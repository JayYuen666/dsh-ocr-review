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

/** 中文文案的痕迹：汉字，以及中文排版常用的全角标点（英文译文里出现它们同样是漏翻）。 */
const HAN = /[\p{Script=Han}、。：；（）「」【】《》？！，]/u;

/** 取字典的键清单（两语同一类型，键集由 tsc 保证，这里只当运行时数据比对）。 */
function keysOf(catalog: { zh: Record<string, string> }): string[] {
  return Object.keys(catalog.zh);
}

/** 两份字典按「扁平 string 表」看（interface 没有隐式索引签名，只能过一次 unknown）。
 *  转型前逐层校验形状：结构一旦演化成嵌套分组，先在这里点名是哪份字典、哪个键，
 *  而不是等到后面 `Object.keys(undefined)` 才炸。 */
interface Dict {
  zh: Record<string, string>;
  en: Record<string, string>;
}
function asDict(catalog: unknown): Dict {
  const value = catalog as Record<string, unknown>;
  for (const lang of ["zh", "en"]) {
    const dict = value[lang];
    if (typeof dict !== "object" || dict === null) {
      throw new TypeError(`字典缺 ${lang} 或不是对象`);
    }
    for (const [key, text] of Object.entries(dict)) {
      if (typeof text !== "string") {
        throw new TypeError(`${lang}.${key} 不是字符串`);
      }
    }
  }
  return value as unknown as Dict;
}
const DICTS: readonly [string, Dict][] = [
  ["host 半 MESSAGES", asDict(MESSAGES)],
  ["卡片半 UI_MESSAGES", asDict(UI_MESSAGES)],
];

/** 无视顺序比较两个键多重集：重复次数也要一致。
 *  `toSorted` 在本包 tsgolint 的 lib 判定下不可用，用计数表。 */
function sameKeys(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const key of left) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const key of right) {
    const remaining = counts.get(key);
    if (remaining === undefined || remaining === 0) {
      return false;
    }
    counts.set(key, remaining - 1);
  }
  return true;
}

describe("字典键集与值形态", () => {
  it.each(DICTS)("%s：zh / en 键集一致，值都非空", (_name, catalog) => {
    const keys = keysOf(catalog);
    expect(keys.length).toBeGreaterThan(10);
    expect(sameKeys(keys, Object.keys(catalog.en))).toBe(true);
    for (const key of keys) {
      expect((catalog.zh[key] ?? "").trim().length, `${key} 中文文案缺失`).toBeGreaterThan(0);
      expect((catalog.en[key] ?? "").trim().length, `${key} 英文文案缺失`).toBeGreaterThan(0);
    }
  });

  it.each(DICTS)("%s：英文那份不残留中文", (_name, catalog) => {
    for (const key of keysOf(catalog)) {
      expect(catalog.en[key] ?? "", `${key} 英文文案残留中文`).not.toMatch(HAN);
    }
  });
});

describe("模板两侧的 {占位符} 集合一致", () => {
  it.each(DICTS)("%s：每个带插值的键在两语里占位符同名", (_name, catalog) => {
    for (const key of keysOf(catalog)) {
      const zhKeys = placeholders(catalog.zh[key] ?? "");
      const enKeys = placeholders(catalog.en[key] ?? "");
      expect(sameKeys([...zhKeys], [...enKeys]), `${key} 占位符不一致`).toBe(true);
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
    expect(MESSAGES.en.ruleHint, "英文示例应保留花括号格式").toContain("{path");
    expect(placeholders(MESSAGES.en.ruleHint).size, "示例里的花括号被当成了占位符").toBe(0);
  });

  it("注入段的中文原文仍在（英文是补齐而非替换），且两语都保留了 CLI 字面量", () => {
    expect(MESSAGES.zh.routingText).toMatch(/ocr_delegate_preview/u);
    expect(MESSAGES.en.routingText).toMatch(/ocr_delegate_preview/u);
    expect(MESSAGES.zh.routingText).toMatch(HAN);
  });
});

describe("文案与实现口径对齐", () => {
  it("后台完成判据按 coverage 的四桶划分，不写成 completed == selected", () => {
    // session list 的 selected 是 completed/reused/failed/waived 的并集（OCR
    // internal/session/list.go 的 manifest 分支），只比 completed 会把续扫复用过的
    // 已完成作业判成未完成。
    for (const text of [MESSAGES.zh.backgroundPolling, MESSAGES.en.backgroundPolling]) {
      expect(text).toContain("completed_files + reused_files + waived_files == selected_files");
      expect(text).not.toContain("completed_files == selected_files");
    }
  });

  it("形状提示不带双花括号（format 不做 {{ }} 反转义）", () => {
    expect(MESSAGES.zh.mcpShapeInvalid).toContain("{name: entry}");
    expect(MESSAGES.zh.mcpShapeInvalid).not.toContain("{{");
    expect(MESSAGES.en.mcpShapeInvalid).toContain("{name: entry}");
  });

  it("会话目录提示披露 ocrConfigPath 的自定义会随 HOME 重定向", () => {
    for (const text of [
      MESSAGES.zh.ocrStatusInvalid,
      MESSAGES.zh.sessionTruncated,
      MESSAGES.en.ocrStatusInvalid,
      MESSAGES.en.sessionTruncated,
    ]) {
      expect(text).toContain("~/.opencodereview/sessions/");
      expect(text).toMatch(/ocrConfigPath/u);
    }
  });
});
