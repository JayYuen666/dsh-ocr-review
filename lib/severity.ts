// lib/severity.ts —— 评审评论的**严重度口径层**：等级白名单、未知等级归一、排序位、计数聚合。
//
// 为什么从 lib/parse.ts 拆出来：这一族东西共同回答一个问题——「一条 severity 字符串该算哪
// 一档」。聚合计数与 top-N 排序都只认这一个口径（此前两处各自实现，同一份数据两种判据，见
// classifySeverity 的注释），判据本身与「OCR 的 JSON 怎么解码」无关，故与 parse.ts 分家。
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
  /** 走了「未知等级 → medium」兜底的条数。降级必须发生，但不该无痕：没有这个数，
   *  OCR 自造等级（blocker / 严重 / "critical "）在聚合与排序里都看不出异常。 */
  unknownSeverityCount: number;
}

/**
 * 严重度归一：白名单外的值（含 OCR 自造等级、大小写异形）一律按 medium。
 * 聚合与排序共用这一个函数——此前两处各自实现（排序 indexOf 未命中得 -1 而把
 * UNKNOWN 排到 critical 之前，聚合却归 medium），同一份数据两种口径。
 *
 * trim 放在**本层**而不是留给 parse.ts：本模块声明自己是「唯一口径」，调用方不一定
 * 来自 parse.ts 的解码路径。少了它，" critical"（带首尾空白）会掉到 medium——一个
 * 高危等级被静默降级成中危，正是这层要防的事。
 *
 * known 一并回传：归一是「必须发生」的降级，但降级本身不该是**无痕**的——调用方要能
 * 统计出「有多少条走了兜底」，否则契约异常被彻底吞掉，聚合里看不出来、排序里也看不出来。
 */
export function classifySeverity(severity: string): { level: SeverityLevel; known: boolean } {
  const matched = SEVERITY_ORDER.find((level) => level === severity.trim().toLowerCase());
  return { level: matched ?? "medium", known: matched !== undefined };
}

/** 排序位：critical→high→medium→low（未知已归 medium，永不为 -1）。 */
export function severityRank(severity: string): number {
  return SEVERITY_ORDER.indexOf(classifySeverity(severity).level);
}

/** 聚合评论：按严重度/类别计数。severity 归类以 critical→high→medium→low 基准。 */
export function aggregateComments(comments: OcrComment[]): CommentAggregation {
  const bySeverity: Record<SeverityLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  // 计数走 Map 而非普通对象字面量：category 由上游给，"constructor" / "toString" /
  // "valueOf" 这类键在 {} 上会命中 Object.prototype 的继承属性——`x ?? 0` 的空值兜底
  // 挡不住它们（读到的不是 nullish），计数于是被写成 "function Object() { [native code] }1"
  // 这样的字符串；而 "__proto__" 是 setter，赋值被静默忽略、该条评论的计数凭空消失。
  // 两者都会被 summarizeReview 原样序列化进给模型的摘要。Map.get 不查原型链。
  // 最后 Object.fromEntries 用 CreateDataProperty 落键（不是 Set），故 "__proto__" 是
  // 一个普通自有键，能被 JSON.stringify 如实输出。
  const categoryCounts = new Map<string, number>();
  let unknownSeverityCount = 0;
  for (const comment of comments) {
    const { level, known } = classifySeverity(comment.severity);
    bySeverity[level] += 1;
    if (!known) {
      unknownSeverityCount += 1;
    }
    // category 与 severity 同一条归一口径（trim 后入键），" Security" 与 "security"
    // 不拆成两类。空串/全空白刻意**不计数也不占键**：parse 的 str() 对缺失字段给 ""，
    // 「无 category」是上游合法的缺省而不是契约异常——所以它的可观测面是「byCategory
    // 各键之和允许小于 total」，差值即无 category 的条数，不给独立计数器。
    const category = comment.category.trim();
    if (category !== "") {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }
  const byCategory: Record<string, number> = Object.fromEntries(categoryCounts);
  return { total: comments.length, bySeverity, byCategory, unknownSeverityCount };
}
