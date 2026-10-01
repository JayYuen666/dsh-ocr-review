// ocr-config 纯函数测试：settings 值投影、官方通道降级状态、映射、迁移、落盘权限。
//
// 装配层在 lib/ocr-config.ts，判据分家在三层：lib/provider-projection.ts（settings 值 →
// provider 形状）、lib/provider-source.ts（通道门面与降级状态）、lib/config-store.ts
// （外部 config.json 的落点与读写）。本文件按各自的边界直接取用，与生产侧的引用关系一致。
//
// 关键约束：**不读任何宿主文件**。provider 清单与 key 状态一律来自
// test/fixtures/gateway-fixture.ts 的 DshConfigGateway 替身（宿主侧真身在
// host.ts createGateway），本包剩下的文件读写只有外部 ocr CLI 的 config.json。
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PI_AI_SETTINGS_VALUE, descriptorsWithValue } from "./fixtures/settings-fixture.ts";
import { makeGateway, NonErrorFault } from "./fixtures/gateway-fixture.ts";
import type { GatewayFixture } from "./fixtures/gateway-fixture.ts";
import {
  applyProviderSelection,
  migratePlaintextKeys,
  ocrHomeOverride,
  providersForCard,
  resolveOcrConfigPath,
} from "../lib/ocr-config.ts";
import { providersFromSettingsValue } from "../lib/provider-projection.ts";
import { markKeyFlags, readProviders } from "../lib/provider-source.ts";
import {
  buildApiKeyCmd,
  credentialScriptPath,
  defaultCredScriptPath,
  expandHomeForSeparator,
  loadOcrConfig,
  renderSelectedConfig,
} from "../lib/config-store.ts";
import type { AppliedConfig, CardPayload } from "../lib/ocr-config.ts";
import type { DshProvider } from "../lib/provider-projection.ts";
import type { ProviderSource } from "../lib/provider-source.ts";
import type { OcrPaths, SelectInput } from "../lib/config-store.ts";
import { MESSAGES } from "../lib/messages.ts";

/** 全部 ref 都能解析出值的替身（apply 走 resolve 这一问）。 */
const ALL_REFS = ["SENSENOVA_API_KEY", "XKIRO_API_KEY", "AMD_API_KEY", "ANTDIGITAL_API_KEY"];

// ── 样本值（断言与入参各钉一次；host/lib 侧那些同名私有常量一律不 import，
//    否则实现漂了测试跟着漂，判据就空转了）────────────────────────────────────
/** 外部 ocr CLI 默认配置位置的组成：home 下的目录名 + 文件名。 */
const OCR_CONFIG_DIR = ".opencodereview";
const OCR_CONFIG_FILE = "config.json";
/** 凭据脚本的文件名（lib/config-store.ts 按 pluginDir/scripts 兜底拼的就是它）。 */
const GET_CRED_FILE = "get-cred.mjs";
/** settings-fixture 里 sensenova 那条的两个模型与 baseURL。 */
const SENSENOVA_MODEL = "deepseek-v4-flash";
const SENSENOVA_LITE_MODEL = "sensenova-6.8-flash-lite";
const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";
/** pi-ai 侧的 api 取值（入参那一侧）与投影到 OCR 的 protocol（期望那一侧）：同一个字，
 *  两个角色，分成两名才留得住「api→protocol 是映射」这条判据。 */
const RESPONSES_API = "openai-responses";
const RESPONSES_PROTOCOL = "openai-responses";
/** 渲染入参样本：配置文件标签（写侧错误点名它）与 pluginDir 兜底用的目录。 */
const CONFIG_LABEL = "/tmp/ocr/config.json";
const PLUGIN_DIR_SAMPLE = "/tmp/plugin";
/** buildApiKeyCmd 的期望产物形态（本文件按「未转义的样本」断言，路径已由 helper 转义）。 */
const API_KEY_CMD = "node scripts/get-cred.mjs SENSENOVA_API_KEY";
/** 明文 key 样本，以及「只有一条明文 key」的那份 ocr config 正文。 */
const PLAINTEXT_KEY = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaa";
const PLAINTEXT_KEY_DOC = `{"custom_providers":{"sensenova":{"api_key":"${PLAINTEXT_KEY}"}}}`;

// ── 文案注入助手 ─────────────────────────────────────────────────────────────
// 本模块的错误与降级原因都是人读文案，但它是纯函数层：消息表由调用方（host.ts）
// 按官方 locale 偏好注入。测试因此统一走「host 注入中文那份」的等价路径
// （断言里的中文串与 i18n 迁移前完全一致），末尾一组双语用例注入 en 那份，
// 证明四条降级原因与全部写侧错误都随语言切换。
const { zh } = MESSAGES;
/** readProviders 的返回形态（本文件里当显式返回类型用，避免匿名重复三遍）。 */
interface ProvidersRead {
  providers: DshProvider[];
  source: ProviderSource;
}
/** migratePlaintextKeys 的回执形态。 */
interface MigrateResult {
  migrated: string[];
  skippedUnknown: string[];
}
const readOf = (gateway: GatewayFixture): ProvidersRead => readProviders(gateway, zh);
const buildApiKeyCmdOf = (scriptPath: string, envKey: string, dshHome?: string): string =>
  buildApiKeyCmd(scriptPath, envKey, dshHome, zh);
const renderOf = (input: SelectInput): string => renderSelectedConfig(input, zh);
const configPathOf = (configured: string | undefined): string =>
  resolveOcrConfigPath(configured, zh);
const homeOf = (configured: string | undefined): string | undefined => ocrHomeOverride(configured);
const cardOf = (gateway: GatewayFixture, paths: OcrPaths): Promise<CardPayload> =>
  providersForCard(gateway, paths, zh);
const selectOf = (
  gateway: GatewayFixture,
  paths: OcrPaths,
  provider: string,
  model: string,
  language?: string,
): Promise<AppliedConfig> =>
  applyProviderSelection(
    gateway,
    paths,
    { provider, model, ...(language === undefined ? {} : { language }) },
    zh,
  );
const migrateOf = (gateway: GatewayFixture, paths: OcrPaths): Promise<MigrateResult> =>
  migratePlaintextKeys(gateway, paths, zh);

let tmp: string;

/** 造一个只剩 ocr config 与插件目录的沙箱（没有任何 dsh 侧文件）。 */
function makePaths(): OcrPaths {
  tmp = mkdtempSync(path.join(tmpdir(), "ocr-config-test-"));
  const pluginDir = path.join(tmp, "plugin");
  mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  writeFileSync(path.join(pluginDir, "scripts", GET_CRED_FILE), "#!/usr/bin/env node\n");
  return {
    ocrConfigJson: path.join(tmp, OCR_CONFIG_FILE),
    homeOverride: undefined,
    pluginDir,
    getCredScript: path.join(pluginDir, "scripts", GET_CRED_FILE),
  };
}

/** 删掉 makePaths() 留下的沙箱：由真正用到它的那四组 suite 各自登记 afterEach。 */
function removeTmpSandbox(): void {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("providersFromSettingsValue", () => {
  const providers = providersFromSettingsValue(PI_AI_SETTINGS_VALUE);

  it("解析出全部 provider 且保持声明顺序", () => {
    expect(providers.map((provider) => provider.name)).toStrictEqual([
      "sensenova",
      "xkiro",
      "amd",
      "antdigital",
    ]);
  });

  it("protocol 映射：openai-completions→openai；openai-responses→openai-responses；anthropic-messages→anthropic", () => {
    expect(providers.find((provider) => provider.name === "sensenova")?.protocol).toBe("openai");
    expect(providers.find((provider) => provider.name === "xkiro")?.protocol).toBe(
      RESPONSES_PROTOCOL,
    );
    // 回归钉：anthropic-messages 是 llm-pi-ai 的合法协议（provider.ts PROTOCOLS），
    // 此前二值映射把它静默写成 openai——select 成功、OCR 按 OpenAI 线协议打
    // Anthropic 端点必然调不通。
    const anthropic = providersFromSettingsValue({
      providers: {
        relay: {
          apiKeyEnv: "RELAY_API_KEY",
          api: "anthropic-messages",
          baseURL: "https://relay.example.com",
          models: [{ id: "claude-x" }],
        },
      },
    });
    expect(anthropic[0]?.protocol).toBe("anthropic");
  });

  it("api 缺省按 llm-pi-ai 的默认 openai-completions 兜底（discovery.ts:300）；未知 api 原样透传给写侧白名单拒绝", () => {
    const value = {
      providers: {
        noApi: { apiKeyEnv: "K", baseURL: "https://n", models: [] },
        weird: { apiKeyEnv: "K", api: "smoke-signals", baseURL: "https://w", models: [] },
      },
    };
    const parsed = providersFromSettingsValue(value);
    expect(parsed[0]?.protocol).toBe("openai");
    expect(parsed[1]?.protocol).toBe("smoke-signals");
    // 写侧闸：未知协议拒绝写入，错误点名 provider 与协议值。
    expect(() =>
      renderOf({
        existingText: "{}",
        configLabel: CONFIG_LABEL,
        providers: parsed,
        provider: "weird",
        model: "m",
        apiKeyCmd: "node x K",
      }),
    ).toThrow(/无法映射到 OCR 支持的 protocol/u);
  });

  it("displayName 回退到 name；models 空数组合法", () => {
    expect(providers.find((provider) => provider.name === "amd")?.displayName).toBe("amd");
    expect(providers.find((provider) => provider.name === "antdigital")?.models).toStrictEqual([]);
  });

  it("上游多出来的字段（contextWindow/retryPolicy/defaultProvider）不影响投影", () => {
    expect(providers[0]?.models[0]).toStrictEqual({
      id: SENSENOVA_MODEL,
      name: SENSENOVA_MODEL,
    });
  });
});

describe("describe() 命名空间值里的防御分支", () => {
  const ODD_VALUE = {
    providers: {
      stringy: "nope",
      noBaseUrl: {
        apiKeyEnv: "   ",
        api: RESPONSES_API,
        models: "not-an-array",
      },
      junkModels: {
        baseURL: "https://junk",
        models: [{ id: 7, name: "数字只读" }, { id: "a" }, "scalar", { name: "无 id" }],
      },
      ok: {
        baseURL: "https://ok",
        models: [{ id: "m1", name: "Model 1" }],
      },
    },
  };

  it("形态不合的条目整条丢弃，model 缺 id 丢弃、name 缺省回退 id", () => {
    const providers = providersFromSettingsValue(ODD_VALUE);
    expect(providers.map((providerCfg) => providerCfg.name)).toStrictEqual(["junkModels", "ok"]);
    expect(providers[0]?.models).toStrictEqual([{ id: "a", name: "a" }]);
    expect(providers[0]?.apiKeyEnv).toBeNull();
    expect(providers[1]?.displayName).toBe("ok");
    expect(providers[1]?.protocol).toBe("openai");
    expect(providers[1]?.models[0]?.name).toBe("Model 1");
  });

  it("protocol 只在 api=openai-responses 时切换（apiKeyEnv 全空白视为未声明）", () => {
    const withResponses = providersFromSettingsValue({
      providers: {
        ...ODD_VALUE.providers,
        resp: { baseURL: "https://r", api: RESPONSES_API, apiKeyEnv: "R_KEY" },
      },
    });
    const resp = withResponses.find((providerCfg) => providerCfg.name === "resp");
    expect(resp?.protocol).toBe(RESPONSES_PROTOCOL);
    expect(resp?.models).toStrictEqual([]);
    expect(withResponses.find((providerCfg) => providerCfg.name === "noBaseUrl")).toBeUndefined();
  });

  it("命名空间值顶层不是对象 / providers 不是对象 ⇒ 一律空列表（读侧宽容，写侧才抛）", () => {
    expect(providersFromSettingsValue(undefined)).toStrictEqual([]);
    expect(providersFromSettingsValue("nope")).toStrictEqual([]);
    expect(providersFromSettingsValue([1, 2])).toStrictEqual([]);
    expect(providersFromSettingsValue({ other: 1 })).toStrictEqual([]);
    expect(providersFromSettingsValue({ providers: "nope" })).toStrictEqual([]);
    expect(providersFromSettingsValue({ providers: [1, 2] })).toStrictEqual([]);
  });
});

describe("readProviders：官方通道的四种降级", () => {
  it("settings + credentials 齐全 ⇒ ready，并给出 provider 清单", () => {
    const { providers, source } = readOf(makeGateway());
    expect(source.status).toBe("ready");
    expect(source.message).toBe("");
    expect(providers).toHaveLength(4);
  });

  it("settings 服务缺席 ⇒ settings-unavailable + 可读原因", () => {
    const { providers, source } = readOf(makeGateway({ health: { settings: false } }));
    expect(providers).toStrictEqual([]);
    expect(source.status).toBe("settings-unavailable");
    expect(source.message).toMatch(/ctx\.settings/u);
  });

  it("describe() 抛错（含非 Error 值）⇒ settings-failed，不抛穿", () => {
    const thrown = readOf(makeGateway({ describeThrows: new Error("boom") }));
    expect(thrown.source.status).toBe("settings-failed");
    expect(thrown.source.message).toContain("boom");
    const weird = readOf(makeGateway({ describeThrows: new NonErrorFault("not-an-error") }));
    expect(weird.source.message).toContain("not-an-error");
  });

  it("describe() 里没有 llm-pi-ai 那条 ⇒ namespace-unavailable", () => {
    const { source } = readOf(makeGateway({ descriptors: [{ ns: "ui-theme", value: {} }] }));
    expect(source.status).toBe("namespace-unavailable");
    expect(source.message).toMatch(/llm-pi-ai/u);
  });

  it("credentials 缺席 ⇒ 清单仍给出，但状态是 credentials-unavailable", () => {
    const { providers, source } = readOf(makeGateway({ health: { credentials: false } }));
    expect(providers.map((providerCfg) => providerCfg.name)).toContain("sensenova");
    expect(source.status).toBe("credentials-unavailable");
    expect(source.message).toMatch(/ctx\.credentials/u);
  });

  it("providers 形状异常（值里没有 providers）⇒ ready 但清单为空", () => {
    const { providers, source } = readOf(
      makeGateway({ descriptors: descriptorsWithValue({ defaultProvider: "x" }) }),
    );
    expect(providers).toStrictEqual([]);
    expect(source.status).toBe("ready");
  });
});

describe("markKeyFlags", () => {
  const providers = providersFromSettingsValue(PI_AI_SETTINGS_VALUE);

  it("逐 provider 问凭据服务，只回布尔", async () => {
    const gateway = makeGateway({ configured: ["SENSENOVA_API_KEY", "AMD_API_KEY"] });
    const keyed = await markKeyFlags(gateway, providers);
    expect(keyed.map((entry) => [entry.name, entry.hasKey])).toStrictEqual([
      ["sensenova", true],
      ["xkiro", false],
      ["amd", true],
      ["antdigital", false],
    ]);
    expect(gateway.describedRefs).toStrictEqual(ALL_REFS);
  });

  it("未声明 apiKeyEnv 的 provider 不去问凭据服务", async () => {
    const gateway = makeGateway();
    const keyed = await markKeyFlags(gateway, [
      {
        name: "nokey",
        displayName: "nokey",
        apiKeyEnv: null,
        protocol: "openai",
        baseURL: "https://n",
        models: [],
      },
    ]);
    expect(keyed[0]?.hasKey).toBe(false);
    expect(gateway.describedRefs).toStrictEqual([]);
  });
});

describe("buildApiKeyCmd", () => {
  it("路径含空格/单引号被 shq 转义", () => {
    const cmd = buildApiKeyCmdOf("/Users/me/my dir/scripts/get-cred.mjs", "SENSENOVA_API_KEY");
    expect(cmd).toContain("node '/Users/me/my dir/scripts/get-cred.mjs'");
    expect(cmd).toContain("'SENSENOVA_API_KEY'");
    expect(cmd).not.toContain("$");
  });

  it("非法 env key 名拒绝", () => {
    expect(() => buildApiKeyCmdOf("/x", "foo;echo pwned")).toThrow(/非法 env key/u);
  });

  it("第三参数（dsh 数据目录）追加为 get-cred 的第一档显式定位；缺省省略", () => {
    expect(buildApiKeyCmdOf("/s/get-cred.mjs", "K", "/home/t/.dsh")).toBe(
      "node '/s/get-cred.mjs' 'K' '/home/t/.dsh'",
    );
    expect(buildApiKeyCmdOf("/s/get-cred.mjs", "K")).toBe("node '/s/get-cred.mjs' 'K'");
  });
});

describe("renderSelectedConfig", () => {
  const providers = providersFromSettingsValue(PI_AI_SETTINGS_VALUE);
  const cmd = buildApiKeyCmdOf("/scripts/get-cred.mjs", "SENSENOVA_API_KEY");

  it("写入 custom_providers 且保留未知顶层键 + 其它 provider 条目", () => {
    const existing = JSON.stringify({
      provider: "sensenova",
      language: "中文",
      effort: "high",
      custom_providers: {
        sensenova: { url: "x", protocol: "openai", model: "m", api_key: "sk-old" },
        other: { url: "y", protocol: "openai", model: "n" },
      },
    });
    const out = renderOf({
      existingText: existing,
      configLabel: CONFIG_LABEL,
      providers,
      provider: "sensenova",
      model: SENSENOVA_LITE_MODEL,
      apiKeyCmd: cmd,
      language: "中文",
    });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["language"]).toBe("中文");
    expect(doc["effort"]).toBe("high");
    expect((doc["custom_providers"] as Record<string, unknown>)["other"]).toBeDefined();
    const entry = (doc["custom_providers"] as Record<string, unknown>)["sensenova"] as Record<
      string,
      unknown
    >;
    expect(entry["url"]).toBe(SENSENOVA_BASE_URL);
    expect(entry["protocol"]).toBe("openai");
    expect(entry["model"]).toBe(SENSENOVA_LITE_MODEL);
    expect(entry["api_key_cmd"]).toBe(cmd);
    expect(entry["api_key"]).toBeUndefined();
  });

  it("provider 不在 dsh 配置列表 / model 不在列表时报错", () => {
    expect(() =>
      renderOf({
        existingText: "{}",
        configLabel: CONFIG_LABEL,
        providers,
        provider: "nope",
        model: "m",
        apiKeyCmd: cmd,
      }),
    ).toThrow(/不在 dsh 配置的 llm-pi-ai\.providers 列表/u);
    expect(() =>
      renderOf({
        existingText: "{}",
        configLabel: CONFIG_LABEL,
        providers,
        provider: "sensenova",
        model: "fake-model",
        apiKeyCmd: cmd,
      }),
    ).toThrow(/不在 sensenova/u);
  });

  it("空 existing（首次配置）也能生成完整配置", () => {
    const out = renderOf({
      existingText: "",
      configLabel: CONFIG_LABEL,
      providers,
      provider: "xkiro",
      model: "qwen/qwen3.8-max",
      apiKeyCmd: cmd,
    });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["provider"]).toBe("xkiro");
    expect(doc["custom_providers"]).toBeDefined();
  });

  it("未传 language ⇒ 不新增 language 键", () => {
    const out = renderOf({
      existingText: '{"provider":"old"}',
      configLabel: CONFIG_LABEL,
      providers,
      provider: "xkiro",
      model: "qwen/qwen3.8-max",
      apiKeyCmd: cmd,
    });
    expect(JSON.parse(out) as Record<string, unknown>).not.toHaveProperty("language");
  });
});

describe("resolveOcrConfigPath（外部 ocr CLI 配置的位置）", () => {
  // 家目录由 process.env.HOME 注入，不用形参也不用 vi.mock：os.homedir() 在 POSIX 先读
  // $HOME，官方 expandHomePath 内部那次 homedir() 调用读到的是**同一个注入值**（实测两侧
  // 都是 /home/tester）。vi.mock("node:os") 做不到这点——vitest 把 node_modules 外置化，
  // 桩进不了官方件内部，会变成"本仓侧假、官方侧真"的互相矛盾。
  // 注入还有一条副产品：`startsWith(HOME)` 这类断言不再由构造必然成立——展开走偏（原样
  // 返回、或折到真家目录）就当场可抓。
  const HOME = "/home/tester";
  const savedHome = process.env["HOME"];
  beforeEach(() => {
    process.env["HOME"] = HOME;
  });
  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = savedHome;
    }
  });

  it("未设置 / 空串 / 全空白 ⇒ 按 os.homedir() 派生默认值", () => {
    const expected = path.join(HOME, OCR_CONFIG_DIR, OCR_CONFIG_FILE);
    expect(configPathOf(undefined)).toBe(expected);
    expect(configPathOf("")).toBe(expected);
    expect(configPathOf("   ")).toBe(expected);
  });

  it("非字符串（宿主配置层给了怪值）⇒ 同样回落默认路径", () => {
    expect(configPathOf(7 as unknown as string)).toBe(
      path.join(HOME, OCR_CONFIG_DIR, OCR_CONFIG_FILE),
    );
  });

  it("<X>/.opencodereview/config.json 布局被接受（含 ~ 展开到该布局的形态）", () => {
    const custom = "/data/ocr/.opencodereview/config.json";
    expect(configPathOf(custom)).toBe(custom);
    expect(configPathOf("~/.opencodereview/config.json")).toBe(
      path.join(HOME, OCR_CONFIG_DIR, OCR_CONFIG_FILE),
    );
  });

  it("布局外的一切绝对路径拒绝（OCR 无文件级覆盖，写了也读不到，宁可直接报错）", () => {
    // 此前这三条被原样接受——静默失配的源头。
    expect(() => configPathOf("~")).toThrow(/布局/u);
    expect(() => configPathOf("~/ocr/conf.json")).toThrow(/布局/u);
    expect(() => configPathOf("/etc/ocr.json")).toThrow(/布局/u);
  });

  it("ocrHomeOverride：布局内返回 X；未设置/布局外/相对路径一律 undefined（绝不抛错）", () => {
    expect(homeOf(undefined)).toBeUndefined();
    expect(homeOf("")).toBeUndefined();
    expect(homeOf("/data/ocr/.opencodereview/config.json")).toBe("/data/ocr");
    expect(homeOf("~/.opencodereview/config.json")).toBe(HOME);
    expect(homeOf("/etc/ocr.json")).toBeUndefined();
    expect(homeOf("relative/ocr.json")).toBeUndefined();
  });

  it("相对路径拒绝（会把配置写到当时的工作区，用户找不到也修不了）", () => {
    expect(() => configPathOf("ocr/config.json")).toThrow(/必须是绝对路径/u);
  });

  it("pOSIX 分隔符下 `~\\x` 不是家目录形态：仍按相对路径报错（不静默造出家目录里的怪文件）", () => {
    // 官方 expandHomePath 吃 `~\` 前缀，在 POSIX 上会折出 `<home>/\notes.txt`——
    // 一枚合法的反斜杠文件名，把用户打错的相对路径变成家目录里的怪文件，
    // 比现状（明确报"必须是绝对路径"）更坏。这一支必须由本仓拦住。
    expect(() => configPathOf(String.raw`~\notes.txt`)).toThrow(/必须是绝对路径/u);
  });

  it("windows 分隔符一侧交官方：`~\\x` 落到家目录之下（这是采纳 expandHomePath 换来的兼容面）", () => {
    // 断言写成 startsWith/endsWith 而不是 path.join(HOME, …) 等值：本机 join 是 POSIX
    // 语义，反斜杠属于文件名，等值断言会在 CI 上假红。HOME 是注入值，所以 startsWith
    // 这一条不是"由构造必然成立"——展开走偏（原样返回或折到真家目录）当场就抓得到。
    const out = expandHomeForSeparator(String.raw`~\notes.txt`, "\\");
    expect(out.startsWith(HOME)).toBe(true);
    expect(out.endsWith("notes.txt")).toBe(true);
  });

  it("两种分隔符都吃 `~/x`，且 `/` 一侧绝不吃 `~\\x`（两条前缀的归属各钉一次）", () => {
    for (const sep of ["/", "\\"]) {
      const out = expandHomeForSeparator("~/ocr/conf.json", sep);
      expect(out.startsWith(HOME)).toBe(true);
      expect(out.endsWith("conf.json")).toBe(true);
    }
    expect(expandHomeForSeparator(String.raw`~\notes.txt`, "/")).toBe(String.raw`~\notes.txt`);
  });
});

describe("credentialScriptPath / defaultCredScriptPath", () => {
  it("显式脚本路径优先", () => {
    const paths: OcrPaths = {
      ocrConfigJson: "/tmp/c.json",
      homeOverride: undefined,
      pluginDir: PLUGIN_DIR_SAMPLE,
      getCredScript: "/opt/other.mjs",
    };
    expect(credentialScriptPath(paths)).toBe("/opt/other.mjs");
  });

  it("getCredScript 为空 ⇒ 按 pluginDir 兜底，两处拼法同源", () => {
    const paths: OcrPaths = {
      ocrConfigJson: "/tmp/c.json",
      homeOverride: undefined,
      pluginDir: PLUGIN_DIR_SAMPLE,
      getCredScript: "",
    };
    expect(credentialScriptPath(paths)).toBe(defaultCredScriptPath(PLUGIN_DIR_SAMPLE));
    expect(credentialScriptPath(paths)).toContain(path.join("scripts", GET_CRED_FILE));
  });
});

describe("providersForCard（磁盘只剩外部 ocr config）", () => {
  afterEach(removeTmpSandbox);

  it("组装 providers+hasKey、当前形态、脚本就绪标记", async () => {
    const paths = makePaths();
    writeFileSync(
      paths.ocrConfigJson,
      '{"provider":"sensenova","custom_providers":{"sensenova":{"model":"m","api_key_cmd":"node x S"}}}',
    );
    const payload = await cardOf(makeGateway({ configured: ["SENSENOVA_API_KEY"] }), paths);
    expect(payload.current.provider).toBe("sensenova");
    expect(payload.current.keyIsDynamic).toBe(true);
    expect(payload.getCredReady).toBe(true);
    expect(payload.source.status).toBe("ready");
    expect(payload.providers.find((entry) => entry.name === "sensenova")?.hasKey).toBe(true);
    expect(payload.providers.find((entry) => entry.name === "xkiro")?.hasKey).toBe(false);
  });

  it("凭据服务缺席 ⇒ hasKey 全 false 且带原因（不去问，也就不会泄露）", async () => {
    const paths = makePaths();
    const gateway = makeGateway({ health: { credentials: false } });
    const payload = await cardOf(gateway, paths);
    expect(payload.providers.every((entry) => !entry.hasKey)).toBe(true);
    expect(payload.source.message).toMatch(/ctx\.credentials/u);
    expect(gateway.describedRefs).toStrictEqual([]);
  });

  it("config.json 不存在 / 坏 JSON ⇒ current 为空但卡片数据照样组装", async () => {
    const paths = makePaths();
    const missing = await cardOf(makeGateway(), paths);
    expect(missing.current.provider).toBe("");
    writeFileSync(paths.ocrConfigJson, "{ broken");
    const broken = await cardOf(makeGateway(), paths);
    expect(broken.current.provider).toBe("");
    expect(broken.source.status).toBe("ready");
  });

  it("脚本缺失 ⇒ getCredReady false", async () => {
    const paths = makePaths();
    rmSync(paths.getCredScript);
    const degraded = await cardOf(makeGateway(), paths);
    expect(degraded.getCredReady).toBe(false);
  });
});

describe("applyProviderSelection", () => {
  afterEach(removeTmpSandbox);

  it("应用成功：生成配置 + chmod 0600 + 只走 resolve 这一问", async () => {
    const gateway = makeGateway();
    const paths = makePaths();
    const applied = await selectOf(gateway, paths, "sensenova", SENSENOVA_LITE_MODEL, "English");
    expect(applied).toStrictEqual({
      provider: "sensenova",
      model: SENSENOVA_LITE_MODEL,
      url: SENSENOVA_BASE_URL,
      protocol: "openai",
    });
    expect(statSync(paths.ocrConfigJson).mode % 0o1000).toBe(0o600);
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as Record<string, unknown>;
    expect(doc["language"]).toBe("English");
    expect(gateway.resolvedRefs).toStrictEqual(["SENSENOVA_API_KEY"]);
    expect(gateway.describedRefs).toStrictEqual([]);
  });

  it("数据源不可用 ⇒ 直接抛出原因（不落半截配置）", async () => {
    const paths = makePaths();
    await expect(
      selectOf(makeGateway({ health: { credentials: false } }), paths, "amd", "x"),
    ).rejects.toThrow(/ctx\.credentials/u);
    await expect(
      selectOf(makeGateway({ health: { settings: false } }), paths, "amd", "x"),
    ).rejects.toThrow(/ctx\.settings/u);
    await expect(
      selectOf(makeGateway({ descriptors: [{ ns: "ui-theme", value: {} }] }), paths, "amd", "x"),
    ).rejects.toThrow(/llm-pi-ai/u);
    expect(existsSync(paths.ocrConfigJson)).toBe(false);
  });

  it("provider 不在 dsh 配置列表 ⇒ 拒绝", async () => {
    await expect(selectOf(makeGateway(), makePaths(), "nope", "m")).rejects.toThrow(
      /不在 dsh 配置的 llm-pi-ai\.providers 列表/u,
    );
  });

  it("provider 未声明 apiKeyEnv ⇒ 拒绝（OCR 自定义 provider 不支持无 key）", async () => {
    const gateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: { nokey: { baseURL: "https://n", models: [] } },
      }),
    });
    await expect(selectOf(gateway, makePaths(), "nokey", "m")).rejects.toThrow(/未声明 apiKeyEnv/u);
  });

  it("凭据 resolve 未命中 ⇒ 拒绝并点名 ref（错误文本里没有 key 值）", async () => {
    const gateway = makeGateway({ resolvable: [] });
    await expect(selectOf(gateway, makePaths(), "amd", "DeepSeek-V4-Flash")).rejects.toThrow(
      /API key 未配置：dsh 凭据服务未解析到 AMD_API_KEY/u,
    );
    expect(gateway.resolvedRefs).toStrictEqual(["AMD_API_KEY"]);
  });

  it("get-cred 脚本缺失时报错（防御纵深）", async () => {
    const paths = makePaths();
    rmSync(paths.getCredScript);
    await expect(selectOf(makeGateway(), paths, "sensenova", SENSENOVA_MODEL)).rejects.toThrow(
      /get-cred 脚本缺失/u,
    );
  });

  it("getCredScript 缺省时按 pluginDir 兜底解析脚本路径", async () => {
    const paths = makePaths();
    const applied = await selectOf(
      makeGateway(),
      { ...paths, getCredScript: "" },
      "sensenova",
      SENSENOVA_MODEL,
    );
    expect(applied.provider).toBe("sensenova");
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(String(doc.custom_providers["sensenova"]?.["api_key_cmd"])).toContain(
      "scripts/get-cred.mjs",
    );
  });

  it("不存在的 OCR config 首次 apply 会创建", async () => {
    const paths = makePaths();
    expect(existsSync(paths.ocrConfigJson)).toBe(false);
    await selectOf(makeGateway(), paths, "sensenova", SENSENOVA_MODEL);
    expect(existsSync(paths.ocrConfigJson)).toBe(true);
  });
});

describe("loadOcrConfig", () => {
  it("报告当前形态与 keyIsDynamic", () => {
    const withCmd = loadOcrConfig(
      '{"provider":"s","custom_providers":{"s":{"model":"m","api_key_cmd":"node x S"}}}',
    );
    expect(withCmd.current.keyIsDynamic).toBe(true);
    expect(withCmd.current.provider).toBe("s");
    const withPlain = loadOcrConfig(
      '{"provider":"s","custom_providers":{"s":{"model":"m","api_key":"sk"}}}',
    );
    expect(withPlain.current.keyIsDynamic).toBe(false);
    expect(withPlain.current.model).toBe("m");
    expect(withPlain.current.url).toBe("");
  });

  it("config 顶层非对象 / 坏 JSON / custom_providers 非对象 ⇒ 读侧一律给空 current", () => {
    expect(loadOcrConfig("[1,2]").current.provider).toBe("");
    expect(loadOcrConfig('"str"').raw).toStrictEqual({});
    expect(loadOcrConfig("{ broken").current.provider).toBe("");
    expect(loadOcrConfig('{"provider":"x","custom_providers":[]}').current.provider).toBe("x");
    expect(loadOcrConfig('{"provider":"x","custom_providers":[]}').current.model).toBe("");
  });
});

describe("renderSelectedConfig 的写侧闸门（坏 JSON 绝不覆盖用户配置）", () => {
  const providers = providersFromSettingsValue(PI_AI_SETTINGS_VALUE);
  const base = {
    configLabel: CONFIG_LABEL,
    providers,
    provider: "sensenova",
    model: SENSENOVA_MODEL,
    apiKeyCmd: API_KEY_CMD,
  };

  it("半截 JSON ⇒ 抛错并点名文件；顶层非对象同样抛错", () => {
    expect(() => renderOf({ ...base, existingText: '{ "providers": ' })).toThrow(
      /不是合法 JSON，已中止写入以保护既有配置/u,
    );
    expect(() => renderOf({ ...base, existingText: "[1,2]" })).toThrow(/顶层不是 JSON 对象/u);
    expect(renderOf({ ...base, existingText: "   " })).toContain('"provider"');
  });

  it("目标条目已有键合并写回（extra_headers/temperature/timeout_seconds 不被抹掉）", () => {
    const rendered = renderOf({
      ...base,
      existingText: JSON.stringify({
        language: "en",
        mcp_servers: { zvec: { cmd: "x" } },
        custom_providers: {
          sensenova: "非对象",
          other: { url: "keep" },
        },
      }),
    });
    const doc = JSON.parse(rendered) as {
      language: string;
      mcp_servers: Record<string, unknown>;
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.custom_providers["sensenova"]).toStrictEqual({
      url: SENSENOVA_BASE_URL,
      protocol: "openai",
      model: SENSENOVA_MODEL,
      api_key_cmd: API_KEY_CMD,
    });
    expect(doc.custom_providers["other"]).toStrictEqual({ url: "keep" });
    expect(doc.mcp_servers).toStrictEqual({ zvec: { cmd: "x" } });
    expect(doc.language).toBe("en");
  });

  it("同条目残留明文 api_key 被清除（api_key_cmd 优先）", () => {
    const rendered = renderOf({
      ...base,
      existingText: JSON.stringify({
        custom_providers: {
          sensenova: {
            api_key: "sk-abcdefghijklmnopqrstuvwxyz012345",
            extra_headers: { "x-a": "1" },
            timeout_seconds: 99,
          },
        },
      }),
    });
    const entry = (
      JSON.parse(rendered) as { custom_providers: Record<string, Record<string, unknown>> }
    ).custom_providers["sensenova"];
    expect(entry?.["api_key"]).toBeUndefined();
    expect(entry?.["extra_headers"]).toStrictEqual({ "x-a": "1" });
    expect(entry?.["timeout_seconds"]).toBe(99);
  });
});

describe("migratePlaintextKeys", () => {
  afterEach(removeTmpSandbox);

  it("把明文 api_key 换成 api_key_cmd（未知 provider 只报不动）", async () => {
    const paths = makePaths();
    writeFileSync(
      paths.ocrConfigJson,
      JSON.stringify({
        provider: "sensenova",
        custom_providers: {
          sensenova: { url: "u", protocol: "openai", model: "m", api_key: "sk-secret" },
          unknown: { url: "v", protocol: "openai", model: "n", api_key: "sk-other" },
        },
      }),
    );
    const { migrated, skippedUnknown } = await migrateOf(makeGateway(), paths);
    expect(migrated).toStrictEqual(["sensenova"]);
    expect(skippedUnknown).toStrictEqual(["unknown"]);
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.custom_providers["sensenova"]!["api_key_cmd"]).toContain("SENSENOVA_API_KEY");
    expect(doc.custom_providers["sensenova"]!["api_key"]).toBeUndefined();
    expect(doc.custom_providers["unknown"]!["api_key"]).toBe("sk-other");
  });

  it("credentials 缺席不阻断迁移（它只需要 name→apiKeyEnv 映射）", async () => {
    const paths = makePaths();
    writeFileSync(paths.ocrConfigJson, PLAINTEXT_KEY_DOC);
    const result = await migrateOf(makeGateway({ health: { credentials: false } }), paths);
    expect(result.migrated).toStrictEqual(["sensenova"]);
  });

  it("settings 侧不可用 ⇒ 拒绝（不知道该写哪条命令时不许假装迁移过了）", async () => {
    const paths = makePaths();
    writeFileSync(paths.ocrConfigJson, PLAINTEXT_KEY_DOC);
    // migratePlaintextKeys 是 async：同一 fail-loud 契约从同步 throw
    // 变成 rejected，消息与正则一字不改（断言一条没删，只是换了 vitest 的拒绝形态）。
    await expect(migrateOf(makeGateway({ health: { settings: false } }), paths)).rejects.toThrow(
      /ctx\.settings/u,
    );
    await expect(
      migrateOf(makeGateway({ descriptors: [{ ns: "ui-theme", value: {} }] }), paths),
    ).rejects.toThrow(/llm-pi-ai/u);
    const describeFaultGateway = makeGateway({ describeThrows: new NonErrorFault("nope") });
    await expect(migrateOf(describeFaultGateway, paths)).rejects.toThrow(/nope/u);
    // 抛错路径绝不写盘。
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toContain("api_key");
  });

  it("无 config / 无 custom_providers / 无 get-cred 脚本 ⇒ 空回执且不写盘", async () => {
    const paths = makePaths();
    const gateway = makeGateway();
    await expect(migrateOf(gateway, paths)).resolves.toStrictEqual({
      migrated: [],
      skippedUnknown: [],
    });
    writeFileSync(paths.ocrConfigJson, '{"provider":"x"}');
    await expect(migrateOf(gateway, paths)).resolves.toStrictEqual({
      migrated: [],
      skippedUnknown: [],
    });
    writeFileSync(paths.ocrConfigJson, PLAINTEXT_KEY_DOC);
    rmSync(paths.getCredScript);
    await expect(migrateOf(gateway, paths)).resolves.toStrictEqual({
      migrated: [],
      skippedUnknown: [],
    });
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toContain(PLAINTEXT_KEY);
  });

  it("非对象条目与无明文条目跳过，明文非法 envKey 记 unknown，全部无进展时不写盘", async () => {
    const paths = makePaths();
    const gateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: { broken: { baseURL: "https://b", apiKeyEnv: "bad-key!", models: [] } },
      }),
    });
    const before = JSON.stringify({
      custom_providers: {
        junk: "非对象",
        clean: { url: "https://c" },
        broken: { api_key: PLAINTEXT_KEY },
      },
    });
    writeFileSync(paths.ocrConfigJson, before);
    await expect(migrateOf(gateway, paths)).resolves.toStrictEqual({
      migrated: [],
      skippedUnknown: ["broken"],
    });
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toBe(before);
    expect(existsSync(`${paths.ocrConfigJson}.bak`)).toBe(false);
  });

  it("migrate 也按 pluginDir 兜底找脚本，并跳过无 apiKeyEnv 的 provider 映射", async () => {
    const paths = makePaths();
    const gateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: {
          sensenova: { baseURL: SENSENOVA_BASE_URL, apiKeyEnv: "SENSENOVA_API_KEY" },
          nokey: { baseURL: "https://n" },
        },
      }),
    });
    writeFileSync(
      paths.ocrConfigJson,
      '{"custom_providers":{"sensenova":{"api_key":"sk-aaaaaaaaaaaaaaaaaaaaaaaaaa"},"nokey":{"api_key":"sk-bbbbbbbbbbbbbbbbbbbbbbbbbb"}}}',
    );
    const result = await migrateOf(gateway, { ...paths, getCredScript: "" });
    expect(result.migrated).toStrictEqual(["sensenova"]);
    expect(result.skippedUnknown).toStrictEqual(["nokey"]);
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(String(doc.custom_providers["sensenova"]?.["api_key_cmd"])).toContain(
      "scripts/get-cred.mjs",
    );
    expect(doc.custom_providers["nokey"]?.["api_key"]).toBe("sk-bbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("migrate 成功时留 .bak（内容为改前原文）且权限收到 0600", async () => {
    const paths = makePaths();
    const before = JSON.stringify({
      custom_providers: { sensenova: { api_key: PLAINTEXT_KEY } },
    });
    writeFileSync(paths.ocrConfigJson, before);
    const result = await migrateOf(makeGateway(), paths);
    expect(result.migrated).toStrictEqual(["sensenova"]);
    expect(readFileSync(`${paths.ocrConfigJson}.bak`, "utf8")).toBe(before);
    expect(statSync(paths.ocrConfigJson).mode % 0o1000).toBe(0o600);
    expect(statSync(`${paths.ocrConfigJson}.bak`).mode % 0o1000).toBe(0o600);
  });

  it("旧文件权限比 0600 宽时写回仍收口到 0600（官方靠新 inode 携带 mode，不靠事后 chmod）", async () => {
    const paths = makePaths();
    const before = JSON.stringify({
      custom_providers: { sensenova: { api_key: PLAINTEXT_KEY } },
    });
    writeFileSync(paths.ocrConfigJson, before, { mode: 0o644 });
    expect(statSync(paths.ocrConfigJson).mode % 0o1000).toBe(0o644);
    const widened = await migrateOf(makeGateway(), paths);
    expect(widened.migrated).toStrictEqual(["sensenova"]);
    expect(statSync(paths.ocrConfigJson).mode % 0o1000).toBe(0o600);
    expect(statSync(`${paths.ocrConfigJson}.bak`).mode % 0o1000).toBe(0o600);
    // 备份必须是**改前**原文：官方件在内部直接 rename，若把 .bak 挪到写之后，
    // 备份到的就是新内容——这条与上面 :744 同向，各钉一次。
    expect(readFileSync(`${paths.ocrConfigJson}.bak`, "utf8")).toBe(before);
  });

  it("并发「应用 provider」与「一键迁移」不互相覆盖整份文档，且不留下 .lock", async () => {
    // 落盘交给异步 writeFileAtomic 之后，"读→判→写"不再同处一个 tick：
    // 不加锁时两条链各自从旧快照渲染整份文档再落盘，后写者把先写者的效果抹掉。
    // 这里的两个信号是**互不相交**的键，所以任何一侧的丢失都看得见：
    //   apply 唯一负责顶层 provider；migrate 唯一负责把 amd 的明文 key 换成 cmd。
    const paths = makePaths();
    writeFileSync(
      paths.ocrConfigJson,
      JSON.stringify({
        provider: "old",
        custom_providers: {
          sensenova: { url: SENSENOVA_BASE_URL, protocol: "openai", model: "m" },
          amd: { api_key: PLAINTEXT_KEY },
        },
      }),
    );
    const gateway = makeGateway();
    const [applied, migrated] = await Promise.all([
      selectOf(gateway, paths, "sensenova", SENSENOVA_LITE_MODEL),
      migrateOf(gateway, paths),
    ]);
    expect(applied.provider).toBe("sensenova");
    expect(migrated.migrated).toContain("amd");
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      provider: string;
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.provider).toBe("sensenova");
    expect(doc.custom_providers["amd"]?.["api_key"]).toBeUndefined();
    expect(String(doc.custom_providers["amd"]?.["api_key_cmd"])).toContain(GET_CRED_FILE);
    // 锁文件只在 RMW 期间存在；留下来说明 finally 清理没跑到（下一次请求会等到超时）。
    expect(existsSync(`${paths.ocrConfigJson}.lock`)).toBe(false);
  });

  it("坏 config.json 在 settings 可用时才报「已中止写入以保护既有配置」", async () => {
    const paths = makePaths();
    writeFileSync(paths.ocrConfigJson, "{ broken");
    await expect(migrateOf(makeGateway(), paths)).rejects.toThrow(/已中止写入以保护既有配置/u);
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toBe("{ broken");
  });
});

// ── i18n：降级原因与写侧错误都取自注入的消息表 ───────────────────────────────
describe("配置通道文案双语（en 注入）", () => {
  afterEach(removeTmpSandbox);

  const { en } = MESSAGES;

  it("四条降级原因在 en 那份里各就各位，且不残留中文", () => {
    expect(readProviders(makeGateway({ health: { settings: false } }), en).source.message).toBe(
      en.sourceSettingsUnavailable,
    );
    const faulted = makeGateway({ describeThrows: new Error("boom") });
    expect(readProviders(faulted, en).source.message).toBe(
      "calling the dsh settings service failed: boom",
    );
    const themeOnly = makeGateway({ descriptors: [{ ns: "ui-theme", value: {} }] });
    expect(readProviders(themeOnly, en).source.message).toBe(
      "the dsh configuration has no llm-pi-ai namespace: the pi-ai adapter is not installed, or no provider is configured yet",
    );
    const credless = readProviders(makeGateway({ health: { credentials: false } }), en);
    expect(credless.source.message).toBe(en.sourceCredentialsUnavailable);
    for (const text of [
      en.sourceSettingsUnavailable,
      en.sourceSettingsFailed,
      en.sourceNamespaceUnavailable,
      en.sourceCredentialsUnavailable,
    ]) {
      expect(text).not.toMatch(/[\u4E00-\u9FFF]/u);
    }
  });

  it("写侧错误（路径/坏 JSON/provider/model/env key）在 en 那份里同样是英文", async () => {
    expect(() => resolveOcrConfigPath("ocr/config.json", en)).toThrow(
      /must be absolute or start with ~/u,
    );
    expect(() => buildApiKeyCmd("/x", "foo;echo", undefined, en)).toThrow(
      /invalid env key: foo;echo/u,
    );
    const base = {
      configLabel: CONFIG_LABEL,
      providers: providersFromSettingsValue(PI_AI_SETTINGS_VALUE),
      provider: "sensenova",
      model: SENSENOVA_MODEL,
      apiKeyCmd: API_KEY_CMD,
    };
    expect(() => renderSelectedConfig({ ...base, existingText: "{ broken" }, en)).toThrow(
      /is not valid JSON; the write was aborted/u,
    );
    expect(() => renderSelectedConfig({ ...base, existingText: "[1,2]" }, en)).toThrow(
      /top level of \/tmp\/ocr\/config\.json is not a JSON object/u,
    );
    const paths = makePaths();
    await expect(
      applyProviderSelection(makeGateway(), paths, { provider: "nope", model: "m" }, en),
    ).rejects.toThrow(/provider is not in the llm-pi-ai\.providers list configured by dsh: nope/u);
  });

  it("apply 的凭据闸错误也随语言（点名 provider 与 ref，绝不含 key 值）", async () => {
    const paths = makePaths();
    const nokeyGateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: { nokey: { baseURL: "https://n", models: [] } },
      }),
    });
    await expect(
      applyProviderSelection(nokeyGateway, paths, { provider: "nokey", model: "m" }, en),
    ).rejects.toThrow(/provider nokey declares no apiKeyEnv/u);
    await expect(
      applyProviderSelection(
        makeGateway({ resolvable: [] }),
        paths,
        { provider: "amd", model: "m" },
        en,
      ),
    ).rejects.toThrow(
      /the API key of provider amd is not configured: the dsh credentials service resolved no AMD_API_KEY/u,
    );
  });

  it("卡片载荷里的 source 与 host 侧同源：注入哪份就是哪份（同一 gateway）", async () => {
    const paths = makePaths();
    const gateway = makeGateway({ health: { settings: false } });
    const zhPayload = await providersForCard(gateway, paths, MESSAGES.zh);
    const enPayload = await providersForCard(gateway, paths, MESSAGES.en);
    expect(zhPayload.source.message).not.toBe(enPayload.source.message);
    expect(enPayload.source.status).toBe(zhPayload.source.status);
  });
});
