// lib/provider-source.ts —— provider 清单的**唯一来源**：dsh 官方配置/凭据通道的最小门面，
// 加上「读不到」时的降级状态。
//
// 为什么从 lib/ocr-config.ts 拆出来：本文件回答的是「清单从哪来、通道缺席时怎么报告」，
// lib/provider-projection.ts 回答「settings 那条值长什么样」，lib/config-store.ts 回答
// 「外部 ocr CLI 的 config.json 怎么读写」，而 lib/ocr-config.ts 只做三条流程的装配
// （卡片数据 / 应用选择 / 明文迁移）。readProviders 与 markKeyFlags 的 export 此前只因单测也
// 按这层边界取用——生产侧的 consumers 全在 ocr-config.ts 那一个文件里，`fallow --production`
// 因此把它们判成「只被测试养着的导出」。
//
// 为什么 provider 清单只能走 ctx.settings.describe()、不读 settings.yaml /
// .credentials.yaml（完整理由见 lib/ocr-config.ts 头注释）：那两个文件的
// 位置与格式都是宿主实现细节。本模块因此只认 DshConfigGateway 这一个面，单测给替身。
//
// 安全口径：本模块绝不在返回值里带出任何 key 值——卡片侧只问 describe(ref) 的 configured
// 布尔，值本身连经手都不经手。

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { providersFromSettingsValue } from "./provider-projection.ts";
import type { DshProvider } from "./provider-projection.ts";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

/** provider 清单所在的官方 settings 命名空间（base bundle 的 pi-ai 适配器注册）。 */
export const PI_AI_NAMESPACE = "llm-pi-ai";

/** 卡片用的 provider：附加 hasKey（只有布尔，永不含 key 值）。 */
export interface DshProviderWithKey extends DshProvider {
  hasKey: boolean;
}

/** describe() 单条描述符里本包用到的面（宿主给全量 SettingsDescriptor，测试给替身）。 */
export interface ProviderDescriptor {
  /** 命名空间名。宿主 0.1.6 的官方字段名是 `ns`（上游有改名 namespace 的 TODO）。 */
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
  /** credentials.resolve(ref) 是否命中：应用前确认 OCR 侧真拿得到 key。 */
  credentialResolvable: (envKey: string) => Promise<boolean>;
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

const SOURCE_READY: ProviderSource = { status: "ready", message: "" };

/**
 * 读 provider 清单并把一切失败折进 source（不抛）：会话热路径与 webServer 端点
 * 都只消费返回值，服务缺席/抛错时卡片仍能显示原因。
 */
export function readProviders(
  gateway: DshConfigGateway,
  messages: OcrReviewMessages,
): {
  providers: DshProvider[];
  source: ProviderSource;
} {
  const health = gateway.health();
  if (!health.settings) {
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
    return {
      providers: [],
      source: {
        status: "settings-failed",
        message: format(messages.sourceSettingsFailed, { message: errorText(error) }),
      },
    };
  }
  const hit = descriptors.find((descriptor) => descriptor.ns === PI_AI_NAMESPACE);
  if (hit === undefined) {
    return {
      providers: [],
      source: {
        status: "namespace-unavailable",
        message: format(messages.sourceNamespaceUnavailable, { ns: PI_AI_NAMESPACE }),
      },
    };
  }
  const providers = providersFromSettingsValue(hit.value);
  if (!health.credentials) {
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
      const hasKey =
        providerCfg.apiKeyEnv === null
          ? false
          : await gateway.credentialConfigured(providerCfg.apiKeyEnv);
      return { ...providerCfg, hasKey };
    }),
  );
  return flagged;
}
