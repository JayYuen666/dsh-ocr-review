// 产物侧装配契约：卡片在 `plugins.bundle.config` 上的**槽 key** 必须是 profile bundles
// 清单里的那一串 bundle 包名，而**取表单**仍用 cordis.patch.yml 的裸条目 id。
//
// 为什么要在 node 工程里另开一个文件（test/client-card.test.ts 已有装配用例）：
// 本包的两个 tsconfig 分工是 `tsconfig.json`（node，types:["node"]）跑 host/lib/test，
// `tsconfig.client.json`（浏览器，types:[]）跑 src/** 与 client-card.test.ts。
// 要**解析** `~/.dsh/profiles/web/package.json` 就得用 node:fs/node:os，在 types:[] 的
// 工程里连 `node:fs` 都解析不了；而槽 key 恰恰只能在能读文件的这一侧验。
// 于是分工：本文件（node）钉住 key 的**值**从哪来，client-card.test.ts（浏览器）钉住
// src 侧的结构与「不得退回裸条目 id」。形状照抄已定案的
// plugins/zvec-grep/test/build-client.test.ts:33 `profileBundleName()`。
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
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildClient } from "../build-client.mjs";

/** 本包包名与包根（profile 的 link: 目标必须正好是它，否则比的是另一份残留副本）。 */
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

const PKG_DIR = path.resolve(import.meta.dirname, "..");

/**
 * profile 的 bundle 清单（`~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`）里
 * 本包那一条，即 `plugins.bundle.config` 唯一可命中的 key。顺带钉住两件事：清单里确有
 * 这一条（否则改名的漂移没人拦）、profile 的 link 目标就是本目录。
 */
function profileBundleName(): string {
  // 宿主派发插件页的 entryKey 就是被装 bundle 的包名（= 本包 package.json.name，与装法无关），
  // 所以核心判据不依赖 profile。profile 只在这台开发机上存在，装了才顺手钉两道机器侧针：
  // 清单里恰有一条、link 目标就是本目录（避免比到另一份残留副本）。
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  const profilePath =
    override === "" ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json") : override;
  if (!existsSync(profilePath)) {
    return PKG_NAME;
  }
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles: unknown = profile.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), `${profilePath} 的 dsh.profile.bundles 应是数组`);
  // link 指向的是"哪一份检出"：本机 profile 装的就是这一份时，才顺手钉"清单里恰有一条、
  // 且只指向本目录"这两道机器侧针（改名/残留副本没人拦就是真缺陷）。指向别处时（单包仓的
  // 暂存副本、消费者自己的检出）这条针不适用 —— 拿别的机器的安装状态判红等于把开发机
  // 状态写进包测试，故跳过而不是失败。
  const installedHere: unknown = profile.dependencies?.[PKG_NAME];
  if (!(typeof installedHere === "string" && installedHere.includes(PKG_DIR))) {
    return PKG_NAME;
  }
  const listed = (bundles as unknown[]).filter((item) => item === PKG_NAME);
  assert.deepEqual(listed, [PKG_NAME], "本包在 profile 的 bundles 清单里，且只列一次");
  const link: unknown = profile.dependencies?.[PKG_NAME];
  assert.equal(typeof link, "string", "profile 的 dependencies 指向本包");
  assert.ok(
    typeof link === "string" && link.includes(PKG_DIR),
    `profile 的 link 目标应是本目录（实得 ${String(link)}）`,
  );
  return PKG_NAME;
}

/** 本包 cordis.patch.yml 声明的裸条目 id（= 0.1.7 的 settings 命名空间 = 表单入参）。 */
function patchEntryIds(): string[] {
  const patch = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  return [...patch.matchAll(/^\s*(?:-\s+)?id:\s*(?<id>\S+)\s*$/gmu)].map(
    (row) => row.groups?.["id"] ?? "",
  );
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

/** apply 一次所需的最小宿主替身（槽位、表单取用 id、locale 注册都留痕）。 */
interface HostTrace {
  effects: { label?: string }[];
  entryIds: string[];
  slotNames: string[];
  desc: { name: string; key: string | undefined } | null;
  payload: unknown;
  cleanups: (() => void)[];
}

/**
 * 本条目共享表单的替身：形状按 installed
 * `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts` 的 `ConfigForm`
 * （getSnapshot:38 / subscribe:44 / set:65 —— set 回**受理位**，只有传输失败才 reject）。
 * `dispose` 只是绊线：卡片若试图销毁 provider 持有的共享表单就立刻炸在这里。
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
    desc: null,
    payload: null,
    cleanups: [],
  };
  const ctx = {
    // 只登记不执行：样式 effect 需要 document，产物侧用例要的是装配形状而非渲染。
    effect: (factory: () => (() => void) | undefined, label?: string): void => {
      trace.effects.push(label === undefined ? {} : { label });
      void factory;
    },
    slots: {
      inject: (slot: string, factory: () => () => void): void => {
        trace.slotNames.push(slot);
        factory();
      },
      register: (desc: {
        name: string;
        key?: string;
        inject?: () => Record<string, unknown>;
      }): (() => void) => {
        trace.desc = { name: desc.name, key: desc.key };
        trace.payload = desc.inject?.() ?? null;
        const cleanup = (): void => {
          trace.payload = null;
        };
        trace.cleanups.push(cleanup);
        return cleanup;
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
  // 新鲜度门禁：下面的用例读的是**磁盘**产物（宿主加载的就是它），故 src 改了不重建
  // 时它们仍会绿在旧 key 上。这一条逐字节比对把「改 src 必须 node build-client.mjs」钉住
  // （同 plugins/zvec-grep/test/client-freshness.ts 的判据，此处就地实现不引新文件）。
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

  it("槽 key = profile 解析出的 bundle 包名；configForms.get 仍是 cordis.patch.yml 的裸条目 id", async () => {
    const formTrace: FormTrace = { setCalls: [], disposeCalls: [] };
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(fakeForm(formTrace));
    apply(ctx);

    const bareIds = patchEntryIds();
    assert.deepEqual(bareIds, ["ocr-review"], "cordis.patch.yml 只声明一行裸条目 id");
    // 表单侧**不跟着槽 key 改**：0.1.7 起 settings 命名空间即条目 id，
    // installed dsh-client-ui-settings/lib/client.js:1309-1315 把入参原样当命名空间用。
    assert.deepEqual(trace.entryIds, bareIds, "只取本条目那张共享表单，且只取一次");

    assert.deepEqual(trace.slotNames, ["plugins.bundle.config"]);
    assert.equal(trace.desc?.name, "plugins.bundle.config");
    const bundleName = profileBundleName();
    // 上一条 `assert.equal(trace.desc?.name, …)` 是 @types/node 的断言签名
    // （`asserts actual is T`）：`trace.desc` 自此收窄成非空 ⇒ 这里不再需要 `?.`。
    assert.equal(trace.desc.key, bundleName, "槽 key 必须命中宿主派发的 entryKey");
    // 反向漂移钉：不得退回裸条目 id（那正是卡片不渲染的写法），也不得是行槽 `pkg#rowId`。
    assert.notEqual(trace.desc.key, bareIds[0], "key 不再是条目 id");
    assert.ok(
      typeof trace.desc.key === "string" && !trace.desc.key.includes("#"),
      "bundle 槽的 key 不含 #（行槽才用 <pkg>#<rowId>）",
    );
    assert.equal(trace.desc.key, PKG_NAME, "槽 key 与本包 package.json 的 name 同源");
  });

  it("写入仍落到那张按裸条目 id 取回的共享表单；disposer 只注销、不 dispose", async () => {
    const formTrace: FormTrace = { setCalls: [], disposeCalls: [] };
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(fakeForm(formTrace));
    apply(ctx);
    const payload = trace.payload as { set: (field: string, value: unknown) => Promise<unknown> };
    // 卡片侧写入面是 Promise<void>：受理位 await 后刻意不消费，故返回 undefined。
    assert.equal(await payload.set("effort", "low"), undefined, "payload.set 不外泄受理位");
    assert.deepEqual(
      formTrace.setCalls,
      [["effort", "low"]],
      "改的是槽 key，不是表单来源：写入仍要落回 configForms.get(裸条目 id) 那张表单",
    );
    assert.equal(trace.cleanups.length, 1);
    trace.cleanups[0]?.();
    assert.deepEqual(
      formTrace.disposeCalls,
      [],
      "disposer 不得销毁 provider 持有的共享表单（0.1.7 ConfigForm 契约无 dispose）",
    );
  });
});
