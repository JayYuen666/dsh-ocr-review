// lib/provider-projection.ts —— 纯投影：settings 命名空间的解析值 → 本包要的 provider 形状。
//
// 为什么从 lib/ocr-config.ts 拆出来：这一层只认得「settings 那条值长什么样」，不认得
// ctx.settings 也不认得 credentials 通道（门面与降级状态在 lib/provider-source.ts），更不认得
// 外部 ocr CLI 的 config.json（在 lib/config-store.ts）。读侧的宽容判据（形状不合的条目整条
// 丢弃，卡片要能打开让用户去修）与「通道在不在」是两件事，此前挤在同一文件里，
// providersFromSettingsValue 的 export 只因单测按这层边界取用，生产侧的 consumer 全在
// ocr-config.ts 同文件内，`fallow --production` 因此把它判成「只被测试养着的导出」。
//
// 安全口径与 lib/ocr-config.ts 一致：投影只搬形状，`apiKeyEnv` 是凭据 ref 名而不是 key 值，
// 本模块不读任何凭据，返回值里也不会出现 key。

import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** llm-pi-ai 命名空间里 provider 表的字段名。 */
const PROVIDERS_FIELD = "providers";

/** provider 的单个模型（settings 值里的形状，多余字段上游加了也不影响）。 */
export interface DshModel {
  id: string;
  name: string;
}

/** settings 的 llm-pi-ai.value.providers 里一条 provider 投影出的本包所需面。 */
export interface DshProvider {
  name: string;
  displayName: string;
  /** 该 provider 的 key 在凭据服务里的 ref 名（apiKeyEnv）；未声明为 null。 */
  apiKeyEnv: string | null;
  protocol: "openai" | "openai-responses";
  baseURL: string;
  models: DshModel[];
}

/** 原始 model 对象 → DshModel（缺 id 视为无效，返回 null）。 */
function modelFromRaw(modelRaw: unknown): DshModel | null {
  if (!isRecord(modelRaw)) {
    return null;
  }
  const rec = modelRaw;
  const id = typeof rec["id"] === "string" ? rec["id"] : "";
  if (!id) {
    return null;
  }
  return { id, name: typeof rec["name"] === "string" && rec["name"] ? rec["name"] : id };
}

/** 原始 provider 对象 → DshProvider（缺 baseURL 视为无效，返回 null）。 */
function providerFromRaw(name: string, raw: unknown): DshProvider | null {
  if (!isRecord(raw)) {
    return null;
  }
  const entry = raw;
  const apiKeyEnv =
    typeof entry["apiKeyEnv"] === "string" && entry["apiKeyEnv"].trim()
      ? entry["apiKeyEnv"].trim()
      : null;
  const protocol = entry["api"] === "openai-responses" ? "openai-responses" : "openai";
  const baseURL = typeof entry["baseURL"] === "string" ? entry["baseURL"] : "";
  if (!baseURL) {
    return null;
  }
  const models = Array.isArray(entry["models"])
    ? entry["models"].map(modelFromRaw).filter((model): model is DshModel => model !== null)
    : [];
  return {
    name,
    displayName:
      typeof entry["displayName"] === "string" && entry["displayName"]
        ? entry["displayName"]
        : name,
    apiKeyEnv,
    protocol,
    baseURL,
    models,
  };
}

/**
 * settings 命名空间解析值 → provider 列表（纯投影，不含任何 key 值）。
 * 上游形状（settings 里 llm-pi-ai.providers.<name>）：
 *   { displayName?, apiKeyEnv?, api: openai-completions|openai-responses,
 *     baseURL, models?: [{id,name,…}] }
 * 形状不合的条目整条丢弃（读侧宽容：卡片要能打开让用户去修），写侧才 fail-loud。
 */
export function providersFromSettingsValue(value: unknown): DshProvider[] {
  const providers = fieldOf(value, PROVIDERS_FIELD);
  if (!isRecord(providers)) {
    return [];
  }
  const out: DshProvider[] = [];
  for (const [name, raw] of Object.entries(providers)) {
    const parsed = providerFromRaw(name, raw);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  // 保持命名空间里的声明顺序稳定（Object.entries 已是插入序，无需再排）。
  return out;
}
