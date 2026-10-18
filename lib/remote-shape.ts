// lib/remote-shape.ts —— 设置卡读面（Typert Remote）两侧共用的**线上形状**。
//
// 为什么单列：宿主侧的服务实现与客户端读取器分属两个产物（host.js / client.js），
// 各自内联一份 lib/。形状放在这个零依赖叶子上，两边引的是同一份声明；写成
// `import type` 后对任一产物的字节数贡献都是零。叶子必须**零导入**：客户端的类型
// 程序不加载 node 类型（tsconfig.client.json 的 `types: []`），一旦从
// lib/ocr-config.ts 借类型，整条 node:fs 依赖链就会被拖进来。

/** 宿主服务键 = 客户端线上命名空间（两侧共用的唯一来源）。 */
export const OCR_REMOTE_NAMESPACE = "ocrReview";

/** 请求被本包拒绝时的回执。`status` 是本包保留的拒绝种类码（不是 HTTP 状态：本包已无 HTTP 面），
 *  卡片只读 `error`；两侧线上形状与 test/remote.test.ts 都按这一枚钉住，删它等于改契约。 */
export interface OcrRemoteRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: number;
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

/** 手动连接测试的回执：`ok` 是 `ocr llm test` 的退出结论。 */
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
