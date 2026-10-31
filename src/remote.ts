// src/remote.ts —— 设置卡读/写**宿主侧 OCR 配置**的那一面（官方 Typert Remote 的消费侧）。
//
// 为什么需要它：卡片跑在浏览器里，而 provider 清单、外部 ocr CLI 的配置与 `ocr llm test`
// 都在宿主进程。设置面没有「宿主执行动作」的口子，唯一的官方通道就是 Remote（见
// host.ts 的读面实现）。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（SRC）下从方法签名推参数名，参数与
// 结果都走 `{ mode: "src-json" }`，不需要生成器的 `typeSymbol` / `create()` 产物。但**客户端**
// 的贡献校验（`$mount` → `requireStrictCodec`）要求每个入参都带 strict codec，非 strict 会
// 拒绝整份贡献。于是这里的入参 codec 写成 strict 的 zod schema：它只在客户端做形状校验，
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
import { z } from "zod";

import { OCR_BUNDLE_PACKAGE, OCR_REMOTE_NAMESPACE } from "../lib/remote-shape.ts";
import type {
  OcrAuthReply,
  OcrChatGptReply,
  OcrChatGptRequest,
  OcrMcpReply,
  OcrMcpSaveReply,
  OcrMcpSaveRequest,
  OcrMigrateReply,
  OcrProbeReply,
  OcrSelectReply,
  OcrSelectRequest,
  OcrTestReply,
} from "../lib/remote-shape.ts";

/** 网关给命名空间注册的**服务键**：`remote.<namespace>`。它在 `$mount` 完成之后才存在，
 *  所以只能在挂载后按这个键去读，而不是提前 inject。 */
const OCR_SERVICE_KEY = `remote.${OCR_REMOTE_NAMESPACE}`;

/** 卡片所在 bundle 的包名（`$mount` 的 `package` 位与槽位键同源；唯一定义在
 *  lib/remote-shape.ts，client-entry.ts 的槽位键引的是同一个常量）。 */
const PACKAGE_NAME = OCR_BUNDLE_PACKAGE;

/** strict codec 的统一出口：失败交给 zod 的 `prettifyError`，读到的是一份带字段路径的说明。 */
function parseOrThrow<Result>(schema: z.ZodType<Result>, value: unknown): Result {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

const SELECT_MESSAGE = "select request requires string provider and model";
const SELECT_SCHEMA = z.object(
  {
    provider: z.string({ error: SELECT_MESSAGE }),
    model: z.string({ error: SELECT_MESSAGE }),
  },
  { error: "select request must be an object" },
);

const MCP_SAVE_MESSAGE = "mcp save request requires a string json";
const MCP_SAVE_SCHEMA = z.object(
  {
    json: z.string({ error: MCP_SAVE_MESSAGE }),
    revision: z.string().optional(),
  },
  { error: MCP_SAVE_MESSAGE },
);

const CHAT_GPT_MESSAGE = "chatgpt request requires a string model";
const CHAT_GPT_SCHEMA = z.object(
  { model: z.string({ error: CHAT_GPT_MESSAGE }) },
  { error: CHAT_GPT_MESSAGE },
);

/** 选择请求的客户端 parser：两位都是必填串。 */
const SELECT_CODEC: TypertCodec<OcrSelectRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#select-request`,
  create: () => ({
    parse(value: unknown): OcrSelectRequest {
      return parseOrThrow(SELECT_SCHEMA, value);
    },
  }),
};

/** MCP 保存请求：`json` 是必填串（原始 JSON 文本，由宿主校验），`revision` 是读侧交回的基线。 */
const MCP_SAVE_CODEC: TypertCodec<OcrMcpSaveRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#mcp-save-request`,
  create: () => ({
    parse(value: unknown): OcrMcpSaveRequest {
      return parseOrThrow(MCP_SAVE_SCHEMA, value);
    },
  }),
};

/** ChatGPT 选择请求：`model` 是必填串。 */
const CHAT_GPT_CODEC: TypertCodec<OcrChatGptRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#chatgpt-request`,
  create: () => ({
    parse(value: unknown): OcrChatGptRequest {
      return parseOrThrow(CHAT_GPT_SCHEMA, value);
    },
  }),
};

/** 把宿主那九个方法挂到客户端远程面上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
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
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/mcp`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "mcp",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/saveMcp`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "saveMcp",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: MCP_SAVE_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/auth`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "auth",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${OCR_REMOTE_NAMESPACE}/chatGpt`,
    service: OCR_REMOTE_NAMESPACE,
    namespace: OCR_REMOTE_NAMESPACE,
    method: "chatGpt",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: CHAT_GPT_CODEC }],
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
  mcp: () => Promise<RemoteResult<OcrMcpReply>>;
  saveMcp: (request: OcrMcpSaveRequest) => Promise<RemoteResult<OcrMcpSaveReply>>;
  auth: () => Promise<RemoteResult<OcrAuthReply>>;
  chatGpt: (request: OcrChatGptRequest) => Promise<RemoteResult<OcrChatGptReply>>;
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
  mcp: () => Promise<OcrMcpReply>;
  saveMcp: (json: string, revision?: string) => Promise<OcrMcpSaveReply>;
  auth: () => Promise<OcrAuthReply>;
  chatGpt: (model: string) => Promise<OcrChatGptReply>;
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
  typeof value["probe"] === "function" &&
  typeof value["mcp"] === "function" &&
  typeof value["saveMcp"] === "function" &&
  typeof value["auth"] === "function" &&
  typeof value["chatGpt"] === "function";

/** 网关回执 → 值；载体/网关失败抛（卡片那层按「请求失败」显示）。
 *  机器码放 `cause`：卡片只展示 message，`REMOTE_...` 这类内部标识不是给用户看的。 */
function unwrap<Value>(result: RemoteResult<Value>): Value {
  if (!result.ok) {
    throw new Error(result.error.message, { cause: { code: result.error.code } });
  }
  return result.value;
}

/**
 * 造出真正的读取器。`remote` 不再是构造期快照：本插件与官方网关之间没有加载顺序
 * 保证（本文件刻意不把 `remote` 写进 `inject`），网关可能在卡片注册之后才
 * `provide("remote")`，所以**每次读取都现取**——缺席报可读错误，晚到也能被下一次
 * 读取接上。挂载 promise 仍缓存（`$mount` 幂等），但拒绝态不缓存：失败后清空，
 * 下一次读取重新挂载，没有「错一次就永远错」的路径。
 * @param ctx - 客户端上下文
 * @returns 读取器
 */
function buildOcrReader(ctx: RemoteHost): OcrReader {
  let mounted: Promise<unknown> | undefined;
  const remoteOf = (): RemoteMounter => {
    // strict 显式给 false：可选读取的语义钉在调用点，不依赖 cordis get 的默认值
    //（默认值变了，缺 remote 的部署就该在这里拿到 undefined 而不是抛错）。
    const remote = ctx.get?.("remote", false);
    if (!isRemoteMounter(remote)) {
      throw new Error("remote 未提供：当前部署没有远程读面");
    }
    return remote;
  };
  const namespaceOf = async (): Promise<OcrNamespace> => {
    const remote = remoteOf();
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: OCR_DESCRIPTORS });
    try {
      await mounted;
    } catch (error) {
      // `??=` 缓存的是那枚已 settled 的 promise：失败不清空的话，同一读取器此后每次
      // 读取都立刻以同一条错误失败，永远不会重试。
      mounted = undefined;
      throw error;
    }
    const namespace = ctx.get?.(OCR_SERVICE_KEY, false);
    if (!isOcrNamespace(namespace)) {
      // 挂载已落定却读不到命名空间（贡献被撤、fiber 卸载、网关重挂）：缓存不清空的话，
      // 后续读取会一直跳过 $mount 并以同一条错误失败，与文件头「晚到也能被下一次读取
      // 接上」的承诺相反。清掉缓存，下一次读取重新挂载。
      mounted = undefined;
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
    async mcp(): Promise<OcrMcpReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.mcp());
    },
    async saveMcp(json: string, revision?: string): Promise<OcrMcpSaveReply> {
      const ns = await namespaceOf();
      // 不带基线时不发这一位：旧宿主会按「请求体只认 json」的 schema 把多出来的键判掉。
      return unwrap(await ns.saveMcp(revision === undefined ? { json } : { json, revision }));
    },
    async auth(): Promise<OcrAuthReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.auth());
    },
    async chatGpt(model: string): Promise<OcrChatGptReply> {
      const ns = await namespaceOf();
      return unwrap(await ns.chatGpt({ model }));
    },
  };
}

/**
 * 造一个「读/写宿主侧 OCR 配置」的读取器。**当前部署没有远程面时读取会抛**可读错误
 * （卡片那层按「请求失败」显示原因）——remote 不在构造期做快照，网关晚于卡片注册
 * `provide("remote")` 的部署在首次成功读取时就能接上，不存在「apply 期没有就永远
 * 读不到」的路径。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），所以缓存那枚 promise：
 * 同一次会话里反复拉取只挂一次；拒绝态例外（见 buildOcrReader）。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器
 */
export function createOcrReader(ctx: RemoteHost): OcrReader {
  return buildOcrReader(ctx);
}
