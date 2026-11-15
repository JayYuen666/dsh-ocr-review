// lib/skill.ts —— 把完整工具规则注册成一枚**虚拟 skill**（rc.2 的 `ctx.skills.register()`）。
//
// 为什么要有这一层：规则全文（messages.routingText）原本整段常驻 systemPrompt，每种语言
// 2.7–3.0KB，每个会话都要背。而其中「选错工具会审错对象 / 白烧 token」的只有少数几条
// （先判 review/scan/delegate、不确定范围先 preview、background 写什么），其余是口径细节
// （读结果的两套口径、内置重试与 resume、toolCalls.failure 怎么读），只在真要用的时候才需要。
// 所以拆成两份：
//   · systemPrompt 只留摘要（messages.routingSummary），逐条对应「不做就会走错路」；
//   · 全文注册成 skill，模型按名加载（`skill({ name: "ocr-review" })`）。
//
// **注册动作本身已经收进 shared**：`@jayyuen66/dsh-plugin-shared/lib/skill` 的
// `registerSkill(ctx, spec)` 承担「取可选服务 → 判形状 → register → 回布尔」（含「正文为空
// 不注册」）。本文件只剩两样本仓自己的东西：skill 名，与把两份文本收成 spec 的那一层。此前
// 三个带常驻提示词的插件各写一遍同一段正文，逐行同构——留着没有意义。
//
// 服务是**可选**的：`@deepseek-ai/dsh-skill` 未装载（精简 profile）时注册只是回 false，
// systemPrompt 那段摘要照旧生效，工具照旧可用。shared 那边因此只收 `get`、不要求 skills 进
// inject 依赖表：进了就把「有 skill 服务」变成插件的硬性前提。
//
// 名字用 kebab-case（`isSkillName` 的语法），与工具名区分开：工具是 ocr_review /
// ocr_scan / ocr_session 这些下划线名，skill 是 ocr-review。
import { registerSkill } from "@jayyuen66/dsh-plugin-shared/lib/skill";

/** skill 名：kebab-case，也是模型用 skill 工具加载时的入参。 */
export const SKILL_NAME = "ocr-review";

/**
 * 注册（或重新注册）本包的工具规则 skill。
 *
 * 文案随调用点传入而不是在这里取：语言由 apply 时的官方 locale 偏好决定，与工具描述、
 * 参数说明同源——三处各取一次就会出现「工具描述是中文、skill 正文是英文」那种错位。
 * @param ctx - 只需 `get`（读可选服务），不要求 skills 进 inject
 * @param content - 规则全文（`messages.routingText`）
 * @param description - skill 目录里那行说明（模型据此决定要不要加载）
 * @returns 注册成功与否；未装载 skill 服务或正文为空时为 false（不抛，摘要段照旧生效）
 */
export function registerRoutingSkill(
  ctx: { readonly get: (name: string) => unknown },
  content: string,
  description: string,
): boolean {
  return registerSkill(ctx, { name: SKILL_NAME, description, content });
}
