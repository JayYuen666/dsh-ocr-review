// MCP / ChatGPT 管理面配置读写：只测纯配置层（不碰卡片与 Remote）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyChatGptModel,
  mcpServersRevision,
  readMcpServers,
  saveMcpServers,
} from "../lib/mcp-config.ts";
import { MESSAGES } from "../lib/messages.ts";

const { zh } = MESSAGES;
const MCP_URL = "https://mcp.example.com";

describe("mcp / chatgpt 配置读写", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocr-mcp-config-"));
  const configPath = path.join(root, "config.json");
  const missingPath = path.join(root, "missing.json");
  const dirPath = path.join(root, "as-directory");

  beforeAll(() => {
    // 目录当文件路径：readExistingText 会抛 EISDIR（不是 ENOENT），用来覆盖“读不动”分支。
    mkdirSync(dirPath, { recursive: true });
  });

  beforeEach(() => {
    // 每个用例从一份确定盘面开始：拒绝分支要证明「盘上没被改动」，接力上一用例的
    // 内容会让这条断言依赖执行顺序。
    writeFileSync(configPath, "{}");
    rmSync(missingPath, { force: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("读：文件不存在 ⇒ 空表；有 mcp_servers ⇒ pretty JSON；坏形态 ⇒ 错误", async () => {
    const missing = await readMcpServers(missingPath, zh);
    expect(missing).toStrictEqual({
      ok: true,
      json: "{}",
      revision: mcpServersRevision({}),
    });
    writeFileSync(
      configPath,
      JSON.stringify({ language: "English", mcp_servers: { docs: { command: "npx" } } }),
    );
    const read = await readMcpServers(configPath, zh);
    expect(read).toStrictEqual({
      ok: true,
      json: JSON.stringify({ docs: { command: "npx" } }, null, 2),
      revision: mcpServersRevision({ docs: { command: "npx" } }),
    });
    writeFileSync(configPath, "{");
    const badJson = await readMcpServers(configPath, zh);
    expect(badJson.ok).toBe(false);
    expect(badJson.ok ? "" : badJson.error).toContain(configPath);
    writeFileSync(configPath, JSON.stringify({ mcp_servers: [] }));
    const notObject = await readMcpServers(configPath, zh);
    expect(notObject.ok).toBe(false);
    expect(notObject.ok ? "" : notObject.error).toContain("{name: entry}");
    const unreadable = await readMcpServers(dirPath, zh);
    expect(unreadable.ok).toBe(false);
    writeFileSync(configPath, JSON.stringify({ mcp_servers: null }));
    const empty = await readMcpServers(configPath, zh);
    expect(empty).toStrictEqual({ ok: true, json: "{}", revision: mcpServersRevision({}) });
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
        remote: { type: "remote", url: MCP_URL, headers: { Authorization: "x" } },
      }),
      zh,
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.count : 0).toBe(2);
    // 回执带新摘要：卡片保存成功后不必重读，就能拿它做下一笔保存的基线。
    expect(result.ok ? result.revision : "").toHaveLength(64);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(written["language"]).toBe("English");
    expect(written["providers"]).toStrictEqual({ alpha: {} });
    expect(written["mcp_servers"]).toStrictEqual({
      docs: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs"],
        env: ["A=B"],
        setup: "npm i",
        tools: ["search"],
      },
      remote: {
        type: "remote",
        url: MCP_URL,
        headers: { Authorization: "x" },
      },
    });
  });

  it("写：过大 / 非法 JSON / 顶层非对象 / 条数超限都拒绝，且盘面不变", async () => {
    const before = readFileSync(configPath, "utf8");
    const tooLarge = await saveMcpServers(configPath, "x".repeat(64 * 1024 + 1), zh);
    expect(tooLarge.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const badJson = await saveMcpServers(configPath, "{", zh);
    expect(badJson.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const notObject = await saveMcpServers(configPath, "[]", zh);
    expect(notObject.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_value, index) => [`s${index}`, { command: "x" }]),
    );
    const tooMany = await saveMcpServers(configPath, JSON.stringify(many), zh);
    expect(tooMany.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("写：config.json 不存在 ⇒ 首次写入建文件建目录，内容只含 mcp_servers", async () => {
    const result = await saveMcpServers(
      missingPath,
      JSON.stringify({ fresh: { command: "npx" } }),
      zh,
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.count : 0).toBe(1);
    expect(JSON.parse(readFileSync(missingPath, "utf8"))).toStrictEqual({
      mcp_servers: { fresh: { type: "stdio", command: "npx" } },
    });
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
    ["args 过多", { server: { command: "x", args: Array.from({ length: 101 }).fill("a") } }],
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

  it.each(invalid)("非法条目：%s ⇒ 拒绝，且点名条目与字段", async (_label, value) => {
    const before = readFileSync(configPath, "utf8");
    const result = await saveMcpServers(configPath, JSON.stringify(value), zh);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("MCP server「");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("写盘失败（配置路径是目录）⇒ 拒绝，且文案是写侧不是读侧", async () => {
    const result = await saveMcpServers(dirPath, "{}", zh);
    expect(result.ok).toBe(false);
    // 复用 mcpReadFailed 时用户会被提示去查一个没坏的读取路径（读侧与写侧必须分开报）。
    expect(result.ok ? "" : result.error.startsWith("写入 MCP 配置失败")).toBe(true);
  });

  it("chatGpt：写 provider/model、清掉同条目 key、保留其他配置", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        language: "English",
        custom_providers: { other: { url: "https://x" } },
        providers: {
          chatgpt: {
            api_key: "secret",
            api_key_cmd: "cmd",
            model: "old",
            base_url: "https://api.example",
          },
          local: { model: "keep-me" },
        },
      }),
    );
    const applied = await applyChatGptModel(configPath, "gpt-6", zh);
    expect(applied).toStrictEqual({ ok: true });
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: string;
      language: string;
      custom_providers: Record<string, unknown>;
      providers: Record<string, Record<string, unknown>>;
    };
    expect(written.provider).toBe("chatgpt");
    expect(written.language).toBe("English");
    expect(written.custom_providers).toStrictEqual({ other: { url: "https://x" } });
    expect(written.providers["chatgpt"]).toStrictEqual({
      model: "gpt-6",
      base_url: "https://api.example",
    });
    expect(written.providers["local"]).toStrictEqual({ model: "keep-me" });
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

  it("远程 URL 必须解析出主机：空主机 / 非 URL 一律拒绝", async () => {
    writeFileSync(configPath, "{}");
    // "http:///path" 不在反例里：WHATWG 解析把它读成主机 "path"（实测 node 24），
    // 那是一个合法主机名；"http://" 与 "https:// " 才会解析失败。
    const urls = ["http://", "https:// ", "not-a-url", "ftp://mcp.example.com"];
    const rejections = await Promise.all(
      urls.map((url) =>
        saveMcpServers(configPath, JSON.stringify({ svc: { type: "remote", url } }), zh),
      ),
    );
    for (const rejected of rejections) {
      expect(rejected.ok).toBe(false);
    }
    const accepted = await saveMcpServers(
      configPath,
      JSON.stringify({ svc: { type: "remote", url: MCP_URL } }),
      zh,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.ok ? accepted.count : 0).toBe(1);
  });

  it("动态键 __proto__ 不静默丢失：server 名与 header 名都落成自有键", async () => {
    // 直接写 out["__proto__"] 会走 Object.prototype 的 setter：条目消失、值变成原型。
    writeFileSync(configPath, "{}");
    const saved = await saveMcpServers(configPath, '{"__proto__":{"command":"npx"}}', zh);
    expect(saved.ok).toBe(true);
    expect(saved.ok ? saved.count : 0).toBe(1);
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(Object.hasOwn(doc.mcp_servers, "__proto__")).toBe(true);
    const entry = Object.entries(doc.mcp_servers).find(([key]) => key === "__proto__")?.[1];
    expect(entry).toStrictEqual({ type: "stdio", command: "npx" });
    const read = await readMcpServers(configPath, zh);
    expect(read.ok).toBe(true);
    expect(read.ok ? JSON.parse(read.json) : null).toStrictEqual({
      ["__proto__"]: { type: "stdio", command: "npx" },
    });
    const headerSaved = await saveMcpServers(
      configPath,
      '{"svc":{"type":"remote","url":"https://x","headers":{"__proto__":"v"}}}',
      zh,
    );
    expect(headerSaved.ok).toBe(true);
    expect(headerSaved.ok ? headerSaved.count : 0).toBe(1);
    const headerDoc = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp_servers: { svc: { headers: Record<string, string> } };
    };
    expect(Object.hasOwn(headerDoc.mcp_servers.svc.headers, "__proto__")).toBe(true);
    const headerValue = Object.entries(headerDoc.mcp_servers.svc.headers).find(
      ([key]) => key === "__proto__",
    )?.[1];
    expect(headerValue).toBe("v");
  });

  it("盘上已有的未知字段保存时接回：只有新条目里的未知键才判非法", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcp_servers: { docs: { command: "npx", timeout: 30, extra: { a: 1 } } } }),
    );
    const kept = await saveMcpServers(
      configPath,
      JSON.stringify({ docs: { command: "npx2", timeout: 30, extra: { a: 2 } } }),
      zh,
    );
    expect(kept.ok).toBe(true);
    expect(kept.ok ? kept.count : 0).toBe(1);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp_servers: { docs: Record<string, unknown> };
    };
    expect(written.mcp_servers.docs).toStrictEqual({
      type: "stdio",
      command: "npx2",
      timeout: 30,
      extra: { a: 2 },
    });
    const added = await saveMcpServers(
      configPath,
      JSON.stringify({ fresh: { command: "x", timeout: 1 } }),
      zh,
    );
    expect(added.ok).toBe(false);
  });

  it("写：基线过期 ⇒ 拒绝且盘上不动；不带基线 ⇒ 照旧写入（旧客户端）", async () => {
    writeFileSync(configPath, JSON.stringify({ mcp_servers: { docs: { command: "npx" } } }));
    const read = await readMcpServers(configPath, zh);
    expect(read.ok).toBe(true);
    const baseline = read.ok ? read.revision : "";
    expect(baseline).toBe(mcpServersRevision({ docs: { command: "npx" } }));
    // 另一张卡（或手工编辑）在本次读取之后改了盘：键序、条目都变了，摘要随之变化。
    writeFileSync(
      configPath,
      JSON.stringify({ mcp_servers: { manual: { command: "npx" }, docs: { command: "npx" } } }),
    );
    const before = readFileSync(configPath, "utf8");
    const stale = await saveMcpServers(configPath, '{"mine":{"command":"npx"}}', zh, baseline);
    expect(stale).toStrictEqual({ ok: false, error: zh.mcpSaveConflict });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    // 拿新基线再存：写入成功，并交回下一笔可用的摘要。
    const fresh = await readMcpServers(configPath, zh);
    const retried = await saveMcpServers(
      configPath,
      '{"mine":{"command":"npx"}}',
      zh,
      fresh.ok ? fresh.revision : undefined,
    );
    expect(retried.ok).toBe(true);
    expect(retried.ok ? retried.count : 0).toBe(1);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written["mcp_servers"] as Record<string, unknown>)).toStrictEqual(["mine"]);
    // 不带基线：按旧契约照旧覆盖（宿主兼容路径，不因缺这一位把保存整体拒掉）。
    const legacy = await saveMcpServers(configPath, '{"legacy":{"command":"npx"}}', zh);
    expect(legacy.ok).toBe(true);
  });

  it("读：超过 64 KiB 的 config.json 直接拒绝，不整个读进内存", async () => {
    const bigPath = path.join(root, "big.json");
    writeFileSync(bigPath, "x".repeat(70 * 1024));
    const big = await readMcpServers(bigPath, zh);
    expect(big.ok).toBe(false);
    expect(big.ok ? "" : big.error).toContain("65536");
  });

  it("chatGpt：providers / providers.chatgpt 非对象时报错，不静默重置成 {}", async () => {
    writeFileSync(configPath, JSON.stringify({ providers: "nope", language: "English" }));
    const badProviders = await applyChatGptModel(configPath, "gpt-6", zh);
    expect(badProviders).toStrictEqual({ ok: false, error: zh.chatGptProvidersInvalid });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toStrictEqual({
      providers: "nope",
      language: "English",
    });
    writeFileSync(
      configPath,
      JSON.stringify({ providers: { chatgpt: ["x"], other: { url: "https://y" } } }),
    );
    const badEntry = await applyChatGptModel(configPath, "gpt-6", zh);
    expect(badEntry).toStrictEqual({ ok: false, error: zh.chatGptProvidersInvalid });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toStrictEqual({
      providers: { chatgpt: ["x"], other: { url: "https://y" } },
    });
  });
});
