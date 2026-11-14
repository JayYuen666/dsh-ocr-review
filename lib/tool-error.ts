// lib/tool-error.ts —— 本包工具失败的**错误类与错误码**。
//
// 为什么要码而不只是人话：宿主 `packages/core/tools/src/pipeline.ts` 的 `errorInfo()` 用
// `error instanceof HarnessError` 判断要不要把 `{ name, code }` 写进工具失败的
// `ToolFailure.info`。判不中时 `info` **整块消失且没有任何提示** —— 模型只看到一句
// `Error: …`，无法据此区分「升级工具」「改参数」「换条路」这几种出路完全不同的失败。
// 码是给模型与下游消费方判读的，人话仍然是 `message`，两者不互相替代。
//
// 为什么父类必须是**宿主那一份** `HarnessError`：类身份按模块实例算。`@deepseek-ai/dsh-error`
// 声明在 peerDependencies 时构建期按包名外部化，本包与宿主共享同一份实例，`instanceof` 成立；
// 一旦挪回 devDependencies，rolldown 会把整包内联进 host.js，本包继承的是产物里另一个类，
// 宿主的判据恒为 false —— 码静默消失，而源码、单测、类型检查一路绿。
// `test/publish-manifest.test.ts` 有一条正相断言盯着产物里的说明符。
//
// 码值一经发布即持久化契约（宿主 error-codes 的注释原话：`The values are persisted
// contract`）：会话日志里存的是这些串，改名等于让旧日志读不懂。要加码就新增，不要复用。

import { HarnessError } from "@deepseek-ai/dsh-error";

/**
 * 本包工具失败的错误码。
 *
 * 分类依据是**出路不同**，不是「消息文本不同」：模型看到码之后该做的事，是这几条的分界线。
 */
export const OCR_TOOL_ERROR_CODES = {
  /** `ocr` 二进制不在 PATH 上：出路是装它，不是重试。 */
  binaryMissing: "OCR_BINARY_MISSING",
  /** 显式给的 timeoutMinutes 到了：可调大再试，或缩小扫描面。 */
  timedOut: "OCR_TIMED_OUT",
  /** 调用被取消（宿主 signal 中止或作业被停）：不是失败，是别人叫停了。 */
  aborted: "OCR_ABORTED",
  /** `ocr` 跑起来但退出码非零：看回显里的失败详情改输入。 */
  commandFailed: "OCR_COMMAND_FAILED",
  /** 调用方参数形态不合契约（非对象、必填缺失）：改参数即可。 */
  badArguments: "OCR_BAD_ARGUMENTS",
  /** 工具返回值没命中自己的 output schema：本插件的缺陷，不是模型的问题。 */
  outputShape: "OCR_OUTPUT_SHAPE",
  /** 宿主没有 jobs 注册表：前台 `wait:true` 可用，后台不可用。 */
  jobsUnavailable: "OCR_JOBS_UNAVAILABLE",
} as const;

/** {@link OCR_TOOL_ERROR_CODES} 的取值类型。 */
export type OcrToolErrorCode = (typeof OCR_TOOL_ERROR_CODES)[keyof typeof OCR_TOOL_ERROR_CODES];

/**
 * 本包工具失败的统一错误类。
 *
 * `name` 报自己的类名（而不是父类的 `HarnessError`）：宿主把它写进 `ToolFailure.info.name`，
 * 取父类名会让「哪个插件错的」从回执里消失。
 */
export class OcrToolError extends HarnessError {
  public constructor(code: OcrToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options);
    this.name = "OcrToolError";
  }
}
