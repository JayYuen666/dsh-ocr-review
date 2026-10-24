// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡两类不会让任何行为用例变红的回退：切面里塞进大查表/字面量，
// 以及外部化清单漏掉一枚包导致整包被内联（`test/build-host.test.ts` 那几条断言判的是说明符
// 字符串还在、模块标记不在，翻倍本身不触发它们）。
//
// 预算怎么定的：两个上限都是「定预算那一刻的产物体积上浮约 15%、向上取整到 500 字节」得来的。
// 留这一截是给正常演进的——加一条规则、改一句文案不该立刻逼人来改预算；翻倍一定会顶穿。
// 它不是验收线：确属正常演进就改这里对应的常量，别为了过门去压缩产物正文。
//
// 明确不做的事：**不开 minify**。压缩后带标识符的文本判据（内联体的函数名会被 mangle）会失效，
// 省下的体积不值得废掉那几条外部化门禁。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  // 1.13.3 工具面扩展（preview/compare/export/rules/llm/摘要字段与双语文案）后的正常演进。
  ["host.js", 311_500],
  // MCP/ChatGPT 管理区（编辑框、状态与双语按钮）后的正常演进。
  ["client.js", 90_000],
];

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条预算断言形状完全相同，手写循环多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    let bytes;
    try {
      bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    } catch (error) {
      assert.fail(
        `${file} 不在盘上：${String(error)}。这道门的正确用法是先跑 node build-host.mjs /` +
          " node build-client.mjs（`npm run check` 里 build 就排在 test 之前）。",
      );
    }
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes} B，超出预算 ${budget} B：多半是某个切面塞进了大查表或字面量，` +
        "或者外部化清单漏了一枚包导致整包被内联。确属正常演进就改 test/dist-size.test.ts 里" +
        "对应的预算常量，并写明理由。",
    );
  });
});
