// host.js 构建冒烟 + 防回归锁。
//
// 各自防的回归：
//   1. 跨包依赖必须保持 external（尤其 `@jayyuen66/dsh-plugin-shared/lib/http` 这类**子路径**
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
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildHost } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 包根（本文件在 test/ 下）：host.js 必须与 host.ts 同目录落在这里。 */
const PKG_ROOT = path.dirname(import.meta.dirname);

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

  it("跨包依赖保持 external（含 shared 子路径说明符）", async () => {
    const text = await buildHost();
    // **逐个**子路径列名：只查 `@jayyuen66/dsh-plugin-shared/` 前缀会被 lib/http 一条
    // 满足，lib/text 哪天被内联（shared 的模块级状态复制成第二份）这条断言看不见。
    for (const subpath of [
      "lib/http",
      "lib/locale",
      "lib/text",
      "lib/record",
      "lib/errors",
      "lib/job-outcome",
    ]) {
      expect(text).toContain(`from "@jayyuen66/dsh-plugin-shared/${subpath}"`);
    }
    expect(text).toContain('from "node:path"');
  });

  it("host.js 保留宿主 fork schemastery 的裸说明符（external 未被内联）", async () => {
    const text = await buildHost();
    expect(text).toContain('from "@deepseek-ai/schemastery"');
    // 反向锁：不得退回公共 schemastery——它没有 `.volatile()`，解析出的 volatile 字段
    // 仍是普通值，设置卡写进去的值永远读不到（0.1.7 迁移的根因）。
    expect(/from\s+["']schemastery["']/u.test(text)).toBe(false);
  });

  it("宿主侧不再依赖 YAML 解析器：产物里不得出现 js-yaml", async () => {
    // provider 清单与 key 状态改走 ctx.settings.describe()/ctx.credentials 之后，
    // 本包唯一的 YAML 读者是独立脚本 scripts/get-cred.mjs（OCR 另起进程执行）。
    // 产物里再出现 js-yaml 就说明有人把宿主文件的解析写回来了。
    const text = await buildHost();
    expect(text).not.toContain("js-yaml");
  });

  it("除宿主 fork 的 schemastery 与凭据 branded-string 构造器外，@deepseek-ai/* 只有类型面", async () => {
    // 文件形态插件的运行时值导入只留两样：Config schema 用的 @deepseek-ai/schemastery，
    // 和 credentialRef / isCredentialRefName 所在的 @deepseek-ai/dsh-credentials
    // （值导入必须落 dependencies，见 plugins/README.md 的跨包依赖纪律）。
    // cordis / dsh-settings / dsh-tools / dsh-shell / dsh-host-webserver / dsh-system-prompt
    // 仍必须 type-only——它们的运行时面由 ctx 注入（服务走 ctx.credentials，不是这个包），
    // 漏一个值导入就会让本包在源码态装载失败或把宿主的服务单例复制成第二份。dsh-tools 与
    // 后三条同时钉住「服务面绑官方声明」：绑的是类型，产物里一个字都不留。
    const text = await buildHost();
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
      expect(text).not.toMatch(new RegExp(`from\\s*["']@deepseek-ai/${name}["']`, "u"));
      expect(text).not.toMatch(new RegExp(`import\\s*["']@deepseek-ai/${name}["']`, "u"));
    }
  });

  it("dsh-credentials 以裸说明符外部化，且官方构造器不再被内联（口径 A）", async () => {
    // 两条要一起看：只钉"说明符在"会在有人把依赖挪回 devDependencies 时被上次构建的产物
    // 蒙过去；只钉"函数体不在"则可能它压根没被用到。本包用的是两枚纯 branded-string
    // 构造器（credentialRef / isCredentialRefName），服务面仍走 ctx.credentials。
    const text = await buildHost();
    expect(text).toContain('from "@deepseek-ai/dsh-credentials"');
    expect(text).not.toMatch(/^function (?:credentialRef|isCredentialRefName|brandString)\(/mu);
    // brand 只是 credentials 的**传递**依赖（它自己的 lib/index.js:2 就值导入 brand）：本包不
    // 直接导入它，故产物里不该出现它的说明符。这条锁的是本包产物，锁不到"运行时同时存在插件
    // 副本与宿主副本"（realpath 与 inode 都不同）——那是 npm 的解析形状，官方自述 brand 无
    // 运行时身份与可变状态（实测其 lib/index.js 33 行、0 处顶层 let/var），故不为此加约束。
    expect(text).not.toMatch(/from\s*["']@deepseek-ai\/dsh-brand["']/u);
  });

  it("产物里没有本地 .ts 说明符残留", async () => {
    const text = await buildHost();
    expect(text).not.toMatch(/from\s*["']\.{1,2}\/[^"']*\.ts["']/u);
  });

  it("产物落包根：PLUGIN_DIR 仍是 import.meta.dirname，且包内脚本随包存在", async () => {
    const text = await buildHost();
    expect(text).toContain("const PLUGIN_DIR = import.meta.dirname;");
    // 构建脚本的写入目标 = 脚本自身目录（= 包根）；改这一行必须同步改本断言。
    const builder = await readFile(path.join(PKG_ROOT, "build-host.mjs"), "utf8");
    expect(builder).toContain("const root = import.meta.dirname;");
    expect(builder).toContain('writeFile(path.join(root, "host.js")');
    const artifactStat = await stat(path.join(PKG_ROOT, "host.js"));
    const credStat = await stat(path.join(PKG_ROOT, "scripts", "get-cred.mjs"));
    expect(artifactStat.isFile(), "host.js 已产出（npm run build）").toBe(true);
    expect(credStat.isFile(), "api_key_cmd 脚本必须随包发布（files 含 scripts）").toBe(true);
  });
});

describe("闸门的外部化面（shared/lib/trust）", () => {
  it("lib/trust 子路径保持裸说明符，且 guardTrust 的实现未被内联", async () => {
    // 这些包原先只钉了 http/project-key/record/jsonl 几枚子路径，`lib/trust` 是新增的第四个坑位：
    // external 的字符串项是精确匹配，子路径一旦漏掉就把整份判据复制进本包产物（判据分叉的起点）。
    const out = await buildHost();
    expect(out).toContain('from "@jayyuen66/dsh-plugin-shared/lib/trust"');
    expect(/^function guardTrust\(/mu.test(out)).toBe(false);
  });
});
