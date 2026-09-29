// 测试 fixture：ctx.settings.describe() 里 llm-pi-ai 那条的 **value**（宿主已解析
// 好的最终值，不再是 settings.yaml 文本）。形状取自宿主 pi-ai 适配器的命名空间声明：
//   providers.<name>: { displayName?, apiKeyEnv?, api, baseURL, models:[{id,name,…}] }
// models 里刻意带 contextWindow/retryPolicy 等本包不认的字段，用来验证投影是
// 「只取所需」而不是「按整份对象断言」。

import type { ProviderDescriptor } from "../../lib/provider-source.ts";

/** pi-ai 适配器里「补全式」provider 的 api 取值（本 fixture 四条里三条是它，xkiro 才是
 *  responses 那一支）。投影把它映射成 OCR 的 protocol=openai，故三条必须同字。 */
const OPENAI_COMPLETIONS_API = "openai-completions";

/** llm-pi-ai 命名空间的解析值（多 provider 形态，含空 models 与无 displayName 两条）。 */
export const PI_AI_SETTINGS_VALUE: Record<string, unknown> = {
  defaultProvider: "sensenova",
  providers: {
    sensenova: {
      displayName: "商汤日日新",
      apiKeyEnv: "SENSENOVA_API_KEY",
      api: OPENAI_COMPLETIONS_API,
      baseURL: "https://token.sensenova.cn/v1",
      models: [
        { id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 1_048_576 },
        {
          id: "sensenova-6.8-flash-lite",
          name: "sensenova-6.8-flash-lite",
          contextWindow: 262_144,
        },
      ],
    },
    xkiro: {
      displayName: "xkiro",
      apiKeyEnv: "XKIRO_API_KEY",
      api: "openai-responses",
      baseURL: "https://api.xkiro.com/v1",
      models: [{ id: "qwen/qwen3.8-max", name: "qwen/qwen3.8-max" }],
    },
    amd: {
      apiKeyEnv: "AMD_API_KEY",
      api: OPENAI_COMPLETIONS_API,
      baseURL: "https://developer.amd.com.cn/radeon/api/v1",
      models: [{ id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash" }],
    },
    antdigital: {
      displayName: "蚂蚁数科",
      apiKeyEnv: "ANTDIGITAL_API_KEY",
      api: OPENAI_COMPLETIONS_API,
      baseURL: "https://maas-api.antdigital.com/v1",
      models: [],
    },
  },
  retry: { backoff: "expo" },
};

/** describe() 的替身：两条毫不相干的命名空间 + llm-pi-ai（值即上面的解析值）。 */
export function descriptorsWithValue(value: unknown): ProviderDescriptor[] {
  return [
    { ns: "ui-theme", value: { preference: "system" } },
    { ns: "llm-pi-ai", value },
    { ns: "shell", value: { maxTimeoutMs: 600_000 } },
  ];
}

/** 默认替身：provider 齐全、四条 ref 全都能解析出值。 */
export const DEFAULT_DESCRIPTORS: ProviderDescriptor[] = descriptorsWithValue(PI_AI_SETTINGS_VALUE);

/** 本 fixture 里已配置 key 的 ref 名（凭据替身按这份名单回答）。 */
export const CONFIGURED_REFS: string[] = [
  "SENSENOVA_API_KEY",
  "XKIRO_API_KEY",
  "AMD_API_KEY",
  "ANTDIGITAL_API_KEY",
];
