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
import { MESSAGES, format } from "../lib/messages.ts";

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

// 下面几个键都在 Object.prototype 上：一律走变量取值，方括号字面量会被 lint 的
// dot-notation / no-proto 改写掉——而这里要验的恰恰是「方括号取值不命中继承属性」。
const ctorKey = "constructor";
const toStringKey = "toString";
const protoKey = "__proto__";

/** 造一条最小评论；category 是这组用例唯一关心的字段。 */
const mk = (category: string): OcrComment => ({
  path: "a.ts",
  content: "x",
  startLine: 1,
  endLine: 2,
  existingCode: "",
  suggestionCode: "",
  category,
  severity: "medium",
});

describe("aggregateComments 的 category 计数不被原型链污染", () => {
  it("constructor / toString 按普通键计数，不被写成函数字符串", () => {
    const agg = aggregateComments([mk(ctorKey), mk(toStringKey), mk(ctorKey)]);
    expect(agg.byCategory[ctorKey]).toBe(2);
    expect(agg.byCategory[toStringKey]).toBe(1);
  });

  it("__proto__ 是普通自有键：计数不消失，克隆后仍在", () => {
    const agg = aggregateComments([mk(protoKey), mk(protoKey)]);
    expect(agg.byCategory[protoKey]).toBe(2);
    // 修复前 __proto__ 是 setter，赋值被静默忽略、这条评论的计数直接消失；
    // 这里断它是一个真·自有属性（getOwnPropertyDescriptor 取得到值）。
    const cloned = structuredClone(agg.byCategory);
    expect(Object.getOwnPropertyDescriptor(cloned, protoKey)?.value).toBe(2);
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
    expect(preview.totalFiles).toBe(2);
  });

  it("preview：excluded 的理由读的是 CLI 的 exclude_reason（不是脑补的 reason）", () => {
    // 真回执（ocr 1.13.0 delegate_cmd.go 的 delegatePreviewFileJSON）发的键是
    // `exclude_reason`；fixture 里那条按真实形态写。此前本包读 `reason`，真回执里
    // 那个键不存在 ⇒ 每条 excluded 的 reason 都是空串，而工具描述与 output schema
    // 都在承诺「被排除文件及原因」。
    const preview = parseDelegatePreview(read("delegate-preview.json"));
    expect(preview.excluded).toStrictEqual([{ path: "package-lock.json", reason: "default_path" }]);
    // 旧形态（只有 `reason`）仍读得出来：回退不是死分支。
    const legacy = parseDelegatePreview(
      '{"mode":"workspace","excluded_files":[{"path":"a.ts","reason":"binary"}]}',
    );
    expect(legacy.excluded).toStrictEqual([{ path: "a.ts", reason: "binary" }]);
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
    // 六个源码值全部接受（partial 是 manifest 终态 StatePartial，exit 0——
    // review_cmd.go 的退出注释 "complete/partial/skipped all succeed"）。
    for (const status of [
      "success",
      "complete",
      "partial",
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

  it("partial（manifest 终态，exit 0）⇒ ok:true，评论与 summary 完整保留不丢弃", () => {
    // 回归钉：此前白名单漏了 partial，整场已花费 token 的部分评审被误报
    // 「status 非法」并把全部评论丢掉。
    const parsed = parseOcr(
      JSON.stringify({
        status: "partial",
        message: "Some files could not be reviewed.",
        comments: [{ path: "a.ts", content: "x", start_line: 1, end_line: 2, severity: "high" }],
        summary: { files_reviewed: 3, comments: 1, total_tokens: 100 },
        warnings: [{ file: "b.ts", message: "boom" }],
        session_id: "sess-p",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("partial");
    expect(parsed.skipped).toBe(false);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.sessionId).toBe("sess-p");
    expect(parsed.summary?.filesReviewed).toBe(3);
    expect(parsed.warnings).toStrictEqual(["b.ts：boom"]);
    // 摘要视图同样可用：totalCommentCount 计入，model 能看到 partial 状态本身。
    const view = summarizeView(parsed);
    expect(view.status).toBe("partial");
    expect(view.totalCommentCount).toBe(1);
    expect(view.topComments[0]?.location).toBe("a.ts:1-2");
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
  it("warnings 按 OCR 的 {file,message,type} 解码；读不出的条目留占位而非静默丢弃", () => {
    // 回归钉：照 {file,error} 读时 message 永远取不到，交给模型的是只剩文件名的告警，
    // 而 completed_with_warnings 这类状态下失败细节本来只有这一个来源。
    // 42 / null 这类不合形态的条目同样不许被 filter(Boolean) 静默丢掉。
    const parsed = parseOcr(
      JSON.stringify({
        status: "completed_with_warnings",
        warnings: [
          "纯文本告警",
          { file: "a.ts", message: "timeout", type: "subtask_error" },
          { message: "仅有说明" },
          { type: "note" },
          42,
          null,
          {},
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("completed_with_warnings");
    expect(parsed.warnings).toStrictEqual([
      "纯文本告警",
      "a.ts：timeout [subtask_error]",
      "仅有说明",
      "[note]",
      zh.warningUnreadable,
      zh.warningUnreadable,
      // 对象但三个字段都读不出：落占位而不是空字符串
      zh.warningUnreadable,
    ]);
  });

  it("无 warnings 字段 ⇒ 空数组；字段存在但不是数组 ⇒ 一条占位", () => {
    expect(parseOcr('{"status":"success"}').warnings).toStrictEqual([]);
    expect(parseOcr('{"status":"success","warnings":[42]}').warnings).toStrictEqual([
      zh.warningUnreadable,
    ]);
    expect(parseOcr('{"status":"partial","warnings":"nope"}').warnings).toStrictEqual([
      zh.warningUnreadable,
    ]);
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

describe("诊断字段：tool_calls / manifest.coverage / summary.budget_exceeded", () => {
  it("真实 complete 夹具：调用数与覆盖度一起带出，模型能证明「这一场审完了」", () => {
    const parsed = parseOcr(read("ocr-review-complete.json"));
    expect(parsed.toolCalls).toStrictEqual({ total: 5, failure: 0, failures: [] });
    expect(parsed.coverage).toStrictEqual({
      selected: 1,
      completed: 1,
      reused: 0,
      failed: 0,
      waived: 0,
      failedItems: [],
    });
    expect(parsed.budgetExceeded).toBe(false);
  });

  it("预算截断与 failed 条目：status 只写 partial，这两处补上「为什么没审完」", () => {
    const parsed = parseOcr(
      '{"status":"partial","summary":{"budget_exceeded":true},"manifest":{"coverage":{' +
        '"selected":[{},{},{}],"completed":[{}],"reused":[],' +
        '"failed":[{"path":"b.ts","classification":"budget","reason":"cap"},{"path":"c.ts"}],' +
        '"waived":[]}}}',
    );
    expect(parsed.budgetExceeded).toBe(true);
    expect(parsed.coverage).toMatchObject({ selected: 3, completed: 1, failed: 2 });
    expect(parsed.coverage?.failedItems).toStrictEqual(["b.ts [budget] cap", "c.ts"]);
  });

  it("failure_details 逐条渲染：缺 tool_name 落占位，缺 file_path 不带 @ 段", () => {
    const parsed = parseOcr(
      '{"status":"complete","tool_calls":{"total":2,"failure":2,"failure_details":[' +
        '{"error":"only error"},{"tool_name":"code_search","error":"x"}]}}',
    );
    expect(parsed.toolCalls?.failures).toStrictEqual([
      `${zh.statusNone}: only error`,
      "code_search: x",
    ]);
  });

  it("明细超过上限：截到上限并补一条省略说明，别让截断读成「一共就这些」", () => {
    const details = Array.from({ length: 11 }, (_unused, index) => ({
      tool_name: `t${index}`,
      error: "e",
    }));
    const parsed = parseOcr(
      JSON.stringify({
        status: "complete",
        tool_calls: { total: 11, failure: 11, failure_details: details },
      }),
    );
    const lines = parsed.toolCalls?.failures ?? [];
    // 上限行 + 一条说明；说明里给出被省略的条数。
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe(format(zh.diagnosticOmitted, { count: "3" }));
  });

  it("字段缺失即 null（不拿 0 冒充「零失败」）；形态不合即 null 并补一条读不出的说明", () => {
    const absent = parseOcr('{"status":"complete"}');
    expect(absent.toolCalls).toBeNull();
    expect(absent.coverage).toBeNull();
    expect(absent.warnings).toStrictEqual([]);
    const badTool = parseOcr('{"status":"complete","tool_calls":{"total":"x","failure":0}}');
    expect(badTool.toolCalls).toBeNull();
    expect(badTool.warnings).toStrictEqual([
      format(zh.diagnosticUnreadable, { field: "tool_calls" }),
    ]);
    const badDetails = parseOcr(
      '{"status":"complete","tool_calls":{"total":1,"failure":0,"failure_details":{}}}',
    );
    expect(badDetails.toolCalls).toBeNull();
    const badCoverage = parseOcr('{"status":"partial","manifest":{"coverage":{"selected":0}}}');
    expect(badCoverage.coverage).toBeNull();
    expect(badCoverage.warnings).toStrictEqual([
      format(zh.diagnosticUnreadable, { field: "manifest.coverage" }),
    ]);
    const badManifest = parseOcr('{"status":"partial","manifest":42}');
    expect(badManifest.coverage).toBeNull();
    expect(badManifest.warnings).toHaveLength(1);
  });

  it("null 值算「没有这层数据」，不落读不出", () => {
    const parsed = parseOcr('{"status":"skipped","tool_calls":null,"manifest":null}');
    expect(parsed.toolCalls).toBeNull();
    expect(parsed.coverage).toBeNull();
    expect(parsed.warnings).toStrictEqual([]);
  });

  it("失败骨架与摘要视图同带这三字段（输出契约逐分支对齐）", () => {
    const failed = parseOcr("not json");
    expect(failed.toolCalls).toBeNull();
    expect(failed.coverage).toBeNull();
    expect(failed.budgetExceeded).toBe(false);
    const view = summarizeView(
      parseOcr('{"status":"complete","summary":{"budget_exceeded":true}}'),
    );
    expect(view.budgetExceeded).toBe(true);
    expect(view.toolCalls).toBeNull();
    expect(view.coverage).toBeNull();
  });

  it('budget_exceeded 只认真布尔：字符串 "true" 不算被截断', () => {
    const parsed = parseOcr('{"status":"complete","summary":{"budget_exceeded":"true"}}');
    expect(parsed.budgetExceeded).toBe(false);
  });

  it("计数字段的坏形态（负数、小数、非数字串）都算读不出，不被 num 折成 0", () => {
    for (const total of ["-1", "1.5", "{}", "true"]) {
      const parsed = parseOcr(`{"status":"complete","tool_calls":{"total":${total},"failure":0}}`);
      expect(parsed.toolCalls, `total=${total}`).toBeNull();
      expect(parsed.warnings).toStrictEqual([
        format(zh.diagnosticUnreadable, { field: "tool_calls" }),
      ]);
    }
  });

  it("tool_calls 不是对象、coverage 不在 manifest 里：都判读不出而不是静默空", () => {
    const scalar = parseOcr('{"status":"complete","tool_calls":"nope"}');
    expect(scalar.toolCalls).toBeNull();
    expect(scalar.warnings).toStrictEqual([
      format(zh.diagnosticUnreadable, { field: "tool_calls" }),
    ]);
    const noCoverage = parseOcr('{"status":"partial","manifest":{"run_id":"r"}}');
    expect(noCoverage.coverage).toBeNull();
    expect(noCoverage.warnings).toStrictEqual([
      format(zh.diagnosticUnreadable, { field: "manifest.coverage" }),
    ]);
  });

  it("failure_details 缺席是合法的「零失败明细」，与读不出是两件事", () => {
    const parsed = parseOcr('{"status":"complete","tool_calls":{"total":4,"failure":0}}');
    expect(parsed.toolCalls).toStrictEqual({ total: 4, failure: 0, failures: [] });
    expect(parsed.warnings).toStrictEqual([]);
  });

  it("failed 条目的字段缺哪个就让位哪个：无 classification、无 reason、无 path、非对象各成一形", () => {
    const parsed = parseOcr(
      '{"status":"partial","manifest":{"coverage":{"selected":[{}],"completed":[],"reused":[],' +
        '"failed":[{"path":"a.ts"},{"path":"b.ts","classification":"git"},{"path":"c.ts","reason":"why"},' +
        '{"reason":"no path"},42],"waived":[]}}}',
    );
    expect(parsed.coverage?.failed).toBe(5);
    // 非对象那条渲染不出来：计数仍在 failed 里，明细以「已省略 1 条」收尾，
    // 而不是把它悄悄吞掉、让模型以为已经看全。
    expect(parsed.coverage?.failedItems).toStrictEqual([
      "a.ts",
      "b.ts [git]",
      "c.ts why",
      `${zh.statusNone} no path`,
      format(zh.diagnosticOmitted, { count: "1" }),
    ]);
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

  it("preview：契约键在但类型不对（null / 字符串 / 对象）⇒ 判失败，不报「0 个文件可审」", () => {
    // 此前 hitsContract 只查「键在不在」，{"reviewable_files": null} 这种上游半截产出
    // 被当成合法文档 ⇒ ok:true + 空清单 = 假阴性的范围结论，比解析失败更难察觉。
    for (const value of ["null", '"oops"', "{}", "42"]) {
      expect(parseDelegatePreview(`{"mode":"commit","reviewable_files":${value}}`).ok).toBe(false);
      expect(parseDelegatePreview(`{"mode":"commit","excluded_files":${value}}`).ok).toBe(false);
    }
    // 合法的空数组仍然放行
    expect(parseDelegatePreview('{"mode":"commit","reviewable_files":[]}').ok).toBe(true);
  });

  it("rule：坏 JSON / 非对象 / 无契约键 三种失败形态", () => {
    expect(parseDelegateRules("nope").ok).toBe(false);
    expect(parseDelegateRules('[{"files":[]}]').ok).toBe(false);
    expect(parseDelegateRules('{"error":"no rules"}')).toStrictEqual({ ok: false, groups: [] });
  });

  it("rule：groups 非数组、组内 files 非数组都判失败（不再静默丢组）", () => {
    // groups 是字符串：那不是「0 个分组」，是契约破损，报 ok:false 才对。
    expect(parseDelegateRules('{"schema_version":1,"groups":"none"}')).toStrictEqual({
      ok: false,
      groups: [],
    });
    // 组内 files 非字符串：此前该组被 files.length > 0 过滤掉，一组规则凭空消失
    // 而 ok 仍是 true——调用方无从知道自己拿到的是残缺清单。
    expect(
      parseDelegateRules('{"groups":[{"group_id":3,"files":"不是数组","rule":"r3"}]}'),
    ).toStrictEqual({ ok: false, groups: [] });
  });

  it("rule：只有 schema_version、groups 缺失 ⇒ 空分组且 ok:true（不是破损）", () => {
    // groups 缺失是「这个文件里没有规则」的正常形态，与「groups 在但形状坏了」要分得开。
    expect(parseDelegateRules('{"schema_version":1}')).toStrictEqual({ ok: true, groups: [] });
  });

  it("rule：files 内非字符串项被丢弃，其余组照常返回", () => {
    const parsed = parseDelegateRules(
      '{"groups":[{"group_id":"2","files":["a.ts",null,{"a":1}],"rule":"r"},{"files":[]}]}',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.groups).toStrictEqual([
      { groupId: 2, source: "", pattern: "", files: ["a.ts"], rule: "r" },
    ]);
  });

  it("rule：分组一条都解析不出来 ⇒ ok:false（不是「0 个规则分组」）", () => {
    // 部分分组解析不出来照旧放行，但全灭时继续报 ok:true + 空分组，模型与用户都会把
    // 半截产出当成范围结论——与 preview 的同款门。
    expect(parseDelegateRules('{"groups":[{"group_id":1}]}')).toStrictEqual({
      ok: false,
      groups: [],
    });
    // files 全是非字符串项时 str() 会造出 "1" / "[object Object]" 这类凭空文件名，
    // 这里整组判不可用。
    expect(parseDelegateRules('{"groups":[{"rule":"r","files":[1,null,{}]}]}')).toStrictEqual({
      ok: false,
      groups: [],
    });
  });

  it("preview：excluded_files 条目全废 ⇒ ok:false（不是「没有排除项」）", () => {
    // 与 reviewable_files 同款门：条目一个都没解析出来时，那是半截产出，不能以
    // ok:true 的形态报「排除项为空」。
    expect(parseDelegatePreview('{"mode":"commit","excluded_files":[7]}').ok).toBe(false);
    expect(parseDelegatePreview('{"mode":"commit","excluded_files":[{"reason":"x"}]}').ok).toBe(
      false,
    );
    // 合法空数组仍然放行。
    expect(parseDelegatePreview('{"mode":"commit","excluded_files":[]}').ok).toBe(true);
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
    const warned =
      '{"status":"completed_with_warnings","warnings":[{"file":"a.ts","message":"t"}]}';
    expect(parseReviewOutput(warned, MESSAGES.zh).warnings).toStrictEqual(["a.ts：t"]);
    expect(parseReviewOutput(warned, MESSAGES.en).warnings).toStrictEqual(["a.ts: t"]);
  });
});
