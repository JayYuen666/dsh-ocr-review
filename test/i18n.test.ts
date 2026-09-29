// 双语字典契约（P6 i18n）：两语键集与插值占位符必须一一对应。
//
// 键集一致**主要靠类型**（zh/en 都标注成同一个 Messages 接口，少键多键在 tsc 阶段
// 就红，见 lib/locale.ts 的说明）。本文件守的是类型管不到的三件事：
//   1. 值非空、en 那份真不含中文（漏翻会在这里红，而不是在英文界面上露出一句中文）；
//   2. 模板两侧的 `{占位符}` 集合一致——翻译时漏掉一个插值，运行时只会看到空白，
//      没有任何报错，所以这条必须有测试；
//   3. host 半自带的 format() 行为（缺键退空串，绝不在文案里留下裸占位符）。
import { describe, expect, it } from "vitest";
import { MESSAGES, format } from "../lib/messages.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";

/** 模板里的 {占位符} 名字集合：只认成对的 `{词}`，`{path, content}` 这类不算。 */
function placeholders(template: string): Set<string> {
  const found = template.match(/\{\w+\}/gu) ?? [];
  return new Set(found.map((token) => token.slice(1, -1)));
}

/** 中文字面（含全角标点里的汉字；`\p{Script=Han}` 覆盖 CJK 汉字区）。 */
const HAN = /[\p{Script=Han}]/u;

/** 取字典的键清单（两语同一类型，键集由 tsc 保证，这里只当运行时数据比对）。 */
function keysOf(catalog: { zh: Record<string, string> }): string[] {
  return Object.keys(catalog.zh);
}

/** 两份字典按「扁平 string 表」看（interface 没有隐式索引签名，只能过一次 unknown）。 */
interface Dict {
  zh: Record<string, string>;
  en: Record<string, string>;
}
const asDict = (catalog: unknown): Dict => catalog as Dict;
const DICTS: readonly [string, Dict][] = [
  ["host 半 MESSAGES", asDict(MESSAGES)],
  ["卡片半 UI_MESSAGES", asDict(UI_MESSAGES)],
];

/** 无序比较两个键集合：`toSorted` 在本包 tsgolint 的 lib 判定下不可用，用 Set。 */
function sameKeys(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  if (leftSet.size !== right.length) {
    return false;
  }
  return right.every((key) => leftSet.has(key));
}

describe("字典键集与值形态", () => {
  it.each(DICTS)("%s：zh / en 键集一致，值都非空", (_name, catalog) => {
    const keys = keysOf(catalog);
    expect(keys.length).toBeGreaterThan(10);
    expect(sameKeys(keys, Object.keys(catalog.en))).toBe(true);
    for (const key of keys) {
      expect((catalog.zh[key] ?? "").length, `${key} 中文文案缺失`).toBeGreaterThan(0);
      expect((catalog.en[key] ?? "").length, `${key} 英文文案缺失`).toBeGreaterThan(0);
    }
  });

  it.each(DICTS)("%s：英文那份不残留中文", (_name, catalog) => {
    for (const key of keysOf(catalog)) {
      expect(catalog.en[key] ?? "").not.toMatch(HAN);
    }
  });
});

describe("模板两侧的 {占位符} 集合一致", () => {
  it.each(DICTS)("%s：每个带插值的键在两语里占位符同名", (_name, catalog) => {
    for (const key of keysOf(catalog)) {
      const zhKeys = placeholders(catalog.zh[key] ?? "");
      const enKeys = placeholders(catalog.en[key] ?? "");
      expect(sameKeys([...zhKeys], [...enKeys]), `${key} 占位符不一致`).toBe(true);
      expect(zhKeys.size).toBe(enKeys.size);
    }
  });
});

describe("host 半 format()（host 侧没有官方插值，自带同语法）", () => {
  it("按 {name} 替换，缺键退空串（绝不留裸占位符）", () => {
    const params = { count: "3", namespace: "llm-pi-ai" };
    expect(format("共 {count} 个 · {namespace}", params)).toBe("共 3 个 · llm-pi-ai");
    expect(format("缺一个 {miss} 键", { here: "x" })).toBe("缺一个  键");
  });

  it(String.raw`非 \w+ 的花括号片段（如评论格式示例）原样保留`, () => {
    const shape = "输出评论建议格式：{path, content, start_line}。";
    expect(format(shape, { path: "被吃掉就说明规则错了" })).toBe(shape);
    expect(MESSAGES.en.ruleHint).toContain(
      "{path, content, start_line, end_line, category, severity}",
    );
  });

  it("注入段的中文原文仍在（英文是补齐而非替换），且两语都保留了 CLI 字面量", () => {
    expect(MESSAGES.zh.routingText).toMatch(/ocr_delegate_preview/u);
    expect(MESSAGES.en.routingText).toMatch(/ocr_delegate_preview/u);
    expect(MESSAGES.zh.routingText).toMatch(HAN);
  });
});
