// lib/output.ts —— 工具返回形态守卫（纯函数、只依赖本包文案表）。
//
// 背景：宿主对声明了 output schema 的工具返回值做严格校验（dsh-tools 的
// ToolOutputError/INVALID_TOOL_OUTPUT，installed lib/index.js:3543 用官方
// validateJsonSchemaValue 逐值比）。曾出过一次回归：ocr_review/ocr_scan 曾返回
// { text, parsed }、delegate 两工具曾返回 { text, raw }，触发 harness 整次拒绝——
// OCR 子进程已烧完 token、结果被丢，且报错不回指插件代码。
//
// 输出契约按官方 cookbook（docs/cookbook/adding-a-tool.md）改为
// 「canonical JSON 值直返」：execute 只交推断出的那个值，不再把结构化对象
// stringify 进 { text } 再让 render 编第二层（双重编码让 PTC 拿到字符串化的 JSON
// 而非对象）。本守卫随之升级：define() 出口处用与该工具 output.schema **同一个
// 对象**自检，违规变成指向具体工具名的插件内错误（模型可见、可重试），故障暴露
// 面从"harness 深处的 schema 拒绝"收敛回插件自身。
//
// 为什么自带一枚迷你校验器而不 import 官方 validateJsonSchemaValue：本包对
// @deepseek-ai/dsh-tools 只做 type-only import（产物里不得出现该说明符，针在
// test/build-host.test.ts）。校验器的判据逐条对齐官方实现（exact-one oneOf、
// required 含 undefined、number 须有限、标量级 const/enum），关键字子集就是官方
// 那份（installed lib/index.js:206）——schema 用了子集外的关键字当场抛错，守卫
// 假装支持却静默放过，才是第二个 bug 的开始。
//
// 文案：违规说明取自 lib/messages.ts（messages 是最后一个入参，本模块仍是
// 纯函数）。脱敏那半（redactKeyMaterial）与形态校验彼此独立，替换次序一律未动。
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import { isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";

/** 守卫支持的 schema 关键字（官方 enforced subset 的全部关键字，见
 *  installed dsh-tools lib/index.js:206；description/title/default/examples 是
 *  官方同样忽略的注解）。 */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "const",
  "enum",
  "description",
  "title",
  "default",
  "examples",
]);

/** schema 里的关键字必须全部落在守卫支持的子集内（递归查 oneOf/properties/items）。
 *  违例抛错而不是当违规值报：schema 是插件自己的代码，错的是代码不是模型的数据。 */
function assertGuardable(
  schema: JsonSchemaNode,
  toolName: string,
  messages: OcrReviewMessages,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(format(messages.resultSchemaUnsupported, { tool: toolName, keyword }));
    }
  }
  for (const branch of schema.oneOf ?? []) {
    assertGuardable(branch, toolName, messages);
  }
  for (const property of Object.values(schema.properties ?? {})) {
    assertGuardable(property, toolName, messages);
  }
  const { items } = schema;
  if (items !== undefined) {
    assertGuardable(items, toolName, messages);
  }
}

/** 标量分支的形态判定（true = 不合形态；判据对齐官方 checkValue 的标量臂：
 *  number 须为有限 JSON 数、integer 须整数值）。 */
function scalarMismatch(
  type: "string" | "number" | "integer" | "boolean" | "null",
  value: unknown,
): boolean {
  if (type === "string") {
    return typeof value !== "string";
  }
  if (type === "number") {
    return typeof value !== "number" || !Number.isFinite(value);
  }
  if (type === "integer") {
    return typeof value !== "number" || !Number.isInteger(value);
  }
  if (type === "boolean") {
    return typeof value !== "boolean";
  }
  return value !== null;
}

/** 递归走查的函数面（object/array 分支经它回到顶层走查器，避免相互定义序问题）。 */
type Walker = (schema: JsonSchemaNode, value: unknown, path: string) => string[];

/** object 分支：isRecord → additionalProperties:false 的多余键 → required（缺键与
 *  「键在但值是 undefined」同判，与官方一致）→ 逐声明字段递归。 */
function objectViolations(
  schema: JsonSchemaNode,
  value: unknown,
  path: string,
  walk: Walker,
): string[] {
  if (!isRecord(value)) {
    return [`${path}: expected object`];
  }
  const { properties, required, additionalProperties } = schema;
  if (additionalProperties === false) {
    const extra = Object.keys(value).filter((key) => properties?.[key] === undefined);
    if (extra.length > 0) {
      return [`${path}: fields outside the schema: ${extra.join(", ")}`];
    }
  }
  for (const key of required ?? []) {
    if (!(key in value) || value[key] === undefined) {
      return [`${path}: missing required field ${key}`];
    }
  }
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    const child = properties?.[key];
    if (child !== undefined) {
      violations.push(...walk(child, value[key], `${path}.${key}`));
    }
  }
  return violations;
}

/** array 分支：Array.isArray → 无 items 视为任意元素 → 逐元素递归（违规一次列全）。 */
function arrayViolations(
  schema: JsonSchemaNode,
  value: unknown,
  path: string,
  walk: Walker,
): string[] {
  if (!Array.isArray(value)) {
    return [`${path}: expected array`];
  }
  const { items } = schema;
  if (items === undefined) {
    return [];
  }
  return value.flatMap((item, index) => walk(items, item, `${path}[${index}]`));
}

/** 官方子集的迷你走查（path 限定违规位置，一次列全）。oneOf 语义与官方一致：
 *  恰好一支命中，多支/零支都算违规。 */
function violationsOf(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((branch) => violationsOf(branch, value, path).length === 0);
    if (passing.length !== 1) {
      return [`${path}: matched ${passing.length} of ${schema.oneOf.length} oneOf branches`];
    }
    return [];
  }
  const { type } = schema;
  if (type === "object") {
    return objectViolations(schema, value, path, violationsOf);
  }
  if (type === "array") {
    return arrayViolations(schema, value, path, violationsOf);
  }
  if (type === undefined) {
    // 官方子集的「无约束」节点：任何 JSON 值都合形态。
    return [];
  }
  // 剩下的全是标量分支（string/number/integer/boolean/null）+ 标量级 const/enum。
  if (scalarMismatch(type, value)) {
    return [`${path}: expected ${type}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    return [`${path}: must be exactly ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum !== undefined && !(schema.enum as readonly unknown[]).includes(value)) {
    return [
      `${path}: must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join("/")}`,
    ];
  }
  return [];
}

/**
 * 校验并放行工具返回值：必须命中该工具自己的 output schema。
 * 违规抛错而非静默裁剪——静默修正是第二个 bug 的开始，抛错让回归在开发期
 * （vitest/首次调用）就炸出来。
 * @param schema 该工具注册时声明的 output.schema（与宿主校验用的是同一个对象）
 * @param value execute 交回的 canonical 值（结构化对象 / 数组 / 标量 / null）
 * @param toolName 工具名（违规信息要点名，模型才知道该重试哪一次调用）
 * @param messages 双语文案
 * @returns 原值（校验只读不改，值原样交给宿主）
 */
export function assertToolOutput(
  schema: JsonSchemaNode,
  value: unknown,
  toolName: string,
  messages: OcrReviewMessages,
): unknown {
  assertGuardable(schema, toolName, messages);
  const violations = violationsOf(schema, value, "result");
  if (violations.length > 0) {
    throw new Error(
      format(messages.resultSchemaViolation, {
        tool: toolName,
        violations: violations.join("; "),
      }),
    );
  }
  return value;
}

// ── 明文 key 脱敏 ───────────────────────────────────────────────────────────

/** provider key 形状：`sk-…`/`ark-…`/`ghp-…` 一类「短前缀 + 长随机串」。
 *
 *  为什么额外要求随机串里至少有一个数字或大写字母：真实 key 是随机 base62（32 位
 *  纯小写的概率约 1e-12），而审查输出里的 kebab 小写长串几乎只可能是文件路径
 *  （`src/my-super-long-directory-name/index.ts`）。少了这道约束，session/delegate
 *  透传出的路径会被抹成 ***REDACTED***，模型拿不到可行动的位置信息。 */
const STANDALONE_KEY =
  /\b[A-Za-z]{2,5}-(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{20,}\b/gu;
/** `Authorization: Bearer xxx` / `bearer xxx`。
 *
 *  字符集写 `[a-z…]` 而不是 `[A-Za-z…]`：本条带 `i` 旗标，`a-z` 在大小写不敏感下
 *  已同时匹配 `A-Z`——再并列一枚 `A-Z` 是同一个字符集抄两遍（sonarjs 判为字符类内重复），
 *  删掉重复的那一位，匹配语言不变。 */
const BEARER_VALUE = /(?<scheme>\bbearer\s+)[a-z0-9._~+/=-]{12,}/giu;
/** `api_key: "xxx"`、`apiKey=xxx`、`token: xxx`、`x-api-key: xxx` 等赋值形态。 */
const KEY_ASSIGNMENT =
  /(?<name>\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|password|token)["'\s]*[:=]["'\s]*)[^\s"',;)}\]]{6,}/giu;
const REDACTION = "***REDACTED***";

/**
 * 抹掉文本里 key 形状的片段。
 *
 * 为什么需要：OCR 会把 provider 配置错误连同请求头/端点整段回显到 stderr，
 * `ocr llm test` 的输出又直通设置卡片；工具错误文本还会被持久化进会话日志
 * （session log），一次回显就等于把明文 key 写进了长期存储。本插件的既定
 * 决策是「key 绝不落盘、绝不过 HTTP」，故所有原始输出出口都必须过这道闸
 * （harness 同方向的红线见 packages/settings/settings/src/redact.ts）。
 *
 * 只做「形态匹配」替换：赋值/Bearer 形态一律从严（宁可多抹），独立 key 形态则
 * 要求随机串特征，避免把要交给模型的文件路径一起抹掉。
 */
export function redactKeyMaterial(text: string): string {
  return text
    .replaceAll(BEARER_VALUE, `$<scheme>${REDACTION}`)
    .replaceAll(KEY_ASSIGNMENT, `$<name>${REDACTION}`)
    .replaceAll(STANDALONE_KEY, REDACTION);
}
