// 产物侧装配契约：本包往宿主注入的**四个贡献槽**逐条对齐，其中卡片与启用指引的**槽 key**
// 必须是 profile bundles 清单里的那一串 bundle 包名，而**取表单**仍用 cordis.patch.yml
// 的裸条目 id。
//
// 为什么要在 node 工程里另开一个文件（test/client/ 已有装配用例）：
// 本包的 tsconfig 分工是 `tsconfig.json`（node，types:["node"]）跑 host/lib/test 与三份根
// 配置，`tsconfig.client.json`（浏览器，types:[]）跑 src/** 与 test/client/**。
// 要**解析** `~/.dsh/profiles/web/package.json` 就得用 node:fs/node:os，在 types:[] 的
// 工程里连 `node:fs` 都解析不了；而槽 key 恰恰只能在能读文件的 node 工程里验。
// 于是分工：本文件（node）钉住 key 的**值**从哪来，test/client/client-card.test.ts
// （浏览器程序）钉住 src 侧的结构与「不得退回裸条目 id」。形状照抄已定案的
// plugins/zvec-grep/test/build-client.test.ts 的 `profileBundleName()`。
//
// 证据（installed dsh 0.1.7，逐条复核）：
//   · dsh-client-ui-plugin-manager/lib/client.js:1821
//     `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })`
//   · 同文件 :2698 `configured: ledger.bundles.has(openPkg.name)`
//   · dsh-client-ui-renderer/lib/client.js:1154
//     `entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)`（逐字相等）
//   · dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
//     「keyed by the bundle's package name」
// 写成裸条目 id 的后果不是报错而是**整张卡静默不渲染**——测试若跟着硬抄同一个错值
// 就一直绿（本包早先的状态正是如此），所以这里坚持解析。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import { buildClient } from "../build-client.mjs";

/** 本包包名与包根（profile 的 link: 目标必须正好是它，否则比的是另一份残留副本）。 */
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

const PKG_DIR = path.resolve(import.meta.dirname, "..");

/**
 * 本包注入的六个槽名。字面量提出来是因为它们在这里要被**逐个点名**断言：槽名和 key
 * 一样，写错的后果都是那块表面静默不出现，而复用同一个串才让"改名"这件事立刻变红。
 * 与 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts 与
 * dsh-client-ui-settings/lib/types/client/contract/slots.d.ts 的 `SlotMap` 声明逐字一致
 * （keyed：`plugins.bundle.config`、`plugins.bundle.activation`；
 * list：`plugins.detail.badge`、`plugins.detail.section`、
 * `settings.section`、`settings.section.icon`）。
 *
 * 后两个是设置页的一级分区与它的导航图标：两者靠**同一个 id** 对上
 * （`settings.section.icon` 的 doc：「unmatched ids never render」），所以那一位单独断言。
 */
const CARD_SLOT = "plugins.bundle.config";
const BADGE_SLOT = "plugins.detail.badge";
const SECTION_SLOT = "plugins.detail.section";
const ACTIVATION_SLOT = "plugins.bundle.activation";
const SETTINGS_SECTION_SLOT = "settings.section";
const SETTINGS_SECTION_ICON_SLOT = "settings.section.icon";
/** 分区在导航里的位次（src 的 `SECTION_ORDER`）。独立写死：实现里改了它而这里没改就该红。 */
const EXPECTED_SECTION_ORDER = 32;

/**
 * 那条 link 是不是指向本检出：`link:` 这类说明符按 profile 所在目录归一（pnpm 写的是
 * `link:../..` 这类相对值），再比 realpath。用 `includes(PKG_DIR)` 判会把
 * `dsh-ocr-review-old`、`dsh-ocr-review-copy` 这类以本目录名开头的残留副本认成本份，
 * 而拦住的正是这种副本；registry 版本号（非 link）与指向别处同样按「不适用」跳过。
 */
function linksThisCheckout(declared: unknown, profileDir: string): boolean {
  const target =
    typeof declared === "string"
      ? /^link:(?<path>.+)$/u.exec(declared)?.groups?.["path"]
      : undefined;
  if (target === undefined) {
    return false;
  }
  try {
    return realpathSync(path.resolve(profileDir, target)) === realpathSync(PKG_DIR);
  } catch {
    return false;
  }
}
/**
 * profile 的 bundle 清单（`~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`）里
 * 本包那一条，也就是 `plugins.bundle.config` 唯一能命中的 key。顺带钉住两件事：清单里确有
 * 这一条（否则改名带来的不一致没人拦）、profile 的 link 目标就是本目录。
 */
function profileBundleName(): string {
  // 宿主派发插件页的 entryKey 就是被装 bundle 的包名（= 本包 package.json.name，与装法无关），
  // 所以最要紧的那条判断不依赖 profile。profile 只在这台开发机上存在，装了才顺手加两道本机侧的核对：
  // 清单里恰好有一条、link 目标就是本目录（避免比到另一份残留的副本）。
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  const profilePath =
    override === "" ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json") : override;
  if (!existsSync(profilePath)) {
    return PKG_NAME;
  }
  let profile: {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf8")) as typeof profile;
  } catch (error) {
    throw new Error(`${profilePath} 不是可解析的 profile JSON：${String(error)}`, { cause: error });
  }
  const bundles: unknown = profile.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), `${profilePath} 的 dsh.profile.bundles 应是数组`);
  // link 指向的是"哪一份检出"：本机 profile 装的就是这一份时，才顺手钉"清单里恰有一条、
  // 且只指向本目录"这两道机器侧针（改名/残留副本没人拦就是真缺陷）。指向别处时（单包仓的
  // 暂存副本、消费者自己的检出）这条针不适用 —— 拿别的机器的安装状态判红等于把开发机
  // 状态写进包测试，故跳过而不是失败。
  if (!linksThisCheckout(profile.dependencies?.[PKG_NAME], path.dirname(profilePath))) {
    return PKG_NAME;
  }
  const listed = (bundles as unknown[]).filter((item) => item === PKG_NAME);
  assert.deepEqual(listed, [PKG_NAME], "本包在 profile 的 bundles 清单里，且只列一次");
  return PKG_NAME;
}

/** 本包 cordis.patch.yml 声明的裸条目 id（= 0.1.7 的 settings 命名空间 = 表单入参）。 */
function patchEntryIds(): string[] {
  const patch = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  return Array.from(
    patch.matchAll(/^\s*(?:-\s+)?id:\s*(?<id>\S+)\s*$/gmu),
    (row) => row.groups?.["id"] ?? "",
  );
}

/**
 * 本包 cordis.patch.yml 声明的 bundle 包名（`name:` 行）。这一行是 client 半加载的
 * 隐含开关：client-modules 只扫裸包名条目的 dsh.client 声明，槽位也按它 keyed；
 * 包改名而漏改它时没有报错，只有「插件没反应」。
 */
function patchEntryName(): string | undefined {
  const patch = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  return /^\s*name:\s*["']?(?<name>[^"'\s]+)["']?\s*$/mu.exec(patch)?.groups?.["name"];
}

interface LoadedModuleDef {
  id?: string;
  factory?: (require: (name: string) => unknown) => unknown;
}

/** 表单落到轨迹上的写调用 + dispose 绊线命中数（0.1.7 的 ConfigForm 契约里没有 dispose）。 */
interface FormTrace {
  setCalls: [string, unknown][];
  disposeCalls: number[];
}

/** 一条 register 的全部留痕：槽描述 + inject payload + 它的 disposer。 */
interface SlotRecord {
  readonly name: string;
  readonly key: string | undefined;
  /** list 槽的寻址位（`settings.section` / `settings.section.icon` 靠它配对）。 */
  readonly id: string | undefined;
  /** 导航位次（只有 list 槽会带）。 */
  readonly order: number | undefined;
  /** 导航文案（thunk：宿主每次读都重新求值，切语言时跟着变）。 */
  readonly label: (() => string) | undefined;
  readonly payload: unknown;
  readonly cleanup: () => void;
  /** disposer 是否被跑过：装配契约要求每条注册都能被宿主回收。 */
  released: boolean;
}

/** apply 一次所需的最小宿主替身（槽位、表单取用 id、locale 注册都留痕）。 */
interface HostTrace {
  /** `ctx.effect` 的逐条 label：工厂体不执行（样式注入要 document），只验装配确实登记了它们。 */
  effects: { label?: string }[];
  entryIds: string[];
  /** `ctx.slots.inject` 的目标槽名，按注入顺序。 */
  slotNames: string[];
  /** `ctx.slots.register` 的逐条留痕；factory 同步执行 ⇒ 顺序与 slotNames 一致。 */
  slots: SlotRecord[];
}

/** 按槽名取回那一条注册；缺了就立刻炸，而不是让下游断言拿到 undefined 后报出无关的形状。 */
function slotOf(trace: HostTrace, slot: string): SlotRecord {
  const found = trace.slots.find((one) => one.name === slot);
  assert.ok(found !== undefined, `src 未向 ${slot} 注册`);
  return found;
}

/**
 * 本条目共享表单的替身：形状按 installed
 * `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts` 的 `ConfigForm`
 * （getSnapshot、subscribe、set 三个方法 —— set 会返回**是否受理**，只有传输失败才 reject）。
 * `dispose` 只是个绊线：卡片要是试图销毁 provider 持有的共享表单，就会立刻在这里报错。
 */
interface FakeForm {
  getSnapshot: () => { status: string; writable: boolean; value: Record<string, unknown> };
  subscribe: () => () => void;
  set: (field: string, value: unknown) => Promise<boolean>;
  dispose: () => never;
}

function fakeForm(trace: FormTrace): FakeForm {
  return {
    getSnapshot: () => ({ status: "ready", writable: true, value: { effort: "high" } }),
    subscribe: () => () => {
      void 0;
    },
    set: (field: string, value: unknown): Promise<boolean> => {
      trace.setCalls.push([field, value]);
      return Promise.resolve(true);
    },
    dispose: (): never => {
      trace.disposeCalls.push(1);
      throw new Error("卡片不得 dispose provider 持有的共享表单");
    },
  };
}

function makeHost(form: FakeForm): { ctx: unknown; trace: HostTrace } {
  const trace: HostTrace = {
    effects: [],
    entryIds: [],
    slotNames: [],
    slots: [],
  };
  const ctx = {
    // 只登记不执行：样式 effect 需要 document，产物侧用例要的是装配形状而非渲染。
    effect: (factory: () => (() => void) | undefined, label?: string): void => {
      trace.effects.push(label === undefined ? {} : { label });
      void factory;
    },
    slots: {
      inject: (slot: string, factory: () => () => void): void => {
        // inject 的第一个入参是宿主侧的槽标识，逐槽顺序即 src 里的注入顺序。
        trace.slotNames.push(slot);
        factory();
      },
      register: (desc: {
        name: string;
        key?: string;
        id?: string;
        order?: number;
        label?: string | (() => string);
        inject?: () => Record<string, unknown>;
      }): (() => void) => {
        const payload = desc.inject?.() ?? null;
        const record: SlotRecord = {
          name: desc.name,
          key: desc.key,
          id: desc.id,
          order: desc.order,
          label: typeof desc.label === "function" ? desc.label : undefined,
          payload,
          released: false,
          cleanup: () => {
            record.released = true;
          },
        };
        trace.slots.push(record);
        return record.cleanup;
      },
    },
    configForms: {
      get: (entryId: string): unknown => {
        trace.entryIds.push(entryId);
        return form;
      },
    },
    locale: {
      register: (): (() => void) => () => {
        void 0;
      },
      bind:
        () =>
        (key: string): string =>
          key,
    },
  };
  return { ctx, trace };
}

/** 求值**磁盘上的** client.js（宿主真正加载的那份产物；stub ModuleLoader + stub react）。 */
async function loadClientExports(): Promise<{
  apply: (ctx: unknown) => void;
  inject: string[];
}> {
  const out = readFileSync(path.join(PKG_DIR, "client.js"), "utf8");
  const sandbox: {
    loadedDef?: LoadedModuleDef;
    window: { __ModuleLoader__: { load: (def: unknown) => void } };
    console: Console;
  } = {
    window: {
      __ModuleLoader__: {
        load(def: unknown) {
          sandbox.loadedDef = def as LoadedModuleDef;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(out, sandbox);
  const loaded = sandbox.loadedDef;
  assert.ok(
    loaded && typeof loaded === "object" && typeof loaded.factory === "function",
    "ModuleLoader.load was called",
  );
  // 模块表 id = 包名（dsh 的 client-modules 只扫裸包名条目并按包名建键）。
  assert.equal(loaded.id, PKG_NAME);
  const fakeReact = {
    createElement: () => ({}),
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      () => {
        void 0;
      },
    ],
    useEffect: () => {
      void 0;
    },
    useRef: (init: unknown) => ({ current: init }),
  };
  const mod = loaded.factory((name: string) => {
    if (name === "react") {
      return fakeReact;
    }
    if (name === "zod") {
      return { z };
    }
    // shared 的 `./client` 不再是可满足的请求：产物内联了卡片组件（build-client.mjs 的
    // 外置清单只留 react / zod）。工厂真对模块表发起这个 require 时，替身按「未知请求」
    // 抛出，正好把「外置回流」挡在这里——宿主页面上的同款失败是启动期的
    // "missed the module table"（GitHub issue #2）。
    throw new Error(`unexpected require in client factory: ${name}`);
  });
  const exported = mod as { apply?: unknown; inject?: unknown };
  assert.equal(typeof exported.apply, "function");
  return {
    apply: exported.apply as (ctx: unknown) => void,
    inject: [...(exported.inject as unknown[])] as string[],
  };
}

describe("client.js 装配契约（槽 key = bundle 包名，表单 = 裸条目 id）", () => {
  // 产物是否最新这条门禁：下面的用例读的是**磁盘**上的产物（宿主加载的就是它），所以 src 改了没重建
  // 时，它们仍会拿着旧的 key 通过。这一条逐字节比对把「改了 src 必须跑 node build-client.mjs」钉住下来
  // （判据同 plugins/zvec-grep/test/client-freshness.ts，这里就地实现，不新增文件）。
  it("磁盘 client.js 与最新构建逐字节一致（改 src 后必须重建）", async () => {
    const expected = await buildClient();
    const onDisk = readFileSync(path.join(PKG_DIR, "client.js"), "utf8");
    assert.equal(
      onDisk,
      expected,
      "client.js 已过期：src/client-entry.ts 变更后未重建。请运行 node build-client.mjs",
    );
  });

  it("inject 仍是 slots/configForms/locale 三件，且不含已移除的 settingsScope", async () => {
    const { inject } = await loadClientExports();
    // 精确全等，不放宽为包含判定：`settingsScope` 在 installed 0.1.7 全树零命中，
    // 留在清单里 = 整条 client 入口挂不上（症状正是设置卡静默消失）。
    assert.deepEqual(inject, ["slots", "configForms", "locale"]);
  });

  it("产物自足：client.js 不含 shared/client 的请求，也不嵌第二层 ModuleLoader 外壳", async () => {
    const out = readFileSync(path.join(PKG_DIR, "client.js"), "utf8");
    // 卡片组件内联进产物（build-client.mjs 的外置清单只留 react / zod）：对外置供应行
    // 的请求在宿主侧可能静默没有供应（GitHub issue #2），所以这里要的是零命中——
    // 上面的工厂替身把这一条按「未知请求即抛」再钉一遍，两条各管一层（文本层/装配层）。
    assert.ok(
      !out.includes("@jayyuen66/dsh-plugin-shared/client"),
      "client.js 又出现 shared/client 的请求：build-client.mjs 的外置清单回流了",
    );
    // 内联目标是 shared 的 `./client` 经 `import` 条件解析出的 ESM 入口；若解析退化到
    // `default` 条件（factory 外壳形态），嵌进来的第二层 load 外壳会在装载时把本包的
    // 注册顶掉。外壳只允许最外层这一处。
    assert.equal(
      out.split("window.__ModuleLoader__.load").length - 1,
      1,
      "client.js 出现多层 ModuleLoader 外壳：内联解析落到了 shared 的 factory 形态产物上",
    );
  });

  it("四个贡献槽逐条对齐；卡片/指引按 bundle 包名 keyed，表单仍吃裸条目 id", async () => {
    const formTrace: FormTrace = { setCalls: [], disposeCalls: [] };
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(fakeForm(formTrace));
    apply(ctx);

    // 样式注入与 locale 字典各一条：少了前者卡片无样式，少了后者提示回落成 key。
    // 按 label 点名而不用总数：共享库的 claimApply 也会登记一条，总数会跟着它变。
    const effectLabels = new Set(trace.effects.map((one) => one.label));
    assert.ok(effectLabels.has("ocr-review-card: styles"), "注册了样式注入 effect");
    assert.ok(
      effectLabels.has("ocr-review-card: locale dictionaries"),
      "注册了 locale 字典 effect",
    );
    const bareIds = patchEntryIds();
    assert.deepEqual(bareIds, ["ocr-review"], "cordis.patch.yml 只声明一行裸条目 id");
    // name 行与 package.json 的 name 同源：它是 client 半加载的隐含开关，漏改的症状
    // 是设置卡静默不渲染，所以必须在这里对质，不能靠上面的槽 key 断言间接盖住。
    assert.equal(patchEntryName(), PKG_NAME, "cordis.patch.yml 的 name 与 package.json.name 同源");
    // 表单侧**不跟着槽 key 改**：0.1.7 起 settings 命名空间即条目 id，
    // installed dsh-client-ui-settings/lib/client.js:1309-1315 把入参原样当命名空间用。
    assert.deepEqual(trace.entryIds, bareIds, "只取本条目那张共享表单，且只取一次");

    // 四个贡献点逐个点名（顺序即 src 的注入顺序）：改名或漏注的症状都是那块表面静默不出现。
    assert.deepEqual(trace.slotNames, [
      CARD_SLOT,
      BADGE_SLOT,
      SECTION_SLOT,
      ACTIVATION_SLOT,
      SETTINGS_SECTION_SLOT,
      SETTINGS_SECTION_ICON_SLOT,
    ]);
    // 每条 register 的 desc.name 必须正好落在它被注入的那个槽上：错槽 = 内容进了别人的槽，
    // 同样是静默不出现，而 inject 与 register 分家后只有这条能把两者钉在一起。
    assert.deepEqual(
      trace.slots.map((one) => one.name),
      trace.slotNames,
    );

    const card = slotOf(trace, CARD_SLOT);
    const bundleName = profileBundleName();
    assert.equal(card.key, bundleName, "槽 key 必须命中宿主派发的 entryKey");
    // 反向漂移钉：不得退回裸条目 id（那正是卡片不渲染的写法），也不得是行槽 `pkg#rowId`。
    assert.notEqual(card.key, bareIds[0], "key 不再是条目 id");
    assert.ok(
      typeof card.key === "string" && !card.key.includes("#"),
      "bundle 槽的 key 不含 #（行槽才用 <pkg>#<rowId>）",
    );
    assert.equal(card.key, PKG_NAME, "槽 key 与本包 package.json 的 name 同源");
    // 启用指引同为 keyed 槽（slot-contract.d.ts:92-96「keyed by npm package name」），
    // 和卡片用同一个键才会一起出现、一起消失；列表槽不读 key，带上等于把自己限定在某个 subject 之外。
    assert.equal(slotOf(trace, ACTIVATION_SLOT).key, card.key);
    assert.equal(slotOf(trace, BADGE_SLOT).key, undefined);
    assert.equal(slotOf(trace, SECTION_SLOT).key, undefined);
    // 一级分区与它的图标都是 list 槽：靠 id 寻址，带 key 等于把自己限定在某个 subject 之外。
    assert.equal(slotOf(trace, SETTINGS_SECTION_SLOT).key, undefined);
    assert.equal(slotOf(trace, SETTINGS_SECTION_ICON_SLOT).key, undefined);
    // 两条注册的 id 必须逐字相同（宿主只按它对图标与分区），而分区 id 又是本包的裸条目 id。
    assert.equal(
      slotOf(trace, SETTINGS_SECTION_ICON_SLOT).id,
      slotOf(trace, SETTINGS_SECTION_SLOT).id,
      "图标与分区必须用同一个 id，对不上时宿主一条都不渲染",
    );
    assert.equal(slotOf(trace, SETTINGS_SECTION_SLOT).id, bareIds[0]);
    // 导航位次也要对上：两个槽同 order（宿主的导航行按它排），且排在本包声明的 32。
    // 位次撞车时宿主不报错，只是两页按注册顺序先后 —— 那才是「看起来没问题」的坏法。
    assert.equal(slotOf(trace, SETTINGS_SECTION_SLOT).order, EXPECTED_SECTION_ORDER);
    assert.equal(slotOf(trace, SETTINGS_SECTION_ICON_SLOT).order, EXPECTED_SECTION_ORDER);
    // label 必须是 thunk 而不是算好的字符串：宿主每次读导航行都重新求值，切语言才跟着变。
    const { label } = slotOf(trace, SETTINGS_SECTION_SLOT);
    assert.equal(typeof label, "function", "label 必须是 thunk，写死字符串切语言时不会更新");
    assert.equal(label?.(), "navLabel", "导航文案走本包字典的 navLabel 键");
  });

  it("写入仍落到那张按裸条目 id 取回的共享表单；disposer 只注销、不 dispose", async () => {
    const formTrace: FormTrace = { setCalls: [], disposeCalls: [] };
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(fakeForm(formTrace));
    apply(ctx);
    const payload = slotOf(trace, CARD_SLOT).payload as {
      set: (field: string, value: unknown) => boolean | Promise<boolean>;
    };
    // 是否受理这个结果必须传出来：官方 ConfigForm.set 用它区分「宿主受理」和「拒绝或跳过」，
    // 丢掉它就分不出「已保存」和「宿主根本没写到磁盘」这两种用户看得见的结果。
    assert.equal(
      await payload.set("effort", "low"),
      true,
      "payload.set 把是否受理的结果回传给卡片",
    );
    assert.deepEqual(
      formTrace.setCalls,
      [["effort", "low"]],
      "改的是槽 key，不是表单来源：写入仍要落回 configForms.get(裸条目 id) 那张表单",
    );
    // 六个槽各回收一次：disposer 存在、可调用，且一次都不碰 provider 持有的共享表单。
    assert.equal(trace.slots.length, 6);
    for (const one of trace.slots) {
      one.cleanup();
      assert.equal(one.released, true, `${one.name} 的 disposer 必须可调用`);
    }
    assert.deepEqual(
      formTrace.disposeCalls,
      [],
      "disposer 不得销毁 provider 持有的共享表单（0.1.7 ConfigForm 契约无 dispose）",
    );
  });
});
