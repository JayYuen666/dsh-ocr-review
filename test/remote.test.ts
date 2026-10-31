// 设置卡读面（Typert Remote）的宿主侧直测：注册、九个方法的成功/拒绝分支，以及客户端
// descriptor 与宿主 `@Remote` 标记的对质。客户端读取器的装配在文件末单独一组。
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import plugin, {
  endpointVerifyOf,
  installOcrRemote,
  joinedOutput,
  ocrEnv,
  OcrReviewRemoteService,
  readLanguage,
} from "../host.ts";
import type { Config, HostCtx, OcrAvailabilityProbe, OcrReviewRemoteDeps } from "../host.ts";
import type { DshConfigGateway } from "../lib/provider-source.ts";
import { MESSAGES } from "../lib/messages.ts";
import { isRemoteRefused, OCR_REMOTE_NAMESPACE } from "../lib/remote-shape.ts";
import type { OcrProbeReply, OcrTestReply } from "../lib/remote-shape.ts";
import { OCR_DESCRIPTORS, createOcrReader } from "../src/remote.ts";

/** 建过的临时家目录：文件级 `afterAll` 统一删除，避免每跑一轮就在 /tmp 留一批。 */
const TEMP_HOMES: string[] = [];

/** 每个用例一份临时 OCR 配置位置：`<X>/.opencodereview/config.json` 是唯一被接受的布局。 */
function freshConfigPath(): string {
  const home = mkdtempSync(path.join(tmpdir(), "ocr-review-remote-"));
  TEMP_HOMES.push(home);
  const file = path.join(home, ".opencodereview", "config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** 真·cordis 装载期解析：volatile 字段以引用形态交出（与 apply 收到的那份同形）。 */
function configOf(configPath: string, over: Record<string, unknown> = {}): Config {
  const schema = plugin.Config as unknown as {
    "~standard": { validate: (value: unknown) => { issues?: unknown; value: unknown } };
  };
  const result = schema["~standard"].validate({
    autoVerify: false,
    ocrConfigPath: configPath,
    ...over,
  });
  assert.equal(result.issues, undefined);
  return result.value as Config;
}

/** 设置项里不合形态的路径（相对路径）：端点侧读到它必须回 500 可读回执，不是 reject。 */
const BAD_CONFIG_PATH = "relative/ocr.json";
/** saveMcp 用例共用的 remote server 端点：三处断言比的是同一份写入内容。 */
const MCP_REMOTE_URL = "https://mcp.example.com";
/** probe 用例的共同前提：成功/失败结论都以非拒绝回执返回，不落到网线错误那一路。 */
const PROBE_NOT_REFUSED = "probe 不该回拒绝回执";

/** settings 里那条 llm-pi-ai 的解析值（一个可用 provider + 一个模型）。 */
const PROVIDER_VALUE = {
  providers: {
    alpha: {
      apiKeyEnv: "ALPHA_API_KEY",
      apiKeyEnvInvalid: null,
      api: "openai-completions",
      baseURL: "https://alpha.example/v1",
      models: [{ id: "alpha-1", name: "alpha-1" }],
    },
  },
};

/** 官方通道门面的替身；`over` 用来把某一位换成失败形态。 */
function gatewayOf(over: Partial<DshConfigGateway> = {}): DshConfigGateway {
  return {
    health: () => ({ settings: true, credentials: true }),
    descriptors: () => [{ ns: "llm-pi-ai", value: PROVIDER_VALUE }],
    credentialConfigured: async () => true,
    credentialSource: async () => "file",
    ...over,
  };
}

/** 外部 CLI 可用性现读口的替身：PATH 上一份 brew 装的。 */
const AVAILABILITY: OcrAvailabilityProbe = () => ({
  source: "path",
  path: "/usr/local/bin/ocr",
  channel: "brew",
});

interface Script {
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  throws?: unknown;
}

/** 壳层替身：按调用次序交出脚本结果，并记下 resolve 收到的命令。 */
function hostOf(scripts: Script[]): { host: HostCtx; commands: string[] } {
  const commands: string[] = [];
  const host = {
    shell: {
      resolve: (spec: { command: string }) => {
        commands.push(spec.command);
        return spec;
      },
      execute: async () => {
        const script = scripts.shift() ?? {};
        if (script.throws !== undefined) {
          // oxlint-disable-next-line typescript/only-throw-error -- 负向用例要的就是任意外抛：真实执行器并不保证抛 Error
          throw script.throws;
        }
        return {
          result: async () => ({
            exitCode: script.exitCode === undefined ? 0 : script.exitCode,
            timedOut: script.timedOut === true,
            aborted: false,
            stdout: { text: script.stdout ?? "", truncated: false },
            stderr: { text: "", truncated: false },
          }),
        };
      },
    },
  } as unknown as HostCtx;
  return { host, commands };
}

interface DepsOptions {
  config?: Record<string, unknown>;
  configPath?: string;
  gateway?: DshConfigGateway;
  scripts?: Script[];
  availability?: OcrAvailabilityProbe;
}

/** 一套完整的读面依赖 + 本次用例可断言的侧效应。 */
function depsOf(options: DepsOptions = {}): {
  deps: OcrReviewRemoteDeps;
  commands: string[];
  configPath: string;
  versionSink: { value: string | null };
} {
  const configPath = options.configPath ?? freshConfigPath();
  const { host, commands } = hostOf(options.scripts ?? []);
  const versionSink: { value: string | null } = { value: null };
  return {
    deps: {
      host,
      config: configOf(configPath, options.config ?? {}),
      gateway: options.gateway ?? gatewayOf(),
      messages: () => MESSAGES.zh,
      extras: {
        verifyOf: () => null,
        availability: options.availability ?? AVAILABILITY,
        versionSink,
      },
    },
    commands,
    configPath,
    versionSink,
  };
}

function serviceOf(deps: OcrReviewRemoteDeps): OcrReviewRemoteService {
  const ctx = new Context();
  assert.equal(installOcrRemote(ctx, deps), true);
  const service: unknown = ctx.get(OCR_REMOTE_NAMESPACE);
  assert.ok(service instanceof OcrReviewRemoteService);
  return service;
}

/** 未用到的命名空间方法一律抛：读取器若调错位，失败面比返回值更早暴露。 */
const unusedRemoteMethod = async (): Promise<never> => {
  throw new Error("unused");
};

/** 九方法齐全的命名空间替身（isOcrNamespace 要求九位都在）。 */
function namespaceStub(): Record<string, unknown> {
  return {
    providers: async (): Promise<unknown> => ({ ok: true, value: { providers: [] } }),
    select: unusedRemoteMethod,
    migrate: unusedRemoteMethod,
    test: unusedRemoteMethod,
    probe: unusedRemoteMethod,
    mcp: unusedRemoteMethod,
    saveMcp: unusedRemoteMethod,
    auth: unusedRemoteMethod,
    chatGpt: unusedRemoteMethod,
  };
}

describe("设置卡 Remote（宿主读面与客户端消费侧）", () => {
  afterAll(() => {
    for (const home of TEMP_HOMES.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("设置卡读面（官方 Typert Remote 源模式）", () => {
    it("装进真 Context：九个方法都带 @Remote 标记，客户端 descriptor 逐项对质", () => {
      const service = serviceOf(depsOf().deps);
      const markers = remoteMethods(service)
        .map((marker) => marker.method)
        .toSorted();
      assert.deepEqual(markers, [
        "auth",
        "chatGpt",
        "mcp",
        "migrate",
        "probe",
        "providers",
        "saveMcp",
        "select",
        "test",
      ]);
      assert.deepEqual(OCR_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(), markers);
      for (const descriptor of OCR_DESCRIPTORS) {
        assert.equal(descriptor.service, OCR_REMOTE_NAMESPACE);
        assert.equal(descriptor.namespace, OCR_REMOTE_NAMESPACE);
        assert.equal(descriptor.invocation.kind, "direct");
        assert.equal(descriptor.result.mode, "src-json");
        assert.equal(
          descriptor.id,
          `@jayyuen66/dsh-ocr-review#${OCR_REMOTE_NAMESPACE}/${descriptor.method}`,
        );
      }
      const select = OCR_DESCRIPTORS.find((descriptor) => descriptor.method === "select");
      assert.deepEqual(
        select?.parameters.map((parameter) => [parameter.name, parameter.source]),
        [["request", "json"]],
      );
      for (const method of ["saveMcp", "chatGpt"]) {
        const descriptor = OCR_DESCRIPTORS.find((entry) => entry.method === method);
        assert.deepEqual(
          descriptor?.parameters.map((parameter) => [parameter.name, parameter.source]),
          [["request", "json"]],
        );
      }
    });

    it("注册口缺席时返回 false（可选读面，不让 apply 下线）", () => {
      assert.equal(installOcrRemote({} as never, depsOf().deps), false);
      assert.equal(installOcrRemote(null as never, depsOf().deps), false);
    });

    it("providers：交回清单、当前配置与 ocrBinary（**不含 csrf**）", async () => {
      const { deps } = depsOf();
      const body = await serviceOf(deps).providers();
      assert.equal(body["ok"], undefined);
      assert.equal("csrf" in body, false);
      const providers = body["providers"] as { name: string; hasKey: boolean }[];
      assert.deepEqual(
        providers.map((entry) => [entry.name, entry.hasKey]),
        [["alpha", true]],
      );
      const binary = body["ocrBinary"] as { source: string; expectedVersion: string };
      assert.equal(binary.source, "path");
      assert.equal(typeof binary.expectedVersion, "string");
    });

    it("providers：设置项路径不合法 ⇒ { ok:false, status:500, error }", async () => {
      const { deps } = depsOf({ config: { ocrConfigPath: BAD_CONFIG_PATH } });
      const body = await serviceOf(deps).providers();
      assert.equal(body["ok"], false);
      assert.equal(body["status"], 500);
      assert.match(String(body["error"]), /absolute|绝对/u);
    });

    it("select：缺字段与非记录入参都回 400，不透传到写盘", async () => {
      const service = serviceOf(depsOf().deps);
      const missing = await service.select({ provider: "", model: "alpha-1" });
      assert.deepEqual([missing.ok, missing.ok ? 0 : missing.status], [false, 400]);
      const noModel = await service.select({ provider: "alpha" } as never);
      assert.deepEqual([noModel.ok, noModel.ok ? 0 : noModel.status], [false, 400]);
      const blankModel = await service.select({ provider: "alpha", model: "   " });
      assert.deepEqual([blankModel.ok, blankModel.ok ? 0 : blankModel.status], [false, 400]);
      const wrongModel = await service.select({ provider: "alpha", model: 3 } as never);
      assert.deepEqual([wrongModel.ok, wrongModel.ok ? 0 : wrongModel.status], [false, 400]);
      const noRecord = await service.select(null as never);
      assert.deepEqual([noRecord.ok, noRecord.ok ? 0 : noRecord.status], [false, 400]);
    });

    it("纯函数边界：语言/自动更新 env/输出合并/自检文案", () => {
      const base = configOf(freshConfigPath());
      const english = configOf(freshConfigPath(), { language: "English" });
      const chinese = configOf(freshConfigPath(), { language: "中文" });
      const noUpdate = configOf(freshConfigPath(), { ocrNoAutoUpdate: true });
      assert.equal(readLanguage(base), "中文");
      assert.equal(readLanguage({ language: { get: () => "fr" } } as never), undefined);
      assert.equal(readLanguage(english), "English");
      assert.equal(readLanguage(chinese), "中文");
      assert.equal(ocrEnv(base), undefined);
      assert.deepEqual(ocrEnv(noUpdate), { OCR_NO_UPDATE: "1" });
      assert.equal(joinedOutput("", ""), "");
      assert.equal(joinedOutput("a", "b"), "a\nb");
      assert.deepEqual(endpointVerifyOf({ ok: true, output: "x" }), { ok: true, message: "" });
      assert.deepEqual(endpointVerifyOf({ ok: false, output: "  hello  " }), {
        ok: false,
        message: "hello",
      });
    });

    it("select：配置了 language 时把它一并写进外部 CLI 配置", async () => {
      const { deps, configPath } = depsOf({ config: { language: "English" } });
      const reply = await serviceOf(deps).select({ provider: "alpha", model: "alpha-1" });
      assert.equal(reply.ok, true);
      const written: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal((written as { language?: string }).language, "English");
    });

    it("HOME 缺席时版本探测与 llm test 仍交出一个可用的 workdir", async () => {
      const saved = process.env["HOME"];
      delete process.env["HOME"];
      try {
        const { deps } = depsOf({
          scripts: [{ exitCode: 0, stdout: "open-code-review 1.13.3 darwin/arm64" }],
        });
        const service = serviceOf(deps);
        const probed = await service.probe();
        assert.equal("status" in probed, false);
        const tested = await service.test();
        assert.equal(tested.ok, true);
      } finally {
        if (saved !== undefined) {
          process.env["HOME"] = saved;
        }
      }
    });

    it("select：应用成功且 autoVerify 关着 ⇒ llmTest 为 null，配置落到指定路径", async () => {
      const { deps, configPath } = depsOf();
      const reply = await serviceOf(deps).select({ provider: "alpha", model: "alpha-1" });
      assert.ok(reply.ok);
      assert.deepEqual(reply.applied, {
        provider: "alpha",
        model: "alpha-1",
        url: "https://alpha.example/v1",
        protocol: "openai",
      });
      assert.equal(reply.llmTest, null);
      const written: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal((written as { provider: string }).provider, "alpha");
      const customs = (written as { custom_providers?: Record<string, { model?: string }> })
        .custom_providers;
      assert.equal(customs?.["alpha"]?.model, "alpha-1");
    });

    it("select：语言读不出时按不写 language 处理", async () => {
      const { deps, configPath } = depsOf();
      (deps.config as unknown as { language: { get: () => undefined } }).language = {
        get: () => {
          void 0;
        },
      };
      const reply = await serviceOf(deps).select({ provider: "alpha", model: "alpha-1" });
      assert.equal(reply.ok, true);
      const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      assert.equal("language" in written, false);
    });

    it("select：autoVerify 开着 ⇒ 顺手跑一次 llm test 并把回执带回来", async () => {
      const { deps, commands } = depsOf({
        config: { autoVerify: true },
        scripts: [{ exitCode: 0, stdout: "endpoint ok" }],
      });
      const reply = await serviceOf(deps).select({ provider: "alpha", model: "alpha-1" });
      assert.ok(reply.ok);
      assert.deepEqual(reply.llmTest, { ok: true, output: "endpoint ok" });
      assert.equal(commands.length, 1);
      assert.match(commands[0] ?? "", /llm test/u);
    });

    it("select：settings 通道抛错 ⇒ 400 与那句可读原因", async () => {
      const gateway = gatewayOf({
        descriptors: () => {
          throw new Error("settings went away");
        },
      });
      const reply = await serviceOf(depsOf({ gateway }).deps).select({
        provider: "alpha",
        model: "alpha-1",
      });
      assert.deepEqual([reply.ok, reply.ok ? 0 : reply.status], [false, 400]);
      if (!reply.ok) {
        assert.match(reply.error, /settings went away/u);
      }
    });

    it("migrate：把明文 api_key 换成 api_key_cmd", async () => {
      const configPath = freshConfigPath();
      writeFileSync(
        configPath,
        JSON.stringify({ custom_providers: { alpha: { api_key: "sk-live" } } }),
      );
      const reply = await serviceOf(depsOf({ configPath }).deps).migrate();
      assert.deepEqual(reply, { ok: true, migrated: ["alpha"], skippedUnknown: [] });
      const written = readFileSync(configPath, "utf8");
      assert.equal(written.includes("sk-live"), false);
      assert.match(written, /api_key_cmd/u);
    });

    it("migrate：坏 JSON 回 400 而不是抛穿网关", async () => {
      const configPath = freshConfigPath();
      writeFileSync(configPath, "{ nope");
      const reply = await serviceOf(depsOf({ configPath }).deps).migrate();
      assert.deepEqual([reply.ok, reply.ok ? 0 : reply.status], [false, 400]);
    });

    it("test：把 llm test 的退出结论与输出原样交回", async () => {
      const passed = await serviceOf(
        depsOf({ scripts: [{ exitCode: 0, stdout: "ok" }] }).deps,
      ).test();
      assert.deepEqual(passed, { ok: true, output: "ok" });
      const failed = await serviceOf(
        depsOf({ scripts: [{ exitCode: 2, stdout: "bad endpoint" }] }).deps,
      ).test();
      assert.deepEqual(failed, { ok: false, output: "bad endpoint" });
    });

    it("test：壳层抛错回 400", async () => {
      const reply = await serviceOf(
        depsOf({ scripts: [{ throws: new Error("no shell") }] }).deps,
      ).test();
      assert.deepEqual(["status" in reply, "status" in reply ? reply.status : 0], [true, 400]);
      if ("status" in reply) {
        assert.match(reply.error, /no shell/u);
      }
    });

    it("probe：一致 ⇒ consistent 真且不给换版命令；版本落进 versionSink", async () => {
      const { deps, versionSink } = depsOf({
        scripts: [{ exitCode: 0, stdout: "open-code-review 1.13.3 darwin/arm64" }],
      });
      const reply = await serviceOf(deps).probe();
      assert.equal(reply.ok, true);
      assert.equal("status" in reply, false, PROBE_NOT_REFUSED);
      if (!("status" in reply)) {
        assert.equal(reply.version, "1.13.3");
        assert.equal(reply.consistent, true);
        assert.equal(reply.changeText, "");
        assert.equal(versionSink.value, "1.13.3");
      }
    });

    it("mcp：只回 mcp_servers；saveMcp 写回并保留其他配置", async () => {
      const { deps, configPath } = depsOf();
      writeFileSync(
        configPath,
        JSON.stringify({ language: "English", mcp_servers: { docs: { command: "npx" } } }),
      );
      const read = await serviceOf(deps).mcp();
      assert.equal("status" in read, false);
      let baseline: string | undefined;
      if (!("status" in read)) {
        assert.deepEqual(JSON.parse(read.json), { docs: { command: "npx" } });
        baseline = read.revision;
      }
      const saved = await serviceOf(deps).saveMcp({
        json: JSON.stringify({ remote: { type: "remote", url: MCP_REMOTE_URL } }),
        revision: baseline,
      });
      assert.deepEqual([saved.ok, saved.ok ? saved.count : 0], [true, 1]);
      // 回执带回新摘要：卡片保存后不必重读就能拿它做下一笔的基线。
      assert.equal(saved.ok ? saved.revision.length : 0, 64);
      const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(written["language"], "English");
      assert.deepEqual(written["mcp_servers"], {
        remote: { type: "remote", url: MCP_REMOTE_URL },
      });
      // 基线在读过之后变了（另一张卡/手工编辑写过盘）：整笔拒绝，盘上内容不动。
      const stale = await serviceOf(deps).saveMcp({
        json: JSON.stringify({ other: { command: "npx" } }),
        revision: baseline,
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error, /已被改动|changed after it was read/u);
      assert.deepEqual(
        (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)["mcp_servers"],
        { remote: { type: "remote", url: MCP_REMOTE_URL } },
      );
      // 基线形态不是字符串：按请求体错误回 400，而不是当成「没有基线」静默跳过比较。
      const badRevision = await serviceOf(deps).saveMcp({ json: "{}", revision: 3 } as never);
      assert.deepEqual([badRevision.ok, badRevision.ok ? 0 : badRevision.status], [false, 400]);
      const bad = await serviceOf(deps).saveMcp({ json: "{" });
      assert.deepEqual([bad.ok, bad.ok ? 0 : bad.status], [false, 400]);
      const wrong = await serviceOf(deps).saveMcp({ json: 3 } as never);
      assert.deepEqual([wrong.ok, wrong.ok ? 0 : wrong.status], [false, 400]);
      const noRequest = await serviceOf(deps).saveMcp(null as never);
      assert.deepEqual([noRequest.ok, noRequest.ok ? 0 : noRequest.status], [false, 400]);
      writeFileSync(configPath, "{");
      const corrupt = await serviceOf(deps).mcp();
      assert.deepEqual([corrupt.ok, corrupt.ok ? 0 : corrupt.status], [false, 400]);
      const badPath = await serviceOf(
        depsOf({ config: { ocrConfigPath: BAD_CONFIG_PATH } }).deps,
      ).mcp();
      assert.deepEqual([badPath.ok, badPath.ok ? 0 : badPath.status], [false, 500]);
      // 写侧同样要回可读回执：设置项坏掉是服务侧故障（500），不能让 Remote 直接 reject
      // ——卡片只会显示一句裸栈，而同一张卡上的读面已经会说人话了。
      const badSavePath = await serviceOf(
        depsOf({ config: { ocrConfigPath: BAD_CONFIG_PATH } }).deps,
      ).saveMcp({ json: "{}" });
      assert.deepEqual([badSavePath.ok, badSavePath.ok ? 0 : badSavePath.status], [false, 500]);
      const badChatGptPath = await serviceOf(
        depsOf({ config: { ocrConfigPath: BAD_CONFIG_PATH } }).deps,
      ).chatGpt({ model: "gpt-6" });
      assert.deepEqual(
        [badChatGptPath.ok, badChatGptPath.ok ? 0 : badChatGptPath.status],
        [false, 500],
      );
    });

    it("auth：状态与登录命令；失败仍回执 output，壳层抛错回 400", async () => {
      const ok = await serviceOf(
        depsOf({ scripts: [{ exitCode: 0, stdout: "Logged in as a@b" }] }).deps,
      ).auth();
      assert.deepEqual(ok, {
        ok: true,
        output: "Logged in as a@b",
        loginCommand: "ocr auth login --provider chatgpt",
      });
      const failed = await serviceOf(
        depsOf({ scripts: [{ exitCode: 1, stdout: "not logged in" }] }).deps,
      ).auth();
      assert.deepEqual(failed, {
        ok: false,
        output: "not logged in",
        loginCommand: "ocr auth login --provider chatgpt",
      });
      const broken = await serviceOf(
        depsOf({ scripts: [{ throws: new Error("no shell") }] }).deps,
      ).auth();
      assert.equal(isRemoteRefused(broken), true);
      if (isRemoteRefused(broken)) {
        assert.equal(broken.status, 400);
      }
      const saved = process.env["HOME"];
      delete process.env["HOME"];
      try {
        const noHome = await serviceOf(
          depsOf({ scripts: [{ exitCode: 0, stdout: "ok" }] }).deps,
        ).auth();
        assert.equal(noHome.ok, true);
      } finally {
        if (saved !== undefined) {
          process.env["HOME"] = saved;
        }
      }
    });

    it("chatGpt：写 provider/model 且不写 key；空模型/坏配置回 400", async () => {
      const { deps, configPath } = depsOf();
      const saved = await serviceOf(deps).chatGpt({ model: "gpt-6" });
      assert.deepEqual(saved, { ok: true, model: "gpt-6" });
      const written = JSON.parse(readFileSync(configPath, "utf8")) as {
        provider: string;
        providers: { chatgpt: Record<string, unknown> };
      };
      assert.equal(written.provider, "chatgpt");
      assert.deepEqual(written.providers.chatgpt, { model: "gpt-6" });
      const empty = await serviceOf(deps).chatGpt({ model: " " });
      assert.deepEqual([empty.ok, empty.ok ? 0 : empty.status], [false, 400]);
      const wrong = await serviceOf(deps).chatGpt({ model: 3 } as never);
      assert.deepEqual([wrong.ok, wrong.ok ? 0 : wrong.status], [false, 400]);
      const noRequest = await serviceOf(deps).chatGpt(null as never);
      assert.deepEqual([noRequest.ok, noRequest.ok ? 0 : noRequest.status], [false, 400]);
      writeFileSync(configPath, "{");
      const corrupt = await serviceOf(deps).chatGpt({ model: "gpt-6" });
      assert.deepEqual([corrupt.ok, corrupt.ok ? 0 : corrupt.status], [false, 400]);
    });

    it("probe：版本不一致 ⇒ 带上换版命令", async () => {
      const reply = await serviceOf(
        depsOf({ scripts: [{ exitCode: 0, stdout: "open-code-review 1.12.13 darwin/arm64" }] })
          .deps,
      ).probe();
      assert.equal("status" in reply, false, PROBE_NOT_REFUSED);
      if (!("status" in reply)) {
        assert.equal(reply.consistent, false);
        assert.notEqual(reply.changeText, "");
      }
    });

    it("probe：读不出版本 ⇒ consistent 为 null（不把没证据说成结论）", async () => {
      const reply = await serviceOf(
        depsOf({ scripts: [{ exitCode: 0, stdout: "open-code-review dev darwin/arm64" }] }).deps,
      ).probe();
      assert.equal("status" in reply, false, PROBE_NOT_REFUSED);
      if (!("status" in reply)) {
        assert.equal(reply.ok, false);
        assert.equal(reply.consistent, null);
        assert.equal(reply.changeText, "");
      }
    });

    it("probe 的失败理由：127 是没装，超时是超时，其余是真退出码", async () => {
      const missing = await serviceOf(depsOf({ scripts: [{ exitCode: 127 }] }).deps).probe();
      assert.equal("status" in missing, false, PROBE_NOT_REFUSED);
      if (!("status" in missing)) {
        assert.equal(missing.ok, false);
        assert.equal(missing.reason, MESSAGES.zh.execNotFound);
      }
      const timedOut = await serviceOf(
        depsOf({ scripts: [{ exitCode: null, timedOut: true }] }).deps,
      ).probe();
      assert.equal("status" in timedOut, false, PROBE_NOT_REFUSED);
      if (!("status" in timedOut)) {
        assert.match(timedOut.reason, /超时|timed out/u);
      }
      const failed = await serviceOf(depsOf({ scripts: [{ exitCode: 1 }] }).deps).probe();
      assert.equal("status" in failed, false, PROBE_NOT_REFUSED);
      if (!("status" in failed)) {
        assert.match(failed.reason, /1/u);
      }
    });

    it("probe：没有候选时把装法命令带出来；壳层抛错回 400", async () => {
      const missing = await serviceOf(
        depsOf({
          availability: () => ({ source: "none" }),
          scripts: [{ exitCode: 0, stdout: "open-code-review dev darwin/arm64" }],
        }).deps,
      ).probe();
      assert.equal("status" in missing, false, PROBE_NOT_REFUSED);
      if (!("status" in missing)) {
        assert.notEqual(missing.changeText, "");
      }
      const thrown = await serviceOf(
        depsOf({ scripts: [{ throws: new Error("probe blew up") }] }).deps,
      ).probe();
      assert.deepEqual(["status" in thrown, "status" in thrown ? thrown.status : 0], [true, 400]);
      if ("status" in thrown) {
        assert.match(thrown.error, /probe blew up/u);
      }
    });
  });

  describe("客户端读取器（Remote 消费侧）", () => {
    it("remote 缺席/形状不合 ⇒ 读取时抛可读错误（解析不快照在构造期）", async () => {
      const absent = createOcrReader({});
      await assert.rejects(async () => absent.providers(), /remote 未提供/u);
      const shapeless = createOcrReader({ get: () => ({}) });
      await assert.rejects(async () => shapeless.providers(), /remote 未提供/u);
      const nul = createOcrReader({ get: () => null });
      await assert.rejects(async () => nul.providers(), /remote 未提供/u);
    });

    it("remote 晚于读取器出现 ⇒ 下一次读取接上（不做构造期快照）", async () => {
      // 本插件与官方网关之间没有加载顺序保证：网关可能在本插件 apply 之后才
      // provide("remote")。构造期快照会让读取器永远拿不到它。
      // remote 用一个可变槽位持有：用例要改的是「此刻有没有」，不是绑定本身。
      const state: { remote: unknown } = { remote: undefined };
      const namespace = {
        providers: async (): Promise<unknown> => ({ ok: true, value: { providers: [] } }),
        select: async (): Promise<never> => {
          throw new Error("unused");
        },
        migrate: async (): Promise<never> => {
          throw new Error("unused");
        },
        test: async (): Promise<never> => {
          throw new Error("unused");
        },
        probe: async (): Promise<never> => {
          throw new Error("unused");
        },
        mcp: async (): Promise<never> => {
          throw new Error("unused");
        },
        saveMcp: async (): Promise<never> => {
          throw new Error("unused");
        },
        auth: async (): Promise<never> => {
          throw new Error("unused");
        },
        chatGpt: async (): Promise<never> => {
          throw new Error("unused");
        },
      };
      const reader = createOcrReader({
        get: (name: string): unknown => {
          if (name === "remote") {
            return state.remote;
          }
          return name === `remote.${OCR_REMOTE_NAMESPACE}` ? namespace : undefined;
        },
      });
      await assert.rejects(async () => reader.providers(), /remote 未提供/u);
      state.remote = { $mount: async (): Promise<void> => undefined };
      // node:assert 没有 resolves：await 本身就是断言，rejection 会让本用例失败。
      await reader.providers();
    });

    it("$mount 只挂一次；九个方法按位置参数转给命名空间服务", async () => {
      let mounts = 0;
      const calls: unknown[] = [];
      const namespace = {
        providers: async () => {
          calls.push(["providers"]);
          return { ok: true, value: { providers: [] } };
        },
        select: async (request: unknown) => {
          calls.push(["select", request]);
          return { ok: true, value: { ok: false, error: "nope", status: 400 } };
        },
        migrate: async () => {
          calls.push(["migrate"]);
          return { ok: true, value: { ok: true, migrated: [], skippedUnknown: [] } };
        },
        test: async () => {
          calls.push(["test"]);
          return { ok: true, value: { ok: true, output: "" } };
        },
        probe: async () => {
          calls.push(["probe"]);
          return {
            ok: true,
            value: {
              ok: true,
              version: null,
              expectedVersion: "",
              consistent: null,
              output: "",
              reason: "",
              changeText: "",
            },
          };
        },
        mcp: async () => {
          calls.push(["mcp"]);
          return { ok: true, value: { ok: true, json: "{}" } };
        },
        saveMcp: async (request: unknown) => {
          calls.push(["saveMcp", request]);
          return { ok: true, value: { ok: true, count: 0 } };
        },
        auth: async () => {
          calls.push(["auth"]);
          return { ok: true, value: { ok: true, output: "", loginCommand: "ocr auth login" } };
        },
        chatGpt: async (request: unknown) => {
          calls.push(["chatGpt", request]);
          return { ok: true, value: { ok: true, model: "gpt-6" } };
        },
      };
      const ctx = {
        get: (name: string): unknown => {
          if (name === "remote") {
            return {
              $mount: async (): Promise<void> => {
                mounts += 1;
              },
            };
          }
          return name === `remote.${OCR_REMOTE_NAMESPACE}` ? namespace : undefined;
        },
      };
      const reader = createOcrReader(ctx);
      assert.deepEqual(await reader.providers(), { providers: [] });
      assert.deepEqual(await reader.select("alpha", "alpha-1"), {
        ok: false,
        error: "nope",
        status: 400,
      });
      await reader.migrate();
      await reader.test();
      await reader.probe();
      assert.deepEqual(await reader.mcp(), { ok: true, json: "{}" });
      assert.deepEqual(await reader.saveMcp("{}"), { ok: true, count: 0 });
      await reader.auth();
      assert.deepEqual(await reader.chatGpt("gpt-6"), { ok: true, model: "gpt-6" });
      assert.equal(mounts, 1);
      assert.deepEqual(calls[1], ["select", { provider: "alpha", model: "alpha-1" }]);
      assert.deepEqual(calls[6], ["saveMcp", { json: "{}" }]);
      assert.deepEqual(calls[8], ["chatGpt", { model: "gpt-6" }]);
    });

    it("挂载失败不缓存：下一次读取重新 $mount 并成功", async () => {
      // `??=` 缓存的是已 settled 的 promise：失败不清空的话，同一读取器此后每次读取
      // 都立刻以同一条错误失败，且永远不会重试。
      let mounts = 0;
      let mountShouldFail = true;
      const namespace = {
        providers: async (): Promise<unknown> => ({ ok: true, value: { providers: [] } }),
        select: async (): Promise<never> => {
          throw new Error("unused");
        },
        migrate: async (): Promise<never> => {
          throw new Error("unused");
        },
        test: async (): Promise<never> => {
          throw new Error("unused");
        },
        probe: async (): Promise<never> => {
          throw new Error("unused");
        },
        mcp: async (): Promise<never> => {
          throw new Error("unused");
        },
        saveMcp: async (): Promise<never> => {
          throw new Error("unused");
        },
        auth: async (): Promise<never> => {
          throw new Error("unused");
        },
        chatGpt: async (): Promise<never> => {
          throw new Error("unused");
        },
      };
      const reader = createOcrReader({
        get: (name: string): unknown => {
          if (name !== "remote") {
            return name === `remote.${OCR_REMOTE_NAMESPACE}` ? namespace : undefined;
          }
          return {
            $mount: async (): Promise<void> => {
              mounts += 1;
              if (mountShouldFail) {
                throw new Error("gateway cold");
              }
            },
          };
        },
      });
      await assert.rejects(async () => reader.providers(), /gateway cold/u);
      mountShouldFail = false;
      await reader.providers();
      assert.equal(mounts, 2);
    });

    it("挂载成功但命名空间缺席 ⇒ 清缓存，命名空间晚到时重新挂载并接上", async () => {
      // 缓存的是已 settled 的成功 promise；不清空的话，后续读取永远跳过 $mount，
      // 与文件头「晚到也能被下一次读取接上」的承诺相反。
      let mounts = 0;
      const late: { namespace: unknown } = { namespace: undefined };
      const reader = createOcrReader({
        get: (name: string): unknown => {
          if (name === "remote") {
            return {
              $mount: async (): Promise<void> => {
                mounts += 1;
              },
            };
          }
          return name === `remote.${OCR_REMOTE_NAMESPACE}` ? late.namespace : undefined;
        },
      });
      await assert.rejects(async () => reader.providers(), /未提供/u);
      late.namespace = namespaceStub();
      assert.deepEqual(await reader.providers(), { providers: [] });
      assert.equal(mounts, 2);
    });

    it("网关回执是失败 ⇒ 抛（卡片那层按「请求失败」显示）；命名空间缺席同样抛", async () => {
      const failing = {
        get: (name: string): unknown =>
          name === "remote"
            ? { $mount: async (): Promise<void> => undefined }
            : {
                providers: async () => ({
                  ok: false,
                  error: { code: "gateway/internal", message: "boom" },
                }),
                select: async () => ({ ok: false }),
                migrate: async () => ({ ok: false }),
                test: async () => ({ ok: false }),
                probe: async () => ({ ok: false }),
                mcp: async () => ({ ok: false }),
                saveMcp: async () => ({ ok: false }),
                auth: async () => ({ ok: false }),
                chatGpt: async () => ({ ok: false }),
              },
      };
      const reader = createOcrReader(failing);
      await assert.rejects(
        async () => reader.providers(),
        (error: unknown) => {
          // 用户只看 message；机器码留在 cause 里供排障。
          assert.ok(error instanceof Error);
          assert.equal(error.message, "boom");
          assert.deepEqual(error.cause, { code: "gateway/internal" });
          return true;
        },
      );
      const absent = createOcrReader({
        get: (name: string): unknown =>
          name === "remote" ? { $mount: async (): Promise<void> => undefined } : undefined,
      });
      await assert.rejects(async () => absent.providers(), /未提供/u);
    });
  });

  describe("isRemoteRefused：判别「请求被拒」与「结论不理想」", () => {
    it("ok 不能当判别式：test 的 ok 两态都取得到，与拒绝回执的 ok=false 重叠", () => {
      // 两者都是 { ok: false, ... }，靠 ok 判会把「LLM 测试没过」说成「请求被拒」，
      // 用户看到的文案与接下来该做什么完全不同。判据是拒绝回执独有的 status。
      const refused: OcrTestReply = { ok: false, error: "boom", status: 400 };
      const testFailed: OcrTestReply = { ok: false, output: "auth failed" };
      const testPassed: OcrTestReply = { ok: true, output: "ok" };
      assert.equal(isRemoteRefused(refused), true);
      assert.equal(isRemoteRefused(testFailed), false);
      assert.equal(isRemoteRefused(testPassed), false);
      // 收窄之后才能读 error/status 而不用断言
      if (isRemoteRefused(refused)) {
        assert.equal(refused.status, 400);
        assert.equal(refused.error, "boom");
      }
    });

    it("非对象 / NaN / 缺 ok 一律不判为拒绝：判别式自己不许抛", () => {
      // 回执来自远端 JSON，本仓不保证它一定是对象。旧实现 `"status" in reply` 在
      // null / 原始值上会抛 TypeError——把「解析异常」升级成「客户端崩」，正好与这个
      // 函数存在的意义相反。以下每个输入都必须安静地返回 false。
      for (const raw of [null, undefined, 0, 42, "refused", true, Symbol("x")]) {
        assert.equal(isRemoteRefused(raw), false);
      }
      // NaN 是 number：只凭 typeof 会被误判成拒绝。
      assert.equal(isRemoteRefused({ ok: false, error: "boom", status: Number.NaN }), false);
      // 非整数 status 同理（远端状态码/浮点不该被读成本包的拒绝种类码）。
      assert.equal(isRemoteRefused({ ok: false, error: "boom", status: 400.5 }), false);
      // 缺 ok、或 ok=true 带数字字段的业务回执都不收。
      assert.equal(isRemoteRefused({ error: "boom", status: 400 }), false);
      assert.equal(isRemoteRefused({ ok: true, error: "boom", status: 400 }), false);
      // error 缺失/非字符串也不收：拒绝回执的 error 是给人读的文案，没有它就没有可读性。
      assert.equal(isRemoteRefused({ ok: false, status: 400 }), false);
      assert.equal(isRemoteRefused({ ok: false, error: 7, status: 400 }), false);
    });

    it("probe 的 ok=false（版本不一致）同样不是拒绝", () => {
      const inconsistent: OcrProbeReply = {
        ok: false,
        version: "1.12.0",
        expectedVersion: "1.13.3",
        consistent: false,
        output: "",
        reason: "",
        changeText: "",
      };
      assert.equal(isRemoteRefused(inconsistent), false);
    });
  });
});
