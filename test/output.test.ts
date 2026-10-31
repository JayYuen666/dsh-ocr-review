// output.ts 守卫回归测试：一次回归（{ text, parsed } / { text, raw }
// 触发 harness INVALID_TOOL_OUTPUT，整次 OCR 结果被丢）的钉死用例，以及明文 key
// 脱敏闸（OCR stderr 会整段回显 provider 配置）。
// 守卫现校验「canonical 值命中该工具自己的 output schema」：本文件用
// 合成 schema 把迷你校验器的每个分支点亮；真实 schema 的全流程由 host.test.ts 覆盖
// （每次 execute 都在 define() 出口过一遍守卫）。
import { describe, expect, it } from "vitest";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { assertToolOutput, redactKeyMaterial, stripAnsi } from "../lib/output.ts";
import { MESSAGES } from "../lib/messages.ts";
import type { OcrReviewMessages } from "../lib/messages.ts";

const { zh } = MESSAGES;

/** 注入文案后的守卫（host 走的是同一份中文消息表）。 */
const guardOf = (
  value: unknown,
  schema: JsonSchemaNode,
  tool = "review",
  messages: OcrReviewMessages = zh,
): unknown => assertToolOutput(schema, value, tool, messages);

describe("assertToolOutput", () => {
  /** 与旧 TEXT_OUTPUT_SCHEMA 同款的最小对象 schema（回归钉：多带一个字段就红）。 */
  const objectSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  } satisfies JsonSchemaNode;

  it("命中 schema 的 canonical 值原样通过（对象与字符串分支都不改写）", () => {
    const value = { text: "ok" };
    expect(guardOf(value, objectSchema)).toBe(value);
    const stringSchema = { type: "string" } satisfies JsonSchemaNode;
    expect(guardOf("plain", stringSchema)).toBe("plain");
  });

  it("拒绝 schema 外字段（回归：text + parsed / text + raw）", () => {
    expect(() => guardOf({ text: "x", parsed: {} }, objectSchema, "scan")).toThrow(
      /ocr scan: 返回值不符合该工具的 output schema：result: fields outside the schema: parsed/u,
    );
    expect(() => guardOf({ text: "x", raw: "y" }, objectSchema, "delegate_preview")).toThrow(
      /fields outside the schema: raw/u,
    );
    // properties 用对象字面量承载：若判定退化成 `key in properties` 或 `properties[key]`，
    // constructor / toString 会沿原型链被当成已声明字段而静默放行。
    expect(() => guardOf({ text: "x", constructor: 1 }, objectSchema)).toThrow(
      /fields outside the schema: constructor/u,
    );
    expect(() => guardOf({ text: "x", toString: "y" }, objectSchema)).toThrow(
      /fields outside the schema: toString/u,
    );
  });

  it("对象分支：非对象、缺必填、键在值 undefined、嵌套字段违规各一条", () => {
    expect(() => guardOf("plain string", objectSchema)).toThrow(/result: expected object/u);
    expect(() => guardOf(["a"], objectSchema)).toThrow(/result: expected object/u);
    expect(() => guardOf({}, objectSchema)).toThrow(/missing required field text/u);
    // 与官方同口径：键在但值是 undefined 同样算缺必填（JSON 里本就存不下 undefined）。
    expect(() => guardOf({ text: undefined }, objectSchema)).toThrow(
      /missing required field text/u,
    );
    expect(() => guardOf({ text: 42 }, objectSchema)).toThrow(/result\.text: expected string/u);
  });

  it("无 required / 无 additionalProperties 的开放对象放行（byCategory 同款）", () => {
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
    } satisfies JsonSchemaNode;
    expect(guardOf({ a: "x", extra: 1 }, open)).toStrictEqual({ a: "x", extra: 1 });
  });

  it("数组分支：非数组、无 items 放行、元素违规一次列全", () => {
    const strings = { type: "array", items: { type: "string" } } satisfies JsonSchemaNode;
    expect(() => guardOf("nope", strings)).toThrow(/result: expected array/u);
    const anyItems = { type: "array" } satisfies JsonSchemaNode;
    expect(guardOf([1, "x", null], anyItems)).toStrictEqual([1, "x", null]);
    expect(() => guardOf(["a", 2, "b", 4], strings)).toThrow(
      /result\[1\]: expected string; result\[3\]: expected string/u,
    );
  });

  it("违规超过 20 条 ⇒ 截断并标出省略条数", () => {
    // 一次跑出 25 条违规：只列前 20 条，尾部注明还剩几条，否则失败消息本身就能把
    // 整张结果表撑爆。
    const strings = { type: "array", items: { type: "string" } } satisfies JsonSchemaNode;
    const many = Array.from({ length: 25 }, (_unused, index) => index);
    expect(() => guardOf(many, strings)).toThrow(/…\(\+5\)/u);
    // 清单会进 session log：字段名里的 key 形态必须先抹掉，整条消息还要按字符上限截断。
    expect(() =>
      guardOf({ text: "x", "sk-live-abcdefghijklmnopqrstuvwx012345": 1 }, objectSchema),
    ).toThrow(/fields outside the schema: \*\*\*REDACTED\*\*\*/u);
    let detail = "";
    try {
      guardOf({ text: "x", ["a".repeat(5000)]: 1 }, objectSchema);
    } catch (error) {
      const { message } = error as Error;
      detail = message;
    }
    expect(detail, "超长字段名该被截断").toContain("fields outside the schema");
    expect(detail.length).toBeLessThan(3000);
  });

  it("多余字段名单最多列 10 个，其余只计省略数", () => {
    const closed = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    } satisfies JsonSchemaNode;
    const extra = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [`extra${String(index)}`, index]),
    );
    expect(() => guardOf({ text: "x", ...extra }, closed)).toThrow(
      /fields outside the schema: extra0, extra1, extra2, extra3, extra4, extra5, extra6, extra7, extra8, extra9 …\(\+2\)/u,
    );
  });

  it("标量分支：number 须有限、integer 须整数、boolean/null 各自点名", () => {
    expect(() => guardOf("x", { type: "number" })).toThrow(/result: expected number/u);
    expect(() => guardOf(Number.NaN, { type: "number" })).toThrow(/expected number/u);
    expect(() => guardOf(4.2, { type: "integer" })).toThrow(/result: expected integer/u);
    expect(() => guardOf(1, { type: "boolean" })).toThrow(/result: expected boolean/u);
    expect(() => guardOf("null", { type: "null" })).toThrow(/result: expected null/u);
    expect(guardOf(null, { type: "null" })).toBeNull();
  });

  it("const / enum：标量级闸，命中放行、偏离点名允许值", () => {
    const constSchema = { type: "string", const: "background" } satisfies JsonSchemaNode;
    expect(guardOf("background", constSchema)).toBe("background");
    expect(() => guardOf("foreground", constSchema)).toThrow(
      /result: must be exactly "background"/u,
    );
    const enumSchema = {
      type: "string",
      enum: ["running", "completed", "killed"],
    } satisfies JsonSchemaNode;
    expect(guardOf("running", enumSchema)).toBe("running");
    expect(() => guardOf("zombie", enumSchema)).toThrow(
      /result: must be one of "running"\/"completed"\/"killed"/u,
    );
  });

  it("无约束节点（官方子集的「任意 JSON 值」）放行任何值", () => {
    expect(guardOf(42, {})).toBe(42);
    expect(guardOf({ nested: ["a"] }, {})).toStrictEqual({ nested: ["a"] });
  });

  it("oneOf：零命中与多命中都判违规，恰好一支命中才放行", () => {
    const nullable = { oneOf: [{ type: "string" }, { type: "null" }] } satisfies JsonSchemaNode;
    expect(guardOf("s", nullable)).toBe("s");
    expect(guardOf(null, nullable)).toBeNull();
    expect(() => guardOf(42, nullable)).toThrow(/result: matched 0 of 2 oneOf branches/u);
    // 同级关键字是合取：oneOf 命中不等于 const 被豁免（在分支里 return 会静默放过）。
    const gated = {
      const: "a",
      oneOf: [{ type: "string" }, { type: "null" }],
    } satisfies JsonSchemaNode;
    expect(() => guardOf("b", gated)).toThrow(/result: must be exactly "a"/u);
    const everything = { oneOf: [{}, {}] } satisfies JsonSchemaNode;
    expect(() => guardOf(42, everything)).toThrow(/matched 2 of 2 oneOf branches/u);
  });

  it("子集外关键字当场抛错（递归到 properties/items/oneOf），不静默放过", () => {
    // 故意的坏 schema：satisfies 会在编译期拦下子集外关键字，所以这里以变量 +
    // as JsonSchemaNode 注入（测的正是「运行期来了一个守卫不认识的关键字」）。
    const withMinLength: Record<string, unknown> = { type: "string", minLength: 3 };
    expect(() => guardOf("x", withMinLength as JsonSchemaNode)).toThrow(
      /ocr review: 返回形态守卫不支持 output schema 关键字 minLength/u,
    );
    const withFormat: Record<string, unknown> = {
      type: "object",
      properties: { a: { type: "string", format: "path" } },
    };
    expect(() => guardOf({ a: "x" }, withFormat as JsonSchemaNode)).toThrow(/关键字 format/u);
    const withPattern: Record<string, unknown> = {
      type: "array",
      items: { type: "string", pattern: "x" },
    };
    expect(() => guardOf(["x"], withPattern as JsonSchemaNode)).toThrow(/关键字 pattern/u);
    // 两支起（官方子集要求 oneOf 至少两项）：这一条测的是「递归进分支后仍能发现子集外
    // 关键字」，所以不能靠列表长度先被拦下。
    const nestedOneOf: Record<string, unknown> = {
      oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    };
    expect(() => guardOf("x", nestedOneOf as JsonSchemaNode)).toThrow(/关键字 minLength/u);
  });

  it("违规条目极多时不靠展开成实参：几十万条也只报一条可读结论，不抛 RangeError", () => {
    // 全量评论一起不合形态（maxComments=0 时是常态）能产出几十万条违规。`push(...子结果)`
    // 会一次性把每条都压进调用栈实参，`RangeError: Maximum call stack size exceeded`
    // 顶掉本来的「不合形态」结论——而这个函数正是要在那种时刻给出结论的地方。
    const arraySchema = { type: "array", items: { type: "string" } };
    const many = Array.from({ length: 200_000 }).fill(1);
    expect(() => guardOf(many, arraySchema as JsonSchemaNode)).toThrow(
      /result\[0\]: expected string/u,
    );
  });

  it("schema 的取值形态也查：type 写成数组、enum 写成字符串、oneOf 不足两支都当场抛", () => {
    // 只查键名时这些写法会走到与官方子集无关的分支：`type: ["string","null"]` 让
    // scalarMismatch 走最后一支（null 放行、string 反被判违规），`enum: "abc"` 变成
    // 子串匹配且非字符串值抛 `map is not a function`。这些都是插件自己的代码写错，
    // 必须在 schema 面炸掉，而不是继续拿错误的判据去判模型的数据。
    const typeArray: Record<string, unknown> = { type: ["string", "null"] };
    expect(() => guardOf("x", typeArray as JsonSchemaNode)).toThrow(/type 必须是单个类型名/u);
    const enumString: Record<string, unknown> = { type: "string", enum: "abc" };
    expect(() => guardOf("cd", enumString as JsonSchemaNode)).toThrow(
      /enum 必须是非空的 JSON 标量/u,
    );
    const enumObjects: Record<string, unknown> = {
      type: "object",
      enum: [{ first: 1 }, { second: 2 }],
    };
    expect(() => guardOf({ key: 1 }, enumObjects as JsonSchemaNode)).toThrow(
      /enum 必须是非空的 JSON 标量/u,
    );
    const enumNumbers: Record<string, unknown> = { type: "number", enum: [1, 2] };
    expect(() => guardOf(1, enumNumbers as JsonSchemaNode)).not.toThrow();
    const enumNonFinite: Record<string, unknown> = {
      type: "number",
      enum: [Number.POSITIVE_INFINITY],
    };
    expect(() => guardOf(1, enumNonFinite as JsonSchemaNode)).toThrow(
      /enum 必须是非空的 JSON 标量/u,
    );
    const objectConst: Record<string, unknown> = { type: "object", const: { a: 1 } };
    expect(() => guardOf({ a: 1 }, objectConst as JsonSchemaNode)).toThrow(
      /const 必须是 JSON 标量/u,
    );
    const shortOneOf: Record<string, unknown> = { oneOf: [{ type: "string" }] };
    expect(() => guardOf("x", shortOneOf as JsonSchemaNode)).toThrow(/oneOf 必须是至少两项/u);
    // type 与 oneOf 可以同时声明：关键词是合取关系（官方同语义），命中一支不等于 type 被豁免。
    const bothTypeAndOneOf: Record<string, unknown> = {
      type: "string",
      oneOf: [{ type: "string" }, { type: "null" }],
    };
    expect(() => guardOf("x", bothTypeAndOneOf as JsonSchemaNode)).not.toThrow();
    expect(() => guardOf(42, bothTypeAndOneOf as JsonSchemaNode)).toThrow(
      /matched 0 of 2 oneOf branches/u,
    );
  });

  it("容器关键字的取值形态也查：数组 properties / 字符串 required / 元组 items 都当场抛", () => {
    // 只查标量关键字时，这几种写法会让走查器丢掉整条约束（数组 properties 把下标当字段名、
    // 字符串 required 逐字符迭代、对象 additionalProperties 与 === false 恒不相等），
    // 失效方向是静默放行——与 type/enum 写错同一类。
    const propsArray: Record<string, unknown> = {
      type: "object",
      properties: [{ type: "string" }],
    };
    expect(() => guardOf({}, propsArray as JsonSchemaNode)).toThrow(
      /properties 必须是字段名的对象/u,
    );
    const requiredString: Record<string, unknown> = { type: "object", required: "text" };
    expect(() => guardOf({}, requiredString as JsonSchemaNode)).toThrow(
      /required 必须是字段名数组/u,
    );
    const additionalNumber: Record<string, unknown> = { type: "object", additionalProperties: 5 };
    expect(() => guardOf({}, additionalNumber as JsonSchemaNode)).toThrow(
      /additionalProperties 必须是布尔或子 schema/u,
    );
    const tupleItems: Record<string, unknown> = { type: "array", items: [{ type: "string" }] };
    expect(() => guardOf([], tupleItems as JsonSchemaNode)).toThrow(/items 必须是单个子 schema/u);
    const missingType: Record<string, unknown> = { properties: { a: { type: "string" } } };
    expect(() => guardOf({}, missingType as JsonSchemaNode)).toThrow(/必须同时声明 type/u);
    // 反例的另一侧：additionalProperties 写成子 schema 是合法形态，且必须递归检查。
    const nestedUnsupported: Record<string, unknown> = {
      type: "object",
      additionalProperties: { type: "string", minLength: 1 },
    };
    expect(() => guardOf({}, nestedUnsupported as JsonSchemaNode)).toThrow(
      /不支持 output schema 关键字 minLength/u,
    );
  });

  it("违规与不支持说明随注入的文案切换（en）", () => {
    expect(() => guardOf("plain", objectSchema, "review", MESSAGES.en)).toThrow(
      "ocr review: the tool result does not match its output schema: result: expected object",
    );
    const withMinLength: Record<string, unknown> = { type: "string", minLength: 3 };
    expect(() => guardOf(42, withMinLength as JsonSchemaNode, "scan", MESSAGES.en)).toThrow(
      "ocr scan: the result guard does not support the output schema keyword minLength (plugin bug: the keyword subset in lib/output.ts lags the schema)",
    );
  });
});

describe("redactKeyMaterial", () => {
  it("独立 key 形态（sk-/ark-/大写前缀）一律抹掉", () => {
    expect(redactKeyMaterial("invalid key sk-abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "invalid key ***REDACTED***",
    );
    expect(redactKeyMaterial("ark-1a2b3c4d5e6f7g8h9i0j111213141516 rejected")).toBe(
      "***REDACTED*** rejected",
    );
    expect(redactKeyMaterial("SK-AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBe("***REDACTED***");
  });

  it("环境变量写法（`_` 紧贴键名）也必须抹：`\b` 在 `_` 之后不成立，曾是漏网的最大一块", () => {
    // `_` 属 \w，`DEEPSEEK_API_KEY=` 的 `KEY` 前那个位置不是词边界。少了这条，最常见的
    // 环境变量形态整条失配，而它恰恰是 provider 配置错误时 OCR 回显的形态。
    expect(redactKeyMaterial("DEEPSEEK_API_KEY=sk-live-abcdefghijklmnop")).toBe(
      "DEEPSEEK_API_KEY=***REDACTED***",
    );
    expect(redactKeyMaterial("DB_PASSWORD=hunter2hunter2")).toBe("DB_PASSWORD=***REDACTED***");
    expect(redactKeyMaterial("export OPENAI_API_KEY=abcdef1234567890abcdef")).toBe(
      "export OPENAI_API_KEY=***REDACTED***",
    );
  });

  it("github 系 token 的下划线形态（ghp_ / github_pat_）抹掉，且不误伤带下划线的散文", () => {
    // STANDALONE_KEY 要求「字母前缀 + 连字符」分界，这类值里没有连字符；单列一条而不是
    // 放宽 STANDALONE_KEY 的连字符要求，是为了不连带把 kebab 小写路径抹掉。
    expect(redactKeyMaterial("GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(
      "GITHUB_TOKEN=***REDACTED***",
    );
    expect(redactKeyMaterial("saw ghp_16C7e42F292c6912E7710c838347Ae178B4a in stderr")).toBe(
      "saw ***REDACTED*** in stderr",
    );
    expect(redactKeyMaterial("pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop")).toBe(
      "pat ***REDACTED***",
    );
    const prose = "db_user_password_column and password_policy are unrelated words";
    expect(redactKeyMaterial(prose)).toBe(prose);
  });

  it("赋值与 Bearer 形态：只抹值、保留键名供排障", () => {
    expect(redactKeyMaterial('failed with "api_key": "sk-notvisible1234567890abc" in config')).toBe(
      'failed with "api_key": "***REDACTED***" in config',
    );
    expect(redactKeyMaterial("Authorization: Bearer Ab3dEfGhIjKlMnOpQrStUv")).toBe(
      "Authorization: Bearer ***REDACTED***",
    );
    expect(redactKeyMaterial("bearer abcdefghijklmnop0123")).toBe("bearer ***REDACTED***");
    expect(redactKeyMaterial("token: ghp_abcdefghijklmnopqrstuvwxyz1234")).toBe(
      "token: ***REDACTED***",
    );
  });

  it("不把要交给模型的文件路径与散文一起抹掉（脱敏必须可定位）", () => {
    const paths =
      "check src/components/my-super-long-directory-name-here/config.ts and packages/plugin-hot-reload/src";
    expect(redactKeyMaterial(paths)).toBe(paths);
    const prose = "the api_key field is missing; token count 1234567890 in max_tokens=12000";
    expect(redactKeyMaterial(prose)).toBe(prose);
  });

  it("路径分隔符两侧的段不抹：拍平后含大写组件的仓库路径段（session file_path）保持可定位", () => {
    // ocr session list 的 file_path 形如
    //   /Users/…/sessions/Users-yuanjiang-Documents-dsh-plugins-dsh-zvec-grep/<uuid>.jsonl
    // 段里的 `Documents` 大写曾让它过掉「数字或大写」护栏、整段被抹成 ***REDACTED***，
    // 首条 session 因此读不出可 --resume 的位置（uuid 段以数字开头、本来就不命中）。
    const filePath =
      "/Users/yuanjiang/.opencodereview/sessions/Users-yuanjiang-Documents-dsh-plugins-dsh-zvec-grep/5aced024-7dd4-4ce7-8386-b28bc4606ec0.jsonl";
    expect(redactKeyMaterial(`{"file_path": "${filePath}"}`)).toBe(`{"file_path": "${filePath}"}`);
    // 同形状的 token 不在斜杠两侧时仍是 key：上下文豁免不许把脱敏本体放宽。
    expect(redactKeyMaterial("leaked Users-yuanjiang-Documents-dsh-plugins-key")).toBe(
      "leaked ***REDACTED***",
    );
  });

  it("已知凭据前缀嵌在路径分隔符之间也照抹：路径豁免不替裸 key 开口", () => {
    expect(redactKeyMaterial("/logs/sk-AbCdEfGhIjKlMnOpQrStUv/line")).toBe(
      "/logs/***REDACTED***/line",
    );
    expect(redactKeyMaterial(String.raw`\cache\ark-1a2b3c4d5e6f7g8h9i0j111213141516\x`)).toBe(
      String.raw`\cache\***REDACTED***\x`,
    );
  });

  it("无空格的小写长 run 不随长度平方放大（脱敏同步跑在宿主事件循环上）", () => {
    // 上限取 `stdoutMaxBytes` 的默认档 400_000：失败详情与 llm test 回执都吃这一档，
    // 而脱敏排在截断之前（先截会把 key 切半、剩下半截全小写就不再命中这条规则）。
    // 2 秒是独立写死的判据，不是量出来的余量：坏写法（把「run 里有数字或大写」写成前瞻）
    // 在本机实测 51 秒，好写法 1.3 毫秒，差四个数量级，不存在擦边。
    const input = "aa-a".repeat(100_000);
    const started = performance.now();
    expect(redactKeyMaterial(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("stripAnsi", () => {
  it("上游那句升级提示里的颜色码被剥掉，要复制的命令本身留着", () => {
    // 这两句是 launcher 硬编码打到 stderr 的真实形状（`--color never` 管不到它：那句在
    // JS 包装层打印，Go 侧的旗标还没生效）。
    const nudge =
      "\u001B[33m[ocr] A new version (v1.13.3) is available. Run to update:\u001B[0m\n" +
      "\u001B[33m  npm i -g @alibaba-group/open-code-review@1.13.3\u001B[0m\n";
    expect(stripAnsi(nudge)).toBe(
      "[ocr] A new version (v1.13.3) is available. Run to update:\n" +
        "  npm i -g @alibaba-group/open-code-review@1.13.3\n",
    );
  });

  it("没有 ESC 前缀的方括号文本一个字符都不动（宁可漏剥也不误伤）", () => {
    const plain = "[33m npm i -g pkg@1.2.3 [0m 与 [ERROR] binary not found";
    expect(stripAnsi(plain)).toBe(plain);
    expect(stripAnsi("")).toBe("");
  });

  it("除 SGR 之外的 CSI 序列同样算控制序列（清行、光标位都不该进浏览器）", () => {
    expect(stripAnsi("a\u001B[2Kb\u001B[1;32mc\u001B[0md")).toBe("abcd");
  });

  it("osc / DCS 与单字符 ESC 序列同样剥掉（标题、超链接、设备控制不留字节）", () => {
    // OSC 以 BEL 收尾：改窗口标题/超链接会走这一档。
    expect(stripAnsi("a\u001B]0;title\u0007b")).toBe("ab");
    // OSC 以 ST（ESC \）收尾。
    expect(stripAnsi("a\u001B]8;;https://example.com\u001B\\b")).toBe("ab");
    // DCS：ESC P … ST。
    expect(stripAnsi("a\u001BPqdata\u001B\\b")).toBe("ab");
    // 单字符 ESC 序列（如 ESC c 重置终端）。
    expect(stripAnsi("a\u001Bcb")).toBe("ab");
  });
});
