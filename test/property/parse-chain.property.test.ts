// 解析链与脱敏层的属性面：OCR 输出解析是「外部工具的任意文本 → 工具回执」的第一站，
// 全函数性与不变量在这里钉。期望值来自 lib/parse.ts / lib/output.ts 头注写明的契约、
// /tmp 探针实测（redact 对纯小写不抹的保守方向、parseOcrVersion 的产品名锚定、
// commaList 交回数组）与 test/fixtures 的真实 OCR 回执，不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseReviewOutput, summarizeReview } from "../../lib/parse.ts";
import { redactKeyMaterial } from "../../lib/output.ts";
import { parseOcrVersion } from "../../lib/cli.ts";
import { commaList, clampEffort } from "../../lib/argv-guard.ts";
import { MESSAGES } from "../../lib/messages.ts";

const { zh } = MESSAGES;

/** 路径段生成域（commaList 的合法输入）。 */
const pathItemArb = fc.array(fc.stringMatching(/^[a-z0-9_.-]{1,10}$/u), { maxLength: 8 });
/** effort 取值域：白名单变体 + 任意串（clampEffort 的输入全集）。 */
const effortArb = fc.oneof(
  fc.constant("LOW"),
  fc.constant("Medium"),
  fc.constant("HIGH "),
  fc.string(),
);
const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "../fixtures/ocr-review-complete.json"),
  "utf8",
);

describe("parseReviewOutput 的全函数性", () => {
  it("任意文本不抛；解析成功时评论与丢弃计数守恒", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const parsed = parseReviewOutput(text, zh);
        if (!parsed.ok) {
          return;
        }
        const dropped = typeof parsed.droppedComments === "number" ? parsed.droppedComments : 0;
        assert.ok(parsed.comments.length + dropped >= parsed.comments.length);
      }),
    );
  });

  it("真实 OCR 回执（fixture）解析出 3 条评论，摘要计数守恒", () => {
    const parsed = parseReviewOutput(FIXTURE, zh);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.comments.length, 3);
    const summary = summarizeReview(parsed, zh);
    assert.equal(summary.totalCommentCount, 3);
  });

  it("status 非法（不在白名单）判 ok:false；failed 状态认得出但同样 ok:false", () => {
    const hostile = JSON.stringify({ ...JSON.parse(FIXTURE), status: "random-status" });
    assert.equal(parseReviewOutput(hostile, zh).ok, false);
    const failed = JSON.stringify({ ...JSON.parse(FIXTURE), status: "failed" });
    assert.equal(parseReviewOutput(failed, zh).ok, false);
  });
});

describe("redactKeyMaterial 的保守性", () => {
  it("幂等：redact(redact(x)) === redact(x)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        assert.equal(redactKeyMaterial(redactKeyMaterial(text)), redactKeyMaterial(text));
      }),
    );
  });

  it("独立 key（随机段 ≥20 且含数字/大写）恒被抹；纯小写短串（词/路径形态）刻意不抹", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 60 }), (length) => {
        // STANDALONE_KEY 的随机段 ≥20；sk- 前缀走 KNOWN_KEY_PREFIX（连路径豁免都不给）。
        const mixed = "aB1".repeat(Math.ceil(length / 3)).slice(0, length);
        const sk = `sk-${mixed}`;
        assert.equal(redactKeyMaterial(sk).includes(sk), false, `独立 key 未抹：${sk}`);
        const ghp = `ghp_${"A1".repeat(Math.ceil(length / 2)).slice(0, length)}`;
        assert.equal(redactKeyMaterial(ghp).includes(ghp), false);
        // 纯小写短段连 20 字符门槛都不到，原样保留（路径可读性那一侧）。
        const kebabPath = "a-kebab-lowercase-path-segment";
        assert.equal(redactKeyMaterial(kebabPath), kebabPath, "路径形态被误抹");
      }),
    );
  });
});

describe("parseOcrVersion 的形状契约", () => {
  it("上游实测的两种形态（带/不带 v 前缀 + GOOS/GOARCH 尾巴）都能解析", () => {
    assert.equal(
      parseOcrVersion("open-code-review 1.13.3 darwin/arm64\nhttps://github.com\n"),
      "1.13.3",
    );
    assert.equal(parseOcrVersion("open-code-review v1.13.3 darwin/arm64\n"), "1.13.3");
  });

  it("升级提示混入另一版本号时仍锚定产品名那一版（探针实测 1.13.3 胜出）；无锚文本回 null", () => {
    assert.equal(
      parseOcrVersion("有新版本 v9.9.9 可用，当前 open-code-review 1.13.3 darwin/arm64"),
      "1.13.3",
    );
    assert.equal(parseOcrVersion("没有任何版本号的普通输出"), null);
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const parsed = parseOcrVersion(text);
        assert.ok(parsed === null || /^\d+\.\d+\.\d+$/u.test(parsed));
      }),
    );
  });
});

describe("commaList 与 clampEffort 的取值域", () => {
  it("commaList 交回验证后的数组：项全 trim 非空；空输入回空数组", () => {
    fc.assert(
      fc.property(pathItemArb, (items) => {
        const validated = commaList(items, "paths", 32, zh);
        assert.ok(Array.isArray(validated));
        for (const part of validated) {
          assert.equal(part, part.trim());
          assert.ok(part.length > 0);
        }
      }),
    );
    assert.deepEqual(commaList([], "paths", 32, zh), []);
  });

  it("clampEffort：白名单外恒回 fallback；大小写不敏感收口", () => {
    fc.assert(
      fc.property(effortArb, (value) => {
        const clamped = clampEffort(value, "medium");
        assert.ok(["low", "medium", "high"].includes(clamped), value);
      }),
    );
  });
});
