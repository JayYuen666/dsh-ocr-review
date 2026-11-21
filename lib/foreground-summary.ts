// dsh-ocr-review/lib/foreground-summary.ts —— 前台长任务（review / scan）共用的结果收尾。
//
// 两条路唯一的差别是解析失败文案里报的工具名（`ocr` / `ocr scan`），其余全部相同：读
// `--output`、解析、脱敏回显、摘要口径、以及拼进 hint 的两句提示（版本核对、前台耗时）。
// 这三段原先写在 host.ts 里并且被两个 120 行的注册函数各抄一遍——抄出来的第二份迟早和
// 第一份各说一套，而这里每一条差异都直接进模型可见的回执。
// 非零退出的收尾也走同一个函数（`error` 入参在场）：OCR 1.13.12 起 partial 带运营性失败
// 也退非零而结果照常发布，有可用覆盖就交回摘要并标注「评审不完整」——判据见
// foregroundSummaryOf 的注释。
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
import { echoRaw, readOutFile, readOutFileSilent, withCoverageDetail } from "./output-file.ts";
import { redactKeyMaterial } from "./output.ts";
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
  /** 这次前台执行的墙钟毫秒（runForeground 记下的）。非零退出的收尾拿不到——
   *  runForeground 是抛错退出的，没有计时可交；缺省时不拼耗时句。 */
  readonly elapsedMs?: number;
  /** 解析失败文案里报的工具名（`ocr` / `ocr scan`）。 */
  readonly toolName: string;
  /** 最近一次实测到的外部 CLI 版本；null = 还没测过。 */
  readonly measuredVersion: string | null;
  /** 评论截断条数（entry config `maxComments` 的落地值；0 = 全量）。 */
  readonly maxComments: number;
  /** 文案表。 */
  readonly messages: OcrReviewMessages;
  /** runForeground 抛出的原错误：在场即「非零退出的收尾」。OCR 1.13.12 起（review_cmd.go
   *  的 reviewManifestRequiresNonZeroExit）partial 带运营性失败也退非零而结果照常发布，
   *  有可用覆盖就交回摘要并标注「评审不完整」，拿不出才把原错误（附 coverage 明细）抛出。 */
  readonly error?: unknown;
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
  elapsedMs: number | undefined,
  messages: OcrReviewMessages,
): ReviewSummaryView {
  if (elapsedMs === undefined) {
    return summary;
  }
  const note = format(messages.elapsedNote, { duration: formatDuration(elapsedMs) });
  return { ...summary, hint: `${summary.hint}\n${note}` };
}

/**
 * 读 --output、解析、出摘要，并拼上版本核对与前台耗时两句提示。
 *
 * `error` 在场时是「非零退出的收尾」：OCR 1.13.12 起（review_cmd.go 的
 * reviewManifestRequiresNonZeroExit）partial 带任一**运营性**失败（timeout/provider/
 * config/panic/unknown）就退非零，而结果照常发布（其 e2e 明写 "The partial JSON result
 * must still be published before the command returns its non-zero status"）。此前非零一律
 * 抛错、只把「哪些文件没审成」附上去，已审出文件的评论整份丢弃——在那个契约下这条路径
 * 罕见，新契约下一次 provider 429 就会踩进去。「可用覆盖」的判据与上游成功口径同源：
 * 解析 ok（status 白名单内，failed 已被 parse 层判掉）且 coverage 在场且
 * completed+reused > 0。comments 为 0 也交回摘要——完成的文件没有发现是合法结果，
 * 抛错会把「审了没发现问题」说成「评审失败」。partial note 拼在 hint 尾部（理由同
 * 文件头：进 hint 而不是新增字段）；耗时句同样交 withElapsedNote 判断，error 路径
 * 没有计时可交，自然少这一句。
 *
 * @param input - 见 ForegroundSummaryInput。
 * @returns 结构化摘要；解析失败（成功路径）时是那段说明字符串（schema 的 string 分支——
 *   不报假干净，也不假装结构化）。拿不出可用覆盖时抛出（带失败明细的）原错误。
 */
export function foregroundSummaryOf(input: ForegroundSummaryInput): ReviewSummaryView | string {
  const { outPath, elapsedMs, toolName, measuredVersion, maxComments, messages } = input;
  const failed = input.error !== undefined;
  const text = failed ? readOutFileSilent(outPath) : readOutFile(outPath, messages);
  if (text === null) {
    // 只有 error 路径会走到这里（readOutFile 对缺失/过大是抛错而不是 null）：
    // 读不到就把原错误原样交回，不往失败详情里再叠一层「读不到 --output」。
    throw withCoverageDetail(input.error, outPath, messages);
  }
  const parsed = parseReviewOutput(text, messages);
  if (failed) {
    const { coverage } = parsed;
    if (!parsed.ok || coverage === null || coverage.completed + coverage.reused <= 0) {
      throw withCoverageDetail(input.error, outPath, messages);
    }
    const summary = summarizeReview(parsed, messages, { maxComments });
    const items = coverage.failedItems.join("; ");
    const note = format(messages.partialResultNote, {
      failed: String(coverage.failed),
      selected: String(coverage.selected),
      items: items === "" ? messages.statusNone : redactKeyMaterial(items),
    });
    const withVersion = withCliVersionNote(
      { ...summary, hint: `${summary.hint}\n${note}` },
      measuredVersion,
      messages,
    );
    return withElapsedNote(withVersion, elapsedMs, messages);
  }
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
