// 端到端：**真 `ocr` 二进制**（本机 PATH 上的 open-code-review，免凭据子命令）。
// stub `ocr`（stub-ocr.e2e）按文档契约模仿；这一层用真二进制证「stub 假设 == 真实现」：
// version 形态、delegate rule 的 JSON 结构（schema_version/groups/files）经真解析链、
// session list 的空态、无参调用的真实失败形状。全部免 LLM 凭据；真 CLI 缺席时整组跳过
// （skip 是显式声明的降级，不是悄悄变成通过——判断在 spawn 之前）。
// 本仓的 oxlint 基线禁同步 spawn 与 require 写法，本文件整段豁免并写明理由：被测对象是
// 外部 CLI 的**退出码和字节流**，同步 spawn 加 node:assert 是对这两者最短的验证路径；
// 豁免范围只覆盖本文件，不外溢到别的测试。
/* oxlint-disable node/no-sync -- 要读真实外部 CLI 的字节流：同步 spawn 最短，而且没有并发需求 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseOcrVersion, EXPECTED_OCR_CLI_VERSION } from "../../lib/cli.ts";
import { parseDelegateRules } from "../../lib/parse.ts";

/** 环境：真 CLI 的 `version` 不允许顺带触发自更新，颜色输出也不会混进比对的字节里。 */
const PROBE_ENV = {
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  CLICOLOR: "0",
  OCR_NO_UPDATE: "1",
} as const;

/** spawn 失败时子进程的流在运行期可能为 null，类型上却写成 string；统一按字节读。 */
function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * PATH 上同名文件不等于可用的真 CLI：Windows runner 上命中的候选可能是目录，也可能是
 * 不能直接 CreateProcess 的 `.cmd` shim。后者 `spawnSync` 会回 `error` 且 `stdout/stderr`
 * 为 null，旧的那句随后会在 `.includes` 上抛 TypeError，把「没装 CLI」报成一次失败。
 * 这里只收**普通文件**且 `version` 能真跑通、输出能被本包解析的候选；不满足就按缺席跳过。
 */
function isRunnableRealOcr(candidate: string): boolean {
  if (candidate.includes("dsh-ocr-review")) {
    return false;
  }
  const entry = statSync(candidate, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile()) {
    return false;
  }
  const probe = spawnSync(candidate, ["version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ...PROBE_ENV },
  });
  return (
    probe.error === undefined &&
    probe.status === 0 &&
    parseOcrVersion(readText(probe.stdout)) !== null
  );
}

/** 真 CLI 定位：PATH 逐目录探测，win32 补常见后缀；候选必须真能跑通 `version`。 */
function locateRealOcr(): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return dirs
    .flatMap((dir) => suffixes.map((suffix) => path.join(dir, `ocr${suffix}`)))
    .find((candidate) => isRunnableRealOcr(candidate));
}

const realOcr = locateRealOcr();
/** 真跑一条命令（关闭颜色；退出码取自被测命令本身——管道之后读 $? 是本仓已踩过的坑）。 */
function run(
  args: readonly string[],
  cwd?: string,
  home?: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(realOcr!, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(home === undefined ? {} : { HOME: home, USERPROFILE: home }),
      ...PROBE_ENV,
    },
    timeout: 60_000,
  });
  // spawn 自身失败（EINVAL/ENOENT/EACCES）时 stdout 与 stderr 可能是 null；原样返回会让
  // 断言在 `.includes` 上炸成 TypeError，掩盖真正的原因。统一归一成字符串与可读错误。
  const spawnError =
    result.error === undefined ? "" : `${result.error.name}: ${result.error.message}`;
  const stderr = readText(result.stderr) || spawnError;
  return {
    status: result.status ?? -1,
    stdout: readText(result.stdout),
    stderr,
  };
}

describe.skipIf(realOcr === undefined)("真 ocr 二进制（免凭据子命令）", () => {
  it("version：退出 0，形态被 parseOcrVersion 读出，且与发布契约一致", () => {
    const result = run(["version"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = parseOcrVersion(result.stdout);
    assert.ok(parsed !== null, `真 version 输出读不出版本：${JSON.stringify(result.stdout)}`);
    // 发布契约锚定的版本（package.json ocrCliVersion）与真 CLI 一致。
    assert.equal(
      parsed,
      EXPECTED_OCR_CLI_VERSION,
      `真 CLI ${parsed} ≠ 契约 ${EXPECTED_OCR_CLI_VERSION}`,
    );
  });

  it("delegate rule --format json：真 JSON 经真解析链，groups 带 pattern 与 files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocr-real-delegate-"));
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true });
      writeFileSync(path.join(dir, "src", "a.ts"), "export const value = 1;\n", "utf8");
      // 真 CLI 约束（本机实测）：delegate 的路径解析要求 git 仓库；非 git 目录先报
      // "is not a git repository" 非零退出——这个失败的形状也一并钉住。
      const nonGit = run(["delegate", "rule", "--format", "json", "src/a.ts"], dir);
      assert.notEqual(nonGit.status, 0);
      assert.ok(nonGit.stderr.includes("not a git repository"), nonGit.stderr.slice(0, 120));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const result = run(["delegate", "rule", "--format", "json", "src/a.ts"], dir);
      assert.equal(result.status, 0, result.stderr);
      const parsed = parseDelegateRules(result.stdout);
      assert.equal(parsed.ok, true, "真输出未过本包解析器");
      assert.ok(parsed.groups.length > 0, "真输出至少一个分组");
      for (const group of parsed.groups) {
        assert.equal(typeof group.pattern, "string");
        assert.ok(Array.isArray(group.files));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session list --json：空态退出 0 且可解析（null 或数组），不读用户真实会话", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocr-real-session-"));
    try {
      // HOME 指向空沙箱：OCR 会话库落在用户家目录之外（测试零接触用户数据）。
      const result = run(["session", "list", "--json"], dir, dir);
      assert.equal(result.status, 0, result.stderr);
      const parsed: unknown = JSON.parse(result.stdout.length > 0 ? result.stdout : "null");
      expect(parsed === null || Array.isArray(parsed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无参调用 delegate rule：真实失败形状是非零退出 + 用法说明（stub 假设的对照面）", () => {
    const result = run(["delegate", "rule"]);
    assert.notEqual(result.status, 0, "缺位置参数应当失败");
    assert.ok(
      result.stderr.includes("requires at least 1 argument") ||
        result.stdout.includes("requires at least 1 argument"),
      `真失败形状变了：${result.stderr.slice(0, 120)}`,
    );
  });
});
