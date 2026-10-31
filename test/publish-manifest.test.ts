// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期与轮次编号写下时有用，读的人只会困惑，且没有任何读者能从中重建
// 当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界值）是数据，
// 角色文档里的日期是内容，两者都不在禁面内。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_OCR_CLI_VERSION } from "../lib/cli.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/**
 * 只在注释与文档里禁的指涉：日期。
 *
 * 「轮次编号」刻意不进门禁。本仓的 `本轮` / `第 N 轮` 绝大多数指的是**会话轮次**这个产品概念
 * （`第一轮消息不支持 fork`、gate 的「下一轮重新计数」），而不是写下这段注释时的工作轮次。
 * 两种含义在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u];

/**
 * `publishConfig` 里允许出现的字段：可见性、源，与发布用的 dist-tag。三者都不是入口面。
 *
 * `tag` 是**允许**写在这里、但本包刻意不写：npm 对带 prerelease 段的版本在既没有 `--tag`
 * 也没有 `publishConfig.tag` 时**直接拒绝发布**（installed npm/lib/commands/publish.js 的
 * isDefaultTag/isPreRelease 那道检查），所以漏旗标的后果是「发不出去」而不是「发错标签」——
 * 响亮失败比把预发布版推上 latest 好。不带这一位时稳定版照默认走 latest，发预发布版就得
 * 显式表态。它与本门禁守的那类字段不同：门禁管的是「入口字段不得只写在 `publishConfig`
 * 里」（npm 不合并 main/exports，换个发布器就发出一个 import 必失败的包），`tag` 没有这个
 * 风险：npm 读它，pnpm 侧还有 `--tag` 旗标可覆盖。
 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry", "tag"]);

/** 精确版本：三段数字，可带预发布后缀，整串锚定（`^`/`~`/`||` 与尾随文本都不放行）。 */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly engines?: Record<string, string>;
  readonly ocrCliVersion?: unknown;
}

/** 一条 `files` 模式的两种形态。 */
export type PatternShape =
  /** 目录或后缀模式：列该目录下以 `extension` 结尾的文件（`extension` 为空表示不筛后缀）。 */
  | {
      readonly kind: "glob";
      readonly dir: string;
      readonly extension: string;
      readonly recursive: boolean;
    }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * 后缀只取通配符**之后**的点号段：`dist/*` 里最后一个点号在通配符之前（或根本不存在），
 * 那不是后缀而是模式本身的一部分；按它切片会得到 `"*"` 这类永不命中的后缀，让该条模式
 * 一个文件都列不出来——门禁静默失效，悬空入口照样绿。`/` 结尾之外的空目录按包根算，
 * 且与 `dir/*` 一样只看单层，不递归扫进 node_modules。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录、后缀过滤与递归标记，或一个精确文件名
 */
export function shapeOf(entry: string): PatternShape {
  const star = entry.indexOf("*");
  if (star !== -1) {
    const dot = entry.lastIndexOf(".");
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, "") || ".",
      extension: dot > star ? entry.slice(dot) : "",
      recursive: entry.includes("**"),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "", recursive: true };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * 目录不存在（`files` 写了尚未构建的产物目录，或名字写错）时返回空清单，让外层
 * 「入口不在 files 覆盖范围内」的断言点名是哪一条入口，而不是抛一句 ENOENT 堆栈。
 *
 * @param shape - 见 {@link shapeOf}
 * @param baseDir - 包根；测试用临时目录驱动
 * @returns 命中的文件清单
 */
export async function expand(shape: PatternShape, baseDir = pkgDir): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(baseDir, shape.file)) ? [shape.file] : [];
  }
  const dirPath = path.join(baseDir, shape.dir);
  if (!existsSync(dirPath)) {
    return [];
  }
  const names = await readdir(dirPath, { recursive: shape.recursive, withFileTypes: true });
  return names
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const rel = shape.recursive
        ? path.relative(dirPath, path.join(entry.parentPath, entry.name))
        : entry.name;
      return rel.split(path.sep).join("/");
    })
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => (shape.dir === "." ? name : path.posix.join(shape.dir, name)));
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * `exports` 的值在 npm 里允许字符串、数组与条件对象三种形态；只按对象迭代会把
 * `"exports": "./host.js"` 拆成每个字符一项，失败信息指向 `h`、`o` 这类不存在的目标。
 *
 * @param value - `exports` 里某一键的值
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((nested) => filesOf(nested));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
export function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const exported = manifest.exports;
  const flat =
    typeof exported === "string" || Array.isArray(exported)
      ? filesOf(exported).map((file) => ({ label: ".", file }))
      : Object.entries(
          typeof exported === "object" && exported !== null
            ? (exported as Record<string, unknown>)
            : {},
        ).flatMap(([specifier, value]) =>
          filesOf(value).map((file) => ({ label: specifier, file })),
        );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/** 发布器无条件附带的文件：不受 `files` 约束，但也不该由门禁去断言它在 `files` 里。 */
const ALWAYS_SHIPPED = [
  "package.json",
  "README.md",
  "README.zh.md",
  "README.zh-CN.md",
  "LICENSE",
  "CHANGELOG.md",
];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  const lines: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const opensBlock = /^\s*\/\*/u.test(line);
    if (inBlock) {
      lines.push(line);
      if (line.includes("*/")) {
        inBlock = false;
      }
    } else if (opensBlock) {
      // `/*` 开在新行时，其后直到 `*/` 的每一行也算注释。只认行首 `/*`：行中出现的 `/*`
      // 可能是字符串字面量，按它进入块态会把后续代码误判成注释。
      lines.push(line);
      inBlock = !line.includes("*/");
    } else if (/^\s*(?:\/\/|#|\*)/u.test(line)) {
      lines.push(line);
    }
  }
  return lines;
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("locale 目录下的每份语言包都在 files 覆盖范围内", async () => {
    const { shipped } = await readSurface();
    const localeDir = path.join(pkgDir, "locale");
    const packs = existsSync(localeDir) ? await readdir(localeDir) : [];
    expect(packs.length, "locale 目录里一份语言包都没有").toBeGreaterThan(0);
    for (const name of packs) {
      expect(
        shipped.has(path.posix.join("locale", name)),
        `locale/${name} 没有被 files 覆盖：exports 的通配子路径会发布一个不存在的文件`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(/\.tsx?$/u);
    }
  });

  it("publishConfig 只留可见性、源与 dist-tag，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });
});

describe("外部 CLI 的版本声明与依赖边界", () => {
  it("package.json 的 ocrCliVersion 与代码里的核对常量逐字相等", async () => {
    // 版本声明只有 package.json 一处是人写的：代码常量与两侧 README 都据本条对齐。
    // 少了这道门，「README 教用户装 A 版本、插件按 B 版本核对」是自洽的——两端各自绿，
    // 用户照着装完才发现提示里那句「与核对版本不一致」永真。
    const { manifest } = await readSurface();
    expect(
      manifest.ocrCliVersion,
      "package.json 的 ocrCliVersion 必须与 lib/cli.ts 的 EXPECTED_OCR_CLI_VERSION 同值",
    ).toBe(EXPECTED_OCR_CLI_VERSION);
  });

  it("没有 optionalDependencies：外部 CLI 由用户自选安装方式", async () => {
    // 曾经那枚 @alibaba-group/open-code-review 的 consequences 有两层：装本插件顺带改了
    // 用户的全局工具链，且解析出的随包绝对路径比 PATH 上用户自装那份更先命中，于是用户
    // 升级了 CLI、插件仍跑随包那份旧版，卡片报的版本与他终端里跑的永远对不上。
    // 判据只断「这张表为空」：它守的是整类「装上本插件就顺带装别的东西」，不是某一个包名。
    const { manifest } = await readSurface();
    expect(manifest.optionalDependencies, "本包不随包分发外部 CLI").toBeUndefined();
  });
});

/** 宿主 dsh 家族的包名前缀（本组三条判据都要按它筛，收常量）。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑。本包被消费方装进 profile 用的是 `nodeLinker: hoisted`
    // 且 `autoInstallPeers: false`（见 pnpm-workspace.yaml），所以 `dependencies` 里的每一枚
    // 宿主包都会在那棵 profile 依赖树里落成**真实目录**，与宿主进程已经加载的那份并存在一起。
    // `@deepseek-ai/dsh-tools` 的 TOOL_RUNTIME_SCHEDULER 是普通 `Symbol`（不是 `Symbol.for`），
    // 符号身份按模块实例计算：宿主的 dsh-agent-loop 用自己那份的 Symbol 去读由副本挂载出来的
    // ToolRuntime，拿到 `undefined`，于是**每一次原生工具调用都抛**
    // "Cannot read properties of undefined (reading 'prepare')"，整个 profile 的工具一起失效。
    // 本包的构建、类型检查与测试在此之前全部照绿，判据只能落在 manifest 面。
    // 因此运行期真要用的那几枚走**非 optional 的 peer**（宿主在场，profile 不装 peer，
    // 所以不产生副本），编译要的再另列一份 dev。别把任何 @deepseek-ai/* "恢复"回 dependencies。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随消费方装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型面。
    // 只判 dev 这一侧：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，判据在下面那条。
    const { manifest } = await readSurface();
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDev.length, "至少要钉住一枚 dsh-* 开发依赖，否则下面两条都是空转").toBeGreaterThan(0);
    const ranged = dshDev.filter(([, range]) => !EXACT_VERSION.test(range));
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 全部同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一次安装里出现两枚 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    // 基准取自这张表自己，不取自 `@deepseek-ai/dsh`：本包一个符号都不从宿主主包导入
    // （服务面全部来自 dsh-* 子包），拿它当基准只是在 manifest 里养一条没人读的条目。
    const { manifest } = await readSurface();
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDev.length, "至少要钉住一枚 dsh-* 开发依赖，否则同版本这条无从校验").toBeGreaterThan(
      0,
    );
    const baseline = dshDev[0]?.[1];
    const drifted = dshDev.filter(([, range]) => range !== baseline);
    expect(drifted, `这些 dsh-* 与 ${baseline} 不同版本`).toStrictEqual([]);
  });

  it("peerDependencies 里的 dsh 家族写支持窗口范围，与裸 dsh 逐条同一条", async () => {
    // peer 由宿主拿自己安装的那版去满足：钉成精确版本等于要求两者版本号完全相等，而滚动支持
    // 窗口本来就含三个版本。宿主侧只在 manifest 没有 engines.dsh 时才读 peer（app-boot 的
    // plugin-compatibility 里 engines.dsh 存在即独判），所以这一位是发布元数据的含义问题。
    const { manifest } = await readSurface();
    // 本包不从宿主主包导入任何符号，因此没有裸 `@deepseek-ai/dsh` 那条 peer；
    // 基准取 engines.dsh——那才是宿主用来判「装不装得下」的那一条。
    const bare = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? manifest.engines?.["dsh"] ?? "";
    expect(bare, "既没有裸 dsh 的 peer 也没有 engines.dsh：支持窗口就失去基准了").toMatch(/^\^/u);
    const offPolicy = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && range !== bare,
    );
    expect(offPolicy, "这些 dsh-* peer 与裸 dsh 不是同一条范围").toStrictEqual([]);
  });
});

describe("形状判据自身（files 通配、exports 三态、精确版本）", () => {
  it("无点号的通配模式不做后缀过滤，列出该目录下全部文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ocr-publish-shape-"));
    try {
      mkdirSync(path.join(dir, "dist", "nested"), { recursive: true });
      writeFileSync(path.join(dir, "dist", "host.js"), "");
      writeFileSync(path.join(dir, "dist", "nested", "deep.js"), "");
      // `dist/*` 只看单层：`extension` 为空（不是 `*`），`recursive` 为 false。
      expect(shapeOf("dist/*")).toStrictEqual({
        kind: "glob",
        dir: "dist",
        extension: "",
        recursive: false,
      });
      await expect(expand(shapeOf("dist/*"), dir)).resolves.toStrictEqual(["dist/host.js"]);
      // `dist/**` 递归；没有前导目录时按包根、仍不递归。
      await expect(expand(shapeOf("dist/**"), dir)).resolves.toStrictEqual([
        "dist/host.js",
        "dist/nested/deep.js",
      ]);
      expect(shapeOf("*.js")).toStrictEqual({
        kind: "glob",
        dir: ".",
        extension: ".js",
        recursive: false,
      });
      await expect(expand(shapeOf("*.js"), dir)).resolves.toStrictEqual([]);
      writeFileSync(path.join(dir, "top.js"), "");
      await expect(expand(shapeOf("*.js"), dir)).resolves.toStrictEqual(["top.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("files 目录不存在时给空清单，让外层断言点名入口而不是抛 ENOENT", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ocr-publish-missing-"));
    try {
      await expect(expand(shapeOf("dist"), dir)).resolves.toStrictEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports 的字符串、数组、对象三态都归一成入口目标", () => {
    expect(entryFiles({ exports: "./host.js" })).toStrictEqual([{ label: ".", file: "./host.js" }]);
    expect(entryFiles({ exports: ["./a.js", "./b.js"] })).toStrictEqual([
      { label: ".", file: "./a.js" },
      { label: ".", file: "./b.js" },
    ]);
    expect(entryFiles({ exports: { ".": "./host.js", "./client": "./client.js" } })).toStrictEqual([
      { label: ".", file: "./host.js" },
      { label: "./client", file: "./client.js" },
    ]);
  });

  it("精确版本判据接受稳定版、拒绝范围算子与尾随文本", () => {
    for (const pinned of ["0.3.0", "0.2.2-alpha.2"]) {
      expect(EXACT_VERSION.test(pinned), `${pinned} 应判为精确版本`).toBe(true);
    }
    for (const ranged of ["^0.2.2", "~0.2.2", "0.2.2 || ^1.0.0", "0.2.2-alpha || ^1.0.0", "12"]) {
      expect(EXACT_VERSION.test(ranged), `${ranged} 不应判为精确版本`).toBe(false);
    }
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});
