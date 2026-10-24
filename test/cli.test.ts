// cli 纯函数测试：命令构造、转义、scope 互斥、注入防线（白名单 + 转义骨架）。
//
// 拒绝理由已随 host 语言走（messages 是 lib/cli.ts 每个函数的最后一个入参）。
// 本文件主体走「host 注入中文那份」的等价路径（断言里的中文串与 i18n 迁移前完全
// 一致），末尾一组用例注入 en 那份，证明同一批校验闸换语言只是换文案、不改判定。
// 取值闸（转义/绝对路径/逗号列表/钳制）按这层边界直接取用 lib/argv-guard.ts，
// 命令构造走 lib/cli.ts——与生产侧的引用关系一致。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  shq,
  assertAbsoluteRoot,
  clampEffort,
  commaList,
  resolveOutputFormat,
  resolveRepoFile,
} from "../lib/argv-guard.ts";
import {
  resolveRoot,
  wrapWithHostReaper,
  ocrCommand,
  locateLauncher,
  buildReviewCommand,
  buildScanCommand,
  buildDelegatePreviewCommand,
  buildDelegateRuleCommand,
  buildSessionCommand,
  buildRulesCheckCommand,
  buildLlmCommand,
  buildLlmTestCommand,
  buildVersionCommand,
  parseOcrVersion,
  withHomeEnv,
  resolveOcrAvailability,
  inferOcrInstallChannel,
  ocrCommandsFor,
  EXPECTED_OCR_CLI_VERSION,
} from "../lib/cli.ts";
import type {
  BuiltCommand,
  DelegatePreviewArgs,
  ReviewScopeArgs,
  ScanScopeArgs,
  SessionArgs,
} from "../lib/cli.ts";
import { MESSAGES } from "../lib/messages.ts";
import type { OcrReviewMessages } from "../lib/messages.ts";

const { zh } = MESSAGES;

const REPO_ABS = "/Users/me/repo";
/** brew 那条装法命令的原文（多处断言共用）。 */
const BREW_INSTALL = "brew install open-code-review";

/** 随包兜底那一份的入口是否「在盘上」的可切换替身：lib/cli.ts 的定位口经 existsSync 判入口，
 *  缺了它就只有「在盘上」这一档分支——而那取决于这台机器的依赖树里有没有那枚包。 */
const fsStub = vi.hoisted(() => ({ exists: true }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = {
    ...actual,
    existsSync: (target: string): boolean =>
      target.endsWith("ocr.js") ? fsStub.exists : actual.existsSync(target),
  };
  return { ...patched, default: patched };
});

/** 解析出的命令词：随包入口的绝对路径，或 PATH 上的裸 `ocr`。测试与生产同源。 */
const OCR = ocrCommand();
/** 命令词在骨架里占一个 ⟦Q⟧ 当且仅当它解析成了绝对路径（未安装时是裸名 `ocr`）。 */
const OCR_QUOTED = OCR.startsWith("'") ? 1 : 0;
/** 可控槽位数（决定命令里应有几段 shq 引号）：命令词另占一段。 */
const REVIEW_SLOTS = 7;
const SCAN_SLOTS = 5;

/** 降级回落的目标子命令（action=show/comments 缺 id 时命令必须落回这一条）。 */
const SESSION_LIST_CMD = `${OCR} session list`;

/* ── 注入中文文案的薄封装（下面的用例因此与迁移前逐字同形）──────────────── */

const rootOf = (root: unknown, messages: OcrReviewMessages = zh): string =>
  assertAbsoluteRoot(root, messages);
const rootOfFallback = (
  value: unknown,
  fallback: string | undefined,
  messages: OcrReviewMessages = zh,
): string => resolveRoot(value, fallback, messages);
const listOf = (
  value: unknown,
  name: string,
  limit: number,
  messages: OcrReviewMessages = zh,
): string[] => commaList(value, name, limit, messages);
const reviewCmd = (
  args: ReviewScopeArgs,
  out: string | undefined,
  messages: OcrReviewMessages = zh,
): BuiltCommand => buildReviewCommand(args, out, messages);
const scanCmd = (
  args: ScanScopeArgs,
  out: string | undefined,
  messages: OcrReviewMessages = zh,
): BuiltCommand => buildScanCommand(args, out, messages);
const previewCmd = (args: DelegatePreviewArgs, messages: OcrReviewMessages = zh): BuiltCommand =>
  buildDelegatePreviewCommand(args, messages);
const ruleCmd = (
  args: { repo: unknown; paths?: unknown; rule?: unknown },
  messages: OcrReviewMessages = zh,
): BuiltCommand => buildDelegateRuleCommand(args, messages);
const sessionCmd = (args: SessionArgs, messages: OcrReviewMessages = zh): BuiltCommand =>
  buildSessionCommand(args, messages);
const rulesCheckCmd = (
  args: { repo: unknown; path?: unknown; rule?: unknown },
  messages: OcrReviewMessages = zh,
): BuiltCommand => buildRulesCheckCommand(args, messages);

/** shq 的逆：剥外层单引号并还原 '\''。 */
function shqUnwrap(quoted: string): string {
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) {
    throw new Error(`not shq-quoted: ${quoted.slice(0, 40)}`);
  }
  return quoted.slice(1, -1).replaceAll(String.raw`'\''`, "'");
}
/** 反向还原守护包装内的原始命令（wrapWithHostReaper 的逆，仅测试用）。 */
function unwrapReaper(wrapped: string): string {
  const prefix = "bash -c ";
  if (!wrapped.startsWith(prefix)) {
    throw new Error(`not reaper-wrapped: ${wrapped.slice(0, 40)}`);
  }
  return shqUnwrap(wrapped.slice(prefix.length));
}

/* ── 临时目录夹具（可用性判据与装法判据都只问文件系统）───────────────────── */

const tempDirs: string[] = [];

/** 造一只临时目录，在里面放几个普通文件（名字逐个给）。 */
function makeBinDir(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ocr-avail-"));
  tempDirs.push(dir);
  for (const name of names) {
    writeFileSync(path.join(dir, name), "#!/bin/sh\n");
  }
  return dir;
}

/** 按 `/` 分隔的相对段落建一棵目录树，末端是普通文件；返回该文件的绝对路径。
 *  装法判据读的是路径里的 `node_modules` / `Cellar` 这些段落，只能靠真目录树构造。 */
function makeNestedFile(segments: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ocr-chan-"));
  tempDirs.push(dir);
  const target = path.join(dir, ...segments);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "#!/bin/sh\n");
  return target;
}

function makeEmptyDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ocr-avail-"));
  tempDirs.push(dir);
  return dir;
}

/** 命令串里的 `--format json`：多处以断言与拼接两种方式出现，抽一份免得字面量散落。 */
const FORMAT_JSON_FLAG = "--format json";

describe("commaList 的边界闸", () => {
  it("数组项自身含逗号 ⇒ 拒绝（join 后与「两项数组」无法区分）", () => {
    // ["a,b"] 与 ["a","b"] join 后都是 "a,b"，而 glob 花括号（{ts,tsx}）恰好含逗号：
    // 静默拆开就把一个模式变成两个，审查/过滤范围被无声改变。
    expect(() => listOf(["src/**/*.{ts,tsx}"], "exclude", 50)).toThrow(/含逗号/u);
    expect(listOf(["a", "b"], "exclude", 50)).toStrictEqual(["a", "b"]);
    // 字符串形态仍按逗号拆——花括号外的逗号拆分语义不变。
    expect(listOf("a,b", "exclude", 50)).toStrictEqual(["a", "b"]);
  });

  it("字符串形式里花括号内含逗号 ⇒ 同样拒绝（split 会撕出无效模式）", () => {
    // "src/**/*.{ts,tsx}" 按 split(",") 拆成 "src/**/*.{ts" 与 "tsx}" 两个无效模式，
    // 过滤条件失效而表面照常成功——与数组分支的拒绝口径一致。
    expect(() => listOf("src/**/*.{ts,tsx}", "exclude", 50)).toThrow(/花括号内含逗号/u);
    expect(() => listOf("a{b,c},d", "exclude", 50)).toThrow(/花括号内含逗号/u);
    // 花括号外逗号照常拆；成对花括号内没有逗号不受影响。
    expect(listOf("a{b}c,d", "exclude", 50)).toStrictEqual(["a{b}c", "d"]);
    expect(listOf("**/*.{ts}", "exclude", 50)).toStrictEqual(["**/*.{ts}"]);
  });

  it("limit 非法（NaN / ≤0）回落到保守默认，而不是静默放开上限", () => {
    const many = [...Array.from({ length: 260 }).keys()].map((index) => `f${index}.ts`);
    // out.length >= NaN 恒为 false ⇒ 修复前上限完全失效。回落默认后 260 条超限 ⇒ 抛错，
    // 而不是悄悄只留 200 条（默认 200 仍在，只是超限从静默丢变成明说拒绝）。
    expect(() => listOf(many, "paths", Number.NaN)).toThrow(/超过 200 条上限（多出 60 条）/u);
    expect(() => listOf(many, "paths", 0)).toThrow(/命令未构造/u);
    expect(() => listOf(many, "paths", -1)).toThrow(/超过 200 条上限/u);
    // 恰好不超限时照常放行（上限仍是上限，只是不静默丢）。
    expect(listOf(many.slice(0, 200), "paths", 200)).toHaveLength(200);
    expect(listOf(many, "paths", 260)).toHaveLength(260);
  });
});

describe("shq", () => {
  it("普通字符串原样进入单引号", () => {
    expect(shq("main")).toBe("'main'");
  });

  it("单引号被转义（注入防护）", () => {
    expect(shq("a'b")).toBe(String.raw`'a'\''b'`);
  });

  it("含 $() 反引号等 shell 元字符安全", () => {
    expect(shq("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shq("`id`; echo hi")).toBe("'`id`; echo hi'");
  });

  it("含 NUL 字节直接拒绝：POSIX 命令串无法表示它，放行会静默截断 argv", () => {
    // 此前这条不变量靠各调用点先做 NUL 检查维持；下沉到 shq 自身后，
    // 「转义后的串一定能被 shell 完整读回」由实现保证，而不是靠调用顺序。
    expect(() => shq("a\u0000b")).toThrow(/NUL/u);
  });
});

describe("assertAbsoluteRoot / resolveRoot", () => {
  it("拒绝相对路径、空值、NUL", () => {
    expect(() => rootOf("relative/path")).toThrow(/绝对路径/u);
    expect(() => rootOf("")).toThrow(/必填/u);
    expect(() => rootOf("a\u0000b")).toThrow(/NUL/u);
    // 非字符串入参（模型传参经 PTC 可到任何类型）：与空串同义，报「必填」而不是
    // 让它掉进「必须是绝对路径」那条误导性文案。
    expect(() => rootOf(123)).toThrow(/必填/u);
    expect(() => rootOf(null)).toThrow(/必填/u);
    expect(() => rootOf(undefined)).toThrow(/必填/u);
    // 全空白同样按未提供处理
    expect(() => rootOf("   ")).toThrow(/必填/u);
  });

  it("接受绝对路径（含首尾空白，trim 后判定）", () => {
    expect(rootOf(REPO_ABS)).toBe(REPO_ABS);
    // 带首尾空白：此前会被「必须是绝对路径」拦下，读起来像路径格式写错，实际只是多了空格
    expect(rootOf(`  ${REPO_ABS}  `)).toBe(REPO_ABS);
  });

  it("交出前归一成唯一形态：尾随斜杠、重复分隔符与点段折叠", () => {
    // 同一目录的几种写法收成一种——会话目录等按路径派生的键不再随写法分叉。
    expect(rootOf("/repo/")).toBe("/repo");
    expect(rootOf("/repo//sub/")).toBe("/repo/sub");
    expect(rootOf("/repo/./a")).toBe("/repo/a");
    // 「..」段按 posix.normalize 的词法折叠落到实际目标（"/repo/../.." 即根），
    // 不存在解析后仍含「..」的形态。
    expect(rootOf("/repo/../other")).toBe("/other");
    expect(rootOf("/repo/../..")).toBe("/");
    expect(rootOf("/")).toBe("/");
  });

  it("显式值优先，空串回退 fallback，都没有时报错", () => {
    expect(rootOfFallback("/a/b", "/work")).toBe("/a/b");
    expect(rootOfFallback("  ", "/work")).toBe("/work");
    expect(() => rootOfFallback(undefined, undefined)).toThrow(/repo 必填/u);
  });

  it("repo 错类型不落进 fallback：指定了仓库却被换成另一个仓库，回执里不留痕迹", () => {
    // 与 idValue 的错类型契约一致：空串/缺省才是「没指定」，数字/对象是「指定错了」。
    expect(() => rootOfFallback(123, "/work")).toThrow(/repo 必须是字符串/u);
    expect(() => rootOfFallback({ path: "/a" }, "/work")).toThrow(/repo 必须是字符串/u);
    expect(rootOfFallback(null, "/work")).toBe("/work");
    expect(rootOfFallback(undefined, "/work")).toBe("/work");
  });
});

describe("clampEffort / commaList", () => {
  it("effort 非法回默认", () => {
    expect(clampEffort("high", "medium")).toBe("high");
    expect(clampEffort("ultra", "medium")).toBe("medium");
    expect(clampEffort(42, "low")).toBe("low");
  });

  it("exclude 兼容数组与逗号字符串，过滤空串", () => {
    expect(listOf(["a", "  ", "b"], "exclude", 10)).toStrictEqual(["a", "b"]);
    expect(listOf("**/gen/*,node_modules", "exclude", 10)).toStrictEqual([
      "**/gen/*",
      "node_modules",
    ]);
    expect(listOf(undefined, "exclude", 10)).toStrictEqual([]);
  });
});

/** 守护包装用例共用的最小命令（字面量散在多处改一处就漏）。 */
const REVIEW_CMD = "ocr review --audience agent";

describe("命令词的合法形态", () => {
  it("要么是 shq 转义的绝对路径，要么是未安装时刻意的裸 `ocr`", () => {
    const legal = OCR === "ocr" || /^'\/.*'$/u.test(OCR);
    expect(legal, `命令词形态不认识：${OCR}`).toBe(true);
  });
});

describe("ocrCommand：命令词解析（与 resolveOcrAvailability 同一份判据）", () => {
  it("PATH 上有候选 ⇒ 命令词是它的绝对路径，随包入口不再抢在它前面", () => {
    // 这条顺序就是「卡片报的版本 = 用户终端里跑的那一份」的全部保障：反过来的时候，
    // 用户升级了 PATH 上的 CLI，插件仍跑随包那份旧版，两处永远对不上。
    const bin = makeBinDir(["ocr"]);
    const launcher = makeBinDir(["ocr.js"]);
    const memo = {};
    expect(ocrCommand(() => path.join(launcher, "ocr.js"), memo, { PATH: bin })).toBe(
      shq(path.join(bin, "ocr")),
    );
  });

  it("PATH 没有候选才取随包 launcher；两处都没有 ⇒ 裸 ocr", () => {
    const launcher = makeBinDir(["ocr.js"]);
    const empty = makeEmptyDir();
    const memo = {};
    expect(ocrCommand(() => path.join(launcher, "ocr.js"), memo, { PATH: empty })).toBe(
      shq(path.join(launcher, "ocr.js")),
    );
    const bare = {};
    expect(ocrCommand(() => null, bare, { PATH: empty })).toBe("ocr");
  });

  it("解析结果每进程记忆一次：第二次即便判据给出别的答案也不重解析", () => {
    const bin = makeBinDir(["ocr"]);
    const other = makeBinDir(["ocr"]);
    const memo = {};
    expect(ocrCommand(() => null, memo, { PATH: bin })).toBe(shq(path.join(bin, "ocr")));
    expect(ocrCommand(() => null, memo, { PATH: other })).toBe(shq(path.join(bin, "ocr")));
  });

  it("生产那一档解析出的命令词可直接执行两种装法之一", () => {
    // 不注入：走默认定位口与真实 PATH。命中时是绝对路径，两处都没有时是裸 ocr——
    // 两者都是可执行命令词，这里只钉住这个不变量（本机装没装 CLI 不该让用例变脸）。
    expect(ocrCommand()).toMatch(/^(?:'.*'|ocr)$/u);
  });

  it("win32 恒走裸 ocr：绝对路径带反斜杠与空格在 cmd 里不可靠，随包 launcher 又是 shebang 脚本", () => {
    // 与 resolveOcrAvailability 的 win32 分支同一口径；README 的平台承诺（Windows 跑裸命令）
    // 由此兑现。platform 换成 stub，记忆槽用局部盒。
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const bin = makeBinDir(["ocr"]);
      const memo = {};
      expect(ocrCommand(() => null, memo, { PATH: bin })).toBe("ocr");
      expect(ocrCommand(() => null, {})).toBe("ocr");
    } finally {
      if (real === undefined) {
        Reflect.deleteProperty(process, "platform");
      } else {
        Object.defineProperty(process, "platform", real);
      }
    }
  });

  it("定位口三档：入口在盘上给出绝对路径，不在盘上或解析抛错都给 null", () => {
    // 默认那一档（createRequire）在此不可测——它取决于这台机器装没装那枚依赖；注入解析口
    // 才能把三条分支都摆出来。「依赖装了一半」（package.json 在、bin 入口不在）正是
    // 当初 optionalDependencies 平台上二进制装不上时的那个形态。
    const pkgDir = mkdtempSync(path.join(tmpdir(), "ocr-pkg-"));
    tempDirs.push(pkgDir);
    writeFileSync(path.join(pkgDir, "package.json"), "{}");
    const binDir = path.join(pkgDir, "bin");
    mkdirSync(binDir);
    const launcher = path.join(binDir, "ocr.js");
    writeFileSync(launcher, "#!/usr/bin/env node\n");
    const resolveEntry = (): string => path.join(pkgDir, "package.json");
    expect(locateLauncher(resolveEntry)).toBe(launcher);
    fsStub.exists = false;
    try {
      expect(locateLauncher(resolveEntry)).toBeNull();
    } finally {
      fsStub.exists = true;
    }
    expect(
      locateLauncher(() => {
        throw new Error("cannot find module");
      }),
    ).toBeNull();
  });

  it("生产那一档：本包不再随包分发 CLI，默认定位口恒给 null", () => {
    // 与 test/publish-manifest.test.ts 那条「没有 optionalDependencies」的门禁同一条事实，
    // 从代码侧再钉一次：这里若哪天不再是 null，就说明随包那份又回来了、PATH 上的用户自装
    // 那份又要被它遮蔽。
    expect(locateLauncher()).toBeNull();
  });
});

describe("wrapWithHostReaper", () => {
  it("外层 bash -c，内部命令完整保留且 ppid 监视带可用性探测", () => {
    const wrapped = wrapWithHostReaper(REVIEW_CMD, zh);
    expect(wrapped.startsWith("bash -c '")).toBe(true);
    const inner = unwrapReaper(wrapped);
    expect(inner).toContain(REVIEW_CMD);
    expect(inner).toContain(`{ ${REVIEW_CMD} ; } & ocr=$!`);
    expect(inner).toContain(
      `p0=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' '); [ -n "$p0" ] && HAVEPS=1 || HAVEPS=0`,
    );
    expect(inner).toContain("trap 'reap; exit 143' TERM INT");
    expect(inner).toContain('killmPid "$ocr"');
    expect(inner).toContain("isl && kill -KILL -- -$$");
    expect(inner).toContain('wait "$ocr"; exit $?');
  });

  it("ps 不可用时监视判据短路：不再每轮 fork ps，且 ppid 比对有显式旁路", () => {
    // 回归钉的是两件事：HAVEPS=0 分支真的存在（否则恒真判据会冒充看护在位），
    // 以及 ps 在该分支下不被调用（否则围栏里每 2 秒刷一次 EPERM）。
    const inner = unwrapReaper(wrapWithHostReaper(REVIEW_CMD, zh));
    expect(inner).toContain(`[ "$HAVEPS" = 0 ] ||`);
    expect(inner).toContain(`isl() { [ "$HAVEPS" = 1 ] &&`);
    expect(inner).toContain(
      `while kill -0 "$ocr" 2>/dev/null && { [ "$HAVEPS" = 0 ] || [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = "$p0" ]; }; do sleep 2; done`,
    );
    // 探测只发生一次（起始行），另一处是监视循环里的短路求值点——两处，别更多。
    expect(inner.match(/ps -o ppid=/gu)).toHaveLength(2);
  });

  it("进程平台为 win32 时不套守护：POSIX 工具链缺席就放行裸命令（否则 execNotFound）", () => {
    // 守护整条链是 bash + ps/pgrep/kill 的进程组语义，Windows 上一样都不成立。
    // 这里把 process.platform 钉成 win32，断言返回的就是原命令、没有任何包装。
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const command = REVIEW_CMD;
      expect(wrapWithHostReaper(command, zh)).toBe(command);
      expect(wrapWithHostReaper(command, zh)).not.toContain("bash -c");
    } finally {
      if (real === undefined) {
        Reflect.deleteProperty(process, "platform");
      } else {
        Object.defineProperty(process, "platform", real);
      }
    }
  });

  it("ps 与 pgrep 都探测；任一不可用就整条不挂守护（残缺 reap 只会杀中间 bash 壳）", () => {
    const inner = unwrapReaper(wrapWithHostReaper(REVIEW_CMD, zh));
    // ps 探测：恒真的 ppid 比对会把「硬退出看护没生效」伪装成在位
    expect(inner).toContain("HAVEPS");
    // pgrep 探测：它只出现在后代快照 desc() 里，漏探时 cs 恒空 ⇒ 真 ocr 进程全部泄漏
    expect(inner).toContain("HAVEPG");
    expect(inner).toContain("pgrep -P 1");
    // 降级分支在两个探针之后、启动子进程之前，不可用时直接原样跑并退出
    expect(inner).toContain("exit $?");
    expect(inner.indexOf("HAVEPG")).toBeLessThan(inner.indexOf("ocr=$!"));
  });

  it("降级说明走 messages 注入：换语言只换文案，两个探针不变", () => {
    const zhInner = unwrapReaper(wrapWithHostReaper(REVIEW_CMD, zh));
    const enInner = unwrapReaper(wrapWithHostReaper(REVIEW_CMD, MESSAGES.en));
    expect(zhInner).not.toBe(enInner);
    expect(zhInner).toContain("宿主回收守护已降级");
    expect(enInner).toContain("host reaper degraded");
    for (const probe of ["HAVEPS", "HAVEPG", "pgrep -P 1"]) {
      expect(zhInner).toContain(probe);
      expect(enInner).toContain(probe);
    }
  });

  it("原命令含单引号时二次转义，可精确还原（注入防护）", () => {
    const cmd = "ocr review --exclude 'a; rm -rf /' --background 'it''s ok'";
    const wrapped = wrapWithHostReaper(cmd, zh);
    const inner = unwrapReaper(wrapped);
    expect(inner).toContain("{ ocr review --exclude 'a; rm -rf /' --background 'it''s ok' ; }");
  });
});

describe("buildReviewCommand", () => {
  it("workspace 默认形态：--audience agent --format json --output", () => {
    const { command, workdir } = reviewCmd({ repo: "/r" }, "/tmp/out.json");
    expect(workdir).toBe("/r");
    expect(command).toContain(`${OCR} review --audience agent --format json`);
    expect(command).toContain("--output '/tmp/out.json'");
    expect(command).toContain("--effort medium");
  });

  it("commit 模式携带 -c 且与 from/to 互斥", () => {
    const { command } = reviewCmd({ repo: "/r", scope: "commit", commit: "abc123" }, "/o");
    expect(command).toContain("--commit 'abc123'");
    expect(() =>
      reviewCmd({ repo: "/r", scope: "commit", commit: "a", from: "main", to: "f" }, "/o"),
    ).toThrow(/互斥/u);
    expect(() => reviewCmd({ repo: "/r", scope: "commit" }, "/o")).toThrow(/需要 commit/u);
  });

  it("branch 模式 require from/to", () => {
    const { command } = reviewCmd(
      { repo: "/r", scope: "branch", from: "main", to: "feature", effort: "high" },
      "/o",
    );
    expect(command).toContain("--from 'main' --to 'feature'");
    expect(command).toContain("--effort high");
    expect(() => reviewCmd({ repo: "/r", scope: "branch", from: "main" }, "/o")).toThrow(
      /from 与 to/u,
    );
  });

  it("exclude/background 经 shq 转义且多值合并为逗号（String 型 flag，实测多实例不生效）", () => {
    const { command } = reviewCmd(
      { repo: "/r", exclude: ["a; rm -rf /", "b/c"], background: "需求：$API 与 `x`" },
      "/o",
    );
    expect(command).toContain("--exclude 'a; rm -rf /,b/c'");
    expect(command).not.toContain("--exclude 'a; rm -rf /' --exclude");
    expect(command).toContain("--background '需求：$API 与 `x`'");
  });

  it("maxTokensBudget 透传 --max-tokens-budget", () => {
    const { command } = reviewCmd({ repo: "/r", maxTokensBudget: 200_000 }, "/o");
    expect(command).toContain("--max-tokens-budget 200000");
  });

  it("数值 flag 忠实透传、无钳制（0 语义：timeout 不限时 / 其余模板默认或不限）", () => {
    const { command } = reviewCmd(
      {
        repo: "/r",
        timeoutMinutes: 0,
        maxTools: 0,
        maxTokens: 3_000_000,
        maxTokensBudget: 0,
        concurrency: 100,
      },
      "/o",
    );
    expect(command).toContain("--timeout 0");
    expect(command).toContain("--max-tools 0");
    expect(command).toContain("--max-tokens 3000000");
    expect(command).toContain("--max-tokens-budget 0");
    expect(command).toContain("--concurrency 100");
  });

  it("数值 flag 缺省省略（跟随 OCR flag 默认）；非法值当场拒绝", () => {
    const base = reviewCmd({ repo: "/r" }, "/o");
    expect(base.command).not.toContain("--timeout");
    expect(base.command).not.toContain("--max-tools");
    expect(base.command).not.toContain("--max-tokens");
    expect(base.command).not.toContain("--concurrency");
    expect(() => reviewCmd({ repo: "/r", maxTokens: -1 }, "/o")).toThrow(/--max-tokens/u);
    expect(() => reviewCmd({ repo: "/r", concurrency: 0 }, "/o")).toThrow(/--concurrency/u);
  });

  it("outputPath 缺省（后台模式）省略 --output：结果以 OCR 会话记录为准", () => {
    const review = reviewCmd({ repo: "/r" }, undefined).command;
    const scan = scanCmd({ repo: "/r", path: ["a.mjs"] }, undefined).command;
    expect(review).not.toContain("--output");
    expect(scan).not.toContain("--output");
  });

  it("resume 与 workspace 同给前置拒绝（OCR 契约 workspace 禁恢复，别烧一次进程才报错）", () => {
    expect(() => reviewCmd({ repo: "/r", resume: "abc" }, "/o")).toThrow(/resume 需要 scope/u);
    // commit/branch 模式下 resume 合法，原样透传。
    const commit = reviewCmd({ repo: "/r", scope: "commit", commit: "abc", resume: "abc" }, "/o");
    expect(commit.command).toContain("--resume 'abc'");
    const branch = reviewCmd({ repo: "/r", from: "main", to: "f", resume: "abc" }, "/o");
    expect(branch.command).toContain("--resume 'abc'");
  });
});

describe("buildScanCommand", () => {
  it("path 多值合并为单个逗号分隔 --path（String 型 flag，实测多实例不生效）", () => {
    const { command } = scanCmd(
      { repo: "/r", path: ["internal/a", "internal/b.go"], batch: "by-directory" },
      "/o",
    );
    expect(command).toContain("--path 'internal/a,internal/b.go'");
    expect(command).not.toContain("--path 'internal/a' --path");
    expect(command).toContain("--batch 'by-directory'");
  });

  it("scan 同样透传 timeout/max-tools/max-tokens/max-tokens-budget（shared_flags.go 的 registerScanFlags 原生支持）", () => {
    const { command } = scanCmd(
      {
        repo: "/r",
        path: ["scripts/a.mjs"],
        timeoutMinutes: 0,
        maxTools: 0,
        maxTokens: 0,
        maxTokensBudget: 0,
      },
      "/o",
    );
    expect(command).toContain("--timeout 0");
    expect(command).toContain("--max-tools 0");
    expect(command).toContain("--max-tokens 0");
    expect(command).toContain("--max-tokens-budget 0");
  });

  it("provider/model 透传 --provider/--model（shared_flags.go 的 registerScanFlags，与 review 对齐）", () => {
    const { command } = scanCmd({ repo: "/r", provider: "p1", model: "m1" }, "/o");
    expect(command).toContain("--provider 'p1'");
    expect(command).toContain("--model 'm1'");
    // 缺省省略，跟随 OCR 全局配置。
    expect(scanCmd({ repo: "/r" }, "/o").command).not.toContain("--provider");
  });
});

describe("buildSessionCommand", () => {
  it("list 缺省：--json --repo --limit 钳制", () => {
    const { command } = sessionCmd({ repo: "/r" });
    expect(command).toContain(`${OCR} session list --json`);
    expect(command).toContain("--repo '/r' --limit 10");
  });

  it("id 存在 → show；action=comments → comments", () => {
    expect(sessionCmd({ repo: "/r", id: "abc" }).command).toContain(
      `${OCR} session show --json --repo '/r' -- 'abc'`,
    );
    // `--` 不是可省的装饰：cobra 在位置参数之前就解析 flag，以 `-` 开头的 id 会被当成
    // flag 消化掉（实测 `ocr session show --json --repo /tmp -abc` 报
    // "unknown shorthand flag: 'a'"）。这条断言钉的是命令骨架，`shq()` 管不到这一层。
    expect(sessionCmd({ repo: "/r", id: "abc" }).command).toMatch(
      / session (?:show|comments) .* -- /u,
    );
    expect(sessionCmd({ repo: "/r", action: "comments", id: "abc" }).command).toContain(
      `${OCR} session comments --json --repo '/r' -- 'abc'`,
    );
  });

  it("limit 显式给出必须是 1-100 整数：0/101/浮点/布尔/非数字串抛错（0 不再静默钳成 1）", () => {
    expect(sessionCmd({ repo: "/r", limit: 50 }).command).toContain("--limit 50");
    // 数字字符串与 pushIntFlag 同口径：接受。
    expect(sessionCmd({ repo: "/r", limit: "25" }).command).toContain("--limit 25");
    for (const bad of [0, 101, 1.5, true, "abc"]) {
      expect(() => sessionCmd({ repo: "/r", limit: bad })).toThrow(/1-100/u);
    }
  });

  it("action=list 与 id 同给 ⇒ 抛错（不再静默改写成 show）", () => {
    expect(() => sessionCmd({ repo: "/r", action: "list", id: "abc" })).toThrow(
      /action=list 不接受 id/u,
    );
  });
});

describe("withHomeEnv / buildLlmTestCommand", () => {
  it("home 未设原样返回；设置时加 HOME= 赋值前缀且路径经 shq", () => {
    expect(withHomeEnv(`${OCR} review`, undefined)).toBe(`${OCR} review`);
    expect(withHomeEnv(`${OCR} review`, "/data/ocr")).toBe(`HOME='/data/ocr' ${OCR} review`);
    // 路径里的空格/元字符必须过 shq，否则赋值前缀就成了注入位。
    expect(withHomeEnv(`${OCR} review`, "/da ta; x")).toBe(`HOME='/da ta; x' ${OCR} review`);
  });

  it("llm test 与五个工具同一命令词解析源（随包装法下 PATH 上没有裸 ocr）", () => {
    // OCR 常量就是 ocrCommand() 的记忆值：两条必须同源，否则 autoVerify/测试连接
    // 在「只随包装了 npm 包」的机器上永远 exit 127。
    expect(buildLlmTestCommand()).toBe(`${OCR} llm test --color never`);
  });
});

describe("version 探测：命令词与版本解析", () => {
  it("与五个工具同一解析源，且不套宿主回收守护（秒级本地打印）", () => {
    expect(buildVersionCommand()).toBe(`${OCR} version`);
  });

  it("两种真实自述形态都读得出来：随包构建带 v，包管理器装到 PATH 上那份不带", () => {
    // 随包的 Go 构建把 git tag 整个塞进 Version，还夹一段 commit（这句是本机实跑取回的原文）。
    expect(
      parseOcrVersion("open-code-review v1.12.13 (fabbdb29) darwin/arm64\nbuilt at: x\n"),
    ).toBe("1.12.13");
    expect(parseOcrVersion("open-code-review v1.12.13 darwin/arm64\n")).toBe("1.12.13");
    expect(parseOcrVersion("open-code-review 1.12.13 darwin/arm64")).toBe("1.12.13");
    expect(parseOcrVersion("open-code-review v1.13.0-rc.1+build.7 linux/amd64")).toBe(
      "1.13.0-rc.1+build.7",
    );
    expect(parseOcrVersion("open-code-review v1.14 darwin/arm64")).toBe("1.14");
  });

  it("读不出即 null，不猜：dev、空串、以及只有升级提示的那句", () => {
    // 未发布构建的 Version 就是 "dev"。
    expect(parseOcrVersion("open-code-review dev linux/amd64")).toBeNull();
    expect(parseOcrVersion("")).toBeNull();
    // launcher 的升级提示里也带一个版本号，但那是**可用的新版本**、不是本机装的这份；
    // 判据锚在产品名上，所以这里必须是 null，而不是把建议读成现状。
    expect(
      parseOcrVersion(
        "[ocr] A new version (v1.14.0) is available. Run to update:\n" +
          "  npm i -g @alibaba-group/open-code-review@1.14.0\n",
      ),
    ).toBeNull();
  });
});

describe("delegate 命令", () => {
  it("preview：workspace 缺省、branch 带 merge-base 对", () => {
    const { command } = previewCmd({
      repo: "/r",
      scope: "branch",
      from: "main",
      to: "f",
    });
    expect(command).toContain(`${OCR} delegate preview --format json`);
    expect(command).toContain("--from 'main' --to 'f'");
  });

  it("rule：位置参数逐条转义、-- 分隔防 dash 开头", () => {
    const { command } = ruleCmd({ repo: "/r", paths: ["-weird.ts", "src/a.ts"] });
    expect(command).toContain(`${OCR} delegate rule --format json -- '-weird.ts' 'src/a.ts'`);
    expect(() => ruleCmd({ repo: "/r", paths: [] })).toThrow(/至少传一个/u);
  });
});

/* ── 注入防线（回归钉）─────────────────────────────────────────────────────
 * 这些用例逐字锁死「值只能以整段 shq 引号形态进入命令」这一条不变式：
 * 未来任何一次改成裸拼接 / 改成转义 format 的编辑都会让它们变红。 */

/** 从开引号下标起找该 shq 段的闭引号下标（-1 = 未闭合）。
 *  shq 的 `'…'\''…'` 形态里 '\'' 只是续段，闭引号必须继续向后找。 */
function scanQuoted(command: string, openAt: number): number {
  let cursor = openAt;
  for (;;) {
    const close = command.indexOf("'", cursor + 1);
    if (close === -1) {
      return -1;
    }
    const escaped =
      command.charAt(close + 1) === "\\" &&
      command.charAt(close + 2) === "'" &&
      command.charAt(close + 3) === "'";
    if (escaped) {
      cursor = close + 3;
    } else {
      return close;
    }
  }
}

/** 剥掉所有 shq 单引号段后的「命令骨架」。
 *  逐段吃掉后骨架里不残留任何引号/反斜杠痕迹，因此骨架应当只剩固定字面量。 */
function skeleton(command: string): string {
  let out = "";
  let index = 0;
  while (index < command.length) {
    if (command.charAt(index) === "'") {
      const closed = scanQuoted(command, index);
      if (closed === -1) {
        return `${out}⟦UNCLOSED⟧`;
      }
      out += "⟦Q⟧";
      index = closed + 1;
    } else {
      out += command.charAt(index);
      index += 1;
    }
  }
  return out;
}

/** 用户可控值注入 shell 元字符的候选（PoC 原型见 review finding 1）。 */
const PAYLOADS = [
  "json; touch /tmp/PWNED; echo",
  "a$(id)",
  "a`id`b",
  "a|b&&c",
  "a>b<c",
  "a'b\"c",
  "a\nb",
  "--output /etc/passwd",
] as const;

/** 除 ⟦Q⟧ 占位与固定字面量外，骨架里不允许出现任何 shell 元字符。 */
const METACHARS = /[;&|`$<>*\n\\"'{}[\]()!#~%]/u;

describe("注入防线：所有插值槽位都必须经 shq 或白名单", () => {
  it("format 白名单：非枚举值（含注入 PoC）回落 json，绝不进命令串", () => {
    expect(resolveOutputFormat("json")).toBe("json");
    expect(resolveOutputFormat("text")).toBe("text");
    expect(resolveOutputFormat("sarif")).toBe("sarif");
    for (const payload of PAYLOADS) {
      expect(resolveOutputFormat(payload)).toBe("json");
      const review = reviewCmd({ repo: "/r", format: payload }, "/o").command;
      const scan = scanCmd({ repo: "/r", format: payload }, "/o").command;
      expect(review).toContain(FORMAT_JSON_FLAG);
      expect(scan).toContain(FORMAT_JSON_FLAG);
      expect(review).not.toContain("touch");
      expect(skeleton(review)).not.toMatch(METACHARS);
      expect(skeleton(scan)).not.toMatch(METACHARS);
    }
    // 非字符串同样进不了命令串
    expect(resolveOutputFormat({ toString: () => "text" })).toBe("json");
    expect(resolveOutputFormat(42)).toBe("json");
  });

  it("白名单放行的 text/sarif 在执行层被拒：本包只解 JSON，交下去只会把契约问题说成 OCR 的错", () => {
    // 三层口径不同是刻意的：resolveOutputFormat 管**注入面**（只放行枚举值，挡住拼接），
    // 而 buildReviewCommand/buildScanCommand 管**下游能力**（解析层只解 JSON）。白名单里
    // 留着 text/sarif 是为了让"传了非法值"与"传了本包不支持的合法值"给出不同的错，
    // 这一条钉的正是后面那句。
    for (const format of ["text", "sarif"] as const) {
      expect(() => reviewCmd({ repo: "/r", format }, "/o")).toThrow(/只支持 --format json/u);
      expect(() => scanCmd({ repo: "/r", format }, "/o")).toThrow(/只支持 --format json/u);
    }
    // 反向：json 与缺省都必须照常出命令，别把正常档一起拦掉。
    expect(reviewCmd({ repo: "/r", format: "json" }, "/o").command).toContain(FORMAT_JSON_FLAG);
    expect(reviewCmd({ repo: "/r" }, "/o").command).toContain(FORMAT_JSON_FLAG);
  });

  it("review：每个可控槽位喂注入载荷，命令骨架仍全是固定字面量", () => {
    for (const payload of PAYLOADS) {
      const { command } = reviewCmd(
        {
          repo: "/r",
          scope: "commit",
          commit: payload,
          background: payload,
          exclude: [payload],
          provider: payload,
          model: payload,
          resume: payload,
          effort: payload,
          format: payload,
        },
        "/tmp/out file.json",
      );
      const stripped = skeleton(command);
      expect(stripped).not.toMatch(METACHARS);
      // 载荷必须整段落在引号里：⟦Q⟧ 个数 = 可控槽位数（commit/background/
      // exclude/provider/model/resume/output）+ 命令词本身。命令词只在解析到绝对路径时
      // 是 shq 转义的（未安装 ocr 的机器上是刻意保留的裸名 `ocr`），所以按现量加。
      expect(stripped.split("⟦Q⟧").length - 1).toBe(REVIEW_SLOTS + OCR_QUOTED);
    }
  });

  it("scan：path/exclude/batch/background 槽位同样闭合", () => {
    for (const payload of PAYLOADS) {
      const { command } = scanCmd(
        {
          repo: "/r",
          path: [payload],
          exclude: payload,
          batch: payload,
          background: payload,
          format: payload,
        },
        "/o",
      );
      const stripped = skeleton(command);
      expect(stripped).not.toMatch(METACHARS);
      expect(stripped.split("⟦Q⟧").length - 1).toBe(SCAN_SLOTS + OCR_QUOTED);
    }
  });

  it("delegate preview/rule 与 session：可控槽位同样闭合", () => {
    for (const payload of PAYLOADS) {
      const preview = previewCmd({
        repo: "/r",
        scope: "branch",
        from: payload,
        to: payload,
        background: payload,
        exclude: [payload],
      }).command;
      expect(skeleton(preview)).not.toMatch(METACHARS);
      const rule = ruleCmd({ repo: "/r", paths: [payload, "b.ts"] }).command;
      expect(skeleton(rule)).not.toMatch(METACHARS);
      const session = sessionCmd({ repo: "/r", id: payload, action: "show" }).command;
      expect(skeleton(session)).not.toMatch(METACHARS);
    }
  });

  it("数值 flag：任何形态的注入都到不了命令串（要么纯数字、要么抛错）", () => {
    const values: unknown[] = ["5", 5, true, [6], "1; touch /tmp/PWNED", {}, "1e+21", Number.NaN];
    const accepted: string[] = [];
    let rejected = 0;
    for (const value of values) {
      try {
        accepted.push(reviewCmd({ repo: "/r", maxTokens: value }, "/o").command);
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(0);
    for (const command of accepted) {
      expect(/--max-tokens \d+(?:\s|$)/u.test(command)).toBe(true);
      expect(skeleton(command)).not.toMatch(METACHARS);
    }
  });

  it("wrapWithHostReaper 后仍然是「一段 bash -c 参数」：二次转义不破功", () => {
    for (const payload of PAYLOADS) {
      const { command } = reviewCmd({ repo: "/r", commit: payload }, "/o");
      const wrapped = wrapWithHostReaper(command, zh);
      expect(wrapped.startsWith("bash -c '")).toBe(true);
      expect(unwrapReaper(wrapped)).toContain(command);
      // 整段 inner 必须只算「一个」shq 参数：骨架里除 ⟦Q⟧ 外什么都不剩，
      // 说明载荷没有任何机会跑到引号外面（= bash -c 的 argv 只有一个 token）。
      expect(skeleton(wrapped.slice("bash -c ".length))).toBe("⟦Q⟧");
    }
  });
});

describe("错类型参数：静默回落会扩大审查范围，一律抛错", () => {
  it("commit/from/to/scope 非字符串（键存在时）拒绝", () => {
    expect(() => reviewCmd({ repo: "/r", commit: 12_345 }, "/o")).toThrow(/commit 必须是字符串/u);
    expect(() => reviewCmd({ repo: "/r", from: 12_345, to: "x" }, "/o")).toThrow(
      /from 必须是字符串/u,
    );
    expect(() => reviewCmd({ repo: "/r", to: {} }, "/o")).toThrow(/to 必须是字符串/u);
    expect(() => reviewCmd({ repo: "/r", scope: ["commit"] }, "/o")).toThrow(/scope 必须是字符串/u);
    expect(() => reviewCmd({ repo: "/r", provider: 7 }, "/o")).toThrow(/provider 必须是字符串/u);
    // null / undefined 仍按缺省处理（workspace）
    expect(reviewCmd({ repo: "/r", commit: undefined }, "/o").command).toContain("--effort medium");
  });

  it("NUL 字节在字符串参数上早拒（不等 spawn 时报错）", () => {
    expect(() => reviewCmd({ repo: "/r", commit: "a\u0000b" }, "/o")).toThrow(/NUL/u);
  });

  it("commaList 元素类型严格：对象不会变成 [object Object] 混进模式串", () => {
    expect(() => listOf([{ a: 1 }], "exclude", 5)).toThrow(/数组元素必须是字符串/u);
    expect(() => listOf(42, "exclude", 5)).toThrow(/必须是字符串或字符串数组/u);
    expect(() => listOf(["a\u0000b"], "path", 5)).toThrow(/NUL/u);
    expect(listOf("a,b", "path", 5)).toStrictEqual(["a", "b"]);
    // 超限整条拒绝：命令不构造、一条都不审，文案把「没有开始」说出口。
    expect(() => listOf(["a", "b"], "path", 1)).toThrow(/超过 1 条上限（多出 1 条）/u);
  });

  it("session action 白名单、id 类型严格", () => {
    expect(() => sessionCmd({ repo: "/r", action: "rm -rf /" })).toThrow(/action 非法/u);
    expect(() => sessionCmd({ repo: "/r", id: 9 })).toThrow(/id 必须是字符串/u);
    // action=list 与 id 同给不再静默改写成 show（自相矛盾的入参一律抛错）。
    expect(() => sessionCmd({ repo: "/r", action: "list", id: "abc" })).toThrow(
      /action=list 不接受 id/u,
    );
  });
});

describe("session --limit 的数值闸", () => {
  it("越界/错类型抛错而非静默钳制（0=「想看全部」钳成 1 是最坏读法）", () => {
    expect(() => sessionCmd({ repo: "/r", limit: 500 })).toThrow(/1-100/u);
    expect(() => sessionCmd({ repo: "/r", limit: true })).toThrow(/1-100/u);
  });
});

describe("scope 组合：branch 先判，commit 非空不再静默吞掉 branch", () => {
  it("scope=branch + commit ⇒ 明确互斥错误（不再降级成 commit 审查）", () => {
    expect(() =>
      reviewCmd({ repo: "/r", scope: "branch", commit: "c", from: "a", to: "b" }, "/o"),
    ).toThrow(/与 commit 互斥/u);
    expect(() => reviewCmd({ repo: "/r", scope: "nope" }, "/o")).toThrow(/未知 scope/u);
    // 白名单必须排在「按 from/to 反推模式」之前：否则 scope=nope 配上一组合法的
    // from/to 会被当成 branch 静默放行，那条 unknownScope 永不可达。
    expect(() => reviewCmd({ repo: "/r", scope: "nope", from: "a", to: "b" }, "/o")).toThrow(
      /未知 scope：nope/u,
    );
  });

  it("显式 scope 与另一种范围参数冲突时明确拒绝（不再被后者静默覆盖）", () => {
    // 缺省 scope 时给 commit 是合法用法，所以只拦「显式声明了 workspace」这一支。
    expect(() => reviewCmd({ repo: "/r", scope: "workspace", commit: "abc" }, "/o")).toThrow(
      /scope=workspace 与 commit 不能同时给/u,
    );
    expect(() => reviewCmd({ repo: "/r", scope: "workspace", from: "a", to: "b" }, "/o")).toThrow(
      /scope=workspace 与 from\/to 不能同时给/u,
    );
    expect(reviewCmd({ repo: "/r", commit: "abc" }, "/o").command).toContain("--commit");
    expect(reviewCmd({ repo: "/r", scope: "workspace" }, "/o").command).not.toContain("--commit");
    expect(() => previewCmd({ repo: "/r", scope: "unknown" })).toThrow(/未知 scope/u);
  });

  it("scope 大小写不敏感；仅给 commit 仍按 commit 模式", () => {
    expect(reviewCmd({ repo: "/r", scope: "COMMIT", commit: "c" }, "/o").command).toContain(
      "--commit 'c'",
    );
    expect(reviewCmd({ repo: "/r", commit: " " }, "/o").command).not.toContain("--commit");
  });
});

describe("session：action 白名单下的优雅降级", () => {
  it("action=show/comments 缺 id ⇒ 回落 list，绝不构造空 id 的 show", () => {
    expect(sessionCmd({ repo: "/r", action: "show" }).command).toContain(SESSION_LIST_CMD);
    expect(sessionCmd({ repo: "/r", action: "comments" }).command).toContain(SESSION_LIST_CMD);
    expect(sessionCmd({ repo: "/r", action: "" }).command).toContain(SESSION_LIST_CMD);
  });

  it("action 缺省但有 id ⇒ show；limit 只在 list 下出现", () => {
    expect(sessionCmd({ repo: "/r", id: "s1" }).command).toContain(`${OCR} session show`);
    expect(sessionCmd({ repo: "/r", id: "s1" }).command).not.toContain("--limit");
  });
});

/* ── i18n：拒绝理由取自注入的那份文案（换语言不换判定，也不换 argv）───────── */

describe("拒绝理由双语（注入 en 那份）", () => {
  const { en } = MESSAGES;

  it("repo 的四类拒绝在 en 下是英文，且把收到的值原样点名", () => {
    expect(() => rootOf("", en)).toThrow("repo is required and must be the absolute path");
    expect(() => rootOf("a\u0000b", en)).toThrow("repo must not contain NUL bytes");
    expect(() => rootOf("relative/x", en)).toThrow(
      "repo must be an absolute path (starting with /): relative/x",
    );
    expect(() => rootOfFallback(undefined, undefined, en)).toThrow(
      "repo is required: the current session workspace is unknown",
    );
  });

  it("类型闸 / 数值闸 / scope 与 action 白名单：整批拒绝都随语言切换", () => {
    expect(() => reviewCmd({ repo: "/r", commit: 12_345 }, "/o", en)).toThrow(
      "commit must be a string (got 12345)",
    );
    expect(() => listOf(["a\u0000b"], "path", 5, en)).toThrow("path must not contain NUL bytes");
    expect(() => listOf([{ obj: 1 }], "exclude", 5, en)).toThrow(
      "the items of exclude must be strings",
    );
    expect(() => listOf(42, "exclude", 5, en)).toThrow(
      "exclude must be a string or an array of strings",
    );
    expect(() => reviewCmd({ repo: "/r", maxTokens: -1 }, "/o", en)).toThrow(
      "--max-tokens must be an integer ≥ 0, got -1",
    );
    expect(() => reviewCmd({ repo: "/r", concurrency: 0 }, "/o", en)).toThrow(
      "--concurrency must be an integer ≥ 1, got 0",
    );
    const mixed = { repo: "/r", scope: "branch", commit: "c", from: "a", to: "b" };
    expect(() => reviewCmd(mixed, "/o", en)).toThrow(
      "scope=branch/from/to and commit are mutually exclusive",
    );
    expect(() => reviewCmd({ repo: "/r", scope: "branch", from: "main" }, "/o", en)).toThrow(
      "scope=branch requires both from and to",
    );
    expect(() => reviewCmd({ repo: "/r", scope: "commit" }, "/o", en)).toThrow(
      "scope=commit requires the commit parameter",
    );
    expect(() => reviewCmd({ repo: "/r", scope: "nope" }, "/o", en)).toThrow(
      "unknown scope: nope (workspace/commit/branch)",
    );
    expect(() => previewCmd({ repo: "/r", scope: "unknown" }, en)).toThrow(
      "unknown scope: unknown (workspace/commit/branch)",
    );
    expect(() => ruleCmd({ repo: "/r", paths: [] }, en)).toThrow("paths is required");
    expect(() => sessionCmd({ repo: "/r", action: "rm -rf /" }, en)).toThrow(
      "invalid action: rm -rf / (expected list/show/comments/compare/export)",
    );
    expect(() => sessionCmd({ repo: "/r", id: 9 }, en)).toThrow("id must be a string (got 9)");
  });

  it("合法入参下两语构造出的命令逐字相同（文案进不了 argv）", () => {
    const reviewArgs: ReviewScopeArgs = {
      repo: "/r",
      scope: "branch",
      from: "main",
      to: "feature/x",
      exclude: ["a", "b"],
      background: "上下文",
    };
    expect(reviewCmd(reviewArgs, "/o", en).command).toBe(reviewCmd(reviewArgs, "/o", zh).command);
    const scanArgs: ScanScopeArgs = { repo: "/r", path: ["x.ts"], batch: "by-directory" };
    expect(scanCmd(scanArgs, "/o", en).command).toBe(scanCmd(scanArgs, "/o", zh).command);
    const previewArgs: DelegatePreviewArgs = { repo: "/r", exclude: "a,b" };
    expect(previewCmd(previewArgs, en).command).toBe(previewCmd(previewArgs, zh).command);
    const ruleArgs = { repo: "/r", paths: ["src/a.ts"] };
    expect(ruleCmd(ruleArgs, en).command).toBe(ruleCmd(ruleArgs, zh).command);
    const sessionArgs: SessionArgs = { repo: "/r", action: "comments", id: "s1" };
    expect(sessionCmd(sessionArgs, en).command).toBe(sessionCmd(sessionArgs, zh).command);
  });
});

/* ── 只问文件系统、不 spawn 的可用性判据 ─────────────────────────────────── */

describe("只问文件系统、不 spawn 的判据：装没装、哪一份、谁装的", () => {
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("resolveOcrAvailability：来源三档与它的假命中防线", () => {
    it("PATH 上有候选 ⇒ path，且随包入口在盘也不抢在它前面", () => {
      // 反序是缺陷形态：随包绝对路径先命中的话，用户升级了自己装在 PATH 上的 CLI，
      // 插件却仍跑随包那份，卡片报的版本与他终端里跑的永远对不上。
      const bin = makeBinDir(["ocr"]);
      const launcher = path.join(makeBinDir(["ocr.js"]), "ocr.js");
      expect(resolveOcrAvailability({ PATH: bin }, () => launcher, "darwin")).toStrictEqual({
        source: "path",
        path: path.join(bin, "ocr"),
        channel: "unknown",
      });
    });

    it("PATH 没有候选、随包入口在盘 ⇒ bundled（那一档只剩兜底的意义）", () => {
      const empty = makeEmptyDir();
      const launcher = path.join(makeBinDir(["ocr.js"]), "ocr.js");
      expect(resolveOcrAvailability({ PATH: empty }, () => launcher, "darwin")).toStrictEqual({
        source: "bundled",
        path: launcher,
        channel: "unknown",
      });
    });

    it("假命中不算数：PATH 里那个 ocr 是目录，或那段目录里根本没有", () => {
      const dirAsBin = makeEmptyDir();
      mkdirSync(path.join(dirAsBin, "ocr"));
      const nothing = makeEmptyDir();
      expect(resolveOcrAvailability({ PATH: dirAsBin }, () => null, "darwin").source).toBe("none");
      expect(resolveOcrAvailability({ PATH: nothing }, () => null, "darwin").source).toBe("none");
    });

    it("PATH 的空段不当 cwd：滤掉之后在真实目录里命中", () => {
      // shell 把空段解释成**当前工作目录**，跟着这条语义走就会把被审查仓库里恰好叫
      // ocr 的文件报成「PATH 上有」——而工作目录正是本包每次评审都在用的那个。
      const bin = makeBinDir(["ocr"]);
      expect(resolveOcrAvailability({ PATH: `:${bin}` }, () => null, "linux")).toStrictEqual({
        source: "path",
        path: path.join(bin, "ocr"),
        channel: "unknown",
      });
      expect(resolveOcrAvailability({ PATH: ":" }, () => null, "linux").source).toBe("none");
    });

    it("按 PATH 顺序找：前一个目录没有就继续往下一个", () => {
      const empty = makeEmptyDir();
      const bin = makeBinDir(["ocr"]);
      expect(
        resolveOcrAvailability({ PATH: `${empty}:${bin}` }, () => null, "darwin"),
      ).toStrictEqual({
        source: "path",
        path: path.join(bin, "ocr"),
        channel: "unknown",
      });
    });

    it("PATH 与 Path 都缺席 ⇒ 空串回落、判 none，不抛（也没了来源可报）", () => {
      expect(resolveOcrAvailability({}, () => null, "darwin")).toStrictEqual({ source: "none" });
    });

    it("win32 即便定位口给得出入口也只走 PATH，并按 PATHEXT 命中", () => {
      // 与 ocrCommand() 的 win32 跳过同一口径：两处不一致时，状态说「随包可用」而命令
      // 却走另一条路，用户按状态做的决定就落在空处。后缀按字面比，大小写折叠是 Windows
      // 文件系统的事，在 POSIX 上照做就错了，本判据不替平台改写语义。
      const bin = makeBinDir(["ocr.cmd"]);
      const launcher = makeBinDir(["ocr.js"]);
      expect(
        resolveOcrAvailability(
          { PATH: bin, PATHEXT: ".COM;.cmd" },
          () => path.join(launcher, "ocr.js"),
          "win32",
        ),
      ).toStrictEqual({ source: "path", path: path.join(bin, "ocr.cmd"), channel: "unknown" });
    });

    it("win32 的 PATHEXT 缺席时认裸名；Path 这种环境变量名也读", () => {
      const bin = makeBinDir(["ocr"]);
      expect(resolveOcrAvailability({ Path: bin }, () => null, "win32")).toStrictEqual({
        source: "path",
        path: path.join(bin, "ocr"),
        channel: "unknown",
      });
    });

    it("win32 的 PATHEXT 里空段与重复段都不生出多余候选", () => {
      const bin = makeBinDir(["ocr"]);
      expect(
        resolveOcrAvailability({ PATH: bin, PATHEXT: ";;.cmd;" }, () => null, "win32").source,
      ).toBe("path");
    });
  });

  describe("inferOcrInstallChannel：那份是谁装上的", () => {
    it("真身在 Cellar 下 ⇒ brew", () => {
      expect(
        inferOcrInstallChannel(
          makeNestedFile(["opt", "homebrew", "Cellar", "open-code-review", "1.13.0", "bin", "ocr"]),
        ),
      ).toBe("brew");
    });

    it("真身在 node_modules 下 ⇒ npm（nvm、brew 装的 node、Windows 的 npm 全局目录都算）", () => {
      expect(
        inferOcrInstallChannel(
          makeNestedFile(["root", ".nvm", "versions", "node", "v24", "lib", "node_modules", "ocr"]),
        ),
      ).toBe("npm");
    });

    it("brew 前缀下的 npm 全局包判 npm：node_modules 先判，否则 homebrew 那段把它抢成 brew", () => {
      // 这条是两条判据的**顺序**测试，不是内容测试：用 brew 装的 node 跑 `npm i -g` 时，
      // 路径同时含 homebrew 与 node_modules。判反了，用户拿到的就是一条动他包管理器的命令。
      expect(
        inferOcrInstallChannel(
          makeNestedFile(["opt", "homebrew", "lib", "node_modules", "@alibaba-group", "ocr.js"]),
        ),
      ).toBe("npm");
    });

    it("bin 目录里那条软链要按真身判：只看链接路径时 brew 与 npm 长得一模一样", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ocr-link-"));
      tempDirs.push(dir);
      const cellar = makeNestedFile([
        "homebrew",
        "Cellar",
        "open-code-review",
        "1.13.0",
        "bin",
        "ocr",
      ]);
      const link = path.join(dir, "ocr");
      await symlink(cellar, link);
      expect(inferOcrInstallChannel(link)).toBe("brew");
    });

    it("两种典型布局都不命中 ⇒ unknown（手工 cp / npx / 别的前缀，不猜）", () => {
      expect(inferOcrInstallChannel(makeNestedFile(["Users", "me", "bin", "ocr"]))).toBe("unknown");
    });

    it("路径已经不在盘上 ⇒ 退回字面值判，不抛", () => {
      // 解不开符号链接这一档在真实机器上是「候选刚被移走」：判据退化成按字面路径读，
      // 结果仍指向正确的装法，而不是因为一次 ENOENT 就没有来源。
      expect(inferOcrInstallChannel("/opt/homebrew/Cellar/open-code-review/9.9.9/bin/ocr")).toBe(
        "brew",
      );
      expect(inferOcrInstallChannel("/Users/me/nowhere/ocr")).toBe("unknown");
    });
  });

  describe("ocrCommandsFor：给人照抄的两条命令", () => {
    it("npm 那条恒带核对版本，且与 install/upgrade 无关（覆盖安装即换版）", () => {
      const npm = `npm i -g @alibaba-group/open-code-review@${EXPECTED_OCR_CLI_VERSION}`;
      expect(ocrCommandsFor("npm", false).npm).toBe(npm);
      expect(ocrCommandsFor("npm", true).npm).toBe(npm);
      expect(ocrCommandsFor("brew", true).npm).toBe(npm);
    });

    it("brew 那条按装没装过换 install/upgrade，但恒不带版本（formula 只有一份 stable）", () => {
      expect(ocrCommandsFor("brew", false).brew).toBe(BREW_INSTALL);
      expect(ocrCommandsFor("brew", true).brew).toBe("brew upgrade open-code-review");
      // 来源判不出来时不赌：`brew upgrade` 对没装过的包名会直接报错，install 才是幂等那条。
      expect(ocrCommandsFor("unknown", true).brew).toBe(BREW_INSTALL);
      expect(ocrCommandsFor("npm", true).brew).toBe(BREW_INSTALL);
    });
  });
});

describe("1.13.3 新增参数：preview / noFilter / scan 开关 / max-git-procs / 路径守卫", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocr-cli-flags-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ocr-cli-outside-"));
  const outsideFile = path.join(outside, "outside.json");

  beforeAll(() => {
    writeFileSync(path.join(root, "rule.json"), "{}");
    writeFileSync(path.join(root, "bg.md"), "# context");
    writeFileSync(path.join(root, "big.md"), Buffer.alloc(300 * 1024));
    writeFileSync(outsideFile, "{}");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("review preview：只带 --preview，不带 --effort；与 resume 互斥", () => {
    const { command } = reviewCmd({ repo: root, preview: true }, "/o");
    expect(command).toContain(" review --audience agent --format json --preview ");
    expect(command).not.toContain("--effort");
    expect(command).toContain("--output '/o'");
    expect(() => reviewCmd({ repo: root, preview: true, resume: "s" }, "/o")).toThrow(
      /preview 不读写会话/u,
    );
    // 预览也可以不落 --output（直连调用方读 stdout）。
    expect(reviewCmd({ repo: root, preview: true }, undefined).command).not.toContain("--output");
  });

  it("review noFilter / maxGitProcs / rule / backgroundFile 透传", () => {
    const { command } = reviewCmd(
      {
        repo: root,
        noFilter: true,
        maxGitProcs: "4",
        rule: "rule.json",
        backgroundFile: "bg.md",
      },
      "/o",
    );
    expect(command).toContain("--no-filter");
    expect(command).toContain("--max-git-procs 4");
    expect(command).toContain("--rule");
    expect(command).toContain("rule.json");
    expect(command).toContain("--background-file");
    expect(command).toContain("bg.md");
  });

  it("scan preview 不带 LLM/provider 参数；scan 的 no-* / resume / maxGitProcs 透传", () => {
    const preview = scanCmd({ repo: root, preview: true, provider: "p" }, "/o").command;
    expect(preview).toContain(" scan --audience agent --format json --preview ");
    expect(preview).not.toContain("--provider");
    expect(() => scanCmd({ repo: root, preview: true, resume: "s" }, "/o")).toThrow(
      /preview 不读写会话/u,
    );
    const normal = scanCmd(
      {
        repo: root,
        noPlan: true,
        noDedup: true,
        noSummary: true,
        resume: "s",
        maxGitProcs: 3,
        rule: "rule.json",
      },
      "/o",
    ).command;
    expect(normal).toContain("--no-plan");
    expect(normal).toContain("--no-dedup");
    expect(normal).toContain("--no-summary");
    expect(normal).toContain("--resume 's'");
    expect(normal).toContain("--max-git-procs 3");
    expect(normal).toContain("--rule");
  });

  it("rule/background-file 只能指向 repo 根内普通文件；越界、目录与超大都拒绝", async () => {
    expect(() => reviewCmd({ repo: root, rule: outsideFile }, "/o")).toThrow(/repo 根目录内/u);
    expect(() => reviewCmd({ repo: root, rule: "big.md" }, "/o")).toThrow(/文件过大/u);
    expect(() => reviewCmd({ repo: root, rule: "." }, "/o")).toThrow(/普通文件/u);
    const link = path.join(root, "escape.json");
    await symlink(outsideFile, link);
    expect(() => reviewCmd({ repo: root, rule: "escape.json" }, "/o")).toThrow(/repo 根目录内/u);
  });

  it("session compare：两个位置参数走 --，缺一/夹带 id 都拒绝", () => {
    const { command } = sessionCmd({
      repo: root,
      action: "compare",
      before: "old",
      after: "new",
    });
    expect(command).toBe(`${OCR} session compare --json --repo '${root}' -- 'old' 'new'`);
    expect(() => sessionCmd({ repo: root, action: "compare", before: "old" })).toThrow(
      /需要同时给出 before 与 after/u,
    );
    expect(() =>
      sessionCmd({ repo: root, action: "compare", before: "old", after: "new", id: "x" }),
    ).toThrow(/不接受 id/u);
    expect(() =>
      sessionCmd({
        repo: root,
        action: "compare",
        before: "old",
        after: "new",
        severity: ["high"],
      }),
    ).toThrow(/不接受 id/u);
    expect(() =>
      sessionCmd({ repo: root, action: "compare", before: "old", after: "new", limit: 3 }),
    ).toThrow(/不接受 id/u);
  });

  it("resolveRepoFile：类型/空串/NUL/根不可读/文件缺失都拒绝；空串在 flag 槽位视为未给", () => {
    expect(() => resolveRepoFile(root, 3, "rule", 1024, zh)).toThrow(/必须是字符串/u);
    expect(() => resolveRepoFile(root, "", "rule", 1024, zh)).toThrow(/文件不存在/u);
    expect(() => resolveRepoFile(root, "a\u0000b", "rule", 1024, zh)).toThrow(/NUL/u);
    expect(() => resolveRepoFile("/no/such/root", "a", "rule", 1024, zh)).toThrow(/根目录不可读/u);
    expect(() => resolveRepoFile(root, "missing.json", "rule", 1024, zh)).toThrow(/文件不存在/u);
    const emptyFlag = reviewCmd({ repo: root, rule: "  " }, "/o").command;
    expect(emptyFlag).not.toContain("--rule");
  });

  it("布尔闸：preview/noFilter 错类型直接拒绝", () => {
    expect(() => reviewCmd({ repo: root, preview: "yes" }, "/o")).toThrow(/preview 必须是布尔值/u);
    expect(() => reviewCmd({ repo: root, noFilter: "true" }, "/o")).toThrow(
      /noFilter 必须是布尔值/u,
    );
  });

  it("session 的推断与互斥分支：compare 推断、list/show 冲突、非法 severity", () => {
    const inferred = sessionCmd({ repo: root, before: "a", after: "b" }).command;
    expect(inferred).toContain("session compare");
    expect(() => sessionCmd({ repo: root, action: "list", before: "a" })).toThrow(
      /before\/after 只适用于/u,
    );
    expect(() => sessionCmd({ repo: root, action: "list", severity: ["high"] })).toThrow(
      /只适用于 action=comments/u,
    );
    expect(() => sessionCmd({ repo: root, action: "comments", id: "s", before: "a" })).toThrow(
      /before\/after 只适用于/u,
    );
    expect(() => sessionCmd({ repo: root, action: "show", id: "s", before: "a" })).toThrow(
      /before\/after 只适用于/u,
    );
    expect(() =>
      sessionCmd({ repo: root, action: "comments", id: "s", severity: ["urgent"] }),
    ).toThrow(/severity 过滤值/u);
    expect(() =>
      sessionCmd({ repo: root, action: "export", output: "/tmp/x", severity: ["high"] }),
    ).toThrow(/只适用于 action=comments/u);
  });

  it("delegate preview/rule 也接受 backgroundFile/rule/maxGitProcs", () => {
    const preview = previewCmd({
      repo: root,
      backgroundFile: "bg.md",
      rule: "rule.json",
      maxGitProcs: 2,
    }).command;
    expect(preview).toContain("--background-file");
    expect(preview).toContain("--rule");
    expect(preview).toContain("--max-git-procs 2");
    const rule = ruleCmd({ repo: root, paths: ["a.ts"], rule: "rule.json" }).command;
    expect(rule).toContain("--rule");
    expect(rule.indexOf("--rule")).toBeLessThan(rule.indexOf(" -- "));
  });

  it("rules check：文件路径走 -- 之后；rule 同样受 repo 根路径闸", () => {
    const { command } = rulesCheckCmd({ repo: root, path: "src/a.ts" });
    expect(command).toBe(`${OCR} rules check --repo '${root}' -- 'src/a.ts'`);
    const withRule = rulesCheckCmd({ repo: root, path: "src/a.ts", rule: "rule.json" }).command;
    expect(withRule).toContain("--rule");
    expect(withRule).toContain("-- 'src/a.ts'");
    expect(() => rulesCheckCmd({ repo: root, path: "" })).toThrow(/path 必填/u);
    expect(() => rulesCheckCmd({ repo: root, path: "src/a.ts", rule: outsideFile })).toThrow(
      /repo 根目录内/u,
    );
    expect(() => rulesCheckCmd({ repo: root, path: 3 })).toThrow(/path 必须是字符串/u);
  });

  it("llm 只读命令：providers / models", () => {
    expect(buildLlmCommand("providers")).toBe(`${OCR} llm providers --color never`);
    expect(buildLlmCommand("models")).toBe(`${OCR} llm models --color never`);
  });

  it("session comments 过滤与 export 输出路径", () => {
    const comments = sessionCmd({
      repo: root,
      action: "comments",
      id: "s1",
      severity: ["HIGH"],
      category: ["bug", "security"],
    }).command;
    expect(comments).toContain("--severity 'high'");
    expect(comments).toContain("--category 'bug,security'");
    expect(comments).toContain("-- 's1'");
    expect(() => sessionCmd({ repo: root, action: "comments", severity: ["high"] })).toThrow(
      /需要同时给出会话 id/u,
    );
    expect(() => sessionCmd({ repo: root, action: "show", id: "s1", severity: ["high"] })).toThrow(
      /只适用于 action=comments/u,
    );
    const exported = sessionCmd({
      repo: root,
      action: "export",
      id: "s1",
      output: "/tmp/review.html",
    }).command;
    expect(exported).toBe(`${OCR} session export --repo '${root}' -o '/tmp/review.html' -- 's1'`);
    expect(() => sessionCmd({ repo: root, action: "export" })).toThrow(/输出路径/u);
    expect(() =>
      sessionCmd({ repo: root, action: "export", output: "/tmp/x", before: "a" }),
    ).toThrow(/不接受 before/u);
    expect(() => sessionCmd({ repo: root, action: "export", output: "/tmp/x", limit: 2 })).toThrow(
      /不接受 before/u,
    );
    // 无 id = 导出最新一场，命令里不应出现位置参数。
    const newest = sessionCmd({ repo: root, action: "export", output: "/tmp/x" }).command;
    expect(newest).toBe(`${OCR} session export --repo '${root}' -o '/tmp/x'`);
  });
});
