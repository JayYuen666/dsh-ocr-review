// ocr-review 设置卡片（Client 半，build-client.mjs 打包为 client.js）。
// 功能：从宿主配置服务（GET /_dsh/ocr-review/providers，背后是
// ctx.settings.describe() 的 llm-pi-ai 命名空间）列出可选 provider+model，
// 选择后 POST /_dsh/ocr-review/select 应用到外部 ocr CLI 的 config.json
// （key 走 api_key_cmd 动态读取，不落盘明文）；附带 llm test 验证、明文 key
// 一键迁移，以及 effort/language/autoVerify/ocrConfigPath 设置行（保存条暂存-写入）。
// React 一律 createElement；卡片注册进 keyed plugins.bundle.config 槽的 **bundle 包名**键
// （`@jayyuen66/dsh-ocr-review`，见 BUNDLE_PKG），不是裸条目 id。
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

import { createElement, useEffect, useState } from "react";
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
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

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
const PROVIDERS_URL = "/_dsh/ocr-review/providers";
const SELECT_URL = "/_dsh/ocr-review/select";
const MIGRATE_URL = "/_dsh/ocr-review/migrate";
const TEST_URL = "/_dsh/ocr-review/test";
/** 写端点 CSRF 头名（与 host.ts OCR_CSRF_HEADER 同源，改名要两端一起改）。 */
const CSRF_HEADER = "x-ocr-csrf";

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
  return {
    providers,
    current,
    getCredReady: fieldOf(json, "getCredReady") === true,
    source: {
      status: strOf(fieldOf(sourceRaw, "status")),
      message: strOf(fieldOf(sourceRaw, "message")),
    },
    csrf: strOf(fieldOf(json, "csrf")),
  };
}

/** 三行表单控件（数字/文本/下拉）共用的类名 = CARD_CSS 里 `.ocr-select{…}` 那条规则。
 *  抽出来是因为两处 input 与一处 select 必须同宽同边框：写三遍字面量时改一处漏两处，
 *  症状是设置卡里某一行的控件比其它行窄。 */
const FORM_CONTROL_CLASS = "ocr-select";

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
export interface ProvidersPayload {
  providers: DshProvider[];
  current: { provider: string; model: string; keyIsDynamic: boolean; url: string };
  getCredReady: boolean;
  source: ProviderSource;
  /** 宿主每次 apply 生成的会话内 CSRF token（写端点必须回填 x-ocr-csrf 头）。 */
  csrf: string;
}

/**
 * 0.1.7 的客户端配置面：直接取官方声明
 * `@deepseek-ai/dsh-client-ui-settings/client` 的 `ConfigForm<T>`（getSnapshot / subscribe /
 * mutate / set / unset）与其 `ConfigFormSnapshot<T>`。原先那份 `getSnapshot: () => unknown`
 * 逼出下面 `cardStore` 里的 `fieldOf(snap, "status")` 逐位再解析——那只是丢失类型的补救，不是
 * 宿主契约（provider 侧已按命名空间 schema decode/derive 过快照，宿主不会送别的形状）。
 * 入口是 `ctx.configForms.get(entryId)`，`entryId` 即 profile 条目 id = 本包命名空间。
 * 本卡依赖的两条：
 *  - `set`/`unset` 多带回**受理位**：`true` 宿主受理，`false` = 拒绝或写入被跳过，只有传输
 *    失败才 reject。本卡维持既有行为：失败面只认 rejection，受理位 await 后即弃（见 apply 里
 *    的 payload）——消费它要新增文案键与判定，属改行为而不是迁移（session-rescue /
 *    quality-gate / danger-guard / ctx-observe 同一条纪律）。
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

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
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
    createElement("span", { className: "ocr-card-name" }, title),
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
  return createElement(
    "li",
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
  busy: boolean;
  actionMsg: { ok: boolean; text: string } | null;
  ready: boolean;
  writable: boolean;
  effectiveProvider: string;
  effectiveModel: string;
  chosenProvider: DshProvider | undefined;
  modelOptions: DshModel[];
  keyHint: string;
  statusHint: string | null;
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
      disabled: deps.busy,
      onClick: deps.onApply,
      "data-field": "apply",
    },
    deps.busy ? t("applying") : t("applyToOcr"),
  );
  const testBtn = createElement(
    "button",
    {
      className: "ocr-btn",
      type: "button",
      disabled: deps.busy,
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
      disabled: deps.busy,
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
  return createElement("div", {}, providerRow, modelRow, actionRow, currentInfo, keyInfo);
}

/** Provider / Model 选择与应用区：三条降级各出一行提示（数据未就绪/读取失败/
 *  数据源不可用），只有 source.status === "ready" 才交给 buildReadyProviderSection 画表单。 */
export function buildProviderSection(deps: OcrCardDeps): ReactNode {
  const { t } = deps;
  if (deps.fetchError !== null) {
    const reason = t("loadProvidersFailed", { error: deps.fetchError });
    return createElement("div", { className: "ocr-status ocr-err" }, reason);
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
    return createElement("div", { className: "ocr-status ocr-err" }, line);
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

/** providers GET 的两个落态口（对象化以受 max-params 约束）。 */
interface ProvidersSinks {
  setData: (payload: ProvidersPayload | null) => void;
  setFetchError: (message: string | null) => void;
}

/** 读 providers 端点（卡片唯一的 GET）：失败只落 fetchError 文本，不抛穿渲染。 */
async function refreshProviders(sinks: ProvidersSinks): Promise<ProvidersPayload | null> {
  sinks.setFetchError(null);
  try {
    const res = await fetch(PROVIDERS_URL, { headers: { accept: "application/json" } });
    if (!res.ok) {
      // 非 2xx 的回执体里就是「为什么读不到」的可读原因（宿主把设置项路径不合法
      // 之类的错误折进 JSON 的 error 字段）。只报状态码等于把最有用的半句丢掉。
      const parsed: unknown = await res.json().catch(() => ({}));
      const detail = strOf(fieldOf(parsed, "error"));
      throw new Error(detail === "" ? `HTTP ${res.status}` : detail);
    }
    const payload = providersPayloadOf(await res.json());
    sinks.setData(payload);
    return payload;
  } catch (error) {
    sinks.setFetchError(String(error instanceof Error ? error.message : error));
    return null;
  }
}

/** 写端点的 CSRF 依赖：本次渲染读到的 token，以及「过期就重取 token」的那道口。 */
interface CsrfPostDeps {
  csrf: string;
  refresh: () => Promise<ProvidersPayload | null>;
}

/**
 * 写端点统一出口：回填宿主下发的 x-ocr-csrf token（宿主只接受带 token 的
 * POST，sec-fetch-site 挡不住本地进程）。宿主每次 apply 会换 token，页面开着
 * 时它可能已过期 → 403 就重取 token 重试一次，避免卡片变成「点什么都没反应」。
 */
async function postWithCsrf(
  url: string,
  body: string | undefined,
  deps: CsrfPostDeps,
): Promise<Response> {
  const request = (token: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        [CSRF_HEADER]: token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
  const first = await request(deps.csrf);
  if (first.status !== 403) {
    return first;
  }
  const renewed = await deps.refresh();
  const retry = await request(renewed?.csrf ?? "");
  return retry;
}

/** 三个 provider 动作（apply / test / migrate）共用的传输口与落态口。 */
interface CardActionDeps {
  t: Translate;
  post: (url: string, body?: string) => Promise<Response>;
  refresh: () => Promise<ProvidersPayload | null>;
  setBusy: (busy: boolean) => void;
  setActionMsg: (message: { ok: boolean; text: string } | null) => void;
}

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
  deps.setBusy(true);
  deps.setActionMsg(null);
  try {
    const res = await deps.post(
      SELECT_URL,
      JSON.stringify({ provider: effectiveProvider, model: effectiveModel }),
    );
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
    deps.setBusy(false);
  }
}

/** POST migrate：明文 api_key 一键迁到 api_key_cmd，回执把迁移/跳过两个名单拼成一行。 */
async function runMigrateKeys(deps: CardActionDeps): Promise<void> {
  const { t } = deps;
  deps.setBusy(true);
  deps.setActionMsg(null);
  try {
    const res = await deps.post(MIGRATE_URL);
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
    deps.setBusy(false);
  }
}

/** POST test：手动触发 ocr llm test，输出原样回显在动作条上。 */
async function runTestConnection(deps: CardActionDeps): Promise<void> {
  const { t } = deps;
  deps.setBusy(true);
  deps.setActionMsg(null);
  try {
    const res = await deps.post(TEST_URL);
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
    deps.setBusy(false);
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
  set: (field: string, value: unknown) => void | Promise<void>;
}

/** 只写差异字段：touched 值为 undefined → 写 null（= 清回 schema 默认）。 */
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
    await deps.set(field, draft === undefined ? null : draft);
  });
  try {
    await Promise.all(ops);
    deps.setSettingsBusy(false);
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
    ? createElement(
        "div",
        { className: `ocr-status ${actionMsg.ok ? "ocr-ok" : "ocr-err"}` },
        actionMsg.text,
      )
    : null;
  return createElement("div", { style: { padding: "2px 0" } }, providerSection, actionMsgNode);
}

function OcrCard(props: CardSlotProps): ReactNode {
  const { t } = props;
  const snap = props.useCard((state) => state);
  const { value } = snap;
  const ready = snap.status === "ready";
  const writable = snap.writable && ready;

  // Provider 数据（webServer 端点，无 key 明文）。
  const [data, setData] = useState<ProvidersPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async (): Promise<ProvidersPayload | null> =>
    refreshProviders({ setData, setFetchError });
  useEffect(() => {
    void refresh();
  }, []);

  const post = async (url: string, body?: string): Promise<Response> =>
    postWithCsrf(url, body, { csrf: data?.csrf ?? "", refresh });

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
  const settingsSection = buildSettingsSection(deps, writable, setField);
  // 头部两行先取成变量：嵌进 createElement 里再调 t() 会顶到 max-nested-calls 上限。
  const headTitle = t("cardTitle");
  const headDesc = t("cardDescription");
  return createElement(
    OcrPluginCard,
    { title: headTitle, description: headDesc },
    providerPanel,
    settingsSection,
  );
}

export interface CardSlotProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <TResult>(selector: (snap: CardSnapshot) => TResult) => TResult;
  set: (field: string, value: unknown) => void | Promise<void>;
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
 * - `configForms`：0.1.7 的配置表单服务（installed
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
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  if (globalThis.ocrReviewCardApplied === true) {
    return;
  }
  globalThis.ocrReviewCardApplied = true;
  ctx.effect(
    () => () => {
      globalThis.ocrReviewCardApplied = undefined;
    },
    "ocr-review-card: apply claim",
  );
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "ocr-review-card-css";
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "ocr-review-card: styles");
  // 本包的共享表单：条目 id == cordis.patch.yml 里的裸 id `ocr-review`（0.1.7 起
  // settings 命名空间即条目 id，host.ts 隐式注册用的也是它），与 locale 命名空间同源，
  // 故直接复用 NS。旧写法 `settingsScope.bind({ namespace: NS })` 取的是同一个串。
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
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed。
        // 0.1.7 复核：槽位仍在（installed slot-contract.d.ts:100），换掉的只是它读写的表单来源。
        // 键值定案：宿主派发 `entryKey: pkg.name`（= bundle 的 npm 包名），
        // 证据见上面 BUNDLE_PKG 的注释块；按裸条目 id 注册 = renderer 逐字相等匹配不到
        // （installed dsh-client-ui-renderer/lib/client.js:1154）= 卡片完全不渲染。
        // 表单侧不变：上面 `ctx.configForms.get(NS)` 仍吃裸条目 id。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          set: async (field: string, value: unknown): Promise<void> => {
            try {
              await scope.set(field, value);
            } catch (error) {
              console.error(`[ocr-review-card] set ${field} failed:`, error);
            }
          },
        }),
      },
      OcrCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），消费契约 `ConfigForm`
    //（config-form-types.d.ts:36-74）里根本没有 dispose，消费者无从销毁；provider 在自己的
    // fiber 上统一回收（installed lib/client.js:1290-1293）。slot collapse 会调用本
    // disposer 并在再次声明时**重跑工厂**（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"）——表单共享且长活，所以重跑后写入
    // 依然落盘；旧 `settingsScope` 那种「离开插件页一次之后 scope 永久 disposed、之后每次
    // 保存被静默丢弃」的坑（0.1.6 的 fiber 级 dispose）随该服务一起消失。
    return unregister;
  });
}

export { OcrCard, inject, apply };

declare global {
  var ocrReviewCardApplied: boolean | undefined;
}
