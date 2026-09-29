// 测试替身：dsh 官方配置/凭据通道（lib/provider-source.ts 的 DshConfigGateway 门面）。
//
// 为什么替身做在这一层而不是做在「文件内容」上：本包已经不读任何宿主文件，
// provider 清单与 key 状态的唯一来源就是这两个服务。替身按 ref 名单回答
// describe/resolve，并且**记录被问到的 ref**——测试据此断言「卡片只问存在性、
// 只有 apply 才去 resolve」，这是 key 不外泄的关键不变式。

import { CONFIGURED_REFS, DEFAULT_DESCRIPTORS } from "./settings-fixture.ts";
import type {
  DshConfigGateway,
  GatewayHealth,
  ProviderDescriptor,
} from "../../lib/provider-source.ts";

export interface GatewayFixtureOptions {
  /** 服务装配探测（默认两个都在）。 */
  health?: Partial<GatewayHealth>;
  /** describe() 返回值（默认含 llm-pi-ai 的完整 provider 清单）。 */
  descriptors?: ProviderDescriptor[];
  /** describe(ref) 回答「已配置」的 ref 名单。 */
  configured?: string[];
  /** resolve(ref) 能命中值的 ref 名单（名单外一律未命中）。 */
  resolvable?: string[];
  /** describe() 抛出的错误值（模拟宿主服务内部故障；非 Error 也要能降级）。 */
  describeThrows?: Error;
}

/**
 * 宿主服务可能抛出**不是 Error 实例**的值（本包必须降级、不能抛穿到卡片）。
 * 这个类刻意不 `extends Error`：运行时 `instanceof Error === false`，但结构上
 * 带 name/message，于是能以 Error 形状穿过 `describeThrows` 的声明。
 */
export class NonErrorFault {
  public readonly name = "non-error-fault";
  public readonly message: string;

  public constructor(message: string) {
    this.message = message;
  }

  public toString(): string {
    return this.message;
  }
}

export interface GatewayFixture extends DshConfigGateway {
  /** 被问过「有没有 key」的 ref（卡片侧）。 */
  describedRefs: string[];
  /** 被问过「能不能解析」的 ref（应用侧）。 */
  resolvedRefs: string[];
}

export function makeGateway(options: GatewayFixtureOptions = {}): GatewayFixture {
  const configured = options.configured ?? CONFIGURED_REFS;
  const resolvable = options.resolvable ?? CONFIGURED_REFS;
  const fixture: GatewayFixture = {
    describedRefs: [],
    resolvedRefs: [],
    health: () => ({ settings: true, credentials: true, ...options.health }),
    descriptors: () => {
      if (options.describeThrows !== undefined) {
        throw options.describeThrows;
      }
      return options.descriptors ?? DEFAULT_DESCRIPTORS;
    },
    credentialConfigured: async (envKey: string) => {
      fixture.describedRefs.push(envKey);
      return configured.includes(envKey);
    },
    credentialResolvable: async (envKey: string) => {
      fixture.resolvedRefs.push(envKey);
      return resolvable.includes(envKey);
    },
  };
  return fixture;
}
