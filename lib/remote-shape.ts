// lib/remote-shape.ts —— 设置卡读面（Typert Remote）两侧共用的**线上形状**。
//
// 为什么单列：宿主侧的服务实现与客户端读取器分属两个产物（host.js / client.js），
// 各自内联一份 lib/。形状放在这个零依赖叶子上，两边引的是同一份声明；写成
// `import type` 后对任一产物的字节数贡献都是零。叶子必须**零导入**：客户端的类型
// 程序不加载 node 类型（tsconfig.client.json 的 `types: []`），一旦从
// lib/ocr-config.ts 借类型，整条 node:fs 依赖链就会被拖进来。

/** 宿主服务键 = 客户端线上命名空间（两侧共用的唯一来源）。 */
export const OCR_REMOTE_NAMESPACE = "ocrReview";

/**
 * 本包 bundle 的 npm 包名。descriptor `id`、`$mount` 的 `package` 位、客户端槽位键与
 * package.json 的 `name` 必须逐字相等（宿主按 bundle 包名派发设置卡槽位，改名漏一处
 * 的症状是卡片静默不渲染而不是报错），因此只有这一个定义处，其余各方引它。
 */
export const OCR_BUNDLE_PACKAGE = "@jayyuen66/dsh-ocr-review";

/**
 * 拒绝回执的**种类码**（`status` 位）的唯一出处。
 *
 * 不是 HTTP 状态：本包已无 HTTP 面，卡片只读 `error`。集中定义的理由是它此前只是裸
 * `number`：宿主实现在十几处各写一次字面量、类型收不到任何提示，调用方也分不清
 * 「本包自定的种类码」与顺手塞进来的 HTTP 状态码。测试仍**独立写死**数字（不从这份表
 * 派生），否则两边一起错时判据会跟着错。
 *
 * · `invalid`：入参/配置不合法，卡片改完就能重试。
 * · `internal`：宿主侧读取或执行失败（读不到配置、子进程起不来），不是改参数能解决的。
 */
export const OCR_REFUSE_STATUS = {
  invalid: 400,
  internal: 500,
} as const;

/** 请求被本包拒绝时的回执。`status` 是本包保留的拒绝种类码（见 {@link OCR_REFUSE_STATUS}，
 *  不是 HTTP 状态：本包已无 HTTP 面），卡片只读 `error`；两侧线上形状与
 *  test/remote.test.ts 都按这一枚钉住，删它等于改契约。 */
export interface OcrRemoteRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: (typeof OCR_REFUSE_STATUS)[keyof typeof OCR_REFUSE_STATUS];
}

/** 选择 provider/model 的入参（源码模式下网关按宿主方法签名的参数名取 `request`）。 */
export interface OcrSelectRequest {
  readonly provider: string;
  readonly model: string;
}

/** 应用成功后写进外部 ocr CLI 配置的那几项（不含 key）。 */
export interface OcrAppliedConfig {
  readonly provider: string;
  readonly model: string;
  readonly url: string;
  readonly protocol: string;
}

/** `ocr llm test` 的回执（`ok` 是测试结论，不是调用成败）。 */
export interface OcrLlmTest {
  readonly ok: boolean;
  readonly output: string;
}

export interface OcrSelectOk {
  readonly ok: true;
  readonly applied: OcrAppliedConfig;
  readonly llmTest: OcrLlmTest | null;
}

export type OcrSelectReply = OcrSelectOk | OcrRemoteRefused;

export interface OcrMigrateOk {
  readonly ok: true;
  readonly migrated: readonly string[];
  readonly skippedUnknown: readonly string[];
}

export type OcrMigrateReply = OcrMigrateOk | OcrRemoteRefused;

/**
 * 手动连接测试的回执：`ok` 是 `ocr llm test` 的**结论**，不是调用成败。
 *
 * 注意 `ok` 不能当判别式：它两态都取得到（测试失败时就是 false），与
 * `OcrRemoteRefused.ok`（恒 false）重叠。分辨「请求被拒」与「测试没过」要用
 * `error`/`status`（只有拒绝回执才有这两项），或直接用 {@link isRemoteRefused}。
 */
export interface OcrTestOk {
  readonly ok: boolean;
  readonly output: string;
}

export type OcrTestReply = OcrTestOk | OcrRemoteRefused;

/**
 * 版本探测的回执。`consistent` 是三态：`null` = 压根没读出版本（未发布构建、超时、
 * 没装），这时宣称「不一致」等于把没证据的事说成结论。
 */
export interface OcrProbeOk {
  readonly ok: boolean;
  readonly version: string | null;
  readonly expectedVersion: string;
  readonly consistent: boolean | null;
  readonly output: string;
  readonly reason: string;
  readonly changeText: string;
}

export type OcrProbeReply = OcrProbeOk | OcrRemoteRefused;

/** MCP 配置读面：`json` 是 `mcp_servers` 的 pretty JSON（不含其他配置/keys）；
 *  `revision` 是这一支的摘要，保存时原样交回，作为「读-改-写」之间没人插队的基线。 */
export interface OcrMcpOk {
  readonly ok: true;
  readonly json: string;
  readonly revision: string;
}

export type OcrMcpReply = OcrMcpOk | OcrRemoteRefused;

/** MCP 配置写面入参：原始 JSON 文本，由宿主校验后写入；`revision` 是读侧交回的基线，
 *  缺省表示不带基线（旧客户端），宿主跳过冲突比较。`exactOptionalPropertyTypes` 下显式
 *  `revision: undefined` 与「没带这一位」同义，两者都按「没有基线」处理。 */
export interface OcrMcpSaveRequest {
  readonly json: string;
  readonly revision?: string | undefined;
}

/** MCP 配置写面回执：`count` 是保存后的 server 条数，`revision` 是该版内容的新摘要。 */
export interface OcrMcpSaved {
  readonly ok: true;
  readonly count: number;
  readonly revision: string;
}

export type OcrMcpSaveReply = OcrMcpSaved | OcrRemoteRefused;

/** ChatGPT 登录态只读回执；`loginCommand` 是给人照抄的登录命令。 */
export interface OcrAuthOk {
  readonly ok: boolean;
  readonly output: string;
  readonly loginCommand: string;
}

export type OcrAuthReply = OcrAuthOk | OcrRemoteRefused;

/** 选择 ChatGPT provider + 模型（不写 key，OAuth 凭据由 ocr auth 管）。 */
export interface OcrChatGptRequest {
  readonly model: string;
}

export interface OcrChatGptOk {
  readonly ok: true;
  readonly model: string;
}

export type OcrChatGptReply = OcrChatGptOk | OcrRemoteRefused;

/** 回执公共形状（判别只看拒绝回执独有的 `status`）。 */
export type OcrAnyReply =
  | OcrSelectReply
  | OcrMigrateReply
  | OcrTestReply
  | OcrProbeReply
  | OcrMcpReply
  | OcrMcpSaveReply
  | OcrAuthReply
  | OcrChatGptReply;

/**
 * 判别「请求被本包拒绝」与「请求做完了但结论不理想」。
 *
 * 为什么需要它：`ok` 在 `OcrTestOk` 里是业务结论（可以是 false），与
 * `OcrRemoteRefused.ok`（恒 false）重叠，所以 `if (!reply.ok)` 在 TypeScript 里
 * 收窄不到拒绝分支，运行时也会把「LLM 测试没过」当成「请求被拒」——
 * 两者的用户可见文案完全不同。
 *
 * 入参刻意是 `unknown`：回执来自远端 JSON，本仓不保证它一定是对象。判据是拒绝回执
 * **同时**独有的三件——`ok === false`、`error` 是非空串、`status` 是整数：
 * · 只凭 `"status" in reply`：null/原始值会直接抛 TypeError，把「解析异常」升级成
 *   「客户端崩」，正好与这个函数存在的意义相反；
 * · 只凭 `typeof status === "number"`：NaN 会通过；业务回执将来带一个数字字段
 *   （HTTP/作业状态码）也会被误判成拒绝，用户看到的文案与接下来该做什么完全不同；
 * · 少了 `ok === false`：同上，判别式落在一个与业务结论重叠的位上。
 */
export function isRemoteRefused(reply: unknown): reply is OcrRemoteRefused {
  if (typeof reply !== "object" || reply === null) {
    return false;
  }
  const candidate = reply as { ok?: unknown; error?: unknown; status?: unknown };
  return (
    candidate.ok === false &&
    typeof candidate.error === "string" &&
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status)
  );
}
