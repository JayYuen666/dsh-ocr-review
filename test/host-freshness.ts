// test/host-freshness.ts —— host 侧产物是否最新的按字节比对门禁（多包共用，复制式分发，同 client-freshness.ts）。
// 本包副本形态：只提供**证据**（磁盘上的 host 产物与当期在内存里构建的产物，加上包名与包根），用例登记留在
// test/build-host.test.ts 的 describe 里。共享的夹具文件一旦自己调用 it()，它就变成用例文件，
// vitest 那几条结构类规则（require-hook、consistent-test-it、valid-title）就全部落到它身上。
//
// 背景：host.ts / lib/*.ts 改后忘跑 node build-host.mjs，dsh 载入的仍是旧 host.js。client 侧
// 早就有这一条（test/client-freshness.ts），host 侧此前一份这样的门禁都没有，于是真的漏过一次：
// danger-guard/host.js 的生成时间早于 host.ts 的下一次改动——产物已经过期，而没有任何检查会报出来。
// settings.js 由同一份构建函数的另一条导出产出，同样没人管，所以它进的是同一条检查。
// mtime 的断言在 git clone 或 touch 之下不稳定，所以这里比对**内容字节**：内存构建（build-host.mjs 的纯函数
// 导出，不写到磁盘）与磁盘产物逐字节比对。源文件任何变更没重建 → 字节必差 → 失败。
//
// 用法（各包 test/build-host.test.ts 里那条逐字节比对的用例）：
//   const evidence = await hostFreshnessEvidence(import.meta.url)
//   —— 自动定位 ../host.js 与 ../build-host.mjs 的 buildHost()。第二个参数指名「另一条导出 +
//   另一个产物文件」：danger-guard 的设置半走 builder: buildSettings、artifact: settings.js，
//   两个产物各自比字节。导出名不在这里统一，因为改 builder 的导出名比把选项写清楚代价大。
//
// 形态自适应：构建函数返回字符串 → 单文件逐字节；返回「写到哪个路径 → 正文」的 Map（shared 的多
// 入口 dist 产物，它根本不产 host.js，这条门禁不替它硬造一个）→ 两侧都折成按路径排序的
// 「相对路径 + 正文摘要」清单再比。摘要只当字节的身份（同摘要即同字节），换来失败时是十来行、
// 每行点名一个产物的 diff，而不是几十 KB 正文并排。
//
// 注意：构建函数必须是确定性构建（同输入同输出）。各包的 build-host.mjs 实测同一进程内双跑
// 逐字节一致（rolldown 的 [hash] 是内容哈希，不含时间戳/随机数），逐字节相等成立；若未来构建
// 引入非确定性，改为规范哈希比较并在 build-host.mjs 里输出 canonical 形态。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** build-host.mjs 的导出返回形状：单文件正文，或「写到磁盘绝对路径 → 正文」的产物清单。 */
type BuiltArtifacts = string | Map<string, string>;

/** 这条比对用的两份产物 + 包名与包根（消息里写明身份和修复命令，两侧取自同一处）。 */
export interface HostFreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  readonly onDisk: string;
  readonly built: string;
}

/** 这条门禁认哪条导出、比哪个产物（默认 buildHost() 与包根的 host.js）。 */
export interface HostFreshnessOptions {
  /** build-host.mjs 里的具名导出（danger-guard 的设置半是 buildSettings）。 */
  readonly builder?: string;
  /** 包根下的产物文件（danger-guard 的设置半是 settings.js）。 */
  readonly artifact?: string;
}

const DEFAULT_BUILDER = "buildHost";
const DEFAULT_ARTIFACT = "host.js";

/** 磁盘上没有这份产物时用的占位正文：让门禁失败在比对里，而不是失败在 ENOENT 的调用栈里。 */
const ABSENT = "[产物缺失：运行 node build-host.mjs]";

/**
 * 读一份文本产物；不存在时交回缺失占位。
 * @param file - 绝对路径
 * @returns 正文，或 ABSENT
 */
function readText(file: string): string {
  if (existsSync(file)) {
    return readFileSync(file, "utf8");
  }
  return ABSENT;
}

/**
 * 一份正文的字节身份。
 * @param text - 产物正文
 * @returns sha256 十六进制
 */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 取包名：用正则从 package.json 里取，不为此把整张依赖表拉进类型（和 client 侧那份的取法相同）。
 * @param pkgDir - 包根绝对路径
 * @returns package.json 的 name；文件在但抠不到 name 时为 unknown
 * @throws Error 包根下没有 package.json（pkgDir 推导有误）
 */
function packageNameOf(pkgDir: string): string {
  const manifestPath = path.resolve(pkgDir, "package.json");
  // 缺这份文件说明包根推导错了（pkgDir 由调用方文件位置上翻一级得到），此时不能与
  // 「文件在、但 name 写法抠不到」共用 unknown：前者要让人看到路径，后者才允许降级。
  if (!existsSync(manifestPath)) {
    throw new Error(`门禁取不到包身份：${manifestPath} 不存在，包根推导有误。`);
  }
  return (
    /"name":\s*"(?<pkgName>[^"]+)"/u.exec(readFileSync(manifestPath, "utf8"))?.groups?.[
      "pkgName"
    ] ?? "unknown"
  );
}

/**
 * 多产物形态：把清单折成按路径排序的「相对路径 + 正文摘要」文本，两侧共用同一排序。
 * @param pkgDir - 包根绝对路径（相对化是为了清单不绑定装机位置）
 * @param files - 构建函数交回的「写到磁盘绝对路径 → 正文」
 * @param fromDisk - true 时逐个读盘算摘要（缺文件即摘要不同，行里已点名是哪个产物）
 * @returns 可直接与另一侧逐字节相等的清单文本
 */
function manifestOf(pkgDir: string, files: Map<string, string>, fromDisk: boolean): string {
  const rows: string[] = [];
  for (const [file, code] of [...files.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const identity = fromDisk ? digestOf(readText(file)) : digestOf(code);
    rows.push(`${path.relative(pkgDir, file)}\t${identity}`);
  }
  return `${rows.join("\n")}\n`;
}

/**
 * 取这条比对的证据：磁盘上的 host 产物与当期在内存里构建的产物（构建只在内存里跑，不写到磁盘）。
 * @param testFileUrl - 调用方用例文件的 import.meta.url
 * @param options - 指认 builder / artifact（缺省 buildHost() vs 包根 host.js）
 * @returns 两份产物文本 + 包名与包根
 */
export async function hostFreshnessEvidence(
  testFileUrl: string,
  options: HostFreshnessOptions = {},
): Promise<HostFreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const builder = options.builder ?? DEFAULT_BUILDER;
  const artifact = options.artifact ?? DEFAULT_ARTIFACT;
  const pkgName = packageNameOf(pkgDir);
  // 动态导入 .mjs 对 TS 为 any，先收窄到调用处再 await（避免 no-unsafe-*）。
  const mod = (await import(
    pathToFileURL(path.resolve(pkgDir, "build-host.mjs")).href
  )) as unknown as Record<string, (() => Promise<BuiltArtifacts>) | undefined>;
  const build = mod[builder];
  if (typeof build !== "function") {
    throw new TypeError(
      `[${pkgName}] build-host.mjs 没有可调用导出 ${builder}：门禁的 builder 选项必须指它真实导出的名字。`,
    );
  }
  const built = await build();
  if (typeof built === "string") {
    return { pkgName, pkgDir, onDisk: readText(path.resolve(pkgDir, artifact)), built };
  }
  if (!(built instanceof Map)) {
    throw new TypeError(
      `[${pkgName}] build-host.mjs 的 ${builder}() 既不是字符串，也不是「落盘路径 → 正文」的 Map：` +
        "这条门禁无从比对产物的形状。",
    );
  }
  return {
    pkgName,
    pkgDir,
    onDisk: manifestOf(pkgDir, built, true),
    built: manifestOf(pkgDir, built, false),
  };
}
