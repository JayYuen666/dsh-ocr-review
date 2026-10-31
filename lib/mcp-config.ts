// MCP 管理面的配置读写：卡片把用户编辑的 `mcp_servers` 写进外部 ocr CLI 的
// config.json。它**不是模型工具**——stdio server 会执行命令，只有设置卡的管理动作
// 可以改它。
//
// 写侧与 provider 选择共用同一条纪律：严格读（读不动就中止，不把 EACCES 当空文档）、
// 锁内改、原子写；只改 `mcp_servers` 这一支，其余 providers/keys/language 原样保留。

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import {
  parseExistingConfig,
  readExistingText,
  updateConfigLocked,
  writeConfigAtomic,
} from "./config-store.ts";

/** 整体上限：MCP 配置是一份人工维护的小表，不承载大文件。 */
const MCP_MAX_BYTES = 64 * 1024;

/**
 * remote MCP server 的 url 只认 http(s)，且必须解析得出一台主机。
 * 前缀匹配（旧实现）会放行 "http://" 这种没有主机的串——写进配置时不报错，OCR 到连接时才炸，
 * 报错点离用户动作很远，所以在这里用 URL 解析判它。
 */
function isHttpServerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}
const MCP_MAX_SERVERS = 100;
const MCP_MAX_ARRAY = 100;
const MCP_MAX_TEXT = 4096;
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "command",
  "args",
  "url",
  "headers",
  "tools",
  "setup",
  "env",
]);

export type McpReadResult =
  | { readonly ok: true; readonly json: string; readonly revision: string }
  | { readonly ok: false; readonly error: string };

export type McpSaveResult =
  | { readonly ok: true; readonly count: number; readonly revision: string }
  | { readonly ok: false; readonly error: string };

/**
 * `mcp_servers` 这一支的摘要，读侧交给卡片、写侧在锁内重算后比对。
 *
 * 只覆盖 `mcp_servers`：保存本来也只改这一支，`providers`/keys 等由别的动作维护，把它们
 * 算进基线会让「改了别处」也变成保存冲突。取值用 `JSON.stringify` 的紧凑形态——两侧都由
 * 同一份文本解析而来，键序一致，摘要可直接逐字节比较。
 *
 * @param servers - 从 config.json 解析出的 `mcp_servers`（缺省按空表）
 * @returns sha256 十六进制摘要
 */
export function mcpServersRevision(servers: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(servers)).digest("hex");
}

function failure(
  name: string,
  field: string,
  reason: string,
  messages: OcrReviewMessages,
): { ok: false; error: string } {
  return { ok: false, error: format(messages.mcpServerInvalid, { name, field, reason }) };
}

/**
 * 用 CreateDataProperty 落动态键，再把原型置空。
 *
 * `out[name] = value` 在 name 为 "__proto__" 时走的是 Object.prototype 的 setter：该条目
 * 既不会成为自有属性（写进 config.json 后静默少一条 server），value 还成了 out 的原型。
 * Object.fromEntries 走 CreateDataProperty，__proto__ 会落成普通自有键（实测：hasOwn 为 true、
 * 原型仍是 Object.prototype、JSON.stringify 带上它）；置空原型是让读侧查不到继承成员。
 */
function recordOf<TValue>(entries: [string, TValue][]): Record<string, TValue> {
  const out: Record<string, TValue> = Object.fromEntries(entries);
  Object.setPrototypeOf(out, null);
  return out;
}

function textField(
  value: unknown,
  name: string,
  field: string,
  messages: OcrReviewMessages,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return failure(name, field, "must be a non-empty string", messages);
  }
  const trimmed = value.trim();
  if (trimmed.length > MCP_MAX_TEXT) {
    return failure(name, field, `must be at most ${MCP_MAX_TEXT} characters`, messages);
  }
  return { ok: true, value: trimmed };
}

function stringArray(
  value: unknown,
  name: string,
  field: string,
  messages: OcrReviewMessages,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MCP_MAX_ARRAY) {
    return failure(name, field, `must be an array of at most ${MCP_MAX_ARRAY} items`, messages);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > MCP_MAX_TEXT) {
      return failure(
        name,
        field,
        `items must be strings of at most ${MCP_MAX_TEXT} characters`,
        messages,
      );
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

function headersField(
  value: unknown,
  name: string,
  messages: OcrReviewMessages,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (!isRecord(value) || Object.keys(value).length > 50) {
    return failure(name, "headers", "must be an object of at most 50 string headers", messages);
  }
  const headers: [string, string][] = [];
  for (const [header, raw] of Object.entries(value)) {
    if (header.trim() === "" || typeof raw !== "string" || raw.length > MCP_MAX_TEXT) {
      return failure(
        name,
        `headers.${header}`,
        "must be a non-empty name and a string value",
        messages,
      );
    }
    headers.push([header, raw]);
  }
  return { ok: true, value: recordOf(headers) };
}

type ServerResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function normalizeStdio(
  raw: Record<string, unknown>,
  name: string,
  messages: OcrReviewMessages,
): ServerResult {
  if (raw["url"] !== undefined || raw["headers"] !== undefined) {
    return failure(name, "type", "stdio does not accept url/headers", messages);
  }
  const command = textField(raw["command"], name, "command", messages);
  if (!command.ok) {
    return command;
  }
  const entry: Record<string, unknown> = { type: "stdio", command: command.value };
  if (raw["args"] !== undefined) {
    const args = stringArray(raw["args"], name, "args", messages);
    if (!args.ok) {
      return args;
    }
    entry["args"] = args.value;
  }
  if (raw["env"] !== undefined) {
    const env = stringArray(raw["env"], name, "env", messages);
    if (!env.ok) {
      return env;
    }
    if (env.value.some((item) => !item.includes("="))) {
      return failure(name, "env", "items must be KEY=VALUE", messages);
    }
    entry["env"] = env.value;
  }
  if (raw["setup"] !== undefined) {
    const setup = textField(raw["setup"], name, "setup", messages);
    if (!setup.ok) {
      return setup;
    }
    entry["setup"] = setup.value;
  }
  return { ok: true, value: entry };
}

function normalizeRemote(
  raw: Record<string, unknown>,
  name: string,
  messages: OcrReviewMessages,
): ServerResult {
  if (
    raw["command"] !== undefined ||
    raw["args"] !== undefined ||
    raw["env"] !== undefined ||
    raw["setup"] !== undefined
  ) {
    return failure(name, "type", "remote does not accept command/args/env/setup", messages);
  }
  const url = textField(raw["url"], name, "url", messages);
  if (!url.ok) {
    return url;
  }
  if (!isHttpServerUrl(url.value)) {
    return failure(name, "url", "must be a valid http:// or https:// URL with a host", messages);
  }
  const entry: Record<string, unknown> = { type: "remote", url: url.value };
  if (raw["headers"] !== undefined) {
    const headers = headersField(raw["headers"], name, messages);
    if (!headers.ok) {
      return headers;
    }
    entry["headers"] = headers.value;
  }
  return { ok: true, value: entry };
}

/**
 * 单个 server 条目 → 只含已知字段的普通对象。
 *
 * 未知字段默认拒绝（避免写出 OCR 不认的配置），但**盘上同一条目已有的未知字段会原样接回**：
 * OCR 自己的 MCPServerConfig 带 unknownJSONFields 契约（读进来不认识的键在来回写时留着），
 * 手写或新版写下的字段在这里丢掉，等于用户改一个字段就静默删掉另一个。
 * 判据是「基线里出现过这个键」——新条目里出现未知键仍判非法，否则一次拼错会被写成 OCR 忽略的键。
 */
/**
 * 未知字段的保留判据（理由见 normalizeServer 的 JSDoc）。
 */
function preservedFieldsOf(
  name: string,
  raw: Record<string, unknown>,
  baseline: unknown,
  messages: OcrReviewMessages,
): { ok: true; value: [string, unknown][] } | { ok: false; error: string } {
  const preserved: [string, unknown][] = [];
  for (const field of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(field)) {
      // baseline === undefined 是写盘前的形状校验：那时还没读盘，未知字段先放过，
      // 由锁内那次带基线的整形决定它们能不能留下。
      if (baseline !== undefined && !(isRecord(baseline) && Object.hasOwn(baseline, field))) {
        return failure(name, field, "is not a supported MCP field", messages);
      }
      preserved.push([field, raw[field]]);
    }
  }
  return { ok: true, value: preserved };
}

function normalizeServer(
  name: string,
  raw: unknown,
  messages: OcrReviewMessages,
  baseline: unknown,
): ServerResult {
  if (!isRecord(raw)) {
    return failure(name, "entry", "must be an object", messages);
  }
  const preservedFields = preservedFieldsOf(name, raw, baseline, messages);
  if (!preservedFields.ok) {
    return preservedFields;
  }
  const preserved = preservedFields.value;
  const type = raw["type"] === undefined ? "stdio" : raw["type"];
  if (type !== "stdio" && type !== "remote") {
    return failure(name, "type", "must be stdio or remote", messages);
  }
  const base =
    type === "stdio" ? normalizeStdio(raw, name, messages) : normalizeRemote(raw, name, messages);
  if (!base.ok) {
    return base;
  }
  if (raw["tools"] !== undefined) {
    const tools = stringArray(raw["tools"], name, "tools", messages);
    if (!tools.ok) {
      return tools;
    }
    base.value["tools"] = tools.value;
  }
  for (const [field, value] of preserved) {
    base.value[field] = value;
  }
  return base;
}

function normalizeServers(
  raw: unknown,
  messages: OcrReviewMessages,
  baseline?: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: messages.mcpShapeInvalid };
  }
  const names = Object.keys(raw);
  if (names.length > MCP_MAX_SERVERS) {
    return {
      ok: false,
      error: format(messages.mcpTooManyServers, { limit: String(MCP_MAX_SERVERS) }),
    };
  }
  const entries: [string, unknown][] = [];
  for (const name of names) {
    if (name.trim() === "" || name.includes("\u0000") || name.length > 64) {
      return failure(name, "name", "must be a non-empty key of at most 64 characters", messages);
    }
    // 严格模式（锁内）下，盘上没有的条目也要给一个空基线：它的未知字段一样非法。
    const entryBaseline = baseline === undefined ? undefined : (baseline[name] ?? {});
    const parsed = normalizeServer(name, raw[name], messages, entryBaseline);
    if (!parsed.ok) {
      return parsed;
    }
    entries.push([name, parsed.value]);
  }
  return { ok: true, value: recordOf(entries) };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

/**
 * 读当前 `mcp_servers`，交给卡片编辑；文件不存在按空表处理，坏 JSON/读不动返回可读错误。
 *
 * 读侧是 async 面（卡片端点不该占住事件循环），且**先 stat 再读**：写侧有 MCP_MAX_BYTES
 * 上限，读侧不设闸就等于允许任意大的 config.json 整个进内存。
 */
export async function readMcpServers(
  configPath: string,
  messages: OcrReviewMessages,
): Promise<McpReadResult> {
  let text: string;
  try {
    const stats = await stat(configPath);
    if (stats.size > MCP_MAX_BYTES) {
      return {
        ok: false,
        error: format(messages.mcpJsonTooLarge, { limit: String(MCP_MAX_BYTES) }),
      };
    }
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      return {
        ok: false,
        error: format(messages.mcpReadFailed, { where: configPath, cause: String(error) }),
      };
    }
    text = "";
  }
  if (!text.trim()) {
    return { ok: true, json: "{}", revision: mcpServersRevision({}) };
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseExistingConfig(text, configPath, messages);
  } catch (error) {
    return {
      ok: false,
      error: format(messages.mcpReadFailed, { where: configPath, cause: String(error) }),
    };
  }
  const servers = doc["mcp_servers"];
  if (servers === undefined || servers === null) {
    return { ok: true, json: "{}", revision: mcpServersRevision({}) };
  }
  if (!isRecord(servers)) {
    return { ok: false, error: messages.mcpShapeInvalid };
  }
  return {
    ok: true,
    json: JSON.stringify(servers, null, 2),
    revision: mcpServersRevision(servers),
  };
}

/**
 * 校验并写回 `mcp_servers`；只改这一支，其余配置原样保留。
 *
 * `revision` 是读侧交回的基线：锁内重算盘上这一支的摘要，与基线不一致就整笔拒绝。没有这道
 * 比较时，两张设置卡（或卡片与手工编辑）先后保存，后一笔会把前一笔新增/修改的条目整段覆盖掉，
 * 而两笔各自都「成功」。
 *
 * @param configPath - 目标 config.json
 * @param json - 卡片交回的 `mcp_servers` JSON 文本
 * @param messages - 双语文案
 * @param revision - 读侧交回的摘要；`undefined` 表示调用方没有基线（旧客户端），跳过比较
 * @returns 保存后的条数与新摘要，或拒绝理由
 */
export async function saveMcpServers(
  configPath: string,
  json: string,
  messages: OcrReviewMessages,
  revision?: string,
): Promise<McpSaveResult> {
  if (Buffer.byteLength(json, "utf8") > MCP_MAX_BYTES) {
    return { ok: false, error: format(messages.mcpJsonTooLarge, { limit: String(MCP_MAX_BYTES) }) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: format(messages.mcpJsonInvalid, { cause: String(error) }) };
  }
  // 先把与磁盘无关的形状问题判掉：坏 payload 不必先读一遍盘、也不该被盘上的坏 JSON 挡在
  // 自己的错误信息后面（那一层基线的判断留给锁内）。
  const shaped = normalizeServers(raw, messages);
  if (!shaped.ok) {
    return shaped;
  }
  try {
    return await updateConfigLocked(configPath, async () => {
      const text = readExistingText(configPath, messages);
      const doc = parseExistingConfig(text, configPath, messages);
      const existing = isRecord(doc["mcp_servers"]) ? doc["mcp_servers"] : {};
      // 基线比较必须在锁内：锁外读到的摘要可能已经是别人刚写完的那一版，比了也不代表
      // 「读-改-写」这三步之间没人插进来。
      if (revision !== undefined && mcpServersRevision(existing) !== revision) {
        return { ok: false as const, error: messages.mcpSaveConflict };
      }
      // 未知字段能不能留下取决于盘上同一条目有没有它，而基线只能拿到锁之后读（锁外读到的
      // 可能是别人刚写完的版本）。
      const normalized = normalizeServers(raw, messages, existing);
      if (!normalized.ok) {
        return normalized;
      }
      doc["mcp_servers"] = normalized.value;
      await writeConfigAtomic(configPath, `${JSON.stringify(doc, null, 2)}\n`);
      return {
        ok: true as const,
        count: Object.keys(normalized.value).length,
        revision: mcpServersRevision(normalized.value),
      };
    });
  } catch (error) {
    // 写失败（加锁/读回/落盘）不能用读侧文案：用户会被提示去查一个没坏的读取路径。
    return {
      ok: false,
      error: format(messages.mcpSaveFailed, { where: configPath, cause: String(error) }),
    };
  }
}

/** ChatGPT provider 的配置写入：不写 key，只设 provider 与模型。 */
export async function applyChatGptModel(
  configPath: string,
  model: string,
  messages: OcrReviewMessages,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = model.trim();
  if (trimmed === "" || trimmed.length > 256 || trimmed.includes("\u0000")) {
    return { ok: false, error: messages.chatGptModelRequired };
  }
  try {
    return await updateConfigLocked(configPath, async () => {
      const text = readExistingText(configPath, messages);
      const doc = parseExistingConfig(text, configPath, messages);
      const providersRaw = doc["providers"];
      const entryRaw = isRecord(providersRaw) ? providersRaw["chatgpt"] : undefined;
      // 静默重置成 {} 会把既有的 url / extra_headers / models 等键一起抹掉。providers 在这里
      // 是坏形态时宁可让用户先手工修正，也不替他把半张表丢掉（配置是手可编辑的）。
      if (
        (providersRaw !== undefined && providersRaw !== null && !isRecord(providersRaw)) ||
        (entryRaw !== undefined && entryRaw !== null && !isRecord(entryRaw))
      ) {
        return { ok: false as const, error: messages.chatGptProvidersInvalid };
      }
      const providers = isRecord(providersRaw) ? providersRaw : {};
      const entry = isRecord(entryRaw) ? entryRaw : {};
      delete entry["api_key"];
      delete entry["api_key_cmd"];
      entry["model"] = trimmed;
      providers["chatgpt"] = entry;
      doc["providers"] = providers;
      doc["provider"] = "chatgpt";
      await writeConfigAtomic(configPath, `${JSON.stringify(doc, null, 2)}\n`);
      return { ok: true as const };
    });
  } catch (error) {
    return { ok: false, error: format(messages.chatGptSaveFailed, { cause: String(error) }) };
  }
}
