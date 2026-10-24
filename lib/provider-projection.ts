// lib/provider-projection.ts —— 纯投影：settings 命名空间的解析值 → 本包要的 provider 形状。
//
// 为什么从 lib/ocr-config.ts 拆出来：这一层只认得「settings 那条值长什么样」，不认得
// ctx.settings 也不认得 credentials 通道（门面与降级状态在 lib/provider-source.ts），更不认得
// 外部 ocr CLI 的 config.json（在 lib/config-store.ts）。读侧的宽容判据（形状不合的条目整条
// 丢弃，卡片要能打开让用户去修）与「通道在不在」是两件事。分层依据就是
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
/** Map 而非对象字面量：查表键来自用户可写的 settings 值，对象会继承 Object.prototype，
 *  于是 api="constructor" 取到 Object 这个构造函数、"__proto__" 取到 Object.prototype，
 *  `?? api` 的原样透传兜底失效——protocol 被写成函数/对象，直接违反 `DshProvider.protocol
 *  的 string 声明，还会让 apply 侧的白名单错误文案里出现 "function toString() { [native
 *  code] }"。Map.get 不查原型链，这两类键安全 miss 并落回「原样透传」这条正路。
 *  provider 名那一侧的同款防护见文件下方的 UNUSABLE_PROVIDER_NAMES。 */
const OCR_PROTOCOL_BY_API: ReadonlyMap<string, string> = new Map([
  ["openai-completions", "openai"],
  ["openai-responses", "openai-responses"],
  ["anthropic-messages", "anthropic"],
]);

/** 不能落进 config.json `custom_providers.<name>` 的 provider 名：`__proto__` 在普通对象
 *  上是 setter（赋值被静默忽略、写入凭空丢失），`constructor` / `prototype` 是继承属性
 *  名，与写侧的普通对象赋值组合都不是普通自有键。空名/全空白名单独由 trim 判据拦。 */
const UNUSABLE_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** 1.13.3 的 `validateProviderName` 口径：点号分段不能为空或全空白。 */
function isUsableProviderName(name: string): boolean {
  if (UNUSABLE_PROVIDER_NAMES.has(name)) {
    return false;
  }
  return name.split(".").every((segment) => segment.trim() !== "");
}

/** 对象/数组形态的 `api` 的透传标记：可读，但绝不会被误认成任何合法协议名。 */
const API_UNREADABLE = "[unreadable]";

/**
 * settings 里的 `api` 字段 → 协议查表用的键；「未声明」以 null 表达。
 *
 * 四种形态必须分开，否则畸形声明会被静默降级成「能用的」配置：
 *   - 未声明（undefined / null）⇒ null，交给 llm-pi-ai 的 openai-completions 兜底语义；
 *   - 字符串 ⇒ trim 后原样，**含空串**（表外值原样透传，由写侧白名单拒绝——显式
 *     `api: ""` 在上游同样不走 `??` 默认，兜底它等于把畸形声明改写成可用配置）；
 *   - 数字 / 布尔 ⇒ String()，同样落进「表外值」这条正路；
 *   - 对象 / 数组 ⇒ 固定标记。用 String(raw) 会走 Object.prototype.toString 得到
 *     "[object Object]"，那既无信息量又看着像协议名；显式标记更能说明「这里读不出来」。
 */
function apiKeyOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
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

/** 原始 provider 对象 → DshProvider（缺 baseURL 或形状不合视为无效，返回 null）。 */
function providerFromRaw(name: string, raw: unknown): DshProvider | null {
  if (!isRecord(raw)) {
    return null;
  }
  const entry = raw;
  const apiKeyEnv =
    typeof entry["apiKeyEnv"] === "string" && entry["apiKeyEnv"].trim()
      ? entry["apiKeyEnv"].trim()
      : null;
  // `api` 的「未声明」与「类型就不对 / 显式空串」必须分开：前者按 llm-pi-ai 的
  // `request.api ?? 'openai-completions'`（discovery.ts:300）兜底成 openai；后两者
  // 字符串化后**原样透传**，让写侧白名单给出可读错误。此前空串也被兜成 ""→openai，
  // 显式写坏 `api: ""` 的 provider 会静默降级成 OpenAI 线协议——正是本文件批评过的
  // 「select 成功、OCR 调不通」。
  const api = apiKeyOf(entry["api"]);
  const protocol = api === null ? "openai" : (OCR_PROTOCOL_BY_API.get(api) ?? api);
  // baseURL 同样 trim，且必须是 http/https URL："not a url"、"ftp://…"、"javascript:…"
  // 这类形态此前能一路写进 config.json，故障延到 OCR 调用期才暴露。读侧宽容的落法
  // 是整条丢弃（卡片照常打开，用户去 settings 修），不是替用户猜一个修正值。
  const baseURL = typeof entry["baseURL"] === "string" ? entry["baseURL"].trim() : "";
  if (!baseURL || !/^https?:\/\//iu.test(baseURL)) {
    return null;
  }
  // 「models 未声明」（缺省/非数组，含显式空数组）与「声明了但每条都无效」必须分开：
  // 后者若也透传成 models=[]，写侧对空 models 是「任意 model 放行」，model 白名单
  // 就被畸形声明绕开。读侧对后者整条丢弃。
  const modelsRaw = Array.isArray(entry["models"]) ? entry["models"] : [];
  const models = modelsRaw
    .map((model) => modelFromRaw(model))
    .filter((model): model is DshModel => model !== null);
  if (modelsRaw.length > 0 && models.length === 0) {
    return null;
  }
  // displayName 与 id/name/baseURL 同一条 trim 口径：全空白是真值，会顶掉本可回退的
  // provider 名，设置卡上渲染成空白项。
  const displayName = typeof entry["displayName"] === "string" ? entry["displayName"].trim() : "";
  return {
    name,
    displayName: displayName === "" ? name : displayName,
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
    // provider 名是写侧落 `custom_providers.<name>` 的键：空名/全空白名、原型链危险键
    // 与 1.13.3 拒绝的空点号分段在投影层整条丢弃（写侧对普通对象赋值，
    // "__proto__" 是 setter、写进去会凭空丢失）。
    const usable = isUsableProviderName(name);
    const parsed = usable ? providerFromRaw(name, raw) : null;
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  // 保持命名空间里的声明顺序稳定——对常规键成立；整数样键（"2"、"1"）例外，JS 引擎
  // 按数值升序枚举它们、排在字符串键之前，与 settings 里的书写顺序可能不一致。若某个
  // 下游取「首个 provider 当默认」，整数样命名可能选到声明顺序之外的那条；这是
  // Object.entries 的枚举契约，不在投影层重排。
  return out;
}
