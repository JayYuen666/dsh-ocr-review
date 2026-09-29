// lib/ocr-config.ts —— 把 dsh 侧 LLM 配置（settings 服务解析后的 llm-pi-ai.providers
// + credentials 服务的 key 状态）映射为外部 open-code-review CLI 的 config.json。
//
// 本文件只做**装配**：三条流程（卡片数据 providersForCard / 应用选择 applyProviderSelection /
// 明文迁移 migratePlaintextKeys）与「设置项 ocrConfigPath → 落点」这一道解析。判据分家在三个
// 模块：provider 形状投影 lib/provider-projection.ts、官方通道门面与降级状态
// lib/provider-source.ts、外部 config.json 的落点与读写 lib/config-store.ts。
// resolveOcrConfigPath 留在本文件：它是**设置项语义**（读配置值 → 决定默认路径 → 报错文案），
// 而它调用的那条展开判据（expandHomeForSeparator）属落点判据，住在 lib/config-store.ts。
//
// 为什么不再自己读 settings.yaml / .credentials.yaml（改走官方通道的理由）：
//   - 那两个文件的**位置与格式**都是宿主实现细节：$DSH_HOME 可被启动参数/环境变量改写，
//     credentials 之上还压着进程环境与项目/用户 .env 三层回退。手解 YAML 等于把宿主的
//     私有布局钉死在本包里——换 profile、换数据目录、换凭据后端都会静默失效。
//   - 官方通道：ctx.settings.describe() 给出各命名空间**解析后的最终值**
//     （packages/settings/settings/src/index.ts:319 —— `value = projectForm(form,
//     plainConfig(entry.fiber.config))`，整个 describe() 是 :302-340），provider 清单即
//     llm-pi-ai 那条的 value.providers；ctx.credentials 的 describe/resolve
//     （packages/credentials/credentials/src/index.ts:183-191）给出 key 的存在性，
//     本包不再假设任何磁盘结构。
//
// 安全设计（与「key 不落 OCR 配置」决策一致）：
//   - 本模块绝不在返回值里带出任何 key 值：卡片侧只问 describe(ref) 的 configured 布尔，
//     应用侧 resolve(ref) 只用来确认「能解析出值」，值本身当场丢弃。
//   - 写入 OCR config 用 api_key_cmd（scripts/get-cred.mjs 在 OCR 侧动态取 key），
//     落盘的是命令字符串而非明文；同 provider 若此前手配过明文 api_key 一并清除（迁移）。
//   - config.json 的目标权限 0600（OCR 官方对 config 文件的权限要求）由官方
//     `writeFileAtomic({ mode: 0o600 })` 在**新 inode** 上携带，不再"写回后 chmod"
//     （事后 chmod 等于给 rename 之后再开一个改写窗口；`writeFile` 的 mode 受 umask
//     影响只会更严不会更松，0o600 本就没有 group/other 位）。`.bak` 是本地
//     `copyFileSync` 复制出来的，官方件管不到它，权限仍由本地 chmod 收到 0600。
//     写回走 temp+rename 原子替换并留 `.bak`，坏 JSON 输入直接抛错——绝不用
//     「解析失败当空配置」的方式把用户已有 providers/keys/mcp_servers 写掉。
//     整段「读→判→写」再套官方 `withFileLock`：落盘改异步之后，读与写之间会让出
//     event loop，两个端点并发就各自拿旧快照重写**整份**文档。
//
// 同步 fs 只剩外部 ocr CLI 自己的 config.json 的读取与备份复制（那个文件宿主服务管不到，
// 写已交官方异步件）：对应同步方法名已列入 oxlint.config.ts 的 node/no-sync ignores。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
// 本模块产出的错误与降级原因全进消息表（lib/messages.ts），由 host.ts 按官方 locale
// 偏好取一份注入——纯函数不读设置，所以 messages 是入参。
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { PI_AI_NAMESPACE, markKeyFlags, readProviders } from "./provider-source.ts";
import type { DshConfigGateway, DshProviderWithKey, ProviderSource } from "./provider-source.ts";
import type { DshProvider } from "./provider-projection.ts";
import {
  buildApiKeyCmd,
  credentialScriptPath,
  expandHomeForSeparator,
  loadOcrConfig,
  parseExistingConfig,
  readText,
  renderSelectedConfig,
  updateConfigLocked,
  writeConfigAtomic,
} from "./config-store.ts";
import type { OcrConfigCurrent, OcrPaths } from "./config-store.ts";

/** 外部 ocr CLI 的默认配置目录/文件名（宿主服务管不到，只能由本包直读直写）。 */
const OCR_CONFIG_DIR = ".opencodereview";
const OCR_CONFIG_FILE = "config.json";

/** 无凭据可问时的一律 false（卡片据 source 显示原因，不显示假的「未配置 key」）。 */
function withoutKeyFlags(providers: DshProvider[]): DshProviderWithKey[] {
  return providers.map((providerCfg) => ({ ...providerCfg, hasKey: false }));
}

/**
 * OCR 配置文件路径：设置项 ocrConfigPath 覆盖，未覆盖时按 os.homedir() 派生。
 * 家目录展开交官方 `expandHomePath`，但本地保留两条它没有的判据（见
 * `expandHomeForSeparator` 与下面的绝对性闸门）：直写相对路径会把配置落到
 * 「当时的工作区」，用户找不到也修不了。
 */
export function resolveOcrConfigPath(
  configured: string | undefined,
  messages: OcrReviewMessages,
): string {
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  if (trimmed === "") {
    return path.join(homedir(), OCR_CONFIG_DIR, OCR_CONFIG_FILE);
  }
  const expanded = expandHomeForSeparator(trimmed, path.sep);
  if (!path.isAbsolute(expanded)) {
    throw new Error(format(messages.ocrConfigPathInvalid, { path: trimmed }));
  }
  return expanded;
}

/** 设置页数据：providers（含 hasKey）、当前 OCR 配置、get-cred 脚本存在性、降级原因。 */
export interface CardPayload {
  providers: DshProviderWithKey[];
  current: OcrConfigCurrent;
  getCredReady: boolean;
  source: ProviderSource;
}

/**
 * 组装设置页数据（绝不返回 key 明文；credentials 缺席时 hasKey 全 false 并给出原因，
 * 让卡片显示「为什么不可用」而不是假装每个 provider 都没配 key）。
 */
export async function providersForCard(
  gateway: DshConfigGateway,
  paths: OcrPaths,
  messages: OcrReviewMessages,
): Promise<CardPayload> {
  const { providers, source } = readProviders(gateway, messages);
  const keyed =
    source.status === "ready" ? await markKeyFlags(gateway, providers) : withoutKeyFlags(providers);
  const { current } = loadOcrConfig(readText(paths.ocrConfigJson));
  return {
    providers: keyed,
    current,
    getCredReady: existsSync(credentialScriptPath(paths)),
    source,
  };
}

/** apply 成功后的回执（不含 key）。 */
export interface AppliedConfig {
  provider: string;
  model: string;
  url: string;
  protocol: string;
}

/** 「选择 provider + model」的一次请求（设置卡 POST /select 的 body 形状）。 */
export interface SelectionRequest {
  provider: string;
  model: string;
  /** 评审评论语言（中文/English），非空时写入 config 顶层 language 键。 */
  language?: string;
}

/**
 * 应用选择：官方通道取 provider 清单 → 校验 key 可解析 → 生成新配置 → 写回（0600）。
 * 任何一步不合条件都抛可读错误（webServer 端点兜成 400，卡片显示原因）。
 */
export async function applyProviderSelection(
  gateway: DshConfigGateway,
  paths: OcrPaths,
  selection: SelectionRequest,
  messages: OcrReviewMessages,
): Promise<AppliedConfig> {
  const { provider, model } = selection;
  const { providers, source } = readProviders(gateway, messages);
  if (source.status !== "ready") {
    throw new Error(source.message);
  }
  const target = providers.find((providerCfg) => providerCfg.name === provider);
  if (!target) {
    throw new Error(format(messages.providerNotInList, { ns: PI_AI_NAMESPACE, provider }));
  }
  if (target.apiKeyEnv === null || target.apiKeyEnv === "") {
    throw new Error(format(messages.noApiKeyEnv, { provider }));
  }
  // resolve 只用于确认「凭据服务现在解析得到值」；值当场丢弃，绝不进配置/回执/日志。
  const resolvable = await gateway.credentialResolvable(target.apiKeyEnv);
  if (!resolvable) {
    throw new Error(format(messages.keyNotResolvable, { provider, ref: target.apiKeyEnv }));
  }
  const scriptPath = credentialScriptPath(paths);
  if (!existsSync(scriptPath)) {
    throw new Error(format(messages.credScriptMissing, { path: scriptPath }));
  }
  const apiKeyCmd = buildApiKeyCmd(scriptPath, target.apiKeyEnv, messages);
  // 读—渲染—写整段进官方 withFileLock：落盘改成异步之前，这三次动作同在一个
  // event-loop tick 里做完，等于免费拿到了"并发不互相覆盖整份文档"的性质；
  // 异步化后读与写之间出现了让出点，不加锁就可能把对方刚写好的 provider 选择
  // 用旧快照盖掉（最坏情况：明文 api_key 复活）。锁只圈文件 RMW，不圈上面那个
  // 凭据可达性 await，避免把外部服务的延迟算进持锁时间。
  await updateConfigLocked(paths.ocrConfigJson, async () => {
    const existing = readText(paths.ocrConfigJson);
    const next = renderSelectedConfig(
      {
        existingText: existing,
        configLabel: paths.ocrConfigJson,
        providers,
        provider,
        model,
        apiKeyCmd,
        ...(selection.language === undefined ? {} : { language: selection.language }),
      },
      messages,
    );
    await writeConfigAtomic(paths.ocrConfigJson, next);
  });
  return { provider: target.name, model, url: target.baseURL, protocol: target.protocol };
}

/**
 * 迁移单条 custom provider 条目：有明文 api_key 且能找到 envKey → 改写入
 * api_key_cmd 并删除明文，返回 'migrated'；找不到 envKey 或构造命令失败 →
 * 'unknown'；无明文 → 'noPlain'（不动作）。
 */
function migrateEntry(
  entry: Record<string, unknown>,
  envKey: string | undefined,
  scriptPath: string,
  messages: OcrReviewMessages,
): "migrated" | "unknown" | "noPlain" {
  if (typeof entry["api_key"] !== "string" || entry["api_key"].length === 0) {
    return "noPlain";
  }
  if (envKey === undefined || envKey === "") {
    return "unknown";
  }
  try {
    entry["api_key_cmd"] = buildApiKeyCmd(scriptPath, envKey, messages);
  } catch {
    // 非法 env key 无法构造命令 → 记入 unknown。
    return "unknown";
  }
  delete entry["api_key"];
  return "migrated";
}

/**
 * 迁移：把自定义 provider 条目里的明文 api_key 改为 api_key_cmd（动态读凭据）。
 * api_key_cmd 优先于 api_key，因此清除明文即可。
 * 对「明文 api_key + 无 api_key_cmd」的条目，依据 settings 里该 provider 的
 * apiKeyEnv 补充命令；settings 里找不到的 provider 不动（不破坏既有配置），
 * 在返回信息里说明。credentials 缺席不阻断本操作（它只要 name→apiKeyEnv 映射），
 * settings 侧读不到则抛错——那正是「不知道该写哪条命令」的状态，静默跳过会让用户
 * 以为迁移过了。
 * 返回 { migrated: string[]; skippedUnknown: string[] }。
 */
export async function migratePlaintextKeys(
  gateway: DshConfigGateway,
  paths: OcrPaths,
  messages: OcrReviewMessages,
): Promise<{
  migrated: string[];
  skippedUnknown: string[];
}> {
  // 锁外的这一段只做"要不要动手"的前置判断，顺序与历史一致（空文件 / settings 不可用
  // 抛错 / 坏 JSON 抛「已中止写入」/ 形状不合 / 缺脚本），为的是错误与回执的先后语义
  // 一字不动；真正的读—判—写在锁内对**新快照**重跑一遍，config.json 很小，多解析
  // 一次远比并发下用旧快照覆盖对方的写入便宜。
  const precheck = readText(paths.ocrConfigJson);
  if (!precheck.trim()) {
    return { migrated: [], skippedUnknown: [] };
  }
  const { providers, source } = readProviders(gateway, messages);
  if (source.status !== "ready" && source.status !== "credentials-unavailable") {
    throw new Error(source.message);
  }
  // 前置闸门只为保持**抛错顺序**：坏 JSON 必须在 readProviders 之后、写盘之前抛
  // 「已中止写入以保护既有配置」，与既有断言一致。结果丢弃——锁内会对新快照重解一次。
  parseExistingConfig(precheck, paths.ocrConfigJson, messages);
  const scriptPath = credentialScriptPath(paths);
  if (!existsSync(scriptPath)) {
    return { migrated: [], skippedUnknown: [] };
  }
  // 已知 name → apiKeyEnv 映射（settings 命名空间值）。
  const envByProvider = new Map<string, string>();
  for (const providerCfg of providers) {
    if (providerCfg.apiKeyEnv !== null && providerCfg.apiKeyEnv !== "") {
      envByProvider.set(providerCfg.name, providerCfg.apiKeyEnv);
    }
  }
  const outcome = await updateConfigLocked(paths.ocrConfigJson, async () => {
    // 锁内不再判一次"空文件"：`parseExistingConfig`（lib/config-store.ts）对空白输入返回
    // `{}`，于是下面的 `custom_providers` 形状闸门自然走成同一条"无可迁移对象"的早返回，
    // 多写一次判据只会留下一条永远测不到的分支。
    const doc = parseExistingConfig(readText(paths.ocrConfigJson), paths.ocrConfigJson, messages);
    const customsRaw = fieldOf(doc, "custom_providers");
    if (!isRecord(customsRaw)) {
      return { migrated: [], skippedUnknown: [] };
    }
    const customs = customsRaw;
    const migrated: string[] = [];
    const skippedUnknown: string[] = [];
    for (const [name, raw] of Object.entries(customs)) {
      if (isRecord(raw)) {
        const entry = raw;
        const result = migrateEntry(entry, envByProvider.get(name), scriptPath, messages);
        if (result === "migrated") {
          migrated.push(name);
        } else if (result === "unknown") {
          skippedUnknown.push(name);
        }
      }
    }
    if (migrated.length === 0) {
      return { migrated, skippedUnknown };
    }
    await writeConfigAtomic(paths.ocrConfigJson, `${JSON.stringify(doc, null, 2)}\n`);
    return { migrated, skippedUnknown };
  });
  // 等的是那把文件锁与锁内的一次写：回执必须落定后才报迁移了哪几条
  //（`return await` 被 typescript/return-await 判违规，故先落变量再回）。
  return outcome;
}
