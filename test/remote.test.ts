// 设置卡读面（Typert Remote）的宿主侧直测：注册、五个方法的成功/拒绝分支，以及客户端
// descriptor 与宿主 `@Remote` 标记的对质。客户端读取器的装配在文件末单独一组。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { OCR_REMOTE_NAMESPACE } from "../lib/remote-shape.ts";
import { OCR_DESCRIPTORS, createOcrReader } from "../src/remote.ts";

/** 每个用例一份临时 OCR 配置位置：`<X>/.opencodereview/config.json` 是唯一被接受的布局。 */
function freshConfigPath(): string {
  const home = mkdtempSync(path.join(tmpdir(), "ocr-review-remote-"));
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

/** settings 里那条 llm-pi-ai 的解析值（一个可用 provider + 一个模型）。 */
const PROVIDER_VALUE = {
  providers: {
    alpha: {
      apiKeyEnv: "ALPHA_API_KEY",
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

describe("设置卡读面（官方 Typert Remote 源模式）", () => {
  it("装进真 Context：五个方法都带 @Remote 标记，客户端 descriptor 逐项对质", () => {
    const service = serviceOf(depsOf().deps);
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(markers, ["migrate", "probe", "providers", "select", "test"]);
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
    const { deps } = depsOf({ config: { ocrConfigPath: "relative/ocr.json" } });
    const body = await serviceOf(deps).providers();
    assert.equal(body["ok"], false);
    assert.equal(body["status"], 500);
    assert.match(String(body["error"]), /absolute|绝对/u);
  });

  it("select：缺字段与非记录入参都回 400，不透传到写盘", async () => {
    const service = serviceOf(depsOf().deps);
    const missing = await service.select({ provider: "", model: "alpha-1" });
    assert.deepEqual([missing.ok, missing.ok ? 0 : missing.status], [false, 400]);
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
        scripts: [{ exitCode: 0, stdout: "open-code-review 1.13.0 darwin/arm64" }],
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
  });

  it("select：语言读不出时按不写 language 处理", async () => {
    const { deps } = depsOf();
    (deps.config as unknown as { language: { get: () => undefined } }).language = {
      get: () => {
        void 0;
      },
    };
    const reply = await serviceOf(deps).select({ provider: "alpha", model: "alpha-1" });
    assert.equal(reply.ok, true);
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
      scripts: [{ exitCode: 0, stdout: "open-code-review 1.13.0 darwin/arm64" }],
    });
    const reply = await serviceOf(deps).probe();
    assert.equal(reply.ok, true);
    if (!("status" in reply)) {
      assert.equal(reply.version, "1.13.0");
      assert.equal(reply.consistent, true);
      assert.equal(reply.changeText, "");
      assert.equal(versionSink.value, "1.13.0");
    }
  });

  it("probe：版本不一致 ⇒ 带上换版命令", async () => {
    const reply = await serviceOf(
      depsOf({ scripts: [{ exitCode: 0, stdout: "open-code-review 1.12.13 darwin/arm64" }] }).deps,
    ).probe();
    if (!("status" in reply)) {
      assert.equal(reply.consistent, false);
      assert.notEqual(reply.changeText, "");
    }
  });

  it("probe：读不出版本 ⇒ consistent 为 null（不把没证据说成结论）", async () => {
    const reply = await serviceOf(
      depsOf({ scripts: [{ exitCode: 0, stdout: "open-code-review dev darwin/arm64" }] }).deps,
    ).probe();
    if (!("status" in reply)) {
      assert.equal(reply.ok, false);
      assert.equal(reply.consistent, null);
      assert.equal(reply.changeText, "");
    }
  });

  it("probe 的失败理由：127 是没装，超时是超时，其余是真退出码", async () => {
    const missing = await serviceOf(depsOf({ scripts: [{ exitCode: 127 }] }).deps).probe();
    if (!("status" in missing)) {
      assert.equal(missing.ok, false);
      assert.equal(missing.reason, MESSAGES.zh.execNotFound);
    }
    const timedOut = await serviceOf(
      depsOf({ scripts: [{ exitCode: null, timedOut: true }] }).deps,
    ).probe();
    if (!("status" in timedOut)) {
      assert.match(timedOut.reason, /超时|timed out/u);
    }
    const failed = await serviceOf(depsOf({ scripts: [{ exitCode: 1 }] }).deps).probe();
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
  it("没有远程面时交 undefined；形状不合同样按没有处理", () => {
    assert.equal(createOcrReader({}), undefined);
    assert.equal(createOcrReader({ get: () => ({}) }), undefined);
    assert.equal(createOcrReader({ get: () => null }), undefined);
  });

  it("$mount 只挂一次；五个方法按位置参数转给命名空间服务", async () => {
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
    assert.ok(reader !== undefined);
    assert.deepEqual(await reader.providers(), { providers: [] });
    assert.deepEqual(await reader.select("alpha", "alpha-1"), {
      ok: false,
      error: "nope",
      status: 400,
    });
    await reader.migrate();
    await reader.test();
    await reader.probe();
    assert.equal(mounts, 1);
    assert.deepEqual(calls[1], ["select", { provider: "alpha", model: "alpha-1" }]);
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
            },
    };
    const reader = createOcrReader(failing);
    assert.ok(reader !== undefined);
    await assert.rejects(async () => reader.providers(), /gateway\/internal: boom/u);
    const absent = createOcrReader({
      get: (name: string): unknown =>
        name === "remote" ? { $mount: async (): Promise<void> => undefined } : undefined,
    });
    assert.ok(absent !== undefined);
    await assert.rejects(async () => absent.providers(), /未提供/u);
  });
});
