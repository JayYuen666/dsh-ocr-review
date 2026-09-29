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
  currentConfigText,
  providerOptionLabel,
} from "../src/client-entry.ts";
import type { OcrCardDeps } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

type Snap = ConfigFormSnapshot<Record<string, unknown>>;

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）：`value` 在首个快照受理前才是
 *  undefined，`mode: "memory"` 时 `writable` 恒假——桩件只能送官方真会送的那些形状。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: { effort: "high" },
    base: {},
    user: {},
    revision: 7,
    writable: true,
    mode: "host",
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
        payload = { ...desc.inject?.(), component };
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
          // 绊线：0.1.7 的 ConfigForm 没有 dispose（installed config-form-types.d.ts:36-74）。
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
  busy: false,
  actionMsg: null,
  ready: true,
  writable: true,
  effectiveProvider: "sensenova",
  effectiveModel: SENSENOVA_MODEL,
  chosenProvider: undefined,
  modelOptions: [],
  keyHint: "",
  statusHint: null,
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
  csrf: "token",
};

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

  it("首个快照受理前 value 缺席 → 视图空对象；memory 模式 writable 恒假", () => {
    const { form, emit } = scopeWith(
      snap({ status: "loading", value: undefined, revision: undefined }),
    );
    const store = cardStore(form);
    expect(store.getSnapshot()).toStrictEqual({ status: "loading", writable: true, value: {} });
    emit(snap({ status: "unavailable", writable: false, mode: "memory" }));
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
    expect(harness.slots).toStrictEqual(["plugins.bundle.config"]);
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
    expect(harness.slotCleanups).toHaveLength(1);
    expect(document.head.querySelector(CARD_STYLE_SELECTOR)).not.toBeNull();
    harness.cleanSlots();
    expect(harness.payloadOf()).toBeNull();
    // 0.1.7 契约移动：`configForms.get()` 交回的是 provider 持有的**共享**表单
    //（installed config-form.d.ts:138-142 "owned by this provider"），消费契约 `ConfigForm`
    //（config-form-types.d.ts:36-74）里根本没有 dispose，provider 在自己的 fiber 上统一回收
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
    expect(harness.slotDescs).toHaveLength(1);
    // 从 map 回调里取值，而不是 `const [cardSlot] = …` 再点成员：client 工程开了
    // noUncheckedIndexedAccess（下标/解构拿到的元素带 `| undefined`），同一枚 `?.` 在
    // tsc 眼里必要、在 oxlint 的类型面眼里多余 —— 两条判据只有这里同时成立。
    const slotNames = harness.slotDescs.map((one) => one.name);
    const slotKeys = harness.slotDescs.map((one) => one.key);
    expect(slotNames).toStrictEqual(["plugins.bundle.config"]);
    expect(slotKeys).toStrictEqual([expect.any(String)]);
    // key 的**值**在替身类型上是 `string | undefined`（宿主给不给 entryKey 说不准）⇒ 空串绊线保留。
    expect(slotKeys.map((key) => key ?? "")).not.toContain("");
    expect(slotKeys).not.toContain(PLUGIN_ENTRY_ID);
    // disposer 只 unregister：0.1.7 的 ConfigForm 没有 dispose，跑到绊线就抛（→ 用例红）。
    expect(harness.slotCleanups).toHaveLength(1);
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

  it("Provider 区三条降级路径按语言（含宿主没给原因时的兜底）", () => {
    const loading = (t: Translate): string => textOf(buildProviderSection(depsWith(t)));
    expect(loading(tZh)).toContain("加载 providers…");
    expect(loading(tEn)).toContain("loading providers…");
    const failed = (t: Translate): string =>
      textOf(buildProviderSection(depsWith(t, { fetchError: "boom" })));
    expect(failed(tZh)).toContain("加载 providers 失败：boom（端点未就绪？重启 dsh 后重试）");
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
