// 调用态卡片（rc.2 的 `ToolDefinition.presentCall`）的标题投影。
//
// 单独成文件有两个理由：
//  1. `host.ts` 有 2000 行上限，而七条工具各写一段 `presentCall` 就要四十多行；
//  2. 这段逻辑与「工具干什么」无关——它只读模型参数、不预判结果，因此可以脱离
//     host 单测（`test/present.test.ts`），不必为了验证标题去装配整条插件。
//
// 不声明 `presentCall` 的后果是具体的：宿主回落到默认卡片，标题就是工具名、
// 也没有类别图标，七条工具在时间线上长得一模一样。调用态发生在 `execute` 之前，
// 所以这里只能看参数——结果侧那一步需要结构化值，而本包的工具结果形态各异。

import type { ToolCallView } from "@deepseek-ai/dsh-tools";

/** 一条工具的卡片规格：类别 + 依次尝试的标题字段 + 回落标题。 */
interface CardSpec {
  readonly kind: "search" | "read" | "other";
  readonly keys: readonly string[];
  readonly fallback: string;
}

/**
 * 七条工具的卡片规格。
 *
 * `kind` 按「用户在时间线上想看到什么动作」定，不是按工具名：评审与预览是找问题
 * （`search`，卡片带放大镜），规则解析、规则体检、会话查询是读（`read`），
 * `ocr_llm` 是列清单（`other`——它不是检索）。
 *
 * `keys` 按「模型最可能指定的那个对象」排序：单选字段在前，数组字段取第一项
 * （卡片标题只放得下一个）。
 */
const CARDS: Readonly<Record<string, CardSpec>> = {
  ocr_review: { kind: "search", keys: ["repo", "commit", "from"], fallback: "ocr_review" },
  ocr_scan: { kind: "search", keys: ["repo", "path"], fallback: "ocr_scan" },
  ocr_delegate_preview: {
    kind: "search",
    keys: ["repo", "commit", "from"],
    fallback: "ocr_delegate_preview",
  },
  ocr_delegate_rule: { kind: "read", keys: ["paths", "repo"], fallback: "ocr_delegate_rule" },
  ocr_session: { kind: "read", keys: ["id", "action", "repo"], fallback: "ocr_session" },
  ocr_rules_check: { kind: "read", keys: ["path", "rule", "repo"], fallback: "ocr_rules_check" },
  ocr_llm: { kind: "other", keys: ["action"], fallback: "ocr_llm" },
};

/**
 * 卡片标题：按 `keys` 顺序取第一个非空字符串；数组字段取第一项；全都没取到就
 * 回落到规格里写死的工具名。
 *
 * 每一格都先判类型再取：模型交的参数是未经校验的原样 unknown，字段可能是对象或
 * 数字，直接交给 UI 会把 `[object Object]` 画到卡片上。
 * @param args - 模型交进来的原始参数（已由调用点收窄成对象）
 * @param spec - 该工具的卡片规格
 * @returns 卡片标题（永不为空串）
 */
function titleOf(args: Record<string, unknown>, spec: CardSpec): string {
  for (const key of spec.keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
      return value[0];
    }
  }
  return spec.fallback;
}

/**
 * 一条工具的调用态视图。
 *
 * 未登记的工名回落到「无视图」而不是抛错：宿主对 `presentCall` 抛错按「无视图」
 * 处理，但让它抛等于把「规格表漏了一行」这种编码错误变成运行时噪音，而且发生在
 * 画卡片这种不该影响执行的位置。
 * @param name - 工具名
 * @param args - 模型交进来的原始参数（未校验）
 * @returns 宿主的调用态视图，或 `undefined`（未登记的工名）
 */
export function callViewOf(name: string, args: Record<string, unknown>): ToolCallView | undefined {
  const spec = CARDS[name];
  // 单出口：`consistent-return` 不许一个分支 `return undefined`、另一个返回视图。
  return spec === undefined
    ? undefined
    : { card: "generic", title: titleOf(args, spec), kind: spec.kind };
}
