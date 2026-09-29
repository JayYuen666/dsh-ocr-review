// parse 纯函数测试：用真实 ocr 输出 fixture 验证契约解析（严重度口径 lib/severity.ts
// 的聚合按同一边界直接取用）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseReviewOutput,
  summarizeReview,
  renderComment,
  parseDelegatePreview,
  parseDelegateRules,
} from "../lib/parse.ts";
import { aggregateComments } from "../lib/severity.ts";
import type { OcrComment, ParsedReview, ReviewSummaryView, SummaryPlan } from "../lib/parse.ts";
import { MESSAGES } from "../lib/messages.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

// ── 文案注入助手 ─────────────────────────────────────────────────────────────
// parse.ts 是人读文案的产地之一（解析失败原因、摘要 hint、0 行定位说明），
// 但它是纯函数：消息表由调用方注入。测试因此按「host 注入哪一份」分两组——
// 本文件走中文那份（断言里的中文串与 i18n 迁移前完全一致），
// 末尾一组双语用例走 MESSAGES.en 那份，证明两语同一条渲染路径。
const { zh } = MESSAGES;
const parseOcr = (text: string): ParsedReview => parseReviewOutput(text, zh);
const summarizeView = (parsed: ParsedReview, plan?: SummaryPlan): ReviewSummaryView =>
  plan === undefined ? summarizeReview(parsed, zh) : summarizeReview(parsed, zh, plan);
const renderedComment = (comment: OcrComment): string => renderComment(comment, zh);

describe("parseReviewOutput — 真实评审（complete）", () => {
  const parsed = parseOcr(read("ocr-review-complete.json"));

  it("解析状态与 summary", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("complete");
    expect(parsed.skipped).toBe(false);
    expect(parsed.summary?.filesReviewed).toBe(1);
    expect(parsed.summary?.comments).toBe(3);
    expect(parsed.summary?.totalTokens).toBeGreaterThan(0);
  });

  it("评论字段完整（含 severity/category）", () => {
    expect(parsed.comments).toHaveLength(3);
    const [c0] = parsed.comments;
    expect(c0?.path).toBe("app.js");
    expect(c0?.severity).toBe("critical");
    expect(c0?.category).toBe("bug");
    expect(c0!.startLine).toBeGreaterThan(0);
    expect(c0!.content.length).toBeGreaterThan(20);
  });

  it("聚合按严重度/类别计数", () => {
    const agg = aggregateComments(parsed.comments);
    expect(agg.total).toBe(3);
    expect(Object.values(agg.bySeverity).reduce((acc, val) => acc + val, 0)).toBe(3);
  });

  it("summarize 输出 top 评论且给出 hint", () => {
    const summary = summarizeView(parsed) as {
      aggregation: { total: number };
      topComments: unknown[];
      hint: string;
    };
    expect(summary.aggregation.total).toBe(3);
    expect(summary.topComments.length).toBeGreaterThan(0);
    expect(summary.hint).toBeTypeOf("string");
  });

  it("maxComments=0 = 不截断：全量评论且包含未锚定（0 行）条目", () => {
    const comments = Array.from({ length: 55 }, (_unused, idx) => ({
      path: `f${idx}.js`,
      content: `c${idx}`,
      start_line: idx === 0 ? 0 : idx,
      end_line: idx,
      category: "bug",
      severity: idx === 0 ? "low" : "high",
      existing_code: "",
      suggestion_code: "",
    }));
    const bulkParsed = parseOcr(JSON.stringify({ status: "complete", comments }));
    const full = summarizeView(bulkParsed, { maxComments: 0 }) as {
      topComments: { location: string }[];
    };
    expect(full.topComments).toHaveLength(55);
    expect(full.topComments.some((cm) => cm.location.endsWith(":0"))).toBe(true);
  });

  it("maxComments>0 不再有 50 上限钳制（60 > 50 仍生效）", () => {
    const comments = Array.from({ length: 55 }, (_unused, idx) => ({
      path: `f${idx}.js`,
      content: `c${idx}`,
      start_line: idx + 1,
      end_line: idx + 1,
      category: "bug",
      severity: "medium",
      existing_code: "",
      suggestion_code: "",
    }));
    const cappedParsed = parseOcr(JSON.stringify({ status: "complete", comments }));
    const summary = summarizeView(cappedParsed, { maxComments: 60 }) as {
      topComments: unknown[];
    };
    expect(summary.topComments).toHaveLength(55);
  });
});

describe("parseReviewOutput — skipped 外壳（无变更可审）", () => {
  const parsed = parseOcr(read("ocr-review-skipped.json"));

  it("识别 skipped 且 comments 为空", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toBe(true);
    expect(parsed.comments).toStrictEqual([]);
  });
});

describe("parseReviewOutput — 非法 JSON", () => {
  it("返回 ok=false 而非抛错", () => {
    const parsed = parseOcr("not json at all");
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("unparseable");
  });
});

describe("delegate 解析", () => {
  it("preview：文件清单 + 统计", () => {
    const preview = parseDelegatePreview(read("delegate-preview.json"));
    expect(preview.ok).toBe(true);
    expect(preview.mode).toBe("workspace");
    expect(preview.reviewable).toHaveLength(1);
    expect(preview.reviewable[0]?.path).toBe("app.js");
    expect(preview.reviewable[0]?.insertions).toBe(4);
    expect(preview.totalFiles).toBe(1);
  });

  it("preview：total_files 缺失时用 reviewable_count；非对象/坏 JSON 一律 ok=false", () => {
    const fallback = parseDelegatePreview('{"mode":"branch","reviewable_count":3}');
    expect(fallback.totalFiles).toBe(3);
    expect(parseDelegatePreview("nope").ok).toBe(false);
    expect(parseDelegatePreview("[1,2]").ok).toBe(false);
    expect(
      parseDelegatePreview('{"reviewable_files":[null,{"path":""}]}').reviewable,
    ).toStrictEqual([]);
  });

  it("rules：按内容分组且 rule 非空", () => {
    const rules = parseDelegateRules(read("delegate-rules.json"));
    expect(rules.ok).toBe(true);
    expect(rules.groups.length).toBeGreaterThan(0);
    expect(rules.groups[0]?.files).toContain("app.js");
    expect(rules.groups[0]!.rule.length).toBeGreaterThan(50);
  });

  it("rules：坏 JSON / 非对象 / 非对象分组 / 空 files 分组都被剔除", () => {
    expect(parseDelegateRules("x").ok).toBe(false);
    expect(parseDelegateRules("[]").ok).toBe(false);
    const parsed = parseDelegateRules(
      '{"groups":[null,{"group_id":"7","files":[null,"a.ts",""]},{"files":[]}]}',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.groups).toHaveLength(1);
    // group_id 是数字字符串也必须读出来（num() 接受数字串）
    expect(parsed.groups[0]?.groupId).toBe(7);
    expect(parsed.groups[0]?.files).toStrictEqual(["a.ts"]);
  });
});

describe("parseReviewOutput — 契约收紧（finding 1/2/9 回归钉）", () => {
  it("数字字符串的 start_line/end_line/summary 不再被当成 0", () => {
    const parsed = parseOcr(
      JSON.stringify({
        status: "complete",
        summary: { files_reviewed: "2", comments: "1", total_tokens: "1500", elapsed: "3s" },
        comments: [{ path: "a.ts", content: "c", start_line: "42", end_line: "43" }],
      }),
    );
    expect(parsed.comments[0]?.startLine).toBe(42);
    expect(parsed.comments[0]?.endLine).toBe(43);
    expect(parsed.summary?.filesReviewed).toBe(2);
    expect(parsed.summary?.totalTokens).toBe(1500);
    // 关键：数字串锚定的评论必须进摘要（此前 "42"→0 → startLine>0 过滤 → 被丢）
    const view = summarizeView(parsed, { maxComments: 12 }) as {
      topComments: { location: string }[];
      droppedCount: number;
    };
    expect(view.topComments[0]?.location).toBe("a.ts:42-43");
    expect(view.droppedCount).toBe(0);
  });

  it("非数字/Infinity/负数串等畸形值回 0（不抛错）", () => {
    const parsed = parseOcr(
      JSON.stringify({
        status: "success",
        summary: { files_reviewed: "abc", comments: "", total_tokens: Infinity },
        comments: [{ path: "a", content: "c", start_line: "  ", end_line: null }],
      }),
    );
    expect(parsed.summary?.filesReviewed).toBe(0);
    expect(parsed.summary?.comments).toBe(0);
    expect(parsed.summary?.totalTokens).toBe(0);
    expect(parsed.comments[0]?.startLine).toBe(0);
    expect(parsed.comments[0]?.endLine).toBe(0);
  });

  it("status 白名单：只有 error 字段的 exit 0 错误对象 ⇒ ok:false", () => {
    const bad = parseOcr('{"error":"auth failed"}');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe("invalid");
    expect(bad.message).toMatch(/status 非法或缺失/u);
    // 非白名单字符串同样拒绝（不再凭空造出 status:"unknown"）
    expect(parseOcr('{"status":"weird"}').ok).toBe(false);
    expect(parseOcr('{"status":42}').message).toContain("42");
    // 五个文档值全部接受
    for (const status of [
      "success",
      "complete",
      "completed_with_warnings",
      "completed_with_errors",
      "skipped",
    ]) {
      expect(parseOcr(`{"status":"${status}"}`).ok).toBe(true);
    }
    // JSON 顶层是数组/数字 ⇒ unparseable
    expect(parseOcr("[1]").status).toBe("unparseable");
    expect(parseOcr("null").status).toBe("unparseable");
  });

  it("comments 不是数组 ⇒ ok:false（无法证明评论完整）", () => {
    const parsed = parseOcr('{"status":"complete","comments":"none"}');
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/comments 字段不是数组/u);
  });

  it("droppedCount / invalidCommentCount 让「干净」可证明", () => {
    const parsed = parseOcr(
      JSON.stringify({
        status: "complete",
        comments: [
          { path: "a.ts", content: "high one", severity: "high", start_line: 3 },
          { path: "b.ts", content: "unanchored", severity: "critical" },
          "not-an-object",
          { path: "c.ts", content: "" },
        ],
      }),
    );
    expect(parsed.droppedComments).toBe(2);
    const view = summarizeView(parsed, { maxComments: 1 }) as {
      droppedCount: number;
      invalidCommentCount: number;
      totalCommentCount: number;
      topComments: unknown[];
    };
    expect(view.invalidCommentCount).toBe(2);
    expect(view.totalCommentCount).toBe(2);
    expect(view.droppedCount).toBe(1);
    expect(view.topComments).toHaveLength(1);
    // includeZeroLine=false 时未锚定条目计入 droppedCount（默认口径）
    const full = summarizeView(parsed, { maxComments: 0 }) as {
      droppedCount: number;
      topComments: unknown[];
    };
    expect(full.droppedCount).toBe(0);
    expect(full.topComments).toHaveLength(2);
  });

  it("未知 severity 的排序位与聚合口径一致（都按 medium，不再排在 critical 前）", () => {
    const parsed = parseOcr(
      JSON.stringify({
        status: "complete",
        comments: [
          { path: "u.ts", content: "unknown", severity: "blocker", start_line: 1 },
          { path: "c.ts", content: "crit", severity: "critical", start_line: 2 },
          { path: "m.ts", content: "med", severity: "medium", start_line: 3 },
        ],
      }),
    );
    const view = summarizeView(parsed, { maxComments: 3 }) as {
      topComments: { location: string; severity: string }[];
      aggregation: { bySeverity: Record<string, number> };
    };
    expect(view.topComments.map((cm) => cm.severity)).toStrictEqual([
      "critical",
      "blocker",
      "medium",
    ]);
    // 聚合把 blocker 记进 medium，排序位也必须落在 medium 那一档
    expect(view.aggregation.bySeverity["medium"]).toBe(2);
    expect(view.aggregation.bySeverity["critical"]).toBe(1);
  });

  it("renderComment：行号区间 / 0 行 / medium 标签省略", () => {
    expect(
      renderedComment({
        path: "a.ts",
        content: "x",
        startLine: 3,
        endLine: 5,
        category: "bug",
        severity: "high",
        existingCode: "",
        suggestionCode: "",
      }),
    ).toContain("a.ts:3-5 [high/bug]");
    const single = renderedComment({
      path: "",
      content: "y",
      startLine: 2,
      endLine: 2,
      category: "",
      severity: "medium",
      existingCode: "",
      suggestionCode: "",
    });
    expect(single).toContain("(path unknown):2");
    expect(single).not.toContain("[");
    expect(
      renderedComment({
        path: "b.ts",
        content: "z",
        startLine: 0,
        endLine: 0,
        category: "",
        severity: "medium",
        existingCode: "",
        suggestionCode: "",
      }),
    ).toMatch(/line 0/u);
  });
});

describe("warnings / 数值字段 / 失败骨架的完整口径", () => {
  it("warnings 兼容字符串条目、{file,error} 对象条目，其它形态丢弃", () => {
    const parsed = parseOcr(
      JSON.stringify({
        status: "completed_with_warnings",
        warnings: ["纯文本告警", { file: "a.ts", error: "timeout" }, { error: "仅错误" }, 42, null],
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("completed_with_warnings");
    expect(parsed.warnings).toStrictEqual(["纯文本告警", "a.ts：timeout", "仅错误"]);
  });

  it("无 warnings 字段 ⇒ 空数组（与「有字段但全被丢弃」两条分支都走）", () => {
    expect(parseOcr('{"status":"success"}').warnings).toStrictEqual([]);
    expect(parseOcr('{"status":"success","warnings":[42]}').warnings).toStrictEqual([]);
  });

  it("数值字段：数字字符串、带空格、1e999（JSON 里的非有限数）、布尔与对象各自的落点", () => {
    const parsed = parseOcr(
      [
        '{"status":"success","summary":{"files_reviewed":" 3 ","comments":true,',
        '"total_tokens":1e999,"elapsed":12},"comments":[',
        '{"path":"a.ts","content":"x","start_line":" 7 ","end_line":false},',
        '{"path":"b.ts","content":"y","start_line":null,"end_line":{"v":1}}]}',
      ].join(""),
    );
    expect(parsed.summary).toStrictEqual({
      filesReviewed: 3,
      comments: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      elapsed: "12",
    });
    expect(parsed.comments.map((comment) => [comment.startLine, comment.endLine])).toStrictEqual([
      [7, 0],
      [0, 0],
    ]);
  });

  it("缺 path 的评论在 top 位置里降级为 (path unknown)", () => {
    const parsed = parseOcr(
      JSON.stringify({ status: "success", comments: [{ content: "无路径", start_line: 4 }] }),
    );
    const view = summarizeView(parsed, { maxComments: 1 });
    expect(view.topComments[0]?.location).toBe("(path unknown):4");
    expect(view.sessionId).toBeNull();
    expect(view.summary).toBeNull();
  });
});

describe("delegate 解析的失败与降级分支", () => {
  it("preview：total_files=0 时退用 reviewable_count；非对象/坏 JSON 均 ok:false", () => {
    const fallback = parseDelegatePreview(
      '{"mode":"workspace","total_files":0,"reviewable_count":7,"reviewable_files":[]}',
    );
    expect(fallback.ok).toBe(true);
    expect(fallback.totalFiles).toBe(7);
    expect(parseDelegatePreview("{ broken").ok).toBe(false);
    expect(parseDelegatePreview('"just a string"').ok).toBe(false);
    expect(parseDelegatePreview('{"error":"repo is not a git worktree"}').ok).toBe(false);
    expect(parseDelegatePreview('{"mode":"commit"}').reviewable).toStrictEqual([]);
  });

  it("rule：坏 JSON / 非对象 / 无契约键 三种失败形态", () => {
    expect(parseDelegateRules("nope").ok).toBe(false);
    expect(parseDelegateRules('[{"files":[]}]').ok).toBe(false);
    expect(parseDelegateRules('{"error":"no rules"}')).toStrictEqual({ ok: false, groups: [] });
  });

  it("rule：groups 非数组、files 非数组与 files 内非字符串都安全降级", () => {
    expect(parseDelegateRules('{"schema_version":1,"groups":"none"}').groups).toStrictEqual([]);
    const parsed = parseDelegateRules(
      '{"groups":[{"group_id":"2","files":["a.ts",null,{"a":1}],"rule":"r"},' +
        '{"files":[]},{"group_id":3,"files":"不是数组","rule":"r3"}]}',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.groups).toStrictEqual([
      { groupId: 2, source: "", pattern: "", files: ["a.ts"], rule: "r" },
    ]);
  });
});

// ── i18n：解析文案取自注入的消息表（换那份 = 换语言）─────────────────────────
describe("解析文案双语（消息表由调用方注入）", () => {
  it("en 那份注入后，失败原因 / hint / 0 行说明都是英文", () => {
    const { en } = MESSAGES;
    expect(parseReviewOutput('{"error":"auth failed"}', en).message).toMatch(
      /invalid or missing status/u,
    );
    expect(parseReviewOutput("not json at all", en).message).toBe(en.ocrNotJson);
    const view = summarizeReview(parseReviewOutput('{"status":"complete"}', en), en);
    expect(view.hint).toBe(en.reviewSummaryHint);
    const zero = renderComment(
      {
        path: "a.ts",
        content: "z",
        startLine: 0,
        endLine: 0,
        category: "",
        severity: "medium",
        existingCode: "",
        suggestionCode: "",
      },
      en,
    );
    expect(zero).toContain("not anchored");
  });

  it("同一输入两语各自可读：中文那份与英文那份不同源、且都不为空", () => {
    for (const key of [
      "ocrNotJson",
      "ocrNotObject",
      "ocrCommentsNotArray",
      "reviewSummaryHint",
      "lineZeroNote",
      "statusNone",
    ] as const) {
      expect(MESSAGES.en[key].length, `${key} 英文文案缺失`).toBeGreaterThan(0);
      expect(MESSAGES.zh[key], `${key} 两语文案相同`).not.toBe(MESSAGES.en[key]);
    }
  });

  it("warnings 的连接器随语言走（中文全角冒号、英文半角）", () => {
    const warned = '{"status":"completed_with_warnings","warnings":[{"file":"a.ts","error":"t"}]}';
    expect(parseReviewOutput(warned, MESSAGES.zh).warnings).toStrictEqual(["a.ts：t"]);
    expect(parseReviewOutput(warned, MESSAGES.en).warnings).toStrictEqual(["a.ts: t"]);
  });
});
