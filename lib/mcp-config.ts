// MCP 管理面的配置读写：卡片把用户编辑的 `mcp_servers` 写进外部 ocr CLI 的
// config.json。它**不是模型工具**——stdio server 会执行命令，只有设置卡的管理动作
// 可以改它。
//
// 写侧与 provider 选择共用同一条纪律：严格读（读不动就中止，不把 EACCES 当空文档）、
// 锁内改、原子写；只改 `mcp_servers` 这一支，其余 providers/keys/language 原样保留。

import { readFile } from "node:fs/promises";
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

/** remote MCP server 的 url 只认 http(s)。 */
const HTTP_URL = /^https?:\/\//iu;
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
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: string };

export type McpSaveResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string };

function failure(
  name: string,
  field: string,
  reason: string,
  messages: OcrReviewMessages,
): { ok: false; error: string } {
  return { ok: false, error: format(messages.mcpServerInvalid, { name, field, reason }) };
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
  const out: Record<string, string> = {};
  for (const [header, raw] of Object.entries(value)) {
    if (header.trim() === "" || typeof raw !== "string" || raw.length > MCP_MAX_TEXT) {
      return failure(
        name,
        `headers.${header}`,
        "must be a non-empty name and a string value",
        messages,
      );
    }
    out[header] = raw;
  }
  return { ok: true, value: out };
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
  if (!HTTP_URL.test(url.value)) {
    return failure(name, "url", "must start with http:// or https://", messages);
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

/** 单个 server 条目 → 只含已知字段的普通对象；未知字段直接拒绝，避免写出 OCR 不认的配置。 */
function normalizeServer(name: string, raw: unknown, messages: OcrReviewMessages): ServerResult {
  if (!isRecord(raw)) {
    return failure(name, "entry", "must be an object", messages);
  }
  for (const field of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(field)) {
      return failure(name, field, "is not a supported MCP field", messages);
    }
  }
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
  return base;
}

function normalizeServers(
  raw: unknown,
  messages: OcrReviewMessages,
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
  const out: Record<string, unknown> = {};
  for (const name of names) {
    if (name.trim() === "" || name.includes("\u0000") || name.length > 64) {
      return failure(name, "name", "must be a non-empty key of at most 64 characters", messages);
    }
    const parsed = normalizeServer(name, raw[name], messages);
    if (!parsed.ok) {
      return parsed;
    }
    out[name] = parsed.value;
  }
  return { ok: true, value: out };
}

/** 读侧用异步读：卡片端点是 async 面，读大文件时不该占住事件循环。 */
function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

/** 读当前 `mcp_servers`，交给卡片编辑；文件不存在按空表处理，坏 JSON/读不动返回可读错误。 */
export async function readMcpServers(
  configPath: string,
  messages: OcrReviewMessages,
): Promise<McpReadResult> {
  let text: string;
  try {
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
    return { ok: true, json: "{}" };
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
    return { ok: true, json: "{}" };
  }
  if (!isRecord(servers)) {
    return { ok: false, error: messages.mcpShapeInvalid };
  }
  return { ok: true, json: JSON.stringify(servers, null, 2) };
}

/** 校验并写回 `mcp_servers`；只改这一支，其余配置原样保留。 */
export async function saveMcpServers(
  configPath: string,
  json: string,
  messages: OcrReviewMessages,
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
  const normalized = normalizeServers(raw, messages);
  if (!normalized.ok) {
    return normalized;
  }
  try {
    const count = await updateConfigLocked(configPath, async () => {
      const text = readExistingText(configPath, messages);
      const doc = parseExistingConfig(text, configPath, messages);
      doc["mcp_servers"] = normalized.value;
      await writeConfigAtomic(configPath, `${JSON.stringify(doc, null, 2)}\n`);
      return Object.keys(normalized.value).length;
    });
    return { ok: true, count };
  } catch (error) {
    return {
      ok: false,
      error: format(messages.mcpReadFailed, { where: configPath, cause: String(error) }),
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
    await updateConfigLocked(configPath, async () => {
      const text = readExistingText(configPath, messages);
      const doc = parseExistingConfig(text, configPath, messages);
      const providers = isRecord(doc["providers"]) ? doc["providers"] : {};
      const entry = isRecord(providers["chatgpt"]) ? providers["chatgpt"] : {};
      delete entry["api_key"];
      delete entry["api_key_cmd"];
      entry["model"] = trimmed;
      providers["chatgpt"] = entry;
      doc["providers"] = providers;
      doc["provider"] = "chatgpt";
      await writeConfigAtomic(configPath, `${JSON.stringify(doc, null, 2)}\n`);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: format(messages.chatGptSaveFailed, { cause: String(error) }) };
  }
}
