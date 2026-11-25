// lib/provider-source.ts —— provider 清单的**唯一来源**：dsh 官方配置/凭据通道的最小门面，
// 加上「读不到」时的降级状态。
//
// 为什么从 lib/ocr-config.ts 拆出来：本文件回答的是「清单从哪来、通道缺席时怎么报告」，
// lib/provider-projection.ts 回答「settings 那条值长什么样」，lib/config-store.ts 回答
// 「外部 ocr CLI 的 config.json 怎么读写」，而 lib/ocr-config.ts 只做三条流程的装配
// （卡片数据 / 应用选择 / 明文迁移）。
//
// 为什么 provider 清单只能走 ctx.settings.describe()、不碰宿主的私有配置文件与
// 凭据文件（完整理由见 lib/ocr-config.ts 头注释）：那些文件的位置与格式都是
// 宿主实现细节。本模块因此只认 DshConfigGateway 这一个接口，单测给替身。
//
// 安全规则：本模块绝不在返回值里带出任何 key 的值——设置卡只读 describe(ref) 返回的 configured
// 这个布尔，值本身连经手都不经手。

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import {
  PROVIDERS_FIELD,
  providerFromProfile,
  providersFromSettingsValue,
} from "./provider-projection.ts";
import type { DshProvider, ProviderDefault } from "./provider-projection.ts";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** provider 清单所在的官方 settings 命名空间（base bundle 的 pi-ai 适配器注册）。 */
export const PI_AI_NAMESPACE = "llm-pi-ai";

/** DeepSeek 官方 API-key 适配器默认的 settings 命名空间（单 section 就是一份 profile）。 */
export const DEEPSEEK_NAMESPACE = "llm-deepseek-api-key";

/** DeepSeek 官方 route 的 provider 名（`llm-deepseek-api-key/src/index.ts` 的 PROVIDER）。 */
const DEEPSEEK_PROVIDER = "deepseek-official";

/** 卡片用的 provider：附加 hasKey（只有布尔，永不含 key 值）。 */
export interface DshProviderWithKey extends DshProvider {
  hasKey: boolean;
}

/** describe() 单条描述符里本包用到的部分（宿主给全量 SettingsDescriptor，测试给替身）。 */
export interface ProviderDescriptor {
  /** 命名空间名。宿主侧官方字段名是 `ns`。 */
  ns: string;
  /** 该命名空间解析后的最终值。 */
  value: unknown;
}

/** 宿主两个官方通道的装配情况（非 web profile / 未装 base bundle 时会缺席）。 */
export interface GatewayHealth {
  settings: boolean;
  credentials: boolean;
}

/**
 * dsh 官方配置/凭据通道的最小门面。由 host.ts 用 ctx 装配，lib 只依赖这个接口
 * （单测给替身），这样 provider 清单与 key 状态的来源在包里只有一个。
 */
export interface DshConfigGateway {
  /** 服务装配探测：缺席走降级文案，绝不在会话热路径抛穿。 */
  health: () => GatewayHealth;
  /** ctx.settings.describe()：跨命名空间读 provider 清单的唯一入口。 */
  descriptors: () => ProviderDescriptor[];
  /** credentials.describe(ref).configured：只回答「有没有配置」，不判 OCR 运行时可达性。 */
  credentialConfigured: (envKey: string) => Promise<boolean>;
  /**
   * credentials.resolve(ref) 的 **source 层 id**（值本身不经手、当场丢弃）：
   * `undefined` = 未配置 / 服务缺席 / ref 语法非法。
   *
   * 为什么是层 id 而不是布尔：宿主侧 resolve 得到值 ≠ OCR 运行时取得到——
   * dsh 起 shell 会净化环境（见 lib/ocr-config.ts 的 keyReachableAtOcrRuntime），
   * apply/migrate 需要按层判断可达性，把"select 成功 → OCR 401"这种漏报拦在写盘之前。
   */
  credentialSource: (envKey: string) => Promise<string | undefined>;
  /**
   * `ctx.llm.listConfigurableProviders()` 的投影：目录里带着 catalog 的
   * `defaultBaseURL` 与 `settingsNs`。settings 值省略 baseURL 时靠它把 provider
   * 画出来。服务缺席时返回空数组（不影响 pi-ai 常见形状）。
   */
  configurableProviders?: () => ProviderDefault[];
}

/** provider 数据源状态；非 ready 时 message 是给用户看的不可用原因。 */
export type ProviderSourceStatus =
  | "ready"
  | "settings-unavailable"
  | "settings-failed"
  | "namespace-unavailable"
  | "credentials-unavailable";

export interface ProviderSource {
  status: ProviderSourceStatus;
  message: string;
}

// 冻结：这份对象被每次 ready 命中按引用返回给所有调用方，ProviderSource 的字段可变，
// 任一消费方就地改写 source.message/status 都会污染全进程后续所有 ready 结果且跨请求
// 生效。冻结后越界改写在严格模式（ESM）下立刻抛错，暴露在改写点上而不是几百行之后。
const SOURCE_READY: ProviderSource = Object.freeze({ status: "ready", message: "" });

/** settings 通道侧抛错（health / descriptors / 投影三处共用同一状态与同一份文案）。 */
const SOURCE_SETTINGS_FAILED: ProviderSourceStatus = "settings-failed";

/**
 * settings 侧任一读取点抛错时的统一出口：空清单 + settings-failed 原因。
 *
 * 抽出来的理由不是「少写几行」：这条是**契约出口**（readProviders 承诺不抛），四处
 * 各手写一份时，改文案或改状态码只改一处就漂了；现在它只在这里定义一次。
 */
function settingsFailed(
  messages: OcrReviewMessages,
  error: unknown,
): { providers: DshProvider[]; source: ProviderSource } {
  return {
    providers: [],
    source: {
      status: SOURCE_SETTINGS_FAILED,
      message: format(messages.sourceSettingsFailed, { message: errorText(error) }),
    },
  };
}

/** descriptors 里本包要读的两类 section；形状坏掉由调用方折进 settings-failed。 */
function providerHitsOf(
  descriptors: ProviderDescriptor[],
  defaults: readonly ProviderDefault[],
): { piHit: ProviderDescriptor | undefined; deepseekHits: ProviderDescriptor[] } {
  // 非数组不是「命名空间没装」而是「这次 describe 的形状坏了」：两者都投影成 []，
  // 但原因不同——报成 namespace-unavailable 会让排查方向跑到「装没装 base bundle」上去。
  if (!Array.isArray(descriptors)) {
    throw new TypeError(`ctx.settings.describe() 没有给出数组（收到 ${typeof descriptors}）`);
  }
  const piHit = descriptors.find((descriptor) => descriptor.ns === PI_AI_NAMESPACE);
  // DeepSeek 的 section 是整个 profile（`settingsPath: []`），名字由目录给出；不能只按
  // 默认命名空间硬匹配，用户把条目改名后目录仍知道它是 deepseek-official。
  const deepseekProfiles = new Set(
    defaults
      .filter((entry) => entry.provider === DEEPSEEK_PROVIDER)
      .map((entry) => entry.settingsNs),
  );
  const deepseekHits = descriptors.filter(
    (descriptor) => descriptor.ns === DEEPSEEK_NAMESPACE || deepseekProfiles.has(descriptor.ns),
  );
  return { piHit, deepseekHits };
}

/** 一个单 section profile 的目录项；目录缺席时用最小回退（hits 只来自默认 ns 或目录）。 */
function deepseekProfileOf(
  hit: ProviderDescriptor,
  defaults: readonly ProviderDefault[],
  messages: OcrReviewMessages,
): ProviderDefault {
  return (
    defaults.find(
      (entry) => entry.settingsNs === hit.ns && entry.provider === DEEPSEEK_PROVIDER,
    ) ?? {
      provider: DEEPSEEK_PROVIDER,
      displayName: messages.providerDeepSeekFallbackName,
      settingsNs: hit.ns,
    }
  );
}

/** pi-ai providers 表 + DeepSeek 单 section 的合并投影；同时回报 pi 表是否坏掉。 */
function projectProviders(
  piHit: ProviderDescriptor | undefined,
  deepseekHits: readonly ProviderDescriptor[],
  defaults: readonly ProviderDefault[],
  messages: OcrReviewMessages,
): {
  providers: DshProvider[];
  piTableMissing: boolean;
  deepseekTableInvalid: boolean;
  deepseekInvalidNs: string;
} {
  const providers = piHit === undefined ? [] : providersFromSettingsValue(piHit.value, defaults);
  let deepseekProjected = 0;
  // 一个都投影不出来时，报错要指向真正坏掉的那枚 section；目录允许把 settingsNs 改名，
  // 不能固定拿默认命名空间去格式化（否则用户会去查一个根本不存在的 section）。
  let deepseekInvalidNs: string | undefined;
  for (const hit of deepseekHits) {
    const projected = providerFromProfile(hit.value, deepseekProfileOf(hit, defaults, messages));
    if (projected === null) {
      deepseekInvalidNs ??= hit.ns;
    } else {
      providers.push(projected);
      deepseekProjected += 1;
    }
  }
  return {
    providers,
    // pi-ai 命中但 providers 表坏掉：只有 DeepSeek 也没有可用行时才按命名空间不可用报，
    // 否则会把已经能画出的 DeepSeek 行一起吞掉。
    piTableMissing: piHit !== undefined && !isRecord(fieldOf(piHit.value, PROVIDERS_FIELD)),
    // DeepSeek 的 section 存在、但每条 profile 都投影不出可用行（缺 baseURL / 形状坏）：
    // 这不再是「没配置」而是「配置读不出来」，不能以 ready + 空清单让卡片只显示空白选择器。
    deepseekTableInvalid: deepseekHits.length > 0 && deepseekProjected === 0,
    // 只有 invalid 分支消费这一格；没有坏 profile 时填默认值，保证消费侧不用再兜一层。
    deepseekInvalidNs: deepseekInvalidNs ?? DEEPSEEK_NAMESPACE,
  };
}

/**
 * 读 provider 清单，并把所有失败收进 source 里（不抛）：会话的热路径和卡片的读取
 * 都只消费返回值，服务缺席/抛错时卡片仍能显示原因。
 */
export function readProviders(
  gateway: DshConfigGateway,
  messages: OcrReviewMessages,
): {
  providers: DshProvider[];
  source: ProviderSource;
} {
  // health() 纳入 try：它对宿主服务对象做属性探测（proxy / getter 抛错就穿透），
  // 而本函数的契约是「把一切失败折进 source，不抛」——applyProviderSelection 与
  // migratePlaintextKeys 都依赖这条不变式。
  // 两个布尔在 try 里一次读出：health() 的返回对象由宿主装配，本函数的契约是
  // 「把一切失败折进 source，不抛」——读属性这一下同样可能经 getter/Proxy 抛，
  // 与 health() 本身一样，都属于「宿主门面不可信」这一类。
  let settingsUp: boolean;
  let credentialsUp: boolean;
  try {
    const health = gateway.health();
    settingsUp = health.settings;
    credentialsUp = health.credentials;
  } catch (error) {
    return settingsFailed(messages, error);
  }
  if (!settingsUp) {
    return {
      providers: [],
      source: {
        status: "settings-unavailable",
        message: messages.sourceSettingsUnavailable,
      },
    };
  }
  let descriptors: ProviderDescriptor[];
  try {
    descriptors = gateway.descriptors();
  } catch (error) {
    return settingsFailed(messages, error);
  }
  // 目录是可选的**附加信息**（只补 defaultBaseURL / settingsNs），它抛错不能连坐
  // descriptors 已经给出的 provider 清单：否则一个 catalog 服务抖动会让整张卡变成
  // settings-failed，连本来就画得出来的 pi-ai 行也一起消失。缺失时就当目录为空。
  let defaults: ProviderDefault[];
  try {
    const rawDefaults = gateway.configurableProviders?.() ?? [];
    defaults = Array.isArray(rawDefaults) ? rawDefaults : [];
  } catch {
    defaults = [];
  }
  // `descriptors()` 是宿主门面方法：降级装配下可能给出 undefined，proxy 上读一次就抛。
  // 它在 try 里取回来了，但 `.find` 与后面几次属性读取同样会抛——一律折进 source，
  // 否则本函数「不抛」的契约就有缺口（apply/migrate 都依赖它）。
  let hits: ReturnType<typeof providerHitsOf>;
  try {
    hits = providerHitsOf(descriptors, defaults);
  } catch (error) {
    return settingsFailed(messages, error);
  }
  if (hits.piHit === undefined && hits.deepseekHits.length === 0) {
    return {
      providers: [],
      source: {
        status: "namespace-unavailable",
        message: format(messages.sourceNamespaceUnavailable, { ns: PI_AI_NAMESPACE }),
      },
    };
  }
  // providers 表的读取走 shared 的 fieldOf：读取抛错（敌意 getter / Proxy 陷阱）在那一层
  // 已经塌成「取不到」，所以这里不再有 try/catch——敌意键和「没配 providers」在这个读取处分不
  // 区分，一律按 namespace-unavailable。仍然分得开的故障形态（describe 形状、descriptor
  // 属性读取、投影阶段的条目读取）由各自的 try 折进 settings-failed，见上方三个分支。
  let projected: ReturnType<typeof projectProviders>;
  try {
    projected = projectProviders(hits.piHit, hits.deepseekHits, defaults, messages);
  } catch (error) {
    return settingsFailed(messages, error);
  }
  if (projected.providers.length === 0 && projected.deepseekTableInvalid) {
    return {
      providers: [],
      source: {
        status: SOURCE_SETTINGS_FAILED,
        message: format(messages.sourceProfileInvalid, {
          ns: projected.deepseekInvalidNs,
        }),
      },
    };
  }
  if (projected.providers.length === 0 && projected.piTableMissing) {
    return {
      providers: [],
      source: {
        status: "namespace-unavailable",
        message: format(messages.sourceNamespaceUnavailable, { ns: PI_AI_NAMESPACE }),
      },
    };
  }
  const { providers } = projected;
  if (!credentialsUp) {
    return {
      providers,
      source: {
        status: "credentials-unavailable",
        message: messages.sourceCredentialsUnavailable,
      },
    };
  }
  return { providers, source: SOURCE_READY };
}

/**
 * 宿主起 shell 子进程时的**环境净化**模式（dsh-subprocess 的 SENSITIVE_ENV_PATTERN
 * `KEY|PASSWORD|SECRET|TOKEN` 大小写不敏感命中即剥，另加 `DSH_` 前缀全剥）。
 * 本包不传 `env`，OCR 子进程拿到的环境就是净化后的那一份——名字命中本模式的
 * 凭据 ref，OCR 及其孙进程（get-cred）在「继承环境」这一层永远读到空。
 */
const HOST_SCRUBBED_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN|^DSH_/iu;

/**
 * key 在 **OCR 运行时**是否真的取得到（get-cred 三层里有没有一层够得到它）。
 *
 * 宿主侧 resolve() 的 source 是「dsh 进程自己的取值层」，不等于「OCR 子进程够得到的
 * 层」——少了这道判断就是"select 成功 → OCR 401"这种漏报：
 *   - `file`（$DSH_HOME/.credentials.yaml）→ get-cred 第 1 层，可达；
 *   - `user-env`（$DSH_HOME/.env）→ get-cred 第 3 层，可达；
 *   - `env`（dsh 进程继承的环境）→ 只有 ref 名**不**命中宿主净化模式时才可达
 *     （API key 类 ref 几乎全含 KEY/TOKEN，实际常不可达）；
 *   - `project-env`（dsh 工作区 .env）→ get-cred 刻意不读被审查仓库的 .env，永不可达；
 *   - 未知层 / `undefined`（未配置）→ 一律按不可达，由调用方分别报「未配置」。
 * @param source credentials.resolve() 交出的层 id（gateway.credentialSource）。
 * @param ref 凭据 ref 名（get-cred/buildApiKeyCmd 用的那个大写名）。
 */
export function keyReachableAtOcrRuntime(source: string | undefined, ref: string): boolean {
  if (source === "file" || source === "user-env") {
    return true;
  }
  if (source === "env") {
    return !HOST_SCRUBBED_ENV_PATTERN.test(ref);
  }
  return false;
}

/**
 * 逐 provider 判「key 现在能不能用」：只回布尔，值本身不经手。
 *
 * 判据必须与 applyProviderSelection / migratePlaintextKeys 完全同源：
 * `credentialSource(ref)` 的 source 还要再过 `keyReachableAtOcrRuntime`，因为宿主能
 * resolve 不等于 OCR 子进程继承得到（env/project-env 层会被净化或刻意不读）。
 * 此前这里只问 `credentialConfigured`，于是 env 层的 key 在卡片上显示可选、点应用才
 * 被同一条可达性闸拒绝。`credentialSource === undefined` 同时覆盖「未配置」与
 * 「服务缺席」，两种都按不可选处理。
 */
export async function markKeyFlags(
  gateway: DshConfigGateway,
  providers: DshProvider[],
): Promise<DshProviderWithKey[]> {
  const flagged = await Promise.all(
    providers.map(async (providerCfg) => {
      // 整段探测包在一个 try 里（ref 的读取 + 服务调用）：ref 是宿主 settings 投影出来的
      // 字段，读它本身也可能是 getter/Proxy；而 `Promise.all` 里任何一个回调同步抛错都会
      // 整片拒绝——恰好与「单个 ref 探测失败不许连坐整张卡」相反。
      //
      // 用 try/catch 而不是 `.catch(...)`：`.catch` 只能接住 Promise 拒绝，
      // `credentialSource` 若是同步抛（门面方法做参数校验/属性探测时很常见），异常在
      // `.catch` 挂上之前就冒出去了。
      let hasKey = false;
      try {
        const ref = providerCfg.apiKeyEnv;
        // 判据和 applyProviderSelection / migratePlaintextKeys 那两侧完全一致（null **或** 空串）：
        // 同一份 DshProvider 上用两套标准，一旦有别的构造路径送来 ""，这里就会把空 ref
        // 送进凭据服务。
        if (ref !== null && ref !== "") {
          // 两问合并：configured 回答「有没有」，source 回答「OCR 子进程够不够得到」。
          // 缺任一条都不算可选——只看 configured 会把 env/project-env 层误报成可用。
          // 两问互不依赖，并行发出；单个 ref 抛错仍由外层 catch 收成 false。
          const [configured, source] = await Promise.all([
            gateway.credentialConfigured(ref),
            gateway.credentialSource(ref),
          ]);
          hasKey = configured && keyReachableAtOcrRuntime(source, ref);
        }
      } catch {
        // 单个 ref 探测失败不许连坐整张卡：凭据服务抖一下不该让 providersForCard 抛穿到
        // GET /providers 的兜底处理（整张卡退化成 500 的 JSON），把其他 provider 已经探到的
        // 结果一起丢掉。降级成 false = 「此刻读不到」，与 host 侧 credentialSource 的
        // catch 是同一种处理方式。
        hasKey = false;
      }
      return { ...providerCfg, hasKey };
    }),
  );
  return flagged;
}
