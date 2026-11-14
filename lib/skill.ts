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
// 为什么是 `register` 而不是 `registerProvider`：正文就在内存里（文案字典已经带语言了），
// 没有文件要读、没有远端要探。`registerProvider` 的 `list()`/`get()` 是异步发现协议，
// 拿它包一份现成字符串只会多一层间接。
//
// 服务是**可选**的：`@deepseek-ai/dsh-skill` 未装载（精简 profile）时 `ctx.get("skills")`
// 回 undefined，此时只是没有 skill 可加载——systemPrompt 那段摘要照旧生效，工具照旧可用。
// 所以这里不进 inject 依赖表：进了就把「有 skill 服务」变成插件的硬性前提。
//
// 名字用 kebab-case（`isSkillName` 的语法），与工具名区分开：工具是 ocr_review /
// ocr_scan / ocr_session 这些下划线名，skill 是 ocr-review。

/** skill 名：kebab-case，也是模型用 skill 工具加载时的入参。 */
export const SKILL_NAME = "ocr-review";

/** `ctx.get("skills")` 交回来的那一面（只取本包用得到的那一位）。
 *  官方 `SkillRegistry.register(skill): () => void` 见
 *  `@deepseek-ai/dsh-skill/lib/types/index.d.ts`。 */
interface SkillsFace {
  readonly register: (skill: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
  }) => () => void;
}

/** 收窄判定：只认「有 register 且是函数」的对象，空对象不能冒充 skill 服务。 */
function isSkillsFace(value: unknown): value is SkillsFace {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const member: unknown = Reflect.get(value, "register");
  return typeof member === "function";
}

/**
 * 注册（或重新注册）本包的工具规则 skill。
 *
 * 文案随调用点传入而不是在这里取：语言由 apply 时的官方 locale 偏好决定，与工具描述、
 * 参数说明同源——三处各取一次就会出现「工具描述是中文、skill 正文是英文」那种错位。
 * @param ctx - 只需 `get`（读可选服务），不要求 skills 进 inject
 * @param content - 规则全文（`messages.routingText`）
 * @param description - skill 目录里那行说明（模型据此决定要不要加载）
 * @returns 注册成功与否；未装载 skill 服务时为 false（不抛，摘要段照旧生效）
 */
export function registerRoutingSkill(
  ctx: { readonly get: (name: string) => unknown },
  content: string,
  description: string,
): boolean {
  const found = ctx.get("skills");
  if (!isSkillsFace(found)) {
    return false;
  }
  found.register({ name: SKILL_NAME, description, content });
  return true;
}
