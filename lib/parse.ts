// lib/parse.ts —— 纯函数：把 ocr CLI 的 JSON 输出解析为省 token 的结构化摘要。
// 契约依据（open-codereview.ai/docs/cli-reference + FAQ，字段名以 CLI 侧 Go 声明为准）：
//   - review/scan JSON 恰好一个对象：status/summary/comments/warnings/session_id
//     /manifest/tool_calls 可选；comments 字段 per-comment：path/content/start_line/end_line
//     /existing_code/suggestion_code/category/severity/thinking。
//   - warnings 条目是 `{file,message,type}`（不是 `error`）。type 标出子任务失败
//     （subtask_error / scan_subtask_error），带 manifest 时 CLI 会把这类条目从
//     warnings 里摘掉——失败事实改由 manifest.coverage.failed 承载，两处都要读，
//     只读一处就有一半失败看不见。
//   - summary.budget_exceeded 只在真被 token 预算截断时出现；status 仍是 partial，
//     单看 status 分不出「审完了没发现」和「预算花完提前收工」。
//   - tool_calls = {total, failure, failure_by_tool, failure_details}，是模型侧
//     「这一场里 LLM 的工具调用失败了多少」的唯一出口（`--audience agent` 下 CLI 的
//     进度行走 io.Discard，任何 stdout 文本都到不了这里）。
//   - status: success | complete | partial | completed_with_warnings
//     | completed_with_errors | skipped。skipped 表示无变更可审（区别于“审了但零
//     发现”），partial 表示部分文件未完成但整体有覆盖（评论仍有效）。白名单外
//     （含缺失、`{"error":…}` 型错误对象）一律 ok=false：exit 0 不等于评审成功。
//   - 退出码 0 = 完成（可能有 warning）；1 = 致命错误。致命错误由调用方根据
//     stderr 抛错，不走到本解析。
//   - delegate preview: {schema_version,mode,repository,total_files,
//     reviewable_count,excluded_count,total_insertions,total_deletions,
//     reviewable_files[{path,status,insertions,deletions}],excluded_files[]}。
//   - delegate rule: {schema_version,groups[{group_id,source,pattern,files[],rule}]}。
//
// 文案：本模块产出的人读文本（解析失败原因、摘要 hint、0 行定位说明）全部来自
// lib/messages.ts 的消息表，由调用方（host.ts）按官方 locale 偏好取一份注入
// ——纯函数不读设置，所以 messages 是入参而不是模块常量。
//
// 分层：本模块只负责「OCR 的 JSON → 本包形状」。severity 白名单、未知等级归一、
// 排序位与计数聚合都在 lib/severity.ts（摘要的排序与聚合共用那一个口径）。
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { aggregateComments, severityRank } from "./severity.ts";
import type { CommentAggregation } from "./severity.ts";

/** 只认十进制整数的行号/计数文本。 */
const DECIMAL_INTEGER = /^\d+$/u;

/**
 * OCR 评审 JSON 的 status 枚举（判据在 CLI 侧 `cmd/opencodereview/output.go` 的 jsonOutput
 * 装配与 `internal/session/manifest.go` 的 TerminalState）。
 * 白名单外的一律视为失败：exit 0 不等于评审成功——`{"error":"auth failed"}`
 * 这类「没有 status 的错误对象」若被当作 ok:true，模型会把「0 条评论」读成
 * 「代码干净」，是最坏的一类假阳性。
 *
 * `failed` 在名单里，但**单独判成 ok:false**（见 `parseReviewOutput`）。两件事要分开：
 * ① 名字得认——非零退出时 CLI 照发的那份 manifest 就带 `status:"failed"`，
 * `withCoverageDetail` 要靠它读出「哪些文件没审成」；不认这个值就等于把失败明细整条丢掉。
 * ② 认了不等于成功——万一它带着 exit 0 回来，把它当 ok:true 就会把一份全场失败的回执
 * 摘要成「0 条评论」，那正是本段开头要避免的假阳性。
 *
 * partial 是 manifest 终态之一：部分文件失败但整体有覆盖、以及 token 预算截断后仍有
 * 覆盖，都以 exit 0 + status "partial" 输出。此前白名单漏了它，整场已花费 token 的
 * 评审被误报成「status 非法」并丢弃全部评论。
 *
 * 有 manifest 时 status 就是它的终态（complete/partial/skipped），success 与
 * completed_with_warnings/completed_with_errors 只在没有 manifest 的产出上出现——
 * 逐文件失败在那两种形态下的落点也不同（前者在 coverage.failed，后者在 warnings）。
 */
const REVIEW_STATUSES = [
  "success",
  "complete",
  "partial",
  "failed",
  "completed_with_warnings",
  "completed_with_errors",
  "skipped",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** 解析结果 status：白名单值，或两种失败形态（都伴随 ok=false）。 */
export type ParsedReviewStatus = ReviewStatus | "unparseable" | "invalid";

export interface OcrComment {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  category: string;
  severity: string;
  existingCode: string;
  suggestionCode: string;
}

export interface ReviewSummary {
  filesReviewed: number;
  comments: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  elapsed: string;
}

/** OCR 的 `llm` 身份：`provider` 只在命名源时出现，`model` 是规范化后的模型名。 */
export interface LlmIdentity {
  provider: string | null;
  model: string;
}

/** `resume` 回执：本次续审复用了哪些文件、跨了哪些模型。 */
export interface ResumeView {
  resumedFrom: string;
  reusedFiles: number;
  rerunFiles: number;
  previousModel: string;
  currentModel: string;
}

/** OCR 的 `retry_report`：只保留三个能说明「这一场被限流/重试拖过」的计数。 */
export interface RetryView {
  totalRetries: number;
  recoveredRequests: number;
  failedRequests: number;
}

/**
 * OCR 的 `tool_calls` 字段：这一场里 LLM 发起的工具调用总数与失败数。
 *
 * 为什么必须读它：`--audience agent` 下 CLI 把进度行（含 "No tool calls parsed"、
 * "Max tool requests reached"）写进 io.Discard，stdout 一个字都到不了宿主；模型侧要
 * 判断「是模型不会调工具，而不是代码没问题」，只有这一条路。
 */
export interface ToolCallView {
  total: number;
  failure: number;
  /** 渲染行：`tool_name @ item_key: error`，截到 DIAGNOSTIC_DETAIL_LIMIT。 */
  failures: string[];
}

/**
 * OCR 的 `manifest.coverage`：五个互斥文件集的大小，selected 是分母。
 *
 * 这是「这一场到底审完了多少文件」的权威口径，与 `warnings` 互补：带 manifest 时 CLI
 * 会把子任务失败从 warnings 里摘掉（同一事实不在两处重复，也避免 provider 原始错误文本
 * 泄漏），失败条目只剩 coverage.failed。`droppedCount` 一类衡量的是**本摘要的截断**，
 * 与这里的**运行覆盖度**是两件事，不能互相替代。
 */
export interface CoverageView {
  selected: number;
  completed: number;
  reused: number;
  failed: number;
  waived: number;
  /** 渲染行：`path [classification] reason`，截到 DIAGNOSTIC_DETAIL_LIMIT。 */
  failedItems: string[];
}

export interface ParsedReview {
  ok: boolean;
  status: ParsedReviewStatus;
  message: string;
  skipped: boolean;
  summary: ReviewSummary | null;
  /** `summary.budget_exceeded`：被 token 预算截断过（status 仍是 partial，看不出这一层）。 */
  budgetExceeded: boolean;
  /** 1.13.3 的 `review_limit_reached` / scan 的 `token_budget_reached`：限流截断过。 */
  limitReached: boolean;
  llm: LlmIdentity | null;
  projectSummary: string | null;
  projectSummaryTruncated: boolean;
  resume: ResumeView | null;
  groupCount: number;
  retry: RetryView | null;
  traceId: string | null;
  comments: OcrComment[];
  warnings: string[];
  toolCalls: ToolCallView | null;
  coverage: CoverageView | null;
  sessionId: string;
  /** comments 数组里形态不合（非对象/无 content）被丢弃的条目数：> 0 即
   *  「本次解析没有覆盖全部产出」，摘要据此无法宣称干净。 */
  droppedComments: number;
}

/** 未知 JSON 值 → 安全字符串（非字符串/缺省给 ''）。 */
function str(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * 行号与增删统计的有效域：有限、非负、整数。
 *
 * 为什么把负数和小数一起挡掉：行号出现 "-3" 会被下游当成「未锚定的评论」而丢弃
 * （分类错了——它是畸形值不是缺锚点），而 insertions: -5 会原样传播进给模型看的
 * diff 统计。两者都是上游畸形值被当合法值透传。0 在下游有既定语义（未锚定 / 无统计），
 * 故作兜底值。
 */
function nonNegativeInt(value: number): number {
  // 直接判原值，**不能先 Math.trunc**：3.7 → 3、0.5 → 0 之后 isSafeInteger 一律成立，
  // 小数就被静默改写了——行号偏移一位、insertions 少算一截，而上方注释承诺的是
  // 「负数和小数一起挡掉」。用 Number.isSafeInteger 而不是 Number.isFinite：1e300
  // 有限但远超安全整数域，原样传播会把行号与统计变成天文数字。与 host.ts:readMaxComments
  // 的口径保持一致。
  if (!Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

/** 数值字段解析：number 与「数字字符串」都接受（OCR 部分 provider 实测把 start_line
 *  输出成 "42"，一律当 0 会把真实评论判成「未锚定」而被摘要丢掉），空串/NaN/Infinity/
 *  其它类型回 0。落进 `nonNegativeInt` 那道有效域。 */
function num(value: unknown): number {
  if (typeof value === "number") {
    return nonNegativeInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // 只认十进制整数：`Number()` 还接受 "0x10"（=16）、"1e3"（=1000）、"0b11" 这类
    // 写法，OCR 一旦吐出十六进制行号，"0x10" 会被当成第 16 行报给模型。
    if (!DECIMAL_INTEGER.test(trimmed)) {
      return 0;
    }
    return nonNegativeInt(Number(trimmed));
  }
  return 0;
}

/**
 * 明细行上限：coverage.failed 与 tool_calls.failure_details 在大会话里可以是几百条，
 * 逐条铺开会把「省 token 的摘要」变成第二份原始输出，而模型只需要知道「有哪些文件没审成」。
 */
const DIAGNOSTIC_DETAIL_LIMIT = 8;

/** 布尔字段：只认真布尔，缺省与非真值一律 false（OCR 用 omitempty 表示「没有发生」）。 */
function boolOf(value: unknown): boolean {
  return value === true;
}

/** 走 plan 预算/工具轮次上限的两枚警告：它们是「限流截断」的唯一结构化信号。 */
const LIMIT_WARNING_TYPES: ReadonlySet<string> = new Set([
  "review_limit_reached",
  "token_budget_reached",
]);

/** 把 project_summary 截到摘要预算内；截断事实单独带出，别让模型把半截当全文。 */
const PROJECT_SUMMARY_LIMIT = 4000;

/** `llm` 身份：两个字段都读不出时回 null，而不是造一个空模型。 */
function llmOf(raw: unknown): LlmIdentity | null {
  if (!isRecord(raw)) {
    return null;
  }
  const provider = str(raw["provider"]).trim();
  const model = str(raw["model"]).trim();
  if (provider === "" && model === "") {
    return null;
  }
  return { provider: provider === "" ? null : provider, model };
}

/** `resume` 回执：字段全空时回 null（CLI 只在真的续审时发这个对象）。 */
function retryOf(raw: unknown): RetryView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const view: RetryView = {
    totalRetries: num(raw["total_retries"]),
    recoveredRequests: num(raw["recovered_requests"]),
    failedRequests: num(raw["failed_requests"]),
  };
  return view.totalRetries === 0 && view.recoveredRequests === 0 && view.failedRequests === 0
    ? null
    : view;
}

function resumeOf(raw: unknown): ResumeView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const view: ResumeView = {
    resumedFrom: str(raw["resumed_from"]),
    reusedFiles: num(raw["reused_files"]),
    rerunFiles: num(raw["rerun_files"]),
    previousModel: str(raw["previous_model"]),
    currentModel: str(raw["current_model"]),
  };
  const empty =
    view.resumedFrom === "" &&
    view.reusedFiles === 0 &&
    view.rerunFiles === 0 &&
    view.previousModel === "" &&
    view.currentModel === "";
  return empty ? null : view;
}

/**
 * 明细行收尾：截断时补一条「另有 N 条已省略」，让读的人知道后面还有，而不是以为看到了全部。
 * @param lines - 已渲染的明细行
 * @param total - 该组的总条数
 * @param messages - 文案表
 * @returns 不超过上限的行数组
 */
function capLines(lines: string[], total: number, messages: OcrReviewMessages): string[] {
  if (lines.length >= total) {
    return lines;
  }
  return [...lines, format(messages.diagnosticOmitted, { count: String(total - lines.length) })];
}

/** 计数字段的合法形态：非负整数或纯十进制数字串（与 {@link num} 的取值域对齐，
 *  否则 "x" 或 -1 会被 num 折成 0，把「读不出」伪装成「零失败」）。 */
function isCount(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return typeof value === "string" && DECIMAL_INTEGER.test(value.trim());
}

/**
 * 解析 `tool_calls`。字段缺失或为 null（这一场没有工具调用记录）返回 null；
 * 存在却读不出 total/failure 两个计数、或 failure_details 不是数组，同样返回 null，
 * 并交出 unreadable 让调用方把「读不出」这条挂进 warnings——诊断字段坏掉不该让整场
 * 评审作废（评论仍然有效），但也不能把它读成「零失败」。
 */
function toolCallsOf(
  raw: unknown,
  messages: OcrReviewMessages,
): { view: ToolCallView | null; unreadable: boolean } {
  if (raw === undefined || raw === null) {
    return { view: null, unreadable: false };
  }
  const doc = isRecord(raw) ? raw : undefined;
  const details = doc?.["failure_details"];
  if (
    doc === undefined ||
    !isCount(doc["total"]) ||
    !isCount(doc["failure"]) ||
    (details !== undefined && !Array.isArray(details))
  ) {
    return { view: null, unreadable: true };
  }
  const rows: unknown[] = Array.isArray(details) ? details : [];
  const rendered = rows
    .filter((row): row is Record<string, unknown> => isRecord(row))
    .map((row) => {
      const key = str(row["file_path"]);
      const tool = str(row["tool_name"]);
      const error = str(row["error"]);
      return `${tool || messages.statusNone}${key === "" ? "" : ` @ ${key}`}: ${error}`;
    });
  return {
    view: {
      total: num(doc["total"]),
      failure: num(doc["failure"]),
      failures: capLines(rendered.slice(0, DIAGNOSTIC_DETAIL_LIMIT), rows.length, messages),
    },
    unreadable: false,
  };
}

/** coverage 的一个集合：不是数组即读不出（undefined）。 */
function setOf(coverage: Record<string, unknown>, key: string): unknown[] | undefined {
  const items: unknown = coverage[key];
  return Array.isArray(items) ? items : undefined;
}

/**
 * 解析 `manifest.coverage`。五个键与 CLI 侧 Coverage 结构一一对应：selected 是分母，
 * 其余四个是它的互斥划分。任一不是数组即整体读不出——宁可回 null 让模型看见「这里没有
 * 覆盖度数据」，也不要用 0 冒充「一个文件都没审」。
 * @param raw - `root["manifest"]`
 * @param messages - 文案表
 * @returns 覆盖度视图，与「manifest 存在但读不出」的标记
 */
function coverageOf(
  raw: unknown,
  messages: OcrReviewMessages,
): { view: CoverageView | null; unreadable: boolean } {
  if (raw === undefined || raw === null) {
    return { view: null, unreadable: false };
  }
  const coverage = isRecord(raw) ? raw["coverage"] : undefined;
  if (!isRecord(coverage)) {
    return { view: null, unreadable: true };
  }
  const selected = setOf(coverage, "selected");
  const completed = setOf(coverage, "completed");
  const reused = setOf(coverage, "reused");
  const failedRows = setOf(coverage, "failed");
  const waived = setOf(coverage, "waived");
  if (
    selected === undefined ||
    completed === undefined ||
    reused === undefined ||
    failedRows === undefined ||
    waived === undefined
  ) {
    return { view: null, unreadable: true };
  }
  const rendered = failedRows
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const path = str(item["path"]);
      const classification = str(item["classification"]);
      const reason = str(item["reason"]);
      return `${path || messages.statusNone}${classification === "" ? "" : ` [${classification}]`}${
        reason === "" ? "" : ` ${reason}`
      }`;
    });
  return {
    view: {
      selected: selected.length,
      completed: completed.length,
      reused: reused.length,
      failed: failedRows.length,
      waived: waived.length,
      failedItems: capLines(
        rendered.slice(0, DIAGNOSTIC_DETAIL_LIMIT),
        failedRows.length,
        messages,
      ),
    },
    unreadable: false,
  };
}

/**
 * 单条 warning 的渲染：字符串原样；`{file,message,type}` 拼成 `file：message [type]`；
 * 三者都读不出即落占位说明（空字符串条目会被模型读成「有一条空告警」，那不是事实）。
 */
function warningLineOf(warn: unknown, messages: OcrReviewMessages): string {
  if (typeof warn === "string") {
    return warn;
  }
  if (!isRecord(warn)) {
    return messages.warningUnreadable;
  }
  const head = [str(warn["file"]), str(warn["message"])]
    .filter(Boolean)
    .join(messages.warningSeparator);
  const type = str(warn["type"]);
  const line = [head, type === "" ? "" : `[${type}]`].filter(Boolean).join(" ");
  return line === "" ? messages.warningUnreadable : line;
}

function commentOf(raw: unknown): OcrComment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const content = str(raw["content"]);
  if (content.length === 0) {
    return null;
  }
  return {
    path: str(raw["path"]),
    content,
    startLine: num(raw["start_line"]),
    endLine: num(raw["end_line"]),
    category: str(raw["category"]),
    severity: (str(raw["severity"]) || "medium").toLowerCase(),
    existingCode: str(raw["existing_code"]),
    suggestionCode: str(raw["suggestion_code"]),
  };
}

/** 失败摘要（status 非法/JSON 不合形态时的统一返回，避免多处重复骨架）。 */
function reviewFailure(status: "unparseable" | "invalid", message: string): ParsedReview {
  return {
    ok: false,
    status,
    message,
    skipped: false,
    summary: null,
    budgetExceeded: false,
    limitReached: false,
    llm: null,
    projectSummary: null,
    projectSummaryTruncated: false,
    resume: null,
    groupCount: 0,
    retry: null,
    traceId: null,
    comments: [],
    warnings: [],
    toolCalls: null,
    coverage: null,
    sessionId: "",
    droppedComments: 0,
  };
}

/**
 * 三个诊断出口的合并：告警行、工具调用统计、运行覆盖度。
 *
 * warnings 条目是 `{file,message,type}`——CLI 侧的 AgentWarning 没有 `error` 这一项，
 * 照 error 读等于把失败原因整条丢掉、只留一个文件名。type 是 CLI 自己分类的依据
 * （subtask_error / scan_subtask_error 与其余），带出去才能让模型分清「哪个文件没审成」
 * 和「只是有个非致命提醒」。字段存在却不是数组、或条目既不是字符串也读不出任何内容
 * ⇒ 保留一条明确的「格式无法解析」占位，而不是静默清空。
 *
 * 诊断字段读不出来时**不判整场失败**（评论仍然有效、token 已经花掉），而是各补一条
 * 说明进同一个 warnings 出口——「这一路没有数据」必须看得见，但不能把结果作废。
 */
function diagnosticsOf(
  root: Record<string, unknown>,
  messages: OcrReviewMessages,
): {
  warnings: string[];
  toolCalls: ToolCallView | null;
  coverage: CoverageView | null;
  limitReached: boolean;
} {
  const warnings: string[] = [];
  let limitReached = false;
  const warningsRaw = root["warnings"];
  if (warningsRaw !== undefined) {
    if (Array.isArray(warningsRaw)) {
      for (const warn of warningsRaw) {
        warnings.push(warningLineOf(warn, messages));
        limitReached ||= isRecord(warn) && LIMIT_WARNING_TYPES.has(str(warn["type"]));
      }
    } else {
      warnings.push(messages.warningUnreadable);
    }
  }
  const toolCalls = toolCallsOf(root["tool_calls"], messages);
  const coverage = coverageOf(root["manifest"], messages);
  if (toolCalls.unreadable) {
    warnings.push(format(messages.diagnosticUnreadable, { field: "tool_calls" }));
  }
  if (coverage.unreadable) {
    warnings.push(format(messages.diagnosticUnreadable, { field: "manifest.coverage" }));
  }
  return { warnings, toolCalls: toolCalls.view, coverage: coverage.view, limitReached };
}

/**
 * 解析 review/scan JSON。text 应为 `ocr review --format json` 的完整 stdout/
 * 输出文件内容。解析失败（非 JSON）或 status 不在白名单（含缺失，例如
 * `{"error":"..."}` 这类 exit 0 的错误对象）返回 ok=false，由调用方报错。
 */
export function parseReviewOutput(text: string, messages: OcrReviewMessages): ParsedReview {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return reviewFailure("unparseable", messages.ocrNotJson);
  }
  if (!isRecord(doc)) {
    return reviewFailure("unparseable", messages.ocrNotObject);
  }
  const root = doc;
  const rawStatus = root["status"];
  const status = REVIEW_STATUSES.find((level) => level === rawStatus);
  if (status === undefined) {
    return reviewFailure(
      "invalid",
      format(messages.ocrStatusInvalid, {
        status: str(rawStatus) || messages.statusNone,
        expected: REVIEW_STATUSES.join("/"),
      }),
    );
  }
  const commentsRaw = root["comments"];
  if (commentsRaw !== undefined && !Array.isArray(commentsRaw)) {
    return reviewFailure("invalid", messages.ocrCommentsNotArray);
  }
  const comments: OcrComment[] = [];
  let droppedComments = 0;
  const rawComments = commentsRaw ?? [];
  for (const raw of rawComments) {
    const comment = commentOf(raw);
    if (comment === null) {
      droppedComments += 1;
    } else {
      comments.push(comment);
    }
  }
  const skipped = status === "skipped";
  // 见 REVIEW_STATUSES 上方：`failed` 要被认出来（失败明细靠它），但不能算成功。
  const ok = status !== "failed";
  const message = str(root["message"]) || (ok ? "" : messages.ocrStatusFailed);
  const sumRaw = root["summary"];
  const sum = isRecord(sumRaw) ? sumRaw : undefined;
  const diagnostics = diagnosticsOf(root, messages);
  const rawProjectSummary = str(root["project_summary"]);
  const projectSummaryTruncated = rawProjectSummary.length > PROJECT_SUMMARY_LIMIT;
  return {
    ok,
    status,
    message,
    skipped,
    summary: sum
      ? {
          filesReviewed: num(sum["files_reviewed"]),
          comments: num(sum["comments"]),
          totalTokens: num(sum["total_tokens"]),
          inputTokens: num(sum["input_tokens"]),
          outputTokens: num(sum["output_tokens"]),
          cacheReadTokens: num(sum["cache_read_tokens"]),
          cacheWriteTokens: num(sum["cache_write_tokens"]),
          elapsed: str(sum["elapsed"]),
        }
      : null,
    budgetExceeded: sum === undefined ? false : boolOf(sum["budget_exceeded"]),
    limitReached: diagnostics.limitReached,
    llm: llmOf(root["llm"]),
    projectSummary:
      rawProjectSummary === "" ? null : rawProjectSummary.slice(0, PROJECT_SUMMARY_LIMIT),
    projectSummaryTruncated,
    resume: resumeOf(root["resume"]),
    groupCount: Array.isArray(root["groups"]) ? root["groups"].length : 0,
    retry: retryOf(root["retry_report"]),
    traceId: str(root["trace_id"]) || null,
    comments,
    warnings: diagnostics.warnings,
    toolCalls: diagnostics.toolCalls,
    coverage: diagnostics.coverage,
    sessionId: str(root["session_id"]),
    droppedComments,
  };
}

/** 单条评论的紧凑渲染：`path:startLine[-endLine] [severity/category] content`。 */
export function renderComment(comment: OcrComment, messages: OcrReviewMessages): string {
  const loc = comment.path || "(path unknown)";
  let line: string;
  if (comment.startLine > 0) {
    line =
      comment.endLine > comment.startLine
        ? `${comment.startLine}-${comment.endLine}`
        : `${comment.startLine}`;
  } else {
    line = messages.lineZeroNote;
  }
  const tagSev = comment.severity && comment.severity !== "medium" ? comment.severity : "";
  const tags = [tagSev, comment.category].filter(Boolean).join("/");
  return `${loc}:${line}${tags ? ` [${tags}]` : ""}\n    ${comment.content.replaceAll(/\s*\n\s*/gu, " ")}`;
}

export interface SummaryPlan {
  /**
   * 摘要保留条数：> 0 = 按 severity/行号排序后的 top N（不再设 50 上限钳制）；
   * <= 0 = 不截断（忠实桥接：全量评论，且包含未锚定的 start_line=0 条目）。
   */
  maxComments: number;
  includeZeroLine?: boolean;
}

/** 默认摘要计划（no-object-as-default-parameter：避免对象字面量作参数默认值）。 */
const DEFAULT_PLAN: SummaryPlan = { maxComments: 12, includeZeroLine: false };

/** 单条评论的 top 位置（0 行未锚定降级为 :0）。 */
function locationOf(comment: OcrComment): string {
  const fallbackPath = comment.path || "(path unknown)";
  if (comment.startLine <= 0) {
    return `${fallbackPath}:0`;
  }
  const suffix = comment.endLine > comment.startLine ? `-${comment.endLine}` : "";
  return `${fallbackPath}:${comment.startLine}${suffix}`;
}

/** 摘要产出的可核对口径：展示数与「被丢弃数」同时给出，「干净」必须可证明。 */
export interface ReviewSummaryView {
  status: ParsedReviewStatus;
  skipped: boolean;
  message: string | null;
  summary: ReviewSummary | null;
  /** 被 token 预算截断过：status 只说 partial，说不出「为什么没审完」。 */
  budgetExceeded: boolean;
  /** 1.13.3 的 review_limit_reached / scan 的 token_budget_reached。 */
  limitReached: boolean;
  llm: LlmIdentity | null;
  projectSummary: string | null;
  projectSummaryTruncated: boolean;
  resume: ResumeView | null;
  groupCount: number;
  retry: RetryView | null;
  traceId: string | null;
  sessionId: string | null;
  aggregation: CommentAggregation;
  /** OCR 产出并经形态校验的评论总数。 */
  totalCommentCount: number;
  /** 解析出但没进 topComments 的条数（未锚定 0 行 / top-N 截断）。 */
  droppedCount: number;
  /** comments 数组里形态不合（非对象/无 content）被丢弃的条数。 */
  invalidCommentCount: number;
  topComments: {
    location: string;
    severity: string;
    category: string;
    content: string;
    suggestion: string | null;
  }[];
  warnings: string[];
  /** LLM 工具调用统计（`--audience agent` 下这是模型侧唯一能看见的失败口径）。 */
  toolCalls: ToolCallView | null;
  /** 运行覆盖度（有 manifest 时「哪些文件没审成」的权威来源）。 */
  coverage: CoverageView | null;
  hint: string;
}

/**
 * 生成工具返回给模型的结构化摘要（省 token：给聚合与 top-N 评论，不塞全量）。
 * 输出为可直接 render 的普通对象，避免 JSON 里塞超大字符串。
 */
export function summarizeReview(
  parsed: ParsedReview,
  messages: OcrReviewMessages,
  plan: SummaryPlan = DEFAULT_PLAN,
): ReviewSummaryView {
  const agg = aggregateComments(parsed.comments);
  // 排序：先 critical→high→medium→low（未知按 medium，见 classifySeverity），
  // 再按行号。未锚定（0 行）默认靠后。
  // maxComments <= 0 = 不截断：全量评论（含未锚定条目），忠实桥接 OCR 全部产出。
  // 这里是数值比较（`SummaryPlan.maxComments: number`，生产侧经 readMaxComments 的
  // Number.isSafeInteger 兜底、不会喂进 NaN），故直接写 `<= 0` 而不是 `!(… > 0)`。
  const unlimited = plan.maxComments <= 0;
  const keepZeroLine = plan.includeZeroLine === true;
  const ranked = [...parsed.comments]
    .toSorted(
      (x, y) => severityRank(x.severity) - severityRank(y.severity) || x.startLine - y.startLine,
    )
    .filter((comment) => unlimited || keepZeroLine || comment.startLine > 0)
    .slice(0, unlimited ? undefined : plan.maxComments);
  return {
    status: parsed.status,
    skipped: parsed.skipped,
    message: parsed.message || null,
    summary: parsed.summary ?? null,
    budgetExceeded: parsed.budgetExceeded,
    limitReached: parsed.limitReached,
    llm: parsed.llm,
    projectSummary: parsed.projectSummary,
    projectSummaryTruncated: parsed.projectSummaryTruncated,
    resume: parsed.resume,
    groupCount: parsed.groupCount,
    retry: parsed.retry,
    traceId: parsed.traceId,
    sessionId: parsed.sessionId || null,
    aggregation: agg,
    totalCommentCount: parsed.comments.length,
    droppedCount: parsed.comments.length - ranked.length,
    invalidCommentCount: parsed.droppedComments,
    topComments: ranked.map((comment) => ({
      location: locationOf(comment),
      severity: comment.severity,
      category: comment.category,
      content: comment.content,
      suggestion: comment.suggestionCode || null,
    })),
    warnings: parsed.warnings,
    toolCalls: parsed.toolCalls,
    coverage: parsed.coverage,
    hint: messages.reviewSummaryHint,
  };
}

// ── delegate 解析 ───────────────────────────────────────────────────────────

/** preview/rule 文档各自的契约键：一个都不命中即视为「不是该命令的输出」。 */
const DELEGATE_PREVIEW_KEYS = ["mode", "repository", "total_files", "reviewable_files"] as const;
const DELEGATE_RULE_KEYS = ["groups", "schema_version"] as const;

function hitsContract(root: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => root[key] !== undefined);
}

/** preview 失败骨架（解析失败/非对象/不合契约三处共用）。 */
function delegatePreviewFailure(): ParsedDelegatePreview {
  return {
    ok: false,
    mode: "",
    repository: "",
    totalFiles: 0,
    reviewable: [],
    excluded: [],
    mergeBase: "",
  };
}

export interface DelegateFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

export interface ParsedDelegatePreview {
  ok: boolean;
  mode: string;
  repository: string;
  totalFiles: number;
  reviewable: DelegateFile[];
  excluded: { path: string; reason: string }[];
  mergeBase: string;
}

/**
 * preview 的条目数组 → 结构化清单；返回 null 表示「上游给了条目却一条都没解析出来」。
 *
 * 判据分两层：部分条目解析不出来照旧丢弃（OCR 偶发脏条目不该毁掉整份清单），
 * 但一条不剩时不能继续以 ok:true 的形态报「0 个文件可审」——那不是「没有可审的
 * 文件」，是半截产出，模型与用户都会拿它当范围结论。
 */
function toDelegateFiles(raw: unknown): DelegateFile[] | null {
  if (!Array.isArray(raw)) {
    return [];
  }
  const files = raw
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const entryPath = str(entry["path"]);
      if (entryPath === "") {
        return null;
      }
      return {
        path: entryPath,
        status: str(entry["status"]),
        insertions: num(entry["insertions"]),
        deletions: num(entry["deletions"]),
      };
    })
    .filter((fileEntry): fileEntry is DelegateFile => fileEntry !== null);
  return raw.length > 0 && files.length === 0 ? null : files;
}

/** excluded_files 同款门：条目形状与 reviewable 一致，缺 path 即不可用。
 *
 *  理由的键名以 CLI 侧 `delegatePreviewFileJSON` 为准，那是 `exclude_reason`
 *  （`delegate_cmd.go` 的 `ExcludeReason string \`json:"exclude_reason,omitempty"\``）。
 *  读 `reason` 是照自己脑补的形状写的：真回执里那个键不存在，`str()` 把缺失读成空串，
 *  于是「被排除文件及原因」永远只有文件没有原因——schema 与工具描述都在承诺后者。
 *  `reason` 作回退保留：形如 `{"reason":…}` 的旧形态/别家产物仍读得出来。 */
function toExcludedFiles(raw: unknown): { path: string; reason: string }[] | null {
  if (!Array.isArray(raw)) {
    return [];
  }
  const files = raw
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const entryPath = str(entry["path"]);
      if (entryPath === "") {
        return null;
      }
      const reason = str(entry["exclude_reason"]) || str(entry["reason"]);
      return { path: entryPath, reason };
    })
    .filter((fileEntry): fileEntry is { path: string; reason: string } => fileEntry !== null);
  return raw.length > 0 && files.length === 0 ? null : files;
}

/** 解析 `ocr delegate preview --format json` 输出。 */
export function parseDelegatePreview(text: string): ParsedDelegatePreview {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return delegatePreviewFailure();
  }
  if (!isRecord(doc)) {
    return delegatePreviewFailure();
  }
  const root = doc;
  // 与 review 同款闸：契约键一个都不命中就不是 preview 文档（典型 `{"error":…}`
  // + exit 0）。放过它会被工具报成「0 个文件可审」= 假阴性范围结论。
  if (!hitsContract(root, DELEGATE_PREVIEW_KEYS)) {
    return delegatePreviewFailure();
  }
  // 契约键在、但值类型不对（null / 字符串 / 对象）⇒ 同样判失败。此前只查「键在不在」，
  // 于是 {"reviewable_files": null} 这种上游半截产出被当成「0 个文件可审」——
  // 假阴性的范围结论，比解析失败更难察觉。同层的 review 解析对 comments 非数组是
  // 硬失败，两条口径必须一致。
  for (const key of ["reviewable_files", "excluded_files"]) {
    const value = root[key];
    if (value !== undefined && !Array.isArray(value)) {
      return delegatePreviewFailure();
    }
  }
  const reviewable = toDelegateFiles(root["reviewable_files"]);
  const excluded = toExcludedFiles(root["excluded_files"]);
  if (reviewable === null || excluded === null) {
    return delegatePreviewFailure();
  }
  return {
    ok: true,
    mode: str(root["mode"]),
    repository: str(root["repository"]),
    totalFiles: num(root["total_files"]) || num(root["reviewable_count"]),
    reviewable,
    excluded,
    mergeBase: str(root["merge_base"]),
  };
}

export interface RuleGroup {
  groupId: number;
  source: string;
  pattern: string;
  files: string[];
  rule: string;
}

/** 解析 `ocr delegate rule --format json` 输出。 */
export function parseDelegateRules(text: string): { ok: boolean; groups: RuleGroup[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, groups: [] };
  }
  if (!isRecord(doc)) {
    return { ok: false, groups: [] };
  }
  const root = doc;
  // 同 preview：`groups`/`schema_version` 都不命中就不是 rule 文档，报 ok:false 而不是
  // 「0 个规则分组」。
  if (!hitsContract(root, DELEGATE_RULE_KEYS)) {
    return { ok: false, groups: [] };
  }
  // 与 preview 同款类型闸：groups 在但不是数组（null / 字符串 / 对象）⇒ 判失败，
  // 否则报出去的是「0 个规则分组」这种看不出异常的结论。
  if (root["groups"] !== undefined && !Array.isArray(root["groups"])) {
    return { ok: false, groups: [] };
  }
  // 组内 files 的形状同样要闸：files 缺失或非数组时该组会被 files.length > 0 过滤掉，
  // 于是一组规则凭空消失而 ok 仍是 true。契约破损必须显式失败。
  const groupsRaw: unknown[] = Array.isArray(root["groups"]) ? root["groups"] : [];
  const hasBadGroupShape = groupsRaw.some(
    (groupRaw) =>
      isRecord(groupRaw) && groupRaw["files"] !== undefined && !Array.isArray(groupRaw["files"]),
  );
  if (hasBadGroupShape) {
    return { ok: false, groups: [] };
  }
  // 到这里的组必带**数组** files：files 存在却非数组的已在上面整体判失败，
  // 不存在 files 的组会被下面 files.length > 0 滤掉。故守卫式收窄一次即可，
  // 不必在映射里再写一遍不可能走到的 : [] 兜底。
  const groupsWithFiles = groupsRaw.filter(
    (groupRaw): groupRaw is { files: unknown[] } & Record<string, unknown> =>
      isRecord(groupRaw) && Array.isArray(groupRaw["files"]),
  );
  const groups: RuleGroup[] = groupsWithFiles
    .map((groupRaw) => ({
      groupId: num(groupRaw["group_id"]),
      source: str(groupRaw["source"]),
      pattern: str(groupRaw["pattern"]),
      // 只收非空字符串项：str() 会把数字/对象变成 "1" / "[object Object]" 这类凭空
      // 造出来的文件名，模型拿着它去定位只会扑空。
      files: groupRaw.files
        .filter((file): file is string => typeof file === "string" && file.trim() !== "")
        .map((file) => file.trim()),
      rule: str(groupRaw["rule"]),
    }))
    // files 为空的组传达不了任何文件路径，留着它等于给模型一条无处可用的规则。
    .filter((group) => group.files.length > 0);
  // 上游给了分组却一条都没解析出来 ⇒ 半截产出，不能再以 ok:true 的形态报「0 个规则
  // 分组」。部分分组解析不出来仍照旧放行（上面已按组丢弃），与 preview 同口径。
  if (groupsRaw.length > 0 && groups.length === 0) {
    return { ok: false, groups: [] };
  }
  return { ok: true, groups };
}

// ── 文件选择预览（review/scan --preview）────────────────────────────────────

/** 预览列表的条数上限：整仓扫描可能列出几千个文件，摘要只留足以判断范围的一截。 */
const PREVIEW_FILE_LIMIT = 200;

export interface PreviewFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  willReview: boolean;
  excludeReason: string;
}

export interface PreviewView {
  totalFiles: number;
  reviewableCount: number;
  excludedCount: number;
  totalInsertions: number;
  totalDeletions: number;
  reviewableFiles: PreviewFile[];
  excludedFiles: PreviewFile[];
  truncated: boolean;
}

function previewFileOf(raw: unknown): PreviewFile | null {
  if (!isRecord(raw)) {
    return null;
  }
  const filePath = str(raw["path"]);
  if (filePath === "") {
    return null;
  }
  return {
    path: filePath,
    status: str(raw["status"]),
    insertions: num(raw["insertions"]),
    deletions: num(raw["deletions"]),
    willReview: raw["will_review"] === true,
    excludeReason: str(raw["exclude_reason"]),
  };
}

/**
 * 解析 `ocr review --preview --format json` / `ocr scan --preview --format json`。
 *
 * 预览是 `model.Preview` 的裸对象（键 `files`），与 review/scan 的摘要**不是**同一
 * 形状；把它喂给 parseReviewOutput 只会得到一条解析失败。契约键一个都不命中、或
 * 条目全是坏形状时判失败，不能报成「0 个文件可审」。
 */
export function parsePreviewOutput(text: string): { ok: boolean; view: PreviewView | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, view: null };
  }
  if (!isRecord(doc) || !Array.isArray(doc["files"])) {
    return { ok: false, view: null };
  }
  const parsed = doc["files"]
    .map((entry) => previewFileOf(entry))
    .filter((entry): entry is PreviewFile => entry !== null);
  if (doc["files"].length > 0 && parsed.length === 0) {
    return { ok: false, view: null };
  }
  const reviewable = parsed.filter((entry) => entry.willReview);
  const excluded = parsed.filter((entry) => !entry.willReview);
  const countOf = (key: string, fallback: number): number => {
    const raw = doc[key];
    return isCount(raw) ? num(raw) : fallback;
  };
  return {
    ok: true,
    view: {
      totalFiles: countOf("total_files", parsed.length),
      reviewableCount: countOf("reviewable_count", reviewable.length),
      excludedCount: countOf("excluded_count", excluded.length),
      totalInsertions: num(doc["total_insertions"]),
      totalDeletions: num(doc["total_deletions"]),
      reviewableFiles: reviewable.slice(0, PREVIEW_FILE_LIMIT),
      excludedFiles: excluded.slice(0, PREVIEW_FILE_LIMIT),
      truncated: reviewable.length > PREVIEW_FILE_LIMIT || excluded.length > PREVIEW_FILE_LIMIT,
    },
  };
}

// ── 会话比较（ocr session compare --json）────────────────────────────────────

/** 每个桶的展示上限：四桶全铺开会把 compare 变成第二份全量评论。 */
const COMPARE_BUCKET_LIMIT = 20;

export interface CompareSide {
  sessionId: string;
  reviewMode: string;
  range: string;
}

export interface CompareComment {
  location: string;
  severity: string;
  category: string;
  content: string;
}

export interface CompareView {
  before: CompareSide;
  after: CompareSide;
  new: CompareComment[];
  persisting: CompareComment[];
  resolved: CompareComment[];
  notReviewed: CompareComment[];
  counts: {
    new: number;
    persisting: number;
    resolved: number;
    notReviewed: number;
  };
  droppedCount: number;
}

function compareSideOf(raw: unknown): CompareSide {
  return {
    sessionId: isRecord(raw) ? str(raw["session_id"]) : "",
    reviewMode: isRecord(raw) ? str(raw["review_mode"]) : "",
    range: isRecord(raw) ? str(raw["range"]) : "",
  };
}

function compareCommentOf(raw: unknown): CompareComment | null {
  const comment = commentOf(raw);
  if (comment === null) {
    return null;
  }
  return {
    location: locationOf(comment),
    severity: comment.severity,
    category: comment.category,
    content: comment.content,
  };
}

/** 一个 compare 桶：缺失/非数组判整个 compare 失败，部分条目坏只丢该条并计入 dropped。 */
function compareBucketOf(raw: unknown): { items: CompareComment[]; total: number } | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const items = raw
    .map((entry) => compareCommentOf(entry))
    .filter((entry): entry is CompareComment => entry !== null);
  return { items: items.slice(0, COMPARE_BUCKET_LIMIT), total: raw.length };
}

/** 解析 `ocr session compare --json`：四个桶与两侧会话标识。 */
export function parseSessionCompare(text: string): { ok: boolean; view: CompareView | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, view: null };
  }
  if (!isRecord(doc)) {
    return { ok: false, view: null };
  }
  const newBucket = compareBucketOf(doc["new"]);
  const persisting = compareBucketOf(doc["persisting"]);
  const resolved = compareBucketOf(doc["resolved"]);
  const notReviewed = compareBucketOf(doc["not_reviewed"]);
  if (newBucket === null || persisting === null || resolved === null || notReviewed === null) {
    return { ok: false, view: null };
  }
  const droppedCount =
    newBucket.total +
    persisting.total +
    resolved.total +
    notReviewed.total -
    (newBucket.items.length +
      persisting.items.length +
      resolved.items.length +
      notReviewed.items.length);
  return {
    ok: true,
    view: {
      before: compareSideOf(doc["before"]),
      after: compareSideOf(doc["after"]),
      new: newBucket.items,
      persisting: persisting.items,
      resolved: resolved.items,
      notReviewed: notReviewed.items,
      counts: {
        new: newBucket.total,
        persisting: persisting.total,
        resolved: resolved.total,
        notReviewed: notReviewed.total,
      },
      droppedCount,
    },
  };
}
