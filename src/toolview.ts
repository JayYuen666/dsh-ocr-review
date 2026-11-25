// src/toolview.ts —— Web Client 的 7 个 OCR 工具行（tool.call.toolview keyed slot）。
//
// 宿主内置 Web Client 不消费 Host 的 presentCall/presentResult，只把原始
// tool/call 与 tool/result 事件交给 Client 插件；未注册 slot 的工具一律落到 generic
// 卡。这里按 wire 工具名逐个注册，行内只从官方 ToolCallViewProps 读取 args、content、
// isError 与 phase，不读会话状态、不发请求。
//
// 视觉按 shared 的 v3 ToolRow 基线：`ToolRow` + `ToolRowGrid` + `ToolRowItem`；
// 行内只画宿主真实投射字段（args 与结果 JSON 的顶层字段），不造耗时、内容大小或重试次数。
// 输出正文不塞进工具行：宿主自己保存完整结果，这一行只做摘要，避免把 828KB 的
// session comments 再复制一遍。
import { createElement } from "react";
import type { ReactNode } from "react";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { Badge, ToolRow, ToolRowGrid, ToolRowItem } from "@jayyuen66/dsh-plugin-shared/client";
import type { BadgeTone, DotTone, ToolRowValueTone } from "@jayyuen66/dsh-plugin-shared/client";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";

export const OCR_TOOLVIEW_NAMES = [
  "ocr_review",
  "ocr_scan",
  "ocr_session",
  "ocr_delegate_preview",
  "ocr_delegate_rule",
  "ocr_rules_check",
  "ocr_llm",
] as const;

type OcrToolName = (typeof OCR_TOOLVIEW_NAMES)[number];
type OcrToolRowProps = ToolCallViewProps & PropsLocale<LocaleNs>;
type ToolState = "running" | "failed" | "done";

const STATE_KEYS: Record<ToolState, keyof UiMessages> = {
  running: "toolRunning",
  failed: "toolFailed",
  done: "toolDone",
};

const DOT_TONES: Record<ToolState, DotTone> = {
  running: "mute",
  failed: "err",
  done: "ok",
};

const BADGE_TONES: Record<ToolState, BadgeTone> = {
  running: "neutral",
  failed: "err",
  done: "ok",
};

interface RowItem {
  label: string;
  value: string;
  tone?: ToolRowValueTone;
}

function recordAt(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return value !== null && isRecord(value[key]) ? value[key] : null;
}

function recordFromJson(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function argsRawOf(props: ToolCallViewProps): string {
  if (props.phase === "preparing") {
    return "";
  }
  if (props.phase === "start") {
    return props.block.argsRaw;
  }
  return props.block.call?.argsRaw ?? "";
}

function contentTextOf(props: ToolCallViewProps): string {
  if (props.phase !== "result") {
    return "";
  }
  return props.block.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textOf(value);
    if (text !== "") {
      return text;
    }
  }
  return "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function countOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return Array.isArray(value) ? value.length : null;
}

function pushItem(rows: RowItem[], label: string, value: string, tone?: ToolRowValueTone): void {
  const trimmed = value.trim();
  if (trimmed !== "") {
    rows.push(tone === undefined ? { label, value: trimmed } : { label, value: trimmed, tone });
  }
}

function countItem(rows: RowItem[], label: string, value: unknown): void {
  const count = countOf(value);
  if (count !== null) {
    pushItem(rows, label, String(count));
  }
}

function baseItems(args: Record<string, unknown> | null, t: Translate): RowItem[] {
  const rows: RowItem[] = [];
  const repo = args === null ? "" : textOf(args["repo"]);
  const singlePath = args === null ? "" : textOf(args["path"]);
  const pathCount = args === null ? null : countOf(args["paths"]);
  const scope = args === null ? "" : textOf(args["scope"]);
  const action = args === null ? "" : textOf(args["action"]);
  const rule = args === null ? "" : textOf(args["rule"]);
  pushItem(rows, t("toolRepoLabel"), repo);
  if (singlePath !== "") {
    pushItem(rows, t("toolPathsLabel"), singlePath);
  } else if (pathCount !== null) {
    pushItem(rows, t("toolPathsLabel"), String(pathCount));
  }
  pushItem(rows, t("toolScopeLabel"), scope);
  pushItem(rows, t("toolActionLabel"), action);
  pushItem(rows, t("toolRuleLabel"), rule);
  return rows;
}

/** 宿主把 `ocr_session` 投影成一个 JSON 字串放在 `sessionOutput` 里；也接受平铺形状。 */
function sessionPayloadOf(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (result === null) {
    return null;
  }
  if (typeof result["kind"] === "string") {
    return result;
  }
  const nested = result["sessionOutput"];
  if (typeof nested === "string") {
    const parsed = recordFromJson(nested);
    if (parsed !== null) {
      return parsed;
    }
  }
  // compare 走的是另一种 canonical 形状：直接返回 before/after/四桶/counts，
  // 没有 sessionOutput 包装。只要顶层带会话结果字段，就按平铺 shape 读；否则
  // 只有 {sessionOutput:"…空态说明…"} 的对象不伪造摘要。
  const sessionKeys = ["summary", "sessions", "items", "comments", "counts"];
  return sessionKeys.some((key) => key in result) ? result : null;
}

function sessionItems(result: Record<string, unknown> | null, t: Translate): RowItem[] {
  const payload = sessionPayloadOf(result);
  if (payload === null) {
    return [];
  }
  const rows: RowItem[] = [];
  // 生产态：host 的 runProjection 把 `sessionOutput` 写成 `{kind, ...value}`；
  // show 的 value 是 `{summary, items}`，list 是 `{sessions}`。早期 fixture 还包过一层
  // `value`，这里只做兼容读取，不依赖它。
  const nested = recordAt(payload, "value");
  const summary = recordAt(payload, "summary");
  const sessions = payload["sessions"] ?? nested?.["sessions"];
  const items = payload["items"] ?? nested?.["items"];
  const comments = payload["comments"] ?? nested?.["comments"];
  // `comments` 数组是截断后的展示面（commentLimit 默认 100），而 `total` 是截断前的
  // 有效评论总数。工具行报的是「这场评审有多少条评论」，不是「这次返回了几条」；
  // 只有投影里没有 total 时才退回数组长度。
  const commentsTotal = payload["total"] ?? nested?.["total"];
  const commentCount = countOf(commentsTotal) === null ? comments : commentsTotal;
  const counts = recordAt(payload, "counts") ?? recordAt(nested, "counts");
  const sessionId = firstText(
    summary?.["sessionId"],
    summary?.["session_id"],
    nested?.["sessionId"],
    nested?.["session_id"],
  );
  pushItem(rows, t("toolKindLabel"), textOf(payload["kind"]));
  pushItem(rows, t("toolSessionLabel"), sessionId);
  countItem(rows, t("toolSessionsLabel"), sessions);
  countItem(rows, t("toolItemsLabel"), items);
  countItem(rows, t("toolCommentsLabel"), commentCount);
  if (counts !== null) {
    const parts = ["new", "persisting", "resolved", "notReviewed"]
      .map((key) => `${key} ${numberText(counts[key]) || "0"}`)
      .join(" · ");
    pushItem(rows, t("toolCountsLabel"), parts);
  }
  return rows;
}

function previewItems(result: Record<string, unknown> | null, t: Translate): RowItem[] {
  if (result === null) {
    return [];
  }
  const rows: RowItem[] = [];
  pushItem(rows, t("toolFilesLabel"), numberText(result["totalFiles"]));
  pushItem(rows, t("toolReviewableLabel"), numberText(result["reviewableCount"]));
  pushItem(rows, t("toolExcludedLabel"), numberText(result["excludedCount"]));
  const dropped = [numberText(result["reviewableDropped"]), numberText(result["excludedDropped"])]
    .filter((entry) => entry !== "" && entry !== "0")
    .join(" / ");
  pushItem(rows, t("toolDroppedLabel"), dropped);
  return rows;
}

function reviewItems(result: Record<string, unknown> | null, t: Translate): RowItem[] {
  if (result === null) {
    return [];
  }
  const rows: RowItem[] = [];
  pushItem(rows, t("toolStatusLabel"), textOf(result["status"]));
  countItem(rows, t("toolCommentsLabel"), result["totalCommentCount"]);
  return rows;
}

function delegateRuleItems(result: Record<string, unknown> | null, t: Translate): RowItem[] {
  if (result === null) {
    return [];
  }
  const rows: RowItem[] = [];
  countItem(rows, t("toolRulesLabel"), result["groupCount"]);
  return rows;
}

function itemsOf(
  name: OcrToolName,
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
  t: Translate,
): RowItem[] {
  const rows = baseItems(args, t);
  switch (name) {
    case "ocr_delegate_preview": {
      rows.push(...previewItems(result, t));
      break;
    }
    case "ocr_session": {
      rows.push(...sessionItems(result, t));
      break;
    }
    case "ocr_review":
    case "ocr_scan": {
      rows.push(...reviewItems(result, t));
      break;
    }
    case "ocr_delegate_rule": {
      rows.push(...delegateRuleItems(result, t));
      break;
    }
    case "ocr_rules_check":
    case "ocr_llm": {
      // 两者的结果都是纯文本 `output`，没有可数结构；工具行只留参数摘要。
      break;
    }
    default: {
      break;
    }
  }
  return rows;
}

function stateOf(props: ToolCallViewProps): ToolState {
  if (props.phase !== "result") {
    return "running";
  }
  return props.block.isError ? "failed" : "done";
}

/** 一个按 wire 名称分派的 OCR 工具行；文本全部来自官方 block，解析失败即退回 args。 */
export function OcrToolRow(props: OcrToolRowProps): ReactNode {
  const name = OCR_TOOLVIEW_NAMES.find((candidate) => candidate === props.toolName);
  if (name === undefined) {
    return null;
  }
  const { t } = props;
  const state = stateOf(props);
  const args = recordFromJson(argsRawOf(props));
  const result = recordFromJson(contentTextOf(props));
  const rows = itemsOf(name, args, result, t);
  const badge = createElement(
    Badge,
    {
      tone: BADGE_TONES[state],
      field: "ocrToolState",
    },
    t(STATE_KEYS[state]),
  );
  const grid = createElement(
    ToolRowGrid,
    null,
    ...rows.map((row, index) =>
      createElement(ToolRowItem, {
        key: `${row.label}:${index}`,
        label: row.label,
        value: row.value,
        ...(row.tone === undefined ? {} : { tone: row.tone }),
      }),
    ),
  );
  return createElement(
    ToolRow,
    {
      name,
      tone: DOT_TONES[state],
      phase: props.phase,
      badge,
    },
    grid,
  );
}
