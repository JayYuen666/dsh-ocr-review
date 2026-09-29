// lib/severity.ts —— 评审评论的**严重度口径层**：等级白名单、未知等级归一、排序位、计数聚合。
//
// 为什么从 lib/parse.ts 拆出来：这一族东西共同回答一个问题——「一条 severity 字符串该算哪
// 一档」。聚合计数与 top-N 排序都只认这一个口径（此前两处各自实现，同一份数据两种判据，见
// normalizeSeverity 的注释），判据本身与「OCR 的 JSON 怎么解码」无关，故与 parse.ts 分家；
// 此前 aggregateComments 的 export 只因单测也按这层边界取用，生产侧的 consumer 全在
// parse.ts 里，`fallow --production` 因此把它判成「只被测试养着的导出」。
//
// 本模块与 parse.ts 之间只有 `OcrComment` 这一条**类型**回边（评论形状是 parse.ts 的解码契约，
// 留在原地），运行时没有反向依赖，不构成模块环。

import type { OcrComment } from "./parse.ts";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
export type SeverityLevel = (typeof SEVERITY_ORDER)[number];

export interface CommentAggregation {
  total: number;
  bySeverity: Record<SeverityLevel, number>;
  byCategory: Record<string, number>;
}

/**
 * 严重度归一：白名单外的值（含 OCR 自造等级、大小写异形）一律按 medium。
 * 聚合与排序共用这一个函数——此前两处各自实现（排序 indexOf 未命中得 -1 而把
 * UNKNOWN 排到 critical 之前，聚合却归 medium），同一份数据两种口径。
 */
function normalizeSeverity(severity: string): SeverityLevel {
  const matched = SEVERITY_ORDER.find((level) => level === severity);
  return matched ?? "medium";
}

/** 排序位：critical→high→medium→low（未知已归 medium，永不为 -1）。 */
export function severityRank(severity: string): number {
  return SEVERITY_ORDER.indexOf(normalizeSeverity(severity));
}

/** 聚合评论：按严重度/类别计数。severity 归类以 critical→high→medium→low 基准。 */
export function aggregateComments(comments: OcrComment[]): CommentAggregation {
  const bySeverity: Record<SeverityLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const byCategory: Record<string, number> = {};
  for (const comment of comments) {
    const sev = normalizeSeverity(comment.severity);
    bySeverity[sev] += 1;
    if (comment.category) {
      byCategory[comment.category] = (byCategory[comment.category] ?? 0) + 1;
    }
  }
  return { total: comments.length, bySeverity, byCategory };
}
