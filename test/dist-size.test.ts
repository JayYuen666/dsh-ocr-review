// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡两类不会让任何行为用例变红的回退：构建切面里塞进大查表/字面量，
// 以及外部化清单漏掉一枚包导致整包被内联（`test/build-host.test.ts` 那几条断言判的是说明符
// 字符串还在、模块标记不在，翻倍本身不触发它们）。
//
// 预算怎么定的：两个上限都是「定预算那一刻的在产物体积实测值上加约 15%、向上取整到 500 字节」得来的。
// 留这一截是给正常演进的——加一条规则、改一句文案不该立刻逼人来改预算；翻倍一定会顶穿。
// 它不是验收线：确属正常演进就改这里对应的常量，别为了过门去压缩产物正文。
//
// minify 的分工：host.js 不压缩——`test/build-host.test.ts` 靠说明符与标识符文本钉外部化，
// 压缩会废掉那几条门禁；client.js 自 0.1.20 起压缩（build-client.mjs 的 `minify`），包名同源
// 判据随之改读源码声明，本门对它只看体积。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  // 1.13.3 工具清单扩展（preview/compare/export/rules/llm/摘要字段与双语文案）后的正常演进。
  // 本轮新增：scan 会话根规范化与 path/exclude 重基、export 临时目录 TTL 清理、
  // preview 的 ignoredParams、delegate preview 计数与 MCP URL 严格语法校验。
  // 0.1.22 再增 OCR 1.14 的 analysis 入参、analysis_meta 摘要字段与双语文案（构建后实测
  // 369,937 B）；按本文件头部「实测 + 约 15%、向上取整到 500」的定预算口径取 425,000
  //（约 +14.9%，同一档余量）。
  ["host.js", 425_000],
  // MCP/ChatGPT 管理区（编辑框、状态与双语按钮）后的正常演进。
  // shared 客户端行改为 external 并开启 minify 后实测 46,701 B；shared card-ui 的字节
  // 不再计入本产物，按实测 × 1.25 取整重定。
  ["client.js", 58_000],
];

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条预算断言形状完全相同，手写循环多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    let bytes: number;
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
      `${file} 实测 ${bytes} B，预算 ${budget} B，超支 ${bytes - budget} B：多半是某个切面塞进了大查表或字面量，` +
        "或者外部化清单漏了一枚包导致整包被内联。确属正常演进就改 test/dist-size.test.ts 里" +
        "对应的预算常量，并写明理由。",
    );
  });
});
