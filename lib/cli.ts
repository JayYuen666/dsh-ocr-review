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
// 契约依据（open-codereview.ai/docs，判据以 CLI 侧源码逐条核对）：核对所依据的那一版写在
// EXPECTED_OCR_CLI_VERSION，本注释不重述数字，以免两处各自漂移。
//   - ocr review：workspace（默认）/ commit（-c）/ range（--from/--to）三模式互斥。
//   - ocr scan：--path 逗号分隔；二者都接受 --format/--output/--audience/--exclude。
//   - ocr delegate preview / rule：--format json 机器可读，reviewable_files
//     / groups 结构见 docs。delegate 无 LLM 消耗，秒级返回。
//   - 所有工具统一走 --output <临时文件>：评审 JSON/文本量大，而本包下发给宿主的
//     stdout 上限（STDOUT_MAX_BYTES）会截断，落盘读取可避免「截断当完整」误判
//     （zvec-grep 同款思路）。

import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import {
  assertAbsoluteRoot,
  clampEffort,
  commaList,
  resolveOutputFormat,
  resolveRepoFile,
  shq,
} from "./argv-guard.ts";
import type { ReviewOutputFormat } from "./argv-guard.ts";

/** Homebrew 安装路径（`Cellar` / `Homebrew` 任一段）。 */
const HOMEBREW_PATH = /(?:^|[/\\])(?:Cellar|Homebrew)(?:[/\\]|$)/iu;
/** `ocr` 版本行：`open-code-review v1.13.3`（允许预发布/构建元数据）。 */
const OCR_VERSION =
  /open-code-review\s+v?(?<version>\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/u;

/** `--exclude` 的模式条数上限。**不是审查范围的上限**，只是防一条失控输入把命令串撑爆；
 *  真实使用里几十条就到头，给到 2000 是为了"尽量不截断"——超了会明确告警，不静默丢。 */
const EXCLUDE_LIST_LIMIT = 2000;

/** `--path` 的路径条数上限（同 EXCLUDE_LIST_LIMIT 的取向：够大 + 超限告警）。 */
const PATH_LIST_LIMIT = 2000;

/** `--rule` / `--background-file` 的文件大小上限：规则是检查清单，背景是需求文档。 */
const RULE_FILE_MAX_BYTES = 256 * 1024;
const BACKGROUND_FILE_MAX_BYTES = 1024 * 1024;
const MAX_GIT_PROCS_FLAG = "--max-git-procs";

/** `ocr review|scan|delegate preview` 的背景说明 flag（三处命令构造共用一条）。
 *  pushTextFlag 按 `flag.slice(2)` 反推报错用的参数名，故值必须带 `--` 前缀。 */
const BACKGROUND_FLAG = "--background";

/**
 * 本包的契约是按外部 `ocr` CLI 的哪一版核对的（README 的前置条件、装法建议与工具回显里
 * 的核对提示都读这一枚）。
 *
 * 声明归 package.json 的 `ocrCliVersion`（发布出去的包页面上看得到，用户据此装对应版本），
 * 这里是它在本包代码里的唯一镜像：test/publish-manifest.test.ts 逐字断言两处相等，
 * test/readme-parity.test.ts 再断言两侧 README 写的也是它。三处只有一处是人写的、
 * 靠门禁钉住另两处，就不会出现「README 教用户装 A、代码按 B 校验」这种两边各自自洽的错。
 */
export const EXPECTED_OCR_CLI_VERSION = "1.13.3";

/** 报错用的值形态（永不调用可能被劫持的 toJSON/toString）。host.ts 的入参闸
 *  （effort/wait）复用同一口径，故导出。 */
export function describeValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/** root 解析：显式绝对路径优先；缺失/空串回退到当前会话工作区。
 *
 * 错类型必须抛错，不能落进 fallback：宿主对工具入参零校验（见 `idValue` 的说明），
 * `{repo: 123}` 静默回退成当前会话工作区，等于「调用方明确指定了仓库」被换成另一个
 * 仓库去审，而回执里不会留下任何痕迹。空串/缺省才是「没指定」。 */
export function resolveRoot(
  value: unknown,
  fallback: string | undefined,
  messages: OcrReviewMessages,
): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(
      format(messages.mustBeString, { name: "repo", received: describeValue(value) }),
    );
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return assertAbsoluteRoot(value.trim(), messages);
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return assertAbsoluteRoot(fallback.trim(), messages);
  }
  throw new Error(messages.repoRequiredUnknownWorkspace);
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
  /** 只列文件清单、不调 LLM；与 resume/wait=false 互斥（由 host 前置拒绝）。 */
  preview?: unknown;
  noFilter?: unknown;
  maxGitProcs?: unknown;
  rule?: unknown;
  backgroundFile?: unknown;
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
  /** OCR 原生 --timeout（每组任务分钟数；0 = 不限时，agent.go 里只有 timeout>0 才 WithTimeout）。 */
  timeoutMinutes?: unknown;
  maxTools?: unknown;
  maxTokens?: unknown;
  maxTokensBudget?: unknown;
  /** OCR scan 原生 --provider/--model（shared_flags.go 的 registerScanFlags），与 review 对齐。 */
  provider?: unknown;
  model?: unknown;
  preview?: unknown;
  noPlan?: unknown;
  noDedup?: unknown;
  noSummary?: unknown;
  resume?: unknown;
  maxGitProcs?: unknown;
  rule?: unknown;
  /** 同 ReviewScopeArgs.format：未知来源、白名单钳制。 */
  format?: unknown;
}

export interface BuiltCommand {
  /** 实际执行的命令串（所有用户可控值已 shq 转义）。 */
  command: string;
  /** 命令运行的工作目录（repo 根）。 */
  workdir: string;
}

/** 纯十进制整数的文本形态：数值槽位接受的唯一字符串写法。 */
const DECIMAL_INTEGER_TEXT = /^\d+$/u;

/**
 * 数值槽位的**唯一**取值口：只接受 `number` 与纯十进制数字串，其余一律 null。
 *
 * 为什么单列一份：`Number()` 会把 true 当 1、把 [] 当 0、把 "0x10" 当 16、把 "1e2" 当 100，
 * 于是错类型或怪写法的输入会被静默读成**另一个数**。数值 flag 与 session limit 两处槽位
 * 共用这一条判据，包里就不会存在第二种数值口径（此前 session limit 用 `Number()`，
 * `{limit: "0x10"}` 被读成 16）。
 * 非安全整数（1e300、1e21）与非法形态同样 null，由调用点按各自的范围判据拒绝。
 */
function decimalInteger(value: unknown): number | null {
  const isDecimalText = typeof value === "string" && DECIMAL_INTEGER_TEXT.test(value.trim());
  if (typeof value !== "number" && !isDecimalText) {
    return null;
  }
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : null;
}

/**
 * 数值 flag 忠实透传（桥接层不设钳制——OCR 原生语义：0 = 配置/模板默认或不限，
 * 负数/非整数由 OCR 侧报错，但桥接层先做同源校验给出更早的错误）。
 * value 为 undefined/null 时省略 flag（跟随 OCR flag 默认值）。
 *
 * 注入面：数值经 `String(num)` 落进命令串（不走 shq）。数值 token 结构上不可能带
 * shell 元字符；安全整数经 String() 只产出 `-?[0-9]+`，而 min ≥ 0 挡掉负号。
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
  const num = decimalInteger(value);
  if (num === null || num < min) {
    throw new Error(
      format(messages.intFlagMustBeInt, {
        flag,
        min: String(min),
        received: describeValue(value),
      }),
    );
  }
  parts.push(flag, String(num));
}

/** 布尔 flag：undefined/null 视为 false；其余非布尔值抛错（字符串 "false" 不能当真值）。 */
function boolFlag(value: unknown, name: string, messages: OcrReviewMessages): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(
      format(messages.boolMustBeBoolean, { name, received: describeValue(value) }),
    );
  }
  return value;
}

function pushBoolFlag(
  parts: string[],
  flag: string,
  value: unknown,
  name: string,
  messages: OcrReviewMessages,
): void {
  if (boolFlag(value, name, messages)) {
    parts.push(flag);
  }
}

/** `--rule` / `--background-file`：缺省/空串视为未给；其余交给路径闸（repo 根内普通文件）。 */
function repoFileOf(
  value: unknown,
  repo: string,
  name: string,
  maxBytes: number,
  messages: OcrReviewMessages,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  return resolveRepoFile(repo, value, name, maxBytes, messages);
}

/** 预览与正常审查共用的选择面：exclude、rule、max-git-procs。 */
function selectionFlags(
  args: ReviewScopeArgs | ScanScopeArgs,
  repo: string,
  messages: OcrReviewMessages,
): string[] {
  const parts: string[] = [];
  const excludes = commaList(args.exclude, "exclude", EXCLUDE_LIST_LIMIT, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  const rule = repoFileOf(args.rule, repo, "rule", RULE_FILE_MAX_BYTES, messages);
  if (rule !== null) {
    parts.push("--rule", shq(rule));
  }
  pushIntFlag(parts, MAX_GIT_PROCS_FLAG, args.maxGitProcs, 1, messages);
  return parts;
}

/** 模式参数解析：workspace（默认）/commit/branch 互斥，非法组合与错类型抛错。
 *
 * 互斥判定必须在两个模式分支之前一次做完：若先判 commit（`commit 非空` 时条件
 * 恒真），后面的「branch 与 commit 互斥」就永不可达，`{scope:branch, commit:x}`
 * 会被静默降级成 commit 审查——审错范围却按结论上报。 */
const KNOWN_SCOPES: ReadonlySet<string> = new Set(["workspace", "commit", "branch"]);

/** 与 `scope` 冲突时报告的是哪一种范围参数（两者都没给时返回空串）。 */
function otherScopeOf(commit: string, from: string, to: string): string {
  if (commit !== "") {
    return "commit";
  }
  return from === "" && to === "" ? "" : "from/to";
}

/**
 * `scope` 是**声明**，不是从别的参数反推出来的结论：先按 from/to/commit 推模式再看
 * scope，`{scope:"nope", from:"a", to:"b"}` 会被当成 branch 静默放行，而调用方声明的
 * 范围与真正审的范围不是一回事。
 */
function declaredScopeOf(args: ReviewScopeArgs, messages: OcrReviewMessages): string {
  const scopeName = idValue(args.scope, "scope", messages).toLowerCase();
  if (scopeName === "") {
    return "workspace";
  }
  if (!KNOWN_SCOPES.has(scopeName)) {
    throw new Error(format(messages.unknownScope, { scope: scopeName }));
  }
  return scopeName;
}

function scopeFlags(args: ReviewScopeArgs, messages: OcrReviewMessages): string[] {
  const scope = declaredScopeOf(args, messages);
  const explicit = idValue(args.scope, "scope", messages) !== "";
  const from = idValue(args.from, "from", messages);
  const to = idValue(args.to, "to", messages);
  const commit = idValue(args.commit, "commit", messages);
  // 显式声明 workspace 却给了另一种范围：两个来源互相矛盾，按哪个审都没有正确答案。
  // 缺省（没写 scope）时给 commit 仍是合法用法，所以只拦「显式声明」这一支。
  if (explicit && scope === "workspace") {
    const given = otherScopeOf(commit, from, to);
    if (given !== "") {
      throw new Error(format(messages.scopeMismatch, { scope, given }));
    }
  }
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
  // scope 已在入口处过白名单，走到这里只剩 workspace。
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
 * 注意：ocr 的 --exclude 是 String 类型（实测多个 flag 实例只认最后一个，
 * 逗号分隔才生效）——多值必须合并为一个 flag 逗号连接，绝不能展开多个。
 * resume 不在这里：它与 scope 是互斥语义（workspace 禁恢复），由
 * buildReviewCommand 在拿到 scopeFlags 结果后前置校验。 */
function optionalFlags(args: ReviewScopeArgs, messages: OcrReviewMessages): string[] {
  const parts: string[] = [];
  const excludes = commaList(args.exclude, "exclude", EXCLUDE_LIST_LIMIT, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  pushTextFlag(parts, "--provider", args.provider, messages);
  pushTextFlag(parts, "--model", args.model, messages);
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
 *    （cmd/opencodereview/interrupt.go 的 signal.Notify）会优雅落盘会话清单再退。
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
 * 降级口径：宿主文件沙箱围栏会把进程信息类命令一并 EPERM 拒绝（实测 /bin/ps），于是
 * 一次性探测 ps 与 pgrep 两个可用性（HAVEPS / HAVEPG）。**任一不可用就不挂守护**：原样
 * 跑命令、把进程树交回宿主，并向 stderr 报一次（不是每 2 秒刷屏）。为什么是「整条不挂」
 * 而不是「挂个残缺版」——pgrep 只出现在后代快照 desc() 里，它不可用时 cs 恒空，reap
 * 于是只杀得掉中间 bash 壳，真 ocr 命令与其孙进程全部存活：那不是「少一条看护」，而是
 * 伪装成看护在位却放任进程持续烧 token。
 * 只包 review/scan（分钟级任务）；delegate/session/llm-test 秒级命令不包。
 */
export function wrapWithHostReaper(command: string, messages: OcrReviewMessages): string {
  // reaper 整条链是 POSIX shell：bash 的 trap/作业控制，加上 ps / pgrep / kill 的
  // 进程组语义。Windows 上这三样都不成立（没有 `bash -c` 可言、kill 不认 -TERM
  // 进程组），硬包只会得到 execNotFound 而**不是**任何降级——所以这里按平台闸直接
  // 放行裸命令：不收割，但能跑。前台另有调用方的超时兜底，代价是宿主硬退出后 OCR
  // 可能留一个孤儿（Windows 上 launchd 式的收养本身也不存在）。
  if (process.platform === "win32") {
    return command;
  }
  const inner = [
    // ps 可用性**一次性**探测（实测：宿主文件沙箱围栏下 /bin/ps 被 EPERM 拒绝）。
    // 不探测的代价有两层，且都是静默的：监视循环每 2 秒 fork 一次注定失败的 ps，整场评审
    // 刷满 "Operation not permitted"；更要紧的是 ppid 比对两边都拿到空串、恒成立，于是
    // 「dsh 硬退出 → 守护自杀」这条**本守护的主要目的**其实一直没生效。探测一次把两条路
    // 分开：可用走原口径；不可用退化为纯 kill -0 监视（见下面 while 判据）——少一条看护
    // 好过让恒真判据蒙混过去，两种失效都是静默的，显式分叉才诚实。
    `p0=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' '); [ -n "$p0" ] && HAVEPS=1 || HAVEPS=0`,
    // pgrep 必须单独探：它只出现在后代快照 desc() 里，探不到时 cs 恒空 ⇒ reap 只杀得掉
    // 中间 bash 壳，真命令与孙进程全部存活。探针取 `pgrep -P 1`：PID 1 必然存在，被
    // 沙箱拒绝时退出码非 0，且不受「当前进程恰好没有子进程」干扰。
    `pgrep -P 1 >/dev/null 2>&1 && HAVEPG=1 || HAVEPG=0`,
    // 两者齐备才挂守护；任一不可用就走降级分支：报一次说明后原样跑，把进程树交回宿主。
    `[ "$HAVEPS" = 1 ] && [ "$HAVEPG" = 1 ] || { printf '%s\\n' ${shq(messages.reaperDegraded)} >&2; { ${command} ; }; exit $?; }`,
    `{ ${command} ; } & ocr=$!`,
    // 关键坑（实测）：bash 的 trap/多语句模式下 `bash -c` 对后台 brace group 不做
    // exec 优化——$ocr 是中间 bash 壳，真命令在其子级。只杀 $ocr 会把真命令变成
    // 孤儿（实测泄漏），所以必须整组或递归后代快照。
    `desc() { for k in $(pgrep -P "$1" 2>/dev/null); do desc "$k"; printf '%s ' "$k"; done; }`,
    // 组长判定：生产 detached:true(setsid) 恒为组长，组杀精确覆盖本命令树；
    // 非组长（手测/异常）绝不组杀——否则会误伤宿主组，改用递归后代回退。
    // HAVEPS=0 时 isl 恒假：拿不到 pgid 就不组杀，只走后代回退那一档（宁可漏杀不可误伤）。
    `isl() { [ "$HAVEPS" = 1 ] && [ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$$" ]; }`,
    // 快照 cs 必须在 TERM 之前（后代被收养后 pgrep 断链）。KILL 单遍：KILL 不可
    // 捕获；僵尸是 kill -0 假阳性，循环补杀会死等。自毙（组 KILL）排最后一步：
    // trap 执行中同信号被 POSIX 丢弃，链必须先确保目标全部死亡再自我清场。
    `reap() { cs=$(desc "$ocr"); isl && kill -TERM -- -$$ 2>/dev/null; kill -TERM "$ocr" 2>/dev/null; for c in $cs; do kill -TERM "$c" 2>/dev/null; done; sleep 1; killmPid(){ kill -0 "$1" 2>/dev/null && kill -KILL "$1" 2>/dev/null; }; killmPid "$ocr"; for c in $cs; do killmPid "$c"; done; isl && kill -KILL -- -$$ 2>/dev/null; }`,
    `trap 'reap; exit 143' TERM INT`,
    // HAVEPS=0 时退化为纯 kill -0 监视：判据里的 ps 短路掉，不再每 2 秒 fork 一个注定
    // 失败的 ps。代价是硬退出看护失效（收不到 ppid 变化），换取零噪音与零无谓 fork。
    `while kill -0 "$ocr" 2>/dev/null && { [ "$HAVEPS" = 0 ] || [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = "$p0" ]; }; do sleep 2; done`,
    `kill -0 "$ocr" 2>/dev/null && reap`,
    `wait "$ocr"; exit $?`,
  ].join("; ");
  return `bash -c ${shq(inner)}`;
}

/** 随包 launcher 的绝对路径；依赖不在树里（或入口不在盘上）时给 undefined。
 *  默认实现用 createRequire 以本文件为基准解析**本插件自己**的依赖树，不走宿主 profile
 *  的目录。
 *
 *  本包不再随包分发 `@alibaba-group/open-code-review`：那枚 optionalDependencies 让「装上
 *  本插件」顺带把外部 CLI 拖进 node_modules，而这条绝对路径又比用户自己装在 PATH 上的那份
 *  更先命中，于是用户升级了 CLI、本插件仍在跑随包那一份旧版——卡片报的版本与用户终端里跑的
 *  永远对不上，且没有任何线索指向「有两份」。装法交回用户自选，本函数只作兜底：部署自己把
 *  它放进依赖树时仍然可用，但排在 PATH 之后。做成入参是为了让两条分支在单测里都能构造。 */
export type LauncherLocator = () => string | null;

/** 把说明符解析成绝对路径的口：默认按**本插件自己**的依赖树解析（打包产物 host.js 里
 *  即随包发布的那一份），不走宿主 profile 的目录。做成入参是因为默认那一档的结果取决于
 *  「这台机器装没装」，而这一档的三条分支必须在单测里都可构造。 */
export type SpecifierResolver = (specifier: string) => string;

/** 随包兜底那一份的 package.json 说明符：解析到它才谈得上取它的 bin 入口。 */
const OCR_PACKAGE_JSON = "@alibaba-group/open-code-review/package.json";

function resolveFromOwnTree(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

export function locateLauncher(
  resolveEntry: SpecifierResolver = resolveFromOwnTree,
): string | null {
  let launcher: string | null = null;
  try {
    const entry = resolveEntry(OCR_PACKAGE_JSON);
    const candidate = path.join(path.dirname(entry), "bin", "ocr.js");
    // 走 launcher 的绝对路径而不是 `node <path>`：Electron 宿主里 process.execPath
    // 是 electron 自己，用它去跑脚本会拉起一个 Electron 窗口而不是 Node。
    // launcher 自带 `#!/usr/bin/env node`，直接执行即可（本包目标平台是 POSIX）。
    if (existsSync(candidate)) {
      launcher = candidate;
    }
  } catch {
    // 依赖不在本包的依赖树里：默认安装下这一档恒空（见 LauncherLocator 的说明）。
  }
  return launcher;
}

/** ocr 可执行体的来源：PATH 上用户自装的那份 / 随包 JS 入口（兜底）/ 两处都没有。 */
export type OcrBinarySource = "bundled" | "path" | "none";

/** 外部 CLI 的安装来源：只用来挑一条**对得上号的**换版命令，不参与「能不能跑」的判定。 */
export type OcrInstallChannel = "brew" | "npm" | "unknown";

export interface OcrBinaryStatus {
  readonly source: OcrBinarySource;
  /** 命中的绝对路径；`none` 时缺席。 */
  readonly path?: string;
  /** 命中那份的来源；`none` 时缺席（压根没有候选，谈不上来源）。 */
  readonly channel?: OcrInstallChannel;
}

/** 是不是一个普通文件（PATH 里恰好有个叫 ocr 的目录不算命中）。 */
function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 符号链接解到底。brew 与 npm 全局都在 bin 目录留一条软链，真身分别在 Cellar 与
 * node_modules 下：不解开就只看得到 `…/bin/ocr`，两种装法长得一模一样。
 * 解不开（目标已消失、无权限）就用字面值判——来源最多退化成 `unknown`，
 * 那一条只会让用户看到两条命令，不会报错误的命令。
 */
function realPathOrSelf(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * 从可执行体的位置推断装法。判据只有两条，且都是「真身在哪棵目录树下」这种事实：
 *  - `node_modules` → npm 一类的包管理器装法（`~/.nvm/…/lib/node_modules`、
 *    brew 装的 node 的 `/opt/homebrew/lib/node_modules`、Windows 的 `%APPDATA%\npm\node_modules`）。
 *  - `Cellar` / `homebrew` → formula 装法（Apple Silicon `/opt/homebrew/Cellar`、
 *    Intel `/usr/local/Homebrew/Cellar`、Linuxbrew `/home/linuxbrew/.linuxbrew/Cellar`）。
 * `node_modules` 必须先判：brew 装的 node 把自己装出来的全局包也放在 `<brew 前缀>` 下，
 * 那条路径同时含 homebrew，反过来判就把 npm 装法报成 brew。
 * 两条都不命中就是 unknown（手工 `cp` 到 ~/bin、npx、别的前缀），不猜。
 * @param candidate - 命中的绝对路径。
 * @returns 安装来源。
 */
export function inferOcrInstallChannel(candidate: string): OcrInstallChannel {
  const resolved = realPathOrSelf(candidate);
  if (resolved.includes("node_modules")) {
    return "npm";
  }
  return HOMEBREW_PATH.test(resolved) ? "brew" : "unknown";
}

/** 用户自选的装法偏好：没装时先推哪一条（部署级设置项 `ocrInstallHint`）。 */
export type OcrInstallPreference = "both" | "brew" | "npm";

/** brew 的 formula 名与 npm 的包名不同：formula 不带 scope。 */
const OCR_BREW_FORMULA = "open-code-review";
const OCR_NPM_PACKAGE = "@alibaba-group/open-code-review";

/**
 * 给人照抄的两条命令。两条不对称是有原因的，不是漏写：
 *  - npm 那条恒带版本号（`npm i -g <包名>@<版本>` 覆盖安装即换版），因为本插件的契约
 *    只按 EXPECTED_OCR_CLI_VERSION 那一版核对过，把版本钉住就不会出现「装完才发现对不上」。
 *  - brew 那条不带版本：homebrew/core 只有一份 stable formula，没有 `open-code-review@x.y`
 *    这种版本化 formula，装/升出来就是上游最新。所以它必须和一句「钉不住版本」的说明
 *    一起出现（文案在 lib/messages.ts），不能让用户以为 `brew install` 得到的是这一版。
 * @param channel - 已命中那份的来源；没命中时传 "unknown"。
 * @param installed - 是否已有一份候选（决定 brew 那条说 install 还是 upgrade）。
 * @returns 两条命令的字面串。
 */
export function ocrCommandsFor(
  channel: OcrInstallChannel,
  installed: boolean,
): { readonly brew: string; readonly npm: string } {
  return {
    // 已知是 brew 装的且已有一份 ⇒ upgrade；其余一律 install——`brew upgrade` 对没装过的
    // 包名直接报错，而 install 对已装的包是幂等升级，判不出来源时宁可走保守那一条。
    brew:
      channel === "brew" && installed
        ? `brew upgrade ${OCR_BREW_FORMULA}`
        : `brew install ${OCR_BREW_FORMULA}`,
    npm: `npm i -g ${OCR_NPM_PACKAGE}@${EXPECTED_OCR_CLI_VERSION}`,
  };
}

/**
 * 只用文件系统的事实回答：`ocr` 这个候选在哪条路上找得到。
 *
 * 为什么需要：`ocrCommand()` 在两条路都没有候选时**假设** PATH 上有裸 `ocr`，而这个假设
 * 过去只有等子进程 exit 127 才暴露——用户看到的是「ocr 命令不存在」而不是「哪条路都
 * 没找到」。本函数给设置页的状态行与工具的前置短路同一个可先问的判据。
 *
 * 口径：
 *  - PATH 先、随包入口后：用户在终端里 `which ocr` 看到的那一份，就是本插件跑的与卡片
 *    报的那一份。两处顺序一致是这条功能最基本的诚实性要求。
 *  - 只回答「找不找得到」，不回答「跑不跑得起来」：丢执行位、入口是符号链接指向空缺
 *    这类事实在真实 spawn 那一侧由子进程自己报（比 fs 侧猜权限准确得多），本判据也不
 *    为此引入 `accessSync` 或 mode 位运算。
 *  - 因此误报方向是安全的：`none` 只在两条路都没有候选文件时给出，而前置短路只认
 *    `none`——不会把一套能跑的环境挡掉。
 *  - Windows 永不报 `bundled`：`ocrCommand()` 在那边刻意跳过随包入口（shebang 脚本
 *    pwsh/cmd 无法直执行），两处口径必须一致，否则状态说可用、命令却走另一条路。
 *  - 「包在但平台二进制缺失」不在这里判——那要读 OCR 自己的内部布局（平台子包名与
 *    bin 文件名），抄进本包就等于养一条随上游漂移的判据；那一档由 launcher 自己那句
 *    `[ERROR] OpenCodeReview binary not found`（exit 1）报出来。
 * @param env - 进程环境（默认生产那一份；单测注入 stub 以构造 PATH 形态）。
 * @param locate - 随包 launcher 的定位口（默认即 `ocrCommand()` 用的那一个）。
 * @param platform - 平台（默认 `process.platform`；单测换成 stub 以覆盖分隔符与后缀）。
 * @returns 来源、命中路径与那份的安装渠道。
 */
export function resolveOcrAvailability(
  env: NodeJS.ProcessEnv = process.env,
  locate: LauncherLocator = locateLauncher,
  platform: NodeJS.Platform = process.platform,
): OcrBinaryStatus {
  const windows = platform === "win32";
  // 空段在 shell 语义里是**当前工作目录**，跟着那条语义走就会把被审查仓库里恰好叫 ocr
  // 的文件报成「PATH 上有」，所以先滤掉再逐段试。
  const dirs = (env["PATH"] ?? env["Path"] ?? "")
    .split(windows ? ";" : ":")
    .filter((dir) => dir !== "");
  const suffixes = windows
    ? [...new Set(["", ...(env["PATHEXT"] ?? "").split(";").filter(Boolean)])]
    : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(dir, `ocr${suffix}`);
      if (isRegularFile(candidate)) {
        return { source: "path", path: candidate, channel: inferOcrInstallChannel(candidate) };
      }
    }
  }
  if (!windows) {
    const launcher = locate();
    if (launcher !== null) {
      return { source: "bundled", path: launcher, channel: inferOcrInstallChannel(launcher) };
    }
  }
  return { source: "none" };
}

/** 进程级记忆槽（默认那一档）：整包共用一次解析结果。 */
const memoBox: { value?: string } = {};

/**
 * 解析出的 `ocr` 命令词（已 shq 转义）：PATH 上用户自装那份的绝对路径，退一步是随包入口
 * 的绝对路径，两处都没有候选时才是裸 `ocr`。
 * 命令词一律取自 `resolveOcrAvailability()`，与设置页状态行、工具前置短路同一份判据——
 * 分成两套就会各说各话：卡片报「PATH 上那份」，实际跑的却是随包那份。
 * 两条路都没有候选时仍交回裸 `ocr` 而不是抛错：装载期不许因为一个外部命令缺席把五个工具
 * 一并拖下线（本包目标平台是 POSIX 优先，Windows 那半见下面）。
 * 惰性求值 + 每进程记忆一次，与 dsh 核心解析 @vscode/ripgrep 同款：解析失败绝不在装载期抛。
 * 导出给同包的命令构造单测——它们按同一个解析结果写期望值，测试与生产同源，
 * 而不是各自把「ocr 还是某个绝对路径」写死一遍。
 * @param locate 随包 launcher 的定位口（默认实现即生产那一档）。
 * @param memo 记忆槽（默认进程级单例；单测传自己的盒以便反复构造两条分支）。
 * @param env 进程环境（默认生产那一份；单测注入 stub 以构造 PATH 形态）。
 */
export function ocrCommand(
  locate: LauncherLocator = locateLauncher,
  memo: { value?: string } = memoBox,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (memo.value === undefined) {
    // Windows 不取绝对路径：`C:\dir\ocr.exe` 这种带反斜杠与空格的词在 cmd 里单引号不是
    // 引号，交回裸 `ocr` 让 shell 自己按 PATHEXT 解析才可靠（与 wrapWithHostReaper/
    // withHomeEnv 的 win32 放行同一口径）。随包 launcher 是 shebang 脚本，pwsh/cmd 也
    // 无法直接执行，故 resolveOcrAvailability 在 Windows 上根本不报 bundled。
    const windows = process.platform === "win32";
    const hit = resolveOcrAvailability(env, locate, process.platform).path;
    memo.value = windows || hit === undefined ? "ocr" : shq(hit);
  }
  return memo.value;
}

/**
 * HOME 重定向：ocrConfigPath 设置项生效的唯一通道。OCR 的 Go 侧全部家目录定位
 * （config、sessions、shell-rc 回退）都走 `os.UserHomeDir()`——Unix 上就是 `$HOME`
 * 环境变量（go doc os.UserHomeDir 原文 "On Unix, including macOS, it returns the
 * $HOME environment variable"），而 config 文件本身没有任何 env/flag 可改
 * （config_cmd.go:92-99 的 defaultConfigPath 是唯一定位，全仓 Getenv 无 config 类
 * 覆盖）。设置项命中 `<X>/.opencodereview/config.json` 布局时，本包把 X 传进来，
 * 在命令串前加 POSIX 赋值前缀 `HOME=<X>`——OCR 及其全部子孙（含 api_key_cmd 起的
 * get-cred）就在重定向后的家目录里读 config、写 sessions，world 自洽。
 *
 * home 为 undefined（默认路径）时不加前缀，命令串一字不动。win32 没有 POSIX
 * 赋值前缀与 HOME 语义（且 resolveOcrConfigPath 对自定义值的布局校验两平台一致），
 * 与 wrapWithHostReaper 同款按平台放行。
 */
export function withHomeEnv(command: string, home: string | undefined): string {
  if (home === undefined || process.platform === "win32") {
    return command;
  }
  return `HOME=${shq(home)} ${command}`;
}

/**
 * `ocr llm test` 命令词（select 的 autoVerify 与卡片「测试连接」共用）。
 * 必须与五个工具走同一个解析源（ocrCommand()）：卡片验的那一份与评审吃的那一份必须是同一
 * 个二进制，否则「测试连接通过」这句回执毫无价值。硬编码裸 `ocr` 在随包兜底装法下还会永远
 * exit 127。`--color` 是 root 持久 flag（color.go:35-39），子命令合法。
 */
export function buildLlmTestCommand(): string {
  return `${ocrCommand()} llm test --color never`;
}

/**
 * `ocr version` 命令词（设置页的状态探测专用）。与五个工具同一个解析源，理由与
 * `llm test` 完全一致；也不套宿主回收守护——它是秒级本地打印，与
 * delegate/session/llm test 同一档（`wrapWithHostReaper` 只管分钟级的 review/scan）。
 */
export function buildVersionCommand(): string {
  return `${ocrCommand()} version`;
}

/**
 * 从 `ocr version` 的回执里取版本号。上游那句自述是 `open-code-review <Version> <os>/<arch>`
 * （`cmd/opencodereview/root.go` 的 versionString），而 `<Version>` 有两种**都在野外**的形态：
 * 上游自己那层 Go 构建把 git tag 整个塞进去、带 `v` 前缀与 commit 段，包管理器装到 PATH 上
 * 那份只有裸数字。上游自己那层 npm 包装的 parseVersionOutput 只认带 `v` 的一种，本包两种都得
 * 读——按包管理器装法的用户按下「检测版本」却看到「没有版本号」，这个功能对他就是失效的。
 * 锚在产品名上而不是「文本里第一个像版本号的串」：launcher 那句升级提示里也带一个版本号，
 * 那是**可用的新版本**而非本机装的这份，抓错就把建议读成了现状。
 * 读不出即 null：未发布构建的 `<Version>` 是 `dev`，没有版本号可报，猜一个等于编一个。
 */
export function parseOcrVersion(text: string): string | null {
  const version = OCR_VERSION.exec(text)?.groups?.["version"];
  return version ?? null;
}

/**
 * `--format` 交给 OCR 的取值：本包只认 json——`lib/parse.ts` 的解析层只解 JSON 一份形状。
 *
 * 白名单（`resolveOutputFormat`）管的是注入面，它放行的 text/sarif 在这里被拒：
 * 那两个值没有下游，交下去只会换回一条「OCR 输出解析失败」，把「参数不在本包支持面内」
 * 说成 OCR 的错。`format` 不在任何工具的 parameters 里，走到这里的只有 PTC/直连调用方。
 */
function jsonOnlyFormat(value: unknown, messages: OcrReviewMessages): ReviewOutputFormat {
  const outputFormat = resolveOutputFormat(value);
  if (outputFormat !== "json") {
    throw new Error(format(messages.formatNotJson, { format: outputFormat }));
  }
  return outputFormat;
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
  const outputFormat = jsonOnlyFormat(args.format, messages);
  const preview = boolFlag(args.preview, "preview", messages);
  const parts: string[] = [ocrCommand(), "review", "--audience", "agent", "--format", outputFormat];
  const resume = idValue(args.resume, "resume", messages);
  if (preview) {
    if (resume !== "") {
      throw new Error(messages.previewRejectsResume);
    }
    parts.push("--preview", ...scopeFlags(args, messages), ...selectionFlags(args, repo, messages));
    if (outputPath !== undefined) {
      parts.push("--output", shq(outputPath));
    }
    return { command: parts.join(" "), workdir: repo };
  }
  // auto = 不传 --effort：让 OCR 自己的 config 决定；缺省仍按 medium（保持 CLI 直调契约）。
  const effort = clampEffort(args.effort, "medium");
  if (effort !== "auto") {
    parts.push("--effort", effort);
  }
  pushIntFlag(parts, "--concurrency", args.concurrency, 1, messages);
  pushIntFlag(parts, "--timeout", args.timeoutMinutes, 0, messages);
  pushIntFlag(parts, "--max-tools", args.maxTools, 0, messages);
  pushIntFlag(parts, "--max-tokens", args.maxTokens, 0, messages);
  pushIntFlag(parts, "--max-tokens-budget", args.maxTokensBudget, 0, messages);
  const scopeParts = scopeFlags(args, messages);
  parts.push(...scopeParts, ...optionalFlags(args, messages));
  pushBoolFlag(parts, "--no-filter", args.noFilter, "noFilter", messages);
  const rule = repoFileOf(args.rule, repo, "rule", RULE_FILE_MAX_BYTES, messages);
  if (rule !== null) {
    parts.push("--rule", shq(rule));
  }
  const backgroundFile = repoFileOf(
    args.backgroundFile,
    repo,
    "backgroundFile",
    BACKGROUND_FILE_MAX_BYTES,
    messages,
  );
  if (backgroundFile !== null) {
    parts.push("--background-file", shq(backgroundFile));
  }
  pushIntFlag(parts, MAX_GIT_PROCS_FLAG, args.maxGitProcs, 1, messages);
  if (resume !== "") {
    // OCR 契约：workspace 模式禁 resume（"resume requires --from/--to or --commit"，
    // registerReviewFlags 的 --resume；review_cmd.go:364-366）。scopeFlags 返回空 = workspace，
    // 此时带 resume 只会烧一次进程启动才拿到英文报错——前置拦下。
    if (scopeParts.length === 0) {
      throw new Error(messages.resumeNeedsScope);
    }
    parts.push("--resume", shq(resume));
  }
  if (outputPath !== undefined) {
    parts.push("--output", shq(outputPath));
  }
  return { command: parts.join(" "), workdir: repo };
}

/** 构造 `ocr scan` 命令（无 git diff 的全文件扫描）。
 * 与 review 相同的坑：--path/--exclude 都是 String 类型，多值必须逗号连接
 * （实测多个 flag 实例不生效），绝不能展开多个。
 * outputPath 缺省（后台模式）省略 --output：结果以 OCR 会话记录为准。 */
export function buildScanCommand(
  args: ScanScopeArgs,
  outputPath: string | undefined,
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const outputFormat = jsonOnlyFormat(args.format, messages);
  const preview = boolFlag(args.preview, "preview", messages);
  const resume = idValue(args.resume, "resume", messages);
  if (preview && resume !== "") {
    throw new Error(messages.previewRejectsResume);
  }
  const parts: string[] = [ocrCommand(), "scan", "--audience", "agent", "--format", outputFormat];
  if (preview) {
    parts.push("--preview");
  }
  const paths = commaList(args.path, "path", PATH_LIST_LIMIT, messages);
  if (paths.length > 0) {
    parts.push("--path", shq(paths.join(",")));
  }
  if (!preview) {
    pushTextFlag(parts, "--batch", args.batch, messages);
    pushTextFlag(parts, "--provider", args.provider, messages);
    pushTextFlag(parts, "--model", args.model, messages);
    pushIntFlag(parts, "--concurrency", args.concurrency, 1, messages);
    pushIntFlag(parts, "--timeout", args.timeoutMinutes, 0, messages);
    pushIntFlag(parts, "--max-tools", args.maxTools, 0, messages);
    pushIntFlag(parts, "--max-tokens", args.maxTokens, 0, messages);
    pushIntFlag(parts, "--max-tokens-budget", args.maxTokensBudget, 0, messages);
    pushBoolFlag(parts, "--no-plan", args.noPlan, "noPlan", messages);
    pushBoolFlag(parts, "--no-dedup", args.noDedup, "noDedup", messages);
    pushBoolFlag(parts, "--no-summary", args.noSummary, "noSummary", messages);
    if (resume !== "") {
      parts.push("--resume", shq(resume));
    }
  }
  parts.push(...selectionFlags(args, repo, messages));
  if (!preview) {
    pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  }
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
  backgroundFile?: unknown;
  exclude?: unknown;
  rule?: unknown;
  maxGitProcs?: unknown;
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
  const excludes = commaList(args.exclude, "exclude", EXCLUDE_LIST_LIMIT, messages);
  if (excludes.length > 0) {
    parts.push("--exclude", shq(excludes.join(",")));
  }
  pushTextFlag(parts, BACKGROUND_FLAG, args.background, messages);
  const backgroundFile = repoFileOf(
    args.backgroundFile,
    repo,
    "backgroundFile",
    BACKGROUND_FILE_MAX_BYTES,
    messages,
  );
  if (backgroundFile !== null) {
    parts.push("--background-file", shq(backgroundFile));
  }
  const rule = repoFileOf(args.rule, repo, "rule", RULE_FILE_MAX_BYTES, messages);
  if (rule !== null) {
    parts.push("--rule", shq(rule));
  }
  pushIntFlag(parts, MAX_GIT_PROCS_FLAG, args.maxGitProcs, 1, messages);
  return { command: parts.join(" "), workdir: repo };
}

/** 构造 `ocr delegate rule` 命令（路径为位置参数，逐条 shq 转义）。 */
export function buildDelegateRuleCommand(
  args: { repo: unknown; paths?: unknown; rule?: unknown },
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
  // cobra 实测支持 -- 分隔）。--rule 必须放在 -- 之前，否则会被当成位置参数。
  const parts: string[] = [ocrCommand(), "delegate", "rule", "--format", "json"];
  const rule = repoFileOf(args.rule, repo, "rule", RULE_FILE_MAX_BYTES, messages);
  if (rule !== null) {
    parts.push("--rule", shq(rule));
  }
  parts.push("--", ...paths);
  return { command: parts.join(" "), workdir: repo };
}

/** `ocr rules check <file>`：只做规则解析，不跑 LLM；`path` 是待查询的文件路径。 */
export function buildRulesCheckCommand(
  args: { repo: unknown; path?: unknown; rule?: unknown },
  messages: OcrReviewMessages,
): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const filePath = idValue(args.path, "path", messages);
  if (filePath === "") {
    throw new Error(messages.rulesPathRequired);
  }
  const parts: string[] = [ocrCommand(), "rules", "check", "--repo", shq(repo)];
  const rule = repoFileOf(args.rule, repo, "rule", RULE_FILE_MAX_BYTES, messages);
  if (rule !== null) {
    parts.push("--rule", shq(rule));
  }
  // 位置参数在 -- 之后：文件路径以 '-' 开头时不会被 cobra 当成 flag。
  parts.push("--", shq(filePath));
  return { command: parts.join(" "), workdir: repo };
}

/** `ocr llm providers|models`：只读诊断命令，不需要仓库目录。 */
export function buildLlmCommand(action: "providers" | "models"): string {
  const sub = action === "providers" ? "providers" : "models";
  return `${ocrCommand()} llm ${sub} --color never`;
}

/** `ocr auth status`：卡片只读查询 ChatGPT 登录态。 */
export function buildAuthStatusCommand(): string {
  return `${ocrCommand()} auth status --provider chatgpt --color never`;
}

/** 登录动作保持人工执行（OAuth 要浏览器 + 本地回调），卡片只显示这条命令。 */
export const CHATGPT_LOGIN_COMMAND = "ocr auth login --provider chatgpt";

export interface SessionArgs {
  repo: unknown;
  limit?: unknown;
  /** 查看/评论/导出的目标会话 id（缺省表示 list / export 最新一场）。 */
  id?: unknown;
  before?: unknown;
  after?: unknown;
  severity?: unknown;
  category?: unknown;
  /** export 的 HTML 落盘路径（宿主注入，不是模型参数）。 */
  output?: unknown;
  /** 输出 comments 子命令结构（comments/show/compare/export）。 */
  action?: unknown;
}

/** session 子命令白名单（子命令名裸拼进命令串，只可能是这些字面量）。 */
const SESSION_ACTIONS = ["list", "show", "comments", "compare", "export"] as const;
type SessionAction = (typeof SESSION_ACTIONS)[number];

const SESSION_SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** severity 过滤：大小写归一 + 白名单；未知值报错而不是交给 CLI 返回空集。 */
function severityFilter(value: unknown, messages: OcrReviewMessages): string[] {
  return commaList(value, "severity", SESSION_SEVERITIES.length, messages).map((item) => {
    const lower = item.toLowerCase();
    if (!(SESSION_SEVERITIES as readonly string[]).includes(lower)) {
      throw new Error(format(messages.invalidSeverity, { value: item }));
    }
    return lower;
  });
}

/** session list --limit：缺省 10（OCR 原生默认 20，本包收紧；OCR 的 0=不限在本包
 * 上限 100 下无意义）。显式给出时必须是 1-100 的整数（与工具 description 的承诺
 * 一致），越界/错类型抛错而不是钳制——静默钳到 1 会把「想看更多」的 0 变成
 * 「只看一条」。数字字符串接受（"3"），与 pushIntFlag 的数值槽位同一口径。 */
function sessionLimit(value: unknown, messages: OcrReviewMessages): number {
  if (value === undefined || value === null) {
    return 10;
  }
  // 取值口径与 pushIntFlag 共用同一枚 decimalInteger：数字字符串 "3" 接受，
  // 而 `Number()` 才会放行的 "0x10" / "1e2" 一律抛错（错写法不该被静默读成另一个数）。
  const num = decimalInteger(value);
  if (num === null || num < 1 || num > 100) {
    throw new Error(format(messages.sessionLimitRange, { received: describeValue(value) }));
  }
  return num;
}

interface SessionContext {
  repo: string;
  id: string;
  before: string;
  after: string;
  severities: string[];
  categories: string[];
  hasFilters: boolean;
  limit: unknown;
  output: string;
  messages: OcrReviewMessages;
}

function sessionListParts(ctx: SessionContext): string[] {
  if (ctx.id !== "") {
    throw new Error(ctx.messages.listRejectsId);
  }
  if (ctx.before !== "" || ctx.after !== "") {
    throw new Error(ctx.messages.beforeAfterOnlyForCompare);
  }
  if (ctx.hasFilters) {
    throw new Error(ctx.messages.filtersOnlyForComments);
  }
  return [
    ocrCommand(),
    "session",
    "list",
    "--json",
    "--repo",
    shq(ctx.repo),
    "--limit",
    String(sessionLimit(ctx.limit, ctx.messages)),
  ];
}

function sessionCompareParts(ctx: SessionContext): string[] {
  if (ctx.before === "" || ctx.after === "") {
    throw new Error(ctx.messages.compareNeedsBoth);
  }
  if (ctx.id !== "" || (ctx.limit !== undefined && ctx.limit !== null) || ctx.hasFilters) {
    throw new Error(ctx.messages.compareRejectsArgs);
  }
  // 两个 id 都是位置参数；`--` 挡住以 '-' 开头的选项注入。
  return [
    ocrCommand(),
    "session",
    "compare",
    "--json",
    "--repo",
    shq(ctx.repo),
    "--",
    shq(ctx.before),
    shq(ctx.after),
  ];
}

function sessionExportParts(ctx: SessionContext): string[] {
  if (ctx.before !== "" || ctx.after !== "" || (ctx.limit !== undefined && ctx.limit !== null)) {
    throw new Error(ctx.messages.exportRejectsArgs);
  }
  if (ctx.hasFilters) {
    throw new Error(ctx.messages.filtersOnlyForComments);
  }
  if (ctx.output === "") {
    throw new Error(ctx.messages.exportOutputRequired);
  }
  const parts = [ocrCommand(), "session", "export", "--repo", shq(ctx.repo), "-o", shq(ctx.output)];
  if (ctx.id !== "") {
    parts.push("--", shq(ctx.id));
  }
  return parts;
}

function sessionCommentsParts(ctx: SessionContext): string[] {
  if (ctx.before !== "" || ctx.after !== "") {
    throw new Error(ctx.messages.beforeAfterOnlyForCompare);
  }
  if (ctx.id === "") {
    if (ctx.hasFilters) {
      throw new Error(ctx.messages.filtersNeedId);
    }
    // 与旧行为一致：没有 id 就退回 list，绝不输出空 id 的 comments。
    return sessionListParts({ ...ctx, hasFilters: false });
  }
  const parts = [ocrCommand(), "session", "comments", "--json", "--repo", shq(ctx.repo)];
  if (ctx.severities.length > 0) {
    parts.push("--severity", shq(ctx.severities.join(",")));
  }
  if (ctx.categories.length > 0) {
    parts.push("--category", shq(ctx.categories.join(",")));
  }
  parts.push("--", shq(ctx.id));
  return parts;
}

function sessionShowParts(ctx: SessionContext): string[] {
  if (ctx.before !== "" || ctx.after !== "") {
    throw new Error(ctx.messages.beforeAfterOnlyForCompare);
  }
  if (ctx.hasFilters) {
    throw new Error(ctx.messages.filtersOnlyForComments);
  }
  if (ctx.id === "") {
    return sessionListParts({ ...ctx, hasFilters: false });
  }
  return [ocrCommand(), "session", "show", "--json", "--repo", shq(ctx.repo), "--", shq(ctx.id)];
}

const SESSION_BUILDERS: Record<SessionAction, (ctx: SessionContext) => string[]> = {
  list: sessionListParts,
  compare: sessionCompareParts,
  export: sessionExportParts,
  comments: sessionCommentsParts,
  show: sessionShowParts,
};

function sessionPartsOf(sub: SessionAction, ctx: SessionContext): string[] {
  return SESSION_BUILDERS[sub](ctx);
}

function inferSessionAction(
  requested: SessionAction | undefined,
  ctx: SessionContext,
): SessionAction {
  if (requested !== undefined) {
    return requested;
  }
  if (ctx.before !== "" || ctx.after !== "") {
    return "compare";
  }
  return ctx.id === "" ? "list" : "show";
}

/** 构造 `ocr session list/show/comments/compare/export` 命令（历史评审会话闭环）。 */
export function buildSessionCommand(args: SessionArgs, messages: OcrReviewMessages): BuiltCommand {
  const repo = assertAbsoluteRoot(args.repo, messages);
  const action = idValue(args.action, "action", messages);
  const requested = SESSION_ACTIONS.find((name) => name === action);
  if (action !== "" && requested === undefined) {
    throw new Error(
      format(messages.invalidAction, { action, expected: SESSION_ACTIONS.join("/") }),
    );
  }
  const ctx: SessionContext = {
    repo,
    id: idValue(args.id, "id", messages),
    before: idValue(args.before, "before", messages),
    after: idValue(args.after, "after", messages),
    severities: severityFilter(args.severity, messages),
    categories: commaList(args.category, "category", 50, messages),
    hasFilters: false,
    limit: args.limit,
    output: idValue(args.output, "output", messages),
    messages,
  };
  ctx.hasFilters = ctx.severities.length > 0 || ctx.categories.length > 0;
  const sub = inferSessionAction(requested, ctx);
  const parts = sessionPartsOf(sub, ctx);
  return { command: parts.join(" "), workdir: repo };
}
