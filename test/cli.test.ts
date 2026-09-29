// cli 纯函数测试：命令构造、转义、scope 互斥、注入防线（白名单 + 转义骨架）。
//
// 拒绝理由已随 host 语言走（messages 是 lib/cli.ts 每个函数的最后一个入参）。
// 本文件主体走「host 注入中文那份」的等价路径（断言里的中文串与 i18n 迁移前完全
// 一致），末尾一组用例注入 en 那份，证明同一批校验闸换语言只是换文案、不改判定。
// 取值闸（转义/绝对路径/逗号列表/钳制）按这层边界直接取用 lib/argv-guard.ts，
// 命令构造走 lib/cli.ts——与生产侧的引用关系一致。
import { describe, expect, it } from "vitest";
import {
  shq,
  assertAbsoluteRoot,
  clampEffort,
  clampPositiveInt,
  commaList,
  resolveOutputFormat,
} from "../lib/argv-guard.ts";
import {
  resolveRoot,
  wrapWithHostReaper,
  buildReviewCommand,
  buildScanCommand,
  buildDelegatePreviewCommand,
  buildDelegateRuleCommand,
  buildSessionCommand,
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

/** 降级回落的目标子命令（action=show/comments 缺 id 时命令必须落回这一条）。 */
const SESSION_LIST_CMD = "ocr session list";

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
  args: { repo: unknown; paths?: unknown },
  messages: OcrReviewMessages = zh,
): BuiltCommand => buildDelegateRuleCommand(args, messages);
const sessionCmd = (args: SessionArgs, messages: OcrReviewMessages = zh): BuiltCommand =>
  buildSessionCommand(args, messages);

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
});

describe("assertAbsoluteRoot / resolveRoot", () => {
  it("拒绝相对路径、空值、NUL", () => {
    expect(() => rootOf("relative/path")).toThrow(/绝对路径/u);
    expect(() => rootOf("")).toThrow(/必填/u);
    expect(() => rootOf("a\u0000b")).toThrow(/NUL/u);
  });

  it("接受绝对路径", () => {
    expect(rootOf("/Users/me/repo")).toBe("/Users/me/repo");
  });

  it("显式值优先，空串回退 fallback，都没有时报错", () => {
    expect(rootOfFallback("/a/b", "/work")).toBe("/a/b");
    expect(rootOfFallback("  ", "/work")).toBe("/work");
    expect(() => rootOfFallback(undefined, undefined)).toThrow(/repo 必填/u);
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

describe("wrapWithHostReaper", () => {
  it("外层 bash -c，内部命令完整保留且 ppid 监视在位", () => {
    const wrapped = wrapWithHostReaper("ocr review --audience agent");
    expect(wrapped.startsWith("bash -c '")).toBe(true);
    const inner = unwrapReaper(wrapped);
    expect(inner).toContain("ocr review --audience agent");
    expect(inner).toContain("{ ocr review --audience agent ; } & ocr=$!");
    expect(inner).toContain("p0=$(ps -o ppid= -p $$ | tr -d ' ')");
    expect(inner).toContain("trap 'reap; exit 143' TERM INT");
    expect(inner).toContain('killmPid "$ocr"');
    expect(inner).toContain("isl && kill -KILL -- -$$");
    expect(inner).toContain('wait "$ocr"; exit $?');
  });

  it("原命令含单引号时二次转义，可精确还原（注入防护）", () => {
    const cmd = "ocr review --exclude 'a; rm -rf /' --background 'it''s ok'";
    const wrapped = wrapWithHostReaper(cmd);
    const inner = unwrapReaper(wrapped);
    expect(inner).toContain("{ ocr review --exclude 'a; rm -rf /' --background 'it''s ok' ; }");
  });
});

describe("buildReviewCommand", () => {
  it("workspace 默认形态：--audience agent --format json --output", () => {
    const { command, workdir } = reviewCmd({ repo: "/r" }, "/tmp/out.json");
    expect(workdir).toBe("/r");
    expect(command).toContain("ocr review --audience agent --format json");
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

  it("scan 同样透传 timeout/max-tools/max-tokens/max-tokens-budget（scan_cmd.go:231-236 原生支持）", () => {
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
});

describe("buildSessionCommand", () => {
  it("list 缺省：--json --repo --limit 钳制", () => {
    const { command } = sessionCmd({ repo: "/r" });
    expect(command).toContain("ocr session list --json");
    expect(command).toContain("--repo '/r' --limit 10");
  });

  it("id 存在 → show；action=comments → comments", () => {
    expect(sessionCmd({ repo: "/r", id: "abc" }).command).toContain(
      "ocr session show --json --repo '/r' 'abc'",
    );
    expect(sessionCmd({ repo: "/r", action: "comments", id: "abc" }).command).toContain(
      "ocr session comments --json --repo '/r' 'abc'",
    );
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
    expect(command).toContain("ocr delegate preview --format json");
    expect(command).toContain("--from 'main' --to 'f'");
  });

  it("rule：位置参数逐条转义、-- 分隔防 dash 开头", () => {
    const { command } = ruleCmd({ repo: "/r", paths: ["-weird.ts", "src/a.ts"] });
    expect(command).toContain("ocr delegate rule --format json -- '-weird.ts' 'src/a.ts'");
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
      expect(review).toContain("--format json");
      expect(scan).toContain("--format json");
      expect(review).not.toContain("touch");
      expect(skeleton(review)).not.toMatch(METACHARS);
      expect(skeleton(scan)).not.toMatch(METACHARS);
    }
    // 非字符串同样进不了命令串
    expect(resolveOutputFormat({ toString: () => "text" })).toBe("json");
    expect(resolveOutputFormat(42)).toBe("json");
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
      // exclude/provider/model/resume/output）。少一个引号段就意味着裸拼接。
      expect(stripped.split("⟦Q⟧").length - 1).toBe(7);
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
      expect(stripped.split("⟦Q⟧").length - 1).toBe(5);
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
      const wrapped = wrapWithHostReaper(command);
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
    expect(listOf(["a", "b"], "path", 1)).toStrictEqual(["a"]);
  });

  it("session action 白名单、id 类型严格", () => {
    expect(() => sessionCmd({ repo: "/r", action: "rm -rf /" })).toThrow(/action 非法/u);
    expect(() => sessionCmd({ repo: "/r", id: 9 })).toThrow(/id 必须是字符串/u);
    expect(sessionCmd({ repo: "/r", action: "list", id: "abc" }).command).toContain(
      "ocr session show",
    );
  });
});

describe("clampPositiveInt（session --limit 的钳制：所有数值槽位都不裸拼）", () => {
  it("非数/非安全整数回退，越界钳到区间端点", () => {
    expect(clampPositiveInt(undefined, 10, 1, 100)).toBe(10);
    expect(clampPositiveInt(null, 10, 1, 100)).toBe(10);
    expect(clampPositiveInt("abc", 10, 1, 100)).toBe(10);
    expect(clampPositiveInt(1.5, 10, 1, 100)).toBe(10);
    expect(clampPositiveInt(2 ** 53, 10, 1, 100)).toBe(10);
    expect(clampPositiveInt("50", 10, 1, 100)).toBe(50);
    expect(clampPositiveInt(0, 10, 1, 100)).toBe(1);
    expect(clampPositiveInt(500, 10, 1, 100)).toBe(100);
  });

  it("limit 进命令串时已是纯数字", () => {
    expect(sessionCmd({ repo: "/r", limit: 500 }).command).toContain("--limit 100");
    expect(sessionCmd({ repo: "/r", limit: "3" }).command).toContain("--limit 3");
  });
});

describe("scope 组合：branch 先判，commit 非空不再静默吞掉 branch", () => {
  it("scope=branch + commit ⇒ 明确互斥错误（不再降级成 commit 审查）", () => {
    expect(() =>
      reviewCmd({ repo: "/r", scope: "branch", commit: "c", from: "a", to: "b" }, "/o"),
    ).toThrow(/与 commit 互斥/u);
    expect(() => reviewCmd({ repo: "/r", scope: "nope" }, "/o")).toThrow(/未知 scope/u);
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
    expect(sessionCmd({ repo: "/r", id: "s1" }).command).toContain("ocr session show");
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
      "invalid action: rm -rf / (expected list/show/comments)",
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
