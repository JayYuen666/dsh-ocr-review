// lib/cli.ts —— 纯函数：把 ocr_* 工具的入参安全地构造成 ocr CLI 命令。
// 无 ctx、无副作用，可独立单测。防注入两道闸（取值判据全在 lib/argv-guard.ts，
// 本文件只决定哪个槽位喂给它、如何拼进命令）：
//   1. 所有用户可控字符串一律经 shq() 单引号转义；
//   2. 枚举型值（--format / session 子命令）先白名单钳制、未知回默认——
//      转义对「本该只有三个取值」的参数不是修复，白名单才是。
// 错类型的字符串参数（commit/from/to/scope/…）一律抛错：静默回落会扩大审查范围。
// root 只走 workdir 字段（命令不接收 --repo 相对值）或转义后的位置参数。
//
// 文案：拒绝理由（错误摘要）是人读文本，取自 lib/messages.ts，由调用方（host.ts）
// 按官方 locale 偏好注入——messages 一律是**最后一个入参**，本模块仍是纯函数。
// 注入防线与此并行，不受语言影响：拼进 argv 的值全部经 shq()，枚举一律白名单钳制，
// 校验闸的调用位置与抛错先后次序都不因文案迁移而改变。
//
// 契约依据（open-codereview.ai/docs，v1.12.0 实测）：
//   - ocr review：workspace（默认）/ commit（-c）/ range（--from/--to）三模式互斥。
//   - ocr scan：--path 逗号分隔；二者都接受 --format/--output/--audience/--exclude。
//   - ocr delegate preview / rule：--format json 机器可读，reviewable_files
//     / groups 结构见 docs。delegate 无 LLM 消耗，秒级返回。
//   - 所有工具统一走 --output <临时文件>：评审 JSON/文本量大（实测一次
//     effort=low 的评审约 19k input tokens），宿主 stdout 有 400KB 截断上限，
//     落盘读取可避免「截断当完整」误判（zvec-grep 同款思路）。

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import {
  assertAbsoluteRoot,
  clampEffort,
  clampPositiveInt,
  commaList,
  resolveOutputFormat,
  shq,
} from "./argv-guard.ts";

/** `ocr review|scan|delegate preview` 的背景说明 flag（三处命令构造共用一条）。
 *  pushTextFlag 按 `flag.slice(2)` 反推报错用的参数名，故值必须带 `--` 前缀。 */
const BACKGROUND_FLAG = "--background";

/** root 解析：显式绝对路径优先；缺失/空串回退到当前会话工作区。 */
export function resolveRoot(
  value: unknown,
  fallback: string | undefined,
  messages: OcrReviewMessages,
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return assertAbsoluteRoot(value.trim(), messages);
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return assertAbsoluteRoot(fallback.trim(), messages);
  }
  throw new Error(messages.repoRequiredUnknownWorkspace);
}

/** 报错用的值形态（永不调用可能被劫持的 toJSON/toString）。 */
function describeValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/** 字符串标量参数：键存在即必须是字符串。
 *
 * 为什么拒绝而不是忽略：宿主对工具入参零校验（dsh tools index.ts
 * `execute(exec.arguments, exec)` 原样下发、schema 只发给模型），错类型一旦
 * 被「当作缺省」就会静默改变语义——实测 `{commit: 12345}` 无 scope 时退化成
 * workspace 审查并把结果当 verdict 报给用户（审查范围被静默扩大）。空串按
 * 缺省处理（与既有语义一致）。 */
function idValue(value: unknown, name: string, messages: OcrReviewMessages): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(format(messages.mustBeString, { name, received: describeValue(value) }));
  }
  const trimmed = value.trim();
  if (trimmed.includes("\u0000")) {
    throw new Error(format(messages.noNulBytes, { name }));
  }
  return trimmed;
}

export interface ReviewScopeArgs {
  repo: unknown;
  scope?: unknown;
  from?: unknown;
  to?: unknown;
  commit?: unknown;
  effort?: unknown;
  background?: unknown;
  exclude?: unknown;
  concurrency?: unknown;
  timeoutMinutes?: unknown;
  maxTools?: unknown;
  maxTokens?: unknown;
  /** 全运行 token 预算（input+output）闸门，超出即停止派发。 */
  maxTokensBudget?: unknown;
  provider?: unknown;
  model?: unknown;
  resume?: unknown;
  /** 未知来源值：调用方（host.ts 直接 spread 模型入参）可塞任意类型，故按
   *  未知声明、由 resolveOutputFormat 白名单钳制。 */
  format?: unknown;
}

export interface ScanScopeArgs {
  repo: unknown;
  path?: unknown;
  background?: unknown;
  exclude?: unknown;
  batch?: unknown;
  concurrency?: unknown;
  /** OCR 原生 --timeout（每组任务分钟数；0 = 不限时，源码 agent.go:750 仅 timeout>0 才 WithTimeout）。 */
  timeoutMinutes?: unknown;
  maxTools?: unknown;
  maxTokens?: unknown;
  maxTokensBudget?: unknown;
  /** 同 ReviewScopeArgs.format：未知来源、白名单钳制。 */
  format?: unknown;
}

export interface BuiltCommand {
  /** 实际执行的命令串（所有用户可控值已 shq 转义）。 */
  command: string;
  /** 命令运行的工作目录（repo 根）。 */
  workdir: string;
}

/**
 * 数值 flag 忠实透传（桥接层不设钳制——OCR 原生语义：0 = 配置/模板默认或不限，
 * 负数/非整数由 OCR 侧报错，但桥接层先做同源校验给出更早的错误）。
 * value 为 undefined/null 时省略 flag（跟随 OCR flag 默认值）。
 *
 * 注入面：数值经 `String(num)` 落进命令串（不走 shq）。Number.isInteger 对
 * 1e21 为 true 而 String() 会写成 `1e+21`，故再加一道「只含数字」的形态校验：
 * 命令串里的数值 token 结构上不可能带 shell 元字符。
 */
function pushIntFlag(
  parts: string[],
  flag: string,
  value: unknown,
  min: number,
  messages: OcrReviewMessages,
): void {
  if (value === undefined || value === null) {
    return;
  }
  const num = typeof value === "number" ? value : Number(value);
  const text = String(num);
  if (!Number.isInteger(num) || num < min || !/^\d+$/u.test(text)) {
    throw new Error(
      format(messages.intFlagMustBeInt, {
        flag,
        min: String(min),
        received: describeValue(value),
      }),
    );
  }
  parts.push(flag, text);
}

/** 模式参数解析：workspace（默认）/commit/branch 互斥，非法组合与错类型抛错。
 *
 * 互斥判定必须在两个模式分支之前一次做完：若先判 commit（`commit 非空` 时条件
 * 恒真），后面的「branch 与 commit 互斥」就永不可达，`{scope:branch, commit:x}`
 * 会被静默降级成 commit 审查——审错范围却按结论上报。 */
function scopeFlags(args: ReviewScopeArgs, messages: OcrReviewMessages): string[] {
  const scopeName = idValue(args.scope, "scope", messages).toLowerCase();
  const scope = scopeName === "" ? "workspace" : scopeName;
  const from = idValue(args.from, "from", messages);
  const to = idValue(args.to, "to", messages);
  const commit = idValue(args.commit, "commit", messages);
  const wantsBranch = scope === "branch" || from !== "" || to !== "";
  const wantsCommit = scope === "commit" || commit !== "";
  if (wantsBranch && wantsCommit) {
    throw new Error(messages.scopeBranchCommitExclusive);
  }
  if (wantsBranch) {
    if (from === "" || to === "") {
      throw new Error(messages.branchNeedsFromAndTo);
    }
    return ["--from", shq(from), "--to", shq(to)];
  }
  if (wantsCommit) {
    if (scope === "commit" && commit === "") {
      throw new Error(messages.commitNeedsValue);
    }
    return ["--commit", shq(commit)];
  }
  if (scope !== "workspace") {
    throw new Error(format(messages.unknownScope, { scope }));
  }
  return [];
}

/** 可选文本 flag：值缺省/空串则省略，错类型抛错（静默丢弃等于悄悄改变语义）。 */
function pushTextFlag(
  parts: string[],
  flag: string,
  value: unknown,
  messages: OcrReviewMessages,
): void {
  const text = idValue(value, flag.slice(2), messages);
  if (text !== "") {
    parts.push(flag, shq(text));
  }
}

/** --exclude/--background/--provider/--model 等通用 flag。
 * 注意：ocr 的 --exclude 是 String 类型（实测 v1.12.0 多 flag 实例只认最后一个，
 * 逗号分隔才生效）——多值必须合并为一个 flag 逗号连接，绝不能展开多个。
 */
function optionalFlags(args: ReviewScopeArgs, messages: OcrReviewMessages): string[] {
  const parts: string[] = [];
  const excludes = commaList(args.exclude, "exclude", 50, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  pushTextFlag(parts, "--provider", args.provider, messages);
  pushTextFlag(parts, "--model", args.model, messages);
  pushTextFlag(parts, "--resume", args.resume, messages);
  return parts;
}

/**
 * 宿主回收守护：把 review/scan 长命令包进 `bash -c`，保证 dsh 进程以任何方式
 * 退出时 OCR 都不会变成孤儿继续跑（用户要求：dsh 彻底退出 → OCR 必须结束）。
 *
 * 为什么需要：macOS 上 dsh 硬退出（kill -9/崩溃）后，detached 子进程被 launchd
 * 收养——subprocess-local 源码自述 "macOS has no supported persistent
 * process-range owner"，只能由进程自己看护自己。
 *
 * 两层互补：
 *  - 优雅退出（exit 命令 / Ctrl+C / SIGTERM）：宿主 teardown 向组发 TERM，
 *    守护的 `trap 'reap; exit 143' TERM INT` 收到后转发 reap。（bash 语义坑：
 *    reap 自毙后 trap 里的 exit 不会执行，所以 reap 必须自带完整链——TERM→宽限
 *    →补 KILL 全部目标，自我清场的组 KILL 排在最后一步。）
 *  - 硬退出：守护随 launchd 收养后 ppid 改变，监视循环探测 ppid != 初始值 →
 *    reap 后退出。TERM 先行是因 OCR 原生 signal.Notify
 *    （cmd/opencodereview/interrupt.go:48）会优雅落盘会话清单再退。
 *
 * 组语义：dsh shell runner 以 detached:true（setsid）启动 `bash -c <cmd>`，
 * 守护即组长，`kill -- -$$` 覆盖组内任意深度后代；守护另有组长判定，非组长
 * （手测/异常）绝不发起组杀（防误伤宿主组），改走「$ocr+递归后代快照」回退。
 *
 * 语义实测（本机 bash 3.2，均为源码模板逐字提取的产物）：
 *  - stdio 与退出码透传（OUT/ERR/rc=7），正常退出路径绝不触发 reap；
 *  - 组长场景（detached 复刻 runner）dsh 硬退出后 +2s：stub 走 trap 优雅收尾、
 *    孙进程随组消亡——只杀 $ocr 与其直接子级会漏孙进程（实测泄漏被收养）；
 *  - 非组长场景守护收 TERM：stub/stub 包装层/孙进程全部消亡。
 * 只包 review/scan（分钟级任务）；delegate/session/llm-test 秒级命令不包。
 */
export function wrapWithHostReaper(command: string): string {
  // reaper 整条链是 POSIX shell：bash 的 trap/作业控制，加上 ps / pgrep / kill 的
  // 进程组语义。Windows 上这三样都不成立（没有 `bash -c` 可言、kill 不认 -TERM
  // 进程组），硬包只会得到 execNotFound 而**不是**任何降级——所以这里按平台闸直接
  // 放行裸命令：不收割，但能跑。前台另有调用方的超时兜底，代价是宿主硬退出后 OCR
  // 可能留一个孤儿（Windows 上 launchd 式的收养本身也不存在）。
  if (process.platform === "win32") {
    return command;
  }
  const inner = [
    `p0=$(ps -o ppid= -p $$ | tr -d ' ')`,
    `{ ${command} ; } & ocr=$!`,
    // 关键坑（实测）：bash 的 trap/多语句模式下 `bash -c` 对后台 brace group 不做
    // exec 优化——$ocr 是中间 bash 壳，真命令在其子级。只杀 $ocr 会把真命令变成
    // 孤儿（实测泄漏），所以必须整组或递归后代快照。
    `desc() { for k in $(pgrep -P "$1" 2>/dev/null); do desc "$k"; printf '%s ' "$k"; done; }`,
    // 组长判定：生产 detached:true(setsid) 恒为组长，组杀精确覆盖本命令树；
    // 非组长（手测/异常）绝不组杀——否则会误伤宿主组，改用递归后代回退。
    `isl() { [ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ]; }`,
    // 快照 cs 必须在 TERM 之前（后代被收养后 pgrep 断链）。KILL 单遍：KILL 不可
    // 捕获；僵尸是 kill -0 假阳性，循环补杀会死等。自毙（组 KILL）排最后一步：
    // trap 执行中同信号被 POSIX 丢弃，链必须先确保目标全部死亡再自我清场。
    `reap() { cs=$(desc "$ocr"); isl && kill -TERM -- -$$ 2>/dev/null; kill -TERM "$ocr" 2>/dev/null; for c in $cs; do kill -TERM "$c" 2>/dev/null; done; sleep 1; killmPid(){ kill -0 "$1" 2>/dev/null && kill -KILL "$1" 2>/dev/null; }; killmPid "$ocr"; for c in $cs; do killmPid "$c"; done; isl && kill -KILL -- -$$ 2>/dev/null; }`,
    `trap 'reap; exit 143' TERM INT`,
    `while kill -0 "$ocr" 2>/dev/null && [ "$(ps -o ppid= -p $$ | tr -d ' ')" = "$p0" ]; do sleep 2; done`,
    `kill -0 "$ocr" 2>/dev/null && reap`,
    `wait "$ocr"; exit $?`,
  ].join("; ");
  return `bash -c ${shq(inner)}`;
}

/**
 * `ocr` 命令词。优先用**随包装上**的 `@alibaba-group/open-code-review` 入口：它经
 * optionalDependencies 带进来（平台二进制再由它自己的 optionalDependencies 选一），
 * 于是「装上本插件 = 工具可用」，不必用户自己再 brew/npm i -g 一遍。
 * 解析不到（平台二进制装不上、或部署刻意不随包分发）就回落到 PATH 上的裸 `ocr`，
 * 与本包一直以来的形态完全一致——两种装法都继续支持。
 *
 * 惰性求值 + 每进程记忆一次，与 dsh 核心解析 @vscode/ripgrep 同款：解析失败绝不在
 * 装载期抛，否则整包会因为一个可选二进制而下线。
 */
/** 随包 launcher 的绝对路径；依赖缺席（或入口不在盘上）时给 undefined。
 *  默认实现用 createRequire 以本文件为基准解析**本插件自己**的依赖树（打包产物
 *  host.js 里即随包发布的那个），不走宿主 profile 的目录。做成入参是为了让回落那一档
 *  在单测里可构造——它平时只在「部署刻意不随包分发」时才发生。 */
export type LauncherLocator = () => string | null;

export function locateLauncher(): string | null {
  let launcher: string | null = null;
  try {
    const entry = createRequire(import.meta.url).resolve(
      "@alibaba-group/open-code-review/package.json",
    );
    const candidate = path.join(path.dirname(entry), "bin", "ocr.js");
    // 走 launcher 的绝对路径而不是 `node <path>`：Electron 宿主里 process.execPath
    // 是 electron 自己，用它去跑脚本会拉起一个 Electron 窗口而不是 Node。
    // launcher 自带 `#!/usr/bin/env node`，直接执行即可（本包目标平台是 POSIX）。
    if (existsSync(candidate)) {
      launcher = candidate;
    }
  } catch {
    // 依赖缺席（optionalDependencies 没装上）：留在 PATH 那一档。
  }
  return launcher;
}

/** 进程级记忆槽（默认那一档）：整包共用一次解析结果。 */
const memoBox: { value?: string } = {};

/** 解析出的 `ocr` 命令词（已 shq 转义）：随包入口的绝对路径，或 PATH 上的裸 `ocr`。
 *  惰性求值 + 每进程记忆一次，与 dsh 核心解析 @vscode/ripgrep 同款：解析失败绝不在
 *  装载期抛，否则整包会因为一个可选二进制而下线。
 *  导出给同包的命令构造单测——它们按同一个解析结果写期望值，测试与生产同源，
 *  而不是各自把「ocr 还是某个绝对路径」写死一遍。
 * @param locate 随包 launcher 的定位口（默认实现即生产那一档）。
 * @param memo 记忆槽（默认进程级单例；单测传自己的盒以便反复构造两条分支）。
 */
export function ocrCommand(
  locate: LauncherLocator = locateLauncher,
  memo: { value?: string } = memoBox,
): string {
  if (memo.value === undefined) {
    const launcher = locate();
    memo.value = launcher === null ? "ocr" : shq(launcher);
  }
  return memo.value;
}

/**
 * 构造 `ocr review` 命令。--output 固定为调用方给定的临时文件路径（防截断），
 * --audience agent --format json 是默认（结构化、无进度行）。
 * outputPath 缺省（后台模式）省略 --output：结果以 OCR 会话记录为准。
 * 返回裸命令；宿主回收守护由调用方（host.ts）在执行点套 wrapWithHostReaper。
 */
export function buildReviewCommand(
  args: ReviewScopeArgs,
  outputPath: string | undefined,
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const parts: string[] = [
    ocrCommand(),
    "review",
    "--audience",
    "agent",
    "--format",
    resolveOutputFormat(args.format),
  ];
  const effort = clampEffort(args.effort, "medium");
  parts.push("--effort", effort);
  pushIntFlag(parts, "--concurrency", args.concurrency, 1, messages);
  pushIntFlag(parts, "--timeout", args.timeoutMinutes, 0, messages);
  pushIntFlag(parts, "--max-tools", args.maxTools, 0, messages);
  pushIntFlag(parts, "--max-tokens", args.maxTokens, 0, messages);
  pushIntFlag(parts, "--max-tokens-budget", args.maxTokensBudget, 0, messages);
  parts.push(...scopeFlags(args, messages), ...optionalFlags(args, messages));
  if (outputPath !== undefined) {
    parts.push("--output", shq(outputPath));
  }
  return { command: parts.join(" "), workdir: repo };
}

/** 构造 `ocr scan` 命令（无 git diff 的全文件扫描）。
 * 与 review 相同的坑：--path/--exclude 都是 String 类型，多值必须逗号连接
 * （实测 v1.12.0：多 flag 实例不生效），绝不能展开多个。
 * outputPath 缺省（后台模式）省略 --output：结果以 OCR 会话记录为准。 */
export function buildScanCommand(
  args: ScanScopeArgs,
  outputPath: string | undefined,
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const parts: string[] = [
    ocrCommand(),
    "scan",
    "--audience",
    "agent",
    "--format",
    resolveOutputFormat(args.format),
  ];
  const paths = commaList(args.path, "path", 100, messages);
  if (paths.length > 0) {
    parts.push("--path", shq(paths.join(",")));
  }
  const excludes = commaList(args.exclude, "exclude", 50, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  pushTextFlag(parts, "--batch", args.batch, messages);
  pushIntFlag(parts, "--concurrency", args.concurrency, 1, messages);
  pushIntFlag(parts, "--timeout", args.timeoutMinutes, 0, messages);
  pushIntFlag(parts, "--max-tools", args.maxTools, 0, messages);
  pushIntFlag(parts, "--max-tokens", args.maxTokens, 0, messages);
  pushIntFlag(parts, "--max-tokens-budget", args.maxTokensBudget, 0, messages);
  pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  if (outputPath !== undefined) {
    parts.push("--output", shq(outputPath));
  }
  return { command: parts.join(" "), workdir: repo };
}

export interface DelegatePreviewArgs {
  repo: unknown;
  scope?: unknown;
  from?: unknown;
  to?: unknown;
  commit?: unknown;
  background?: unknown;
  exclude?: unknown;
}

/** 构造 `ocr delegate preview` 命令（只列文件清单，不跑 LLM）。 */
export function buildDelegatePreviewCommand(
  args: DelegatePreviewArgs,
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const scopeArgs: ReviewScopeArgs = { ...args, format: "json" };
  const parts: string[] = [
    ocrCommand(),
    "delegate",
    "preview",
    "--format",
    "json",
    ...scopeFlags(scopeArgs, messages),
  ];
  const excludes = commaList(args.exclude, "exclude", 50, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  return { command: parts.join(" "), workdir: repo };
}

/** 构造 `ocr delegate rule` 命令（路径为位置参数，逐条 shq 转义）。 */
export function buildDelegateRuleCommand(
  args: { repo: unknown; paths?: unknown },
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  // commaList 已保证「数组元素必须是字符串」+ NUL 检查（错类型不再被静默丢弃：
  // 少一个路径 = 少审一个文件，结果却以「全部已审」口径报告）。
  const paths = commaList(args.paths, "paths", 200, messages).map((filePath) => shq(filePath));
  if (paths.length === 0) {
    throw new Error(messages.pathsRequired);
  }
  // 位置参数以 -- 分隔，避免路径以 '-' 开头被当 flag（clap 同 zvec-grep 处理，
  // cobra 实测支持 -- 分隔）。
  const parts: string[] = [ocrCommand(), "delegate", "rule", "--format", "json", "--", ...paths];
  return { command: parts.join(" "), workdir: repo };
}

export interface SessionArgs {
  repo: unknown;
  limit?: unknown;
  /** 查看/评论的目标会话 id（缺省表示仅 list）。 */
  id?: unknown;
  /** 输出 comments 子命令结构（comments/show）。 */
  action?: unknown;
}

/** session 子命令白名单（子命令名裸拼进命令串，只可能是这三个字面量）。 */
const SESSION_ACTIONS = ["list", "show", "comments"] as const;
type SessionAction = (typeof SESSION_ACTIONS)[number];

/** 构造 `ocr session list/show/comments` 命令（历史评审会话闭环，Json 输出）。 */
export function buildSessionCommand(args: SessionArgs, messages: OcrReviewMessages): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const id = idValue(args.id, "id", messages);
  const action = idValue(args.action, "action", messages);
  const requested = SESSION_ACTIONS.find((name) => name === action);
  if (action !== "" && requested === undefined) {
    throw new Error(
      format(messages.invalidAction, { action, expected: SESSION_ACTIONS.join("/") }),
    );
  }
  // action=show/comments 但 id 缺失 → 优雅降级为 list（防御：绝不输出空 id 的 show/comments）。
  let sub: SessionAction;
  if (requested === "comments" || requested === "show") {
    sub = id === "" ? "list" : requested;
  } else {
    sub = id === "" ? "list" : "show";
  }
  const parts: string[] = [ocrCommand(), "session", sub];
  if (sub === "list") {
    parts.push("--json", "--repo", shq(repo));
    const limit = clampPositiveInt(args.limit, 10, 1, 100);
    parts.push("--limit", String(limit));
  } else {
    parts.push("--json", "--repo", shq(repo), shq(id));
  }
  return { command: parts.join(" "), workdir: repo };
}
