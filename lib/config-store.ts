// lib/config-store.ts —— 外部 ocr CLI 自己的那份 config.json：**落点、读、渲染、原子写回**，
// 以及写进去的 `api_key_cmd` 怎么构造。
//
// 为什么从 lib/ocr-config.ts 拆出来：这一层只认得「那个文件」——路径怎么定（含官方
// `expandHomePath` 之外本地保留的那两条判据，绝对性闸门在 lib/ocr-config.ts 的
// resolveOcrConfigPath 里）、盘面怎么在不丢未知键的前提下改、怎么用官方
// `withFileLock` + `writeFileAtomic` 落盘。而「读到的清单与写盘的配置怎么装配成卡片/应用/迁移
// 三条流程」在 lib/ocr-config.ts。此前这一层被单测直接取用的五个判据（loadOcrConfig /
// buildApiKeyCmd / renderSelectedConfig / expandHomeForSeparator / credentialScriptPath）全靠
// export 养着——生产侧的 consumers 全在 ocr-config.ts 那一个文件里，`fallow --production`
// 因此把它们判成「只被测试养着的导出」；另外四件写盘原语本是文件私有，随这一层一起搬家后
// 改由装配层跨文件取用。
//
// 权限与备份口径（0600 / `.bak` / 坏 JSON 抛错而读侧宽容）与「key 不落 OCR 配置」那条决策，
// 完整理由记在 lib/ocr-config.ts 的头注释里，本模块逐字实现它：写盘一律交官方件，本地只
// 管备份与目录。

import { readFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { expandHomePath } from "@deepseek-ai/dsh-home-paths";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
// 本模块产出的错误与降级原因全进消息表（lib/messages.ts），由 host.ts 按官方 locale
// 偏好取一份注入——纯函数不读设置，所以 messages 是入参。
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { PI_AI_NAMESPACE } from "./provider-source.ts";
import type { DshProvider } from "./provider-projection.ts";

/** api_key_cmd 脚本名（pluginDir 兜底路径的唯一拼法来源）。 */
const GET_CRED_SCRIPT = path.join("scripts", "get-cred.mjs");

/** 未知值 → 安全字符串（非字符串给 ''）。 */
function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface OcrConfigCurrent {
  provider: string;
  model: string;
  /** 当前 provider 是否走 api_key_cmd（动态读取）而非明文 api_key。 */
  keyIsDynamic: boolean;
  /** 该 provider 端点（url），可能为空。 */
  url: string;
}

/** 读取外部 ocr CLI config.json 的当前形态（不含 key 值）。
 *  只读侧刻意保持宽容：坏 JSON 也要能让设置卡片打开（用户正是靠卡片去修），
 *  写侧由 parseExistingConfig fail-loud——两者语义不同，不可照抄。 */
export function loadOcrConfig(configJsonText: string): {
  current: OcrConfigCurrent;
  raw: Record<string, unknown>;
} {
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(configJsonText);
    doc = isRecord(parsed) ? parsed : {};
  } catch {
    doc = {};
  }
  const provider = strOf(fieldOf(doc, "provider"));
  const custom = fieldOf(doc, "custom_providers");
  const entry = isRecord(custom) ? fieldOf(custom, provider) : undefined;
  const current: OcrConfigCurrent = {
    provider,
    model: isRecord(custom) ? strOf(fieldOf(entry, "model")) : "",
    keyIsDynamic: isRecord(custom) && strOf(fieldOf(entry, "api_key_cmd")).length > 0,
    url: isRecord(custom) ? strOf(fieldOf(entry, "url")) : "",
  };
  return { current, raw: doc };
}

/** config.json 的当前文本（读不到/不存在一律空串，交由 loadOcrConfig 的宽容读侧处理）。 */
export function readText(configPath: string): string {
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    return "";
  }
}

/** 单引号转义（api_key_cmd 内嵌命令用，模块级纯函数）。 */
function shqDyn(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** api_key_cmd 值构造：脚本路径与 env key 名（及可选的 dsh 数据目录）shq 转义后
 *  拼成 shell 命令。第三参数是 get-cred.mjs 数据目录定位的**第一档**（显式参数 >
 *  $DSH_HOME > homedir()/.dsh）：ocrConfigPath 重定向 ocr 子进程的 HOME 后，
 *  get-cred 的 homedir() 兜底会跟着跑偏，须在宿主侧把解析出的数据目录显式钉进
 *  命令。undefined（未重定向）时省略，沿用 env/默认档。
 *  env key 白名单维持 ^[A-Z0-9_]+$（刻意比宿主 CredentialRef 的语法紧：OCR 侧
 *  惯例大写，且这是写进 config.json 的可信输入）。 */
export function buildApiKeyCmd(
  scriptPath: string,
  envKey: string,
  dshHome: string | undefined,
  messages: OcrReviewMessages,
): string {
  if (!/^[A-Z0-9_]+$/u.test(envKey)) {
    throw new Error(format(messages.badEnvKey, { key: envKey }));
  }
  const parts = ["node", shqDyn(scriptPath), shqDyn(envKey)];
  if (dshHome !== undefined) {
    parts.push(shqDyn(dshHome));
  }
  return parts.join(" ");
}

export interface SelectInput {
  /** 目标 config.json 的完整盘面（用于保留未知键）。 */
  existingText: string;
  /** 目标文件的显示名（写侧错误文案要点名实际路径，设置项覆盖后不能还报默认值）。 */
  configLabel: string;
  /** settings 服务的 llm-pi-ai.providers 列表（须先经 providersFromSettingsValue）。 */
  providers: DshProvider[];
  provider: string;
  model: string;
  apiKeyCmd: string;
  /** 评审评论语言（中文/English），非空时写入顶层 language 键。 */
  language?: string;
}

/** 现有 config 文本 → 盘面对象。
 *
 * 解析失败必须抛错而非给 `{}`：调用方（renderSelectedConfig /
 * migratePlaintextKeys）拿返回值做「保留未知键」的基准，静默变成空对象就等于
 * 把用户全部 providers/keys/mcp_servers 配置当成「不存在」写掉——一个手滑写坏
 * 的 config.json（合法场景：OCR 崩溃时留下半截文件）从此再也回不来。 */
export function parseExistingConfig(
  text: string,
  where: string,
  messages: OcrReviewMessages,
): Record<string, unknown> {
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  // String(error) 已保留 SyntaxError 的「Unexpected end of JSON input」定位信息；
  // JSON.parse 只会抛 Error，故不再写 instanceof 兜底分支（那一支永不可达）。
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(format(messages.configNotJson, { where, cause: String(error) }), {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(format(messages.configNotObject, { where }));
  }
  return parsed;
}

/**
 * 把「读 config.json → 改 → 原子写回」整段串行化。
 *
 * 为什么需要：落盘交给官方异步 `writeFileAtomic` 之后，原本同处一个
 * event-loop tick 内的读写对被拆开了——卡片的「应用 provider」与「一键迁移」并发
 * 时可以各自用旧快照覆盖对方的整份文档，最坏情况是刚迁走的明文 api_key 又被写回来。
 * 锁用官方 `dsh-atomic-write` 的 `withFileLock`（`<目标>.lock`、`wx` 独占创建、
 * 持锁进程已退出按 pid 探活接管、`finally` 删除），本仓不自制互斥件。
 * 先补一次父目录：官方件只在写目标文件时建目录，而锁文件本身就落在那个目录里，
 * 首写（目录尚不存在）时不先建就会 ENOENT。
 */
export async function updateConfigLocked<TResult>(
  targetPath: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  return withFileLock(targetPath, operation);
}

/**
 * 原子写回 config.json：先留 `.bak` 备份，再交官方 `writeFileAtomic` 落盘。
 * 此前是 `writeFileSync` 直写：进程/磁盘在写入中途出问题就会留下半截配置
 * （OCR 与用户都读不到），且没有任何回滚点。rename 在同目录内是原子的。
 *
 * 随机后缀临时文件 + `wx` 独占创建、失败清临时文件、Windows rename 重试、父目录
 * 创建（`dirMode`）与新 inode 携带 `mode` 全是官方件既有行为，本仓不再手抄
 * （实测）。本地只剩 `.bak`：官方写文件面无备份语义，且备份必须落在
 * rename **之前**——挪到之后备份到的就是新内容。
 */
export async function writeConfigAtomic(targetPath: string, text: string): Promise<void> {
  const bakPath = `${targetPath}.bak`;
  if (existsSync(targetPath)) {
    copyFileSync(targetPath, bakPath);
    // 备份里可能仍有迁移前的明文 key，权限按最严格收口。
    chmodSync(bakPath, 0o600);
  }
  await writeFileAtomic(targetPath, text, { mode: 0o600, dirMode: 0o700 });
}

/** 本包允许写进 custom_providers.<name>.protocol 的白名单（OCR config_cmd.go:796
 *  "Protocol values: anthropic, anthropic-bedrock, openai, openai-responses"）。
 *  本包只会经 provider-projection 的映射表产出前三种；anthropic-bedrock 无对应的
 *  llm-pi-ai 协议、不由本包写出。表外值 = 投影透传的未知 `api`：拒绝写入，绝不落
 *  一份 OCR 解析不了的配置（此前二值映射会把 anthropic-messages 静默写成 openai）。 */
const WRITABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  "openai",
  "openai-responses",
  "anthropic",
]);

/**
 * 生成「选择 provider+model」后的 config.json 全文。
 * - provider 顶层设为目标名；custom_providers.<name> 写 url/protocol/model/
 *   api_key_cmd；同条目残留明文 api_key 清除。
 * - 目标条目上已有的其它键（extra_headers/temperature/timeout_seconds…）与
 *   其余顶层键（language/max_tokens/effort/mcp_servers…）、其它
 *   custom_providers 条目一律原样保留，绝不丢配置。
 */
export function renderSelectedConfig(input: SelectInput, messages: OcrReviewMessages): string {
  const doc = parseExistingConfig(input.existingText, input.configLabel, messages);
  const target = input.providers.find((providerCfg) => providerCfg.name === input.provider);
  if (!target) {
    throw new Error(
      format(messages.providerNotInList, {
        ns: PI_AI_NAMESPACE,
        provider: input.provider,
      }),
    );
  }
  const modelOk =
    target.models.length === 0 || target.models.some((model) => model.id === input.model);
  if (!modelOk) {
    throw new Error(
      format(messages.modelNotInList, { provider: input.provider, model: input.model }),
    );
  }
  if (!WRITABLE_PROTOCOLS.has(target.protocol)) {
    throw new Error(
      format(messages.protocolUnsupported, {
        provider: input.provider,
        protocol: target.protocol,
      }),
    );
  }
  const customsRaw = fieldOf(doc, "custom_providers");
  const customs = isRecord(customsRaw) ? customsRaw : {};
  // 合并而非整体覆盖：此前 `customs[provider] = entry` 会把该条目上用户手配的
  // extra_headers / temperature / timeout_seconds / 自定义 headers 全删掉
  // （卡片只认四个键，用户却是在 OCR 侧配的）。
  const existingRaw = fieldOf(customs, input.provider);
  const existingEntry = isRecord(existingRaw) ? existingRaw : {};
  const entry: Record<string, unknown> = {
    ...existingEntry,
    url: target.baseURL,
    protocol: target.protocol,
    model: input.model,
    api_key_cmd: input.apiKeyCmd,
  };
  // 迁移：同 provider 旧明文 api_key 移除（api_key_cmd 优先于 api_key 解析，
  // 留下会混乱且违背「不落明文」决策）。
  delete entry["api_key"];
  customs[input.provider] = entry;
  doc["provider"] = input.provider;
  doc["custom_providers"] = customs;
  if (input.language !== undefined) {
    doc["language"] = input.language;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 本包还剩的文件路径：全部指向**外部** ocr CLI 自己的地盘（宿主服务管不到）。 */
export interface OcrPaths {
  /** ocr CLI 配置文件；默认按 os.homedir() 派生，可被设置项 ocrConfigPath 覆盖。 */
  ocrConfigJson: string;
  /** ocr 子进程的 HOME 重定向值：设置项命中 `<X>/.opencodereview/config.json` 布局
   *  时为 X，否则 undefined（默认路径零重定向）。工具执行点据此给命令加 HOME 前缀
   *  （lib/cli.ts withHomeEnv）；undefined/坏设置一律不加前缀。 */
  homeOverride: string | undefined;
  /** 插件所在目录（get-cred 脚本兜底位置）。 */
  pluginDir: string;
  /** api_key_cmd 脚本路径；空串 = 按 pluginDir 兜底。 */
  getCredScript: string;
}

/**
 * 家目录展开交官方 `expandHomePath`，只有 POSIX 上的 `~\x` 由本地拦下：官方吃
 * `~/` 与 `~\` 两条前缀，在 POSIX 上会把 `~\notes.txt` 折成 `<home>/\notes.txt`
 * ——一枚合法的反斜杠文件名，等于把用户打错的相对路径静默变成家目录里的怪文件，
 * 比现状（报"必须是绝对路径"）更坏。原样放行让它落到调用方（lib/ocr-config.ts 的
 * resolveOcrConfigPath）那道绝对性闸门去报错。
 * sep 作参数而不是就地读 `path.sep`：两个分支都要能被断言（同 plugin-hot-reload
 * 的 shellQuoted(bin, viaShell) 手法）。
 */
export function expandHomeForSeparator(value: string, sep: string): string {
  if (sep === "/" && value.startsWith("~\\")) {
    return value;
  }
  return expandHomePath(value);
}

/** api_key_cmd 脚本在插件目录里的固定落点（host.ts 与兜底路径共用这一处）。 */
export function defaultCredScriptPath(pluginDir: string): string {
  return path.join(pluginDir, GET_CRED_SCRIPT);
}

/** api_key_cmd 脚本落点：显式路径优先，否则按 pluginDir 兜底。 */
export function credentialScriptPath(paths: OcrPaths): string {
  return paths.getCredScript === "" ? defaultCredScriptPath(paths.pluginDir) : paths.getCredScript;
}
