// src/remote.ts —— 设置卡读/写**宿主侧 OCR 配置**的那一面（官方 Typert Remote 的消费侧）。
//
// 为什么需要它：卡片跑在浏览器里，而 provider 清单、外部 ocr CLI 的配置与 `ocr llm test`
// 都在宿主进程。设置面没有「宿主执行动作」的口子，唯一的官方通道就是 Remote（见
// host.ts 的读面实现）。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（SRC）下从方法签名推参数名，参数与
// 结果都走 `{ mode: "src-json" }`，不需要生成器的 `typeSymbol` / `create()` 产物。但**客户端**
// 的贡献校验（`$mount` → `requireStrictCodec`）要求每个入参都带 strict codec，非 strict 会
// 拒绝整份贡献。于是这里的入参 codec 写成 strict 的手写 parser：它只在客户端做形状校验，
// 从不跨网；宿主那边仍按源模式从签名取参数名。
//
// ⚠ **为什么走 `ctx.get("remote")` 而不是把 `remote` 写进 `inject`**：cordis 对**未 inject 的
// 服务**读取是**抛错**。而本卡的其余部分在"没装远程面"的部署里也必须照常渲染（远程读面是
// 可选能力），`inject: ["remote", …]` 却会把整条 client 入口绑死在远程面上——缺它就不激活。
// `ctx.get` 是**显式读取**，不受 inject 门禁约束——官方网关自己也是这么读可选服务的。
//
// ⚠ 类型一律 `import type`（产物里零新说明符）：`@deepseek-ai/*` 只作类型消费。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import { OCR_REMOTE_NAMESPACE } from "../lib/remote-shape.ts";
import type {
  OcrMigrateReply,
  OcrProbeReply,
  OcrSelectReply,
  OcrSelectRequest,
  OcrTestReply,
} from "../lib/remote-shape.ts";

/** 网关给命名空间注册的**服务键**：`remote.<namespace>`。它在 `$mount` 完成之后才存在，
 *  所以只能在挂载后按这个键去读，而不是提前 inject。 */
const OCR_SERVICE_KEY = `remote.${OCR_REMOTE_NAMESPACE}`;

/** 卡片所在 bundle 的包名（`$mount` 的 `package` 位与槽位键同源，见 client-entry.ts 的 BUNDLE_PKG）。 */
const PACKAGE_NAME = "@jayyuen66/dsh-ocr-review";

/** 选择请求的客户端 parser：两位都是必填串。 */
const SELECT_CODEC: TypertCodec<OcrSelectRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#select-request`,
  create: () => ({
    parse(value: unknown): OcrSelectRequest {
      if (!isRecord(value)) {
        throw new TypeError("select request must be an object");
      }
      const { provider, model } = value;
      if (typeof provider !== "string" || typeof model !== "string") {
        throw new TypeError("select request requires string provider and model");
      }
      return { provider, model };
    },
  }),
};

/** 把宿主那五个方法挂到客户端远程面上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
 *  导出它只为一件事：`test/remote.test.ts` 拿它与宿主侧 `remoteMethods()` 的标记对质
 *  —— 两侧分叉时卡片不会报错，只会"读不到"，所以那条比较必须在门禁里。 */
export const OCR_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/providers`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "providers",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/select`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "select",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: SELECT_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/migrate`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "migrate",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/test`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "test",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/probe`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "probe",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
];

/** 客户端上下文里本模块用到的那一位：**显式读取**一个可选服务（见文件头为什么不用 inject）。 */
export interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

/** 官方网关的客户端服务面：本卡只用 `$mount` 一位（挂载一枚手写贡献）。 */
interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

/** 挂载后由网关提供的命名空间服务面（方法名 = descriptor.method，位置参数）。 */
interface OcrNamespace {
  providers: () => Promise<RemoteResult<Record<string, unknown>>>;
  select: (request: OcrSelectRequest) => Promise<RemoteResult<OcrSelectReply>>;
  migrate: () => Promise<RemoteResult<OcrMigrateReply>>;
  test: () => Promise<RemoteResult<OcrTestReply>>;
  probe: () => Promise<RemoteResult<OcrProbeReply>>;
}

/**
 * 卡片用到的读取器。拒绝回执（`ok:false`）原样交回，由卡片决定怎么显示——传输/网关
 * 失败才抛。`providers` 交回原始记录（卡片那层逐字段守卫照旧生效）。
 */
export interface OcrReader {
  providers: () => Promise<Record<string, unknown>>;
  select: (provider: string, model: string) => Promise<OcrSelectReply>;
  migrate: () => Promise<OcrMigrateReply>;
  test: () => Promise<OcrTestReply>;
  probe: () => Promise<OcrProbeReply>;
}

/** 这个值能当远程面用吗（只核我们要调的那一位；服务来自别的实现或版本时保守当作没有）。 */
const isRemoteMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

/** 同上：命名空间服务（挂载之后才有，缺它说明网关没认这枚贡献）。 */
const isOcrNamespace = (value: unknown): value is OcrNamespace =>
  isRecord(value) &&
  typeof value["providers"] === "function" &&
  typeof value["select"] === "function" &&
  typeof value["migrate"] === "function" &&
  typeof value["test"] === "function" &&
  typeof value["probe"] === "function";

/** 网关回执 → 值；载体/网关失败抛（卡片那层按「请求失败」显示）。 */
function unwrap<Value>(result: RemoteResult<Value>): Value {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * 造出真正的读取器（挂载一次 + 每次读命名空间服务）。
 * @param ctx - 客户端上下文
 * @param remote - 已核过形状的远程面
 * @returns 读取器
 */
function buildOcrReader(ctx: RemoteHost, remote: RemoteMounter): OcrReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<OcrNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: OCR_DESCRIPTORS });
    await mounted;
    const namespace = ctx.get?.(OCR_SERVICE_KEY, false);
    if (!isOcrNamespace(namespace)) {
      throw new Error(`${OCR_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    async providers(): Promise<Record<string, unknown>> {
      const ns = await namespaceOf();
      return unwrap(await ns.providers());
    },
    async select(provider: string, model: string): Promise<OcrSelectReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.select({ provider, model }));
    },
    async migrate(): Promise<OcrMigrateReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.migrate());
    },
    async test(): Promise<OcrTestReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.test());
    },
    async probe(): Promise<OcrProbeReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.probe());
    },
  };
}

/**
 * 造一个「读/写宿主侧 OCR 配置」的读取器；**当前部署没有远程面时返回 `undefined`**
 * （卡片照常渲染，只是数据面显示读不到 —— 与 host 侧可选读面同一条口径）。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），所以这里缓存那枚 promise：
 * 同一次会话里反复拉取只挂一次。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器；没有远程面时 `undefined`
 */
export function createOcrReader(ctx: RemoteHost): OcrReader | undefined {
  const remote = ctx.get?.("remote");
  // 单 return（三元的另一支是 `undefined`）：`consistent-return` 不接受"早退 undefined + 晚退函数"
  // 这种混合形状，而这里两种结果本来就是同一件事的两面。
  return isRemoteMounter(remote) ? buildOcrReader(ctx, remote) : undefined;
}
