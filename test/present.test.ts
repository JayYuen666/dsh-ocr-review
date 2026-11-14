// 调用态卡片（`presentCall`）的规格表：只读模型参数、不预判结果。
//
// 这一格的判据是「不声明会怎样」：宿主回落到默认卡片，标题=工具名、没有类别图标，
// 七条工具在时间线上长得一模一样。所以期望表独立写死，不从实现派生。

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { callViewOf } from "../lib/present.ts";

/** 七条工具的期望类别。写死的是「用户想看到什么动作」，不是从实现读。 */
const KINDS = new Map<string, string>([
  ["ocr_review", "search"],
  ["ocr_scan", "search"],
  ["ocr_delegate_preview", "search"],
  ["ocr_delegate_rule", "read"],
  ["ocr_session", "read"],
  ["ocr_rules_check", "read"],
  ["ocr_llm", "other"],
]);

describe("callViewOf（七条工具的调用态卡片）", () => {
  it("每条工具都给出 generic 卡片、各自对路的类别、非空标题", () => {
    for (const [name, kind] of KINDS) {
      const view = callViewOf(name, {});
      assert.ok(view !== undefined, `${name} 没有卡片规格`);
      // 上面那条 assert.ok 已把类型收窄成非 undefined。
      assert.equal(view.card, "generic", `${name} 的卡片类型`);
      assert.equal(view.kind, kind, `${name} 的卡片类别`);
      assert.ok(
        typeof view.title === "string" && view.title.length > 0,
        `${name} 的卡片标题不能是空串`,
      );
    }
  });

  it("标题取模型给的那个对象：repo / 会话 id / 规则路径", () => {
    assert.equal(callViewOf("ocr_review", { repo: "/tmp/repo" })?.title, "/tmp/repo");
    assert.equal(callViewOf("ocr_session", { id: "session-1" })?.title, "session-1");
    assert.equal(
      callViewOf("ocr_rules_check", { path: ".ocr-rules.json" })?.title,
      ".ocr-rules.json",
    );
    assert.equal(callViewOf("ocr_llm", { action: "providers" })?.title, "providers");
  });

  it("数组字段取第一项（卡片标题只放得下一个）", () => {
    assert.equal(
      callViewOf("ocr_delegate_rule", { paths: ["src/a.ts", "src/b.ts"] })?.title,
      "src/a.ts",
    );
    assert.equal(callViewOf("ocr_scan", { path: ["lib/", "test/"] })?.title, "lib/");
  });

  it("参数缺失或类型不对时回落工具名，不把 [object Object] 画上卡片", () => {
    assert.equal(callViewOf("ocr_review", {})?.title, "ocr_review");
    assert.equal(callViewOf("ocr_review", { repo: 42 })?.title, "ocr_review");
    assert.equal(callViewOf("ocr_session", { id: { nested: true } })?.title, "ocr_session");
    assert.equal(callViewOf("ocr_scan", { path: [] })?.title, "ocr_scan");
  });

  it("未登记的工名交回 undefined（宿主按「无视图」处理），不抛错", () => {
    assert.equal(callViewOf("ocr_unknown", {}), undefined);
    assert.equal(callViewOf("", { repo: "/tmp" }), undefined);
  });
});
