// 同步写/删除调用的落点守卫（补 oxlint.config.ts 里那几条文件级豁免管不到的两面）。
//
// 共享基线的 node/no-sync 豁免现在按文件生效（oxlint.config.ts 的 syncIoScopes），
// 越界落点由 lint 直接判红。本用例管的是 lint 给不出的两件事：
//   1. 名单里每个名字都必须在语料里真的出现过 —— 改名或删掉调用之后，一条不再命中任何
//      代码的豁免就是死配置，lint 对它完全沉默；
//   2. build-*.mjs 那批脚本的落点 —— 它们被 SCRIPTS_OVERRIDES 整条关掉 node/no-sync，
//      lint 在那里不提供这条判据。
//
// 判据表**独立写死在这里**、不从 oxlint.config.ts 派生：派生的话配置与判据会一起漂，
// 两边一起错时仍然全绿。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");

const SOURCE_EXT = /\.(?:ts|mts|mjs)$/u;

/** 生产面与测试面的源文件清单（相对仓根、`/` 分隔）。 */
function listSources(): string[] {
  const files = ["build-client.mjs", "build-host.mjs", "host.ts"];
  for (const dir of ["lib", "scripts", "src", "test"]) {
    const entries = readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        const absolute = path.join(entry.parentPath, entry.name);
        files.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
      }
    }
  }
  return files.toSorted();
}

interface SyncRule {
  readonly name: string;
  /** 允许出现该调用的文件（相对仓根）。 */
  readonly allowed: (file: string) => boolean;
}

const isTest = (file: string): boolean => file.startsWith("test/");

/** 与 oxlint.config.ts 的 syncIoScopes 同一批名字，但落点写死在这里。 */
const RULES: readonly SyncRule[] = [
  { name: "mkdirSync", allowed: isTest },
  { name: "truncateSync", allowed: isTest },
  { name: "writeFileSync", allowed: (file) => file === "lib/config-store.ts" || isTest(file) },
  { name: "mkdtempSync", allowed: (file) => file === "host.ts" || isTest(file) },
  {
    name: "rmSync",
    allowed: (file) => file === "host.ts" || file === "lib/config-store.ts" || isTest(file),
  },
];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** 只认调用形态（名字后紧跟左括号），注释里提到的名字不算。 */
function callPattern(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*\\(`, "u");
}

function violationsOf(sources: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const source of sources) {
    for (const rule of RULES) {
      if (!rule.allowed(source.path) && callPattern(rule.name).test(source.text)) {
        violations.push(`${source.path}: ${rule.name}`);
      }
    }
  }
  return violations;
}

const SOURCES: SourceFile[] = listSources().map((file) => ({
  path: file,
  text: readFileSync(path.join(ROOT, file), "utf8"),
}));

describe("同步写/删除调用的落点守卫", () => {
  it("判据自身能红：生产面越界与注释提及分别有不同结果", () => {
    // 负例先行：不做这一步的话，「真实语料零违规」与「扫描器根本没生效」逐字节相同。
    expect(
      violationsOf([{ path: "lib/evil.ts", text: "rmSync(tmp, { recursive: true });" }]),
    ).toStrictEqual(["lib/evil.ts: rmSync"]);
    expect(
      violationsOf([{ path: "src/x.ts", text: "mkdirSync(dir);\nwriteFileSync(f, s);" }]),
    ).toStrictEqual(["src/x.ts: mkdirSync", "src/x.ts: writeFileSync"]);
    // 注释里出现名字不算调用（lib/config-store.ts 的注释就提到过 writeFileSync）。
    expect(
      violationsOf([{ path: "lib/y.ts", text: "// 不用 writeFileSync，走原子写。" }]),
    ).toStrictEqual([]);
    // 允许的落点不红。
    expect(violationsOf([{ path: "host.ts", text: "rmSync(tmp);" }])).toStrictEqual([]);
  });

  it("语料下限：清单非空、每个白名单名字都真的在语料里出现过", () => {
    // 空集不打 ✓：扫描面读不到时这条必须红，而不是报绿。
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(SOURCES.map((source) => source.path)).toContain("host.ts");
    for (const rule of RULES) {
      const pattern = callPattern(rule.name);
      expect(
        SOURCES.filter((source) => pattern.test(source.text)).map((source) => source.path),
      ).not.toStrictEqual([]);
    }
  });

  it("真实语料：越界调用为零", () => {
    expect(violationsOf(SOURCES)).toStrictEqual([]);
  });
});
