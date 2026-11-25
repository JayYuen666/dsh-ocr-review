// lib/session-view.ts —— ocr_session 的**展示投影**。
//
// 为什么单独一层：OCR 的 `session list/show/comments --json` 是给人和程序看的完整记录，
// 一个真实会话就能到 27KB / 39KB / 828KB（comments 里 thinking 占绝大部分）。直接把这团
// JSON 塞给模型既会撞宿主 stdout 上限，也会让模型在几十个逐文件 coverage 数组里找关键字段。
// 这里只保留「下一次判断要用的字段」：会话身份、范围、计数、终态、失败归因、逐文件检查点和
// 评论正文；逐文件 coverage 的 selected/completed/excluded 明细只留计数。
//
// 这是纯函数层：不读文件、不跑进程、不依赖 host。host.ts 负责在 stdout 被截断时从 spill
// 文件读回完整文本，再调用这里。

import { classifySeverity } from "./severity.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

export interface SessionRunFailureView {
  classification: string;
  reason: string;
}

export interface SessionCoverageView {
  selected: number;
  completed: number;
  reused: number;
  failed: number;
  waived: number;
  excluded: number;
}

export interface SessionManifestView {
  schemaVersion: string;
  operation: string;
  terminalState: string;
  elapsedMs: number;
  runFailure: SessionRunFailureView | null;
  coverage: SessionCoverageView;
}

export interface SessionSummaryView {
  sessionId: string;
  filePath: string;
  repoDir: string;
  gitBranch: string;
  model: string;
  reviewMode: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  selectedFiles: number;
  completedFiles: number;
  failedFiles: number;
  reusedFiles: number;
  waivedFiles: number;
  totalComments: number;
  llmFailures: number;
  aborted: boolean;
  legacy: boolean;
  /** OCR 的 analysis 产物目录；本会话没有启用 analysis 时为 null。 */
  analysisDir: string | null;
  manifest: SessionManifestView | null;
}

export interface SessionItemView {
  type: string;
  timestamp: string;
  filePath: string;
  oldPath: string;
  newPath: string;
  comments: number;
  error: string;
}

export interface SessionListView {
  sessions: SessionSummaryView[];
}

export interface SessionShowView {
  summary: SessionSummaryView;
  items: SessionItemView[];
}

export interface SessionCommentView {
  path: string;
  content: string;
  /** OCR 原始 severity；归一后的等级另见 level。 */
  severity: string;
  level: "critical" | "high" | "medium" | "low";
  category: string;
  startLine: number;
  endLine: number;
  existingCode: string;
  suggestionCode: string;
  thinking?: string;
}

export interface SessionCommentsView {
  /** 有效评论条数（丢弃无效条目后、截断前；原始条数另见 droppedInvalid）。 */
  total: number;
  comments: SessionCommentView[];
  /** 非对象条目被丢弃的条数。 */
  droppedInvalid: number;
  /** 模型没要求 thinking 时，这里是被省略的条数。 */
  thinkingOmitted: number;
}

export interface SessionProjectionOptions {
  /** comments 是否带出 OCR 的推理文本；默认 false，thinking 通常是最大字段。 */
  includeThinking: boolean;
  /** comments 最多保留多少条；超出部分只留计数。 */
  commentLimit: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const JSONL_SUFFIX = /\.jsonl$/u;

function analysisDirOf(filePath: string): string | null {
  return filePath === "" ? null : `${filePath.replace(JSONL_SUFFIX, "")}/analysis`;
}

function coverageView(raw: unknown): SessionCoverageView {
  const coverage = record(raw);
  return {
    selected: array(coverage?.["selected"]).length,
    completed: array(coverage?.["completed"]).length,
    reused: array(coverage?.["reused"]).length,
    failed: array(coverage?.["failed"]).length,
    waived: array(coverage?.["waived"]).length,
    excluded: array(coverage?.["excluded"]).length,
  };
}

function runFailureView(raw: unknown): SessionRunFailureView | null {
  const failure = record(raw);
  if (failure === undefined) {
    return null;
  }
  const classification = str(failure["classification"]);
  const reason = str(failure["reason"]);
  return classification === "" && reason === "" ? null : { classification, reason };
}

function manifestView(raw: unknown): SessionManifestView | null {
  const manifest = record(raw);
  if (manifest === undefined) {
    return null;
  }
  return {
    schemaVersion: str(manifest["schema_version"]),
    operation: str(manifest["operation"]),
    terminalState: str(manifest["terminal_state"]),
    elapsedMs: count(manifest["elapsed_ms"]),
    runFailure: runFailureView(manifest["run_failure"]),
    coverage: coverageView(manifest["coverage"]),
  };
}

function summaryView(raw: unknown): SessionSummaryView | null {
  const summary = record(raw);
  if (summary === undefined) {
    return null;
  }
  const filePath = str(summary["file_path"]);
  const analysis = record(summary["analysis"]);
  return {
    sessionId: str(summary["session_id"]),
    filePath,
    repoDir: str(summary["repo_dir"]),
    gitBranch: str(summary["git_branch"]),
    model: str(summary["model"]),
    reviewMode: str(summary["review_mode"]),
    startTime: str(summary["start_time"]),
    endTime: str(summary["end_time"]),
    durationMs: Math.round(count(summary["duration_ns"]) / 1_000_000),
    selectedFiles: count(summary["selected_files"]),
    completedFiles: count(summary["completed_files"]),
    failedFiles: count(summary["failed_files"]),
    reusedFiles: count(summary["reused_files"]),
    waivedFiles: count(summary["waived_files"]),
    totalComments: count(summary["total_comments"]),
    llmFailures: count(summary["llm_failures"]),
    aborted: bool(summary["aborted"]),
    legacy: bool(summary["legacy"]),
    analysisDir: bool(analysis?.["enabled"]) ? analysisDirOf(filePath) : null,
    manifest: manifestView(summary["run_manifest"]),
  };
}

function itemView(raw: unknown): SessionItemView | null {
  const item = record(raw);
  if (item === undefined) {
    return null;
  }
  return {
    type: str(item["type"]),
    timestamp: str(item["timestamp"]),
    filePath: str(item["file_path"]),
    oldPath: str(item["old_path"]),
    newPath: str(item["new_path"]),
    comments: count(item["comments"]),
    error: str(item["error"]),
  };
}

function commentView(raw: unknown): SessionCommentView | null {
  const comment = record(raw);
  if (comment === undefined) {
    return null;
  }
  const content = str(comment["content"]);
  const thinking = str(comment["thinking"]);
  if (content === "" && thinking === "") {
    return null;
  }
  const severity = str(comment["severity"]);
  return {
    path: str(comment["path"]) || str(comment["file_path"]),
    content,
    severity,
    level: classifySeverity(severity).level,
    category: str(comment["category"]),
    startLine: count(comment["start_line"]),
    endLine: count(comment["end_line"]),
    existingCode: str(comment["existing_code"]),
    suggestionCode: str(comment["suggestion_code"]),
    ...(thinking === "" ? {} : { thinking }),
  };
}

function listView(raw: unknown[]): SessionListView {
  const sessions = raw
    .map((entry) => summaryView(entry))
    .filter((entry): entry is SessionSummaryView => entry !== null);
  return { sessions };
}

function showView(raw: Record<string, unknown>): SessionShowView | null {
  const summary = summaryView(raw["summary"]);
  if (summary === null || !Array.isArray(raw["items"])) {
    return null;
  }
  const items = raw["items"]
    .map((entry) => itemView(entry))
    .filter((entry): entry is SessionItemView => entry !== null);
  return { summary, items };
}

function commentsView(raw: unknown[], options: SessionProjectionOptions): SessionCommentsView {
  let droppedInvalid = 0;
  let thinkingOmitted = 0;
  const comments: SessionCommentView[] = [];
  for (const entry of raw) {
    const comment = commentView(entry);
    if (comment === null) {
      droppedInvalid += 1;
    } else {
      const projected = options.includeThinking ? comment : { ...comment };
      if (!options.includeThinking && projected.thinking !== undefined) {
        thinkingOmitted += 1;
        delete projected.thinking;
      }
      comments.push(projected);
    }
  }
  const total = comments.length;
  return {
    total,
    comments: comments.slice(0, options.commentLimit),
    droppedInvalid,
    thinkingOmitted,
  };
}

/** 解析 `ocr_session` 的 JSON；返回值的 kind 跟实际顶层形状一致，不跟请求的 action 硬绑。 */
export type SessionParsed =
  | { kind: "list"; value: SessionListView }
  | { kind: "show"; value: SessionShowView }
  | { kind: "comments"; value: SessionCommentsView };

/**
 * @param text - OCR 的完整 `--json` 输出。
 * @param expected - 请求的 action；用于区分「comments 空数组」与「list 空数组」。
 * @param options - comments 的投影预算。
 * @returns 解析失败（不是 JSON / 形状不认识）时 null，调用方回退到原始文本。
 */
export function parseSessionText(
  text: string,
  expected: "list" | "show" | "comments",
  options: SessionProjectionOptions,
): SessionParsed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    // show/comments 缺 id 时 OCR 会回退成 list（数组），所以这里按形状优先判断；
    // expected=comments 时空数组本身就是「这个会话没有评论」，与空 list 只差一个 kind。
    if (expected === "comments" && parsed.length === 0) {
      return { kind: "comments", value: commentsView(parsed, options) };
    }
    if (
      expected === "comments" &&
      parsed.length > 0 &&
      record(parsed[0]) !== undefined &&
      (record(parsed[0])?.["content"] !== undefined || record(parsed[0])?.["path"] !== undefined)
    ) {
      return { kind: "comments", value: commentsView(parsed, options) };
    }
    return { kind: "list", value: listView(parsed) };
  }
  if (isRecord(parsed)) {
    const view = showView(parsed);
    return view === null ? null : { kind: "show", value: view };
  }
  return null;
}
