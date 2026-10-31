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
// 宿主实现细节。本模块因此只认 DshConfigGateway 这一个面，单测给替身。
//
// 安全口径：本模块绝不在返回值里带出任何 key 值——卡片侧只问 describe(ref) 的 configured
// 布尔，值本身连经手都不经手。

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { PROVIDERS_FIELD, providersFromSettingsValue } from "./provider-projection.ts";
import type { DshProvider } from "./provider-projection.ts";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** provider 清单所在的官方 settings 命名空间（base bundle 的 pi-ai 适配器注册）。 */
export const PI_AI_NAMESPACE = "llm-pi-ai";

/** 卡片用的 provider：附加 hasKey（只有布尔，永不含 key 值）。 */
export interface DshProviderWithKey extends DshProvider {
  hasKey: boolean;
}

/** describe() 单条描述符里本包用到的面（宿主给全量 SettingsDescriptor，测试给替身）。 */
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
 * dsh 官方配置/凭据通道的最小门面。由 host.ts 用 ctx 装配，lib 只依赖这个面
 * （单测给替身），这样 provider 清单与 key 状态的来源在包里只有一个。
 */
export interface DshConfigGateway {
  /** 服务装配探测：缺席走降级文案，绝不在会话热路径抛穿。 */
  health: () => GatewayHealth;
  /** ctx.settings.describe()：跨命名空间读 provider 清单的唯一入口。 */
  descriptors: () => ProviderDescriptor[];
  /** credentials.describe(ref).configured：卡片判断「有没有 key」，值不经手。 */
  credentialConfigured: (envKey: string) => Promise<boolean>;
  /**
   * credentials.resolve(ref) 的 **source 层 id**（值本身不经手、当场丢弃）：
   * `undefined` = 未配置 / 服务缺席 / ref 语法非法。
   *
   * 为什么是层 id 而不是布尔：宿主侧 resolve 得到值 ≠ OCR 运行时取得到——
   * dsh 起 shell 会净化环境（见 lib/ocr-config.ts 的 keyReachableAtOcrRuntime），
   * apply/migrate 需要按层判定可达性，把「select 成功 → OCR 401」的假绿拦在写盘前。
   */
  credentialSource: (envKey: string) => Promise<string | undefined>;
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

/**
 * 读 provider 清单并把一切失败折进 source（不抛）：会话热路径与卡片读面
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
  // 与 health() 本身同属「宿主门面不可信」的那一面。
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
  // `descriptors()` 是宿主门面方法：降级装配下可能给出 undefined，proxy 上读一次就抛。
  // 它在 try 里取回来了，但 `.find` 与后面几次属性读取同样会抛——一律折进 source，
  // 否则本函数「不抛」的契约就有缺口（apply/migrate 都依赖它）。
  let hit: ProviderDescriptor | undefined;
  try {
    // 非数组不是「命名空间没装」而是「这次 describe 的形状坏了」：两者都投影成 []，
    // 但原因不同——报成 namespace-unavailable 会让排查方向跑到「装没装 base bundle」上去。
    if (!Array.isArray(descriptors)) {
      throw new TypeError(`ctx.settings.describe() 没有给出数组（收到 ${typeof descriptors}）`);
    }
    hit = descriptors.find((descriptor) => descriptor.ns === PI_AI_NAMESPACE);
  } catch (error) {
    return settingsFailed(messages, error);
  }
  if (hit === undefined) {
    return {
      providers: [],
      source: {
        status: "namespace-unavailable",
        message: format(messages.sourceNamespaceUnavailable, { ns: PI_AI_NAMESPACE }),
      },
    };
  }
  // providers 表的读取走 shared 的 fieldOf：读取抛错（敌意 getter / Proxy 陷阱）在那一层
  // 已塌成「取不到」，所以这里不再有 try/catch——敌意键与「没配 providers」在本读口不可
  // 区分，一律按 namespace-unavailable。仍然分得开的故障形态（describe 形状、descriptor
  // 属性读取、投影阶段的条目读取）由各自的 try 折进 settings-failed，见上方三个分支。
  const providersValue = fieldOf(hit.value, PROVIDERS_FIELD);
  if (!isRecord(providersValue)) {
    return {
      providers: [],
      source: {
        status: "namespace-unavailable",
        message: format(messages.sourceNamespaceUnavailable, { ns: PI_AI_NAMESPACE }),
      },
    };
  }
  // 投影同样纳入 try：它对命名空间值做 Object.entries + 逐字段取值，宿主给的是
  // settings 解析值（可能是带 getter 的对象），抛穿就违反本函数「不抛」的契约。
  let providers: DshProvider[];
  try {
    providers = providersFromSettingsValue(hit.value);
  } catch (error) {
    return settingsFailed(messages, error);
  }
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

/** 逐 provider 问凭据服务「有没有 key」（并行；只回布尔）。 */
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
      // `credentialConfigured` 若是同步抛（门面方法做参数校验/属性探测时很常见），异常在
      // `.catch` 挂上之前就冒出去了。
      let hasKey = false;
      try {
        const ref = providerCfg.apiKeyEnv;
        // 判据与 applyProviderSelection / migratePlaintextKeys 侧完全一致（null **或** 空串）：
        // 同一份 DshProvider 上两套判据，一旦有别的构造路径送来 ""，这里就会把空 ref
        // 送进凭据服务。
        if (ref !== null && ref !== "") {
          hasKey = await gateway.credentialConfigured(ref);
        }
      } catch {
        // 单个 ref 探测失败不许连坐整张卡：凭据服务抖一下不该让 providersForCard 抛穿到
        // GET /providers 的兜底（整张卡退化成 500 JSON），把其他 provider 已经探到的
        // configured 结果一起丢掉。降级成 false = 「此刻读不到」，与 host 侧
        // credentialConfigured 的 catch 口径一致。
        hasKey = false;
      }
      return { ...providerCfg, hasKey };
    }),
  );
  return flagged;
}
