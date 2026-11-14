// dsh-ocr-review/lib/foreground-summary.ts —— 前台长任务（review / scan）共用的结果收尾。
//
// 两条路唯一的差别是解析失败文案里报的工具名（`ocr` / `ocr scan`），其余全部相同：读
// `--output`、解析、脱敏回显、摘要口径、以及拼进 hint 的两句提示（版本核对、前台耗时）。
// 这三段原先写在 host.ts 里并且被两个 120 行的注册函数各抄一遍——抄出来的第二份迟早和
// 第一份各说一套，而这里每一条差异都直接进模型可见的回执。
//
// 为什么提示拼进 hint 而不是新增字段：output schema 是 `additionalProperties: false` +
// 逐字段 `required`，加一枚要同时动 schema、必填表和 lib/output.ts 的形态闸三处；而这两条
// 信息的全部价值就是「模型读到它」，hint 那段本来就是教模型怎么读这份结果。
//
// 后台路径不经过这里：`wait: false` 启动即返回，耗时属于作业记录（模型用 job_output 看），
// 本包不再重复报一遍（用户裁定：「sessionStats 不做 rtk，改为给 ocr 的前台作业加耗时统计，
// 后台运行的不加」）。
//
// 引用面（新建时探查，均零命中）：仓库根 grep `foreground-summary.ts` → No matches found
// （无 import/引用者；接线后 host.ts 的两个注册函数成为唯一消费者）；test 层 grep
// `foreground-summary|foregroundSummaryOf` → No matches found（无测试触达；由
// test/host.test.ts 的版本核对与前台耗时两组用例经工具路径间接覆盖）；文档层同 grep →
// No matches found（README/DETAIL/CHANGELOG 未提及）。
//
// 受影响的导出：新增 `RAW_ECHO_LIMIT`（从 host.ts 迁入，host.ts 仍保留同名再导出以维持
// 既有测试引用）与 `foregroundSummaryOf`；`withCliVersionNote` / `withElapsedNote` 变为本
// 模块私有。不改任何 render/schema 形状。

import type { ReviewSummaryView } from "./parse.ts";
import { parseReviewOutput, summarizeReview } from "./parse.ts";
import { echoRaw, readOutFile } from "./output-file.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { format } from "./messages.ts";
import { formatDuration } from "./duration.ts";
import { EXPECTED_OCR_CLI_VERSION } from "./cli.ts";

/** 解析失败时回显给模型的原始内容长度上限（UTF-16 码元；已脱敏）。
 *  单位是码元不是「字符」：本常量喂给 echoRaw→truncateEnd，那一刀按码元数计
 *  （一张 emoji = 2 枚），写「字符」会把给模型的说明夸大约一倍。 */
export const RAW_ECHO_LIMIT = 500;

/** 前台长任务收尾的入参（>5 参数会撞 max-params，收成对象，与 host.ts 的
 *  RunTuning / BackgroundJob 同一取舍）。 */
export interface ForegroundSummaryInput {
  /** OCR 的 --output 临时文件。 */
  readonly outPath: string;
  /** 这次前台执行的墙钟毫秒（runForeground 记下的）。 */
  readonly elapsedMs: number;
  /** 解析失败文案里报的工具名（`ocr` / `ocr scan`）。 */
  readonly toolName: string;
  /** 最近一次实测到的外部 CLI 版本；null = 还没测过。 */
  readonly measuredVersion: string | null;
  /** 评论截断条数（entry config `maxComments` 的落地值；0 = 全量）。 */
  readonly maxComments: number;
  /** 文案表。 */
  readonly messages: OcrReviewMessages;
}

/**
 * 把版本核对提示追加到摘要的 `hint` 尾部，让模型读得到「这份结果不是按插件核对的版本跑的」。
 *
 * 没实测值（装载期自检关着、或那条命令跑砸了）就原样交回：不知道就是不知道，编一句
 * 「版本可能不一致」会让模型把没发生过的事转述给用户。
 * @param summary - summarizeReview 的产物。
 * @param measured - 最近一次实测到的外部 CLI 版本；null = 还没测过。
 * @param messages - 文案表。
 * @returns 同一份摘要，或 hint 尾部多了一句的副本。
 */
function withCliVersionNote(
  summary: ReviewSummaryView,
  measured: string | null,
  messages: OcrReviewMessages,
): ReviewSummaryView {
  if (measured === null || measured === EXPECTED_OCR_CLI_VERSION) {
    return summary;
  }
  const note = format(messages.versionMismatch, {
    actual: measured,
    expected: EXPECTED_OCR_CLI_VERSION,
  });
  return { ...summary, hint: `${summary.hint}\n${note}` };
}

/**
 * 在摘要的 hint 尾部加一句前台耗时（拼进 hint 的理由与 withCliVersionNote 相同）。
 * @param summary - summarizeReview 的产物（或被 withCliVersionNote 加过一句的副本）。
 * @param elapsedMs - runForeground 记下的墙钟毫秒。
 * @param messages - 文案表（`{duration}` 由 formatDuration 排好版）。
 * @returns 同一份摘要，或 hint 尾部多了一句耗时的副本。
 */
function withElapsedNote(
  summary: ReviewSummaryView,
  elapsedMs: number,
  messages: OcrReviewMessages,
): ReviewSummaryView {
  const note = format(messages.elapsedNote, { duration: formatDuration(elapsedMs) });
  return { ...summary, hint: `${summary.hint}\n${note}` };
}

/**
 * 读 --output、解析、出摘要，并拼上版本核对与前台耗时两句提示。
 *
 * @param input - 见 ForegroundSummaryInput。
 * @returns 结构化摘要；解析失败时是那段说明字符串（schema 的 string 分支——不报假干净，
 *   也不假装结构化）。
 */
export function foregroundSummaryOf(input: ForegroundSummaryInput): ReviewSummaryView | string {
  const { outPath, elapsedMs, toolName, measuredVersion, maxComments, messages } = input;
  const text = readOutFile(outPath, messages);
  const parsed = parseReviewOutput(text, messages);
  if (!parsed.ok) {
    return format(messages.parseFailedWithReason, {
      tool: toolName,
      message: parsed.message,
      limit: String(RAW_ECHO_LIMIT),
      raw: echoRaw(text, RAW_ECHO_LIMIT),
    });
  }
  const summary = summarizeReview(parsed, messages, { maxComments });
  const withVersion = withCliVersionNote(summary, measuredVersion, messages);
  return withElapsedNote(withVersion, elapsedMs, messages);
}
