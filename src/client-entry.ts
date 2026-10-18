// ocr-review 设置卡片（Client 半，build-client.mjs 打包为 client.js）。
// 功能：经官方 Typert Remote（src/remote.ts）从宿主配置服务列出可选 provider+model，
// 选择后写到外部 ocr CLI 的 config.json（key 走 api_key_cmd 动态读取，不落盘明文）；
// 附带 llm test 验证、明文 key 一键迁移，以及 effort/language/autoVerify/ocrConfigPath
// 设置行（保存条暂存-写入）。React 一律 createElement；卡片注册进 keyed
// plugins.bundle.config 槽的 **bundle 包名**键（`@jayyuen66/dsh-ocr-review`，见 BUNDLE_PKG），
// 不是裸条目 id。
//
// 界面文案全在 src/ui-messages.ts（中英两份）：apply 里 `ctx.locale.register(NS, UI_MESSAGES)`
// （官方类型化重载，两语一次交齐）+ `ctx.locale.bind(NS)` 拿到取文案函数，再以 `t` prop
// 经 slots.register 的 payload 下发
// ——语言切换由官方 @deepseek-ai/dsh-client-locale 驱动重渲染，即时生效、无需重载页面。
//
// 卡片不知道任何宿主文件路径：provider 读不到时宿主回的是**结构化状态**
// （source.status + source.message），卡片只负责把原因显示出来。
//
// 元素树用中间变量 + 抽 helper 逐层构造（避免 createElement 深层嵌套触发
// unicorn/max-nested-calls 与 max-statements/complexity）；状态/网络回调统一
// async/await + try/catch。

import { createElement, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
// 配置表单面取官方声明（type-only：产物 client.js 里对包名零引用，由 build-client.test.ts
// 的 external 判定守着），不再手抄一份 `getSnapshot: () => unknown` 的镜像。
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:73-104`，
// 文件头明写「A registrant merges this contract with `import type` and registers
// through `ctx.slots`; it never imports this package at runtime」）。本包过去没有那份
// merge，也没有手抄一份——结果是 `ctx.slots.inject("plugins.bundle.config", …)` 的槽位名
// 一直只是个自由 `string`，拼错了编译器不说话。抄一次就多一处漂移点，而属主的 dts 现在是
// 本包 devDependency，编译器可以替我们对表。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把那份 merge 载入 program 的入口（TS 会
// 顺着 `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type {
  ConfigPageForm,
  PluginActivationOwnerProps,
  PluginDetailProps,
  PluginsSubject,
} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { claimApply } from "@jayyuen66/dsh-plugin-shared/lib/card-apply";
import { diffTouched } from "@jayyuen66/dsh-plugin-shared/lib/card-diff";
import { createOcrReader } from "./remote.ts";
import type { OcrReader } from "./remote.ts";
import type { OcrSelectRequest } from "../lib/remote-shape.ts";

const NS: LocaleNs = "ocr-review";
/**
 * `plugins.bundle.config` 是 keyed 槽，宿主派发的 entryKey 就是 bundle 的 **npm 包名**：
 *   · installed dsh-client-ui-plugin-manager/lib/client.js:1821
 *     `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })`；
 *   · 同文件 :2698 `configured: ledger.bundles.has(openPkg.name)`（决定这一节画不画）；
 *   · installed dsh-client-ui-renderer/lib/client.js:1154
 *     `entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)` 逐字相等；
 *   · 契约 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
 *     「keyed by the bundle's package name」；官方占位者
 *     dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 同样写包名。
 * 写成裸条目 id（`ocr-review`）匹配不到任何 entry → 整张卡在 bundle 页面上**静默不渲染**
 * （不是回落、不是报错）。值 = 本包 package.json 的 name，且必须出现在 profile 的
 * `dsh.profile.bundles` 里；test/build-client.test.ts 从
 * `~/.dsh/profiles/web/package.json` 解析校验，不在此处硬抄一份到测试。
 * 设置命名空间**不跟着改**：下面 `ctx.configForms.get(NS)` 仍吃裸条目 id（installed
 * dsh-client-ui-settings/lib/client.js:1309-1315 把入参原样当 settings 命名空间用）。
 */
const BUNDLE_PKG = "@jayyuen66/dsh-ocr-review";

/** 未知值 → 安全字符串（非字符串给 ''）。 */
function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 未知值 → 安全数字（非 number 给 fallback）。 */
function numOf(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** 错误摘要（非 Error 抛出也要可读；catch 分支共用）。 */
function errorSummary(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/* ── providers 载荷逐字段投影（防御纵深，不加 any 断言）────────────── */

function modelOf(raw: unknown): DshModel {
  return { id: strOf(fieldOf(raw, "id")), name: strOf(fieldOf(raw, "name")) };
}

function providerOf(raw: unknown): DshProvider {
  const modelsArr = fieldOf(raw, "models");
  const models = Array.isArray(modelsArr) ? modelsArr.map((item) => modelOf(item)) : [];
  const apiKeyEnvRaw = fieldOf(raw, "apiKeyEnv");
  return {
    name: strOf(fieldOf(raw, "name")),
    displayName: strOf(fieldOf(raw, "displayName")),
    apiKeyEnv: typeof apiKeyEnvRaw === "string" ? apiKeyEnvRaw : null,
    baseURL: strOf(fieldOf(raw, "baseURL")),
    models,
    hasKey: fieldOf(raw, "hasKey") === true,
  };
}

/** 可得性来源的合法域（与 host 侧 `OcrBinarySource` 同一份取值）。形状不合即「没报」。 */
const BINARY_SOURCES = new Set(["bundled", "path", "none"]);

/**
 * 解析宿主送的可得性对象。导出是为了让「wire 键名」这条契约能被钉住：卡片与 host
 *  两处各写一份键名时，写错了的症状是状态行永远显示「未取到」，而不是任何报错。
 *
 * 只有 `source` 是必需的：其余四样各管一句附加信息，缺了就少说那一句，而不是把整行判定
 * 作废——「宿主报了 PATH 却没报版本」仍然是一条用户要看的事实。`measuredVersion` 例外，
 * 它恒在（null = 还没测过），因为「没测过」与「旧宿主不带这字段」在卡片上是同一句话。
 */
export function binaryOf(raw: unknown): OcrBinaryView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const source = strOf(raw["source"]);
  if (!BINARY_SOURCES.has(source)) {
    return null;
  }
  const path = strOf(raw["path"]);
  const channel = strOf(raw["channel"]);
  const expectedVersion = strOf(raw["expectedVersion"]);
  const installHint = strOf(raw["installHint"]);
  const measured = raw["measuredVersion"];
  return {
    source,
    ...(path === "" ? {} : { path }),
    ...(channel === "" ? {} : { channel }),
    ...(expectedVersion === "" ? {} : { expectedVersion }),
    ...(installHint === "" ? {} : { installHint }),
    measuredVersion: typeof measured === "string" ? measured : null,
  };
}

/**
 * 详情页徽标/区块/启用指引共用的取数口：读同一条 providers 载荷的 `ocrBinary` 那半。
 * 判据只在 host 的 `resolveOcrAvailability` 一处，本包三个显示面都只翻译它的结论。
 * 读取器缺席（部署没装远程面）与传输失败都归成 null：这三处只负责显示。
 */
export async function loadCliStatus(reader: OcrReader | undefined): Promise<OcrBinaryView | null> {
  if (reader === undefined) {
    return null;
  }
  try {
    return binaryOf(fieldOf(await reader.providers(), "ocrBinary"));
  } catch {
    // 读不到就是「宿主没报」：这三处贡献点的职责正是把这件事显示出来，不再叠一层错误条。
    return null;
  }
}

function providersPayloadOf(json: unknown): ProvidersPayload {
  const providersArr = fieldOf(json, "providers");
  const providers = Array.isArray(providersArr) ? providersArr.map((item) => providerOf(item)) : [];
  const currentRaw = fieldOf(json, "current");
  const current = {
    provider: strOf(fieldOf(currentRaw, "provider")),
    model: strOf(fieldOf(currentRaw, "model")),
    keyIsDynamic: fieldOf(currentRaw, "keyIsDynamic") === true,
    url: strOf(fieldOf(currentRaw, "url")),
  };
  // source 是宿主给的结构化降级状态（status + 给用户看的 message）；wire 上一切
  // 未知取值都按「不可用」处理，只有 status === "ready" 才允许渲染选择器。
  const sourceRaw = fieldOf(json, "source");
  // 装载期端点自检：宿主没跑（或旧宿主不带该字段）时为 null；形状不合按 null 处理。
  const verifyRaw = fieldOf(json, "endpointVerify");
  const endpointVerify =
    verifyRaw === null || verifyRaw === undefined
      ? null
      : { ok: fieldOf(verifyRaw, "ok") === true, message: strOf(fieldOf(verifyRaw, "message")) };
  return {
    providers,
    current,
    getCredReady: fieldOf(json, "getCredReady") === true,
    source: {
      status: strOf(fieldOf(sourceRaw, "status")),
      message: strOf(fieldOf(sourceRaw, "message")),
    },
    endpointVerify,
    ocrBinary: binaryOf(fieldOf(json, "ocrBinary")),
  };
}

/** 三行表单控件（数字/文本/下拉）共用的类名 = CARD_CSS 里 `.ocr-select{…}` 那条规则。
 *  抽出来是因为两处 input 与一处 select 必须同宽同边框：写三遍字面量时改一处漏两处，
 *  症状是设置卡里某一行的控件比其它行窄。 */
const FORM_CONTROL_CLASS = "ocr-select";

/** 小节标题的类名（卡片头、CLI 状态行、详情页区块共用；sonarjs 的重复字面量门禁）。 */
const CARD_NAME_CLASS = "ocr-card-name";

const CARD_CSS = [
  // 设置卡外壳（复刻其它自研卡片/一方 PluginCard：边框圆角卡片 + 可折叠 header）
  ".ocr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".ocr-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".ocr-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".ocr-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".ocr-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
  ".ocr-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".ocr-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".ocr-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".ocr-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".ocr-card-chevron-open{transform:rotate(180deg)}",
  ".ocr-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px;font-size:13px;line-height:1.5}",
  ".ocr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0}",
  ".ocr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);margin-top:2px}",
  ".ocr-select{flex:none;width:min(46%,240px);box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,#d8dbe2);border-radius:8px;padding:5px 8px}",
  ".ocr-btn{appearance:auto;font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2,#d8dbe2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".ocr-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".ocr-btn-primary{background:var(--dsw-alias-brand-primary,#2f6fed);border-color:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".ocr-status{font-size:12px;margin-top:6px;white-space:pre-wrap;word-break:break-word}",
  ".ocr-err{color:#c4483f}",
  ".ocr-ok{color:var(--dsw-alias-label-primary,inherit)}",
  ".ocr-muted{color:var(--dsw-alias-label-tertiary,#8a8f99)}",
].join("\n");

export interface DshModel {
  id: string;
  name: string;
}
export interface DshProvider {
  name: string;
  displayName: string;
  apiKeyEnv: string | null;
  baseURL: string;
  models: DshModel[];
  hasKey: boolean;
}
/** 宿主给的数据源状态；status 只认 "ready"，其它取值一律按不可用显示原因。 */
export interface ProviderSource {
  status: string;
  message: string;
}
/**
 * 外部 `ocr` 的可得性（`lib/cli.ts` 的 resolveOcrAvailability 那一档）+ 版本核对所需的两样。
 * 卡片自己不起进程也不判来源：`measuredVersion` 是宿主那边最近一次 `ocr version` 的落态值，
 * 没测过就是 null；现测归「检测」按钮那条 POST。
 */
export interface OcrBinaryView {
  /** "bundled" | "path" | "none"；wire 上一切未知取值按「未报」处理（见 binaryOf）。 */
  source: string;
  /** 命中的绝对路径，宿主没给（none 档）即缺席。 */
  path?: string;
  /** 那份的装法："brew" | "npm" | "unknown"；判不出来源时缺席。 */
  channel?: string;
  /** 本插件契约核对所依据的版本（`lib/cli.ts` 的 EXPECTED_OCR_CLI_VERSION）。 */
  expectedVersion?: string;
  /** 最近一次实测到的版本；null = 还没测过。 */
  measuredVersion: string | null;
  /** 装法那一句（含命令原文与版本），由 host 按来源/部署偏好组好。 */
  installHint?: string;
}
export interface ProvidersPayload {
  providers: DshProvider[];
  current: { provider: string; model: string; keyIsDynamic: boolean; url: string };
  getCredReady: boolean;
  source: ProviderSource;
  /** 装载期端点自检结果（host 在 apply 时跑一次 `ocr llm test`）；null/缺省 = 没跑。
   *  可选：上游 host 版本可能不带这个字段，卡片按「没跑」处理即可。 */
  endpointVerify?: { ok: boolean; message: string } | null;
  /** 外部 ocr 的可得性（纯 fs 判据）；null/缺省 = 宿主这侧没报，卡片显示「未取到状态」。 */
  ocrBinary?: OcrBinaryView | null;
}

/**
 * 客户端配置面：直接取官方声明
 * `@deepseek-ai/dsh-client-ui-settings/client` 的 `ConfigForm<T>`（getSnapshot / subscribe /
 * mutate / set / unset）与其 `ConfigFormSnapshot<T>`。原先那份 `getSnapshot: () => unknown`
 * 逼出下面 `cardStore` 里的 `fieldOf(snap, "status")` 逐位再解析——那只是丢失类型的补救，不是
 * 宿主契约（provider 侧已按命名空间 schema decode/derive 过快照，宿主不会送别的形状）。
 * 入口是 `ctx.configForms.get(entryId)`，`entryId` 即 profile 条目 id = 本包命名空间。
 * 本卡依赖的两条：
 *  - `set`/`unset` 多带回**受理位**：`true` 宿主受理，`false` = 拒绝或写入被跳过，只有传输
 *    失败才 reject。本卡两条都认：受理位回传到 `saveSettingsDraft`，`false` 的字段留在
 *    touched 上并报出（见下面 saveRefused 文案键）；把受理位丢掉会让「宿主没写盘」显示成
 *    「已保存」，用户无从分辨。
 *  - 交回的表单**没有 `dispose()`**：那是 provider 自己持有的共享表单，消费者无从销毁。 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/**
 * 官方 `LocaleRuntime.register` 类型化重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'ocr-review'>>`——两语（官方 `BuiltInLocaleId`
 * = `"zh" | "en"`，installed `dsh-client-locale/lib/types/locale-settings.d.ts:10-12`）
 * 必须齐、每语的键集必须等于 `UiMessages`，都由官方表达式给出。
 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视模型（官方快照的有用子集 + 兜底值）。
 *  `status`/`writable` 两位出自**同一个**官方源：属主包交给配置页的那份状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:150-155`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。原先 `status` 已经从 `ConfigFormSnapshot` 取，`writable` 却还是手抄的裸
 *  `boolean`——两位两个来源就各漂各的，现在同源了。宿主把 status 的取值域或 writable 的
 *  必选性一改，这里当场红。
 *  两者都成立才可写，故保持**必选**，不再用 `unknown` 假装宿主会送别的形状；`value` 是本卡
 *  的兜底收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
export interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

export function cardStore(scope: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | null = null;
  let cachedView: CardSnapshot | null = null;
  // 只作 TS 收窄兜底：官方 getSnapshot() 恒回一个快照，首次调用即走上面的赋值分支。
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  return {
    getSnapshot() {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          // 官方 value 在首个快照受理前是 undefined，这里落到空对象供渲染。
          value: snap.value ?? {},
        };
      }
      return cachedView ?? EMPTY_SNAPSHOT;
    },
    subscribe(listener) {
      return scope.subscribe(listener);
    },
  };
}

export function SaveBar(props: {
  t: Translate;
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { t } = props;
  const disabled = !props.writable || props.busy;
  const btnStyle: Record<string, string> = {
    appearance: "auto",
    font: "inherit",
    fontSize: "12px",
    cursor: disabled || !props.dirty ? "not-allowed" : "pointer",
    borderRadius: "6px",
    padding: "4px 12px",
    border: "1px solid var(--dsw-alias-border-l2,#d8dbe2)",
    background: "var(--dsw-alias-bg-layer-1,transparent)",
    color: "var(--dsw-alias-label-primary,inherit)",
    opacity: disabled ? "0.5" : "1",
  };
  const saveBtn = createElement(
    "button",
    {
      type: "button",
      "data-field": "save",
      disabled: disabled || !props.dirty,
      onClick: props.onSave,
      style: {
        ...btnStyle,
        background: "var(--dsw-alias-brand-primary,#2f6fed)",
        borderColor: "var(--dsw-alias-brand-primary,#2f6fed)",
        color: "var(--dsw-alias-label-primary-foreground,#fff)",
      },
    },
    props.busy ? t("saving") : t("save"),
  );
  const discardBtn = createElement(
    "button",
    {
      type: "button",
      "data-field": "discard",
      disabled: disabled || !props.dirty,
      onClick: props.onDiscard,
      style: btnStyle,
    },
    t("revert"),
  );
  const dirtyText = props.dirty ? t("statusDirty") : t("statusClean");
  let statusNode: ReactNode;
  if (props.error !== null) {
    statusNode = createElement("span", { style: { fontSize: 12, color: "#c4483f" } }, props.error);
  } else if (props.writable) {
    statusNode = createElement(
      "span",
      { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8a8f99)" } },
      dirtyText,
    );
  } else {
    statusNode = createElement(
      "span",
      { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8a8f99)" } },
      t("statusReadOnly"),
    );
  }
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "10px 0 2px",
        borderTop: "1px dashed var(--dsw-alias-border-l2,#d8dbe2)",
        marginTop: 6,
        flexWrap: "wrap",
      },
    },
    saveBtn,
    discardBtn,
    statusNode,
  );
}

/** 设置卡外壳：复刻同款自研卡片（边框圆角卡片 + 可折叠 header + chevron）。 */
function OcrPluginCard(props: {
  title: string;
  description: string;
  children?: ReactNode;
}): ReactNode {
  const { title, description, children } = props;
  const [open, setOpen] = useState(false);
  const pathKey = "d";
  const headRow = createElement(
    "span",
    { className: "ocr-card-head" },
    createElement("span", { className: CARD_NAME_CLASS }, title),
    createElement("span", { className: "ocr-card-desc" }, description),
  );
  const chevron = createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      "aria-hidden": true,
      className: `ocr-card-chevron${open ? " ocr-card-chevron-open" : ""}`,
    },
    createElement("path", {
      [pathKey]: "M3 5l4 4 4-4",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
  const header = createElement(
    "button",
    {
      type: "button",
      className: "ocr-card-header",
      "aria-expanded": open,
      onClick: () => {
        setOpen(!open);
      },
    },
    headRow,
    chevron,
  );
  const body = open ? createElement("div", { className: "ocr-card-body" }, children) : null;
  // 根节点是 div 而不是 li：宿主把本卡放进 PackageDetail 的 <section data-plugin-config>
  // 与 SlotOutlet 的 <div data-slot>，两处都不是列表，li 在此是非法嵌套。本卡靠 class 画
  // 外观，不需要列表语义。
  return createElement(
    "div",
    { className: `ocr-card${open ? " ocr-card-open" : ""}` },
    header,
    body,
  );
}

interface NumberRowProps {
  label: string;
  hint: string;
  field: string;
  value: number;
  min: number;
  /** undefined = 不设上限（如 timeoutMinutes/maxComments 的"0=不限/全量"语义）。 */
  max?: number;
  disabled: boolean;
  onCommit: (num: number) => void;
}

/** 整数数字输入行（保存条模式：合法输入上报草稿，不直写）。 */
function NumberRow(props: NumberRowProps): ReactNode {
  const { label, hint, value, min, max, disabled, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const stage = (): void => {
    const parsed = Number(draft);
    if (Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)) {
      onCommit(parsed);
    }
  };
  return createElement(
    "div",
    { className: "ocr-row" },
    createElement(
      "div",
      { style: { minWidth: 0, marginRight: 12 } },
      createElement("div", {}, label),
      createElement("div", { className: "ocr-hint" }, hint),
    ),
    createElement("input", {
      type: "number",
      "data-field": props.field,
      value: draft,
      min,
      max,
      disabled,
      "aria-label": label,
      onChange: (ev: { target: { value: string } }) => {
        setDraft(ev.target.value);
        stage();
      },
      onKeyDown: (ev: { key: string; preventDefault: () => void }) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          stage();
        }
      },
      className: FORM_CONTROL_CLASS,
    }),
  );
}

interface TextRowProps {
  label: string;
  hint: string;
  field: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (text: string) => void;
}

/** 文本输入行（保存条模式：改动只上报草稿）。空串是合法取值（= 用宿主默认位置），
 *  所以不像 NumberRow 那样要求「解析成功」才上报。 */
function TextRow(props: TextRowProps): ReactNode {
  const { label, hint, value, placeholder, disabled, onCommit } = props;
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const stage = (): void => {
    onCommit(draft.trim());
  };
  return createElement(
    "div",
    { className: "ocr-row" },
    createElement(
      "div",
      { style: { minWidth: 0, marginRight: 12 } },
      createElement("div", {}, label),
      createElement("div", { className: "ocr-hint" }, hint),
    ),
    createElement("input", {
      type: "text",
      "data-field": props.field,
      value: draft,
      placeholder,
      disabled,
      "aria-label": label,
      className: FORM_CONTROL_CLASS,
      style: { width: "min(60%,320px)" },
      onChange: (ev: { target: { value: string } }) => {
        setDraft(ev.target.value);
        stage();
      },
      onKeyDown: (ev: { key: string; preventDefault: () => void }) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          stage();
        }
      },
    }),
  );
}

interface SelectRowProps {
  label: string;
  hint: string;
  field: string;
  options: { value: string; label: string; disabled?: boolean }[];
  current: unknown;
  disabled: boolean;
  onChange: (field: string, value: string) => void;
}

function SelectRow(props: SelectRowProps): ReactNode {
  const current = typeof props.current === "string" ? props.current : "";
  const options = props.options.map((option) =>
    createElement(
      "option",
      { key: option.value, value: option.value, disabled: option.disabled === true },
      option.label,
    ),
  );
  const labelBlock = createElement(
    "div",
    { style: { minWidth: 0, marginRight: 12 } },
    createElement("div", {}, props.label),
    createElement("div", { className: "ocr-hint" }, props.hint),
  );
  const select = createElement(
    "select",
    {
      className: FORM_CONTROL_CLASS,
      "aria-label": props.label,
      value: current,
      disabled: props.disabled,
      onChange: (ev: { target: { value: string } }) => {
        props.onChange(props.field, ev.target.value);
      },
    },
    options,
  );
  return createElement("div", { className: "ocr-row" }, labelBlock, select);
}

export interface OcrCardDeps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  data: ProvidersPayload | null;
  fetchError: string | null;
  /** 哪条动作正在飞（四条动作共用一个传输口与一份回执位，故同一时刻只允许一条）；
   *  null = 空闲。按钮按「有没有动作在飞」禁用，但只有**自己**那条在飞时才改自己的文案——
   *  否则按下「检测版本」会让「应用」按钮读成「应用中…」，把没发生过的事报给用户。 */
  busy: CardActionKind | null;
  actionMsg: { ok: boolean; text: string } | null;
  ready: boolean;
  writable: boolean;
  effectiveProvider: string;
  effectiveModel: string;
  chosenProvider: DshProvider | undefined;
  modelOptions: DshModel[];
  keyHint: string;
  statusHint: string | null;
  /** 外部 ocr 的可得性（fs 判据，随 providers 载荷来）；null = 宿主没报。 */
  binary: OcrBinaryView | null;
  /** 最近一次 `ocr version` 的回执；null = 还没检测过。 */
  probeMsg: { ok: boolean; text: string } | null;
  effortValue: unknown;
  languageValue: unknown;
  autoVerifyValue: unknown;
  maxCommentsValue: number;
  timeoutMinutesValue: number;
  ocrConfigPathValue: string;
  dirty: boolean;
  settingsBusy: boolean;
  saveError: string | null;
  onPickProvider: (name: string) => void;
  onPickModel: (name: string) => void;
  onApply: () => void;
  onTest: () => void;
  onMigrate: () => void;
  onProbe: () => void;
  onField: (field: string, value: unknown) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** provider 下拉项文本（没有 key 的加后缀并被禁用）。提成模块级函数是为了不把
 *  带插值的 t() 嵌进 createElement（unicorn/max-nested-calls 上限 3）。 */
export function providerOptionLabel(t: Translate, provider: DshProvider): string {
  return `${provider.displayName}${provider.hasKey ? "" : t("noKeySuffix")}`;
}

/** 当前 OCR 配置那一行（官方 Translate 的 {name} 插值）。 */
export function currentConfigText(t: Translate, current: ProvidersPayload["current"]): string {
  return t("currentConfig", {
    provider: current.provider,
    modelPart: current.model === "" ? "" : t("modelPart", { model: current.model }),
    keyPart: t(current.keyIsDynamic ? "dynamicKey" : "plainKeyWarning"),
  });
}

/** 装法枚举到文案键：查表而不是嵌套三元（本仓 lint 禁嵌套三元），查不到就是「未识别」那一档。 */
const CHANNEL_KEYS: Record<string, "channelBrew" | "channelNpm" | "channelUnknown"> = {
  brew: "channelBrew",
  npm: "channelNpm",
};

/** 那份 CLI 是怎么装上的，翻成人话。判不出来源（含 host 没报这一档）不猜。 */
function channelText(t: Translate, channel: string | undefined): string {
  return t(CHANNEL_KEYS[channel ?? ""] ?? "channelUnknown");
}

/**
 * 外部 CLI 可得性那一行的文本。三档来源与「宿主没报」四种说法，判据全在 host 侧
 * （`lib/cli.ts` 的 resolveOcrAvailability），卡片只翻译结论——两处各算各的就会漂。
 */
export function binaryStatusText(t: Translate, binary: OcrBinaryView | null): string {
  if (binary === null) {
    return t("binaryUnknown");
  }
  if (binary.source === "bundled") {
    return t("binaryBundled", {
      path: binary.path ?? "",
      channel: channelText(t, binary.channel),
    });
  }
  if (binary.source === "path") {
    return t("binaryPath", { path: binary.path ?? "", channel: channelText(t, binary.channel) });
  }
  return t("binaryNone");
}

/**
 * 版本核对那一行：「插件按哪一版核对」恒说，「本机是哪一版」只在测过之后才说。
 * 没测过时不编造任何结论，也不在这里重复「点检测」——那句在按钮本身与区块指路里已经有了。
 */
export function cliVersionText(t: Translate, binary: OcrBinaryView | null): string {
  if (binary?.expectedVersion === undefined) {
    return "";
  }
  const expected = binary.expectedVersion;
  const lines = [t("versionExpected", { expected })];
  if (binary.measuredVersion !== null) {
    lines.push(
      binary.measuredVersion === expected
        ? t("versionMatched", { actual: binary.measuredVersion })
        : t("versionDiverged", { actual: binary.measuredVersion, expected }),
    );
  }
  return lines.join(" · ");
}

/**
 * 装法那一行：只在两条路都没有候选时出现。已装着的时候这条是噪音——那种情况下用户要的是
 * 「哪一份、什么版本、要不要换」，那两行已经说了。
 */
export function cliInstallText(binary: OcrBinaryView | null): string {
  if (binary?.source !== "none") {
    return "";
  }
  return binary.installHint ?? "";
}

/** 一条错误提示行的类名（多处在用；sonarjs 的重复字面量门禁要求收成常量）。 */
const STATUS_ERROR_CLASS = "ocr-status ocr-err";

/** 一条成功/失败回执行的类名（动作条、探测回执共用）。 */
function statusClass(ok: boolean): string {
  return `ocr-status ${ok ? "ocr-ok" : "ocr-err"}`;
}

/**
 * 外部 CLI 状态行：可得性 + 「检测」按钮 + 最近一次探测回执。
 *
 * 刻意画在 provider 表单**之外**（provider 源不可用时也要看得见）——「这台机器有没有
 * ocr」与「宿主能不能列出 provider」是两件事，混在一支里会让缺 CLI 的机器连原因都看不到。
 * 回执用 `.ocr-status`（`white-space:pre-wrap`）而不是输入框：那段文本里就有上游给的
 * `npm i -g …` 命令，要能选中复制，而本包不提供剪贴板 API（非安全上下文会静默失败）。
 */
export function buildCliStatusRow(deps: OcrCardDeps): ReactNode {
  const { t } = deps;
  const label = createElement("div", { className: CARD_NAME_CLASS }, t("binaryTitle"));
  const button = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      disabled: deps.busy !== null,
      onClick: deps.onProbe,
      "data-field": "probe",
    },
    deps.busy === "probe" ? t("detecting") : t("detectCli"),
  );
  const row = createElement(
    "div",
    { className: "ocr-row", style: { justifyContent: "flex-start", gap: 8 } },
    label,
    button,
  );
  const statusText = binaryStatusText(t, deps.binary);
  const status = createElement("div", { className: "ocr-hint" }, statusText);
  const versionText = cliVersionText(t, deps.binary);
  const versionLine =
    versionText === "" ? null : createElement("div", { className: "ocr-hint" }, versionText);
  const hintText = cliInstallText(deps.binary);
  const installLine =
    hintText === "" ? null : createElement("div", { className: "ocr-hint" }, hintText);
  const probe = deps.probeMsg
    ? createElement(
        "div",
        { className: statusClass(deps.probeMsg.ok), "data-field": "probe-result" },
        deps.probeMsg.text,
      )
    : null;
  return createElement(
    "div",
    { style: { padding: "2px 0" }, "data-field": "cli-status" },
    row,
    status,
    versionLine,
    installLine,
    probe,
  );
}

/**
 * 徽标用的短文案（标题旁那只标签放不下整句装法）。与 `binaryStatusText` 同一判据、
 * 不同长度：两处各算一份「哪一档」就会漂，所以入参仍是 host 送的那份 `OcrBinaryView`。
 *
 * 「实测过且与核对版本不一致」压过来源那一档：用户扫一眼列表要看到的结论是「这份 CLI
 * 与本插件不同版本」，来源在哪一行里已经写了。没实测过就不压——那时不一致与否无从谈起。
 */
export function cliBadgeText(t: Translate, binary: OcrBinaryView | null): string {
  if (binary === null) {
    return t("badgeUnknown");
  }
  const diverged =
    binary.expectedVersion !== undefined &&
    binary.measuredVersion !== null &&
    binary.measuredVersion !== binary.expectedVersion;
  if (diverged) {
    return t("badgeDiverged");
  }
  if (binary.source === "bundled") {
    return t("badgeBundled");
  }
  if (binary.source === "path") {
    return t("badgePath");
  }
  return t("badgeNone");
}

/** 这页说的是不是本包（bundle 页与它的行页都算；官方插件页 `item` 没有包名可比）。
 *  导出是因为「在别人插件的页上白拉一次自己的端点」这条判据只能在这里钉。 */
export function isOwnSubject(subject: PluginsSubject): boolean {
  return subject.kind !== "item" && subject.pkg.name === BUNDLE_PKG;
}

/** 徽标那枚元素（状态已到才画；取状态与 subject 过滤留给组件，用例才不必起渲染器）。 */
export function buildCliBadge(t: Translate, status: OcrBinaryView | null): ReactNode {
  return createElement(
    "span",
    { className: "ocr-hint", "data-field": "cli-badge" },
    cliBadgeText(t, status),
  );
}

/** 详情页/启用指引这几处贡献点共用的注入面：取文案的口 + 取可得性的口。 */
export interface CliStatusShare {
  t: Translate;
  loadCliStatus: () => Promise<OcrBinaryView | null>;
}

/**
 * 订阅一次外部 CLI 可得性（GET providers 的 `ocrBinary` 那半，纯 fs 判据、不起进程）。
 *
 * `active` 为假（这页说的不是本包）时既不发请求也不画东西：官方契约是「对无话可说的
 * subject 渲染 null」，在别人插件的页面上拉一次自己的端点属于白干的活。
 * @returns undefined = 还没回来（渲染 null，不闪「状态未知」）；null = 宿主没报。
 */
function useCliStatus(
  active: boolean,
  load: () => Promise<OcrBinaryView | null>,
): OcrBinaryView | null | undefined {
  const [status, setStatus] = useState<OcrBinaryView | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const settle = (value: OcrBinaryView | null): void => {
      if (alive) {
        setStatus(value);
      }
    };
    const run = async (): Promise<void> => {
      try {
        settle(await load());
      } catch {
        settle(null);
      }
    };
    if (active) {
      void run();
    }
    return (): void => {
      alive = false;
    };
  }, [active, load]);
  return status;
}

/** 详情页标题旁的徽标：一句话说明外部 ocr 从哪条路来（或压根没有）。 */
export function OcrCliBadge(props: CliStatusShare & PluginDetailProps): ReactNode {
  const mine = isOwnSubject(props.subject);
  const status = useCliStatus(mine, props.loadCliStatus);
  if (!mine || status === undefined) {
    return null;
  }
  return buildCliBadge(props.t, status);
}

/** 区块体：标题 + 完整状态那一行 + 版本核对那一行 + 装法（没装时）+ 指路那一句。 */
export function buildCliSection(t: Translate, status: OcrBinaryView | null): ReactNode {
  const title = createElement("div", { className: CARD_NAME_CLASS }, t("binaryTitle"));
  const body = createElement("div", { className: "ocr-hint" }, binaryStatusText(t, status));
  const versionText = cliVersionText(t, status);
  const versionLine =
    versionText === "" ? null : createElement("div", { className: "ocr-hint" }, versionText);
  const hintText = cliInstallText(status);
  const installLine =
    hintText === "" ? null : createElement("div", { className: "ocr-hint" }, hintText);
  const hint = createElement("div", { className: "ocr-hint" }, t("binaryProbeHint"));
  return createElement(
    "div",
    { style: { padding: "8px 0" }, "data-field": "cli-section" },
    title,
    body,
    versionLine,
    installLine,
    hint,
  );
}

/** 详情页下方的区块：完整状态 + 「版本号要在配置卡片里点检测」的指路。 */
export function OcrCliSection(props: CliStatusShare & PluginDetailProps): ReactNode {
  const mine = isOwnSubject(props.subject);
  const status = useCliStatus(mine, props.loadCliStatus);
  if (!mine || status === undefined) {
    return null;
  }
  return buildCliSection(props.t, status);
}

/**
 * 启用指引的内容：一句「两条路都没找到」+ 带版本的装法 + 去详情页 / 收起这两个动作。
 * 动作回调由宿主给（`onOpenDetails` 顺带把用户送到本包配置页，那里才有「检测」按钮）。
 * @param t - 文案口。
 * @param props - 只取那两个动作回调。
 * @param install - 装法那一句（host 按核对版本与部署偏好组好的原文）。
 */
export function buildCliActivation(
  t: Translate,
  props: Pick<PluginActivationOwnerProps, "onOpenDetails" | "onDismiss">,
  install: string,
): ReactNode {
  const text = createElement("div", { className: STATUS_ERROR_CLASS }, t("binaryNone"));
  const installLine =
    install === "" ? null : createElement("div", { className: "ocr-hint" }, install);
  const details = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      onClick: props.onOpenDetails,
      "data-field": "guide-details",
    },
    t("binaryGuideDetails"),
  );
  const dismiss = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      onClick: props.onDismiss,
      "data-field": "guide-dismiss",
    },
    t("binaryGuideDismiss"),
  );
  return createElement(
    "div",
    { style: { padding: "8px 0", display: "flex", gap: 8 }, "data-field": "cli-activation" },
    text,
    installLine,
    details,
    dismiss,
  );
}

/**
 * 启用后的一次性指引：只在「两条路都没找到 ocr」那一刻说话。
 *
 * 这是官方给第三方 bundle 的最外侧位置（`plugins.bundle.activation`，用户从列表启用本包
 * 后由页面渲染）。列表卡片上那排标签全部来自宿主对条目自身的判定，插件注入不进去，所以
 * 「装没装外部 CLI」能被显示的最外一处就是这里，外加详情页那只徽标。
 */
export function OcrCliActivation(props: CliStatusShare & PluginActivationOwnerProps): ReactNode {
  const mine = props.packageName === BUNDLE_PKG;
  const status = useCliStatus(mine, props.loadCliStatus);
  if (!mine || status?.source !== "none") {
    return null;
  }
  return buildCliActivation(props.t, props, cliInstallText(status));
}

/** 数据齐（source.status === "ready"）那一支：provider/model 两行 + 三个动作按钮 +
 *  当前配置与 key 两行提示。拆出来是因为这一支画的是整块表单，与上面三条「一行提示」
 *  的降级支本就不是同一件事。 */
function buildReadyProviderSection(deps: OcrCardDeps, data: ProvidersPayload): ReactNode {
  const { t } = deps;
  const providerOptions = data.providers.map((provider) => ({
    value: provider.name,
    label: providerOptionLabel(t, provider),
    disabled: !provider.hasKey,
  }));
  const fallbackModelName = deps.effectiveModel === "" ? t("noModel") : deps.effectiveModel;
  const modelOptions = (
    deps.modelOptions.length > 0
      ? deps.modelOptions
      : [{ id: deps.effectiveModel, name: fallbackModelName }]
  ).map((model) => ({ value: model.id, label: model.name }));
  const providerRow = createElement(SelectRow, {
    label: "Provider",
    hint: t("providerHint"),
    field: "ocrProvider",
    current: deps.effectiveProvider,
    disabled: data.providers.length === 0,
    options: providerOptions,
    onChange: (field, value) => {
      void field;
      deps.onPickProvider(value);
    },
  });
  const modelRow = createElement(SelectRow, {
    label: "Model",
    hint: deps.chosenProvider ? deps.chosenProvider.baseURL : "",
    field: "ocrModel",
    current: deps.effectiveModel,
    disabled: !deps.chosenProvider || deps.modelOptions.length === 0,
    options: modelOptions,
    onChange: (field, value) => {
      void field;
      deps.onPickModel(value);
    },
  });
  const applyBtn = createElement(
    "button",
    {
      className: "ocr-btn ocr-btn-primary",
      type: "button",
      disabled: deps.busy !== null,
      onClick: deps.onApply,
      "data-field": "apply",
    },
    deps.busy === "apply" ? t("applying") : t("applyToOcr"),
  );
  const testBtn = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      disabled: deps.busy !== null,
      onClick: deps.onTest,
      "data-field": "test",
    },
    t("testConnection"),
  );
  const migrateBtn = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      disabled: deps.busy !== null,
      onClick: deps.onMigrate,
      "data-field": "migrate",
    },
    t("migrateKeys"),
  );
  const actionRow = createElement(
    "div",
    { className: "ocr-row", style: { justifyContent: "flex-start", gap: 8 } },
    applyBtn,
    testBtn,
    migrateBtn,
  );
  const cur = data.current;
  const currentHint = cur.provider === "" ? t("noProvider") : currentConfigText(t, cur);
  const currentInfo = createElement("div", { className: "ocr-hint" }, currentHint);
  const keyInfo = createElement("div", { className: "ocr-hint" }, deps.keyHint);
  // 装载期自检失败只作提示：配置照样可以改（正因为端点可能配错，才不该挡住表单）。
  const verify = data.endpointVerify ?? null;
  const verifyWarning =
    verify !== null && !verify.ok
      ? createElement(
          "div",
          { className: STATUS_ERROR_CLASS, "data-field": "endpoint-verify" },
          t("endpointVerifyFailed", { reason: verify.message }),
        )
      : null;
  return createElement(
    "div",
    {},
    verifyWarning,
    providerRow,
    modelRow,
    actionRow,
    currentInfo,
    keyInfo,
  );
}

/** Provider / Model 选择与应用区：三条降级各出一行提示（数据未就绪/读取失败/
 *  数据源不可用），只有 source.status === "ready" 才交给 buildReadyProviderSection 画表单。 */
export function buildProviderSection(deps: OcrCardDeps): ReactNode {
  const { t } = deps;
  if (deps.fetchError !== null) {
    const reason = t("loadProvidersFailed", { error: deps.fetchError });
    return createElement("div", { className: STATUS_ERROR_CLASS }, reason);
  }
  if (deps.data === null) {
    return createElement("div", { className: "ocr-status ocr-muted" }, t("loadingProviders"));
  }
  if (deps.data.source.status !== "ready") {
    // 不点名任何宿主文件：卡片并不知道（也不该知道）配置与凭据存在哪里，
    // 原因由宿主的 source.message 给（settings/credentials 服务缺席、命名空间未
    // 注册、读取抛错…），卡片只负责把原因显示出来（原因本身是 host 侧双语过的）。
    const sourceMessage = deps.data.source.message;
    const reason = sourceMessage === "" ? t("noReason") : sourceMessage;
    const line = t("readProvidersFailed", { reason });
    return createElement("div", { className: STATUS_ERROR_CLASS }, line);
  }
  return buildReadyProviderSection(deps, deps.data);
}

interface SelectionResult {
  effectiveProvider: string;
  effectiveModel: string;
  chosenProvider: DshProvider | undefined;
  modelOptions: DshModel[];
}

/** provider 预选：显式选择 > 当前 OCR 配置（仍存在）> 第一个有 key 的 provider。 */
function resolveBackend(
  providerList: DshProvider[],
  current: ProvidersPayload["current"] | undefined,
  selProvider: string,
): {
  effectiveProvider: string;
  chosenProvider: DshProvider | undefined;
  currentModelValid: boolean;
} {
  const currentStillExists =
    current !== undefined && providerList.some((provider) => provider.name === current.provider);
  // `currentStillExists` 是 `current !== undefined && …` 的别名条件（TS 4.4+ 的
  // aliased narrowing）：它为真就已经含住 `current` 非空，重复判一次是恒真条件。
  const effectiveProvider =
    selProvider ||
    (currentStillExists ? current.provider : "") ||
    (providerList.find((provider) => provider.hasKey)?.name ?? "");
  const chosenProvider = providerList.find((provider) => provider.name === effectiveProvider);
  // current.model 仅当确实存在于该 provider 的 models 列表时才沿用（防手写/过期
  // config 的 model 导致 apply 白白 400）。
  const currentModelValid =
    currentStillExists &&
    current.provider === chosenProvider?.name &&
    typeof current.model === "string" &&
    current.model.length > 0 &&
    // 走到这一臂时 `chosenProvider` 已被上面那条相等式收窄成非空（空的话 `?.name` 是
    // undefined、`current.provider` 是 string，等式不成立就短路了），`some()` 又恒回
    // boolean ⇒ 既不用 `?.` 也不用 `?? false`。
    chosenProvider.models.some((model) => model.id === current.model);
  return { effectiveProvider, chosenProvider, currentModelValid };
}

/** model 预选：selModel 优先，其次当前配置的有效 model，最后首个 model。 */
function resolveModel(
  chosenProvider: DshProvider | undefined,
  current: ProvidersPayload["current"] | undefined,
  currentModelValid: boolean,
  selModel: string,
): { effectiveModel: string; modelOptions: DshModel[] } {
  const effectiveModel =
    selModel ||
    (currentModelValid && current !== undefined
      ? current.model
      : (chosenProvider?.models[0]?.id ?? ""));
  return { effectiveModel, modelOptions: chosenProvider?.models ?? [] };
}

function resolveSelection(
  providerList: DshProvider[],
  current: ProvidersPayload["current"] | undefined,
  selProvider: string,
  selModel: string,
): SelectionResult {
  const backend = resolveBackend(providerList, current, selProvider);
  const model = resolveModel(backend.chosenProvider, current, backend.currentModelValid, selModel);
  return {
    effectiveProvider: backend.effectiveProvider,
    effectiveModel: model.effectiveModel,
    chosenProvider: backend.chosenProvider,
    modelOptions: model.modelOptions,
  };
}

/** 设置行（effort/language/autoVerify + 保存条）。 */
export function buildSettingsSection(
  deps: OcrCardDeps,
  writable: boolean,
  setField: (field: string, value: unknown) => void,
): ReactNode {
  const { t } = deps;
  const effortRow = createElement(SelectRow, {
    label: t("effortLabel"),
    hint: t("effortHint"),
    field: "effort",
    current: deps.effortValue,
    disabled: !writable,
    options: [
      { value: "low", label: t("effortLow") },
      { value: "medium", label: t("effortMedium") },
      { value: "high", label: t("effortHigh") },
    ],
    onChange: (field, draft) => {
      setField(field, draft);
    },
  });
  const languageRow = createElement(SelectRow, {
    label: t("languageLabel"),
    hint: t("languageHint"),
    field: "language",
    current: deps.languageValue,
    disabled: !writable,
    // value 是写进 config.language 并透传给外部 ocr CLI 的枚举值，label 是语言的
    // 自称——两侧都不是界面文案，故不进字典（见 src/ui-messages.ts 头注释）。
    options: [
      { value: "中文", label: "中文" },
      { value: "English", label: "English" },
    ],
    onChange: (field, draft) => {
      setField(field, draft);
    },
  });
  const verifyRow = createElement(SelectRow, {
    label: t("autoVerifyLabel"),
    hint: t("autoVerifyHint"),
    field: "autoVerify",
    current: deps.autoVerifyValue === true ? "on" : "off",
    disabled: !writable,
    options: [
      { value: "on", label: t("onLabel") },
      { value: "off", label: t("offLabel") },
    ],
    onChange: (field, draft) => {
      setField(field, draft === "on");
    },
  });
  const maxCommentsRow = createElement(NumberRow, {
    label: t("maxCommentsLabel"),
    hint: t("maxCommentsHint"),
    field: "maxComments",
    value: deps.maxCommentsValue,
    min: 0,
    disabled: !writable,
    onCommit: (num) => {
      setField("maxComments", num);
    },
  });
  const timeoutRow = createElement(NumberRow, {
    label: t("timeoutLabel"),
    hint: t("timeoutHint"),
    field: "timeoutMinutes",
    value: deps.timeoutMinutesValue,
    min: 0,
    disabled: !writable,
    onCommit: (num) => {
      setField("timeoutMinutes", num);
    },
  });
  const configPathRow = createElement(TextRow, {
    label: t("configPathLabel"),
    hint: t("configPathHint"),
    field: "ocrConfigPath",
    value: deps.ocrConfigPathValue,
    placeholder: "~/.opencodereview/config.json",
    disabled: !writable,
    onCommit: (text) => {
      setField("ocrConfigPath", text);
    },
  });
  const saveRow = createElement(SaveBar, {
    t,
    dirty: deps.dirty,
    writable,
    busy: deps.settingsBusy,
    error: deps.saveError,
    onSave: deps.onSave,
    onDiscard: deps.onDiscard,
  });
  const statusHintNode =
    deps.statusHint !== null && deps.statusHint !== ""
      ? createElement("div", { className: "ocr-hint" }, deps.statusHint)
      : null;
  return createElement(
    "div",
    { style: { padding: "2px 0" } },
    statusHintNode,
    effortRow,
    languageRow,
    verifyRow,
    maxCommentsRow,
    timeoutRow,
    configPathRow,
    saveRow,
  );
}

/** providers 读面的两个落态口（对象化以受 max-params 约束）。 */
interface ProvidersSinks {
  setData: (payload: ProvidersPayload | null) => void;
  setFetchError: (message: string | null) => void;
}

/**
 * 读设置页载荷（卡片唯一的数据入口）：失败只落 fetchError 文本，不抛穿渲染。
 * 拒绝回执（`ok:false`）里的 error 就是「为什么读不到」的可读原因；只报一句
 * 「读取失败」等于把最有用的半句丢掉。
 */
async function refreshProviders(
  reader: OcrReader | undefined,
  t: Translate,
  sinks: ProvidersSinks,
): Promise<ProvidersPayload | null> {
  sinks.setFetchError(null);
  try {
    if (reader === undefined) {
      throw new Error(t("remoteUnavailable"));
    }
    const json = await reader.providers();
    if (fieldOf(json, "ok") === false) {
      const detail = strOf(fieldOf(json, "error"));
      throw new Error(detail === "" ? t("remoteUnavailable") : detail);
    }
    const payload = providersPayloadOf(json);
    sinks.setData(payload);
    return payload;
  } catch (error) {
    sinks.setFetchError(String(error instanceof Error ? error.message : error));
    return null;
  }
}

/** 卡片动作的线上方法名（与 src/remote.ts 的 descriptor.method 同源）。 */
export type RemoteAction = "select" | "migrate" | "test" | "probe";

/** 动作回执的最小面：既有动作函数只读 `json()`，不必把整个 Response 门面造齐。 */
export interface JsonReply {
  json: () => Promise<unknown>;
}

/** 写动作的统一出口（读取器缺席时抛一句可显示的话）。 */
export type CardPost = (action: RemoteAction, body?: OcrSelectRequest) => Promise<JsonReply>;

/** 把读取器接成动作函数认的那个 `post` 形状：拒绝回执原样交回，传输失败才抛。 */
function readerPost(reader: OcrReader | undefined, t: Translate): CardPost {
  return async (action, body) => {
    if (reader === undefined) {
      throw new Error(t("remoteUnavailable"));
    }
    switch (action) {
      case "select": {
        const provider = strOf(fieldOf(body, "provider"));
        const model = strOf(fieldOf(body, "model"));
        const reply = await reader.select(provider, model);
        return { json: () => Promise.resolve(reply) };
      }
      case "migrate": {
        const reply = await reader.migrate();
        return { json: () => Promise.resolve(reply) };
      }
      case "test": {
        const reply = await reader.test();
        return { json: () => Promise.resolve(reply) };
      }
      case "probe": {
        const reply = await reader.probe();
        return { json: () => Promise.resolve(reply) };
      }
      default: {
        throw new Error(`unknown remote action: ${String(action)}`);
      }
    }
  };
}

/** 三个 provider 动作（apply / test / migrate）共用的传输口与落态口。 */
interface CardActionDeps {
  t: Translate;
  post: CardPost;
  refresh: () => Promise<ProvidersPayload | null>;
  setBusy: (busy: CardActionKind | null) => void;
  setActionMsg: (message: { ok: boolean; text: string } | null) => void;
}

/** 卡片上四条动作的标识。同一时刻只允许一条在飞（动作回执只有一份），
 *  所以它是一个「谁在飞」的旗标而不是布尔——按钮按「有没有动作在飞」禁用，但只有**自己**
 *  那条在飞时才改自己的文案，否则按下「检测版本」会让「应用」按钮读成「应用中…」。 */
export type CardActionKind = "apply" | "test" | "migrate" | "probe";

/** apply 动作多要两位：本次渲染选中的 provider/model。 */
interface ApplySelectionDeps extends CardActionDeps {
  effectiveProvider: string;
  effectiveModel: string;
}

/** POST select：把选中的 provider/model 写进 OCR 配置，回执里按 autoVerify 决定是否带 llm test。 */
async function runApplySelection(deps: ApplySelectionDeps): Promise<void> {
  const { t, effectiveProvider, effectiveModel } = deps;
  if (!effectiveProvider || !effectiveModel) {
    deps.setActionMsg({ ok: false, text: t("pickProviderModel") });
    return;
  }
  deps.setBusy("apply");
  deps.setActionMsg(null);
  try {
    const res = await deps.post("select", { provider: effectiveProvider, model: effectiveModel });
    const selJson: unknown = await res.json();
    const ok = fieldOf(selJson, "ok") === true;
    if (ok) {
      let testText: string;
      const llmTestRaw = fieldOf(selJson, "llmTest");
      if (isRecord(llmTestRaw)) {
        const testOutput = strOf(fieldOf(llmTestRaw, "output")).slice(0, 400);
        testText =
          fieldOf(llmTestRaw, "ok") === true
            ? t("llmTestPassed")
            : `${t("llmTestFailed")}${testOutput}`;
      } else {
        testText = t("notVerified");
      }
      const appliedText = t("applied", {
        provider: effectiveProvider,
        model: effectiveModel,
        test: testText,
      });
      deps.setActionMsg({ ok: true, text: appliedText });
      void deps.refresh();
    } else {
      const failure = strOf(fieldOf(selJson, "error"));
      deps.setActionMsg({ ok: false, text: failure === "" ? t("applyFailed") : failure });
    }
  } catch (error: unknown) {
    const failedText = `${t("requestFailed")}${errorSummary(error)}`;
    deps.setActionMsg({ ok: false, text: failedText });
  } finally {
    deps.setBusy(null);
  }
}

/** POST migrate：明文 api_key 一键迁到 api_key_cmd，回执把迁移/跳过两个名单拼成一行。 */
async function runMigrateKeys(deps: CardActionDeps): Promise<void> {
  const { t } = deps;
  deps.setBusy("migrate");
  deps.setActionMsg(null);
  try {
    const res = await deps.post("migrate");
    const json: unknown = await res.json();
    const migratedVal = fieldOf(json, "migrated");
    const skippedVal = fieldOf(json, "skippedUnknown");
    const migrated = Array.isArray(migratedVal)
      ? migratedVal.filter((item): item is string => typeof item === "string")
      : [];
    const skipped = Array.isArray(skippedVal)
      ? skippedVal.filter((item): item is string => typeof item === "string")
      : [];
    const ok = fieldOf(json, "ok") === true;
    const head = ok
      ? (migrated.length > 0 ? t("migratedPrefix") + migrated.join(", ") : t("noPlainKey")) +
        (skipped.length > 0 ? t("skippedPrefix") + skipped.join(", ") : "")
      : t("migrateFailed");
    deps.setActionMsg({ ok, text: head });
    void deps.refresh();
  } catch (error: unknown) {
    const failedText = `${t("requestFailed")}${errorSummary(error)}`;
    deps.setActionMsg({ ok: false, text: failedText });
  } finally {
    deps.setBusy(null);
  }
}

/** POST test：手动触发 ocr llm test，输出原样回显在动作条上。 */
async function runTestConnection(deps: CardActionDeps): Promise<void> {
  const { t } = deps;
  deps.setBusy("test");
  deps.setActionMsg(null);
  try {
    const res = await deps.post("test");
    const json: unknown = await res.json();
    const ok = fieldOf(json, "ok") === true;
    const testOutput = strOf(fieldOf(json, "output"));
    deps.setActionMsg({
      ok,
      text: (ok ? t("llmTestPassed") : t("llmTestFailed")) + testOutput,
    });
  } catch (error: unknown) {
    const failedText = `${t("requestFailed")}${errorSummary(error)}`;
    deps.setActionMsg({ ok: false, text: failedText });
  } finally {
    deps.setBusy(null);
  }
}

/** 探测动作的落态口：只写自己的那一行，不占 provider 动作条（两处同时有回执要分得开）。
 *  导出是为了让「回执文本 = 版本行 + 原样附上的 output」这条用户可见契约能被钉住。 */
export interface ProbeActionDeps {
  t: Translate;
  post: CardPost;
  refresh: () => Promise<ProvidersPayload | null>;
  setBusy: (busy: CardActionKind | null) => void;
  setProbeMsg: (message: { ok: boolean; text: string } | null) => void;
}

/**
 * POST probe：跑一次 `ocr version`。
 *
 * 回执里的 `output` 原样附上，不从中抽「有新版本」那句——那是上游的措辞，抽一次就多
 * 一处会跟着漂的判据；那段文本本来就带在页面上供人选中复制（含上游给的 `npm i -g …`）。
 */
export async function runProbe(deps: ProbeActionDeps): Promise<void> {
  const { t } = deps;
  deps.setBusy("probe");
  deps.setProbeMsg(null);
  try {
    const res = await deps.post("probe");
    const json: unknown = await res.json();
    const ok = fieldOf(json, "ok") === true;
    const head = ok
      ? t("probeVersion", { version: strOf(fieldOf(json, "version")) })
      : t("probeReason", { reason: strOf(fieldOf(json, "reason")) });
    const output = strOf(fieldOf(json, "output"));
    // `changeText` 是宿主按「实测版本 ≠ 核对版本」或「压根没装」才给的那句换版命令；
    // 一致时它是空串，这里就不许多嘴。
    const change = strOf(fieldOf(json, "changeText"));
    const lines = [head, change, output].filter((line) => line !== "");
    deps.setProbeMsg({ ok, text: lines.join("\n") });
    // 走完一次来回就重读载荷：状态那一行是页面装载时读的，而探测吃的是**此刻**的文件系统。
    // 用户在页面开着的时候装上（或拆掉）CLI，就会出现「ocr 版本：1.2.3」与「未找到 ocr」
    // 同屏自相矛盾——两处必须落到同一时刻的事实上。
    void deps.refresh();
  } catch (error: unknown) {
    deps.setProbeMsg({ ok: false, text: `${t("requestFailed")}${errorSummary(error)}` });
  } finally {
    deps.setBusy(null);
  }
}

/** 保存草稿所需的写入通道与落态口（touched → set/unset 的差集在函数内自算）。 */
interface SaveDraftDeps {
  t: Translate;
  value: Record<string, unknown>;
  touched: Record<string, unknown>;
  setTouched: (next: Record<string, unknown>) => void;
  setSettingsBusy: (busy: boolean) => void;
  setSaveError: (message: string | null) => void;
  set: (field: string, value: unknown) => boolean | Promise<boolean>;
}

/** 只写差异字段：touched 值为 undefined → 写 null（= 清回 schema 默认）。
 *  受理位必须回来：`set` 回 `false` 表示宿主拒收或跳过了这次写入（值没落盘），
 *  这时不能清 touched、也不能报成功——否则用户看到「已保存」而配置原封未动。
 *  传输失败仍以 rejection 表达。 */
async function saveSettingsDraft(deps: SaveDraftDeps): Promise<void> {
  const { t, value, touched } = deps;
  const keys = diffTouched(touched, value);
  if (keys.length === 0) {
    return;
  }
  deps.setSettingsBusy(true);
  deps.setSaveError(null);
  const ops = keys.map(async (field: string) => {
    const draft = touched[field];
    return deps.set(field, draft === undefined ? null : draft);
  });
  try {
    const settled = await Promise.all(ops);
    deps.setSettingsBusy(false);
    const refused = keys.filter((_field, index) => settled[index] !== true);
    if (refused.length > 0) {
      deps.setSaveError(t("saveRefused", { fields: refused.join(", ") }));
      return;
    }
    deps.setTouched({});
  } catch (error: unknown) {
    deps.setSettingsBusy(false);
    deps.setSaveError(`${t("saveFailed")}${errorSummary(error)}`);
  }
}

/** 设置行的渲染值（touched 优先、快照兜底，再按各行自己的类型收口）。 */
interface DraftFields {
  effortValue: unknown;
  languageValue: unknown;
  autoVerifyValue: unknown;
  maxCommentsValue: number;
  timeoutMinutesValue: number;
  ocrConfigPathValue: string;
}

function draftFieldsOf(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): DraftFields {
  const eff = (field: string, def: unknown): unknown =>
    field in touched ? touched[field] : (value[field] ?? def);
  return {
    effortValue: eff("effort", "medium"),
    languageValue: eff("language", "中文"),
    autoVerifyValue: eff("autoVerify", true),
    maxCommentsValue: numOf(eff("maxComments", 12), 12),
    timeoutMinutesValue: numOf(eff("timeoutMinutes", 0), 0),
    ocrConfigPathValue: strOf(eff("ocrConfigPath", "")),
  };
}

/** 两条「这一会儿卡片能不能用 / key 从哪来」的提示（设置快照与 provider 数据各自缺席时不同）。 */
interface CardHints {
  keyHint: string;
  statusHint: string | null;
}

function cardHints(
  t: Translate,
  ready: boolean,
  status: CardSnapshot["status"],
  data: ProvidersPayload | null,
): CardHints {
  let statusHint: string | null;
  if (ready) {
    statusHint = null;
  } else {
    statusHint = status === "loading" ? t("settingsLoading") : null;
  }
  let keyHint: string;
  if (data) {
    keyHint = data.getCredReady ? t("keyDynamicHint") : t("keyScriptMissing");
  } else {
    keyHint = "";
  }
  return { keyHint, statusHint };
}

/** Provider 区 = provider/model 表单 + 最近一次动作的回执条。 */
function buildProviderPanel(deps: OcrCardDeps): ReactNode {
  const { actionMsg } = deps;
  const providerSection = buildProviderSection(deps);
  const actionMsgNode = actionMsg
    ? createElement("div", { className: statusClass(actionMsg.ok) }, actionMsg.text)
    : null;
  return createElement("div", { style: { padding: "2px 0" } }, providerSection, actionMsgNode);
}

function OcrCard(props: CardSlotProps): ReactNode {
  const { t } = props;
  const snap = props.useCard((state) => state);
  const { value } = snap;
  const ready = snap.status === "ready";
  const writable = snap.writable && ready;

  // Provider 数据（官方 Remote 读面，无 key 明文）。
  const [data, setData] = useState<ProvidersPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CardActionKind | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(
    async (): Promise<ProvidersPayload | null> =>
      refreshProviders(props.reader, t, { setData, setFetchError }),
    [props.reader, t],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = readerPost(props.reader, t);

  // 本地选择态（未持久化到 settings；apply 时才写 OCR config）。
  const [selProvider, setSelProvider] = useState("");
  const [selModel, setSelModel] = useState("");

  const selection = resolveSelection(data?.providers ?? [], data?.current, selProvider, selModel);
  const { effectiveProvider, effectiveModel, chosenProvider, modelOptions } = selection;
  const providerList = data?.providers ?? [];

  function pickProvider(name: string): void {
    setSelProvider(name);
    const picked = providerList.find((entry) => entry.name === name);
    const first = picked?.models[0]?.id ?? "";
    setSelModel(first);
  }

  const actions: ApplySelectionDeps = {
    t,
    post,
    refresh,
    setBusy,
    setActionMsg,
    effectiveProvider,
    effectiveModel,
  };

  // 设置行（effort/language/autoVerify）。
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = diffTouched(touched, value).length > 0;
  const setField = (field: string, draft: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: draft }));
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };

  const deps: OcrCardDeps = {
    t,
    data,
    fetchError,
    busy,
    actionMsg,
    ready,
    writable,
    effectiveProvider,
    effectiveModel,
    chosenProvider,
    modelOptions,
    ...cardHints(t, ready, snap.status, data),
    binary: data?.ocrBinary ?? null,
    probeMsg,
    ...draftFieldsOf(touched, value),
    dirty,
    settingsBusy,
    saveError,
    onPickProvider: pickProvider,
    onPickModel: setSelModel,
    onApply: () => {
      void runApplySelection(actions);
    },
    onTest: () => {
      void runTestConnection(actions);
    },
    onMigrate: () => {
      void runMigrateKeys(actions);
    },
    onProbe: () => {
      void runProbe({ t, post, refresh, setBusy, setProbeMsg });
    },
    onField: setField,
    onSave: () => {
      void saveSettingsDraft({
        t,
        value,
        touched,
        setTouched,
        setSettingsBusy,
        setSaveError,
        set: props.set,
      });
    },
    onDiscard: discard,
  };
  const providerPanel = buildProviderPanel(deps);
  const cliStatus = buildCliStatusRow(deps);
  const settingsSection = buildSettingsSection(deps, writable, setField);
  // 头部两行先取成变量：嵌进 createElement 里再调 t() 会顶到 max-nested-calls 上限。
  const headTitle = t("cardTitle");
  const headDesc = t("cardDescription");
  return createElement(
    OcrPluginCard,
    { title: headTitle, description: headDesc },
    cliStatus,
    providerPanel,
    settingsSection,
  );
}

export interface CardSlotProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <TResult>(selector: (snap: CardSnapshot) => TResult) => TResult;
  set: (field: string, value: unknown) => boolean | Promise<boolean>;
  /** 宿主读面（官方 Remote 的消费侧，见 src/remote.ts）；缺席 = 当前部署没有远程面。 */
  reader?: OcrReader;
}

/**
 * 本卡用到的 ctx 面：`effect` / `slots` 两位直接取官方服务面，`locale` 取官方**类型化**
 * 重载，只有 `configForms` 仍是方法面投影（原因见那一条）。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两个重载）。原先这里
 *   手写的是 `(factory: () => (() => void) | undefined, label?: string) => void`——返回位
 *   被抄成了 `void`，而官方交回的是可 await 的 `Disposable`/`AsyncDisposable`；抄一次就把
 *   cordis 的形状漂移钉死的机会丢掉了。
 * - `slots`：官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`，installed
 *   `dsh-client-ui-renderer/lib/types/client/index.d.ts:27`）的**方法面投影**。取 `Pick`
 *   而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（同目录 `registry.d.ts:46`），TS 对它做名义比较，测试桩件无法满足。
 *   `register` 逐字复用 `SlotCore['register']`（`registry.d.ts:85`，两个重载），
 *   `inject` 是 `registry.d.ts:111` 的「按槽位声明生命周期装 effect」那一位（disposer
 *   随 collapse 重跑工厂的语义就写在 :100）。合并进 `SlotMap` 的槽位键在这里是
 *   **编译期受检**的：`inject`/`register` 的 key 参数域就是 `keyof SlotMap & string`，
 *   `plugins.bundle.config` 能过靠的是文件头那条 `import type` 把属主 merge 载入 program。
 * - `configForms`：宿主的配置表单服务（installed
 *   `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
 *   `Context.configForms`，`get:142` 按 profile 条目 id 取那张共享表单）：取代已随宿主
 *   移除的 `settingsScope`（installed 全树零命中）。只投影用到的 `get`：官方
 *   `ConfigForms.get` 是泛型（`<T>(entryId) => ConfigForm<T>`），且 `ConfigForms` 同样是
 *   Service 类 → 既不能整类型用，也不能把 `Pick` 交给桩件；这里把 `T` 钉在本卡唯一取的
 *   那张表单上，返回面仍是官方 `ConfigForm`。写侧的 `remote.settings` 由 provider 自己的
 *   fiber 承担，故此处不必声明。
 * - `locale`：官方 `@deepseek-ai/dsh-client-locale` 的 client 面（`LocaleRuntime`，installed
 *   `lib/types/client/index.d.ts:97`）在**类型化**那两条重载上的投影：
 *   - `register`：`index.d.ts:199` 的 `register<N extends Extract<keyof
 *     LocaleNamespaceMap, string>>(ns: N, dicts: Record<BuiltInLocaleId,
 *     LocaleDictOf<N>>)`，取在 `typeof NS` 上：字典参数即上面的 `LocaleCatalog`
 *     （两语必须一次交齐，缺一门即编译期红）。
 *     ⚠ 不用 :209 那条未类型化的三参重载（`dict: LocaleDict = Record<string, string>`）：
 *     `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 `interface`，而
 *     interface 拿不到隐式索引签名，走那条得先本包自己把字典再投影一次；有限键映射那条
 *     既满足官方契约、又让「少一门语言」「多一个键」都在编译期红。
 *   - `bind`：:219 的类型化那条（`bind<N>(ns: N): TranslateNS<N>`）。本包命名空间已 merge
 *     进 `LocaleNamespaceMap`（见 ui-messages.ts），故取在 `typeof NS` 上就是本包键集收窄的
 *     `Translate`。
 *     ⚠ 不写成 `LocaleRuntime['bind']`：那会把 :226 的未类型化重载（返回
 *     `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条（quality-gate 侧
 *     实测过这一位换成 `LocaleRuntime["bind"]` 后的报错：
 *     `Type 'string' is not assignable to type 'LocaleKeysOf<"quality-gate">'`）。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
  /** 显式读取可选服务（官方 `ctx.get`）；缺省时按「当前部署没有远程面」处理。 */
  get?: (name: string, strict?: boolean) => unknown;
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  if (!claimApply(ctx, "ocrReviewCardApplied", "ocr-review-card: apply claim")) {
    return;
  }
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "ocr-review-card-css";
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "ocr-review-card: styles");
  // 本包的共享表单：条目 id == cordis.patch.yml 里的裸 id `ocr-review`（隐式
  // settings 命名空间即条目 id，host.ts 隐式注册用的也是它），与 locale 命名空间同源，
  // 故直接复用 NS。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典一次性交给**类型化**那条 register 重载
  // （官方要求每个内置 locale 都在，缺一门即编译期红；disposer 随 effect 回收），再
  // bind 出稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重渲染，无需重载页面。
  // 一次性交齐与旧的两份逐语注册在宿主侧是**同一条代码路径**：installed
  // dsh-client-locale/lib/client.js:1379-1405 的 `register(ns, localeOrDicts, dict)` 在
  // 第二参不是字符串时走 `Object.entries(localeOrDicts)`，两份字典进同一个 `pairs`，
  // 返回的是**一个**回收全部 pairs 的 disposer（旧写法是两个 disposer 手工串起来）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "ocr-review-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  // 远程读面在 apply 期造一次：`$mount` 幂等（随卡片卸载自动撤），反复拉取只挂一次；
  // 没有远程面的部署交 undefined，卡片照常渲染、数据面显示读不到。
  const reader = createOcrReader(ctx);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 旧的 settings.plugin.item 槽位已从宿主侧移除（installed slot-contract.d.ts 零命中）；
        // 本槽 plugins.bundle.config 按 bundle 包名 keyed。
        // 键值定案：宿主派发 `entryKey: pkg.name`（= bundle 的 npm 包名），
        // 证据见上面 BUNDLE_PKG 的注释块；按裸条目 id 注册 = renderer 逐字相等匹配不到
        // （installed dsh-client-ui-renderer/lib/client.js:1154）= 卡片完全不渲染。
        // 表单侧不变：上面 `ctx.configForms.get(NS)` 仍吃裸条目 id。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          set: (field: string, value: unknown): boolean | Promise<boolean> =>
            scope.set(field, value),
          // 宿主读面（remote 的消费侧）：缺省不交这一位 = 当前部署没有远程面。
          ...(reader === undefined ? {} : { reader }),
        }),
      },
      OcrCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：宿主的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），消费契约 `ConfigForm`
    //（config-form-types.d.ts 的 ConfigForm）里根本没有 dispose，消费者无从销毁；provider 在自己的
    // fiber 上统一回收（installed lib/client.js:1290-1293）。slot collapse 会调用本
    // disposer 并在再次声明时**重跑工厂**（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"）——表单共享且长活，所以重跑后写入
    // 依然落盘；旧 `settingsScope` 那种「离开插件页一次之后 scope 永久 disposed、之后每次
    // 保存被静默丢弃」的坑（早先那个 fiber 级 dispose）随该服务一起消失。
    return unregister;
  });
  // 三处对外贡献：详情页徽标（标题旁）、详情页区块（页面内容之下）、启用后指引。
  // 全部吃 `loadCliStatus` 那一个口——「装没装 ocr」在卡片、徽标、区块三处必须是同一句
  // 话，各自算一份就等着哪天分叉。官方只给第三方 bundle 到这几个位置：列表卡片那排标签
  // 全是宿主对条目自身的判定（running/off/problem），插件注入不进去。
  const cliShare: CliStatusShare = { t, loadCliStatus: () => loadCliStatus(reader) };
  ctx.slots.inject("plugins.detail.badge", () =>
    ctx.slots.register(
      {
        name: "plugins.detail.badge",
        id: `${NS}-cli-badge`,
        order: 100,
        label: "ocr-review CLI badge",
        inject: () => cliShare,
      },
      OcrCliBadge,
    ),
  );
  ctx.slots.inject("plugins.detail.section", () =>
    ctx.slots.register(
      {
        name: "plugins.detail.section",
        id: `${NS}-cli-section`,
        order: 100,
        label: "ocr-review CLI section",
        inject: () => cliShare,
      },
      OcrCliSection,
    ),
  );
  ctx.slots.inject("plugins.bundle.activation", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.activation",
        key: BUNDLE_PKG,
        inject: () => cliShare,
      },
      OcrCliActivation,
    ),
  );
}

export { OcrCard, inject, apply };

declare global {
  var ocrReviewCardApplied: boolean | undefined;
}
