// output.ts 守卫回归测试：一次回归（{ text, parsed } / { text, raw }
// 触发 harness INVALID_TOOL_OUTPUT，整次 OCR 结果被丢）的钉死用例，以及明文 key
// 脱敏闸（OCR stderr 会整段回显 provider 配置）。
// 守卫现校验「canonical 值命中该工具自己的 output schema」：本文件用
// 合成 schema 把迷你校验器的每个分支点亮；真实 schema 的全流程由 host.test.ts 覆盖
// （每次 execute 都在 define() 出口过一遍守卫）。
import { describe, expect, it } from "vitest";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { assertToolOutput, redactKeyMaterial } from "../lib/output.ts";
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
    const nestedOneOf: Record<string, unknown> = { oneOf: [{ type: "string", minLength: 1 }] };
    expect(() => guardOf("x", nestedOneOf as JsonSchemaNode)).toThrow(/关键字 minLength/u);
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
});
