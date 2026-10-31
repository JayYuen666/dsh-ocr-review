// ref 语法的**层间一致**门禁：ref 名在三处被校验——宿主官方 isCredentialRefName
// （宽：^[A-Za-z_][A-Za-z0-9_]*$，小写也过）、本包投影/命令构造与 get-cred.mjs
// （严：^[A-Z0-9_]+$，ref 名要当环境变量名用）。历史上小写 ref 能过官方语法、卡片显示
// configured，却到 buildApiKeyCmd 才抛——报错离用户动作隔了两层。本文件钉：
// ① 两层严语法逐样本同判；② applyProviderSelection 在 select 时就用严语法收口。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyProviderSelection } from "../lib/ocr-config.ts";
import type { OcrPaths } from "../lib/config-store.ts";
import { CREDENTIAL_ENV_KEY } from "../lib/provider-projection.ts";
import { makeGateway } from "./fixtures/gateway-fixture.ts";
import type { ProviderDescriptor } from "../lib/provider-source.ts";
import { MESSAGES } from "../lib/messages.ts";

const { zh } = MESSAGES;

/** 投影层源码面探针：apiKeyEnvInvalid 字段是否已带出。 */
function sourceIncludes(needle: string): boolean {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../lib/provider-projection.ts"),
    "utf8",
  );
  return source.includes(needle);
}

/** get-cred.mjs 的 ref 白名单独立副本（.mjs 不便值导入；逐样本对表由本测试承担）。 */
const GET_CRED_REF_PATTERN = /^[A-Z0-9_]+$/u;

const SAMPLES = {
  accepts: ["DSH_API_KEY", "OCR_KEY_2", "A", "_X"],
  rejects: ["myKey", "apiKey", "dsh-key", "with-dash", "with.dot", "", "中文KEY", "KEY!"],
} as const;

/** 一条带小写 ref 的 provider 投影（llm-pi-ai settings 的 value 形状）。 */
function descriptorsWithLowercaseRef(): ProviderDescriptor[] {
  return [
    {
      ns: "llm-pi-ai",
      value: {
        defaultProvider: "custom",
        providers: {
          custom: {
            displayName: "custom",
            apiKeyEnv: "myKey",
            api: "openai-completions",
            baseURL: "https://example.invalid/v1",
            models: [{ id: "m", name: "m", contextWindow: 1024 }],
          },
        },
      },
    },
  ];
}

function makePaths(): OcrPaths {
  const tmp = mkdtempSync(path.join(tmpdir(), "ocr-ref-parity-"));
  const pluginDir = path.join(tmp, "plugin");
  mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  writeFileSync(path.join(pluginDir, "scripts", "get-cred.mjs"), "#!/usr/bin/env node\n");
  return {
    ocrConfigJson: path.join(tmp, "config.json"),
    homeOverride: undefined,
    pluginDir,
    getCredScript: path.join(pluginDir, "scripts", "get-cred.mjs"),
  };
}

describe("ref 语法的层间一致", () => {
  it("本包投影白名单与 get-cred.mjs 白名单对同一组样本同判", () => {
    for (const sample of SAMPLES.accepts) {
      assert.equal(CREDENTIAL_ENV_KEY.test(sample), true, `投影层拒绝了合法样本 ${sample}`);
      assert.equal(GET_CRED_REF_PATTERN.test(sample), true, `get-cred 形状拒绝 ${sample}`);
    }
    for (const sample of SAMPLES.rejects) {
      assert.equal(CREDENTIAL_ENV_KEY.test(sample), false, `投影层接受了 ${sample}`);
      assert.equal(GET_CRED_REF_PATTERN.test(sample), false, `get-cred 形状接受了 ${sample}`);
    }
  });

  it("get-cred.mjs 源码里的正则与本文件的独立副本逐字一致（漂移即红）", () => {
    const scriptPath = path.resolve(import.meta.dirname, "../scripts/get-cred.mjs");
    assert.equal(existsSync(scriptPath), true);
    const source = readFileSync(scriptPath, "utf8");
    assert.ok(
      source.includes("/^[A-Z0-9_]+$/u"),
      "get-cred.mjs 的 ref 白名单改了形状——同步更新本文件的独立副本与两层对表",
    );
  });

  it("applyProviderSelection 在 select 时就用严语法收口（小写 ref 不再等到评审运行时）", async () => {
    const gateway = makeGateway({ descriptors: descriptorsWithLowercaseRef() });
    const paths = makePaths();
    try {
      await assert.rejects(
        () =>
          applyProviderSelection(
            gateway,
            paths,
            { provider: "custom", model: "m", language: "zh" },
            zh,
          ),
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          return text.includes("myKey") && text.includes("A-Z0-9_");
        },
      );
      // 语法先拦：凭据解析面不应被问到（报错离动作最近的那次交互就给出原因）。
      assert.equal(gateway.resolvedRefs.length, 0);
      // 投影面带出无效 ref 原值：修复前它被无声置 null，报错谎称「未声明」。
      assert.ok(
        sourceIncludes("apiKeyEnvInvalid"),
        "投影层缺 apiKeyEnvInvalid 面（无效 ref 又会被无声吞掉）",
      );
    } finally {
      rmSync(path.dirname(paths.ocrConfigJson), { recursive: true, force: true });
    }
  });
});
