// lib/parse.ts —— 纯函数：把 ocr CLI 的 JSON 输出解析为省 token 的结构化摘要。
// 契约依据（open-codereview.ai/docs/cli-reference + FAQ + 1.12.0 实测）：
//   - review/scan JSON 恰好一个对象：status/summary/comments/warnings/session_id
//     /manifest 可选；comments 字段 per-comment：path/content/start_line/end_line
//     /existing_code/suggestion_code/category/severity/thinking。
//   - status: success | complete | completed_with_warnings | completed_with_errors
//     | skipped。skipped 表示无变更可审（区别于“审了但零发现”）。白名单外
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
import { isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";
import { aggregateComments, severityRank } from "./severity.ts";
import type { CommentAggregation } from "./severity.ts";

/**
 * OCR 评审 JSON 的 status 枚举（docs/cli-reference + 1.12.0 实测）。
 * 白名单外的一律视为失败：exit 0 不等于评审成功——`{"error":"auth failed"}`
 * 这类「没有 status 的错误对象」若被当作 ok:true，模型会把「0 条评论」读成
 * 「代码干净」，是最坏的一类假阳性。
 */
const REVIEW_STATUSES = [
  "success",
  "complete",
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
  elapsed: string;
}

export interface ParsedReview {
  ok: boolean;
  status: ParsedReviewStatus;
  message: string;
  skipped: boolean;
  summary: ReviewSummary | null;
  comments: OcrComment[];
  warnings: string[];
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
 * 数值字段解析：number 与「数字字符串」都接受（OCR 部分 provider 实测把
 * start_line 输出成 "42"，一律当 0 会把真实评论判成「未锚定」而被摘要丢掉），
 * 空串/NaN/Infinity/其它类型回 0。
 */
function num(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return 0;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
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
    comments: [],
    warnings: [],
    sessionId: "",
    droppedComments: 0,
  };
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
  const sumRaw = root["summary"];
  const sum = isRecord(sumRaw) ? sumRaw : undefined;
  const warningsArr = Array.isArray(root["warnings"])
    ? root["warnings"]
        .map((warn) => {
          if (typeof warn === "string") {
            return warn;
          }
          if (isRecord(warn)) {
            return [str(warn["file"]), str(warn["error"])]
              .filter(Boolean)
              .join(messages.warningSeparator);
          }
          return "";
        })
        .filter(Boolean)
    : [];
  return {
    ok: true,
    status,
    message: str(root["message"]),
    skipped,
    summary: sum
      ? {
          filesReviewed: num(sum["files_reviewed"]),
          comments: num(sum["comments"]),
          totalTokens: num(sum["total_tokens"]),
          inputTokens: num(sum["input_tokens"]),
          outputTokens: num(sum["output_tokens"]),
          elapsed: str(sum["elapsed"]),
        }
      : null,
    comments,
    warnings: warningsArr,
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
  // 排序：先 critical→high→medium→low（未知按 medium，见 normalizeSeverity），
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
  const reviewable: DelegateFile[] = Array.isArray(root["reviewable_files"])
    ? root["reviewable_files"]
        .map((fileRaw) => {
          if (!isRecord(fileRaw)) {
            return null;
          }
          return {
            path: str(fileRaw["path"]),
            status: str(fileRaw["status"]),
            insertions: num(fileRaw["insertions"]),
            deletions: num(fileRaw["deletions"]),
          };
        })
        .filter(
          (fileEntry): fileEntry is DelegateFile => fileEntry !== null && fileEntry.path.length > 0,
        )
    : [];
  const excluded: { path: string; reason: string }[] = Array.isArray(root["excluded_files"])
    ? root["excluded_files"]
        .map((fileRaw) => {
          if (!isRecord(fileRaw)) {
            return null;
          }
          return { path: str(fileRaw["path"]), reason: str(fileRaw["reason"]) };
        })
        .filter(
          (fileEntry): fileEntry is { path: string; reason: string } =>
            fileEntry !== null && fileEntry.path.length > 0,
        )
    : [];
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
  const groups: RuleGroup[] = Array.isArray(root["groups"])
    ? root["groups"]
        .map((groupRaw) => {
          if (!isRecord(groupRaw)) {
            return null;
          }
          return {
            groupId: num(groupRaw["group_id"]),
            source: str(groupRaw["source"]),
            pattern: str(groupRaw["pattern"]),
            files: Array.isArray(groupRaw["files"])
              ? groupRaw["files"].map(str).filter(Boolean)
              : [],
            rule: str(groupRaw["rule"]),
          };
        })
        .filter((group): group is RuleGroup => group !== null && group.files.length > 0)
    : [];
  return { ok: true, groups };
}
