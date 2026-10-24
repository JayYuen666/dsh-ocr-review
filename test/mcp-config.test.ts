// MCP / ChatGPT 管理面配置读写：只测纯配置层（不碰卡片与 Remote）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyChatGptModel, readMcpServers, saveMcpServers } from "../lib/mcp-config.ts";
import { MESSAGES } from "../lib/messages.ts";

const { zh } = MESSAGES;

describe("mcp / chatgpt 配置读写", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocr-mcp-config-"));
  const configPath = path.join(root, "config.json");
  const missingPath = path.join(root, "missing.json");
  const dirPath = path.join(root, "as-directory");

  beforeAll(() => {
    // 目录当文件路径：readExistingText 会抛 EISDIR（不是 ENOENT），用来覆盖“读不动”分支。
    mkdirSync(dirPath, { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("读：文件不存在 ⇒ 空表；有 mcp_servers ⇒ pretty JSON；坏形态 ⇒ 错误", async () => {
    const missing = await readMcpServers(missingPath, zh);
    expect(missing).toStrictEqual({ ok: true, json: "{}" });
    writeFileSync(
      configPath,
      JSON.stringify({ language: "English", mcp_servers: { docs: { command: "npx" } } }),
    );
    const read = await readMcpServers(configPath, zh);
    expect(read).toStrictEqual({
      ok: true,
      json: JSON.stringify({ docs: { command: "npx" } }, null, 2),
    });
    writeFileSync(configPath, "{");
    const badJson = await readMcpServers(configPath, zh);
    expect(badJson.ok).toBe(false);
    writeFileSync(configPath, JSON.stringify({ mcp_servers: [] }));
    const notObject = await readMcpServers(configPath, zh);
    expect(notObject.ok).toBe(false);
    const unreadable = await readMcpServers(dirPath, zh);
    expect(unreadable.ok).toBe(false);
    writeFileSync(configPath, JSON.stringify({ mcp_servers: null }));
    const empty = await readMcpServers(configPath, zh);
    expect(empty).toStrictEqual({ ok: true, json: "{}" });
  });

  it("写：stdio/remote 都通过，只改 mcp_servers 且保留其他配置", async () => {
    writeFileSync(configPath, JSON.stringify({ language: "English", providers: { alpha: {} } }));
    const result = await saveMcpServers(
      configPath,
      JSON.stringify({
        docs: {
          command: "npx",
          args: ["-y", "docs"],
          env: ["A=B"],
          setup: "npm i",
          tools: ["search"],
        },
        remote: { type: "remote", url: "https://mcp.example.com", headers: { Authorization: "x" } },
      }),
      zh,
    );
    expect(result).toStrictEqual({ ok: true, count: 2 });
    const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(written["language"]).toBe("English");
    expect(written["providers"]).toStrictEqual({ alpha: {} });
    expect(Object.keys(written["mcp_servers"] as object).toSorted()).toStrictEqual([
      "docs",
      "remote",
    ]);
  });

  it("写：过大 / 非法 JSON / 顶层非对象 / 条数超限都拒绝", async () => {
    const tooLarge = await saveMcpServers(configPath, "x".repeat(70 * 1024), zh);
    expect(tooLarge.ok).toBe(false);
    const badJson = await saveMcpServers(configPath, "{", zh);
    expect(badJson.ok).toBe(false);
    const notObject = await saveMcpServers(configPath, "[]", zh);
    expect(notObject.ok).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_value, index) => [`s${index}`, { command: "x" }]),
    );
    const tooMany = await saveMcpServers(configPath, JSON.stringify(many), zh);
    expect(tooMany.ok).toBe(false);
  });

  const invalid = [
    ["空名", { "": { command: "x" } }],
    ["未知字段", { server: { command: "x", bogus: 1 } }],
    ["条目非对象", { server: "nope" }],
    ["type 非法", { server: { type: "other", command: "x" } }],
    ["stdio 缺 command", { server: {} }],
    ["command 过长", { server: { command: "x".repeat(5000) } }],
    ["args 非数组", { server: { command: "x", args: "a" } }],
    ["args 元素非字符串", { server: { command: "x", args: [1] } }],
    ["args 过多", { server: { command: "x", args: Array.from({ length: 101 }, () => "a") } }],
    ["args 元素过长", { server: { command: "x", args: ["a".repeat(5000)] } }],
    ["env 缺等号", { server: { command: "x", env: ["A"] } }],
    ["env 非数组", { server: { command: "x", env: "A=B" } }],
    ["setup 为空", { server: { command: "x", setup: " " } }],
    ["tools 非数组", { server: { command: "x", tools: {} } }],
    ["stdio 带 url", { server: { command: "x", url: "https://x" } }],
    ["remote 带 command", { server: { type: "remote", url: "https://x", command: "x" } }],
    ["remote 缺 url", { server: { type: "remote" } }],
    ["remote url 非 http", { server: { type: "remote", url: "ftp://x" } }],
    ["headers 非对象", { server: { type: "remote", url: "https://x", headers: [] } }],
    [
      "headers 值非字符串",
      { server: { type: "remote", url: "https://x", headers: { Authorization: 1 } } },
    ],
    ["headers 名为空", { server: { type: "remote", url: "https://x", headers: { "": "v" } } }],
    [
      "headers 过多",
      {
        server: {
          type: "remote",
          url: "https://x",
          headers: Object.fromEntries(
            Array.from({ length: 51 }, (_value, index) => [`h${index}`, "v"]),
          ),
        },
      },
    ],
  ] as const;

  it.each(invalid)("非法条目：%s ⇒ 拒绝", async (_label, value) => {
    const result = await saveMcpServers(configPath, JSON.stringify(value), zh);
    expect(result.ok).toBe(false);
  });

  it("写盘失败（配置路径是目录）⇒ 拒绝", async () => {
    const result = await saveMcpServers(dirPath, "{}", zh);
    expect(result.ok).toBe(false);
  });

  it("chatGpt：写 provider/model、清掉同条目 key、保留其他配置", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        language: "English",
        custom_providers: { other: { url: "https://x" } },
        providers: { chatgpt: { api_key: "secret", api_key_cmd: "cmd", model: "old" } },
      }),
    );
    const applied = await applyChatGptModel(configPath, "gpt-6", zh);
    expect(applied).toStrictEqual({ ok: true });
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: string;
      language: string;
      custom_providers: Record<string, unknown>;
      providers: { chatgpt: Record<string, unknown> };
    };
    expect(written.provider).toBe("chatgpt");
    expect(written.language).toBe("English");
    expect(written.custom_providers).toStrictEqual({ other: { url: "https://x" } });
    expect(written.providers.chatgpt).toStrictEqual({ model: "gpt-6" });
  });

  it("chatGpt：空模型 / 坏配置 / 写盘失败 ⇒ 可读错误", async () => {
    const emptyModel = await applyChatGptModel(configPath, "  ", zh);
    expect(emptyModel.ok).toBe(false);
    writeFileSync(configPath, "{");
    const badConfig = await applyChatGptModel(configPath, "gpt-6", zh);
    expect(badConfig.ok).toBe(false);
    const writeFailed = await applyChatGptModel(dirPath, "gpt-6", zh);
    expect(writeFailed.ok).toBe(false);
  });
});
