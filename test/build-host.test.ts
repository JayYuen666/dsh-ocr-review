// host.js 构建冒烟 + 防回归锁。
//
// 各自防的回归：
//   1. 跨包依赖必须保持 external（尤其 `@jayyuen66/dsh-plugin-shared/lib/record` 这类**子路径**
//      说明符：external 的字符串项是精确匹配，匹配不到子路径 → 必须按包名段判定）；
//   2. Config schema 用的是宿主 fork 的 `@deepseek-ai/schemastery`（0.1.7 的 `.volatile()`
//      解析只在它有实现），产物里既不能被内联、也不能退回公共 schemastery；
//   3. 产物里不得残留 `from "./x.ts"`（Node 载入 node_modules 内的 .ts 直接抛
//      ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）；
//   4. **产物落包根**这条不变式：host.ts 用 `PLUGIN_DIR = import.meta.dirname`
//      （host.ts 的常量段）定位 scripts/get-cred.mjs，而 get-cred.mjs 是 OCR
//      api_key_cmd 以 `node <绝对路径>` 另起进程执行的独立脚本——产物一旦挪进
//      dist/，PLUGIN_DIR 指向 dist/，apply 时「get-cred 脚本缺失」直接报错。
import { describe, expect, it } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildHost } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 包根（本文件在 test/ 下）：host.js 必须与 host.ts 同目录落在这里。 */
const PKG_ROOT = path.dirname(import.meta.dirname);

/**
 * 一次内存构建、多用例共读：`buildHost()` 每调一次都完整跑一遍 rolldown（该切面没有
 * 缓存），七个用例各构建一次是本文件最重的固定开销，而它们判的是同一份产物的文本。
 */
let builtHost: Promise<string> | undefined;
async function hostText(): Promise<string> {
  builtHost ??= buildHost();
  return builtHost;
}

/**
 * 官方 `dsh-credentials` 实现体里的稳定特征：`credentialRef` 抛错文案的前半段。
 * 取不到就直接判红——依赖挪了位置或被改名时，这条判据不能静默通过。
 */
async function officialCredentialMarker(): Promise<string> {
  const source = await readFile(
    path.join(PKG_ROOT, "node_modules", "@deepseek-ai", "dsh-credentials", "lib", "index.js"),
    "utf8",
  );
  const marker = /throw new TypeError\(`(?<text>[^`]*must match)/u.exec(source)?.groups?.["text"];
  if (marker === undefined) {
    throw new Error("官方 dsh-credentials 里没有取到 credentialRef 的特征文案，判据要跟着改");
  }
  return marker;
}

/** 宿主侧源码里值导入过的 shared 子路径（去重排序），供逐条钉外部化。 */
async function sharedSubpaths(): Promise<string[]> {
  const libNames = await readdir(path.join(PKG_ROOT, "lib"));
  const inLib = libNames.filter((name) => name.endsWith(".ts")).map((name) => `lib/${name}`);
  const texts = await Promise.all(
    ["host.ts", ...inLib].map((file) => readFile(path.join(PKG_ROOT, file), "utf8")),
  );
  const found = texts.flatMap((text) =>
    Array.from(
      text.matchAll(/"@jayyuen66\/dsh-plugin-shared\/(?<subpath>lib\/[a-z-]+)"/gu),
      (row) => row.groups?.["subpath"] ?? "",
    ),
  );
  return [...new Set(found.filter((name) => name !== ""))].toSorted();
}

describe("ocr-review host 构建", () => {
  it("host.js 与最新构建逐字节一致（改 host.ts / lib/*.ts 后必须 node build-host.mjs）", async () => {
    // 本文件其余用例读的是**内存**构建产物，过期态在它们里全是绿的；只有逐字节比对磁盘
    // 那份才钉得住「改源必须重建」（判据见 test/host-freshness.ts）。
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url);
    expect(
      onDisk,
      `[${pkgName}] host.js 已过期：host.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    ).toBe(built);
  });

  it("跨包依赖保持 external（shared 子路径按源码现量逐条钉）", async () => {
    const text = await hostText();
    // 清单从宿主侧源码现量：写死五名的表只证明「这五条在」，host.ts 新增一条
    // `lib/format` 并被内联时产物照样全绿，而注释担心的正是「shared 的模块级状态
    // 被复制成第二份」。派生式判据让新增子路径无需人工同步。
    const subpaths = await sharedSubpaths();
    expect(subpaths.length, "宿主侧至少要有一条 shared 说明符，否则这条判据在空转").toBeGreaterThan(
      0,
    );
    for (const subpath of subpaths) {
      expect(text).toContain(`from "@jayyuen66/dsh-plugin-shared/${subpath}"`);
    }
    expect(text).toContain('from "node:path"');
  });

  it("host.js 保留宿主 fork schemastery 的裸说明符（external 未被内联）", async () => {
    const text = await hostText();
    expect(text).toContain('from "@deepseek-ai/schemastery"');
    // 反向锁：不得退回公共 schemastery——它没有 `.volatile()`，解析出的 volatile 字段
    // 仍是普通值，设置卡写进去的值永远读不到（0.1.7 迁移的根因）。
    expect(/(?:from|import)\s*\(?\s*["']schemastery["'/]/u.test(text)).toBe(false);
  });

  it("宿主侧不再依赖 YAML 解析器：产物里不得出现 js-yaml", async () => {
    // provider 清单与 key 状态改走 ctx.settings.describe()/ctx.credentials 之后，
    // 本包唯一的 YAML 读者是独立脚本 scripts/get-cred.mjs（OCR 另起进程执行）。
    // 产物里再出现 js-yaml 就说明有人把宿主文件的解析写回来了。
    const text = await hostText();
    expect(text).not.toContain("js-yaml");
  });

  it("除宿主 fork 的 schemastery 与凭据 branded-string 构造器外，@deepseek-ai/* 只有类型面", async () => {
    // 文件形态插件的运行时值导入只留两样：Config schema 用的 @deepseek-ai/schemastery，
    // 和 credentialRef / isCredentialRefName 所在的 @deepseek-ai/dsh-credentials
    // （值导入落 **peerDependencies**，绝不落 dependencies——后者会被消费方的 profile 装成
    // 真实目录、在宿主进程里物化出第二份，判据见 test/publish-manifest.test.ts 那条门禁）。
    // cordis / dsh-settings / dsh-tools / dsh-shell / dsh-host-webserver / dsh-system-prompt
    // 仍必须 type-only——它们的运行时面由 ctx 注入（服务走 ctx.credentials，不是这个包），
    // 漏一个值导入就会让本包在源码态装载失败或把宿主的服务单例复制成第二份。dsh-tools 与
    // 后三条同时钉住「服务面绑官方声明」：绑的是类型，产物里一个字都不留。
    const text = await hostText();
    for (const name of [
      "cordis",
      "dsh-settings",
      "dsh-tools",
      "dsh-shell",
      "dsh-host-webserver",
      "dsh-system-prompt",
      // 注册表实例由宿主注入，本包只借它的类型面（连同只进 test/ 的实现件）。
      "dsh-jobs",
      "dsh-jobs-local",
    ]) {
      // 子路径值导入、`export … from`、动态 import 三种写法都会把宿主的服务面变成运行期
      // 依赖，所以按包名段命中即可，不要求说明符正好等于裸包名。
      expect(
        text,
        `产物不该值导入 ${name}（裸名、子路径、export-from 与动态 import 都算）`,
      ).not.toMatch(new RegExp(`(?:from|import)\\s*\\(?\\s*["']@deepseek-ai/${name}["'/]`, "u"));
    }
  });

  it("dsh-credentials 以裸说明符外部化，且官方构造器不再被内联（口径 A）", async () => {
    // 两条要一起看：只钉"说明符在"会在有人把依赖挪回 devDependencies 时被上次构建的产物
    // 蒙过去；只钉"函数体不在"则可能它压根没被用到。本包用的是两枚纯 branded-string
    // 构造器（credentialRef / isCredentialRefName），服务面仍走 ctx.credentials。
    const text = await hostText();
    expect(text).toContain('from "@deepseek-ai/dsh-credentials"');
    // 按函数名加行首判「没被内联」，在改名（credentialRef2）、折成 const 箭头或
    // `export function` 时全都匹配不到——内联了也照样绿。官方实现体里 TypeError 的那句
    // 文案是改名与换形态都带得走的特征，缺席才算没内联。
    expect(text, "产物不该内联 dsh-credentials 的实现体").not.toContain(
      await officialCredentialMarker(),
    );
    // brand 只是 credentials 的**传递**依赖（它自己的 lib/index.js:2 就值导入 brand）：本包不
    // 直接导入它，故产物里不该出现它的说明符。这条锁的是本包产物，锁不到"运行时同时存在插件
    // 副本与宿主副本"（realpath 与 inode 都不同）——那是 npm 的解析形状，官方自述 brand 无
    // 运行时身份与可变状态（实测其 lib/index.js 无顶层 let/var），故不为此加约束。
    expect(text).not.toMatch(/from\s*["']@deepseek-ai\/dsh-brand["']/u);
  });

  it("产物里没有本地 .ts 说明符残留", async () => {
    const text = await hostText();
    // 覆盖 from / 副作用 import / 动态 import：Node 在 node_modules 里对这三种 .ts 说明符
    // 都会抛 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING。
    expect(text).not.toMatch(/(?:from|import)\s*\(?\s*["'][^"']*\.ts["']/u);
  });

  it("产物落包根：PLUGIN_DIR 仍是 import.meta.dirname，且包内脚本随包存在", async () => {
    const text = await hostText();
    expect(text).toContain("const PLUGIN_DIR = import.meta.dirname;");
    // 构建脚本的写入目标 = 脚本自身目录（= 包根）；改这一行必须同步改本断言。
    // 原子落盘与构建编排已移到 @jayyuen66/dsh-plugin-shared 的统一构建切面
    // （写盘手法的判据由 shared 自己的测试钉）；这里只钉目标路径仍在本仓声明。
    const builder = await readFile(path.join(PKG_ROOT, "build-host.mjs"), "utf8");
    expect(builder).toContain("const root = import.meta.dirname;");
    expect(builder).toContain('const HOST_OUTPUT = "host.js";');
    expect(builder).toContain("writeArtifact(path.join(root, HOST_OUTPUT), out);");
    expect(builder).toContain('from "@jayyuen66/dsh-plugin-shared/lib/build-host"');
    // 产物缺失时 `stat` 抛 ENOENT 会直接红在异常栈上，下面两条带提示的断言永远执行不到；
    // 折成 undefined 让断言自己说出「先跑 build」。
    const artifactStat = await stat(path.join(PKG_ROOT, "host.js")).catch(() => null);
    const credStat = await stat(path.join(PKG_ROOT, "scripts", "get-cred.mjs")).catch(() => null);
    expect(artifactStat?.isFile(), "host.js 已产出（npm run build）").toBe(true);
    expect(credStat?.isFile(), "api_key_cmd 脚本必须随包发布（files 含 scripts）").toBe(true);
  });
});
