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
  ensureKeyScriptPointer,
  migratePlaintextKeys,
  ocrHomeOverride,
  providersForCard,
  resolveOcrConfigPath,
} from "../lib/ocr-config.ts";
import { providersFromSettingsValue } from "../lib/provider-projection.ts";
import { markKeyFlags, PI_AI_NAMESPACE, readProviders } from "../lib/provider-source.ts";
import {
  buildApiKeyCmd,
  credentialScriptPath,
  defaultCredScriptPath,
  expandHomeForSeparator,
  loadOcrConfig,
  parseApiKeyCmd,
  renderSelectedConfig,
  repointDanglingKeyScripts,
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
/** parseApiKeyCmd 用例共用的样本脚本路径与 amd 那条的真实型号。 */
const SAMPLE_SCRIPT = "/a/get-cred.mjs";
const AMD_MODEL = "DeepSeek-V4-Flash";
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
/** settings 通道抛错时的 source 状态（本文件多处断言同一个值）。 */
const SETTINGS_FAILED = "settings-failed";

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
    expect(thrown.source.status).toBe(SETTINGS_FAILED);
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

  it("providers 形状异常（值里没有 providers 表）⇒ 不报 ready，理由点名命名空间", () => {
    // 此前这条固化的是「ready + 空清单」：卡片只显示一个空的 provider 选择器且没有任何
    // 原因，apply 侧闸门放行后报 providerNotInList，把「配置形状坏了」说成
    // 「你没配这个 provider」，排查方向直接跑偏。
    const { providers, source } = readOf(
      makeGateway({ descriptors: descriptorsWithValue({ defaultProvider: "x" }) }),
    );
    expect(providers).toStrictEqual([]);
    expect(source.status).toBe("namespace-unavailable");
    expect(source.message).toContain(PI_AI_NAMESPACE);
  });

  it("health() 抛错 ⇒ 折进 settings-failed，不穿破 readProviders 的不抛契约", () => {
    const faulted = makeGateway({});
    faulted.health = () => {
      throw new Error("probe blew up");
    };
    const { providers, source } = readOf(faulted);
    expect(providers).toStrictEqual([]);
    expect(source.status).toBe(SETTINGS_FAILED);
    expect(source.message).toMatch(/probe blew up/u);
  });

  it("投影读命名空间值时抛错 ⇒ 同样折进 settings-failed，不穿破不抛契约", () => {
    // 投影会对该值做 Object.entries + 逐字段读取；宿主给的是 settings 解析值，
    // 带 getter 的对象完全可能在这里抛，而调用方（apply / migrate）依赖永不抛。
    // providers 表本身是合法对象（能过形状闸），但其中一个条目的字段读取会抛：
    // 这正是投影阶段才会发生、health / descriptors 阶段看不到的故障形态。
    const hostileEntry = Object.defineProperty({}, "baseURL", {
      get() {
        throw new Error("provider field blew up");
      },
    });
    // descriptorsWithValue 收的是**命名空间的解析值本身**（不再套一层命名空间键）
    const hostile = { providers: { bad: hostileEntry } };
    const { providers, source } = readOf(
      makeGateway({ descriptors: descriptorsWithValue(hostile) }),
    );
    expect(providers).toStrictEqual([]);
    expect(source.status).toBe(SETTINGS_FAILED);
    expect(source.message).toMatch(/provider field blew up/u);
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

  it("空串 apiKeyEnv 与 null 同义：不把空 ref 送进凭据服务", async () => {
    // 此前判据只有 === null，而 apply / migrate 侧是 === null || === ""：同一份
    // DshProvider 上两套判据，有别的构造路径送来 "" 就会去问凭据服务。
    const gateway = makeGateway();
    const keyed = await markKeyFlags(gateway, [
      {
        name: "blank",
        displayName: "blank",
        apiKeyEnv: "",
        protocol: "openai",
        baseURL: "https://n",
        models: [],
      },
    ]);
    expect(keyed[0]?.hasKey).toBe(false);
    expect(gateway.describedRefs).toStrictEqual([]);
  });

  it("单个 ref 探测失败只降级这一条，不连坐整张卡", async () => {
    // 修复前 Promise.all 整体 reject → providersForCard 抛穿到 GET /providers 的兜底，
    // 整张卡退化成 500 JSON，连其他 provider 已探到的 configured 结果一起丢。
    const gateway = makeGateway({ configured: ["SENSENOVA_API_KEY"] });
    const original = gateway.credentialConfigured;
    gateway.credentialConfigured = async (ref: string): Promise<boolean> => {
      if (ref === "XKIRO_API_KEY") {
        throw new Error("credentials service unavailable");
      }
      return original(ref);
    };
    const keyed = await markKeyFlags(gateway, providers);
    // configured 名单里只有 SENSENOVA：xkiro 探针抛错降级成 false（此刻读不到），
    // amd / antdigital 本来就没配。修复前这里整个 Promise.all reject，四个全丢。
    expect(keyed.map((entry) => [entry.name, entry.hasKey])).toStrictEqual([
      ["sensenova", true],
      ["xkiro", false],
      ["amd", false],
      ["antdigital", false],
    ]);
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

  it("win32 走双引号（ocr 在 Windows 用 cmd.exe 跑 api_key_cmd，单引号是字面字符）", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(
        buildApiKeyCmdOf(
          String.raw`C:\Program Files\p\get-cred.mjs`,
          "K",
          String.raw`C:\Users\t\.dsh`,
        ),
      ).toBe(String.raw`node "C:\Program Files\p\get-cred.mjs" "K" "C:\Users\t\.dsh"`);
      // 值内双引号翻倍；收尾反斜杠再翻倍（防 CommandLineToArgvW 吃掉收尾引号）。
      expect(buildApiKeyCmdOf(String.raw`C:\we "ird"\get-cred.mjs`, "K")).toBe(
        String.raw`node "C:\we ""ird""\get-cred.mjs" "K"`,
      );
      // 以反斜杠收尾的值没法走 String.raw：收尾反引号前的 \` 是转义反引号，而 \${ 又会把
      // 插值转义成字面量——窄化豁免，仅此一行用普通转义串。
      // oxlint-disable-next-line unicorn/prefer-string-raw
      expect(buildApiKeyCmdOf("C:\\dir\\", "K")).toBe('node "C:\\dir\\\\" "K"');
    } finally {
      if (real === undefined) {
        Reflect.deleteProperty(process, "platform");
      } else {
        Object.defineProperty(process, "platform", real);
      }
    }
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

  it("包内形状闸：provider / model 非字符串或全空白即抛错，不写盘", async () => {
    // 宿主对 HTTP body 与模型入参都不做校验，这一层就是最后一道。model 为空串时
    // 下游 `target.models.length === 0` 会无条件放行，把空 model 写进 config.json。
    const shapes = [
      { provider: "", model: "m" },
      { provider: "  ", model: "m" },
      { provider: "sensenova", model: "" },
      { provider: "sensenova", model: "  " },
    ];
    const wrote = await Promise.all(
      shapes.map(async (selection) => {
        const paths = makePaths();
        await expect(applyProviderSelection(makeGateway(), paths, selection, zh)).rejects.toThrow(
          zh.providerModelRequired,
        );
        return existsSync(paths.ocrConfigJson);
      }),
    );
    expect(wrote, "形状不合时不得留下半份配置").not.toContain(true);
  });

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
    const gateway = makeGateway({ sources: {} });
    await expect(selectOf(gateway, makePaths(), "amd", AMD_MODEL)).rejects.toThrow(
      /API key 未配置：dsh 凭据服务未解析到 AMD_API_KEY/u,
    );
    expect(gateway.resolvedRefs).toStrictEqual(["AMD_API_KEY"]);
  });

  it("key 只存在于 OCR 运行时不可达的层（env/project-env）⇒ 写盘前拒绝（假绿闸）", async () => {
    // env 层 + ref 名命中宿主净化模式（*API_KEY 全中招）⇒ OCR 子进程拿不到。
    const paths = makePaths();
    const envGateway = makeGateway({ sources: { AMD_API_KEY: "env" } });
    await expect(selectOf(envGateway, paths, "amd", AMD_MODEL)).rejects.toThrow(
      /存在于凭据层「env」，OCR 运行时取不到/u,
    );
    // 拒绝发生在写盘之前：config.json 根本没有被创建。
    expect(existsSync(paths.ocrConfigJson)).toBe(false);
    // project-env 层：get-cred 刻意不读被审查仓库，一律不可达。
    const projectGateway = makeGateway({ sources: { AMD_API_KEY: "project-env" } });
    await expect(selectOf(projectGateway, paths, "amd", AMD_MODEL)).rejects.toThrow(
      /存在于凭据层「project-env」/u,
    );
  });

  it("key 在可达层（file/user-env/env 但 ref 不命中净化模式）⇒ 照常应用", async () => {
    const userEnv = await selectOf(
      makeGateway({ sources: { SENSENOVA_API_KEY: "user-env" } }),
      makePaths(),
      "sensenova",
      SENSENOVA_MODEL,
    );
    expect(userEnv.provider).toBe("sensenova");
    const file = await selectOf(
      makeGateway({ sources: { AMD_API_KEY: "file" } }),
      makePaths(),
      "amd",
      AMD_MODEL,
    );
    expect(file.provider).toBe("amd");
    // env 层但 ref 名不被 KEY/TOKEN/SECRET/PASSWORD/DSH_ 命中 ⇒ OCR 继承得到，放行。
    const envGateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: {
          custom: {
            baseURL: "https://c",
            apiKeyEnv: "MY_UNSCRUBBED_REF",
            models: [{ id: "m", name: "m" }],
          },
        },
      }),
      sources: { MY_UNSCRUBBED_REF: "env" },
    });
    const applied = await selectOf(envGateway, makePaths(), "custom", "m");
    expect(applied.provider).toBe("custom");
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

  it("apiKeyEnv 形状不合法（解得出值也构造不出命令）⇒ 记 unknown，明文原样留着", async () => {
    // 两道闸是独立的：ref 名在可达层（reachableEnvKeys 放行），但不符合
    // ^[A-Z0-9_]+$ 时命令根本构造不出来。此时绝不能删明文——删了就只剩一条取不到
    // 东西的命令，等于把能用的凭据换成不能用的。
    const paths = makePaths();
    writeFileSync(
      paths.ocrConfigJson,
      JSON.stringify({
        provider: "weird",
        custom_providers: {
          weird: { url: "u", protocol: "openai", model: "m", api_key: "sk-keepme" },
        },
      }),
    );
    const gateway = makeGateway({
      descriptors: descriptorsWithValue({
        providers: {
          weird: { apiKeyEnv: "bad-name", api: "openai-completions", baseURL: "u", models: [] },
        },
      }),
      sources: { "bad-name": "file" },
    });
    const { migrated, skippedUnknown } = await migrateOf(gateway, paths);
    expect(migrated).toStrictEqual([]);
    expect(skippedUnknown).toStrictEqual(["weird"]);
    const doc = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      custom_providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.custom_providers["weird"]!["api_key"]).toBe("sk-keepme");
    expect(doc.custom_providers["weird"]!["api_key_cmd"]).toBeUndefined();
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

  it("无 config / 无 custom_providers ⇒ 空回执且不写盘", async () => {
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
  });

  it("缺 get-cred 脚本 ⇒ 抛错，绝不回空名单", async () => {
    // 回空名单会让端点给 200 {ok:true, migrated:[]}，卡片据此渲染成「没有需要迁移的
    // 明文 key」——把「没做」报成「没有」，用户以为明文密钥已清掉，实际还留在盘上。
    const paths = makePaths();
    writeFileSync(paths.ocrConfigJson, PLAINTEXT_KEY_DOC);
    rmSync(paths.getCredScript);
    await expect(migrateOf(makeGateway(), paths)).rejects.toThrow(/get-cred 脚本缺失/u);
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toContain(PLAINTEXT_KEY);
  });

  it("新命令解析不到值 ⇒ 明文一条都不删，记入 skippedUnknown", async () => {
    // 与 apply 的关键差别：apply 不成功就整条放弃，迁移一旦删掉明文就没有回头路。
    // sources 给空表即等价于凭据服务解析不到那条 ref（undefined = 未配置）。
    const paths = makePaths();
    writeFileSync(paths.ocrConfigJson, PLAINTEXT_KEY_DOC);
    const result = await migrateOf(makeGateway({ sources: {} }), paths);
    expect(result.migrated).toStrictEqual([]);
    expect(result.skippedUnknown).toStrictEqual(["sensenova"]);
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
        makeGateway({ sources: {} }),
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

// ── api_key_cmd 指针自愈（换 profile / 重装后不留悬空路径）────────────────────
//
// 背景：api_key_cmd 里烤的是**写那一刻**的插件安装绝对路径。插件装在 desktop 还是
// browser、profile 叫什么名字都不影响——路径一律来自 host.ts 的
// PLUGIN_DIR = import.meta.dirname。本组钉的就是「目录一变就自动拉回来」，以及三条
// 不越界的边界：当前脚本自己缺失不动、旧脚本还活着不动、读不懂的命令串不动。

describe("parseApiKeyCmd", () => {
  it("反解本包写出的两段/三段形态", () => {
    expect(parseApiKeyCmd("node '/a/scripts/get-cred.mjs' 'SENSENOVA_API_KEY'")).toStrictEqual({
      script: "/a/scripts/get-cred.mjs",
      envKey: "SENSENOVA_API_KEY",
      dshHome: undefined,
    });
    expect(
      parseApiKeyCmd("node '/a/scripts/get-cred.mjs' 'SENSENOVA_API_KEY' '/home/t/.dsh'"),
    ).toStrictEqual({
      script: "/a/scripts/get-cred.mjs",
      envKey: "SENSENOVA_API_KEY",
      dshHome: "/home/t/.dsh",
    });
  });

  it("路径里有空格或单引号也能原样反解（shq 转义的往返）", () => {
    const cmd = buildApiKeyCmd(
      "/Users/me/my dir/o'brien/get-cred.mjs",
      "XKIRO_API_KEY",
      undefined,
      zh,
    );
    expect(parseApiKeyCmd(cmd)).toStrictEqual({
      script: "/Users/me/my dir/o'brien/get-cred.mjs",
      envKey: "XKIRO_API_KEY",
      dshHome: undefined,
    });
  });

  it("串尾多余空白仍能正常反解（buildApiKeyCmd 不产生，但手改过就会）", () => {
    expect(parseApiKeyCmd(`node '${SAMPLE_SCRIPT}' 'KEY'   `)).toStrictEqual({
      script: SAMPLE_SCRIPT,
      envKey: "KEY",
      dshHome: undefined,
    });
    expect(parseApiKeyCmd(`node   '${SAMPLE_SCRIPT}'\t'KEY'`)).toStrictEqual({
      script: SAMPLE_SCRIPT,
      envKey: "KEY",
      dshHome: undefined,
    });
  });

  it("win32 双引号形态（双引号臂写出的那种）也能反解，含引号/尾部反斜杠的往返", () => {
    expect(parseApiKeyCmd(String.raw`node "C:\p\get-cred.mjs" "K" "C:\u\.dsh"`)).toStrictEqual({
      script: String.raw`C:\p\get-cred.mjs`,
      envKey: "K",
      dshHome: String.raw`C:\u\.dsh`,
    });
    // 值内 "" 是翻倍的引号；中段反斜杠是字面量（cmd 不把它当转义）。
    expect(parseApiKeyCmd(String.raw`node "C:\we ""ird""\get-cred.mjs" "K"`)).toStrictEqual({
      script: String.raw`C:\we "ird"\get-cred.mjs`,
      envKey: "K",
      dshHome: undefined,
    });
    // 收尾反斜杠在写侧被翻倍（防 CommandLineToArgvW 吃掉收尾引号），读侧按对称规则折半。
    // 期望值以反斜杠收尾——String.raw 写不出这种串（收尾反引号前的 \` 是转义反引号），
    // 规则自己也不会要求转换，这里就是普通转义串的合理用场。
    expect(parseApiKeyCmd(String.raw`node "C:\dir\\" "K"`)).toStrictEqual({
      script: "C:\\dir\\",
      envKey: "K",
      dshHome: undefined,
    });
    // 配置可能跨机迁移：同一解析源两种形态都认，不假设「写它的平台=读它的平台」。
    expect(parseApiKeyCmd(`node '${SAMPLE_SCRIPT}' 'KEY'`)).toStrictEqual({
      script: SAMPLE_SCRIPT,
      envKey: "KEY",
      dshHome: undefined,
    });
    // 双引号形态自己的三档形态不符（POSIX 先判 null 才轮到它们）：裸词 / 未闭合 /
    // 尾随空白在最后一枚 token 之后照常收口。
    expect(parseApiKeyCmd(`node ${SAMPLE_SCRIPT} "KEY"`)).toBeNull();
    expect(parseApiKeyCmd(`node "${SAMPLE_SCRIPT} 'KEY'`)).toBeNull();
    expect(parseApiKeyCmd(`node "${SAMPLE_SCRIPT}" "KEY"   `)).toStrictEqual({
      script: SAMPLE_SCRIPT,
      envKey: "KEY",
      dshHome: undefined,
    });
  });

  it("不是本包形态一律 null（宁可漏修也不猜）", () => {
    expect(parseApiKeyCmd("cat /etc/passwd")).toBeNull();
    // 只剩 "node " 这种一个 token 都没有的残串：槽位取不到值，按形态不符处理。
    expect(parseApiKeyCmd("node ")).toBeNull();
    expect(parseApiKeyCmd("node /a/get-cred.mjs KEY")).toBeNull();
    expect(parseApiKeyCmd("node '/a/get-cred.mjs' 'KEY")).toBeNull();
    expect(parseApiKeyCmd("node '/a/get-cred.mjs' 'foo;echo pwned'")).toBeNull();
    expect(parseApiKeyCmd("node '/a/get-cred.mjs' 'K' '/h' 'extra'")).toBeNull();
    expect(parseApiKeyCmd("")).toBeNull();
  });
});

/** 造一条 llm-pi-ai 形态的 provider 原始条目（这组用例只关心 api → protocol）。 */
const RAW_BASE_URL = "https://x.invalid/v1";
const RAW_API_KEY_ENV = "RAW_API_KEY";
const ANTHROPIC_MESSAGES = "anthropic-messages";

function providerRaw(api: unknown): Record<string, unknown> {
  return { baseURL: RAW_BASE_URL, apiKeyEnv: RAW_API_KEY_ENV, api };
}

describe("协议映射表不被原型链污染", () => {
  // __proto__ 在 Object.prototype 上：键走变量，方括号字面量会被 lint 的 no-proto 改写，
  // 而这里要验的恰恰是「方括号查表不命中继承属性」。
  const protoKey = "__proto__";

  it("api=constructor / __proto__ / toString 原样透传（交给写侧白名单拒绝），不取到构造函数", () => {
    const value = {
      providers: {
        ctor: providerRaw("constructor"),
        proto: providerRaw(protoKey),
        tostr: providerRaw("toString"),
        anthropic: providerRaw(ANTHROPIC_MESSAGES),
      },
    };
    expect(providersFromSettingsValue(value).map((provider) => provider.protocol)).toStrictEqual([
      "constructor",
      "__proto__",
      "toString",
      "anthropic",
    ]);
  });

  it("api 类型不对（数字/对象）不静默降级成 openai，字符串化后原样透传给白名单", () => {
    // 此前所有非字符串 api 都塌成 ""，与「未声明」共用同一条 openai 兜底，于是
    // api: 123 被写进 config.json 当成 OpenAI 线协议 —— select 成功、OCR 调不通。
    const value = {
      providers: {
        num: providerRaw(123),
        obj: providerRaw({ nested: true }),
      },
    };
    expect(providersFromSettingsValue(value).map((provider) => provider.protocol)).toStrictEqual([
      "123",
      "[unreadable]",
    ]);
  });

  it("api / baseURL / model id 的首尾空白被裁掉；全空白视作未声明", () => {
    const value = {
      providers: {
        relay: {
          baseURL: `  ${RAW_BASE_URL}  `,
          apiKeyEnv: RAW_API_KEY_ENV,
          api: `  ${ANTHROPIC_MESSAGES}  `,
          models: [{ id: "  m1  ", name: "  " }, { id: "   " }],
        },
      },
    };
    const [provider] = providersFromSettingsValue(value);
    expect(provider?.baseURL).toBe("https://x.invalid/v1");
    expect(provider?.protocol).toBe("anthropic");
    // 全空白 id 的 model 视为无效被丢弃；有效 id 被裁掉空白；全空白 name 回落到 id
    expect(provider?.models).toStrictEqual([{ id: "m1", name: "m1" }]);
  });
});

// 悬空脚本路径样本（刻意写成「已消失的 profile 安装目录」形态：它要证明的是自愈不看
// profile 叫什么名字，只看解析出来的当前路径）。
const STALE_SCRIPT = "/profiles/desktop/node_modules/pkg/scripts/get-cred.mjs";
const CURRENT_TARGET = { script: "/now/here/scripts/get-cred.mjs", dshHome: "/now/.dsh" };

/** 造一条指向 script 的 api_key_cmd 文档（带一个未知键，验证「保留未知键」）。 */
function docOf(script: string): Record<string, unknown> {
  return {
    provider: "opencodego",
    language: "中文",
    custom_providers: {
      opencodego: {
        url: "https://example.inference/v1",
        protocol: "openai",
        model: "space-bunny-free",
        temperature: 0.2,
        api_key_cmd: buildApiKeyCmd(script, "OPENCODEGO_API_KEY", "/old/.dsh", zh),
      },
    },
  };
}

function entryOf(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  return (doc["custom_providers"] as Record<string, Record<string, unknown>>)[name] ?? {};
}

describe("repointDanglingKeyScripts", () => {
  const current = CURRENT_TARGET;

  it("脚本已不存在 ⇒ 重指向当前安装目录，其余键与未知顶层键原样保留", () => {
    // current.script 必须**真实存在**：第一道闸正是「当前脚本自己都不在 ⇒ 一律不动」，
    // 拿假路径当 current 会让本例退化成那条早返回，等于没测到重指向本身。
    const paths = makePaths();
    try {
      const live = { script: paths.getCredScript, dshHome: current.dshHome };
      const doc = docOf(STALE_SCRIPT);
      const result = repointDanglingKeyScripts(doc, live, zh);
      expect(result.repointed).toStrictEqual(["opencodego"]);
      // /old/.dsh 同样已不存在 ⇒ 连同脚本路径一起换成宿主此刻解析出的 current.dshHome。
      expect(entryOf(doc, "opencodego")["api_key_cmd"]).toBe(
        buildApiKeyCmd(live.script, "OPENCODEGO_API_KEY", current.dshHome, zh),
      );
      expect(entryOf(doc, "opencodego")["temperature"]).toBe(0.2);
      expect(doc["language"]).toBe("中文");
    } finally {
      removeTmpSandbox();
    }
  });

  it("旧脚本还活着 ⇒ 一条都不动（用户显式指定优先于 pluginDir 兜底）", () => {
    const paths = makePaths();
    try {
      const live = { script: paths.getCredScript, dshHome: current.dshHome };
      // 情形一：指向的就是当前这份。
      const same = docOf(paths.getCredScript);
      expect(repointDanglingKeyScripts(same, live, zh).repointed).toStrictEqual([]);
      expect(entryOf(same, "opencodego")["api_key_cmd"]).toContain(paths.getCredScript);
      // 情形二：指向另一份**同样存在**的脚本（自制脚本 / 共享副本）。这条走的是
      // 「旧脚本还活着」而不是「就是当前这份」，两者是不同的判据。
      const elsewhere = path.join(paths.pluginDir, "scripts", "other-get-cred.mjs");
      writeFileSync(elsewhere, "#!/usr/bin/env node\n");
      const other = docOf(elsewhere);
      expect(repointDanglingKeyScripts(other, live, zh).repointed).toStrictEqual([]);
      expect(entryOf(other, "opencodego")["api_key_cmd"]).toContain(elsewhere);
    } finally {
      removeTmpSandbox();
    }
  });

  it("当前脚本自己缺失 ⇒ 一律不动（把报错留给 apply 侧）", () => {
    const doc = docOf(STALE_SCRIPT);
    const result = repointDanglingKeyScripts(
      doc,
      { script: "/no/such/get-cred.mjs", dshHome: undefined },
      zh,
    );
    expect(result.repointed).toStrictEqual([]);
    expect(entryOf(doc, "opencodego")["api_key_cmd"]).toContain("/profiles/desktop");
  });

  it("读不懂的命令串 ⇒ 不动（不插手用户手写的取用方式）", () => {
    const paths = makePaths();
    try {
      const live = { script: paths.getCredScript, dshHome: current.dshHome };
      const doc: Record<string, unknown> = {
        custom_providers: {
          mine: { api_key_cmd: "/usr/local/bin/my-own-fetcher OPENCODEGO_API_KEY" },
        },
      };
      expect(repointDanglingKeyScripts(doc, live, zh).repointed).toStrictEqual([]);
    } finally {
      removeTmpSandbox();
    }
  });

  it("非 custom_providers / 无 api_key_cmd / 明文 key 一律不产生产物", () => {
    const paths = makePaths();
    try {
      const live = { script: paths.getCredScript, dshHome: current.dshHome };
      expect(repointDanglingKeyScripts({}, live, zh).repointed).toStrictEqual([]);
      expect(
        repointDanglingKeyScripts({ custom_providers: "x" }, live, zh).repointed,
      ).toStrictEqual([]);
      expect(
        repointDanglingKeyScripts({ custom_providers: { a: { api_key: "sk-plain" } } }, live, zh)
          .repointed,
      ).toStrictEqual([]);
      expect(
        repointDanglingKeyScripts({ custom_providers: { a: "not-a-record" } }, live, zh).repointed,
      ).toStrictEqual([]);
    } finally {
      removeTmpSandbox();
    }
  });

  it("多条 provider 并存时只重指向悬空的那几条", () => {
    const paths = makePaths();
    try {
      const doc = docOf(paths.getCredScript);
      const customs = doc["custom_providers"] as Record<string, Record<string, unknown>>;
      customs["stale"] = {
        api_key_cmd: buildApiKeyCmd(
          "/profiles/desktop/pkg/get-cred.mjs",
          "AMD_API_KEY",
          undefined,
          zh,
        ),
      };
      expect(
        repointDanglingKeyScripts(
          doc,
          { script: paths.getCredScript, dshHome: current.dshHome },
          zh,
        ).repointed,
      ).toStrictEqual(["stale"]);
      expect(entryOf(doc, "opencodego")["api_key_cmd"]).toContain(paths.getCredScript);
    } finally {
      removeTmpSandbox();
    }
  });
});

describe("ensureKeyScriptPointer", () => {
  afterEach(() => {
    removeTmpSandbox();
  });

  it("悬空的 api_key_cmd 被拉回当前沙箱脚本，且权限仍是 0600", async () => {
    const paths = makePaths();
    writeFileSync(
      paths.ocrConfigJson,
      `${JSON.stringify(
        {
          provider: "opencodego",
          custom_providers: {
            opencodego: {
              model: "space-bunny-free",
              api_key_cmd: buildApiKeyCmd(STALE_SCRIPT, "OPENCODEGO_API_KEY", undefined, zh),
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await expect(ensureKeyScriptPointer(paths, zh)).resolves.toStrictEqual({
      repointed: ["opencodego"],
      checked: true,
    });
    const written = JSON.parse(readFileSync(paths.ocrConfigJson, "utf8")) as {
      custom_providers: Record<string, { api_key_cmd: string }>;
    };
    expect(written.custom_providers["opencodego"]?.api_key_cmd).toBe(
      buildApiKeyCmd(paths.getCredScript, "OPENCODEGO_API_KEY", undefined, zh),
    );
    // mode 的低九位用取模取（不进位），避开 no-bitwise：0o600 是 0o1000 内的数。
    expect(statSync(paths.ocrConfigJson).mode % 0o1000).toBe(0o600);
  });

  it("指针本就健康 ⇒ 不写盘（配置字节不变，也没有 .bak）", async () => {
    const paths = makePaths();
    const original = `${JSON.stringify(
      {
        provider: "opencodego",
        custom_providers: {
          opencodego: {
            api_key_cmd: buildApiKeyCmd(paths.getCredScript, "OPENCODEGO_API_KEY", undefined, zh),
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(paths.ocrConfigJson, original);
    await expect(ensureKeyScriptPointer(paths, zh)).resolves.toStrictEqual({
      repointed: [],
      checked: true,
    });
    expect(readFileSync(paths.ocrConfigJson, "utf8")).toBe(original);
    expect(existsSync(`${paths.ocrConfigJson}.bak`)).toBe(false);
  });

  it("没有配置文件 ⇒ 什么都不建（不凭空造出用户目录）", async () => {
    const paths = makePaths();
    await expect(ensureKeyScriptPointer(paths, zh)).resolves.toStrictEqual({
      repointed: [],
      checked: true,
    });
    expect(existsSync(paths.ocrConfigJson)).toBe(false);
  });

  it("坏 JSON / 脚本缺失 ⇒ 静默放过，绝不把工具一起拖死", async () => {
    const broken = makePaths();
    writeFileSync(broken.ocrConfigJson, "{ broken");
    await expect(ensureKeyScriptPointer(broken, zh)).resolves.toStrictEqual({
      repointed: [],
      checked: false,
    });
    removeTmpSandbox();

    const noScript = makePaths();
    rmSync(noScript.getCredScript, { force: true });
    writeFileSync(noScript.ocrConfigJson, "{}");
    await expect(ensureKeyScriptPointer(noScript, zh)).resolves.toStrictEqual({
      repointed: [],
      checked: false,
    });
  });
});
