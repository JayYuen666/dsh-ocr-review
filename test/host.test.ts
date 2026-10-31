// host.ts 集成测试：注册面 + 7 个工具执行路径 + 9 条 ocrReview Remote 方法。
//
// 关键约束：**绝不触碰外部 ocr 二进制与网络**。shell.execute 全是替身，
// 断言的是「下发给宿主的命令串形态」与「结果映射」；--output 落盘文件由替身按
// 命令里的路径反写（这正是真实 OCR 的契约：exit 0 ⇒ 该路径有 JSON）。
//
// provider 清单与 key 状态同样走替身：本包不读宿主的私有配置文件与凭据文件，
// 宿主替身给出 settings.describe() 的返回值与 ctx.credentials
// 的 describe/resolve 回答。替身的 resolve 返回**明文样本**，用来断言它不会出现在
// 任何 HTTP 回执 / 落盘配置里（官方通道的安全不变式）。
// HOME 指向临时目录之后才 import host.ts：插件按 os.homedir() 派生外部 ocr CLI 的
// 默认配置位置，端点读写的就是那个沙箱路径（含原子写 + .bak 回归）。
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { JobId, JobKind } from "@deepseek-ai/dsh-jobs";
import { SessionId as brandSessionId } from "@deepseek-ai/dsh-session";
import { PI_AI_SETTINGS_VALUE, descriptorsWithValue } from "./fixtures/settings-fixture.ts";
import { MESSAGES } from "../lib/messages.ts";
import { resolveOcrAvailability, EXPECTED_OCR_CLI_VERSION } from "../lib/cli.ts";
import type { OcrAvailabilityProbe } from "../host.ts";
import { OCR_REMOTE_NAMESPACE } from "../lib/remote-shape.ts";
import { shq } from "../lib/argv-guard.ts";

const OCR_DIR_NAME = ".opencodereview";
const OCR_CONFIG_NAME = "config.json";

/**
 * 临时 home 沙箱：宿主侧 `.dsh/` 与外部 ocr CLI 的 `.opencodereview/` 都在这里，
 * 且必须在 `await import("../host.ts")` 之前就位（插件按 os.homedir() 派生配置位置）。
 * @returns 已建好两个子目录的临时 home 根
 */
function makeSandboxHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "ocr-review-host-"));
  mkdirSync(path.join(home, ".dsh"), { recursive: true });
  mkdirSync(path.join(home, OCR_DIR_NAME), { recursive: true });
  return home;
}

const HOME = makeSandboxHome();
process.env["HOME"] = HOME;
// Windows 的 os.homedir() 读 USERPROFILE；host.ts 在导入期按它派生配置位置，两枚都要在
// import 之前指向同一个沙箱，否则那一格会去读 runner 的真实家目录。
process.env["USERPROFILE"] = HOME;

const HOST_MODULE = await import("../host.ts");
const {
  default: plugin,
  apply: applyWithProbe,
  assertOcrPresent,
  createGateway,
  ocrRepo,
  productionProbe,
  requiredKeys,
} = HOST_MODULE;

// host 侧双语：直接被单测调到的两个纯函数按「host 注入哪一份」显式传表，
// 其余文案走 apply 的官方 locale 偏好替身（makeHost({ locale: { preference } })）。
const { zh } = MESSAGES;
const { format } = await import("../lib/messages.ts");

const OCR_CONFIG = path.join(HOME, OCR_DIR_NAME, OCR_CONFIG_NAME);
/** cordis.patch.yml 里本包那一行的裸条目 id（0.1.7 起也就是设置命名空间）。host.ts 里那份
 *  是私有常量，测试侧独立声明：命名空间与 schema 不同源这条判据才拦得住。 */
const PLUGIN_ENTRY_ID = "ocr-review";
/** 官方作业注册表里本包作业的 kind（宿主据此签发的 id 形如 `ocr-review-N`）。与条目 id
 *  同字但是两件事：一位是注册表的分类键，一位是 cordis 装配面的行 id，各自独立漂移。
 *  类型吃官方 `JobKind`（host.ts 的 JobKindMap 合并项）而不是裸字面量：object literal 的
 *  属性类型会被拓宽成 string，`jobs.start(spec)` 那道官方名义闸就白装了。 */
const OCR_JOB_KIND: JobKind = "ocr-review";
/** 明文 key 样本：任何出口（HTTP 回执/工具文本）出现即测试失败。 */
const PLAIN_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";
/** ctx.credentials 替身回答的活 key：同样绝不出宿主。 */
const LIVE_KEY = "sk-live-from-credential-service-0001";
/** fixture 里声明了 apiKeyEnv 的全部 ref（替身默认全都能解析）。 */
const ALL_REFS = ["SENSENOVA_API_KEY", "XKIRO_API_KEY", "AMD_API_KEY", "ANTDIGITAL_API_KEY"];
/** 👨‍👩‍👧‍👦 = 11 枚码元（4 对代理 + 3 枚 ZWJ）。截断用例的切点是照着这个长度算的，
 *  故 ZWJ 写成显式转义而不是裸字符：裸字符会被编辑器/格式化悄悄吃掉，一吃掉长度就
 *  从 11 变 8，切点落回合法配对边界，用例便对着空靶子打还一路绿灯。 */
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";

// ── shell 替身 ──────────────────────────────────────────────────────────────
//
// host.ts 的 shell / webServer / systemPrompt 三个服务面已绑官方声明（`Pick<ShellExecutor,
// "resolve" | "execute">` 等），但官方那三面都是带 private/protected 成员的 `Service` 子类
// → 名义比 → 结构替身根本满足不了整个类类型，故替身经 applyPlugin 的 `as unknown as`
// 边界接进去，只带本包真正读到的那几个字段（result() 交回 ShellRunResult 的子集）。
// 断言的是「下发给宿主的请求形态」与「结果映射」，官方字段一变，编译错误落在 host.ts。

interface RunScript {
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  stdoutText?: string;
  stdoutTruncated?: boolean;
  stdoutSpillPath?: string;
  stderrText?: string;
  stderrTruncated?: boolean;
  /** --output 文件正文：给出即按命令里的路径反写；缺省则不写（ENOENT 分支）。 */
  output?: string;
  /** --output 文件按这个字节数截成**稀疏**文件：造「超上限」那一档而不真写这么多字节。 */
  sparseBytes?: number;
  /** 把 --output 指到一个**目录**：让插件读回落盘结果时抛错（失败路径的降级分支）。 */
  outputDirectory?: boolean;
  /** 前台 result() 直接抛出的值（含非 Error，覆盖 shared 的 errorText 两支）。 */
  throws?: unknown;
}

interface ResolveCall {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  /** 0.1.7 resolve 的宿主 deadline 策略（缺省 'kill'）；后台通道显式取 'none'。 */
  onExpiry?: string;
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
  /** 按调用携带的沙箱策略（官方 `SandboxExecutionPolicy`，手抄形状以免测试引运行期包）。 */
  sandboxPolicy?: { mode: string; workspaceRoot: string };
  /** 按调用携带的普通环境变量（官方 `ShellExecRequest.env`，在凭据净化之后合并）。
   *  状态探测靠它带 `OCR_NO_UPDATE=1`，这条断言就是那道副作用闸门。 */
  env?: Record<string, string>;
}

/** dsh-shell 的非消费按偏移读者（官方作业注册表的 pull source 直接吃它）。 */
interface FakeReader {
  readFrom: (fromByte: number) => { text: string; nextOffset: number; lossy: boolean };
}

interface FakeProc {
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  /** 0.1.7 ShellProcess 的信号名（自然退出为 null）：官方作业 detail 用它。 */
  signal: string | null;
  killCount: number;
  kill: () => boolean;
  done: Promise<void>;
  settle: () => void;
  /** 0.1.7 ShellExecution 的前台投影（旧 run() 的落点）；后台 job 从不 await 它。 */
  result: () => Promise<unknown>;
  /** 往某条流上追加输出（等价于子进程又吐了一段）。 */
  emit: (channel: "stdout" | "stderr", text: string) => void;
  /** 让某条流的读者从此抛错（复刻执行器侧读者坏掉这一档边角）。 */
  failRead: (channel: "stdout" | "stderr") => void;
  /** 某条流的读者被敲了几次——用来证明"坏一次之后就不该再敲"。 */
  readCount: (channel: "stdout" | "stderr") => number;
  observed: { stdout: FakeReader; stderr: FakeReader };
}

/** 会话根归一化那条环境查询（`git rev-parse --show-toplevel`）的命令判据。 */
const GIT_TOPLEVEL_RE = /git\s+rev-parse\s+--show-toplevel/u;

interface FakeShell {
  resolveCalls: ResolveCall[];
  scripts: RunScript[];
  procs: FakeProc[];
  /** 模拟 shell 执行器自己那个 maxTimeoutMs 设置项的宿主上限：resolve 按
   *  min(请求, 上限) 收口（官方 shell 契约：resolve「apply implementation-owned
   *  defaults and caps」）。缺省 = 不设限，替身原样回传。 */
  maxTimeoutMs?: number;
  /** `git rev-parse --show-toplevel` 的应答：字符串 = 顶层在别处；null = 非 git
   *  仓库（exit 128）；缺省 = 原样回显 workdir（该目录本身就是顶层）。 */
  gitTopLevel?: string | null;
  resolve: (spec: ResolveCall) => unknown;
  /** 0.1.7 唯一的执行入口（旧 run/start 合并）：前台取 handle.result()，后台留句柄。 */
  execute: (spec: unknown) => Promise<FakeProc>;
}

/** 从（被宿主回收守护二次转义的）命令串里取 --output 路径。 */
function outputPathOf(command: string): string | undefined {
  const normalized = command.replaceAll(String.raw`'\''`, "'");
  return /--output '(?<path>[^']+)'/u.exec(normalized)?.groups?.["path"];
}

function withResolvers(): { promise: Promise<void>; resolve: () => void } {
  return (
    Promise as unknown as {
      withResolvers: () => { promise: Promise<void>; resolve: () => void };
    }
  ).withResolvers();
}

function deferredProc(result: () => Promise<unknown>): FakeProc {
  const box = withResolvers();
  // 两条流的"已捕获全文"：observed 的读者按 **UTF-8 字节**偏移切，与官方件一致。
  const captured: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const broken: Record<"stdout" | "stderr", boolean> = { stdout: false, stderr: false };
  const reads: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };
  const reader = (channel: "stdout" | "stderr"): FakeReader => ({
    readFrom: (fromByte) => {
      reads[channel] += 1;
      if (broken[channel]) {
        throw new Error("already reaped");
      }
      const bytes = Buffer.from(captured[channel], "utf8");
      const text = bytes.subarray(Math.min(fromByte, bytes.length)).toString("utf8");
      return { text, nextOffset: bytes.length, lossy: false };
    },
  });
  const proc: FakeProc = {
    status: "running",
    exitCode: null,
    signal: null,
    killCount: 0,
    done: box.promise,
    settle: box.resolve,
    result,
    emit: (channel, text) => {
      captured[channel] += text;
    },
    failRead: (channel) => {
      broken[channel] = true;
    },
    readCount: (channel) => reads[channel],
    observed: { stdout: reader("stdout"), stderr: reader("stderr") },
    kill: () => {
      proc.killCount += 1;
      proc.status = "killed";
      return true;
    },
  };
  return proc;
}

/** 官方注册表的宿主默认值（经它自己的 `~standard.validate` 现解，不抄字面量）。 */
interface RegistryDefaults {
  maxConcurrentJobsPerOwner: number;
  retainBytes: number;
  settledRetainBytes: number;
  pumpPollMs: number;
}

/**
 * 宿主装载期怎么解析 `LocalJobRegistry.Config`，这里就怎么取默认值（实测
 * `validate({})` ⇒ `{10, 262144, 16384, 150}`，给部分覆盖会与默认合并）。手抄字面量的毛病
 * 是"抄来的值印证抄来的行为"：宿主改了默认，测试仍绿而真宿主已经变了。
 */
function registryDefaults(row: Partial<RegistryDefaults> = {}): RegistryDefaults {
  const parsed = (
    LocalJobRegistry.Config as unknown as {
      "~standard": {
        validate: (value: unknown) => { issues?: unknown; value: RegistryDefaults };
      };
    }
  )["~standard"].validate(row);
  expect(parsed.issues).toBeUndefined();
  return parsed.value;
}

/** 本仓默认泵拍（宿主是 150ms，实测）：压小它让每条输出用例都真走一遍周期泵。 */
const PUMP_MS = 25;

/** host.ts 的 `OCR_JOB_HISTORY_MAX`：本 kind 在册的已落定记录上限（本包政策，非宿主默认）。 */
const HISTORY_MAX = 10;

/** 官方作业 id 的字形：kind 前缀 + 注册表按 randomUUID 截短的 16 位 hex。
 *  用例靠它钉「宿主换了发号方式我们立刻知道」，而断「哪几条在册」靠
 *  `startBackgroundRuns` 当场交回的 id，不拼字面量。 */
const OCR_JOB_ID = /^ocr-review-[0-9a-f]{16}$/u;

/**
 * 官方注册表的**实现本身**，不是假件：替身若按"我以为的官方语义"写，测的就是我的理解。
 * 真件让"后台评审可被 job_list/job_output/job_kill 观察"这条契约钉在真行为上；
 * 逐条实测语义见 plugins/docs/harness/f3-equiv/probe-jobs.mjs。
 */
function makeJobRegistry(pumpPollMs = PUMP_MS): LocalJobRegistry {
  return new LocalJobRegistry(new Context(), registryDefaults({ pumpPollMs }));
}

/** 官方 `registry.resolveOwner` 读的 agent 注册表面：会话 id → 活 Agent 的 ctx。 */
interface AgentRegistryStub {
  get: (session: string) => { ctx: Context } | undefined;
}

/** 带 agent 注册表的注册表实例：有 owner 的作业要在 start 时查到这条活 Agent。 */
function makeOwnedJobRegistry(agents: AgentRegistryStub): LocalJobRegistry {
  const ctx = new Context();
  ctx.reflect.provide("agents", agents);
  return new LocalJobRegistry(ctx, registryDefaults({ pumpPollMs: PUMP_MS }));
}

/**
 * 评审进行中 `ctx.jobs` 那一行被重载/关掉的那一档：读侧全部转给真件，只有 `kill` 照官方
 * 对陌生 id 的字形抛（dsh-jobs-local 里 `expect` 那一处，文本就是 `unknown job <id>`）。
 * 不复用真注册表来造这一档，是因为"我们不认这条 id"只在**另一枚实例**的名册里成立，
 * 而 `startBackground` 闭包攥着的是起作业那一枚——换 `host.jobs` 换不进闭包，只能在这一位兜一手。
 * @param real 真件（除 kill 外七个方法都原样转给它）
 * @returns 只坏掉 `kill` 的注册表面
 */
function registryWithThrowingKill(real: LocalJobRegistry): LocalJobRegistry {
  return {
    start: (...args: Parameters<LocalJobRegistry["start"]>) => real.start(...args),
    list: () => real.list(),
    get: (...args: Parameters<LocalJobRegistry["get"]>) => real.get(...args),
    kill: () => {
      throw new Error("unknown job ocr-review-0000000000000000");
    },
    remove: (...args: Parameters<LocalJobRegistry["remove"]>) => {
      real.remove(...args);
    },
    wait: (...args: Parameters<LocalJobRegistry["wait"]>) => real.wait(...args),
    attachController: (...args: Parameters<LocalJobRegistry["attachController"]>) =>
      real.attachController(...args),
  } as unknown as LocalJobRegistry;
}

/**
 * 「剪枝时注册表已经不认这批记录」那一档：除 `list` 抛错外全部转给真件
 * （重载/换枚实例之后，startBackground 会在剪枝那一步就撞上）。
 * @param real 真件（除 list 外六个方法原样转给它）
 * @returns 只坏掉 `list` 的注册表面
 */
function registryWithThrowingList(real: LocalJobRegistry): LocalJobRegistry {
  return {
    start: (...args: Parameters<LocalJobRegistry["start"]>) => real.start(...args),
    list: () => {
      throw new Error("registry reloaded");
    },
    get: (...args: Parameters<LocalJobRegistry["get"]>) => real.get(...args),
    kill: (...args: Parameters<LocalJobRegistry["kill"]>) => real.kill(...args),
    remove: (...args: Parameters<LocalJobRegistry["remove"]>) => {
      real.remove(...args);
    },
    wait: (...args: Parameters<LocalJobRegistry["wait"]>) => real.wait(...args),
    attachController: (...args: Parameters<LocalJobRegistry["attachController"]>) =>
      real.attachController(...args),
  } as unknown as LocalJobRegistry;
}

/**
 * 只抄 `wait` 的入参、其余读侧原样转给真件的那一枚注册表面：enforceOcrDeadline
 * 的兜底窗口现来自行 config，测试需要一个不复刻注册表行为就能看到「递了几毫秒」的位置。
 * @param real 真件
 * @returns 替身注册表 + 每次 wait 收到的第二个实参（毫秒，未给时为 undefined）
 */
function registryRecordingWaits(real: LocalJobRegistry): {
  registry: LocalJobRegistry;
  waits: (number | undefined)[];
} {
  const waits: (number | undefined)[] = [];
  const registry = {
    start: (...args: Parameters<LocalJobRegistry["start"]>) => real.start(...args),
    list: () => real.list(),
    get: (...args: Parameters<LocalJobRegistry["get"]>) => real.get(...args),
    kill: (...args: Parameters<LocalJobRegistry["kill"]>) => real.kill(...args),
    remove: (...args: Parameters<LocalJobRegistry["remove"]>) => {
      real.remove(...args);
    },
    wait: (...args: Parameters<LocalJobRegistry["wait"]>) => {
      waits.push(args[1]);
      return real.wait(...args);
    },
    attachController: (...args: Parameters<LocalJobRegistry["attachController"]>) =>
      real.attachController(...args),
  } as unknown as LocalJobRegistry;
  return { registry, waits };
}

/** 等过一拍注册表的周期泵（pull source 的增量是由泵搬进环的，不等它就只测到最后一次排水）。 */
async function pumpTick(): Promise<void> {
  const box = withResolvers();
  setTimeout(box.resolve, PUMP_MS * 3);
  return box.promise;
}

/**
 * 取回本用例那一枚作业的身份。测试替身不保证 list() 非空，判空后抛出比
 * `as never` 断言诚实——它会在契约破掉的第一行就指出是"作业没登记"。
 * @param job 从注册表 list() 出来的可选投影
 * @returns {JobId}
 */
function onlyJob(job: { id: JobId } | undefined): JobId {
  if (job === undefined) {
    throw new Error("作业未登记（ctx.jobs 里没有记录）");
  }
  return job.id;
}

/** 给事件循环一次宏任务：官方落定链（收尾排水 → settle）全在微任务上。 */
async function settledTick(): Promise<void> {
  const gate = (
    Promise as unknown as { withResolvers: () => { promise: Promise<void>; resolve: () => void } }
  ).withResolvers();
  setImmediate(gate.resolve);
  return gate.promise;
}

/**
 * 跑一段并收集这期间冒出来的**未捕获异常**。装监听器不是为了吞掉问题，是为了把它变成
 * 一条可断言的事实：AbortSignal 监听器里抛出的错误由 Node 以
 * `process.nextTick(() => { throw err })` 重抛 ⇒ 未捕获 ⇒ 默认直接终止进程（本机实测
 * EXIT=1）。不装就是整个测试进程跟着宿主一起没，断言都轮不到跑。
 * @param body 要在监视下跑完的段落
 * @returns 该段落期间落到未捕获处理器上的异常
 */
async function collectUncaught(body: () => Promise<void> | void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const capture = (error: unknown): void => {
    seen.push(error);
  };
  process.on("uncaughtException", capture);
  try {
    await body();
    // Node 的重抛排在 nextTick 上，而 nextTick 队列先于宏任务 ⇒ 一次 setImmediate 就够。
    await settledTick();
  } finally {
    process.removeListener("uncaughtException", capture);
  }
  return seen;
}

/**
 * 同 collectUncaught，但收的是**未处理 rejection**：fire-and-forget 的 Promise 漏了
 * catch 时，Node ≥22 默认把它升成未捕获异常并终止宿主进程。这里把它变成一条可断言的
 * 事实，而不是让整个测试进程跟着宿主一起没。
 * @param body 要在监视下跑完的段落
 * @returns 该段落期间落到 unhandledRejection 上的理由
 */
async function collectUnhandledRejections(body: () => Promise<void> | void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const capture = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    await body();
    // 未处理 rejection 在微任务排空后的那一轮才上报，一次 setImmediate 足够。
    await settledTick();
  } finally {
    process.removeListener("unhandledRejection", capture);
  }
  return seen;
}

/**
 * 占桶用的活作业 promise：永不落定 ⇒ 官方件按"未拥有桶里有一条活的"计数，
 * 桶满（实测 10）时新 start 被拒。
 */
async function voidPending(): Promise<never> {
  const box = (
    Promise as unknown as { withResolvers: () => { promise: Promise<never> } }
  ).withResolvers();
  return box.promise;
}

function makeShell(): FakeShell {
  const shell: FakeShell = {
    resolveCalls: [],
    scripts: [],
    procs: [],
    resolve: (spec) => {
      // resolveCalls 的语义是「本包下发给 OCR CLI 的请求形态」，每个既有断言都按这个
      // 读它（索引 0 = 第一个 ocr 调用）。会话根归一化那条 `git rev-parse` 是宿主环境
      // 查询、不是 ocr 调用，另记一笔，免得所有按索引取的断言整体错位。
      if (!GIT_TOPLEVEL_RE.test(spec.command)) {
        shell.resolveCalls.push(spec);
      }
      // 宿主收口：min(请求, shell.maxTimeoutMs)。请求值原样留在 resolveCalls 里
      // （那份断言的是「下发给宿主的请求形态」），收口只体现在回传的 spec 上。
      const cap = shell.maxTimeoutMs;
      if (cap !== undefined && spec.timeoutMs !== undefined && spec.timeoutMs > cap) {
        return { ...spec, timeoutMs: cap };
      }
      return spec;
    },
    // 0.1.7：execute 是前后台唯一入口。分流判据沿用宿主自身的分工——前台带
    // timeoutMs（deadline），后台（wait=false）不带、且从不 await result()。
    // result() 即旧 run() 的落点：脚本队列仍按发起序 shift，抛点与输出落盘都不变。
    async execute(spec) {
      const call = spec as ResolveCall;
      // `git rev-parse --show-toplevel` 是宿主环境查询，不是被测的 ocr 调用：
      // 单独应答、不消费脚本队列，否则每个工具测试的脚本都会错位一格。
      // 缺省（undefined）回显 workdir，即「这个目录本身就是顶层」——既有测试的
      // 既有语义原样保留；给字符串表示顶层在别处；给 null 表示不是 git 仓库。
      if (GIT_TOPLEVEL_RE.test(call.command)) {
        const top = shell.gitTopLevel;
        return deferredProc(async () =>
          top === null
            ? {
                exitCode: 128,
                timedOut: false,
                aborted: false,
                stdout: { text: "", truncated: false },
                stderr: { text: "not a git repository", truncated: false },
              }
            : {
                exitCode: 0,
                timedOut: false,
                aborted: false,
                stdout: { text: top ?? call.workdir ?? "", truncated: false },
                stderr: { text: "", truncated: false },
              },
        );
      }
      const proc = deferredProc(async () => {
        const script = shell.scripts.shift() ?? {};
        if (script.throws !== undefined) {
          // oxlint-disable-next-line typescript/only-throw-error -- 负向用例要的就是非 Error 抛出值：只有它能走通 shared 的 errorText 那条 String(error) 支（真实 shell 服务异常时并不保证抛 Error），换成 new Error(…) 就测不到那一位
          throw script.throws;
        }
        const outPath = outputPathOf(call.command);
        if (outPath !== undefined && script.outputDirectory === true) {
          // 建成目录：后续 readFileSync 会抛 EISDIR，走插件那条「读不到就原样交回」的分支。
          mkdirSync(outPath, { recursive: true });
        }
        if (outPath !== undefined && script.output !== undefined) {
          writeFileSync(outPath, script.output);
        }
        if (outPath !== undefined && script.sparseBytes !== undefined) {
          // 稀疏：只落一页元数据，不真占这么多盘。truncateSync 直接吃路径，
          // 不必为建空文件再开一枚同步 fd。
          writeFileSync(outPath, "");
          truncateSync(outPath, script.sparseBytes);
        }
        return {
          // 显式给了 null 就保留 null：那是「进程被墙钟/信号收走」的真实形状（执行器交回
          // 的 exitCode 本就是 number|null），`?? 0` 会把它糊成一次成功退出，让「超时」那一档
          // 在替身里永远测不到。
          exitCode: script.exitCode === undefined ? 0 : script.exitCode,
          timedOut: script.timedOut ?? false,
          aborted: script.aborted ?? false,
          stdout: {
            text: script.stdoutText ?? "",
            truncated: script.stdoutTruncated ?? false,
            ...(script.stdoutSpillPath === undefined ? {} : { spillPath: script.stdoutSpillPath }),
          },
          stderr: { text: script.stderrText ?? "", truncated: script.stderrTruncated ?? false },
        };
      });
      if (call.timeoutMs === undefined) {
        shell.procs.push(proc);
      }
      return proc;
    },
  };
  return shell;
}

// ── 宿主替身 ────────────────────────────────────────────────────────────────

interface FakeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => { type: string; text: string }[];
  };
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

interface FakeRoute {
  kind: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/** describe() 的替身项（只用到 ns/value 两个字段，与官方 SettingsDescriptor 一致）。 */
interface FakeDescriptor {
  ns: string;
  value: unknown;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

/**
 * ctx.credentials 替身。describe 只回存在性，resolve 回**明文样本** LIVE_KEY：
 * 断言 LIVE_KEY 不出现在任何 HTTP 回执里，验的就是「宿主侧 resolve 的值绝不出门」。
 */
interface FakeCredentials {
  describe: (ref: string) => Promise<{ configured: boolean; writable: boolean }>;
  resolve: (ref: string) => Promise<{ value: string; source: string } | undefined>;
}

interface FakeHost {
  registeredTools: FakeTool[];
  registeredRoutes: FakeRoute[];
  sections: { name: string; order: number; text: string }[];
  /** settings.configure 的调用记录（页面策略断言用）。0.1.7 里本包对 settings 只做
   *  这一件事 + describe() 读，命名空间注册已从插件侧拿走（宿主隐式投影 Config）。 */
  configureCalls: ConfigureCall[];
  /** 设置卡当前值：volatile 引用背后的可变宿主，改它即等价于「用户改了设置」。 */
  settingsValue: Record<string, unknown>;
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  shell: FakeShell;
  /** 官方注册表的实现本身（见 makeJobRegistry）；后台评审作业的真身都在它里面。 */
  jobs: LocalJobRegistry;
  /** 会话 id → 该会话的 Agent ctx（`jobs.start` 的 owner 校验要查这一位）。 */
  agents: Map<string, Context>;
  /** ctx.effect 登记的释放器（卸载用例要手动跑一遍）。 */
  effectDisposers: (() => void)[];
  /** `reflect.provide` 收到的服务（Remote 读面是否上线、其依赖闭包能否取数）。 */
  provided: Map<string, unknown>;
  /** cordis `Service` 构造期的注册口：apply 里的 `installOcrRemote` 只认这一位。 */
  reflect: { provide: (name: string, service: unknown) => void };
  /** `inject(...)` 子 fiber 的 effect 登记的释放器。与上面**分开存**：混在一队就分不出
   *  「释放器挂在谁身上」，而五条路由的释放器必须挂在子 fiber 上（webServer 换实例时
   *  子 fiber 先卸后装，主 fiber 的效应那时还没轮到）。 */
  injectEffectDisposers: (() => void)[];
  /** ctx.on 注册的事件监听器（按事件名分组）：用例经 emit 触发，验证会话回收接合。 */
  listeners: Map<string, Set<(payload?: unknown) => void>>;
  /** 被问过存在性的 ref（卡片侧）。 */
  describedRefs: string[];
  /** 被问过「能否解析」的 ref（应用侧）。 */
  resolvedRefs: string[];
  settings: {
    /** 页面策略登记：宿主用它决定要不要自动生成表单页。 */
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
    /** 跨命名空间读的唯一官方入口：provider 清单与 locale 偏好都从这里挑。 */
    describe: () => FakeDescriptor[];
  };
  tools: { register: (def: FakeTool) => () => void };
  systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void };
  /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次。 */
  inject: (
    deps: readonly string[],
    callback: (child: {
      settings: FakeHost["settings"];
      effect: (factory: () => (() => void) | undefined) => unknown;
    }) => void,
  ) => unknown;
  get: (name: string) => unknown;
  /** ctx.effect(factory)：立即执行并把返回的释放器收进 effectDisposers。 */
  effect: (factory: () => (() => void) | undefined) => void;
  /** ctx.on(event, listener)：cordis 返回释放器；替身记录监听器供用例触发。 */
  on: (event: string, listener: (payload?: unknown) => void) => () => void;
  /** 用例侧触发：按注册顺序调用该事件的监听器（复刻 cordis emit）。 */
  emit: (event: string, payload?: unknown) => void;
}

/** 宿主替身的可选项：两个官方通道的装配状态与回答。 */
interface FakeHostOptions {
  webServer?: boolean;
  /** false ⇒ get("settings") 拿不到服务（未装配 settings 的 profile）。 */
  settingsService?: boolean;
  /** false ⇒ get("credentials") 缺席（非 web profile / 精简 bundle）。 */
  credentialsService?: boolean;
  /** describe() 的命名空间清单。 */
  descriptors?: FakeDescriptor[];
  /** 视为已配置 key 的 ref 名单。 */
  configured?: string[];
  /** false ⇒ get("jobs") 交不出注册表（宿主没装 dsh-jobs-local 的那一档）。 */
  jobs?: boolean;
  /** true ⇒ describe/resolve 直接 reject（宿主侧凭据服务故障，不该把卡片打成 500）。 */
  credentialsReject?: boolean;
  /** true ⇒ resolve 命中但值是空串（凭据层的「空值即不存在」规则）。 */
  emptyValue?: boolean;
  /**
   * describe() 里 locale 那条的 value（官方 locale 插件的解析值）；
   * 缺省 = 该命名空间未被投影出来 → 文案按中文默认（与 ctx-observe 同款替身）。
   */
  locale?: { preference?: string };
}

function noop(): () => void {
  return (): void => {
    void 0;
  };
}

/** 会话被停止/关闭的宿主事件名：三处用例共用，避免重复字面量。 */
const SESSION_DISPOSED = "session/disposed";

/** 建过的替身先记下来，文件级 `afterEach` 统一收尾（判据见那里）。 */
const HOSTS: FakeHost[] = [];

function makeHost(options: FakeHostOptions = {}): FakeHost {
  const configured = options.configured ?? ALL_REFS;
  // 两个问答记录先声明：credentials 替身与 host 门面互相引用，避免用到未定义的 host。
  const describedRefs: string[] = [];
  const resolvedRefs: string[] = [];
  const credentials: FakeCredentials = {
    describe: async (ref: string) => {
      describedRefs.push(ref);
      if (options.credentialsReject === true) {
        throw new Error("credentials provider unavailable");
      }
      return { configured: configured.includes(ref), writable: true };
    },
    resolve: async (ref: string) => {
      resolvedRefs.push(ref);
      if (options.credentialsReject === true) {
        throw new Error("credentials provider unavailable");
      }
      return configured.includes(ref)
        ? { value: options.emptyValue === true ? "" : LIVE_KEY, source: "file" }
        : undefined;
    },
  };
  const agents = new Map<string, Context>();
  const host: FakeHost = {
    registeredTools: [],
    registeredRoutes: [],
    sections: [],
    listeners: new Map(),
    configureCalls: [],
    fiber: { id: "ocr-review-fiber" },
    jobs: makeOwnedJobRegistry({
      get: (session) => {
        const ctx = agents.get(session);
        return ctx === undefined ? undefined : { id: session, ctx };
      },
    }),
    agents,
    effectDisposers: [],
    provided: new Map(),
    reflect: {
      provide: (name, service) => {
        host.provided.set(name, service);
      },
    },
    injectEffectDisposers: [],
    describedRefs,
    resolvedRefs,
    settingsValue: {
      effort: "medium",
      language: "中文",
      autoVerify: true,
      maxComments: 12,
      timeoutMinutes: 0,
      // 装载期自检默认关：它会在 apply 里起一次 `ocr llm test` 子进程，而本文件大量用例
      // 断言「apply 不产生子进程」。要测自检的用例自己把它置 true（见「装载期端点自检」组）。
      startupVerify: false,
    },
    shell: makeShell(),
    settings: {
      /** 页面策略登记（0.1.7 起命名空间由宿主隐式投影，插件不再 register）。 */
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        host.configureCalls.push({ presentation, owner });
        return noop();
      },
      describe: () => [
        ...(options.descriptors ?? descriptorsWithValue(PI_AI_SETTINGS_VALUE)),
        // 官方 locale 插件拥有的命名空间：卡片侧语言由宿主驱动，host 侧只读这一份偏好。
        // 未注册（options.locale 缺省）时这条根本不在 describe() 的结果里。
        ...(options.locale === undefined ? [] : [{ ns: "locale", value: options.locale }]),
      ],
    },
    tools: {
      register: (def) => {
        host.registeredTools.push(def);
        return noop();
      },
    },
    systemPrompt: {
      section: (section) => {
        host.sections.push(section);
        return noop();
      },
    },
    inject: (_deps, attach) => {
      // 子 fiber 的 effect 与主 fiber 同构（cordis：立即执行 factory、释放器随子 fiber 回收），
      // 但**另存一队**：五条路由的释放器必须挂在子 fiber 上，混队就测不出挂错了地方。
      attach({
        settings: host.settings,
        effect: (factory: () => (() => void) | undefined) => {
          const dispose = factory();
          if (dispose !== undefined) {
            host.injectEffectDisposers.push(dispose);
          }
        },
      });
    },
    // ctx.effect(factory)：cordis 立即执行 factory 并把返回的释放器挂上 fiber。
    // 替身照此执行，卸载用例再手动跑 effectDisposers 即可复刻回收顺序。
    effect: (factory: () => (() => void) | undefined) => {
      const dispose = factory();
      if (dispose !== undefined) {
        host.effectDisposers.push(dispose);
      }
    },
    // ctx.on(event, listener)：cordis 把监听器挂到 fiber 上并交回摘除函数。
    // 替身照此记录；用例经 host.emit(event) 触发，验证「会话 dispose 才回收」。
    on: (event, listener) => {
      const set = host.listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      host.listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit: (event, payload) => {
      for (const listener of host.listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    get: (name: string) => {
      let service: unknown;
      if (name === "webServer" && options.webServer !== false) {
        service = {
          // 逐字复刻官方件（installed dsh-host-webserver/lib/index.js:177-184）：同路径再注册
          // 当场抛 `webserver: duplicate <kind> route "<path>"`，返回的 disposer 必须**调用方
          // 自己调**才摘得掉。替身若只 push 再回一枚 noop，"路由从不摘"这类缺陷就只在
          // 编译器里存在（早前复核正是这么漏过去的）。
          register: (route: FakeRoute) => {
            if (host.registeredRoutes.some((one) => one.path === route.path)) {
              throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
            }
            host.registeredRoutes.push(route);
            return () => {
              const index = host.registeredRoutes.findIndex((one) => one.path === route.path);
              if (index !== -1) {
                host.registeredRoutes.splice(index, 1);
              }
            };
          },
          // 官方 `Config['host']` 是**必有**的具体 IP 字面量（config 层拒绝通配与
          // 非字面量），替身给回环 127.0.0.1 与默认部署一致。
          host: "127.0.0.1",
        };
      } else if (name === "settings" && options.settingsService !== false) {
        service = host.settings;
      } else if (name === "jobs" && options.jobs !== false) {
        service = host.jobs;
      } else if (name === "agents") {
        // 官方 agent 注册表：只给 owner 判定读的那一位（会话 id → 活 Agent）。
        service = {
          // 官方 Agent 的 `id` 就是会话 id（注册表按它写 view.owner 与 Lifecycle 记录）。
          get: (session: string) => {
            const ctx = host.agents.get(session);
            return ctx === undefined ? undefined : { id: session, ctx };
          },
        };
      } else if (name === "credentials" && options.credentialsService !== false) {
        service = credentials;
      }
      return service;
    },
  };
  HOSTS.push(host);
  return host;
}

// ── 0.1.7 设置面替身：Config schema → volatile 引用 ───────────────────────────
//
// 旧替身是 `settings.register(ns, schema, { base })` 交回一个 scope，本包再 scope.get()。
// 0.1.7 三处都变了：命名空间由宿主按 profile 条目 id 隐式定、可编辑字段由 schema 上的
// `.volatile()` 声明、行 config 与默认的合并发生在 cordis 装载期。下面这组 helper 就是
// 照宿主真实的判据（settings/src/schema.ts 的 volatileForm + fiber.ts 的 resolveConfig）
// 复刻出来的替身，不复刻语义的测试会在真宿主上假绿。

/** 导出 Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 导出 Config schema 的 dict（单源：字段名与元数据都从宿主实际读的那份来）。 */
function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份底座，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/** 设置卡该能编辑的字段（src/client-entry.ts 的六行设置，一个都不该漏）。 */
const EDITABLE = [
  "autoVerify",
  "effort",
  "language",
  "maxComments",
  "ocrConfigPath",
  "timeoutMinutes",
];

/** 字段化的部署值：在 Config 里但**不标** volatile ⇒ 只在行 config 上改。 */
const DEPLOYMENT = [
  "llmTestTimeoutMs",
  "ocrBackgroundMaxMs",
  "ocrInstallHint",
  "ocrNoAutoUpdate",
  "startupVerify",
  "stdoutMaxBytes",
];

/**
 * 复刻 cordis 交进 apply 的那份 Config：**volatile** 字段是稳定引用、其 get() 现读
 * host.settingsValue（与真实 Volatile 的「引用不变、值可变」同构，cosmokit
 * createVolatile 也只有一个 get()，见 vendor/cosmokit/src/volatile.ts:39-45）；
 * **非 volatile** 字段是装载期定值（部署调优三字段走这一臂：行 config 改值要重启，
 * 与 cordis 对非 volatile 的语义一致，故这里快照而不是给引用）。
 */
function liveConfig(host: Partial<FakeHost> | null | undefined): Record<string, unknown> {
  // 类型在说谎：契约守卫用例喂的就是空壳（`{} as unknown as FakeHost`）与 null
  // （`null as unknown as FakeHost`，见"apply 的契约守卫"那组），构 Config 不许先于
  // apply 的守卫炸。所以入参类型按**运行时真相**声明成可缺省，`?.` 守卫保留。
  const values: Record<string, unknown> = host?.settingsValue ?? {};
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) =>
      field.meta?.["volatile"] === true
        ? [key, { get: () => values[key] }]
        : [key, values[key] ?? field.meta?.["default"]],
    ),
  );
}

/** 真·cordis 装载期解析（fiber.ts resolveConfig 走的就是 `~standard`.validate）：
 *  行 config 交进来 → 按 Config 校验 + 填 schema 默认 → volatile 引用。用它而不是在
 *  测试里自己合并，才能证明「显式缺省的字段落回底座」这件事仍然只在 schema 一处成立。 */
function resolveRowConfig(row: Record<string, unknown>): Record<string, { get: () => unknown }> {
  const schema = plugin.Config as unknown as {
    "~standard": { validate: (value: unknown) => { issues?: unknown; value: unknown } };
  };
  const result = schema["~standard"].validate(row);
  expect(result.issues).toBeUndefined();
  return result.value as Record<string, { get: () => unknown }>;
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts:35-47 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表「没有」：本仓 lint 的 consistent-return 配了
 *  `treatUndefinedAsUnspecified`，`return undefined` 记作无值返回、与 `return []` 冲突。）
 */
function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片/端点/命名空间三处都按它对齐，写死会让测试与包体漂移。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const id = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(yml)?.groups?.["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("cordis.patch.yml 里没有裸 `- id:` 条目");
  }
  return id;
}

/** 默认现读口替身：本文件绝大多数用例只关心命令构造与输出契约，不该被「这台机器
 *  装没装 ocr」这件事左右。前置短路那一档由专门的用例显式注入 `none` 来验。 */
const presentProbe: OcrAvailabilityProbe = () => ({
  source: "bundled",
  path: "/fake/node_modules/@alibaba-group/open-code-review/bin/ocr.js",
  channel: "npm",
});

/** 前置短路那一档的现读口替身：两条路都没有候选。 */
const noneProbe: OcrAvailabilityProbe = () => ({ source: "none" });

/** PATH 命中那一档的现读口替身：随包入口缺席，PATH 上有候选。 */
const pathProbe: OcrAvailabilityProbe = () => ({
  source: "path",
  path: "/usr/local/bin/ocr",
  channel: "unknown",
});

function applyPlugin(host: FakeHost, probe: OcrAvailabilityProbe = presentProbe): void {
  (
    applyWithProbe as unknown as (
      ctx: unknown,
      config: unknown,
      availability: OcrAvailabilityProbe,
    ) => void
  )(host, liveConfig(host), probe);
}

/** `ocr llm test` 跑通那句（装载期自检的多个用例共用，写四遍就成了各漂各的期望值）。 */
/** brew 那条装法命令的原文（多处断言共用）。 */
const BREW_INSTALL = "brew install open-code-review";
const LLM_TEST_OK = { exitCode: 0, stdoutText: "Connection test successful" };
/** `ocr version` 跑通且与核对版本同版那份回执。 */
const VERSION_OK_OUT = `open-code-review ${EXPECTED_OCR_CLI_VERSION} darwin/arm64\n`;

/**
 * 装载期自检开着、且版本探测交出 `versionOut` 的宿主：apply 里两行调用的先后即 resolve
 * 的先后（先端点自检、后版本探测），所以脚本队列要按这个次序喂两条。
 * 版本核对相关的用例共用它，队列里剩下的余量留给工具调用本身。
 */
async function hostWithMeasuredVersion(versionOut: string): Promise<FakeHost> {
  const host = makeHost();
  host.settingsValue["startupVerify"] = true;
  host.shell.scripts.push(LLM_TEST_OK, { exitCode: 0, stdoutText: versionOut });
  applyPlugin(host);
  await settledTick();
  return host;
}

function toolOf(host: FakeHost, name: string): FakeTool {
  const found = host.registeredTools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  return found;
}

/** 工具注册项的 output schema（canonical 输出契约的钉子用）。 */
function outputSchemaOf(host: FakeHost, name: string): Record<string, unknown> {
  return toolOf(host, name).output.schema;
}

/** host.ts 的 ToolExec 投影（官方 `ToolRunContext` 的 signal/agent 两面）。
 *  从 `ocrRepo` 的参数位取类型，而不是在测试里再抄一份执行面形状——抄了就又会漂。 */
type HostExec = Parameters<typeof ocrRepo>[1];

/** 执行面替身：`agent` 给的是官方契约之外的脏数据（null、缺 session / 缺 header 的半装配）。 */
function fakeExec(signal: AbortSignal, agent: unknown): HostExec {
  return { signal, agent } as HostExec;
}

function makeExec(cwd?: string, sessionId?: string): HostExec {
  if (sessionId !== undefined) {
    return {
      signal: new AbortController().signal,
      agent: { session: { id: sessionId, header: cwd === undefined ? {} : { cwd } } },
    } as HostExec;
  }
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? {} : { session: { header: { cwd } } },
  } as HostExec;
}

/** 把一个会话登记成活 Agent（owner 校验用），并返回该会话的 exec。 */
function ownExec(host: FakeHost, sessionId: string, cwd?: string): HostExec {
  host.agents.set(sessionId, new Context());
  return makeExec(cwd, sessionId);
}

/**
 * 起 count 条后台评审（并发起是安全的：容量闸只管活的，count <= 10）。
 */
async function startBackgroundRuns(host: FakeHost, count: number): Promise<string[]> {
  const before = new Set(host.jobs.list().map((job) => String(job.id)));
  const runs: Promise<unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    runs.push(toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec()));
  }
  await Promise.all(runs);
  return host.jobs
    .list()
    .map((job) => String(job.id))
    .filter((id) => !before.has(id));
}

/**
 * 把 `procs[from..]` 全部自然落定。`settle()` 是同步的、注册表的落定链全是微任务
 * ⇒ 整批只需一次宏任务，不必一条条等。
 * @param host 宿主替身
 * @param from procs 的下标起点
 * @returns {Promise<void>}
 */
async function settleBackgroundRuns(host: FakeHost, from: number): Promise<void> {
  for (const proc of host.shell.procs.slice(from)) {
    proc.settle();
  }
  await settledTick();
}

// ── 顶层 describe 与文件级钩子 ────────────────────────────────────────────
//
// 下面三条钩子（沙箱复位 / mock 进程结算 / 临时 home 清理）对整个文件生效，而
// vitest(require-top-level-describe) 要求钩子必须在 describe 里，故本文件的全部
// suite 收进同一层 describe（钩子的作用域与顺序因此不变）。
const REVIEW_JSON = JSON.stringify({
  status: "success",
  session_id: "sess-1",
  summary: { files_reviewed: 2, comments: 1, total_tokens: 900, elapsed: "12s" },
  comments: [
    {
      path: "src/a.ts",
      content: "空指针风险",
      start_line: "42",
      end_line: 44,
      category: "bug",
      severity: "critical",
    },
  ],
});

/** review/scan `--preview` 的裸 model.Preview 回执（键 files，不是摘要对象）。 */
const PREVIEW_JSON = JSON.stringify({
  files: [
    { path: "src/a.ts", status: "modified", insertions: 2, deletions: 1, will_review: true },
    {
      path: "src/a.test.ts",
      status: "modified",
      insertions: 1,
      deletions: 0,
      will_review: false,
      exclude_reason: "default_path",
    },
  ],
  total_insertions: 3,
  total_deletions: 1,
  total_files: 2,
  reviewable_count: 1,
  excluded_count: 1,
});

/** session compare 的四桶回执（键名按 CLI 的 CompareResult）。 */
const COMPARE_JSON = JSON.stringify({
  before: { session_id: "b", review_mode: "range", range: "main..x" },
  after: { session_id: "a", review_mode: "range", range: "main..x" },
  new: [
    {
      path: "src/new.ts",
      content: "new issue",
      start_line: 1,
      end_line: 1,
      category: "bug",
      severity: "high",
    },
  ],
  persisting: [],
  resolved: [
    {
      path: "src/old.ts",
      content: "fixed",
      start_line: 2,
      end_line: 2,
      category: "bug",
      severity: "medium",
    },
  ],
  not_reviewed: [],
});

/** 失败覆盖度样本：`failed` 里一条真实的预算失败条目（多处用例共用同一形状）。 */
const FAILED_ITEM_BUDGET = {
  path: "src/b.ts",
  classification: "budget",
  reason: "token budget",
};
describe("host.ts（注册面 + 7 个工具执行路径 + 9 条 ocrReview Remote 方法）", () => {
  // ── 沙箱复位（每个用例只清外部 ocr CLI 的配置；宿主侧已无文件）────────────────

  beforeEach(() => {
    rmSync(OCR_CONFIG, { force: true });
    rmSync(`${OCR_CONFIG}.bak`, { force: true });
    // 官方件写的临时名是 `<目标>.<随机 hex>.tmp`、锁名是 `<目标>.lock`，都不是固定后缀，
    // 所以按前缀清扫整目录里的兄弟文件：一次中途崩溃留下的残骸否则会跨用例存在，
    // 而锁残骸会让后续写入等满 2s 才失败（假失败）。
    const dir = path.dirname(OCR_CONFIG);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (
          name.startsWith(`${path.basename(OCR_CONFIG)}.`) &&
          (name.endsWith(".tmp") || name.endsWith(".lock"))
        ) {
          rmSync(`${dir}/${name}`, { force: true });
        }
      }
    }
  });

  /**
   * 每条用例离场时把它做过的 mock 进程全部落定。
   *
   * 为什么必须有这一位：官方注册表的周期泵只在**名册里有活作业**时按 `pumpPollMs` 自续
   * （本仓替身是 25ms），而 `兜底 deadline` 那条用例要 `vi.useFakeTimers()` 后一次推进
   * 2 小时。别条用例留下的活作业，它的泵**正好在假时间窗里重新挂上**时就会被当成那条用例
   * 自己的拍白刷掉整段假时间窗；挂不挂上看调度 ⇒ 整文件耗时跳档甚至判超时
   * （本机实测）。用例内的断言都在落定之前跑完，这一位不改判据只收尾。
   */
  afterEach(async () => {
    for (const one of HOSTS.splice(0)) {
      for (const proc of one.shell.procs) {
        proc.settle();
      }
    }
    await settledTick();
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  // ── 注册面 ──────────────────────────────────────────────────────────────────

  describe("apply 注册面", () => {
    it("登记页面策略、7 个工具、路由段与 5 个端点", () => {
      const host = makeHost();
      applyPlugin(host);
      // 0.1.7 隐式注册：本包不再向 settings 登记命名空间，只登记一次页面策略
      // （{ auto: false } = 自带卡片，别让宿主再生成一份自动页）。
      expect(host.configureCalls).toHaveLength(1);
      expect(host.configureCalls[0]?.presentation).toStrictEqual({ auto: false });
      expect(host.configureCalls[0]?.owner).toBe(host.fiber);
      expect(host.registeredTools.map((tool) => tool.name).toSorted()).toStrictEqual([
        "ocr_delegate_preview",
        "ocr_delegate_rule",
        "ocr_llm",
        "ocr_review",
        "ocr_rules_check",
        "ocr_scan",
        "ocr_session",
      ]);
      expect(host.sections).toHaveLength(1);
      expect(host.sections[0]?.order).toBe(1555);
      expect(host.registeredRoutes, "HTTP 数据面已迁到官方 Remote").toStrictEqual([]);
      // Remote 读面无条件上线：它的存在只由 apply 决定，与 webServer 是否到位无关。
      expect(host.provided.has(OCR_REMOTE_NAMESPACE)).toBe(true);
    });

    it("行 config 的 undefined 字段落回 schema 默认（0.1.6 内置底座的等价面）", () => {
      // 0.1.7 里这层合并已归 cordis 装载期（fiber.ts resolveConfig 用导出的 Config 校验
      // 并填默认），插件只读引用。旧断言盯的是「插件把行 config 合进 BUILTIN_BASE 后交给
      // settings.register 的那份 base」，现在盯的是**真解析**出来的引用当前值。
      const resolved = resolveRowConfig({ effort: "high", language: undefined, maxComments: 3 });
      expect(resolved["effort"]?.get()).toBe("high");
      expect(resolved["maxComments"]?.get()).toBe(3);
      expect(resolved["timeoutMinutes"]?.get()).toBe(0);
      expect(resolved["ocrConfigPath"]?.get()).toBeUndefined();
    });

    it("无 webServer 服务时端点注册整体跳过（工具与设置照常）", () => {
      const host = makeHost({ webServer: false });
      applyPlugin(host);
      expect(host.registeredTools).toHaveLength(7);
      expect(host.registeredRoutes).toHaveLength(0);
    });

    it("remote 读面无 webServer 也上线，providers 走 apply 交进去的那组依赖", async () => {
      const host = makeHost({ webServer: false });
      applyPlugin(host);
      const service = host.provided.get(OCR_REMOTE_NAMESPACE) as
        | { providers: () => Promise<Record<string, unknown>> }
        | undefined;
      expect(service).toBeDefined();
      const body = await service?.providers();
      expect(body?.["ok"]).toBeUndefined();
      expect(Array.isArray(body?.["providers"])).toBe(true);
      // 读面不再下发会话内 token：卡片走官方网关，鉴权归网关。
      expect(body !== undefined && "csrf" in body).toBe(false);
    });

    it("宿主服务面缺一即抛（守卫名副其实，不运行到一半才炸）", () => {
      const baseHost = makeHost();
      applyPlugin(baseHost);
      const missingGet = { ...baseHost } as Record<string, unknown>;
      delete missingGet["get"];
      expect(() => {
        applyPlugin(missingGet as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      const brokenShell = { ...baseHost, shell: { resolve: baseHost.shell.resolve } };
      expect(() => {
        applyPlugin(brokenShell as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      // settings 只够 configure 不够 describe：provider 清单与 locale 这条官方通道直接
      // 没有，守卫必须在装载期就说清楚，而不是等卡片打开后显示空列表。
      const noDescribe = { ...baseHost, settings: { configure: baseHost.settings.configure } };
      expect(() => {
        applyPlugin(noDescribe as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      // 缺 configure 同样当场拒：页面策略登记不上，宿主会替本包再生成一份自动表单页。
      const noConfigure = { ...baseHost, settings: { describe: baseHost.settings.describe } };
      expect(() => {
        applyPlugin(noConfigure as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      // 缺 inject：页面策略那条 effect 挂不上（守卫里点名了它，就必须当场拒）。
      const missingInject = { ...baseHost } as Record<string, unknown>;
      delete missingInject["inject"];
      expect(() => {
        applyPlugin(missingInject as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      expect(() => {
        applyPlugin({} as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
      expect(() => {
        applyPlugin(null as unknown as FakeHost);
      }).toThrow(/缺少所需的/u);
    });
  });

  // ── 0.1.7 隐式注册验收：volatileForm(Config) 的字段集 = 设置卡的可编辑字段集 ──
  //
  // 为什么单独要这一条：0.1.7 的命名空间与可编辑字段都是**从 schema 反推**的，漏写一个
  // `.volatile()` 不会报错，只会让那一项从设置卡上**静默消失**（宿主 describe() 只投影
  // volatileForm 的结果）；全漏则整条被跳过（settings/index.ts:308-309）、写入抛
  // `has no volatile fields`（:386）。这类退化在本文件其它用例里全绿——它们改的是
  // host.settingsValue，替身根本不看 schema 的 meta。只有拿宿主同一个判据回头看 schema
  // 才拦得住。
  //
  // ⚠ 它能拦住的：字段级 volatile 漏标/多标、字段名漂移、条目 id 与 schema 不同源。
  // 它**拦不住**的（仍靠真实宿主启动或人工核对）：
  //   1. 行 id 接线 —— 命名空间取的是 profile 条目 `options.id`，即 ~/.dsh 里那份**已装配
  //      的** profile 文档，本包 cordis.patch.yml 只是它的来源；profile 被手工改过、或
  //      别处也 insert 了同名条目时，这里断言的 id 与实际 ns 依然会错开。
  //   2. `fiber.runtime.Config` —— 宿主读的是装载后 runtime 上那份 Config
  //      （settings/index.ts:425-428 `'toJSON' in schema` 才算数）。本包导出的是同一个对象
  //      引用，但"cordis 真的把它挂上了 runtime"这一步不在单测射程内。
  describe("0.1.7 隐式注册验收", () => {
    it("命名空间 = cordis.patch.yml 的条目 id", () => {
      expect(patchEntryId()).toBe(PLUGIN_ENTRY_ID);
    });

    it("schema 逐字段默认 = 0.1.6 交给 register 的内置底座", () => {
      // 0.1.7 删了 settings.register(ns, schema, { base })：默认值改由 schema 自己带
      // （cordis 装载期用同一份 schema 填默认，fiber.ts resolveConfig）。少一个默认就会
      // 在真实宿主上变样，故逐字段对齐旧 BUILTIN_BASE。
      expect(schemaDefaults()).toStrictEqual({
        effort: "auto",
        language: "中文",
        autoVerify: true,
        maxComments: 12,
        timeoutMinutes: 0,
        // 路径**不给**默认：内置底座一旦写死绝对路径就又回到「作者机器布局」。
        ocrConfigPath: undefined,
        // 部署级那一组：llmTestTimeoutMs / stdoutMaxBytes 与原常量同值，
        // ocrBackgroundMaxMs 的默认改为 0（无兜底窗口）。
        // 这里手写字面值而不引 host.ts 的常量——引常量就成了自证，常量改了该先红。
        llmTestTimeoutMs: 90_000,
        ocrBackgroundMaxMs: 0,
        stdoutMaxBytes: 400_000,
        // 装载期端点自检默认开（部署可关）。
        startupVerify: true,
        // 自动更新默认不抑制：维持被封装 CLI 的既有行为，要关是部署的决定。
        ocrNoAutoUpdate: false,
        // 装法默认两条都给：替他选装法是部署的决定，不是本包的偏好。
        ocrInstallHint: "both",
      });
    });

    it("ocrConfigPath 无默认：undefined 哨兵不被默认值永久掩掉", () => {
      const field = configDict()["ocrConfigPath"];
      expect(field?.meta?.["default"]).toBeUndefined();
      expect(field?.meta?.["volatile"]).toBe(true);
    });

    it("volatileForm(Config) 的字段集恰为六项可编辑字段", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      expect(form).not.toBeNull();
      expect(form?.toSorted()).toStrictEqual(EDITABLE);
      // Config 的字段全集 = 设置卡六项 + 三项部署值（后者不进表单，但仍在 schema 上）
      expect(Object.keys(configDict()).toSorted()).toStrictEqual(
        [...EDITABLE, ...DEPLOYMENT].toSorted(),
      );
    });
  });

  describe("define 的入参闸与必填闸", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("非对象入参当场拒绝（不静默跑一次真实评审）", async () => {
      const review = toolOf(host, "ocr_review");
      await expect(review.execute(null, makeExec("/tmp"))).rejects.toThrow(/必须是 JSON 对象/u);
      await expect(review.execute(["repo"], makeExec("/tmp"))).rejects.toThrow(/array/u);
      expect(host.shell.resolveCalls).toHaveLength(0);
    });

    it("parameters.required 缺项即拒，且不带任何副作用", async () => {
      const rule = toolOf(host, "ocr_delegate_rule");
      await expect(rule.execute({}, makeExec("/tmp"))).rejects.toThrow(/缺少必填参数 paths/u);
      expect(host.shell.resolveCalls).toHaveLength(0);
    });

    it("requiredKeys 只接受字符串数组形态", () => {
      expect(requiredKeys({ required: ["a"] }, zh)).toStrictEqual(["a"]);
      expect(requiredKeys({}, zh)).toStrictEqual([]);
      expect(() => requiredKeys({ required: "a" }, zh)).toThrow(/必须是字符串数组/u);
      expect(() => requiredKeys({ required: [1] }, zh)).toThrow(/元素必须是字符串/u);
    });

    it("output schema 与 render 一致（pretty-print 正常臂与三条降级兜底都覆盖）", () => {
      const { render } = toolOf(host, "ocr_review").output;
      // canonical 值直返后 ocr_review 的根是四分支 oneOf：后台回执 / 摘要对象 / 文件预览 / 解析失败字符串。
      expect(toolOf(host, "ocr_review").output.schema["oneOf"]).toHaveLength(4);
      // 正常臂：能 JSON 化的结构化值按两层缩进 pretty-print 成 model-facing 文本（不是 String(value)）。
      expect(render({}, { jobId: "j-1", files: ["a.ts"] })[0]?.text).toBe(
        '{\n  "jobId": "j-1",\n  "files": [\n    "a.ts"\n  ]\n}',
      );
      expect(render({}, undefined)[0]?.text).toBe("undefined");
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(render({}, circular)[0]?.text).toBe("[object Object]");
      const unrenderable = {
        toString() {
          throw new Error("nope");
        },
      };
      Object.defineProperty(unrenderable, "boom", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      expect(render({}, unrenderable)[0]?.text).toBe("[unrenderable value]");
    });

    it("七个工具各自声明真实的 output schema（canonical 直返，不再是统一 {text}）", () => {
      // review / scan：oneOf[后台回执对象, 摘要对象, 文件预览对象, 解析失败字符串]；两个工具共用同一份。
      const reviewBranches = outputSchemaOf(host, "ocr_review")["oneOf"] as Record<
        string,
        unknown
      >[];
      expect(reviewBranches).toHaveLength(4);
      expect(reviewBranches[2]).toMatchObject({ type: "object" });
      expect(reviewBranches[3]).toStrictEqual({ type: "string" });
      const receiptProps = (reviewBranches[0] as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(receiptProps).toSorted()).toStrictEqual([
        "jobId",
        "mode",
        "polling",
        "processStatus",
        "repo",
        "started",
        "tool",
      ]);
      const summaryRequired = (reviewBranches[1] as { required: string[] }).required;
      expect(summaryRequired).toContain("topComments");
      expect(outputSchemaOf(host, "ocr_scan")["oneOf"]).toStrictEqual(reviewBranches);
      // preview / rule 是两分支 oneOf（对象 / 解析失败字符串）。
      expect(outputSchemaOf(host, "ocr_delegate_preview")["oneOf"]).toHaveLength(2);
      expect(outputSchemaOf(host, "ocr_delegate_rule")["oneOf"]).toHaveLength(2);
      // session：raw 对象（sessionOutput+hint）或 compare 结构化对象。
      const session = outputSchemaOf(host, "ocr_session")["oneOf"] as Record<string, unknown>[];
      expect(session).toHaveLength(2);
      expect(
        Object.keys((session[0] as { properties: object }).properties).toSorted(),
      ).toStrictEqual(["hint", "sessionOutput"]);
      expect((session[1] as { required: string[] }).required).toContain("persisting");
    });
  });

  // ── repo 解析 ───────────────────────────────────────────────────────────────

  describe("ocrRepo / sessionHeaderCwd 回落", () => {
    it("显式绝对路径优先，缺省回落到会话工作区", () => {
      expect(ocrRepo({ repo: "/explicit" }, makeExec("/session"), zh)).toBe("/explicit");
      expect(ocrRepo({}, makeExec("/session"), zh)).toBe("/session");
      expect(ocrRepo({ repo: "  " }, makeExec("/session"), zh)).toBe("/session");
    });

    it("无显式值且会话缺位/非字符串/非绝对 ⇒ 抛错要求显式传入", () => {
      expect(() => ocrRepo({}, makeExec(), zh)).toThrow(/repo 必填/u);
      expect(() => ocrRepo({}, makeExec("relative/path"), zh)).toThrow(/绝对路径/u);
      const headerless = fakeExec(new AbortController().signal, { session: {} });
      expect(() => ocrRepo({}, headerless, zh)).toThrow(/repo 必填/u);
      const nullAgent = fakeExec(new AbortController().signal, null);
      expect(() => ocrRepo({}, nullAgent, zh)).toThrow(/repo 必填/u);
    });
  });

  // ── review 工具 ─────────────────────────────────────────────────────────────

  describe("会话根归一化：review 与 ocr_session 必须落在同一个根", () => {
    // 模型给的 monorepo 子目录，与它对应的 git 顶层。
    const MONO_SUB = "/mono/pkg/foo";
    const MONO_TOP = "/mono";
    // 这一组里有一条真实盘符的软链用例；Windows 上不能桩 linux，否则 assertAbsoluteRoot
    // 会按 POSIX 分支拒掉 C:\…。其余用例用 /mono 字面量，两种平台语义下同形。
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const pretendPosix = realPlatform?.value !== "win32";
    let host: FakeHost;
    beforeEach(() => {
      if (pretendPosix) {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      }
      host = makeHost();
      applyPlugin(host);
    });
    afterEach(() => {
      if (pretendPosix) {
        Object.defineProperty(process, "platform", realPlatform ?? {});
      }
    });

    it("monorepo 子目录 ⇒ 两侧都提升到 git 顶层", async () => {
      // OCR 内部把 review 的 RepoDir 锚定在 git 顶层，会话目录又由 RepoDir 编码而来。
      // 模型给的若是子目录，不归一化就是「review 写进顶层、session 查子目录」，
      // 查询侧命中目录不存在分支、静默返回空（缺陷 1）。
      host.shell.gitTopLevel = MONO_TOP;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: MONO_SUB }, makeExec());
      const reviewWorkdir = host.shell.resolveCalls.at(-1)?.workdir;

      host.shell.scripts.push({ stdoutText: "null" });
      await toolOf(host, "ocr_session").execute({ repo: MONO_SUB }, makeExec());
      const sessionCommand = String(host.shell.resolveCalls.at(-1)?.command);

      expect(reviewWorkdir).toBe(MONO_TOP);
      expect(sessionCommand).toContain(`--repo '${MONO_TOP}'`);
      // 两处都不得回落到模型给的子目录。
      expect(reviewWorkdir).not.toBe(MONO_SUB);
      expect(sessionCommand).not.toContain(MONO_SUB);
    });

    it("ocr_scan 不提升：workdir 保留传入的子目录", async () => {
      // scan 靠 workdir 限定扫描范围（OCR 的 scan 路径 requireGit=false，保留 CWD），
      // 一起提升会把扫描扩到整个 monorepo；而它不落会话，无需与 review 对齐。
      host.shell.gitTopLevel = MONO_TOP;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_scan").execute({ repo: MONO_SUB, wait: true }, makeExec());
      expect(host.shell.resolveCalls.at(-1)?.workdir).toBe(MONO_SUB);
    });

    it("每条 ocr 调用都显式带 danger-full-access：否则会话写不进 ~/.opencodereview", async () => {
      // 回归钉的是**下发给宿主的请求形态**（本文件既有断言一律读 resolveCalls）：
      // 宿主围栏的 workspace-write 只放行 workspaceRoot 与后端临时区，而 ocr 的状态目录
      // 是 $HOME/.opencodereview（在 workspace 之外），漏掉这一栏的后果不是"少个功能"
      // 而是**跑完的评审被丢掉**——同步调用在 finalize session 失败、对外整体报错。
      // 宿主侧确实采纳调用方的值（dsh-bash-sandbox 的 resolve 是
      // `request.sandboxPolicy ?? 默认`，且 execute 对 danger-full-access 直接绕过围栏），
      // 所以这一栏写在这里就够了，不需要插件侧再做任何兜底。
      host.shell.gitTopLevel = MONO_TOP;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: MONO_SUB }, makeExec());
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_scan").execute({ repo: MONO_SUB, wait: true }, makeExec());

      // 覆盖 review 与 scan 两条执行路径（前台）；background 那条由 startBackground 另发。
      expect(host.shell.resolveCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of host.shell.resolveCalls) {
        expect(call.sandboxPolicy).toStrictEqual({
          mode: "danger-full-access",
          workspaceRoot: call.workdir,
        });
      }
    });

    it("非 git 目录 + 符号链接前缀 ⇒ 回退 realpath（缺陷 1 的触发条件②）", async () => {
      const real = mkdtempSync(path.join(tmpdir(), "ocr-real-"));
      const linkParent = mkdtempSync(path.join(tmpdir(), "ocr-link-"));
      try {
        const link = path.join(linkParent, "repo-link");
        await symlink(real, link);
        host.shell.gitTopLevel = null;
        host.shell.scripts.push({ output: REVIEW_JSON });
        await toolOf(host, "ocr_review").execute({ repo: link }, makeExec());
        expect(host.shell.resolveCalls.at(-1)?.workdir).toBe(realpathSync(real));
      } finally {
        rmSync(linkParent, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });

    it("路径不存在 ⇒ 原样返回，不因 realpath 失败而让评审失败", async () => {
      host.shell.gitTopLevel = null;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/no/such/dir" }, makeExec());
      expect(host.shell.resolveCalls.at(-1)?.workdir).toBe("/no/such/dir");
    });
  });

  describe("ocr_review 前台执行", () => {
    // POSIX 臂判据：钉住平台再判（纪律同 dsh-danger-guard 的平台桩）——Windows CI 上
    // 这些用例会跑进 win32 轨道、以假理由红；win32 轨道由各 win32 桩用例自证。
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    let host: FakeHost;
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      host = makeHost();
      applyPlugin(host);
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", realPlatform ?? {});
    });

    it("命令构造：守护包装 + --output 临时文件；评论摘要锚定数字字符串行号", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      const view = (await toolOf(host, "ocr_review").execute(
        {
          repo: "/repo",
          wait: true,
          background: "登录改造",
          exclude: ["**/gen/*"],
          effort: "high",
        },
        makeExec(),
      )) as {
        status: string;
        sessionId: string;
        aggregation: { bySeverity: Record<string, number> };
        topComments: { location: string }[];
      };
      const [spec] = host.shell.resolveCalls;
      expect(spec?.workdir).toBe("/repo");
      expect(String(spec?.command).startsWith("bash -c '")).toBe(true);
      const outPath = outputPathOf(String(spec?.command));
      expect(outPath).toMatch(/ocr-review-.{6,}[\\/]out\.json$/u);
      expect(view.status).toBe("success");
      expect(view.sessionId).toBe("sess-1");
      expect(view.topComments[0]?.location).toBe("src/a.ts:42-44");
      expect(view.aggregation.bySeverity["critical"]).toBe(1);
    });

    it("execute 直返 canonical 对象（不再把结果 stringify 进 {text} 双重编码）", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      );
      // 双重编码回归钉：值本身就是结构化对象，而不是「JSON 字符串里再包一份 JSON」；
      // 也不再有包着字符串的 text 字段（PTC 的 await tools.ocr_review(...) 拿到的就是它）。
      expect(result).toBeTypeOf("object");
      expect(result).not.toHaveProperty("text");
      const view = result as { status: string; sessionId: string; topComments: unknown[] };
      expect(view.status).toBe("success");
      expect(view.sessionId).toBe("sess-1");
      expect(Array.isArray(view.topComments)).toBe(true);
    });

    it("partial（部分文件失败但整体有覆盖，exit 0）⇒ 正常返回摘要而不是解析失败", async () => {
      // 回归钉：此前 status 白名单漏了 partial，整场已花费 token 的评审被报成
      // 「status 非法」并丢弃全部评论（输出 schema 的 enum 同步收 partial）。
      // 同一场里 coverage.failed 与 tool_calls 必须一起到模型手上：带 manifest 时 CLI
      // 会把子任务失败从 warnings 摘掉，只读 warnings 就看不见是哪个文件没审成。
      host.shell.scripts.push({
        output: JSON.stringify({
          status: "partial",
          message: "Some files could not be reviewed.",
          session_id: "sess-p",
          comments: [{ path: "src/a.ts", content: "空指针风险", start_line: 42, end_line: 44 }],
          warnings: [{ file: "src/c.ts", message: "skip: no rule", type: "note" }],
          summary: { files_reviewed: 2, budget_exceeded: true },
          tool_calls: {
            total: 3,
            failure: 1,
            failure_details: [
              { tool_name: "code_comment", file_path: "src/b.ts", error: "bad args" },
            ],
          },
          manifest: {
            coverage: {
              selected: [{}],
              completed: [{}],
              reused: [],
              failed: [FAILED_ITEM_BUDGET],
              waived: [],
            },
          },
        }),
      });
      const view = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as {
        status: string;
        totalCommentCount: number;
        warnings: string[];
        budgetExceeded: boolean;
        toolCalls: { total: number; failure: number; failures: string[] };
        coverage: { selected: number; failed: number; failedItems: string[] };
      };
      expect(view.status).toBe("partial");
      expect(view.totalCommentCount).toBe(1);
      expect(view.warnings).toStrictEqual(["src/c.ts：skip: no rule [note]"]);
      expect(view.budgetExceeded).toBe(true);
      expect(view.toolCalls).toStrictEqual({
        total: 3,
        failure: 1,
        failures: ["code_comment @ src/b.ts: bad args"],
      });
      expect(view.coverage).toStrictEqual({
        selected: 1,
        completed: 1,
        reused: 0,
        failed: 1,
        waived: 0,
        failedItems: ["src/b.ts [budget] token budget"],
      });
    });

    it("ocrConfigPath 布局内自定义 ⇒ spawn 的命令带 HOME=<X> 前缀（重定向生效通道）", async () => {
      // 端到端钉：设置层（端点读写）与执行层（HOME 注入）吃的是同一个设置值——
      // 卡片把 provider 应用到 <X>/.opencodereview/config.json 后，评审进程就在 X
      // 的家目录里读它，两侧 world 自洽。
      const customHome = path.join(HOME, "elsewhere");
      const custom = path.join(customHome, OCR_DIR_NAME, OCR_CONFIG_NAME);
      mkdirSync(path.dirname(custom), { recursive: true });
      host.settingsValue["ocrConfigPath"] = custom;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      const command = String(host.shell.resolveCalls[0]?.command);
      // withHomeEnv 的 shq 引号被守护的 shq 二次转义成 '\''——按真实落串形态断言。
      const homeAssignment = shq(customHome).replaceAll("'", String.raw`'\''`);
      expect(command).toContain(`HOME=${homeAssignment} `);
      // 未设置时命令不含 HOME=：默认路径零重定向。
      host.settingsValue["ocrConfigPath"] = undefined;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(String(host.shell.resolveCalls[1]?.command)).not.toContain("HOME=");
    });

    it("临时目录解析后即删", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      const outPath = String(outputPathOf(String(host.shell.resolveCalls[0]?.command)));
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(path.dirname(outPath))).toBe(false);
    });

    it("输出解析失败 ⇒ 回显脱敏后的原文片段，不报假干净", async () => {
      host.shell.scripts.push({ output: `{"error":"auth failed api_key=${PLAIN_KEY}"}` });
      // 解析失败分支的诚实值就是一段说明字符串（不再包 { text }）。
      const message = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as string;
      expect(message).toMatch(/status 非法或缺失/u);
      expect(message).toContain("已脱敏");
      expect(message).not.toContain(PLAIN_KEY);
    });

    it("exit 0 却没写出 --output 文件 ⇒ 可行动错误而非裸 ENOENT", async () => {
      host.shell.scripts.push({});
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/未写出 --output 文件/u);
    });

    it("非零退出但 CLI 已写出 --output ⇒ 失败详情带上哪些文件没审成", async () => {
      // 上游退出契约：只有 run-level 失败或「每个被选中的文件都失败」才非零，而那份
      // manifest 照发（review_cmd.go 的 reviewResultError）。只回 stderr 的话模型看到
      // 「2 of 2 selected item(s) failed」却不知道是哪些文件、哪一类失败。
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: "review failed: 2 of 2 selected item(s) failed",
        output: JSON.stringify({
          status: "failed",
          comments: [],
          manifest: {
            coverage: {
              selected: [{}],
              completed: [],
              reused: [],
              waived: [],
              failed: [FAILED_ITEM_BUDGET],
            },
          },
        }),
      });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(
        /2 of 2 selected item\(s\) failed[\s\S]*src\/b\.ts \[budget\] token budget/u,
      );
    });

    it("ocr_scan 也走同一条失败详情路径（两处调用点各要一份回执）", async () => {
      // withCoverageDetail 在 review 与 scan 各挂一次。只验 review 那一侧，等于让 scan 的
      // 接线在无覆盖的情况下存在——改错了没有任何用例会红。
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: "scan failed: 1 of 1 selected item(s) failed",
        output: JSON.stringify({
          status: "failed",
          comments: [],
          manifest: {
            coverage: {
              selected: [{}],
              completed: [],
              reused: [],
              waived: [],
              failed: [{ path: "src/c.ts", classification: "budget", reason: "token budget" }],
            },
          },
        }),
      });
      await expect(
        toolOf(host, "ocr_scan").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(
        /1 of 1 selected item\(s\) failed[\s\S]*src\/c\.ts \[budget\] token budget/u,
      );
    });

    it("非零退出但 --output 里没有失败明细 ⇒ 原样交回错误，不追加空说明", async () => {
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: "boom",
        output: JSON.stringify({
          status: "failed",
          comments: [],
          manifest: {
            coverage: { selected: [], completed: [], reused: [], waived: [], failed: [] },
          },
        }),
      });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/^ocr 执行失败（exit=1）：boom$/u);
    });

    it("非零退出但 --output 落在读不回来的位置 ⇒ 原样交回错误，不把「读不到」说成 OCR 的失败", async () => {
      // 裁剪分支：readFileSync 抛错时 withCoverageDetail 必须原样返回原错误。这条保证失败
      // 详情里不会冒出第二层「读不到落盘结果」，把真正的 exit 原因盖住。
      // 制造方式：让 --output 指向一个**目录**——writeFileSync 会静默失败（替身里那句
      // 写在 try 外，所以这里改用 shell 替身的 throws 之外的手段：把目录预先建好）。
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: "boom",
        outputDirectory: true,
      });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/^ocr 执行失败（exit=1）：boom$/u);
    });

    it("非零退出但 --output 里没有 manifest ⇒ failedItems 落到空集，原样交回错误", async () => {
      // 覆盖 `coverage?.failedItems ?? []` 的**空值分支**：回执存在但没有 manifest（上游在
      // run-level 失败时可能什么都不写），此时没有可附的明细，错误必须原样交回。
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: "boom",
        output: JSON.stringify({ status: "failed", comments: [] }),
      });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/^ocr 执行失败（exit=1）：boom$/u);
    });

    it("非零退出且没写出 --output ⇒ 失败详情原样，不凭空加一句", async () => {
      host.shell.scripts.push({ exitCode: 1, stderrText: "boom" });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/^ocr 执行失败（exit=1）：boom$/u);
    });

    it("--output 超过读取上限 ⇒ 点名文件与上限，不整份读进内存", async () => {
      // 稀疏文件：truncate 立刻给出这个大小，而插件在 readFileSync 之前就该拒掉。
      // 512 MiB 刻意远大于任何合理上限：这条断言不绑定 OUT_FILE_MAX_BYTES 的具体取值。
      const oversize = 512 * 1024 * 1024;
      host.shell.scripts.push({ sparseBytes: oversize });
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/--output 文件过大/u);
    });

    it("maxComments 0（不截断）与非法值（回退 12）都按条数兑现", async () => {
      // 评论数必须超过回退值 12，否则 0 与 12 两种截断口径会输出同一份清单，
      // 「回退 12」这条标题就只剩恒绿。所有评论都锚定到行号，避免 includeZeroLine
      // 的默认口径先把它们滤掉。
      const many = JSON.stringify({
        status: "success",
        session_id: "sess-many",
        summary: { files_reviewed: 2, comments: 15, total_tokens: 900, elapsed: "12s" },
        comments: Array.from({ length: 15 }, (_item, index) => ({
          path: "src/a.ts",
          content: `问题 ${index + 1}`,
          start_line: index + 1,
          end_line: index + 1,
          category: "bug",
          severity: "low",
        })),
      });
      host.settingsValue["maxComments"] = 0;
      host.shell.scripts.push({ output: many });
      const unlimited = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as { topComments: unknown[]; droppedCount: number };
      expect(unlimited.topComments).toHaveLength(15);
      expect(unlimited.droppedCount).toBe(0);
      host.settingsValue["maxComments"] = "many";
      host.shell.scripts.push({ output: many });
      const fallback = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as { topComments: unknown[]; droppedCount: number };
      expect(fallback.topComments).toHaveLength(12);
      expect(fallback.droppedCount).toBe(3);
    });

    it("effort 缺省取设置卡值（auto 不传，low/high 直通，其它归 medium）", async () => {
      host.settingsValue["effort"] = "auto";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(String(host.shell.resolveCalls[0]?.command)).not.toContain("--effort");
      host.settingsValue["effort"] = "low";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(String(host.shell.resolveCalls[1]?.command)).toContain("--effort low");
      host.settingsValue["effort"] = "high";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(String(host.shell.resolveCalls[2]?.command)).toContain("--effort high");
      host.settingsValue["effort"] = "ultra";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(String(host.shell.resolveCalls[3]?.command)).toContain("--effort medium");
    });

    it("模型传了认不出的 effort ⇒ 按「未指定」处理，回落设置卡值（不静默改成 medium）", async () => {
      host.settingsValue["effort"] = "high";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", effort: "deeper", wait: true },
        makeExec(),
      );
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("--effort high");
      host.settingsValue["effort"] = "auto";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", effort: "ultra", wait: true },
        makeExec(),
      );
      // auto = 跟随 OCR 自己的配置 ⇒ 不传 --effort；旧实现会在这里下发 --effort medium，
      // 等于模型打错一个字就把用户的 auto 深度改成了 medium。
      expect(String(host.shell.resolveCalls[1]?.command)).not.toContain("--effort");
    });

    it("effort/wait 错类型一律抛错（静默回落会改变审查深度或等待语义），null 仍按缺省", async () => {
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", effort: 3, wait: true }, makeExec()),
      ).rejects.toThrow(/effort 必须是字符串（收到 3）/u);
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: "false" }, makeExec()),
      ).rejects.toThrow(/wait 必须是布尔值（true\/false），收到 false/u);
      // null 与 undefined 同口径：按**缺省**处理，不抛。缺省现在是后台（see waitOf），
      // 所以这条走后台通道：没有 --output，但 --effort 仍按缺省 medium 下发。
      const bg = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", effort: null, wait: null },
        makeExec(),
      )) as { jobId?: string };
      expect(bg.jobId).toBeDefined();
      expect(bg.jobId === undefined ? 0 : bg.jobId.length).toBeGreaterThan(0);
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("--effort medium");
      expect(String(host.shell.resolveCalls[0]?.command)).not.toContain("--output");
    });

    it("wait=false 走后台通道：无 --output、无 timeoutMs、宿主 deadline 关闭", async () => {
      const receipt = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        makeExec(),
      )) as { started: boolean; mode: string; tool: string; processStatus: string };
      expect(receipt.started).toBe(true);
      expect(receipt.mode).toBe("background");
      expect(receipt.tool).toBe("ocr_review");
      expect(receipt.processStatus).toBe("running");
      expect(host.shell.procs).toHaveLength(1);
      expect(outputPathOf(String(host.shell.resolveCalls[0]?.command))).toBeUndefined();
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBeUndefined();
      // 回归护栏：0.1.7 的 bash-local resolve 缺省 onExpiry='kill'，后台漏传 'none'
      // 就会被宿主缺省 timeoutMs（Config.timeoutMs 缺省 120s）杀掉长评审。
      expect(host.shell.resolveCalls[0]?.onExpiry).toBe("none");
    });

    it("前台执行不得关闭宿主 deadline（onExpiry 只在后台通道下发）", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: true }, makeExec());
      expect(host.shell.resolveCalls[0]?.onExpiry).toBeUndefined();
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBeTypeOf("number");
    });

    it("后台回执带上官方作业 id ⇒ 模型有必有结果的 job_output 句柄", async () => {
      const receipt = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        makeExec(),
      )) as { jobId: unknown; polling: string };
      // 回执里必须有一个模型能直接喂给 job_output 的作业 id：polling 原本只把
      // 模型导向 ocr_session(action=list)，而那条路要会话已落盘、--repo 又对得上，
      // 启动早期两件事都可能还没成立。
      expect(receipt.jobId).toBeTypeOf("string");
      expect(String(receipt.jobId)).not.toBe("");
      // 且轮询文案真的把这条路线说出来了。
      expect(receipt.polling).toContain("job_output");
    });
  });

  // ── 后台取消接合 ────────────────────────────────────────────────────────────

  describe("startBackground 的生命周期接合", () => {
    it("工具调用中止不停后台进程，也不把 signal 交给 shell spec", async () => {
      const host = makeHost();
      applyPlugin(host);
      const controller = new AbortController();
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      const [proc] = host.shell.procs;
      // program 模式在程序结束时会 abort 活跃调用；后台评审若接了这枚 signal，
      // 就变成「随一次程序执行结束而停」，与后台语义矛盾。
      expect(host.shell.resolveCalls[0]?.signal).toBeUndefined();
      expect(proc?.killCount).toBe(0);
      controller.abort();
      expect(proc?.killCount, "abort 不再杀后台进程").toBe(0);
      expect(host.jobs.list()[0]?.status).toBe("running");
      proc?.settle();
      await settledTick();
    });

    it("剪枝抛错（注册表被重载换掉）⇒ 已起的进程先被收掉，不留无主 OCR", async () => {
      const host = makeHost();
      const real = host.jobs;
      host.jobs = registryWithThrowingList(real);
      applyPlugin(host);
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec()),
      ).rejects.toThrow(/registry reloaded/u);
      const [proc] = host.shell.procs;
      // 进程已经在 execute 那时起来了：剪枝/取文案抛错若不先 killProc，留下的是一条
      // 谁也看不见、谁也停不掉的 OCR 在烧 token。
      expect(proc?.killCount, "execute 之后的抛错必须先收进程").toBe(1);
      expect(real.list()).toStrictEqual([]);
    });

    it("默认无兜底窗口（0）⇒ 不向注册表登记 jobs.wait", async () => {
      const host = makeHost();
      const spy = registryRecordingWaits(host.jobs);
      host.jobs = spy.registry;
      applyPlugin(host);
      await toolOf(host, "ocr_scan").execute({ repo: "/repo", wait: false }, makeExec());
      expect(spy.waits).toStrictEqual([]);
      host.shell.procs[0]?.settle();
      await settledTick();
    });

    it("会话 dispose ⇒ 经注册表回收在跑的后台评审，reason 落进 detail", async () => {
      const host = makeHost();
      applyPlugin(host);
      const exec = ownExec(host, "s1");
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, exec);
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list(brandSessionId("s1"));
      expect(job?.status).toBe("running");
      expect(job?.owner, "会话发起的作业带 owner").toBe("s1");
      host.emit(SESSION_DISPOSED, { id: "s1" });
      // 经 registry.kill 而不是裸 proc.kill：名册里那条必须立刻显出"正在收"，
      // 否则观察者会一直以为它还在跑（实测这条曾经就是停在 running 的）。
      expect(host.jobs.get(onlyJob(job), brandSessionId("s1")).status).toBe("stopping");
      expect(proc?.killCount, "会话回收那一臂仍要把进程杀掉").toBe(1);
      proc?.settle();
      await settledTick();
      const [settled] = host.jobs.list(brandSessionId("s1"));
      expect(settled?.status).toBe("killed");
      // detail 的组成钉死（生产者结局在前、注册表追加 reason），reason 本体取字典：
      // 字典改文案不该让这条契约用例红，改**拼接次序**才该。
      expect(settled?.detail).toBe(`killed before exit; ${zh.jobReasonSessionStopped}`);
    });

    it("会话 dispose 只收自己的作业：别的会话与 agentless 都不动", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s1"));
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s2"));
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      expect(host.shell.procs).toHaveLength(3);
      const s1Job = host.jobs.list(brandSessionId("s1")).find((job) => job.owner === "s1");
      const s2Job = host.jobs.list(brandSessionId("s2")).find((job) => job.owner === "s2");
      const agentless = host.jobs.list().find((job) => job.owner === undefined);
      if (s1Job === undefined || s2Job === undefined || agentless === undefined) {
        throw new Error("三条作业都在册");
      }
      host.emit(SESSION_DISPOSED, { id: "s1" });
      expect(host.jobs.get(s1Job.id, brandSessionId("s1")).status, "s1 的作业被收").toBe(
        "stopping",
      );
      expect(host.jobs.get(s2Job.id, brandSessionId("s2")).status, "s2 的作业不动").toBe("running");
      expect(host.jobs.get(agentless.id).status, "agentless 作业不动").toBe("running");
      for (const proc of host.shell.procs) {
        proc.settle();
      }
      await settledTick();
    });

    it("agentless 作业不随任何会话 dispose 回收，随插件卸载一起收", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      host.emit(SESSION_DISPOSED, { id: "s1" });
      expect(host.jobs.get(onlyJob(job)).status, "agentless 不归这条会话").toBe("running");
      expect(proc?.killCount).toBe(0);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(host.jobs.get(onlyJob(job)).status, "卸载时统一收").toBe("stopping");
      expect(proc?.killCount).toBe(1);
      proc?.settle();
      await settledTick();
    });

    it("卸载收掉有主作业：别的会话起的后台评审也随插件卸载结束", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s1"));
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list(brandSessionId("s1"));
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(
        host.jobs.get(onlyJob(job), brandSessionId("s1")).status,
        "台账里的有主作业也要收",
      ).toBe("stopping");
      expect(proc?.killCount).toBe(1);
      proc?.settle();
      await settledTick();
    });

    it("卸载也移除有主作业的已落定记录", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s1"));
      const [proc] = host.shell.procs;
      proc?.settle();
      await settledTick();
      expect(host.jobs.list(brandSessionId("s1"))).toHaveLength(1);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(host.jobs.list(brandSessionId("s1")), "已落定记录随卸载移除").toStrictEqual([]);
    });

    it("会话 dispose 也移除该会话已落定的记录", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s1"));
      const [proc] = host.shell.procs;
      proc?.settle();
      await settledTick();
      host.emit(SESSION_DISPOSED, { id: "s1" });
      expect(host.jobs.list(brandSessionId("s1")), "会话的记录随会话回收").toStrictEqual([]);
      expect(proc?.killCount).toBe(0);
    });

    it("卸载不碰别的插件（别的 kind）的无主作业", async () => {
      const host = makeHost();
      const detach = host.jobs.attachController("test");
      const foreignGate = Promise.withResolvers<{ status: "completed" }>();
      const foreign = host.jobs.start({
        kind: "bash",
        label: "foreign",
        run: () => ({ cancel: noop(), done: foreignGate.promise }),
      });
      detach();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(host.jobs.get(foreign).status, "别的 kind 的作业不动").toBe("running");
      foreignGate.resolve({ status: "completed" });
      proc?.settle();
      await settledTick();
    });

    it("session/disposed 载荷认不出会话 ⇒ 一条作业都不动", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, ownExec(host, "s1"));
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list(brandSessionId("s1"));
      host.emit(SESSION_DISPOSED, {});
      expect(host.jobs.get(onlyJob(job), brandSessionId("s1")).status).toBe("running");
      host.emit(SESSION_DISPOSED, { id: "" });
      expect(host.jobs.get(onlyJob(job), brandSessionId("s1")).status).toBe("running");
      expect(proc?.killCount).toBe(0);
      proc?.settle();
      await settledTick();
    });

    it("注册表已经不认这些记录 ⇒ 会话回收就地收敛，不把异常抛给事件总线", async () => {
      const host = makeHost();
      const real = host.jobs;
      host.jobs = registryWithThrowingKill(real);
      applyPlugin(host);
      const exec = ownExec(host, "s1");
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, exec);
      const [proc] = host.shell.procs;
      const uncaught = await collectUncaught(async () => {
        host.emit(SESSION_DISPOSED, { id: "s1" });
      });
      // 事件处理器里抛出的错误由 Node 以 `process.nextTick(() => { throw err })` 重抛 ⇒ 未捕获
      // 异常 ⇒ **整个宿主进程退出**（本机实跑复现）。会话结束时再炸一次宿主没有任何补救价值，
      // 所以这一臂必须自己兜住。
      expect(uncaught, "会话回收链不许把异常交给 Node").toStrictEqual([]);
      // 注册表不认这些记录 ⇒ 手里没有进程句柄可杀，如实记录不假装收过。
      expect(proc?.killCount).toBe(0);
      expect(real.list(brandSessionId("s1"))[0]?.status, "名册归别人管时不假装收过了").toBe(
        "running",
      );
      // 收尾把这条活作业落定，别把泵留给别人（判据统一写在文件级 `afterEach` 那一处）。
      proc?.settle();
      await settledTick();
    });

    it("proc.kill 自己抛（ESRCH 那一类）⇒ 被 cancel 兜住，名册照样推到 stopping", async () => {
      const host = makeHost();
      applyPlugin(host);
      const exec = ownExec(host, "s1");
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, exec);
      const [proc] = host.shell.procs;
      if (proc === undefined) {
        throw new Error("后台评审没起出进程");
      }
      proc.kill = () => {
        throw new Error("ESRCH: no such process");
      };
      const [job] = host.jobs.list(brandSessionId("s1"));
      const uncaught = await collectUncaught(async () => {
        host.emit(SESSION_DISPOSED, { id: "s1" });
      });
      expect(uncaught).toStrictEqual([]);
      // 这条断言才是 `killProc` 自己的牙齿（而不是 `stop` 那层 catch 顺带兜住）：官方 `killJob`
      // 先调 `job.cancel()` 再把记录推到 stopping（installed dsh-jobs-local:611-622），
      // cancel 一抛那条就永远停在 running。
      expect(
        host.jobs.get(onlyJob(job), brandSessionId("s1")).status,
        "cancel 抛错不能把记录留在 running",
      ).toBe("stopping");
      // 收尾落定（判据统一写在文件级 `afterEach` 那一处）。
      proc.settle();
      await settledTick();
    });
  });

  // ── 后台评审登记为官方 ctx.jobs 作业 ─────────────────────────────────────

  describe("后台评审的官方作业面", () => {
    it("作业进注册表：kind/id/label 与两条流的环", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [job] = host.jobs.list();
      expect(String(job?.id)).toMatch(OCR_JOB_ID);
      expect(job?.kind).toBe(OCR_JOB_KIND);
      // label 是给 job_list 看的一行字：哪个工具 + 哪个仓库（命令串本身不外销）。
      expect(job?.label).toBe("ocr_review /repo");
      expect(job?.status).toBe("running");
      const [proc] = host.shell.procs;
      proc?.emit("stdout", "reviewing 12 files\n");
      proc?.emit("stderr", "warn: rate limit\n");
      proc?.settle();
      await settledTick();
      const read = host.jobs.readAt(onlyJob(job), 0);
      const byChannel = new Map<string, string>();
      for (const chunk of read.chunks) {
        byChannel.set(
          chunk.channel ?? "(none)",
          (byChannel.get(chunk.channel ?? "(none)") ?? "") + chunk.text,
        );
      }
      expect(byChannel.get("stdout")).toBe("reviewing 12 files\n");
      expect(byChannel.get("stderr")).toBe("warn: rate limit\n");
      const settled = host.jobs.get(onlyJob(job));
      // 注册表面的 `get()` 返回的就是记录本身（官方 d.ts 非可选，本文件别处也是直接取
      // 成员），且 `onlyJob` 已经先把「作业没登记」拦成响亮失败 ⇒ 这里不写 `?.`。
      expect(settled.status).toBe("completed");
      expect(settled.detail).toBe("exit code: 0");
    });

    it("历史窗口有界：每次登记前剪掉本 kind 最老的已落定记录", async () => {
      const host = makeHost();
      applyPlugin(host);
      // 铺场顺序受两处闸约束：容量闸只管"活的"（一次并发起 10 条到顶），窗口裁剪又只看
      // 已落定的条数 ⇒ 先并发起满 10 条并落定，再单起两条各次触发一次裁剪。
      const firstBatch = await startBackgroundRuns(host, 10);
      await settleBackgroundRuns(host, 0);
      // 剪枝跑在 `start` **之前**，剪到 HISTORY_MAX-1 条 ⇒ 起完正好 HISTORY_MAX 条在册。
      // 按 HISTORY_MAX 剪就是 HISTORY_MAX+1 条：README 的"只留最近 10 条"与卡片 404 文案
      // 说的都是在册上限，那一格是实现与文案的分歧（此前修的是剪枝边界，这条用例回到不变量）。
      const eleventh = await startBackgroundRuns(host, 1);
      expect(host.jobs.list().map((job) => String(job.id))).toStrictEqual([
        ...firstBatch.slice(1),
        ...eleventh,
      ]);
      await settleBackgroundRuns(host, 10);
      // 第 12 条登记时最老那条才走。注册表只在显式 remove 前保留落定记录 ⇒ 本包不剪就是
      // 每次评审永久留一条记录外加一只最多 256 KiB 的环。
      const twelfth = await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 11);
      const ids = host.jobs.list().map((job) => String(job.id));
      expect(ids).toStrictEqual([...firstBatch.slice(2), ...eleventh, ...twelfth]);
      expect(ids.length, "在册条数任何时刻都不越界").toBeLessThanOrEqual(HISTORY_MAX);
    });

    it("剪窗口只剪已落定的：正在跑与正在收的记录一条都不动", async () => {
      const host = makeHost();
      applyPlugin(host);
      await startBackgroundRuns(host, 1);
      const [running] = host.shell.procs;
      const [firstJob] = host.jobs.list();
      if (firstJob === undefined) {
        throw new Error("第一条评审作业未登记");
      }
      expect(host.jobs.kill(firstJob.id, undefined, "先停第一条")).toBe("requested");
      // 第一条停在 stopping（done 故意不落定）。此后并发起 9 条（1 stopping + 9 running
      // 正好到容量闸的 10），落定后再单起两条 ⇒ 两次裁剪都只能挑已落定的。
      await startBackgroundRuns(host, 9);
      await settleBackgroundRuns(host, 1);
      await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 10);
      await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 11);
      const ids = host.jobs.list().map((job) => `${String(job.id)}:${job.status}`);
      expect(ids).toContain(`${String(firstJob.id)}:stopping`);
      expect(running?.killCount, "取消只发过一次，裁剪不许再杀它").toBe(1);
    });

    it("宿主没装 ctx.jobs ⇒ 点名缺件，且绝不起进程", async () => {
      const host = makeHost({ jobs: false });
      applyPlugin(host);
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec()),
      ).rejects.toThrow(/no ctx\.jobs/u);
      expect(host.shell.procs).toHaveLength(0);
      expect(host.shell.resolveCalls).toHaveLength(0);
    });

    it("宿主没装 ctx.jobs 不影响前台评审（wait:true 不经过注册表）", async () => {
      // 准入条件若按「有没有 jobs」写，会把一条本来能跑的前台路径关掉。
      const host = makeHost({ jobs: false });
      applyPlugin(host);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      );
      expect((result as { status: string }).status).toBe("success");
    });

    it("注册表拒收（并发满员）⇒ 刚起的进程立刻被杀，错误照原样抛出", async () => {
      const host = makeHost();
      applyPlugin(host);
      // 用**别的 kind**把未拥有那一桶占满（实测容量按 owner 桶计，未拥有共用一桶）：
      // 本包的 start 会被官方件在 preflight 阶段拒掉。宿主 bash 生产者自己挂 controller
      // （本包起完就摘，不再替别人开着闸门），故这里也照它的样子挂一枚再摘。
      const detachBash = host.jobs.attachController("test: host bash tool");
      for (let index = 0; index < 10; index += 1) {
        host.jobs.start({
          kind: "bash",
          label: "filler",
          run: () => ({
            cancel: () => {
              noop();
            },
            done: voidPending(),
          }),
        });
      }
      detachBash();
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec()),
      ).rejects.toThrow(/background job limit reached/u);
      expect(host.shell.procs, "进程起在注册之前").toHaveLength(1);
      expect(host.shell.procs[0]?.killCount, "被拒的那条不能留在后台烧 token").toBe(1);
      expect(host.jobs.list().some((job) => job.kind === OCR_JOB_KIND)).toBe(false);
    });

    it("controller 只挂在 start 那一瞬：起完即摘，不给别的 caller 留大门", async () => {
      const host = makeHost();
      applyPlugin(host);
      const spec = {
        kind: OCR_JOB_KIND,
        label: "bare start",
        run: () => ({ cancel: noop, done: Promise.resolve({ status: "completed" as const }) }),
      };
      // 未经本包端点、也没有任何 controller 的裸 start 先被拒（官方那道闸）。
      expect(() => host.jobs.start(spec)).toThrow(/no job controller serves this agent/u);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      // 起完之后再裸 start 仍是拒：留一枚常驻 token 的后果是"宿主故意没装 job 工具"的
      // 组成里，本包替全宿主开着 start 的大门。
      expect(() => host.jobs.start(spec)).toThrow(/no job controller serves this agent/u);
    });

    it("卸载 effect 收掉仍在跑的评审：名册推到 stopping 并留下理由", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      expect(host.jobs.list()).toHaveLength(1);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(host.jobs.get(onlyJob(job)).status, "注册表随宿主活着，不杀它就永远停在 running").toBe(
        "stopping",
      );
      expect(proc?.killCount, "取消经 cancel() 落到 proc.kill").toBe(1);
      proc?.settle();
      await settledTick();
      // 理由取字典而不是复述中文串：改文案不该让这条契约用例红（zvec 同位早已如此）。
      expect(host.jobs.get(onlyJob(job)).detail).toContain(zh.jobReasonUnload);
    });

    it("卸载理由跟随官方 locale 偏好：en 会话里模型读到的是英文理由", async () => {
      // 这一臂的理由在**效应里**现取（`localeMessages(ctx).jobReasonUnload`，host.ts:1671），
      // 不是注册表自己造的 ⇒ 前面那条只覆盖了中文默认值，语言接线没人钉：把 `localeMessages`
      // 换成固定 `MESSAGES.zh` 时全套件仍全绿，而英文会话的模型会收到中文理由。
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      proc?.settle();
      await settledTick();
      expect(host.jobs.get(onlyJob(job)).detail).toContain(MESSAGES.en.jobReasonUnload);
    });

    it("卸载也 remove 已落定的记录：用户直接禁用本包时没有下一次 apply 来剪窗口", async () => {
      const host = makeHost();
      applyPlugin(host);
      const settledRun = await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 0);
      const liveRun = await startBackgroundRuns(host, 1);
      const [liveId] = liveRun;
      if (liveId === undefined) {
        throw new Error("第二条评审作业未登记");
      }
      // 卸载前的名册：一条已落定 + 一条在跑（窗口剪枝在登记前跑，1 条远没到上限）。
      expect(host.jobs.list().map((job) => String(job.id))).toStrictEqual([
        ...settledRun,
        ...liveRun,
      ]);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      // 两件事都做才叫回收：活着的经注册表 kill（推到 stopping、理由进 detail），已落定的
      // remove（连带那只最多 256 KiB 的环）。只 kill 不 remove 的后果——本包不留常驻
      // 状态，禁用后再没有 apply，留下的记录就是永久的。
      expect(host.jobs.list().map((job) => `${String(job.id)}:${job.status}`)).toStrictEqual([
        `${liveId}:stopping`,
      ]);
      expect(host.shell.procs[1]?.killCount, "在跑那条由 cancel() 收到进程").toBe(1);
      expect(host.shell.procs[0]?.killCount, "自然落定的那条不该被再杀一遍").toBe(0);
      // 收尾把停在 stopping 的那条落定（判据统一写在文件级 `afterEach` 那一处）。
      host.shell.procs[1]?.settle();
      await settledTick();
    });

    it("卸载时宿主已经没有 ctx.jobs ⇒ 效应安静跳过，不抛穿卸载", () => {
      // 服务被关掉那一档：卸载效应读到的就是 undefined。没有这条用例，那半个分支
      // 只在编译器里存在，v8 的块覆盖也看不见它。
      const host = makeHost({ jobs: false });
      // 前提钉子：这一档替身交不出注册表，用例走的才确实是「安静跳过」那一臂。
      expect(host.get("jobs")).toBeUndefined();
      applyPlugin(host);
      // 释放器确实登记了：主 fiber 上是作业回收两位（插件卸载、会话 dispose），
      // 五条端点的释放器挂在注入子 fiber 的 injectEffectDisposers 上；否则下面的循环
      // 是空转、覆盖是假象。
      expect(host.effectDisposers).toHaveLength(2);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      // 没有注册表可读 ⇒ 回收整条跳过：名册里一条记录都没被写过（真回收会留下 stopping/detail）。
      expect(host.jobs.list()).toStrictEqual([]);
    });

    it("会话 dispose 时宿主已经没有 ctx.jobs ⇒ 安静跳过，不抛穿事件总线", () => {
      const host = makeHost({ jobs: false });
      expect(host.get("jobs")).toBeUndefined();
      applyPlugin(host);
      // 监听器确实挂上了：否则下面的 emit 是空转、覆盖是假象。
      expect(host.listeners.has(SESSION_DISPOSED)).toBe(true);
      expect(() => {
        host.emit(SESSION_DISPOSED);
      }).not.toThrow();
      expect(host.jobs.list()).toStrictEqual([]);
    });

    it("兜底 deadline 到点：挂死的评审被经注册表收掉，理由进 detail", async () => {
      // 假定时器必须**在起作业之前**装好：`wait` 的内部定时器是 start 那一刻建的，晚装
      // 就追不上它。泵拍顺带拉长到一小时，否则推进两小时会把它白刷几万拍。
      const host = makeHost();
      // 默认窗口已是 0（不设时限），这条测的是「显式配了窗口时的兜底回收」，
      // 故显式把两小时写进 settingsValue。
      host.settingsValue["ocrBackgroundMaxMs"] = 120 * 60_000;
      host.jobs = makeJobRegistry(60 * 60_000);
      applyPlugin(host);
      vi.useFakeTimers();
      let proc: FakeProc | undefined;
      let job: { id: JobId } | undefined;
      try {
        await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
        [proc] = host.shell.procs;
        [job] = host.jobs.list();
        await vi.advanceTimersByTimeAsync(120 * 60_000 + 10);
        expect(host.jobs.get(onlyJob(job)).status, "到点应经注册表收，而不是绕过它杀进程").toBe(
          "stopping",
        );
        expect(proc?.killCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      proc?.settle();
      await settledTick();
      // 与上面"取消经注册表收"那条同形：整串钉死（生产者结局 + 注册表追加的 reason），reason
      // 按实际兜底窗口换算（这条用例自己配的 120 分钟，不写死文案里的"2 小时"）。原先只
      // `toContain(...)` 是字典值的一段 ⇒ 拼接次序坏了也不会红。
      expect(host.jobs.get(onlyJob(job)).detail).toBe(
        `killed before exit; ${format(MESSAGES.zh.jobReasonTimeout, { minutes: "120" })}`,
      );
    });

    it("周期泵真的在搬增量：两次 emit 不重不漏（readFrom 的游标算错就会红）", async () => {
      // 复核点出的盲区：若 emit 完就 settle，注册表只会跑"落定前最后一次排水"，
      // 把 readFrom(fromByte) 写成 readFrom(0)（每拍重灌全文）或 +1（每拍吞一字节）
      // 都能全绿。这条用例让泵带着内容跑两拍，直接把那种变异咬住。
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      proc?.emit("stdout", "alpha ");
      await pumpTick();
      proc?.emit("stdout", "beta");
      await pumpTick();
      const read = host.jobs.readAt(onlyJob(job), 0);
      expect(read.chunks.map((chunk) => chunk.text)).toStrictEqual(["alpha ", "beta"]);
      proc?.settle();
      await settledTick();
      expect(
        host.jobs
          .readAt(onlyJob(job), 0)
          .chunks.map((chunk) => chunk.text)
          .join(""),
        "落定前最后一次排水不许把已搬过的字节再来一遍",
      ).toBe("alpha beta");
    });

    it("执行器读者抛错 → 模型侧看到一次性说明，且不反复敲坏掉的读者", async () => {
      const host = makeHost();
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      proc?.emit("stdout", "before the reader broke");
      await pumpTick();
      proc?.failRead("stdout");
      await pumpTick();
      // 断"latch 之后一次都不再敲"，而不是"总共不超过 N 次"：N 那一档量的是**坏掉之前**
      // 拍了几次，而拍数随负载漂（本仓加过几条用例之后它就从 4 漂到 5 判红）。latch 在
      // host.ts 的 `if (failed) return`，它真正的可观测面是"撞坏之后读数不再增长"。
      const knocked = proc?.readCount("stdout") ?? 0;
      await pumpTick();
      await pumpTick();
      const texts = host.jobs
        .readAt(onlyJob(job), 0)
        .chunks.map((chunk) => chunk.text)
        .join("");
      expect(texts).toContain("before the reader broke");
      expect(texts).toContain("输出读取失败");
      expect(texts.match(/输出读取失败/gu), "说明只写一次，别每拍灌一条").toHaveLength(1);
      expect(proc?.readCount("stdout"), "坏掉的读者不该被继续敲").toBe(knocked);
    });
  });

  // ── review / scan 的文件预览 ────────────────────────────────────────────────

  describe("文件和扫描预览", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("review preview：走 --preview、返回拆分后的清单，不生成摘要", async () => {
      host.shell.scripts.push({ output: PREVIEW_JSON });
      const result = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", preview: true },
        makeExec(),
      )) as { totalFiles: number; reviewableFiles: unknown[]; excludedFiles: unknown[] };
      expect(String(host.shell.resolveCalls[0]?.command)).toContain(
        "review --audience agent --format json --preview",
      );
      expect(result.totalFiles).toBe(2);
      expect(result.reviewableFiles).toHaveLength(1);
      expect(result.excludedFiles).toHaveLength(1);
    });

    it("review preview + wait=false 直接拒绝；preview 错类型也拒绝；预览回执坏掉时回显说明", async () => {
      await expect(
        toolOf(host, "ocr_review").execute(
          { repo: "/repo", preview: true, wait: false },
          makeExec(),
        ),
      ).rejects.toThrow(/preview 是秒级前台操作/u);
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo", preview: "yes" }, makeExec()),
      ).rejects.toThrow(/preview 必须是布尔值/u);
      host.shell.scripts.push({ output: "not json" });
      const result = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", preview: true },
        makeExec(),
      )) as string;
      expect(result).toContain("preview 回执");
    });

    it("scan preview：同一份解析器；正常扫描的 no-* 开关进命令", async () => {
      host.shell.scripts.push({ output: PREVIEW_JSON });
      const result = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", preview: true, path: ["src"] },
        makeExec(),
      )) as { totalFiles: number };
      expect(result.totalFiles).toBe(2);
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("--preview");
      await expect(
        toolOf(host, "ocr_scan").execute({ repo: "/repo", preview: true, wait: false }, makeExec()),
      ).rejects.toThrow(/preview 是秒级前台操作/u);
      host.shell.scripts.push({ output: "not json" });
      const bad = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", preview: true },
        makeExec(),
      )) as string;
      expect(bad).toContain("preview 回执");
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", wait: true, noPlan: true, noDedup: true, noSummary: true },
        makeExec(),
      );
      const command = String(host.shell.resolveCalls.at(-1)?.command);
      expect(command).toContain("--no-plan");
      expect(command).toContain("--no-dedup");
      expect(command).toContain("--no-summary");
    });
  });

  // ── scan 工具 ───────────────────────────────────────────────────────────────

  describe("ocr_scan", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("前台扫描：--path 合并、结果聚合", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", path: ["src", "test"], wait: true },
        makeExec(),
      )) as { totalCommentCount: number };
      // 命令词可能是 PATH 上的裸 `ocr`，也可能是随包 launcher 的绝对路径；
      // 而 reaper 还要对整条内层再转义一次。故这里只钉子命令骨架与合并后的 path 列表，
      // 命令词的解析形态由 lib/cli.ts 自己的用例覆盖。
      const command = String(host.shell.resolveCalls[0]?.command);
      expect(command).toMatch(/scan --audience agent/u);
      expect(command).toContain("src,test");
      expect(result.totalCommentCount).toBe(1);
    });

    it("解析失败 ⇒ 回显脱敏原文；未写出文件 ⇒ 抛错且临时目录已清", async () => {
      host.shell.scripts.push({ output: "not json at all" });
      const failed = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as string;
      expect(failed).toMatch(/合法 JSON/u);
      const outPath = String(outputPathOf(String(host.shell.resolveCalls[0]?.command)));
      host.shell.scripts.push({});
      await expect(
        toolOf(host, "ocr_scan").execute({ repo: "/repo", wait: true }, makeExec()),
      ).rejects.toThrow(/未写出 --output 文件/u);
      expect(existsSync(path.dirname(outPath))).toBe(false);
    });

    it("wait=false 后台：tool 字段为 ocr_scan", async () => {
      const receipt = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", wait: false },
        makeExec(),
      )) as { tool: string };
      expect(receipt.tool).toBe("ocr_scan");
    });
  });

  // ── shell 错误映射 ──────────────────────────────────────────────────────────

  describe("runForeground 错误映射", () => {
    let host: FakeHost;
    let preview: FakeTool;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
      preview = toolOf(host, "ocr_delegate_preview");
    });

    it("超时 ⇒ 点名实际生效分钟数与行动建议", async () => {
      host.settingsValue["timeoutMinutes"] = 3;
      host.shell.scripts.push({ exitCode: null, timedOut: true });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /实际生效 3 分钟/u,
      );
    });

    it("宿主收口后 ⇒ 报收口值，不报请求值", async () => {
      // 请求 60 分钟，宿主按 shell.maxTimeoutMs 收口到 10 分钟：文案自称
      // 「实际生效」，就得印收口后的那个数——请求值只会把上限说成天文数字
      // （timeoutMinutes 留空时请求值是 2^31-1 ms，即 35791 分钟）。
      host.settingsValue["timeoutMinutes"] = 60;
      host.shell.maxTimeoutMs = 600_000;
      host.shell.scripts.push({ exitCode: null, timedOut: true });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /实际生效 10 分钟/u,
      );
      // 下发给宿主的仍是请求值本身（收口是宿主 resolve 的事）。
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBe(3_600_000);
    });

    it("请求值不超过上限时 ⇒ 原样报请求值", async () => {
      host.settingsValue["timeoutMinutes"] = 10;
      host.shell.maxTimeoutMs = 600_000;
      host.shell.scripts.push({ exitCode: null, timedOut: true });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /实际生效 10 分钟/u,
      );
    });

    it("aborted ⇒ 被中止；exit 127 ⇒ 安装指引", async () => {
      host.shell.scripts.push({ exitCode: null, aborted: true });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /被中止/u,
      );
      host.shell.scripts.push({ exitCode: 127 });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /命令不存在/u,
      );
    });

    it("其它退出码 ⇒ stderr（空则退 stdout）、超 800 字符走中间省略、全空只报退出码", async () => {
      host.shell.scripts.push({ exitCode: 1, stderrText: "boom: provider 未配置" });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /exit=1）：boom: provider 未配置/u,
      );
      host.shell.scripts.push({ exitCode: 2, stderrText: "", stdoutText: "y".repeat(900) });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /中间省略/u,
      );
      host.shell.scripts.push({ exitCode: 3, stderrText: "", stdoutText: "" });
      await expect(preview.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /^ocr 执行失败（exit=3）$/u,
      );
    });

    it("失败详情里的明文 key 先脱敏再截断", async () => {
      // key 摆在头部截断边界上：截断后头部只剩 key 的前 20 个码元，碎片不满足
      // STANDALONE_KEY 的 20 字符下限，先截断再脱敏时会原样留下；先脱敏时留下的是
      // 完整的 ***REDACTED*** 标记。
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: `HEAD ${"y".repeat(374)} ${PLAIN_KEY} ${"z".repeat(500)} tail`,
      });
      const error = (await preview
        .execute({ repo: "/repo", wait: true }, makeExec())
        .catch((error_: unknown) => error_ as Error)) as Error;
      expect(error.message).toMatch(/REDACTED/u);
      expect(error.message).not.toContain("sk-");
    });

    it("stdout 截断 ⇒ 追加截断说明，有落盘路径时一并给出", async () => {
      host.shell.scripts.push({ stdoutText: "partial", stdoutTruncated: true });
      // "partial" 不是合法 JSON ⇒ preview 走解析失败分支，诚实值就是那段说明字符串。
      const result = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as string;
      expect(result).toContain("已截断");
      expect(result).not.toContain("完整输出已落盘");
      host.shell.scripts.push({
        stdoutText: "partial",
        stdoutTruncated: true,
        stdoutSpillPath: "/tmp/spill.txt",
      });
      const spilled = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as string;
      expect(spilled).toContain("/tmp/spill.txt");
    });

    it("timeoutMinutes 非法 ⇒ 按 0 处理并请求宿主上限", async () => {
      host.settingsValue["timeoutMinutes"] = "soon";
      host.shell.scripts.push({ stdoutText: "{}" });
      await preview.execute({ repo: "/repo", wait: true }, makeExec());
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBe(2_147_483_647);
    });

    it("stdout 含 emoji 且被截断 ⇒ 工具结果不留孤立代理（会话日志会被永久毒化）", async () => {
      // 上游同缺陷：一个孤立高代理会让该会话之后的每次 Messages 请求都失败。
      // 判据按码点整枚走（for...of 迭代器）：配对成功的代理对交出的是合成码点
      // （>0xFFFF，必在代理区之外），被切开的孤枚半代理才以 D800–DFFF 的原值现形。
      // 代理区写成十进制分隔符形态：十六进制字面量在本仓被 oxfmt 判小写、被 oxlint
      // 的 number-literal-case 判大写，两条 gate 互斥（shared/lib/text.ts 同款处置）。
      const cjkEmoji =
        "审查结论：此处需修正\u{1F6D1}并补充测试\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(60);
      // 自守一：那 3 枚 ZWJ 是裸字符（上面这条是 brief 的逐字 fixture），它们撑着
      // 「周期 28 码元 ⇒ 500 = 17×28 + 24 正好切在 👧 的高代理上」这块地基。ZWJ 一旦被
      // 编辑器/format/sed 抹掉，周期变 25、500 % 25 === 0 ⇒ 切点落在合法对边界
      // （实测末枚变成配好的低代理 U+DC66），本用例就再也咬不住任何东西。
      expect(cjkEmoji).toHaveLength(1680);
      // 自守二：直接钉「裸 slice 在这儿确实切开了代理对」（500 = RAW_ECHO_LIMIT），
      // 与上一条互为备份。
      expect(cjkEmoji.slice(0, 500).isWellFormed()).toBe(false);
      host.shell.scripts.push({ stdoutText: cjkEmoji });
      const result = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as string;
      // 自守三：另两条空转通道——回显原文这条路真走了吗？真截断了吗？（parseDelegatePreview
      // 哪天收下这份输入就不进 echoRaw 分支；上限哪天形同不设也不留孤立代理。两种都白过。）
      expect(result).toContain("输出解析失败");
      expect(result.length).toBeLessThan(cjkEmoji.length);
      for (const char of result) {
        const point = char.codePointAt(0) ?? 0;
        expect(point >= 55_296 && point <= 57_343, `结果含孤立代理 U+${point.toString(16)}`).toBe(
          false,
        );
      }
    });

    it("失败详情（exit=2）的头尾两切各咬住一枚代理：不留孤立代理、省略号两侧都还在", async () => {
      // failureDetail 的 400/400 两处切点：1122 = 14 + 11×100 + 8，第 400 码元正好是 👨
      // 的高代理（裸前切留下它），倒数第 400 码元正好是 👩 的低代理（裸后切留下它）。
      // 两条裸 slice 的 isWellFormed 自守就是本用例的牙齿：切点哪天不咬代理对了，当场红。
      const detail = `头部哨兵${"·".repeat(10)}${FAMILY.repeat(100)}${"·".repeat(4)}尾部哨兵`;
      expect(detail).toHaveLength(1122);
      expect(detail.slice(0, 400).isWellFormed()).toBe(false);
      expect(detail.slice(-400).isWellFormed()).toBe(false);
      host.shell.scripts.push({ exitCode: 2, stderrText: detail });
      // 拒绝消息就是进会话日志的那一条，要的是全串而不是正则命中的一截。
      const message = String(
        await preview
          .execute({ repo: "/repo", wait: true }, makeExec())
          .catch((error: unknown) => error),
      );
      expect(message.isWellFormed()).toBe(true);
      const halves = message.split(zh.middleEllipsis);
      // 省略号只有一枚 ⇒ 头切与尾切都真的跑了。
      expect(halves).toHaveLength(2);
      const [headHalf = "", tailHalf = ""] = halves;
      // 两半的归属：把 truncateEnd 与 truncateStart 对调同样不留孤立代理（两个函数各自
      // 都是安全的），只会让前后内容掉头 ⇒ 这两条是那次对调的捕手。
      expect(headHalf).toContain("头部哨兵");
      expect(tailHalf).toContain("尾部哨兵");
      // 399 = 400 减掉 truncateStart 丢掉的那枚孤低代理。
      expect(tailHalf).toHaveLength(399);
    });
  });

  describe("delegate 与 session 的输出映射", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("preview：正常清单与不合契约的 JSON 两路", async () => {
      const preview = toolOf(host, "ocr_delegate_preview");
      host.shell.scripts.push({
        stdoutText: JSON.stringify({
          mode: "workspace",
          repository: "/repo",
          total_files: 1,
          merge_base: "abc",
          reviewable_files: [
            { path: "a.ts", status: "M", insertions: "3", deletions: 1 },
            "not-an-object",
            { status: "M", insertions: 1 },
          ],
          excluded_files: [{ path: "b.lock" }, "nope", { path: "" }],
        }),
      });
      const result = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as {
        mergeBase: string | null;
        reviewableCount: number;
        insertions: number;
        deletions: number;
        excludedFiles: unknown[];
      };
      expect(result.mergeBase).toBe("abc");
      expect(result.reviewableCount).toBe(1);
      expect(result.insertions).toBe(3);
      expect(result.deletions).toBe(1);
      expect(result.excludedFiles).toHaveLength(1);
      host.shell.scripts.push({ stdoutText: '{"error":"nope"}' });
      const bad = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as string;
      expect(bad).toMatch(/preview 输出解析失败/u);
    });

    it("preview：merge_base 缺席（omitempty）⇒ null，而不是缺字段", async () => {
      const preview = toolOf(host, "ocr_delegate_preview");
      host.shell.scripts.push({
        stdoutText: JSON.stringify({
          mode: "workspace",
          repository: "/repo",
          total_files: 0,
          reviewable_files: [],
        }),
      });
      const result = (await preview.execute({ repo: "/repo", wait: true }, makeExec())) as {
        mergeBase: string | null;
      };
      expect(result.mergeBase).toBeNull();
    });

    it("rule：分组结果与不合契约的 JSON 两路", async () => {
      const rule = toolOf(host, "ocr_delegate_rule");
      host.shell.scripts.push({
        stdoutText: JSON.stringify({
          schema_version: 1,
          groups: [
            { group_id: 1, source: "builtin", pattern: "*.ts", files: ["a.ts"], rule: "看空值" },
            { group_id: 2, source: "builtin", pattern: "*.go", files: [], rule: "空组丢弃" },
            "not-an-object",
          ],
        }),
      });
      const ok = (await rule.execute({ repo: "/repo", paths: ["a.ts"] }, makeExec())) as {
        groupCount: number;
      };
      expect(ok.groupCount).toBe(1);
      host.shell.scripts.push({ stdoutText: "[1,2]" });
      const bad = (await rule.execute({ repo: "/repo", paths: ["a.ts"] }, makeExec())) as string;
      expect(bad).toMatch(/rule 输出解析失败/u);
    });

    it("session：空会话提示、超长透传截断、action 白名单", async () => {
      const session = toolOf(host, "ocr_session");
      host.shell.scripts.push({ stdoutText: "null" });
      const empty = (await session.execute({ repo: "/repo" }, makeExec())) as {
        sessionOutput: string;
      };
      expect(empty.sessionOutput).toMatch(/暂无历史评审会话/u);
      host.shell.scripts.push({ stdoutText: `${PLAIN_KEY}${"x".repeat(12_500)}` });
      const long = (await session.execute({ repo: "/repo", action: "list" }, makeExec())) as {
        sessionOutput: string;
      };
      expect(long.sessionOutput).toContain("[截断]");
      expect(long.sessionOutput).not.toContain(PLAIN_KEY);
      host.shell.scripts.push({ stdoutText: `[{"session_id":"s","note":"${PLAIN_KEY}"}]` });
      const shown = (await session.execute(
        { repo: "/repo", action: "show", id: "s" },
        makeExec(),
      )) as { sessionOutput: string };
      expect(shown.sessionOutput).toContain("session_id");
      expect(shown.sessionOutput).not.toContain(PLAIN_KEY);
      await expect(
        session.execute({ repo: "/repo", action: "rm -rf /" }, makeExec()),
      ).rejects.toThrow(/action 非法/u);
    });

    it("session compare：结构化四桶，compare 子命令带两个 -- 后的位置参数", async () => {
      const session = toolOf(host, "ocr_session");
      host.shell.scripts.push({ stdoutText: COMPARE_JSON });
      const result = (await session.execute(
        { repo: "/repo", action: "compare", before: "b", after: "a" },
        makeExec(),
      )) as { before: { sessionId: string }; counts: { new: number; resolved: number } };
      expect(result.before.sessionId).toBe("b");
      expect(result.counts).toStrictEqual({ new: 1, persisting: 0, resolved: 1, notReviewed: 0 });
      expect(String(host.shell.resolveCalls[0]?.command)).toContain(
        "session compare --json --repo '/repo' -- 'b' 'a'",
      );
      await expect(
        session.execute({ repo: "/repo", action: "compare", before: "b" }, makeExec()),
      ).rejects.toThrow(/需要同时给出 before 与 after/u);
      // 退出 0 但回执不是四桶 JSON：原样回显，不把坏回执说成「没有变化」。
      host.shell.scripts.push({ stdoutText: "not json" });
      const bad = (await session.execute(
        { repo: "/repo", action: "compare", before: "b", after: "a" },
        makeExec(),
      )) as { sessionOutput: string; hint: string };
      expect(bad.sessionOutput).toContain("not json");
      expect(bad.hint).toContain("new");
    });

    it("session export：返回 HTML 路径；comments 的 severity/category 进命令", async () => {
      const session = toolOf(host, "ocr_session");
      host.shell.scripts.push({});
      const exported = (await session.execute(
        { repo: "/repo", action: "export", id: "s1" },
        makeExec(),
      )) as { sessionOutput: string };
      expect(exported.sessionOutput.endsWith(path.join("review.html"))).toBe(true);
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("session export");
      rmSync(path.dirname(exported.sessionOutput), { recursive: true, force: true });
      host.shell.scripts.push({ stdoutText: "[]" });
      await session.execute(
        {
          repo: "/repo",
          action: "comments",
          id: "s1",
          severity: ["high"],
          category: ["bug"],
        },
        makeExec(),
      );
      const command = String(host.shell.resolveCalls.at(-1)?.command);
      expect(command).toContain("--severity 'high'");
      expect(command).toContain("--category 'bug'");
      expect(command).toContain("-- 's1'");
      // export 子进程失败：拒绝并且不把半成品路径交出去。
      host.shell.scripts.push({ exitCode: 1, stderrText: "export failed" });
      await expect(
        session.execute({ repo: "/repo", action: "export", id: "s1" }, makeExec()),
      ).rejects.toThrow(/export failed/u);
    });
  });

  describe("规则诊断与 LLM 诊断", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("rules check：走 --repo 与 -- 后的文件路径，原样回显", async () => {
      host.shell.scripts.push({ stdoutText: "File: src/a.ts\nSource: System built-in\n" });
      const result = (await toolOf(host, "ocr_rules_check").execute(
        { repo: "/repo", path: "src/a.ts" },
        makeExec(),
      )) as { output: string; hint: string };
      expect(result.output).toContain("Source: System built-in");
      expect(result.hint).toContain("Source");
      expect(String(host.shell.resolveCalls[0]?.command)).toContain(
        "rules check --repo '/repo' -- 'src/a.ts'",
      );
      host.shell.scripts.push({ stdoutText: "x".repeat(12_001) });
      const long = (await toolOf(host, "ocr_rules_check").execute(
        { repo: "/repo", path: "src/a.ts" },
        makeExec(),
      )) as { output: string };
      expect(long.output).toContain("[截断]");
    });

    it("llm：providers/models 走只读命令；非法 action 拒绝", async () => {
      host.shell.scripts.push({ stdoutText: "Built-in providers:\n" });
      const providers = (await toolOf(host, "ocr_llm").execute(
        { action: "providers" },
        makeExec(),
      )) as { output: string };
      expect(providers.output).toContain("Built-in providers");
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("llm providers --color never");
      host.shell.scripts.push({ stdoutText: "gpt-6\n" });
      await toolOf(host, "ocr_llm").execute({ action: "models" }, makeExec());
      expect(String(host.shell.resolveCalls.at(-1)?.command)).toContain("llm models --color never");
      host.shell.scripts.push({ stdoutText: "y".repeat(12_001) });
      const long = (await toolOf(host, "ocr_llm").execute({ action: "providers" }, makeExec())) as {
        output: string;
      };
      expect(long.output).toContain("[截断]");
      await expect(toolOf(host, "ocr_llm").execute({ action: "test" }, makeExec())).rejects.toThrow(
        /action 非法/u,
      );
      await expect(toolOf(host, "ocr_llm").execute({ action: 3 }, makeExec())).rejects.toThrow(
        /action 非法/u,
      );
    });
  });

  // ── webServer 端点 ──────────────────────────────────────────────────────────

  describe("createGateway 的官方通道门面", () => {
    type GatewayArg = Parameters<typeof createGateway>[0];

    it("health 如实报告两个服务的装配状态", () => {
      expect(createGateway(makeHost() as unknown as GatewayArg).health()).toStrictEqual({
        settings: true,
        credentials: true,
      });
      expect(
        createGateway(
          makeHost({ settingsService: false, credentialsService: false }) as unknown as GatewayArg,
        ).health(),
      ).toStrictEqual({ settings: false, credentials: false });
    });

    it("descriptors() 原样透传 settings.describe()（不做任何 YAML 再解析）", () => {
      const gateway = createGateway(makeHost() as unknown as GatewayArg);
      expect(gateway.descriptors().map((descriptor) => descriptor.ns)).toContain("llm-pi-ai");
    });

    it("descriptors() 在 settings 服务缺席时抛可读错，不返回空表", () => {
      const gateway = createGateway(makeHost({ settingsService: false }) as unknown as GatewayArg);
      expect(() => gateway.descriptors()).toThrow(/设置服务/u);
    });

    it("credentialConfigured 走 describe、credentialSource 走 resolve，只回存在性/层 id", async () => {
      const host = makeHost();
      const gateway = createGateway(host as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(true);
      await expect(gateway.credentialSource("AMD_API_KEY")).resolves.toBe("file");
      await expect(gateway.credentialConfigured("MISSING_KEY")).resolves.toBe(false);
      await expect(gateway.credentialSource("MISSING_KEY")).resolves.toBeUndefined();
      expect(host.describedRefs).toStrictEqual(["AMD_API_KEY", "MISSING_KEY"]);
      expect(host.resolvedRefs).toStrictEqual(["AMD_API_KEY", "MISSING_KEY"]);
    });

    it("服务缺席时两个凭据问题一律降级（false / undefined，不抛）", async () => {
      const gateway = createGateway(
        makeHost({ credentialsService: false }) as unknown as GatewayArg,
      );
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(false);
      await expect(gateway.credentialSource("AMD_API_KEY")).resolves.toBeUndefined();
    });

    it("不合 ref 语法的名不去烦凭据服务（官方 isCredentialRefName 的语义）", async () => {
      const host = makeHost();
      const gateway = createGateway(host as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("9BAD-KEY")).resolves.toBe(false);
      await expect(gateway.credentialSource("")).resolves.toBeUndefined();
      expect(host.describedRefs).toStrictEqual([]);
      expect(host.resolvedRefs).toStrictEqual([]);
    });

    it("resolve 命中但值为空串 ⇒ 按未配置处理（凭据层「空值即不存在」的同款规则）", async () => {
      const gateway = createGateway(makeHost({ emptyValue: true }) as unknown as GatewayArg);
      await expect(gateway.credentialSource("AMD_API_KEY")).resolves.toBeUndefined();
    });

    it("凭据服务 describe 抛错 ⇒ 与「未配置」同一降级面，不外抛成 500", async () => {
      const gateway = createGateway(makeHost({ credentialsReject: true }) as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(false);
    });

    it("凭据服务 resolve 抛错 ⇒ 按未配置处理（应用据此拒绝，热路径不炸）", async () => {
      const gateway = createGateway(makeHost({ credentialsReject: true }) as unknown as GatewayArg);
      await expect(gateway.credentialSource("AMD_API_KEY")).resolves.toBeUndefined();
    });
  });

  describe("外部 CLI 版本核对：实测值让模型也看得见", () => {
    it("实测与核对版本不同 ⇒ 摘要的 hint 尾部多出那一句，并把两个数字都写出来", async () => {
      const host = await hostWithMeasuredVersion("open-code-review 9.9.9 darwin/arm64\n");
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as {
        hint: string;
      };
      expect(ok.hint.startsWith(zh.reviewSummaryHint)).toBe(true);
      expect(ok.hint).toContain("9.9.9");
      expect(ok.hint).toContain(EXPECTED_OCR_CLI_VERSION);
    });

    it("实测就是核对的那一版 ⇒ hint 一字不多（不给模型编一个没发生过的问题）", async () => {
      const host = await hostWithMeasuredVersion(VERSION_OK_OUT);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as {
        hint: string;
      };
      expect(ok.hint).toBe(zh.reviewSummaryHint);
    });

    it("没测过（自检关着又没点检测）⇒ 不报任何版本结论，也不因此少给一份摘要", async () => {
      const host = makeHost();
      applyPlugin(host);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as {
        hint: string;
      };
      expect(ok.hint).toBe(zh.reviewSummaryHint);
      expect(host.shell.resolveCalls).toHaveLength(1);
    });

    it("装载期自检的 shell 基础设施故障不产生未处理 rejection（自检失败不许杀宿主）", async () => {
      const host = makeHost();
      host.settingsValue["startupVerify"] = true;
      // 端点自检先、版本探测后：两条探测各消费一条脚本，都在 result() 上抛。
      host.shell.scripts.push(
        { throws: new Error("shell down") },
        { throws: new Error("shell down") },
      );
      const rejections = await collectUnhandledRejections(async () => {
        applyPlugin(host);
        await settledTick();
      });
      expect(
        rejections,
        "fire-and-forget 自检漏 catch 会把未处理 rejection 交给 Node",
      ).toStrictEqual([]);
      // 两次探测都真发起了：否则上面的空数组只是「没跑」而不是「跑过且没漏」。
      expect(host.shell.resolveCalls).toHaveLength(2);
      const service = host.provided.get(OCR_REMOTE_NAMESPACE) as
        | { providers: () => Promise<Record<string, unknown>> }
        | undefined;
      const body = await service?.providers();
      // 结论留空 = 卡片显示「未检测」：失败不许被写成成功，也不许把装载拖挂。
      expect(body?.["endpointVerify"]).toBeNull();
    });

    it("ocr_scan 走同一句：两个自驱 LLM 的工具都吃同一份实测值", async () => {
      const host = await hostWithMeasuredVersion("open-code-review 0.0.1 linux/amd64\n");
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as {
        hint: string;
      };
      expect(ok.hint).toContain("0.0.1");
    });
  });

  // ── i18n：host 半文案随官方 locale 偏好切换（zh 为默认，en 为补齐）────────────
  describe("host 文案双语（describe() 里 locale 那条的偏好）", () => {
    it("preference=en-US：工具 description 与参数说明整份是英文，不残留中文", () => {
      const host = makeHost({ locale: { preference: "en-US" } });
      applyPlugin(host);
      const review = toolOf(host, "ocr_review");
      expect(review.description).toBe(MESSAGES.en.reviewToolDescription);
      expect(JSON.stringify(review.parameters)).not.toMatch(/[\u4E00-\u9FFF]/u);
      // tuningParams 的 {unit} 插值在两语下都被换成实际量词（不留下裸占位符）。
      const concurrency = (
        review.parameters as { properties: { concurrency: { description: string } } }
      ).properties.concurrency.description;
      expect(concurrency).toBe("Concurrent group count (OCR --concurrency; unset = OCR native 8)");
      expect(toolOf(host, "ocr_scan").description).toBe(MESSAGES.en.scanToolDescription);
      expect(JSON.stringify(toolOf(host, "ocr_scan").parameters)).toContain("Per-file tool-call");
      expect(host.sections[0]?.text).toBe(MESSAGES.en.routingText);
    });

    it("locale 未注册或 preference 为中文系 ⇒ 中文默认（未注册不抛）", () => {
      const unset = makeHost();
      applyPlugin(unset);
      expect(toolOf(unset, "ocr_review").description).toBe(MESSAGES.zh.reviewToolDescription);
      expect(unset.sections[0]?.text).toBe(MESSAGES.zh.routingText);
      const explicit = makeHost({ locale: { preference: "zh-Hans-CN" } });
      applyPlugin(explicit);
      expect(toolOf(explicit, "ocr_session").description).toBe(MESSAGES.zh.sessionToolDescription);
      const bogus = makeHost({ locale: { preference: "klingon" } });
      applyPlugin(bogus);
      expect(toolOf(bogus, "ocr_scan").description).toBe(MESSAGES.zh.scanToolDescription);
    });

    it("执行期回显按当前语言：超时、解析失败（脱敏与截断次序不变）、hint 全英文", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      const review = toolOf(host, "ocr_review");
      host.settingsValue["timeoutMinutes"] = 2;
      host.shell.scripts.push({ exitCode: null, timedOut: true });
      await expect(review.execute({ repo: "/repo", wait: true }, makeExec())).rejects.toThrow(
        /^ocr timed out \(effective 2 min = min\(request, shell\.maxTimeoutMs\)\)/u,
      );
      host.shell.scripts.push({ output: `{"error":"auth failed api_key=${PLAIN_KEY}"}` });
      const failed = (await review.execute({ repo: "/repo", wait: true }, makeExec())) as string;
      expect(failed).toMatch(
        /ocr output parsing failed: OCR output has an invalid or missing status: \(none\)/u,
      );
      // 单位口径锁：{limit} 插的是 RAW_ECHO_LIMIT=500，而 echoRaw→truncateEnd 那一刀按
      // **UTF-16 码元**数计（一张 emoji 占 2 枚）——写 "characters"/"字符" 会把给模型的说明
      // 夸大约一倍。故这里钉的是单位词本身：换成"码元"以外的任何写法这条就红。
      expect(failed).toContain("first 500 UTF-16 code units of the raw output (redacted)");
      expect(failed).not.toContain(PLAIN_KEY);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await review.execute({ repo: "/repo", wait: true }, makeExec())) as {
        hint: string;
      };
      expect(ok.hint).toBe(MESSAGES.en.reviewSummaryHint);
    });

    it("命令构造层的拒绝理由也随 en（绝对路径 / 错类型 / 空清单三类闸判定不变）", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      const review = toolOf(host, "ocr_review");
      await expect(review.execute({ repo: "relative" }, makeExec())).rejects.toThrow(
        "repo must be an absolute path: relative",
      );
      await expect(review.execute({ repo: "/repo", commit: 12_345 }, makeExec())).rejects.toThrow(
        "commit must be a string (got 12345)",
      );
      await expect(
        toolOf(host, "ocr_delegate_rule").execute({ repo: "/repo", paths: [] }, makeExec()),
      ).rejects.toThrow("paths is required");
      // 同一份入参在中文那份下同判同抛，只是文案不同。
      const zhHost = makeHost();
      applyPlugin(zhHost);
      await expect(
        toolOf(zhHost, "ocr_review").execute({ repo: "relative" }, makeExec()),
      ).rejects.toThrow("repo 必须是绝对路径：relative");
    });

    it("后台回执 / delegate / session 的回显同样按 en，且明文 key 绝不出门", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      const receipt = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        makeExec(),
      )) as { polling: string };
      expect(receipt.polling).toBe(MESSAGES.en.backgroundPolling);
      const preview = toolOf(host, "ocr_delegate_preview");
      host.shell.scripts.push({ stdoutText: '{"error":"nope"}' });
      const badPreview = (await preview.execute(
        { repo: "/repo", wait: true },
        makeExec(),
      )) as string;
      expect(badPreview).toMatch(/^ocr delegate preview output parsing failed/u);
      const rule = toolOf(host, "ocr_delegate_rule");
      host.shell.scripts.push({
        stdoutText: JSON.stringify({ groups: [{ files: ["a.ts"], rule: "r" }] }),
      });
      const goodRule = (await rule.execute({ repo: "/repo", paths: ["a.ts"] }, makeExec())) as {
        hint: string;
      };
      expect(goodRule.hint).toBe(MESSAGES.en.ruleHint);
      const session = toolOf(host, "ocr_session");
      host.shell.scripts.push({ stdoutText: "null" });
      const empty = (await session.execute({ repo: "/repo" }, makeExec())) as {
        sessionOutput: string;
        hint: string;
      };
      expect(empty.sessionOutput).toBe(MESSAGES.en.sessionEmpty);
      expect(empty.hint).toBe(MESSAGES.en.sessionResumeHint);
    });
  });

  describe("部署值：stdoutMaxBytes / llmTestTimeoutMs / ocrBackgroundMaxMs", () => {
    it("默认：前台 stdout 上限 400k，截断说明报同一个数", async () => {
      const host = makeHost();
      applyPlugin(host);
      host.shell.scripts.push({ stdoutText: "partial", stdoutTruncated: true });
      const text = (await toolOf(host, "ocr_delegate_preview").execute(
        { repo: "/repo" },
        makeExec(),
      )) as string;
      expect(host.shell.resolveCalls[0]?.stdoutMaxBytes).toBe(400_000);
      expect(text).toContain("400000");
    });

    it("行 config 覆盖：resolve 的 stdoutMaxBytes 与截断说明都按行值走", async () => {
      const host = makeHost();
      host.settingsValue["stdoutMaxBytes"] = 1234;
      applyPlugin(host);
      host.shell.scripts.push({ stdoutText: "partial", stdoutTruncated: true });
      const text = (await toolOf(host, "ocr_delegate_preview").execute(
        { repo: "/repo" },
        makeExec(),
      )) as string;
      expect(host.shell.resolveCalls[0]?.stdoutMaxBytes).toBe(1234);
      // 报数失真 = 模型按错的余量规划检索：说明里必须是配置值，而不是写死的 400k。
      expect(text).toContain("1234");
      expect(text).not.toContain("400000");
    });

    it("行 config 覆盖：后台缓冲上限与 enforceOcrDeadline 的兜底窗口同一来源", async () => {
      const host = makeHost();
      host.settingsValue["stdoutMaxBytes"] = 4321;
      host.settingsValue["ocrBackgroundMaxMs"] = 5000;
      const spy = registryRecordingWaits(host.jobs);
      host.jobs = spy.registry;
      applyPlugin(host);
      await toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec());
      expect(host.shell.resolveCalls[0]?.stdoutMaxBytes).toBe(4321);
      expect(spy.waits[0]).toBe(5000);
    });

    it("三个新字段都不标 volatile ⇒ 不进设置卡表单", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      expect(form?.toSorted()).toStrictEqual(EDITABLE);
      for (const key of DEPLOYMENT) {
        expect(configDict()[key]?.meta?.["volatile"]).toBeUndefined();
      }
    });
  });
  describe("外部 CLI 可用性前置：两条路都没有候选时不起进程", () => {
    /** 七个工具各自的必填形态（与它们各自的入参闸一致，只为了让 run 走到前置这一行）。 */
    const TOOL_ARGS: Record<string, Record<string, unknown>> = {
      ocr_review: { repo: "/repo" },
      ocr_scan: { repo: "/repo" },
      ocr_delegate_preview: { repo: "/repo" },
      ocr_delegate_rule: { repo: "/repo", paths: ["src/a.ts"] },
      ocr_session: { repo: "/repo", action: "list" },
      ocr_rules_check: { repo: "/repo", path: "src/a.ts" },
      ocr_llm: { action: "providers" },
    };

    it("none ⇒ 七个工具一律拒绝，且连一次 resolve 都没发生", async () => {
      const host = makeHost();
      applyPlugin(host, noneProbe);
      // 七个调用并发跑（用例面的 no-await-in-loop：串行 await 只是把同一批断言排成
      // 一条更慢的链），失败原因逐个收成消息串再整体比对，免掉逐条 try/catch 留下的分支。
      const reasons = await Promise.all(
        Object.entries(TOOL_ARGS).map(([name, args]) =>
          toolOf(host, name)
            .execute(args, makeExec())
            .catch((error: unknown): string => (error as Error).message),
        ),
      );
      expect(
        reasons.every((message) => message === reasons[0]),
        "七处拒绝理由该是同一句",
      ).toBe(true);
      // 拒绝里必须带着**能照着敲**的装法，而且 npm 那条带版本：用户（或模型）拿到这句话
      // 就能装对，不必再去翻文档核对「哪个版本才是插件按着写的」。
      const npm = `npm i -g @alibaba-group/open-code-review@${EXPECTED_OCR_CLI_VERSION}`;
      expect(reasons[0]).toContain(npm);
      expect(reasons[0]).toContain(BREW_INSTALL);
      // 钉的是这条短路自己的契约：没找到候选就不该有 shell 请求。
      expect(host.shell.resolveCalls).toStrictEqual([]);
    });

    it("path 命中那一档照常执行（短路只认 none）", async () => {
      const host = makeHost();
      applyPlugin(host, pathProbe);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: true },
        makeExec(),
      );
      expect(result).toBeTypeOf("object");
      expect(host.shell.resolveCalls).toHaveLength(1);
    });

    it("assertOcrPresent：bundled 与 path 放行，none 抛并把装法原文带进消息", () => {
      const install = BREW_INSTALL;
      expect(() => {
        assertOcrPresent({ source: "bundled", path: "/x", channel: "npm" }, zh, install);
      }).not.toThrow();
      expect(() => {
        assertOcrPresent({ source: "path", path: "/x", channel: "brew" }, zh, install);
      }).not.toThrow();
      expect(() => {
        assertOcrPresent({ source: "none" }, zh, install);
      }).toThrow(format(zh.ocrBinaryMissing, { install }));
    });

    it("生产现读口逐字等于 lib/cli.ts 那份 fs 判据", () => {
      // 两次独立调用在同一进程里必须给出同一个判定：这条既把「默认口用的是那份判据」
      // 钉住，又不需要用例去分支这台机器恰好装没装 ocr。
      expect(productionProbe()).toStrictEqual(resolveOcrAvailability());
    });

    it("入口形状：cordis 交两参，现读口在入口这一层接上", () => {
      const host = makeHost();
      expect(plugin.apply).toHaveLength(2);
      (plugin as unknown as { apply: (ctx: unknown, config: unknown) => void }).apply(
        host,
        liveConfig(host),
      );
      // 注册期不问可用性（装载不该被一个外部 CLI 拖下线），所以到这里仍没有任何 shell 请求。
      expect(host.registeredTools.map((tool) => tool.name)).toStrictEqual([
        "ocr_review",
        "ocr_scan",
        "ocr_delegate_preview",
        "ocr_delegate_rule",
        "ocr_session",
        "ocr_rules_check",
        "ocr_llm",
      ]);
      expect(host.shell.resolveCalls).toStrictEqual([]);
    });
  });
});
