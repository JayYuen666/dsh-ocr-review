// lib/provider-projection.ts —— 纯投影：settings 命名空间的解析值 → 本包要的 provider 形状。
//
// 为什么从 lib/ocr-config.ts 拆出来：这一层只认得「settings 那条值长什么样」，不认得
// ctx.settings 也不认得 credentials 通道（门面与降级状态在 lib/provider-source.ts），更不认得
// 外部 ocr CLI 的 config.json（在 lib/config-store.ts）。读侧的宽容判据（形状不合的条目整条
// 丢弃，卡片要能打开让用户去修）与「通道在不在」是两件事，此前挤在同一文件里，
// providersFromSettingsValue 的 export 只因单测按这层边界取用；生产侧的 consumer 是
// lib/provider-source.ts 的 readProviders 与 lib/ocr-config.ts（不再是「全在同文件内」
// ——拆分已经发生过一次，这条依据照抄会让人以为它仍是测试专用）。真正的分层依据是
// 上面那条：**本层不认 ctx、不认 credentials、不认 config.json**，只做纯形状投影。
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
  /** OCR config 的 protocol 值（由下面的映射表从 llm-pi-ai 的 `api` 算出；表外
   *  值原样透传，由 apply 侧白名单拒绝——绝不静默降级成 openai）。 */
  protocol: string;
  baseURL: string;
  models: DshModel[];
}

/**
 * llm-pi-ai 的 `api` 协议 → OCR config 的 `protocol` 映射。
 *
 * 两侧枚举的对照（dsh packages/llm/llm-pi-ai/src/provider.ts:44-48 的 PROTOCOLS
 * 对 OCR config_cmd.go:796 的 "Protocol values: anthropic, anthropic-bedrock,
 * openai, openai-responses"）：openai-completions 与 OCR 的 openai 是同一条
 * OpenAI Chat Completions 线协议；anthropic-messages 即 OCR 的 anthropic。
 * 此前「非 openai-responses 一律 openai」的二值映射会把 anthropic-messages 的
 * 端点按 OpenAI 线协议打出去——select 成功、OCR 调不通。表外值透传，让
 * renderSelectedConfig 的白名单给出可读错误。
 */
// Map 而非对象字面量：查表键来自用户可写的 settings 值，对象会继承 Object.prototype，
// 于是 api="constructor" 取到 Object 这个构造函数、"__proto__" 取到 Object.prototype，
// `?? api` 的原样透传兜底失效——protocol 被写成函数/对象，直接违反 `DshProvider.protocol
// 的 string 声明，还会让 apply 侧的白名单错误文案里出现 "function toString() { [native
// code] }"。Map.get 不查原型链，这两类键安全 miss 并落回「原样透传」这条正路。
const OCR_PROTOCOL_BY_API: ReadonlyMap<string, string> = new Map([
  ["openai-completions", "openai"],
  ["openai-responses", "openai-responses"],
  ["anthropic-messages", "anthropic"],
]);

/** 对象/数组形态的 `api` 的透传标记：可读，但绝不会被误认成任何合法协议名。 */
const API_UNREADABLE = "[unreadable]";

/**
 * settings 里的 `api` 字段 → 协议查表用的键。
 *
 * 三种形态必须分开，否则畸形声明会被静默降级成「能用的」配置：
 *   - 未声明（undefined / null）⇒ ""，交给 llm-pi-ai 的 openai-completions 兜底语义；
 *   - 字符串 ⇒ trim 后原样（表外值原样透传，由写侧白名单拒绝）；
 *   - 数字 / 布尔 ⇒ String()，同样落进「表外值」这条正路；
 *   - 对象 / 数组 ⇒ 固定标记。用 String(raw) 会走 Object.prototype.toString 得到
 *     "[object Object]"，那既无信息量又看着像协议名；显式标记更能说明「这里读不出来」。
 */
function apiKeyOf(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return API_UNREADABLE;
}

/** 原始 model 对象 → DshModel（缺 id 视为无效，返回 null）。 */
function modelFromRaw(modelRaw: unknown): DshModel | null {
  if (!isRecord(modelRaw)) {
    return null;
  }
  const rec = modelRaw;
  // id / name 统一 trim：全空白 id 会作为 `--model "  "` 传给外部 CLI，全空白 name 会
  // 覆盖本来有效的 id，而 `!id` 判空挡不住任何一种。
  const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
  if (!id) {
    return null;
  }
  const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
  return { id, name: name === "" ? id : name };
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
  // `api` 的「未声明」与「类型就不对」必须分开：前者按 llm-pi-ai 的
  // `request.api ?? 'openai-completions'`（discovery.ts:300）兜底成 openai，后者
  // （数字/对象/数组）字符串化后**原样透传**，让写侧白名单给出可读错误。此前两者都塌成
  // ""，于是 `api: 123` 被静默降级成 OpenAI 线协议并写进 config.json ——
  // 正是本文件批评过的「select 成功、OCR 调不通」。
  const api = apiKeyOf(entry["api"]);
  const protocol = api === "" ? "openai" : (OCR_PROTOCOL_BY_API.get(api) ?? api);
  // baseURL 同样 trim：全空白会被写入配置而 OCR 调不通，且 check !baseURL 挡不住。
  const baseURL = typeof entry["baseURL"] === "string" ? entry["baseURL"].trim() : "";
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
 *   { displayName?, apiKeyEnv?, api: openai-completions|openai-responses|anthropic-messages,
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
