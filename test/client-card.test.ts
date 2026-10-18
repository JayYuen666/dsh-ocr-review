// ocr-review 卡片的 locale 接线与双语（@deepseek-ai/dsh-client-locale 契约）。
//
// 与 ctx-observe 的同名测试同形态，但**没有 jsdom / @testing-library 可用**
// （本包 devDeps 里没有，全仓也不为此新装依赖）：改用两步等价验证——
//   1. `apply(fakeCtx)`：断言两语字典都注册进官方 locale、bind 到的 translator
//      以 `t` 经 slots.register 的 payload 下发；
//   2. 直接调用不碰 hooks 的纯组件函数（SaveBar / buildProviderSection /
//      buildSettingsSection）拿到 createElement 产出的元素树，递归取 props 里的
//      字符串与 children 当「渲染文本」——en 那份整棵子树不得出现汉字。
// 带插值的行（currentConfig / provider 标签）另按 helper 直断，
// 等价于样板包对 sessionRow 的渲染断言。
import { describe, expect, it, afterEach } from "vitest";
import {
  apply,
  inject,
  cardStore,
  SaveBar,
  buildProviderSection,
  buildSettingsSection,
  buildCliStatusRow,
  buildCliBadge,
  buildCliSection,
  buildCliActivation,
  binaryOf,
  binaryStatusText,
  cliBadgeText,
  cliInstallText,
  cliVersionText,
  isOwnSubject,
  loadCliStatus,
  runProbe,
  currentConfigText,
  providerOptionLabel,
} from "../src/client-entry.ts";
import type { CardActionKind, OcrBinaryView, OcrCardDeps } from "../src/client-entry.ts";
import type {
  PluginPackageRef,
  PluginsSubject,
} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";
import type { OcrReader } from "../src/remote.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

type Snap = ConfigFormSnapshot<Record<string, unknown>>;

/** 官方 `ConfigFormSnapshot` 的合法形状（6 位全必选）：`value` 在首个快照受理前才是
 *  undefined，`writable` 说的是宿主文档收不收写——桩件只能送官方真会送的那些形状。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: { effort: "high" },
    base: {},
    user: {},
    revision: 7,
    writable: true,
    ...over,
  };
}

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.translate` 在 active 链与 common 命名空间都 miss 后的行为，
 * installed dsh-client-locale/lib/client.js:1415-1417）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后 `TranslateNS<NS>` 的键域是「本包键 ∪ common 命名空间键」（官方 `LocaleKeysOf`），
 * 按 `UiMessages` 索引那条并集会在编译期红（实测
 * `Property 'back' does not exist on type 'UiMessages'`），而运行时真相就是回落。
 * 展开成字面量是为了拿到隐式索引签名（`UiMessages` 是 interface，本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

/** 两语字典的 `Record<string, string>` 面：translator 用它，缺键时回落键名。 */
const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const enTable: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文 translator：卡片断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});
const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});

const HAN = /[\p{Script=Han}]/u;
const noop = (): void => {
  void 0;
};

/** 本包在 cordis.patch.yml 里声明的条目 id（0.1.7 起也就是设置命名空间）。
 *  测试侧独立声明，不 import 实现里那份同名常量——实现漂了这条断言才红得住。 */
const PLUGIN_ENTRY_ID = "ocr-review";

/** 本包贡献的四个槽位名（与 src/client-entry.ts 的注册一一对应；四处共用同一份常量，
 *  槽位被改名时症状是那块表面静默不出现，常量在这里钉成断言）。 */
const CARD_SLOT = "plugins.bundle.config";
const BADGE_SLOT = "plugins.detail.badge";
const SECTION_SLOT = "plugins.detail.section";
const ACTIVATION_SLOT = "plugins.bundle.activation";

// ── 最小 document 替身（node 环境没有 jsdom）────────────────────────────────
// apply 的样式 effect 只用到 createElement / head.append / remove 三件事，
// 断言也只问「这条 id 的 style 在不在 head 里」——不必为此装一个 jsdom。
interface StubStyle {
  id: string;
  textContent: string;
  remove: () => void;
}
/** 卡片注入的那枚 <style> 的 id（替身按 id 认标签，remove() 也按它回收）。 */
const CARD_STYLE_ID = "ocr-review-card-css";
/** 上面那枚 id 的选择器形态：document.head.querySelector 只吃 `#id`。 */
const CARD_STYLE_SELECTOR = `#${CARD_STYLE_ID}`;
const injectedStyles: StubStyle[] = [];
const stubDocument = {
  createElement: (): StubStyle => ({
    id: "",
    textContent: "",
    remove: () => {
      const at = injectedStyles.findIndex((tag) => tag.id === CARD_STYLE_ID);
      if (at !== -1) {
        injectedStyles.splice(at, 1);
      }
    },
  }),
  head: {
    append: (tag: StubStyle): void => {
      injectedStyles.push(tag);
    },
    querySelector: (selector: string): StubStyle | null =>
      selector === CARD_STYLE_SELECTOR ? (injectedStyles[0] ?? null) : null,
  },
};
globalThis.document = stubDocument as unknown as Document;

/**
 * 递归取出一棵元素树里的全部文本（无 jsdom 的渲染替身）：
 * 元素取 props、普通对象取字段（SelectRow 的 `options: {value,label}[]` 就是这么
 * 被看到的），函数型 prop（回调）与布尔/样式跳过。
 */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (node === null || node === undefined || typeof node !== "object") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map((item) => textOf(item)).join(" ");
  }
  const holder = node as { props?: Record<string, unknown> } & Record<string, unknown>;
  const source = holder.props ?? holder;
  const parts: string[] = [];
  for (const value of Object.values(source)) {
    // 回调/组件这类函数 prop 不承载文案，跳过（不写 continue，见 no-continue）。
    if (typeof value !== "function") {
      parts.push(textOf(value));
    }
  }
  return parts.join(" ");
}

/**
 * `ctx.configForms.get(entryId)` 交回的那张共享表单的替身：直接 `extends` 官方
 * `ConfigForm<Record<string, unknown>>`（getSnapshot/subscribe/mutate/set/unset 五位齐备才算
 * 桩件，缺一位就编译失败——src 那边换掉手抄镜像后，漂移由这里钉住）。契约里**没有** dispose：
 * 表单由 provider 持有并在自己的 fiber 上统一回收。`set`/`unset`/`mutate` 带受理位
 * `Promise<boolean>`：true=宿主受理，false=拒绝或被跳过，只有传输失败才 reject。
 * 这里仍留一根会抛的 dispose 绊线（makeCtx 内接上计数器）：把 `scope.dispose()` 写回 slot
 * disposer 这类回退会立刻炸在这里，而不是像 0.1.6 那样静默让之后的每次保存都落空。
 */
interface StubForm extends ConfigForm<Record<string, unknown>> {
  /** 绊线位：不属于官方 `ConfigForm` 契约，只在 makeCtx 里挂上（见那里的注释）。 */
  dispose?: () => never;
}

function makeScope(): StubForm {
  return {
    getSnapshot: () => snap(),
    subscribe: (): (() => void) => noop,
    set: async (): Promise<boolean> => true,
    unset: async (): Promise<boolean> => true,
    // 官方 ConfigForm 的第五位（路径级原子写入）：本卡不走它，但类型面要求它在位。
    mutate: async (): Promise<boolean> => true,
  };
}

/** apply 的入参类型（ClientCtx 未导出，从函数签名上取，避免两头漂移）。 */
type CardCtx = Parameters<typeof apply>[0];

/** 替身 client ctx 的观测面：locale 注册、bind、slots、表单取用都被记下来供断言。 */
interface CardCtxHarness {
  ctx: CardCtx;
  /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典）。
   *  形状就是官方 `LocaleRuntime.register` 类型化重载的两个参数。 */
  registered: {
    ns: string;
    dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>;
  }[];
  /** `ctx.configForms.get(entryId)` 收到过的条目 id（0.1.7 起 == 设置命名空间）。 */
  formEntryIds: string[];
  slots: string[];
  /** slots.register 收到的 desc 里与装配相关的两项（钉住槽位名与 key 没被顺手改掉）。 */
  slotDescs: { name: string; key: string | undefined }[];
  effects: (() => void)[];
  slotCleanups: (() => void)[];
  /** dispose 绊线的命中次数（正常路径恒 0：0.1.7 的消费契约里没有 dispose）。 */
  disposedOf: () => number;
  payloadOf: () => Record<string, unknown> | null;
  /** 逐个跑掉 slots.inject 注册回来的 disposer（断言里避免下标访问）。 */
  cleanSlots: () => void;
}

/** 替身 client ctx：官方 locale 的 register/bind、slots 与 configForms 都记下来供断言。 */
function makeCtx(options: { bound?: Translate } = {}): CardCtxHarness {
  const form: StubForm = makeScope();
  const registered: CardCtxHarness["registered"] = [];
  const formEntryIds: string[] = [];
  const slots: string[] = [];
  const slotDescs: { name: string; key: string | undefined }[] = [];
  const effects: (() => void)[] = [];
  const slotCleanups: (() => void)[] = [];
  let disposed = 0;
  let payload: Record<string, unknown> | null = null;
  const ctx: CardCtx = {
    // `effect` / `slots` 在 ClientCtx 里已是**官方**服务投影（cordis `Context["effect"]`
    // 与 `Pick<SlotRegistry, "inject" | "register">`），生产侧签名一漂移就红在编译期。
    // 两处不得已的显式标注：
    //  - `effect`：官方是**两**个重载（同步 `Disposable<Promise<void>>` 与可 await 的
    //    `AsyncDisposable<Promise<void>>`，后者还是 PromiseLike），单个箭头签名同时满足
    //    不了两边，故一次性投影到官方面；桩件只回收同步 disposer，那个返回面没人消费。
    //  - `register`：官方是**双重载**（`inject?: undefined` 与 `inject: (…) => I`），
    //    重载目标推不出上下文参数类型（TS7006），故按 `unknown` 收、在桩内一次性投影
    //    回本卡实际传的那一重载。
    effect: ((factory: () => (() => void) | undefined): void => {
      const teardown = factory();
      if (typeof teardown === "function") {
        effects.push(teardown);
      }
    }) as Context["effect"],
    slots: {
      inject: (name, factory): (() => void) => {
        slots.push(name);
        // 官方 `SlotInjectionEffect`：一个 disposer 或一组 disposer（本卡是前者）。
        const teardown = factory();
        if (typeof teardown === "function") {
          slotCleanups.push(teardown);
        }
        return noop;
      },
      register: (registration: unknown, component: unknown): (() => void) => {
        const desc = registration as {
          name: string;
          key?: string;
          inject?: () => Record<string, unknown>;
        };
        slotDescs.push({ name: desc.name, key: desc.key });
        // payload 只记**卡片**那一条：本包还向详情页与启用指引贡献了三条注册，
        // 一并覆盖会让「translator 以 t 经 payload 下发」那条断言变成看运气。
        if (desc.name === CARD_SLOT) {
          payload = { ...desc.inject?.(), component };
        }
        return (): void => {
          payload = null;
        };
      },
    },
    configForms: {
      get: (entryId: string): StubForm => {
        formEntryIds.push(entryId);
        return {
          ...form,
          // 绊线：0.1.7 的 ConfigForm 没有 dispose（installed config-form-types.d.ts 的 ConfigForm）。
          // 卡片 slot disposer 一旦回退成「先销毁表单再注销」，这里立刻抛并留下计数。
          dispose: (): never => {
            disposed += 1;
            throw new Error("configForms.get() 交回的是 provider 持有的共享表单，卡片不得 dispose");
          },
        };
      },
    },
    locale: {
      // 官方类型化重载：两语一次性交齐，返回**一个** disposer（宿主实现正是按
      // `Object.entries(dicts)` 回收这一份注册里的全部 locale）。
      register: (ns, dicts): (() => void) => {
        registered.push({ ns, dicts });
        return noop;
      },
      bind: (): Translate => options.bound ?? tZh,
    },
  };
  return {
    ctx,
    registered,
    formEntryIds,
    slots,
    slotDescs,
    effects,
    slotCleanups,
    disposedOf: (): number => disposed,
    payloadOf: (): Record<string, unknown> | null => payload,
    cleanSlots: (): void => {
      for (const cleanup of slotCleanups) {
        cleanup();
      }
    },
  };
}

/** sensenova 样本的模型标识与 baseURL（与 test/fixtures/settings-fixture.ts 同值，
 *  在此独立声明而不引实现侧常量：渲染断言必须对着「期望值」，而不是对着实现自己用的名）。 */
const SENSENOVA_MODEL = "deepseek-v4-flash";
const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

const BASE_DEPS: OcrCardDeps = {
  t: tZh,
  data: null,
  fetchError: null,
  busy: null,
  actionMsg: null,
  ready: true,
  writable: true,
  effectiveProvider: "sensenova",
  effectiveModel: SENSENOVA_MODEL,
  chosenProvider: undefined,
  modelOptions: [],
  keyHint: "",
  statusHint: null,
  binary: null,
  probeMsg: null,
  effortValue: "medium",
  languageValue: "中文",
  autoVerifyValue: true,
  maxCommentsValue: 12,
  timeoutMinutesValue: 0,
  ocrConfigPathValue: "",
  dirty: false,
  settingsBusy: false,
  saveError: null,
  onPickProvider: noop,
  onPickModel: noop,
  onApply: noop,
  onTest: noop,
  onMigrate: noop,
  onProbe: noop,
  onField: noop,
  onSave: noop,
  onDiscard: noop,
};

const depsWith = (t: Translate, over: Partial<OcrCardDeps> = {}): OcrCardDeps => ({
  ...BASE_DEPS,
  t,
  ...over,
});

// displayName 用 ASCII：英文那份的断言是「整棵子树无汉字」，不能被样本数据里的
// 厂商中文名干扰（真实数据里它也可能中文，但那属数据不属文案）。
const SENSENOVA = {
  name: "sensenova",
  displayName: "Sensenova",
  apiKeyEnv: "SENSENOVA_API_KEY",
  baseURL: SENSENOVA_BASE_URL,
  models: [
    { id: SENSENOVA_MODEL, name: SENSENOVA_MODEL },
    { id: "second", name: "second" },
  ],
  hasKey: true,
};
const XKIRO = {
  name: "xkiro",
  displayName: "xkiro",
  apiKeyEnv: "XKIRO_API_KEY",
  baseURL: "https://api.xkiro.com/v1",
  models: [],
  hasKey: false,
};

const READY_DATA = {
  providers: [SENSENOVA, XKIRO],
  current: {
    provider: "sensenova",
    model: SENSENOVA_MODEL,
    keyIsDynamic: true,
    url: SENSENOVA_BASE_URL,
  },
  getCredReady: true,
  source: { status: "ready", message: "" },
};

/** 装载期自检提示的取文辅助（模块级：放 it / describe 里会被 sonarjs 判「每次调用重建」）。 */
const withVerify = (verify: { ok: boolean; message: string } | null): string =>
  textOf(buildProviderSection(depsWith(tZh, { data: { ...READY_DATA, endpointVerify: verify } })));

const CURRENT = {
  provider: "sensenova",
  model: SENSENOVA_MODEL,
  keyIsDynamic: true,
  url: SENSENOVA_BASE_URL,
};

interface SaveBarState {
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
}

// SaveBar 在本文件里被当普通工厂函数直接调用（node 环境没有渲染器，要的是
// createElement 产出的元素树里的 props 文本）。小写别名只承载「这是一次函数调用
// 而不是构造」，组件本身仍是 client-entry 导出的大写组件。
const saveBar = SaveBar;

const saveBarOf = (t: Translate, state: Partial<SaveBarState> = {}): string =>
  textOf(
    saveBar({
      t,
      dirty: state.dirty ?? true,
      writable: state.writable ?? true,
      busy: state.busy ?? false,
      error: state.error ?? null,
      onSave: noop,
      onDiscard: noop,
    }),
  );

// ── cardStore：官方快照 → 渲染视模型 ───────────────────────────────────────
// src 绑上官方 `ConfigForm` 之后，这里删掉了 `fieldOf(snap,"status")` 那套逐位再解析
// （含 `isRecord(rawValue)` 与 `writableValue === true` 两处降级）。它们能表达的形状
// （status 越界 / writable 非布尔 / value 非对象）在官方快照上**不可表示**——provider
// 已按命名空间 schema decode/derive 过。下面两条钉住的正是官方真会送来的那两态。

function scopeWith(initial: Snap): { form: StubForm; emit: (next: Snap) => void } {
  let current = initial;
  return {
    form: {
      getSnapshot: () => current,
      subscribe: () => noop,
      set: async () => true,
      unset: async () => true,
      mutate: async () => true,
    },
    emit: (next: Snap) => {
      current = next;
    },
  };
}

describe("cardStore 取官方快照的三态", () => {
  it("ready 快照逐位直取，同一快照引用回同一视图对象（uSES 不死循环）", () => {
    const { form } = scopeWith(snap());
    const store = cardStore(form);
    expect(store.getSnapshot()).toStrictEqual({
      status: "ready",
      writable: true,
      value: { effort: "high" },
    });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("首个快照受理前 value 缺席 → 视图空对象；宿主拒写时 writable 恒假", () => {
    const { form, emit } = scopeWith(
      snap({ status: "loading", value: undefined, revision: undefined }),
    );
    const store = cardStore(form);
    expect(store.getSnapshot()).toStrictEqual({ status: "loading", writable: true, value: {} });
    emit(snap({ status: "unavailable", writable: false }));
    expect(store.getSnapshot()).toStrictEqual({
      status: "unavailable",
      writable: false,
      value: { effort: "high" },
    });
  });
});

describe("apply 的官方 locale 接线", () => {
  afterEach(() => {
    globalThis.ocrReviewCardApplied = undefined;
    document.head.querySelector(CARD_STYLE_SELECTOR)?.remove();
  });

  it("inject 声明 locale；两语字典一次性注册进官方 locale", () => {
    // inject 清单就是装配契约：`settingsScope` 在 installed 0.1.7 全树零命中，留着它整条
    // client 入口挂不上（症状正是「设置卡静默消失」）。替代面 = configForms（installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98 的 Context 增强、
    // :142 的 get<T>(entryId): ConfigForm<T>）。精确全等，不放宽为包含判定。
    expect(inject).toStrictEqual(["slots", "configForms", "locale"]);
    const harness = makeCtx();
    apply(harness.ctx);
    // 表单按 **profile 条目 id** 取（0.1.7 起设置命名空间即条目 id），本包那一行是
    // cordis.patch.yml 里的裸 id `ocr-review`（与下方装配用例同一条判据）。
    expect(harness.formEntryIds).toStrictEqual([PLUGIN_ENTRY_ID]);
    expect(harness.slots).toStrictEqual([CARD_SLOT, BADGE_SLOT, SECTION_SLOT, ACTIVATION_SLOT]);
    // 官方类型化 register：一次调用带齐两语，故 (命名空间, locale) 的展开结果与旧的两份
    // 逐语注册逐字相同——「两语都注册到本包命名空间」这条判据没有松动。
    expect(
      harness.registered.flatMap((row) =>
        Object.keys(row.dicts).map((localeId) => [row.ns, localeId]),
      ),
    ).toStrictEqual([
      [PLUGIN_ENTRY_ID, "zh"],
      [PLUGIN_ENTRY_ID, "en"],
    ]);
    expect(harness.registered[0]?.dicts.zh.cardTitle).toBe(UI_MESSAGES.zh.cardTitle);
    expect(harness.registered[0]?.dicts.en.cardTitle).toBe(UI_MESSAGES.en.cardTitle);
  });

  it("bind 出的 translator 以 t 经 slots.register payload 下发", () => {
    const harness = makeCtx({ bound: tEn });
    apply(harness.ctx);
    const payload = harness.payloadOf();
    expect(payload).not.toBeNull();
    const injected = payload as unknown as { t: Translate; hooks: unknown; set: unknown };
    expect(injected.t).toBe(tEn);
    expect(injected.hooks).toBeDefined();
    // payload 里那份就是 bind 回来的 translator：插值真能把字典模板填出来。
    expect(injected.t("applied", { provider: "amd", model: "m", test: "t" })).toBe(
      "Applied: amd / m\nt",
    );
    // 三个 effect：apply claim + 样式 + locale 字典（locale 字典随 effect 回收）。
    expect(harness.effects).toHaveLength(3);
    expect(harness.slotCleanups).toHaveLength(4);
    expect(document.head.querySelector(CARD_STYLE_SELECTOR)).not.toBeNull();
    harness.cleanSlots();
    expect(harness.payloadOf()).toBeNull();
    // 0.1.7 契约移动：`configForms.get()` 交回的是 provider 持有的**共享**表单
    //（installed config-form.d.ts:138-142 "owned by this provider"），消费契约 `ConfigForm`
    //（config-form-types.d.ts 的 ConfigForm）里根本没有 dispose，provider 在自己的 fiber 上统一回收
    //（installed lib/client.js:1290-1293）。故 slot disposer 只注销登记、绊线计数恒 0
    //（迁移前这里是 `toBe(1)`：卡片自己 dispose 那张共享表单，重挂之后每次保存被静默丢弃）。
    // mock 的 dispose 是一根会抛的绊线，真被调用时 cleanSlots() 就直接炸在这里。
    expect(harness.disposedOf()).toBe(0);
    for (const teardown of harness.effects) {
      teardown();
    }
    expect(document.head.querySelector(CARD_STYLE_SELECTOR)).toBeNull();
    expect(globalThis.ocrReviewCardApplied).toBeUndefined();
  });

  it("重复 apply 只生效一次（apply claim 随 effect 回收）", () => {
    const harness = makeCtx();
    apply(harness.ctx);
    apply(harness.ctx);
    expect(harness.formEntryIds).toStrictEqual([PLUGIN_ENTRY_ID]);
    // 一次注册带齐两语（官方类型化 register），第二次 apply 什么都没加——旧写法在这里是
    // 两份逐语注册、第二次 apply 后仍是 2 条，判据（不重复注册）完全一致。
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered.flatMap((row) => Object.keys(row.dicts))).toStrictEqual(["zh", "en"]);
  });

  // ── 0.1.7 装配契约：入口从 settingsScope 换成 ctx.configForms（迁移回归锚点）────
  it("0.1.7 装配：inject 不再索要 settingsScope；表单按条目 id 取一次；disposer 不销毁表单", () => {
    // `settingsScope` 在 installed 0.1.7 全树零命中，留在清单里 = 整条 client 入口挂不上
    //（症状正是「设置卡静默消失」）。替代面 = configForms（installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98 的 Context 增强、
    // :142 的 get<T>(entryId)）。本文件跑在 tsconfig.client.json 的浏览器工程里（types:[]，
    // 读不了 cordis.patch.yml），条目 id 与那一行的对拍靠上面 formEntryIds 的精确断言 +
    // node 侧 test/build-client.test.ts（那里解析 cordis.patch.yml 与 profile 的 bundles 清单）。
    expect(inject).not.toContain("settingsScope");
    const harness = makeCtx();
    apply(harness.ctx);
    // 只取一次，取的是本包在 cordis.patch.yml 里声明的那一行 `ocr-review`
    //（0.1.7 起设置命名空间即条目 id；本包没有 danger-guard 那种持 Config 的 bulkhead 行）。
    expect(harness.formEntryIds).toStrictEqual([PLUGIN_ENTRY_ID]);
    // 槽位名与「只注册这一张槽」在此钉住；槽 key 的**值**由 node 侧
    // test/build-client.test.ts 用 profileBundleName() 从
    // `~/.dsh/profiles/web/package.json` 解析钉住（宿主派发的是 bundle 包名：installed
    // dsh-client-ui-plugin-manager/lib/client.js:1821 `entryKey: pkg.name` +
    // slot-contract.d.ts:96-100）。本工程 types:[]（浏览器项目）读不了文件，故不能在此
    // 解析；反过来也**不硬抄**那串包名——硬抄一个错值就会像之前那样一路绿到页面上什么都不渲染。
    // 这里只留反向漂移钉：key 必须是非空字符串，且绝不能再退回裸条目 id `ocr-review`
    //（installed dsh-client-ui-renderer/lib/client.js:1154 逐字相等，退回 = 卡片静默消失）。
    expect(harness.slotDescs).toHaveLength(4);
    // 四条注册逐个点名（顺序即 apply 里的注册顺序）：槽位被改名的症状是那块表面静默
    // 不出现，比只断言条数更能第一时间红。
    expect(harness.slotDescs.map((one) => one.name)).toStrictEqual([
      CARD_SLOT,
      BADGE_SLOT,
      SECTION_SLOT,
      ACTIVATION_SLOT,
    ]);
    // 两条 keyed 槽（卡片、启用指引）必须同键，且那个键既不是空串也不是裸条目 id：
    // renderer 按逐字相等匹配 entryKey，退回裸 id 就等于让表面静默消失。
    const keyedSlots = harness.slotDescs.filter((one) => one.key !== undefined);
    expect(keyedSlots.map((one) => one.name)).toStrictEqual([CARD_SLOT, ACTIVATION_SLOT]);
    const cardKey = keyedSlots[0]?.key;
    expect(keyedSlots[1]?.key).toBe(cardKey);
    expect(cardKey).toBeTypeOf("string");
    expect(cardKey).not.toBe("");
    expect(cardKey).not.toBe(PLUGIN_ENTRY_ID);
    // disposer 只 unregister：0.1.7 的 ConfigForm 没有 dispose，跑到绊线就抛（→ 用例红）。
    expect(harness.slotCleanups).toHaveLength(4);
    harness.cleanSlots();
    expect(harness.disposedOf()).toBe(0);
  });
});

const readOnly = (t: Translate): string => saveBarOf(t, { dirty: false, writable: false });
const busy = (t: Translate): string => saveBarOf(t, { busy: true });
const clean = (t: Translate): string => saveBarOf(t, { dirty: false });

describe("卡片双语（换 translator 即换语言，同一条渲染路径）", () => {
  it("SaveBar：zh 中文状态条，en 全英文且不残留汉字", () => {
    const zh = saveBarOf(tZh);
    expect(zh).toContain("有未保存的修改，点「保存」生效");
    expect(zh).toContain("撤销");
    const en = saveBarOf(tEn);
    expect(en).toContain("Unsaved changes — press Save to apply");
    expect(en).toContain("Revert");
    expect(en).not.toMatch(HAN);
  });

  it("只读 / busy / clean 三态各取其语", () => {
    expect(readOnly(tZh)).toContain("当前作用域只读");
    expect(readOnly(tEn)).toContain("This scope is read-only");
    expect(busy(tZh)).toContain("保存中…");
    expect(busy(tEn)).toContain("Saving…");
    expect(clean(tZh)).toContain("无未保存的修改");
    expect(clean(tEn)).toContain("No unsaved changes");
  });

  it("Provider 区 ready 分支：按钮/说明/未配置 key 后缀整体换语言", () => {
    // 插值过的 keyHint 先取成变量：嵌进 depsWith 再进 buildProviderSection 会
    // 顶到 unicorn/max-nested-calls 上限（3）。
    const enHint = tEn("keyDynamicHint");
    const enDeps = depsWith(tEn, {
      data: READY_DATA,
      chosenProvider: SENSENOVA,
      modelOptions: SENSENOVA.models,
      keyHint: enHint,
    });
    const en = textOf(buildProviderSection(enDeps));
    expect(en).toContain("Apply to OCR config");
    expect(en).toContain("Migrate plain-text keys");
    expect(en).toContain("no key configured");
    expect(en).toContain("Keys are read dynamically via get-cred.mjs");
    expect(en).not.toMatch(HAN);
    const zhHint = tZh("keyScriptMissing");
    const zhDeps = depsWith(tZh, { data: READY_DATA, keyHint: zhHint });
    const zh = textOf(buildProviderSection(zhDeps));
    expect(zh).toContain("应用到 OCR 配置");
    expect(zh).toContain("（未配置 key）");
    expect(zh).toContain("⚠ get-cred 脚本缺失");
  });

  it("装载期自检失败 ⇒ ready 分支上方多一行提示；通过/未跑都不出这行", () => {
    const failed = withVerify({ ok: false, message: "MissingSessionID" });
    expect(failed).toContain("装载期端点自检失败");
    expect(failed).toContain("MissingSessionID");
    expect(withVerify({ ok: true, message: "" })).not.toContain("装载期端点自检失败");
    expect(withVerify(null)).not.toContain("装载期端点自检失败");
  });

  it("Provider 区三条降级路径按语言（含宿主没给原因时的兜底）", () => {
    const loading = (t: Translate): string => textOf(buildProviderSection(depsWith(t)));
    expect(loading(tZh)).toContain("加载 providers…");
    expect(loading(tEn)).toContain("loading providers…");
    const failed = (t: Translate): string =>
      textOf(buildProviderSection(depsWith(t, { fetchError: "boom" })));
    expect(failed(tZh)).toContain("加载 providers 失败：boom（远程面未就绪？重启 dsh 后重试）");
    expect(failed(tEn)).toContain("failed to load providers: boom");
    const degraded = (t: Translate): string =>
      textOf(
        buildProviderSection(
          depsWith(t, {
            data: { ...READY_DATA, source: { status: "settings-unavailable", message: "" } },
          }),
        ),
      );
    expect(degraded(tZh)).toContain("未能从 dsh 配置服务读取 provider 列表：宿主未给出原因");
    expect(degraded(tEn)).toContain("the host gave no reason");
    // 宿主给了原因时原样透出那半句（它已在 host 侧按语言生成，卡片不再翻）
    const withReason = textOf(
      buildProviderSection(
        depsWith(tEn, {
          data: {
            ...READY_DATA,
            source: { status: "settings-unavailable", message: "reason from host" },
          },
        }),
      ),
    );
    expect(withReason).toContain("Could not read the provider list");
    expect(withReason).toContain("reason from host");
  });

  it("设置区：行标题/说明与下拉项文本整体换语言", () => {
    const zh = textOf(buildSettingsSection(depsWith(tZh), true, noop));
    expect(zh).toContain("审查深度 (effort)");
    expect(zh).toContain("medium — 均衡（默认）");
    expect(zh).toContain("摘要评论条数 (maxComments)");
    expect(zh).toContain("开启");
    const en = textOf(buildSettingsSection(depsWith(tEn), true, noop));
    expect(en).toContain("Review depth (effort)");
    expect(en).toContain("medium — balanced (default)");
    expect(en).toContain("Summary comment cap (maxComments)");
    expect(en).toContain("On");
    // 评审语言的两项：value 是写进 config.language 的枚举值、label 是语言自称，
    // 两语下都保持「中文 / English」原样（刻意不进字典，见 ui-messages.ts 头注释）。
    expect(en).toContain("中文");
    expect(en).toContain("English");
    expect(en).toContain("Review language");
  });

  it("当前配置行与 provider 标签由字典模板插值（两语各得其所）", () => {
    expect(currentConfigText(tZh, CURRENT)).toBe(
      "当前配置：sensenova / deepseek-v4-flash（动态 key）",
    );
    expect(currentConfigText(tEn, { ...CURRENT, model: "", keyIsDynamic: false })).toBe(
      "Current config: sensenova (⚠ plain-text key, migration recommended)",
    );
    expect(currentConfigText(tZh, { ...CURRENT, model: "", keyIsDynamic: false })).toBe(
      "当前配置：sensenova（⚠ 明文 key，建议迁移）",
    );
    expect(providerOptionLabel(tZh, SENSENOVA)).toBe("Sensenova");
    expect(providerOptionLabel(tZh, XKIRO)).toBe("xkiro（未配置 key）");
    expect(providerOptionLabel(tEn, XKIRO)).toBe("xkiro (no key configured)");
  });
});

/** 元素 props 里本文件会读到的那几位。刻意用具体接口而不是 `Record<string, unknown>`：
 *  TS 的 noPropertyAccessFromIndexSignature 要 `["children"]`，而 oxlint 的 dot-notation
 *  要 `.children`，索引签名类型同时喂两条就必红一边——具名属性两边都 satisfied。
 *  `data-field` 带连字符，本来就只能走方括号，两条规则对它都无话可说。 */
interface ElementProps {
  "data-field"?: string;
  children?: unknown;
  className?: string;
  disabled?: boolean;
  onClick?: (() => void) | undefined;
}

/** 元素树里按 data-field 找一位：文本断言看不出 class 与 disabled，属性得单独取。 */
function fieldProps(node: unknown, field: string): ElementProps | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = fieldProps(item, field);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }
  const { props } = node as { props?: ElementProps };
  if (props === undefined) {
    return null;
  }
  return props["data-field"] === field ? props : fieldProps(props.children, field);
}

/** 随包 launcher 的样本路径（三处断言共用，写三遍就成了会各漂各的期望值）。 */
const BUNDLED_LAUNCHER = "/pkg/bin/ocr.js";
/** PATH 上那份全局安装的样本路径。 */
const PATH_LAUNCHER = "/usr/local/bin/ocr";
/** 探测回执那条的 data-field。 */
const PROBE_RESULT = "probe-result";
/** 传输层失败时那条 TypeError 的消息（替身与断言共用，写两遍就成了各漂各的期望值）。 */
const REFUSAL = "connection refused";

/** host 送来的核对版本样本（不引 lib/cli.ts 的那枚常量：卡片只认载荷，写独立字面量才测得到「读到什么报什么」）。 */
const VIEW_EXPECTED = "1.13.0";
/** 装法那句由 host 组好，卡片只原样显示：这里用一段可辨认的样本。 */
const VIEW_INSTALL = "两条命令任选：brew install open-code-review";
/** 「核对版本」那一行的中文原文（多处断言共用，写几遍就成了各漂各的期望值）。 */
const ZH_VERSION_EXPECTED = "本插件的契约按 ocr 1.13.0 逐条核对";
/** 徽标「来自 PATH」那档短文案（同样多处共用）。 */
const ZH_BADGE_PATH = "ocr 来自 PATH";

/**
 * `OcrBinaryView` 的夹具构造口。`measuredVersion` 是必填的（null = 还没测过），
 * 逐处手写容易漏成一侧有、一侧没有，集中一处才漂不了。
 *
 * 三个可选键用 `null` 表「宿主没报这一档」（键必须整个缺席，`exactOptionalPropertyTypes`
 * 不许写 `path: undefined`），缺省则给出「PATH 上 brew 装的那一份、按 VIEW_EXPECTED 核对」
 * 这套最常测的形状。
 */
function viewOf(
  over: {
    source?: string;
    path?: string | null;
    channel?: string | null;
    expectedVersion?: string | null;
    measuredVersion?: string | null;
    installHint?: string | null;
  } = {},
): OcrBinaryView {
  const path = over.path === undefined ? PATH_LAUNCHER : over.path;
  const channel = over.channel === undefined ? "brew" : over.channel;
  const expectedVersion = over.expectedVersion === undefined ? VIEW_EXPECTED : over.expectedVersion;
  const installHint = over.installHint === undefined ? VIEW_INSTALL : over.installHint;
  return {
    source: over.source ?? "path",
    ...(path === null ? {} : { path }),
    ...(channel === null ? {} : { channel }),
    ...(expectedVersion === null ? {} : { expectedVersion }),
    ...(installHint === null ? {} : { installHint }),
    measuredVersion: over.measuredVersion ?? null,
  };
}

/** 读取器替身里不参与本组用例的方法：调到即失败（文本面用例不该顺手证明别的方法可用）。 */
async function unusedReaderMethod(): Promise<never> {
  throw new Error("unused reader method");
}

/**
 * 读取器替身：按调用次序交出 providers 回包（本组用例只走这一位）。
 */
function readerStub(replies: readonly (() => Promise<Record<string, unknown>>)[]): {
  reader: OcrReader;
  calls: () => number;
} {
  let count = 0;
  const reader: OcrReader = {
    providers: async () => {
      const step = replies[count] ?? (async () => ({}));
      count += 1;
      return step();
    },
    select: unusedReaderMethod,
    migrate: unusedReaderMethod,
    test: unusedReaderMethod,
    probe: unusedReaderMethod,
  };
  return { reader, calls: () => count };
}

describe("外部 CLI 状态行：wire 形状、四档文本与检测回执", () => {
  it("binaryOf 只认 host 送的那三种 source，其余一律「没报」", () => {
    expect(
      binaryOf({
        source: "bundled",
        path: BUNDLED_LAUNCHER,
        channel: "npm",
        expectedVersion: VIEW_EXPECTED,
        measuredVersion: null,
        installHint: VIEW_INSTALL,
      }),
    ).toStrictEqual({
      source: "bundled",
      path: BUNDLED_LAUNCHER,
      channel: "npm",
      expectedVersion: VIEW_EXPECTED,
      measuredVersion: null,
      installHint: VIEW_INSTALL,
    });
    // 空串一律不落键（host 那侧缺字段时给的就是空串）：留着键等于让文案里出现一句空话。
    expect(binaryOf({ source: "path" })).toStrictEqual({
      source: "path",
      measuredVersion: null,
    });
    // 旧宿主不带 measuredVersion：按「没测过」处理，而不是把整行判定作废。
    expect(
      binaryOf({ source: "path", path: PATH_LAUNCHER, measuredVersion: "1.2.3" }),
    ).toStrictEqual({ source: "path", path: PATH_LAUNCHER, measuredVersion: "1.2.3" });
    expect(binaryOf({ source: "weird" })).toBeNull();
    expect(binaryOf(null)).toBeNull();
    expect(binaryOf("bundled")).toBeNull();
  });

  it("四档状态文本（中文那一份逐字对齐行动性最高的两档）", () => {
    expect(binaryStatusText(tZh, viewOf({ source: "bundled", path: BUNDLED_LAUNCHER }))).toContain(
      BUNDLED_LAUNCHER,
    );
    // 装法与版本都在这一行：用户要的是「哪一份、谁装的」，而不是「有一个 ocr」。
    expect(binaryStatusText(tZh, viewOf({ channel: "brew" }))).toContain("brew formula");
    expect(binaryStatusText(tZh, viewOf({ channel: "npm" }))).toContain("npm 全局包");
    expect(binaryStatusText(tZh, viewOf({ channel: null }))).toContain("装法未识别");
    expect(binaryStatusText(tZh, viewOf({ source: "none", path: null }))).toContain("未找到 ocr");
    expect(binaryStatusText(tZh, viewOf({ source: "path" }))).toContain(PATH_LAUNCHER);
    expect(binaryStatusText(tZh, null)).not.toBe(binaryStatusText(tZh, viewOf()));
  });

  it("英文那一份整行不含汉字，且随包/未找到两档各自成话", () => {
    const bundled = binaryStatusText(tEn, viewOf({ source: "bundled", path: BUNDLED_LAUNCHER }));
    const missing = binaryStatusText(tEn, viewOf({ source: "none", path: null }));
    expect(bundled).not.toMatch(HAN);
    expect(missing).not.toMatch(HAN);
    expect(bundled).not.toBe(missing);
  });

  it("版本那一行：没测过只说核对版本，测过再补一句一致/不一致", () => {
    expect(cliVersionText(tZh, viewOf({ measuredVersion: null }))).toBe(ZH_VERSION_EXPECTED);
    expect(cliVersionText(tZh, viewOf({ measuredVersion: "1.13.0" }))).toContain(
      "本机实测 1.13.0，与核对版本一致",
    );
    const diverged = cliVersionText(tZh, viewOf({ measuredVersion: "1.12.13" }));
    expect(diverged).toContain("本机实测 1.12.13");
    expect(diverged).toContain("与核对版本 1.13.0 不一致");
    // 宿主没报或没给核对版本 ⇒ 整行不说（不编一句「版本未知」的结论）。
    expect(cliVersionText(tZh, null)).toBe("");
    expect(cliVersionText(tZh, viewOf({ expectedVersion: null }))).toBe("");
  });

  it("装法那一行只在两条路都没有候选时出现", () => {
    expect(cliInstallText(viewOf({ source: "none", path: null }))).toBe(VIEW_INSTALL);
    // 已装着的时候这句是噪音：那种场合用户要的是版本核对，那一句已经说了。
    expect(cliInstallText(viewOf())).toBe("");
    expect(cliInstallText(null)).toBe("");
  });

  it("状态行把标题、状态文本、版本行、装法与检测按钮画齐", () => {
    const node = buildCliStatusRow(
      depsWith(tZh, { binary: viewOf({ source: "none", path: null }) }),
    );
    const text = textOf(node);
    expect(text).toContain("外部 CLI（ocr）");
    expect(text).toContain("未找到 ocr");
    expect(text).toContain(VIEW_INSTALL);
    expect(text).toContain("本插件的契约按 ocr 1.13.0 逐条核对");
    expect(text).toContain("检测版本");
    expect(fieldProps(node, "probe")).not.toBeNull();
  });

  it("进行中：按钮文案换成「检测中…」并禁用（防连点起两个 ocr 进程）", () => {
    const node = buildCliStatusRow(depsWith(tZh, { busy: "probe" }));
    const props = fieldProps(node, "probe");
    expect(props?.disabled).toBe(true);
    expect(textOf(node)).toContain("检测中…");
    expect(textOf(node)).not.toContain("检测版本");
  });

  it("文案只跟着**自己**那条动作走：探测在飞时「应用」不许读成「应用中…」", () => {
    // 四条动作共用一个在飞旗标（一个传输口 + 一份回执，本就只跑一条），所以「有没有
    // 动作在飞」和「是哪一条」必须分开判——只看布尔，按下「检测版本」就会把「应用」
    // 按钮念成「应用中…」，而什么都没被应用过。
    const probing = buildProviderSection(
      depsWith(tZh, { data: READY_DATA, ready: true, busy: "probe" }),
    );
    expect(textOf(probing)).not.toContain("应用中");
    expect(fieldProps(probing, "apply")?.disabled).toBe(true);
    const applying = buildProviderSection(
      depsWith(tZh, { data: READY_DATA, ready: true, busy: "apply" }),
    );
    expect(textOf(applying)).toContain("应用中");
    const statusRow = buildCliStatusRow(depsWith(tZh, { busy: "apply" }));
    // 别人在飞时本按钮同样禁用（同一时刻只跑一条），但文案仍是「检测版本」。
    expect(fieldProps(statusRow, "probe")?.disabled).toBe(true);
    expect(textOf(statusRow)).toContain("检测版本");
    expect(textOf(statusRow)).not.toContain("检测中");
  });

  it("回执条：有则按 ok/err 上色，无则整条不画", () => {
    const idle = buildCliStatusRow(depsWith(tZh, {}));
    expect(fieldProps(idle, PROBE_RESULT)).toBeNull();
    const failed = buildCliStatusRow(
      depsWith(tZh, { probeMsg: { ok: false, text: "未取到版本号：x" } }),
    );
    const props = fieldProps(failed, PROBE_RESULT);
    expect(String(props?.className)).toContain("ocr-err");
    expect(textOf(failed)).toContain("未取到版本号：x");
    const passed = buildCliStatusRow(depsWith(tEn, { probeMsg: { ok: true, text: "v" } }));
    expect(String(fieldProps(passed, PROBE_RESULT)?.className)).toContain("ocr-ok");
  });

  it("loadCliStatus 只读 ocrBinary 那半，读不到（含没有远程面）都归成 null", async () => {
    const stub = readerStub([
      async () => ({ ocrBinary: { source: "path", path: PATH_LAUNCHER } }),
      // 宿主没带这个字段（旧 host）与形状不合（域外的 source）都只能算「没报」。
      async () => ({ providers: [] }),
      async () => ({ ocrBinary: { source: "installed" } }),
    ]);
    await expect(loadCliStatus(stub.reader)).resolves.toStrictEqual({
      source: "path",
      path: PATH_LAUNCHER,
      measuredVersion: null,
    });
    await expect(loadCliStatus(stub.reader)).resolves.toBeNull();
    await expect(loadCliStatus(stub.reader)).resolves.toBeNull();
    // 部署里没有远程面：三处贡献点共用这一个口，判据必须在口上而不是各点各写一份。
    await expect(loadCliStatus(undefined)).resolves.toBeNull();
    expect(stub.calls()).toBe(3);
  });

  it("loadCliStatus 传输失败也归成 null（这三处只负责显示，不叠错误条）", async () => {
    const stub = readerStub([
      async () => {
        throw new TypeError(REFUSAL);
      },
    ]);
    await expect(loadCliStatus(stub.reader)).resolves.toBeNull();
  });
});

/** 详情页 subject 的三种面：本判据只读 kind 与 pkg.name，其余字段随官方形状填齐。
 *  整份 PluginPackageRef 手写而不 as 断言，是为了让宿主加必填字段时这里先编译红。 */
function subjectOf(over: { name: string; kind?: "bundle" | "row" | "item" }): PluginsSubject {
  const kind = over.kind ?? "bundle";
  if (kind === "item") {
    return { kind: "item", id: over.name };
  }
  const pkg: PluginPackageRef = {
    name: over.name,
    installed: true,
    availability: "profile",
    official: false,
    enabled: true,
    rows: [],
  };
  return kind === "bundle"
    ? { kind: "bundle", pkg }
    : { kind: "row", pkg, row: { rowId: "review", moduleName: "ocr-review", enabled: true } };
}

const OWN = "@jayyuen66/dsh-ocr-review";

describe("三处对外贡献：subject 过滤 + 纯渲染", () => {
  it("isOwnSubject 只认本包的 bundle 页与行页", () => {
    expect(isOwnSubject(subjectOf({ name: OWN }))).toBe(true);
    expect(isOwnSubject(subjectOf({ name: OWN, kind: "row" }))).toBe(true);
    // 别人的 bundle / 行：官方契约是「对无话可说的 subject 渲染 null」，这里必须是假。
    expect(isOwnSubject(subjectOf({ name: "@deepseek-ai/dsh-subagent-claude-code" }))).toBe(false);
    expect(isOwnSubject(subjectOf({ name: "other", kind: "row" }))).toBe(false);
    // 官方插件页没有包名可比——少这一道短路就会去读 undefined.name 并整页报错。
    expect(isOwnSubject(subjectOf({ name: "settings", kind: "item" }))).toBe(false);
  });

  it("徽标短文案四档齐全，且英文那份不残留汉字", () => {
    expect(cliBadgeText(tZh, viewOf({ source: "bundled" }))).toBe("ocr 走随包兜底");
    expect(cliBadgeText(tZh, viewOf({ source: "path" }))).toBe(ZH_BADGE_PATH);
    expect(cliBadgeText(tZh, viewOf({ source: "none", path: null }))).toBe("未找到 ocr");
    expect(cliBadgeText(tZh, null)).toBe("ocr 状态未取到");
    for (const status of [
      viewOf({ source: "bundled" }),
      viewOf({ source: "path" }),
      viewOf({ source: "none", path: null }),
      null,
    ] satisfies (OcrBinaryView | null)[]) {
      expect(cliBadgeText(tEn, status)).not.toMatch(HAN);
    }
    // 短文案与整句状态文本共用同一份判据，但必须各说各的话（标题旁放不下整句）。
    expect(cliBadgeText(tZh, viewOf({ source: "none", path: null }))).not.toBe(
      binaryStatusText(tZh, viewOf({ source: "none", path: null })),
    );
  });

  it("实测过且版本不一致时徽标改口说版本，来源那一档让位", () => {
    expect(cliBadgeText(tZh, viewOf({ measuredVersion: "1.12.13" }))).toBe("ocr 版本不一致");
    // 没测过时不许抢话：那时「不一致」与否根本没有依据。
    expect(cliBadgeText(tZh, viewOf({ measuredVersion: null }))).toBe(ZH_BADGE_PATH);
    expect(cliBadgeText(tZh, viewOf({ measuredVersion: VIEW_EXPECTED }))).toBe(ZH_BADGE_PATH);
    expect(cliBadgeText(tEn, viewOf({ measuredVersion: "1.12.13" }))).not.toMatch(HAN);
  });

  it("buildCliBadge 落出徽标元素并带上短文案", () => {
    const node = buildCliBadge(tZh, viewOf({ source: "bundled" }));
    expect(String(fieldProps(node, "cli-badge")?.className)).toContain("ocr-hint");
    // textOf 会把 className/data-field 一起拼进来，所以按「含短文案」断言而不是整串相等。
    expect(textOf(node)).toContain("ocr 走随包兜底");
    expect(textOf(buildCliBadge(tEn, null))).toContain("ocr status unavailable");
  });

  it("buildCliSection 画齐标题、状态、版本核对与「版本要去卡片点检测」的指路", () => {
    const node = buildCliSection(tZh, viewOf());
    expect(fieldProps(node, "cli-section")).not.toBeNull();
    const text = textOf(node);
    expect(text).toContain("外部 CLI（ocr）");
    expect(text).toContain(PATH_LAUNCHER);
    expect(text).toContain(ZH_VERSION_EXPECTED);
    expect(text).toContain("检测版本");
    // 没装时那一句装法要在区块里看得见（详情页是用户读文档之外的第二个入口）。
    const missingZh = textOf(buildCliSection(tZh, viewOf({ source: "none", path: null })));
    expect(missingZh).toContain(VIEW_INSTALL);
    // 那句是 host 按当前语言组好的原文，卡片只原样显示：英文界面下样本也按英文给，
    // 这里断的是「卡片自己那一半文案不带汉字」，不是替 host 翻它给的那句。
    const missingEn = textOf(
      buildCliSection(tEn, viewOf({ source: "none", path: null, installHint: "brew install" })),
    );
    expect(missingEn).not.toMatch(HAN);
  });

  it("buildCliActivation 给缺失说明配上带版本的装法与两个动作", () => {
    const clicked: string[] = [];
    const node = buildCliActivation(
      tZh,
      {
        onOpenDetails: () => {
          clicked.push("details");
        },
        onDismiss: () => {
          clicked.push("dismiss");
        },
      },
      VIEW_INSTALL,
    );
    expect(fieldProps(node, "cli-activation")).not.toBeNull();
    // 装法原文来自 host（带核对版本），卡片不再自己写一遍命令：两处各写一份就会漂成
    // 「卡片教的版本与插件核对的版本不是一版」。
    expect(textOf(node)).toContain(VIEW_INSTALL);
    const details = fieldProps(node, "guide-details");
    const dismiss = fieldProps(node, "guide-dismiss");
    expect(details?.onClick).toBeTypeOf("function");
    expect(dismiss?.onClick).toBeTypeOf("function");
    details?.onClick?.();
    dismiss?.onClick?.();
    expect(clicked).toStrictEqual(["details", "dismiss"]);
    // 英文那份同样不含汉字（指引出现在启用那一刻，是最外侧的可见文本）。
    expect(
      textOf(buildCliActivation(tEn, { onOpenDetails: noop, onDismiss: noop }, "brew install x")),
    ).not.toMatch(HAN);
  });
});

/** 一条探测回执。 */
interface ProbeMsg {
  ok: boolean;
  text: string;
}

/** runProbe 的落态记录：忙位依次经过哪些值、回执依次写出哪些内容、调的是哪条动作、
 *  载荷被重读了几次。 */
interface ProbeRun {
  actions: string[];
  busy: (CardActionKind | null)[];
  messages: (ProbeMsg | null)[];
  refreshes: number;
}

/**
 * 跑一次 runProbe。`post` 由注入给（与卡片里那条读取器接出来的 `post` 同一个口），
 * 替身只送 runProbe 真读的 json()。`fails` 用来模拟传输层失败。
 */
async function probeOnce(json: unknown, fails = false): Promise<ProbeRun> {
  const run: ProbeRun = { actions: [], busy: [], messages: [], refreshes: 0 };
  await runProbe({
    t: tZh,
    post: async (action: string): Promise<Response> => {
      run.actions.push(action);
      if (fails) {
        throw new TypeError(REFUSAL);
      }
      return { json: async () => json } as unknown as Response;
    },
    refresh: async (): Promise<null> => {
      run.refreshes += 1;
      return null;
    },
    setBusy: (next: CardActionKind | null): void => {
      run.busy.push(next);
    },
    setProbeMsg: (message: ProbeMsg | null): void => {
      run.messages.push(message);
    },
  });
  return run;
}

describe("检测版本这条动作：动作名、回执文本与忙位回收", () => {
  it("成功带回版本 + 上游 output 时，回执是「版本行 + 原样附上的 output」", async () => {
    const run = await probeOnce({
      ok: true,
      version: "1.12.13",
      output: "npm i -g @alibaba-group/open-code-review@1.13.0",
    });
    // 动作名逐字钉：读取器的 descriptor 改了而卡片没跟上，症状正是「点了没反应」之外的那句报错。
    expect(run.actions).toStrictEqual(["probe"]);
    expect(run.messages).toStrictEqual([
      null,
      { ok: true, text: "ocr 版本：1.12.13\nnpm i -g @alibaba-group/open-code-review@1.13.0" },
    ]);
    // 忙位必须成对：先占位（按钮禁用）再在 finally 里放开，漏第二步就是永久转圈。
    expect(run.busy).toStrictEqual(["probe", null]);
    // 走完一次来回就要重读载荷：否则「刚装上 CLI 立刻点检测」会出现「版本 1.12.13」与
    // 「未找到 ocr」同屏（状态那行还是页面装载时读的）。
    expect(run.refreshes).toBe(1);
  });

  it("只有版本号时不补空行（output 缺席就只写版本行）", async () => {
    const run = await probeOnce({ ok: true, version: "1.12.13" });
    expect(run.messages[1]).toStrictEqual({ ok: true, text: "ocr 版本：1.12.13" });
  });

  it("host 给了换版命令就插在版本行与 output 之间，没给就不许多嘴", async () => {
    const withCommand = await probeOnce({
      ok: true,
      version: "1.12.13",
      changeText: "brew 那条命令：`brew upgrade open-code-review`",
      output: "open-code-review 1.12.13 darwin/arm64",
    });
    expect(withCommand.messages[1]?.text.split("\n")).toStrictEqual([
      "ocr 版本：1.12.13",
      "brew 那条命令：`brew upgrade open-code-review`",
      "open-code-review 1.12.13 darwin/arm64",
    ]);
    // 一致那一档 host 交回空串：多一行「怎么换版」是噪音。
    const without = await probeOnce({ ok: true, version: "1.13.0", changeText: "" });
    expect(without.messages[1]?.text).toBe("ocr 版本：1.13.0");
  });

  it("host 报失败时把原因写进回执，并把 ok 落成假", async () => {
    const run = await probeOnce({ ok: false, reason: "ocr version 超时" });
    expect(run.messages[1]).toStrictEqual({ ok: false, text: "未取到版本号：ocr version 超时" });
    expect(run.busy).toStrictEqual(["probe", null]);
    // 来回成了、只是没取到版本：载荷照样重读（CLI 可能刚被拆掉，那行得跟着改）。
    expect(run.refreshes).toBe(1);
  });

  it("传输层失败也归成一条错误回执，且忙位照样回收", async () => {
    const run = await probeOnce({}, true);
    expect(run.messages[1]?.ok).toBe(false);
    expect(run.messages[1]?.text).toContain("请求失败：");
    expect(run.messages[1]?.text).toContain(REFUSAL);
    expect(run.busy).toStrictEqual(["probe", null]);
    // 请求根本没成：拿不到任何新事实，就不该再打一次 GET（与 migrate 同一分工）。
    expect(run.refreshes).toBe(0);
  });
});
