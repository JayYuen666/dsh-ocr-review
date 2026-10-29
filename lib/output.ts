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
// 而非对象）。本守卫在 define() 出口处用与该工具 output.schema **同一个
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
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

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

/** 官方子集只认这几个标量类型名（`SCHEMA_TYPES`）；`type` 写数组官方直接拒。 */
const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * schema 里的关键字必须全部落在守卫支持的子集内（递归查 oneOf/properties/items），
 * 关键字的**取值形态**也必须合法。
 *
 * 违例抛错而不是当违规值报：schema 是插件自己的代码，错的是代码不是模型的数据。
 *
 * 为什么取值形态也要查：只查键名的话，`type: ["string","null"]` 这种官方子集不认的
 * 写法会让 `scalarMismatch` 走进最后那支 `value !== null`——于是 `null` 放行、字符串
 * 反而判违规，守卫给出的结论与它自己声称支持的子集无关。`enum` 写成字符串同理：
 * 走到 `enum.includes` 时成了子串匹配，非字符串值还会抛 `map is not a function`。
 */
function malformed(toolName: string, detail: string, messages: OcrReviewMessages): Error {
  return new Error(format(messages.resultSchemaMalformed, { tool: toolName, detail }));
}

/** 关键字白名单：守卫只认官方子集，多一个都算插件自己的 schema 写错了。 */
function assertKnownKeywords(
  schema: JsonSchemaNode,
  toolName: string,
  messages: OcrReviewMessages,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(format(messages.resultSchemaUnsupported, { tool: toolName, keyword }));
    }
  }
}

/** `type` 的取值形态：官方明确不接受类型数组，只收单个类型名。 */
function assertTypeShape(type: unknown, toolName: string, messages: OcrReviewMessages): void {
  if (type === undefined) {
    return;
  }
  if (typeof type === "string" && SCHEMA_TYPES.has(type)) {
    return;
  }
  throw malformed(
    toolName,
    `type 必须是单个类型名（${[...SCHEMA_TYPES].join("/")}），收到 ${JSON.stringify(type)}`,
    messages,
  );
}

/** `oneOf` 的取值形态：至少两项的分支数组（单项等价于直接写那个分支，多半是漏写了别的分支）。 */
function assertOneOfShape(oneOf: unknown, toolName: string, messages: OcrReviewMessages): void {
  if (oneOf === undefined) {
    return;
  }
  if (Array.isArray(oneOf) && oneOf.length >= 2) {
    return;
  }
  throw malformed(toolName, "oneOf 必须是至少两项的数组", messages);
}

/** `enum` 的取值形态：非空数组。写成字符串时 `enum.includes` 会退化成子串匹配。 */
function assertEnumShape(enumValues: unknown, toolName: string, messages: OcrReviewMessages): void {
  if (enumValues === undefined) {
    return;
  }
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return;
  }
  throw malformed(toolName, "enum 必须是非空数组", messages);
}

/**
 * schema 里的关键字必须全部落在守卫支持的子集内（递归查 oneOf/properties/items），
 * 关键字的**取值形态**也必须合法。
 *
 * 违例抛错而不是当违规值报：schema 是插件自己的代码，错的是代码不是模型的数据。
 *
 * 为什么取值形态也要查：只查键名的话，`type: ["string","null"]` 这种官方子集不认的
 * 写法会让 `scalarMismatch` 走进最后那支 `value !== null`——于是 `null` 放行、字符串
 * 反而判违规，守卫给出的结论与它自己声称支持的子集无关。`enum` 写成字符串同理：
 * 走到 `enum.includes` 时成了子串匹配，非字符串值还会抛 `map is not a function`。
 */
function assertGuardable(
  schema: JsonSchemaNode,
  toolName: string,
  messages: OcrReviewMessages,
): void {
  assertKnownKeywords(schema, toolName, messages);
  const { type, oneOf, enum: enumValues } = schema;
  if (type !== undefined && oneOf !== undefined) {
    throw malformed(toolName, "type 与 oneOf 不能同时声明", messages);
  }
  assertTypeShape(type, toolName, messages);
  assertOneOfShape(oneOf, toolName, messages);
  assertEnumShape(enumValues, toolName, messages);
  for (const branch of Array.isArray(oneOf) ? oneOf : []) {
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
  // 一律用 Object.hasOwn，而不是 `properties?.[key]` / `key in value`：后者沿原型链
  // 命中继承属性，`constructor`/`toString` 这些键于是取到 Object.prototype 上的成员
  // 而非 undefined，逃过 additionalProperties:false，再以「无约束节点」静默通过递归。
  // 本模块的立身之本是「未声明字段必须抛错」，这两处必须闭合。
  const declared = (key: string): JsonSchemaNode | undefined =>
    properties !== undefined && Object.hasOwn(properties, key) ? properties[key] : undefined;
  if (additionalProperties === false) {
    const extra = Object.keys(value).filter((key) => declared(key) === undefined);
    if (extra.length > 0) {
      return [`${path}: fields outside the schema: ${extra.join(", ")}`];
    }
  }
  for (const key of required ?? []) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      return [`${path}: missing required field ${key}`];
    }
  }
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    const child = declared(key);
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

// ── 明文 key 脱敏 ───────────────────────────────────────────────────────────
// 本块排在走查之前：schema 校验的失败消息出口要用 redactKeyMaterial，而本仓的
// no-use-before-define 不放行「先声明后定义」。

/** provider key 形状：`sk-…`/`ark-…`/`ghp-…` 一类「短前缀 + 长随机串」。
 *
 *  为什么额外要求随机串里至少有一个数字或大写字母：真实 key 是随机 base62（32 位
 *  纯小写的概率约 1e-12），而审查输出里的 kebab 小写长串几乎只可能是文件路径
 *  （`src/my-super-long-directory-name/index.ts`）。少了这道约束，session/delegate
 *  透传出的路径会被抹成 ***REDACTED***，模型拿不到可行动的位置信息。
 *
 *  这道约束写在替换回调里而**不写成前瞻**：`-` 同属前缀与随机串的字符集，一条长 run 里
 *  能嵌套任意多个候选起点，而「run 内是否存在数字或大写」这类前瞻要把后面整段 run 反向
 *  回溯一遍——逐起点相乘就是 O(n²)（实测 400_000 字符 51 秒，正好是 `stdoutMaxBytes`
 *  的默认档）。run 是首个 `-` 之后的那一段：前缀只含字母，故首个 `-` 必是分界。 */
const STANDALONE_KEY = /\b[A-Za-z]{2,5}-[\w-]{20,}\b/gu;
/** `Authorization: <scheme> <value>` / `Proxy-Authorization: …`：认**头名**而不是
 *  枚举认证方案。头名本身就是「后面跟着凭据」的信号，Basic / Token / Digest 乃至
 *  vendor 自定义 scheme 都不会漏；而只认头名还避开了正文里「token based
 *  authentication」这类措辞被误抹。scheme 组连同其后的空白一起捕获，回填时凭据被
 *  替换而 scheme 词保留。 */
const AUTH_HEADER_VALUE =
  /(?<name>\b(?:proxy-)?authorization["'\s]*[:=]["'\s]*)(?<scheme>[a-z][\w-]*[ \t]+)?[^\s"',;)}\]]{4,}/giu;
/** 裸 scheme + 值（没有头名时 OCR 也会整行回显）。scheme 只留 bearer：它在散文中几乎
 *  不出现，而 token / basic 之类会撞上「token count」「basic usage」等普通措辞。 */
const BEARER_VALUE = /(?<scheme>\bbearer[ \t]+)[\w.~+/=-]{4,}/giu;
/** `api_key: "xxx"`、`apiKey=xxx`、`token: xxx`、`x-api-key: xxx` 等赋值形态。
 *  值下限取 4 且容许一个 scheme 词：`token: Basic <base64>` 里赋值形态先能吃到的只是
 *  scheme 词（Basic 恰好 5 字符），下限更高时整条失配，后面那个 base64 就原样进了日志。
 *
 *  左边界用 `(?<![A-Za-z0-9])` 而**不是** `\b`：`_` 也属 `\w`，`DEEPSEEK_API_KEY=` 里
 *  `KEY` 之前的那个位置对 `\b` 不成立，于是最常见的环境变量写法整条失配——而「把
 *  `XXX_API_KEY=…` 抹掉」正是这道闸最该管的一类。
 *
 *  字符类写 `[A-Z0-9]` 而不是 `[A-Za-z0-9]`：这条正则带 `i` 标志，两者等价，
 *  而重复的字符区间会让静态检查报 duplicates-in-character-class。 */
const KEY_ASSIGNMENT =
  /(?<name>(?<![A-Z0-9])(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|password|token)["'\s]*[:=]["'\s]*)(?<scheme>[a-z][\w-]*[ \t]+)?[^\s"',;)}\]]{4,}/giu;
/** GitHub 系 token 的**下划线**形态（`ghp_…`、`github_pat_…`）：STANDALONE_KEY 要求
 *  「字母前缀 + 连字符」分界，这类值里没有连字符，前缀后又紧跟下划线，故单列一条。
 *  不并进 STANDALONE_KEY 是为了不放开那里的连字符要求——那条要求同时承担「别把
 *  kebab 小写路径当 key 抹掉」的职责。 */
const UNDERSCORE_TOKEN = /\b(?:gh[pousr]|github_pat)_\w{20,}\b/gu;
const REDACTION = "***REDACTED***";
/** token 尾部至少一枚非 `-` 的字母/数字。 */
const TOKEN_TAIL_CHARACTER = /[0-9A-Z]/u;

/** 独立 key 形态的替换臂：随机串段里真有数字或大写才抹，否则原样交回（文件路径要保持可读）。
 *  两侧任一是路径分隔符的匹配是路径段而非 key：ocr CLI 会把仓库路径拍平成 kebab 段嵌进
 *  session 的 file_path（`…/sessions/Users-yuanjiang-Documents-…/uuid.jsonl`），原路径里
 *  只要有大写组件（macOS 的 Documents/Desktop 一类）就过得了「数字或大写」那道护栏——
 *  裸 key 从不出现在斜杠两侧，路径段也从不出现在别处，按上下文分比按字符集猜稳。 */
function redactStandaloneKey(match: string, offset: number, whole: string): string {
  const before = whole[offset - 1];
  const after = whole[offset + match.length];
  if (before === "/" || after === "/" || before === "\\" || after === "\\") {
    return match;
  }
  return TOKEN_TAIL_CHARACTER.test(match.slice(match.indexOf("-") + 1)) ? REDACTION : match;
}

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
  // 头名形态排在最前：它连 scheme 词一起捕获，先跑掉就不会被后面的规则拆开。
  return text
    .replaceAll(AUTH_HEADER_VALUE, `$<name>$<scheme>${REDACTION}`)
    .replaceAll(BEARER_VALUE, `$<scheme>${REDACTION}`)
    .replaceAll(KEY_ASSIGNMENT, `$<name>$<scheme>${REDACTION}`)
    .replaceAll(UNDERSCORE_TOKEN, REDACTION)
    .replaceAll(STANDALONE_KEY, redactStandaloneKey);
}

/** ESC 由运行时构造：`eslint(no-control-regex)` 不许控制字符出现在正则字面量里，而这里
 *  必须按真 ESC 匹配——放宽成「匹配 `[33m` 这种文本」会把日志里合法的方括号内容一起吃掉。 */
const ESC = String.fromCodePoint(27);
/** ECMA-48 的 CSI 序列：ESC `[` + 参数位 + 中间位 + 终结位（SGR 颜色码就是终结位 `m`）。 */
const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");

/**
 * 剥掉终端控制序列，只给**要显示给人复制**的那段输出用。
 *
 * 上游 launcher 那句「有新版本，跑这条命令」是硬编码 `console.error("\x1b[33m…")` 打到
 * stderr 的，`--color never` 管不到它（那句在 JS 包装层打印，Go 那侧的旗标还没生效）。
 * 留着这些字节，浏览器里看到的就是 `[33m[ocr] A new version …[0m` 这种噪声，而用户要选中
 * 复制进终端的恰好是那条 `npm i -g …`——复制到的是带控制字符的脏命令。
 */
export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_CSI, "");
}

/** 官方子集的迷你走查（path 限定违规位置，一次列全）。oneOf 语义与官方一致：
 *  恰好一支命中，多支/零支都算违规。 */
function violationsOf(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  // 关键词之间是合取关系（与官方实现一致）：oneOf 命中**不等于**同级的 type/const/enum
  // 被豁免。在 oneOf 分支里直接 return 会把它们一并跳过，于是 `{ const: true,
  // oneOf: [...] }` 这类 schema 的 const 被静默放过——正是文件头警惕的那种
  // 「守卫假装支持却静默放过」。
  const violations: string[] = [];
  const { oneOf } = schema;
  if (oneOf !== undefined) {
    const passing = oneOf.filter((branch) => violationsOf(branch, value, path).length === 0);
    if (passing.length !== 1) {
      violations.push(`${path}: matched ${passing.length} of ${oneOf.length} oneOf branches`);
    }
  }
  const { type } = schema;
  // 逐条 push 而不是 `push(...子结果)`：全量评论一起不合形态时子结果可以是几十万条，
  // 展开成实参要一次性占满调用栈（`RangeError: Maximum call stack size exceeded`），
  // 而这个函数正是用来在那种时刻给出可读结论的。
  if (type === "object") {
    for (const violation of objectViolations(schema, value, path, violationsOf)) {
      violations.push(violation);
    }
  } else if (type === "array") {
    for (const violation of arrayViolations(schema, value, path, violationsOf)) {
      violations.push(violation);
    }
  } else if (type !== undefined && scalarMismatch(type, value)) {
    // type 缺省是官方子集的「无约束」节点：任何 JSON 值都合形态。
    violations.push(`${path}: expected ${type}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path}: must be exactly ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !(schema.enum as readonly unknown[]).includes(value)) {
    violations.push(
      `${path}: must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join("/")}`,
    );
  }
  return violations;
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
    // 违规清单会被宿主持久化进 session log，所以既限量也脱敏：全量评论一起不合形态时
    // `join` 能产出几十万字符（日志膨胀），而清单里的字段名/路径一旦含 key 形状的串，
    // 就等于把凭据写进长期存储。
    const MAX_LISTED = 20;
    const MAX_CHARS = 2000;
    const omitted = violations.length - MAX_LISTED;
    const listed =
      violations.slice(0, MAX_LISTED).join("; ") + (omitted > 0 ? ` …(+${omitted})` : "");
    throw new Error(
      format(messages.resultSchemaViolation, {
        tool: toolName,
        violations: redactKeyMaterial(listed).slice(0, MAX_CHARS),
      }),
    );
  }
  return value;
}
