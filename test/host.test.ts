// host.ts 集成测试：注册面 + 5 个工具执行路径 + 4 个 webServer 端点。
//
// 关键约束：**绝不触碰外部 ocr 二进制与网络**。shell.execute 全是替身，
// 断言的是「下发给宿主的命令串形态」与「结果映射」；--output 落盘文件由替身按
// 命令里的路径反写（这正是真实 OCR 的契约：exit 0 ⇒ 该路径有 JSON）。
//
// provider 清单与 key 状态同样走替身：本包已经不读 settings.yaml /
// .credentials.yaml，宿主替身给出 settings.describe() 的返回值与 ctx.credentials
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
  statSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { JobId, JobKind } from "@deepseek-ai/dsh-jobs";
import { PI_AI_SETTINGS_VALUE, descriptorsWithValue } from "./fixtures/settings-fixture.ts";
import { MESSAGES } from "../lib/messages.ts";

/**
 * 临时 home 沙箱：宿主侧 `.dsh/` 与外部 ocr CLI 的 `.opencodereview/` 都在这里，
 * 且必须在 `await import("../host.ts")` 之前就位（插件按 os.homedir() 派生配置位置）。
 * @returns 已建好两个子目录的临时 home 根
 */
function makeSandboxHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "ocr-review-host-"));
  mkdirSync(path.join(home, ".dsh"), { recursive: true });
  mkdirSync(path.join(home, ".opencodereview"), { recursive: true });
  return home;
}

const HOME = makeSandboxHome();
process.env["HOME"] = HOME;

const HOST_MODULE = await import("../host.ts");
const {
  default: plugin,
  createGateway,
  ocrRepo,
  parseJsonBody,
  registerConfigEndpoints,
  requiredKeys,
} = HOST_MODULE;

// host 侧双语：直接被单测调到的两个纯函数按「host 注入哪一份」显式传表，
// 其余文案走 apply 的官方 locale 偏好替身（makeHost({ locale: { preference } })）。
const { zh } = MESSAGES;

const OCR_CONFIG = path.join(HOME, ".opencodereview", "config.json");
const CSRF_HEADER = "x-ocr-csrf";
const PROVIDERS_PATH = "/_dsh/ocr-review/providers";
const SELECT_PATH = "/_dsh/ocr-review/select";
const MIGRATE_PATH = "/_dsh/ocr-review/migrate";
const TEST_PATH = "/_dsh/ocr-review/test";
/** sec-fetch-site 的两个取值：跨站那一条必须被端点拒掉，同源才放行（写端点另加 CSRF 头）。 */
const FETCH_SITE_CROSS_SITE = "cross-site";
const FETCH_SITE_SAME_ORIGIN = "same-origin";
/** fixture 里两条 provider 的模型 id（amd 那条带真实型号的大小写混排形态，钳制用例靠它）。 */
const SENSENOVA_MODEL = "deepseek-v4-flash";
const AMD_MODEL = "DeepSeek-V4-Flash";
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

interface ConfigDoc {
  provider?: string;
  language?: string;
  custom_providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

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

interface FakeShell {
  resolveCalls: ResolveCall[];
  scripts: RunScript[];
  procs: FakeProc[];
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

/** 本包作业的官方 id 序列（`<kind>-N`：kind 是 `ocr-review`，计数器按**注册表实例**从 1 起，
 *  字形由下面作业面那段那条 `toBe("ocr-review-1")` 钉着，少一根连字符即红）。
 *  @param from 起始序号（含）
 *  @param to 结束序号（含）
 *  @returns 形如 `["ocr-review-2", "ocr-review-3"]` 的 id 表 */
function ocrIds(from: number, to: number): string[] {
  const ids: string[] = [];
  for (let index = from; index <= to; index += 1) {
    ids.push(`ocr-review-${index}`);
  }
  return ids;
}

/**
 * 官方注册表的**实现本身**，不是假件：替身若按"我以为的官方语义"写，测的就是我的理解。
 * 真件让"后台评审可被 job_list/job_output/job_kill 观察"这条契约钉在真行为上；
 * 逐条实测语义见 plugins/docs/harness/f3-equiv/probe-jobs.mjs。
 */
function makeJobRegistry(pumpPollMs = PUMP_MS): LocalJobRegistry {
  return new LocalJobRegistry(new Context(), registryDefaults({ pumpPollMs }));
}

/**
 * 评审进行中 `ctx.jobs` 那一行被重载/关掉的那一档：读侧全部转给真件，只有 `kill` 照官方
 * 对陌生 id 的字形抛（installed dsh-jobs-local/lib/index.js:554-558 的 `expect`）。
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
      throw new Error("unknown job ocr-review-1");
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
      shell.resolveCalls.push(spec);
      return spec;
    },
    // 0.1.7：execute 是前后台唯一入口。分流判据沿用宿主自身的分工——前台带
    // timeoutMs（deadline），后台（wait=false）不带、且从不 await result()。
    // result() 即旧 run() 的落点：脚本队列仍按发起序 shift，抛点与输出落盘都不变。
    async execute(spec) {
      const call = spec as ResolveCall;
      const proc = deferredProc(async () => {
        const script = shell.scripts.shift() ?? {};
        if (script.throws !== undefined) {
          // oxlint-disable-next-line typescript/only-throw-error -- 负向用例要的就是非 Error 抛出值：只有它能走通 shared 的 errorText 那条 String(error) 支（真实 shell 服务异常时并不保证抛 Error），换成 new Error(…) 就测不到那一位
          throw script.throws;
        }
        const outPath = outputPathOf(call.command);
        if (outPath !== undefined && script.output !== undefined) {
          writeFileSync(outPath, script.output);
        }
        return {
          exitCode: script.exitCode ?? 0,
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
  /** ctx.effect 登记的释放器（卸载用例要手动跑一遍）。 */
  effectDisposers: (() => void)[];
  /** `inject(...)` 子 fiber 的 effect 登记的释放器。与上面**分开存**：混在一队就分不出
   *  「释放器挂在谁身上」，而四条路由的释放器必须挂在子 fiber 上（webServer 换实例时
   *  子 fiber 先卸后装，主 fiber 的效应那时还没轮到）。 */
  injectEffectDisposers: (() => void)[];
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
}

/** 宿主替身的可选项：两个官方通道的装配状态与回答。 */
interface FakeHostOptions {
  webServer?: boolean;
  /** webServer 服务替身的 `host` 成员（官方唯一可读的非回环信号）。缺省 = undefined，
   *  即"没声明绑到哪张网卡"；给 `"0.0.0.0"` 才让 `servingNonLoopback` 那道锁真的合上。 */
  webServerHost?: string;
  /** false ⇒ get("settings") 拿不到服务（未装配 settings 的 profile）。 */
  settingsService?: boolean;
  /** true ⇒ get("settings") 首次可用、之后消失（探测后被卸载的竞态）。 */
  settingsVanishes?: boolean;
  /** false ⇒ get("credentials") 缺席（非 web profile / 精简 bundle）。 */
  credentialsService?: boolean;
  /** true ⇒ 凭据服务只有 describe、没有 resolve（界面不完整的半装配）。 */
  partialCredentials?: boolean;
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
  let settingsLookups = 0;
  const host: FakeHost = {
    registeredTools: [],
    registeredRoutes: [],
    sections: [],
    configureCalls: [],
    fiber: { id: "ocr-review-fiber" },
    jobs: makeJobRegistry(),
    effectDisposers: [],
    injectEffectDisposers: [],
    describedRefs,
    resolvedRefs,
    settingsValue: {
      effort: "medium",
      language: "中文",
      autoVerify: true,
      maxComments: 12,
      timeoutMinutes: 0,
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
      // 但**另存一队**：四条路由的释放器必须挂在子 fiber 上，混队就测不出挂错了地方。
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
          // 官方唯一可读的非回环信号（同包 d.ts `:50`）：host 成员不给，`servingNonLoopback`
          // 就永为 false，那道锁在接线层面从没被拨开过。
          host: options.webServerHost,
        };
      } else if (name === "settings" && options.settingsService !== false) {
        settingsLookups += 1;
        // 探测通过后服务被卸载（health 与真正读取之间）：门面必须报错而非回空表。
        service =
          options.settingsVanishes === true && settingsLookups > 1 ? undefined : host.settings;
      } else if (name === "jobs" && options.jobs !== false) {
        service = host.jobs;
      } else if (name === "credentials" && options.credentialsService !== false) {
        service =
          options.partialCredentials === true ? { describe: credentials.describe } : credentials;
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

/** 字段化的三个部署值：在 Config 里但**不标** volatile ⇒ 只在行 config 上改。 */
const DEPLOYMENT = ["llmTestTimeoutMs", "ocrBackgroundMaxMs", "stdoutMaxBytes"];

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

function applyPlugin(host: FakeHost): void {
  (plugin as unknown as { apply: (ctx: unknown, config: unknown) => void }).apply(
    host,
    liveConfig(host),
  );
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

function routeOf(host: FakeHost, url: string): FakeRoute {
  const found = host.registeredRoutes.find((route) => route.path === url);
  if (found === undefined) {
    throw new Error(`route not registered: ${url}`);
  }
  return found;
}

/** host.ts 的 ToolExec 投影（官方 `ToolRunContext` 的 signal/agent 两面）。
 *  从 `ocrRepo` 的参数位取类型，而不是在测试里再抄一份执行面形状——抄了就又会漂。 */
type HostExec = Parameters<typeof ocrRepo>[1];

/** 执行面替身：`agent` 给的是**官方契约之外**的脏数据（`null`、缺 session / 缺 header
 *  的半装配）。官方 `Agent` 类型不收这些，而运行时真可能收到——host.ts 的
 *  `sessionHeaderCwd` 逐层判空就是为它们留的闸。故值按 `unknown` 构造，只在
 *  这一处定点回投影类型（cast 只存在于测试，生产代码没有）。 */
function fakeExec(signal: AbortSignal, agent: unknown): HostExec {
  return { signal, agent } as HostExec;
}

function makeExec(cwd?: string): HostExec {
  return fakeExec(
    new AbortController().signal,
    cwd === undefined ? {} : { session: { header: { cwd } } },
  );
}

// ── HTTP 替身 ───────────────────────────────────────────────────────────────

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writableEnded: boolean;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes;
  end: (data?: string) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      res.headers[name] = value;
    },
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers !== undefined) {
        Object.assign(res.headers, headers);
      }
      res.headersSent = true;
      return res;
    },
    end(data) {
      res.body = data ?? "";
      res.writableEnded = true;
      return res;
    },
  };
  return res;
}

/** 假响应只实现端点用到的面（writeHead/end/setHeader），按 ServerResponse 喂给 handler。 */
function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse;
}

function bodyOf(res: FakeRes): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

interface ReqSpec {
  method?: string | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  /** 流读取中断（覆盖 readBody 的 aborted → 400 分支）。 */
  broken?: boolean | undefined;
}

function makeReq(spec: ReqSpec): IncomingMessage {
  const raw = {
    method: spec.method ?? "GET",
    url: spec.url ?? "/",
    headers: spec.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (spec.broken === true) {
        throw new Error("aborted by peer");
      }
      if (spec.body !== undefined) {
        yield Buffer.from(spec.body, "utf8");
      }
    },
  };
  return raw as unknown as IncomingMessage;
}

/** GET 端点调用样板。 */
async function get(
  host: FakeHost,
  url: string,
  headers?: Record<string, string>,
): Promise<FakeRes> {
  const res = makeRes();
  await routeOf(host, url).handler(makeReq({ method: "GET", url, headers }), asRes(res));
  return res;
}

/** 一次 GET providers 拿到的会话内 csrf token（写端点必须回填该头）。 */
async function csrfOf(host: FakeHost): Promise<string> {
  const res = await get(host, PROVIDERS_PATH);
  return String(bodyOf(res)["csrf"]);
}

/** 写端点调用样板：带 csrf + 可选 body。 */
async function post(
  host: FakeHost,
  url: string,
  options: { body?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<FakeRes> {
  const res = makeRes();
  await routeOf(host, url).handler(
    makeReq({
      method: "POST",
      url,
      headers: {
        [CSRF_HEADER]: options.token ?? (await csrfOf(host)),
        ...options.headers,
      },
      body: options.body,
    }),
    asRes(res),
  );
  return res;
}

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

function writeOcrConfig(doc: string): void {
  writeFileSync(OCR_CONFIG, doc);
}

function configDoc(): ConfigDoc {
  return JSON.parse(readFileSync(OCR_CONFIG, "utf8")) as ConfigDoc;
}

/**
 * 起 count 条后台评审（并发起是安全的：容量闸只管活的，count <= 10）。
 * 循环体里不许 await（oxlint no-await-in-loop），故先攒 Promise 再一次 all。
 * @param host 宿主替身
 * @param count 条数
 * @returns {Promise<void>}
 */
async function startBackgroundRuns(host: FakeHost, count: number): Promise<void> {
  const runs: Promise<unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    runs.push(toolOf(host, "ocr_review").execute({ repo: "/repo", wait: false }, makeExec()));
  }
  await Promise.all(runs);
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

/** 本机网卡上的非回环 IPv4：`shared/lib/trust.ts:120-129` 只认"确属本机网卡"的那批地址。
 *  取不到就响亮失败而不是跳过——这条用例是本仓唯一把 `servingNonLoopback` 拨到 **true**
 *  的接线（两包替身根本没有 `host` 成员，那道锁在真实接线上永为合着）。 */
function lanIpv4(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  throw new Error("这台机器上没有非回环 IPv4 网卡地址：非回环服务面的接线用例无法构造");
}

// ── 顶层 describe 与文件级钩子 ────────────────────────────────────────────
//
// 下面三条钩子（沙箱复位 / mock 进程结算 / 临时 home 清理）对整个文件生效，而
// vitest(require-top-level-describe) 要求钩子必须在 describe 里，故本文件的全部
// suite 收进同一层 describe：钩子的作用域、顺序与原来逐字一致，只是宿主容器换了名字。
describe("host.ts（注册面 + 5 个工具执行路径 + 4 个 webServer 端点）", () => {
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
   * 自己的拍白刷 ~28.8 万次；挂不挂上看调度 ⇒ 整文件在 1.3s / 8.6s / >20s（判超时）之间跳
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
    it("登记页面策略、5 个工具、路由段与 4 个端点", () => {
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
        "ocr_review",
        "ocr_scan",
        "ocr_session",
      ]);
      expect(host.sections).toHaveLength(1);
      expect(host.sections[0]?.order).toBe(1555);
      expect(host.registeredRoutes.map((route) => route.path).toSorted()).toStrictEqual([
        MIGRATE_PATH,
        PROVIDERS_PATH,
        SELECT_PATH,
        TEST_PATH,
      ]);
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
      expect(host.registeredTools).toHaveLength(5);
      expect(host.registeredRoutes).toHaveLength(0);
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

    it("Config schema 逐字段默认 = 0.1.6 交给 register 的内置底座", () => {
      // 0.1.7 删了 settings.register(ns, schema, { base })：默认值改由 schema 自己带
      // （cordis 装载期用同一份 schema 填默认，fiber.ts resolveConfig）。少一个默认就会
      // 在真实宿主上变样，故逐字段对齐旧 BUILTIN_BASE。
      expect(schemaDefaults()).toStrictEqual({
        effort: "medium",
        language: "中文",
        autoVerify: true,
        maxComments: 12,
        timeoutMinutes: 0,
        // 路径**不给**默认：内置底座一旦写死绝对路径就又回到「作者机器布局」。
        ocrConfigPath: undefined,
        // 字段化的三个部署值：默认与原常量同值（90s / 2h / 400k），行为冻结。
        // 这里手写字面值而不引 host.ts 的常量——引常量就成了自证，常量改了该先红。
        llmTestTimeoutMs: 90_000,
        ocrBackgroundMaxMs: 2 * 60 * 60_000,
        stdoutMaxBytes: 400_000,
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
      // canonical 值直返后 ocr_review 的根是三分支 oneOf：后台回执 / 摘要对象 / 解析失败字符串。
      expect(toolOf(host, "ocr_review").output.schema["oneOf"]).toHaveLength(3);
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

    it("五个工具各自声明真实的 output schema（canonical 直返，不再是统一 {text}）", () => {
      // review / scan：oneOf[后台回执对象, 摘要对象, 解析失败字符串]；两个工具共用同一份。
      const reviewBranches = outputSchemaOf(host, "ocr_review")["oneOf"] as Record<
        string,
        unknown
      >[];
      expect(reviewBranches).toHaveLength(3);
      expect(reviewBranches[2]).toStrictEqual({ type: "string" });
      const receiptProps = (reviewBranches[0] as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(receiptProps).toSorted()).toStrictEqual([
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
      // session 的诚实值本来就是对象：sessionOutput（一手透传字符串）+ hint。
      const session = outputSchemaOf(host, "ocr_session");
      expect(session["type"]).toBe("object");
      expect(Object.keys(session["properties"] as object).toSorted()).toStrictEqual([
        "hint",
        "sessionOutput",
      ]);
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

  describe("ocr_review 前台执行", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("命令构造：守护包装 + --output 临时文件；评论摘要锚定数字字符串行号", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      const view = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo", background: "登录改造", exclude: ["**/gen/*"], effort: "high" },
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
      expect(outPath).toMatch(/ocr-review-.{6,}\/out\.json$/u);
      expect(view.status).toBe("success");
      expect(view.sessionId).toBe("sess-1");
      expect(view.topComments[0]?.location).toBe("src/a.ts:42-44");
      expect(view.aggregation.bySeverity["critical"]).toBe(1);
    });

    it("execute 直返 canonical 对象（不再把结果 stringify 进 {text} 双重编码）", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      // 双重编码回归钉：值本身就是结构化对象，而不是「JSON 字符串里再包一份 JSON」；
      // 也不再有包着字符串的 text 字段（PTC 的 await tools.ocr_review(...) 拿到的就是它）。
      expect(result).toBeTypeOf("object");
      expect(result).not.toHaveProperty("text");
      const view = result as { status: string; sessionId: string; topComments: unknown[] };
      expect(view.status).toBe("success");
      expect(view.sessionId).toBe("sess-1");
      expect(Array.isArray(view.topComments)).toBe(true);
    });

    it("临时目录解析后即删", async () => {
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      const outPath = String(outputPathOf(String(host.shell.resolveCalls[0]?.command)));
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(path.dirname(outPath))).toBe(false);
    });

    it("输出解析失败 ⇒ 回显脱敏后的原文片段，不报假干净", async () => {
      host.shell.scripts.push({ output: `{"error":"auth failed api_key=${PLAIN_KEY}"}` });
      // 解析失败分支的诚实值就是一段说明字符串（不再包 { text }）。
      const message = (await toolOf(host, "ocr_review").execute(
        { repo: "/repo" },
        makeExec(),
      )) as string;
      expect(message).toMatch(/status 非法或缺失/u);
      expect(message).toContain("已脱敏");
      expect(message).not.toContain(PLAIN_KEY);
    });

    it("exit 0 却没写出 --output 文件 ⇒ 可行动错误而非裸 ENOENT", async () => {
      host.shell.scripts.push({});
      await expect(
        toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec()),
      ).rejects.toThrow(/未写出 --output 文件/u);
    });

    it("maxComments 0（不截断）与非法值（回退 12）都能跑通", async () => {
      host.settingsValue["maxComments"] = 0;
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      host.settingsValue["maxComments"] = "many";
      host.shell.scripts.push({ output: REVIEW_JSON });
      const result = (await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec())) as {
        status: string;
      };
      expect(result.status).toBe("success");
    });

    it("effort 缺省取设置卡值（low/high 直通，其它归 medium）", async () => {
      host.settingsValue["effort"] = "low";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      expect(String(host.shell.resolveCalls[0]?.command)).toContain("--effort low");
      host.settingsValue["effort"] = "high";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      expect(String(host.shell.resolveCalls[1]?.command)).toContain("--effort high");
      host.settingsValue["effort"] = "ultra";
      host.shell.scripts.push({ output: REVIEW_JSON });
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      expect(String(host.shell.resolveCalls[2]?.command)).toContain("--effort medium");
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
      await toolOf(host, "ocr_review").execute({ repo: "/repo" }, makeExec());
      expect(host.shell.resolveCalls[0]?.onExpiry).toBeUndefined();
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBeTypeOf("number");
    });
  });

  // ── 后台取消接合 ────────────────────────────────────────────────────────────

  describe("startBackground 的取消接合", () => {
    it("调用被中止 ⇒ proc.kill()，进程落定后摘掉 abort 监听", async () => {
      const host = makeHost();
      applyPlugin(host);
      const controller = new AbortController();
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      const [proc] = host.shell.procs;
      expect(host.shell.resolveCalls[0]?.signal).toBe(controller.signal);
      expect(proc?.killCount).toBe(0);
      controller.abort();
      expect(proc?.killCount).toBe(1);
      proc?.settle();
      await proc?.done;
      controller.abort();
      expect(proc?.killCount).toBe(1);
    });

    it("signal 已 aborted ⇒ 拿到句柄立即 kill", async () => {
      const host = makeHost();
      applyPlugin(host);
      const controller = new AbortController();
      controller.abort();
      await toolOf(host, "ocr_scan").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      expect(host.shell.procs[0]?.killCount).toBe(1);
    });

    it("取消经注册表收：记录先 stopping 再 killed，reason 落进 detail 且只出现一次", async () => {
      const host = makeHost();
      applyPlugin(host);
      const controller = new AbortController();
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      const [proc] = host.shell.procs;
      const [job] = host.jobs.list();
      expect(job?.status).toBe("running");
      controller.abort();
      // 经 registry.kill 而不是裸 proc.kill：名册里那条必须立刻显出"正在收"，
      // 否则观察者会一直以为它还在跑（实测这条曾经就是停在 running 的）。
      expect(host.jobs.get(onlyJob(job)).status).toBe("stopping");
      expect(proc?.killCount, "cancel 那一臂仍要把进程杀掉").toBe(1);
      proc?.settle();
      await settledTick();
      const [settled] = host.jobs.list();
      expect(settled?.status).toBe("killed");
      // detail 的组成钉死（生产者结局在前、注册表追加 reason），reason 本体取字典：
      // 字典改文案不该让这条契约用例红，改**拼接次序**才该。
      expect(settled?.detail).toBe(`killed before exit; ${zh.jobReasonAborted}`);
    });

    it("注册表已经不认这条 ⇒ 取消退化成直接杀进程，绝不在 abort 监听器里抛", async () => {
      const host = makeHost();
      const real = host.jobs;
      host.jobs = registryWithThrowingKill(real);
      applyPlugin(host);
      const controller = new AbortController();
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      const [proc] = host.shell.procs;
      const uncaught = await collectUncaught(async () => {
        controller.abort();
      });
      // 监听器里抛出的错误由 Node 以 `process.nextTick(() => { throw err })` 重抛 ⇒ 未捕获异常
      // ⇒ **整个宿主进程退出**（本机实跑复现）。用户在别的会话里按一次取消
      // 不该把 dsh 弄没，所以这一臂必须自己兜住。
      expect(uncaught, "取消链不许把异常交给 Node").toStrictEqual([]);
      expect(proc?.killCount, "注册表收不动时仍要把进程杀掉").toBe(1);
      expect(real.list()[0]?.status, "名册归别人管时不假装收过了").toBe("running");
      // 收尾把这条活作业落定，别把泵留给别人（判据统一写在文件级 `afterEach` 那一处）。
      proc?.settle();
      await settledTick();
    });

    it("proc.kill 自己抛（ESRCH 那一类）⇒ 被 cancel 兜住，名册照样推到 stopping", async () => {
      const host = makeHost();
      applyPlugin(host);
      const controller = new AbortController();
      await toolOf(host, "ocr_review").execute(
        { repo: "/repo", wait: false },
        { signal: controller.signal, agent: {} },
      );
      const [proc] = host.shell.procs;
      if (proc === undefined) {
        throw new Error("后台评审没起出进程");
      }
      proc.kill = () => {
        throw new Error("ESRCH: no such process");
      };
      const [job] = host.jobs.list();
      const uncaught = await collectUncaught(async () => {
        controller.abort();
      });
      expect(uncaught).toStrictEqual([]);
      // 这条断言才是 `killProc` 自己的牙齿（而不是 `stop` 那层 catch 顺带兜住）：官方 `killJob`
      // 先调 `job.cancel()` 再把记录推到 stopping（installed dsh-jobs-local:611-622），
      // cancel 一抛那条就永远停在 running。
      expect(host.jobs.get(onlyJob(job)).status, "cancel 抛错不能把记录留在 running").toBe(
        "stopping",
      );
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
      expect(String(job?.id)).toBe("ocr-review-1");
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
      // 注册表面的 `get()` 返回的就是记录本身（官方 d.ts 非可选，本文件另外 6 处也是直接取
      // 成员），且 `onlyJob` 已经先把「作业没登记」拦成响亮失败 ⇒ 这里不写 `?.`。
      expect(settled.status).toBe("completed");
      expect(settled.detail).toBe("exit code: 0");
    });

    it("历史窗口有界：每次登记前剪掉本 kind 最老的已落定记录", async () => {
      const host = makeHost();
      applyPlugin(host);
      // 铺场顺序受两处闸约束：容量闸只管"活的"（一次并发起 10 条到顶），窗口裁剪又只看
      // 已落定的条数 ⇒ 先并发起满 10 条并落定，再单起两条各次触发一次裁剪。
      await startBackgroundRuns(host, 10);
      await settleBackgroundRuns(host, 0);
      // 剪枝跑在 `start` **之前**，剪到 HISTORY_MAX-1 条 ⇒ 起完正好 HISTORY_MAX 条在册。
      // 按 HISTORY_MAX 剪就是 HISTORY_MAX+1 条：README 的"只留最近 10 条"与卡片 404 文案
      // 说的都是在册上限，那一格是实现与文案的分歧（此前修的是剪枝边界，这条用例回到不变量）。
      await startBackgroundRuns(host, 1);
      expect(host.jobs.list().map((job) => String(job.id))).toStrictEqual(
        ocrIds(2, HISTORY_MAX + 1),
      );
      await settleBackgroundRuns(host, 10);
      // 第 12 条登记时最老那条才走。注册表只在显式 remove 前保留落定记录 ⇒ 本包不剪就是
      // 每次评审永久留一条记录外加一只最多 256 KiB 的环。
      await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 11);
      const ids = host.jobs.list().map((job) => String(job.id));
      expect(ids).toStrictEqual(ocrIds(3, HISTORY_MAX + 2));
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
      expect(ids).toContain("ocr-review-1:stopping");
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
      await startBackgroundRuns(host, 1);
      await settleBackgroundRuns(host, 0);
      await startBackgroundRuns(host, 1);
      // 卸载前的名册：一条已落定 + 一条在跑（窗口剪枝在登记前跑，1 条远没到上限）。
      expect(host.jobs.list().map((job) => String(job.id))).toStrictEqual([
        "ocr-review-1",
        "ocr-review-2",
      ]);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      // 两件事都做才叫回收：活着的经注册表 kill（推到 stopping、理由进 detail），已落定的
      // remove（连带那只最多 256 KiB 的环）。只 kill 不 remove 的后果——本包不留常驻
      // 状态，禁用后再没有 apply，留下的记录就是永久的。
      expect(host.jobs.list().map((job) => `${String(job.id)}:${job.status}`)).toStrictEqual([
        "ocr-review-2:stopping",
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
      // 释放器确实登记了：主 fiber 上就是作业回收这一位（四条端点的释放器挂在注入子 fiber
      // 的 injectEffectDisposers 上），否则下面的循环是空转、覆盖是假象。
      expect(host.effectDisposers).toHaveLength(1);
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      // 没有注册表可读 ⇒ 回收整条跳过：名册里一条记录都没被写过（真回收会留下 stopping/detail）。
      expect(host.jobs.list()).toStrictEqual([]);
    });

    it("兜底 deadline 到点：挂死的评审被经注册表收掉，理由进 detail", async () => {
      // 假定时器必须**在起作业之前**装好：`wait` 的内部定时器是 start 那一刻建的，晚装
      // 就追不上它。泵拍顺带拉长到一小时，否则推进两小时会把它白刷几万拍。
      const host = makeHost();
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
      // 取字典。原先只 `toContain("超过 2 小时")` 是字典值的一段 ⇒ 拼接次序坏了也不会红。
      expect(host.jobs.get(onlyJob(job)).detail).toBe(
        `killed before exit; ${MESSAGES.zh.jobReasonTimeout}`,
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
        { repo: "/repo", path: ["src", "test"] },
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
        { repo: "/repo" },
        makeExec(),
      )) as string;
      expect(failed).toMatch(/合法 JSON/u);
      const outPath = String(outputPathOf(String(host.shell.resolveCalls[0]?.command)));
      host.shell.scripts.push({});
      await expect(toolOf(host, "ocr_scan").execute({ repo: "/repo" }, makeExec())).rejects.toThrow(
        /未写出 --output 文件/u,
      );
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
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(
        /实际生效 3 分钟/u,
      );
    });

    it("aborted ⇒ 被中止；exit 127 ⇒ 安装指引", async () => {
      host.shell.scripts.push({ exitCode: null, aborted: true });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(/被中止/u);
      host.shell.scripts.push({ exitCode: 127 });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(/命令不存在/u);
    });

    it("其它退出码 ⇒ stderr（空则退 stdout）、超 800 字符走中间省略、全空只报退出码", async () => {
      host.shell.scripts.push({ exitCode: 1, stderrText: "boom: provider 未配置" });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(
        /exit=1）：boom: provider 未配置/u,
      );
      host.shell.scripts.push({ exitCode: 2, stderrText: "", stdoutText: "y".repeat(900) });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(/中间省略/u);
      host.shell.scripts.push({ exitCode: 3, stderrText: "", stdoutText: "" });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(
        /^ocr 执行失败（exit=3）$/u,
      );
    });

    it("失败详情里的明文 key 先脱敏再截断", async () => {
      host.shell.scripts.push({
        exitCode: 1,
        stderrText: `HEAD ${"y".repeat(900)} ${PLAIN_KEY} tail`,
      });
      await expect(preview.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(/REDACTED/u);
    });

    it("stdout 截断 ⇒ 追加截断说明，有落盘路径时一并给出", async () => {
      host.shell.scripts.push({ stdoutText: "partial", stdoutTruncated: true });
      // "partial" 不是合法 JSON ⇒ preview 走解析失败分支，诚实值就是那段说明字符串。
      const result = (await preview.execute({ repo: "/repo" }, makeExec())) as string;
      expect(result).toContain("已截断");
      expect(result).not.toContain("完整输出已落盘");
      host.shell.scripts.push({
        stdoutText: "partial",
        stdoutTruncated: true,
        stdoutSpillPath: "/tmp/spill.txt",
      });
      const spilled = (await preview.execute({ repo: "/repo" }, makeExec())) as string;
      expect(spilled).toContain("/tmp/spill.txt");
    });

    it("timeoutMinutes 非法 ⇒ 按 0 处理并请求宿主上限", async () => {
      host.settingsValue["timeoutMinutes"] = "soon";
      host.shell.scripts.push({ stdoutText: "{}" });
      await preview.execute({ repo: "/repo" }, makeExec());
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
      const result = (await preview.execute({ repo: "/repo" }, makeExec())) as string;
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
        await preview.execute({ repo: "/repo" }, makeExec()).catch((error: unknown) => error),
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
      const result = (await preview.execute({ repo: "/repo" }, makeExec())) as {
        reviewableCount: number;
        insertions: number;
        deletions: number;
        excludedFiles: unknown[];
      };
      expect(result.reviewableCount).toBe(1);
      expect(result.insertions).toBe(3);
      expect(result.deletions).toBe(1);
      expect(result.excludedFiles).toHaveLength(1);
      host.shell.scripts.push({ stdoutText: '{"error":"nope"}' });
      const bad = (await preview.execute({ repo: "/repo" }, makeExec())) as string;
      expect(bad).toMatch(/preview 输出解析失败/u);
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
  });

  // ── webServer 端点 ──────────────────────────────────────────────────────────

  describe("GET providers", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("下发 provider 列表与 csrf token，且不含 key 明文", async () => {
      writeOcrConfig(
        JSON.stringify({
          provider: "sensenova",
          custom_providers: {
            sensenova: { model: SENSENOVA_MODEL, api_key_cmd: "node scripts/get-cred.mjs" },
          },
        }),
      );
      const res = await get(host, PROVIDERS_PATH);
      expect(res.statusCode).toBe(200);
      const payload = bodyOf(res);
      expect(String(payload["csrf"])).toMatch(/[0-9a-f-]{36}/u);
      expect(res.headers["cache-control"]).toBe("no-store");
      const current = payload["current"] as Record<string, unknown>;
      expect(current["provider"]).toBe("sensenova");
      expect(current["keyIsDynamic"]).toBe(true);
      expect(res.body).not.toContain(LIVE_KEY);
      // provider 清单来自 settings.describe()：四条、带 hasKey，且不含任何 key 值。
      const providers = payload["providers"] as Record<string, unknown>[];
      expect(providers.map((entry) => entry["name"])).toStrictEqual([
        "sensenova",
        "xkiro",
        "amd",
        "antdigital",
      ]);
      expect((bodyOf(res)["source"] as Record<string, unknown>)["status"]).toBe("ready");
    });

    it("跨站请求 ⇒ 403；坏 JSON 的 config 仍能让卡片打开", async () => {
      writeOcrConfig("{ broken");
      const cross = await get(host, PROVIDERS_PATH, { "sec-fetch-site": FETCH_SITE_CROSS_SITE });
      expect(cross.statusCode).toBe(403);
      const res = await get(host, PROVIDERS_PATH, { "sec-fetch-site": FETCH_SITE_SAME_ORIGIN });
      expect(res.statusCode).toBe(200);
      expect((bodyOf(res)["current"] as Record<string, unknown>)["provider"]).toBe("");
    });
  });

  // ── 官方通道的降级面（服务缺席 / 命名空间缺失 / 服务竞态）─────────────────────

  describe("GET providers 的官方通道降级", () => {
    it("credentials 缺席 ⇒ 清单照给但标记不可用，且一个 ref 都不去问", async () => {
      const host = makeHost({ credentialsService: false });
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH);
      const payload = bodyOf(res);
      expect(res.statusCode).toBe(200);
      expect((payload["source"] as Record<string, unknown>)["status"]).toBe(
        "credentials-unavailable",
      );
      expect(String((payload["source"] as Record<string, unknown>)["message"])).toMatch(
        /ctx\.credentials/u,
      );
      expect(host.describedRefs).toStrictEqual([]);
      expect(
        (payload["providers"] as Record<string, unknown>[]).map((entry) => entry["hasKey"]),
      ).toStrictEqual([false, false, false, false]);
    });

    it("settings 服务缺席 ⇒ settings-unavailable + 空清单", async () => {
      const host = makeHost({ settingsService: false });
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH);
      const payload = bodyOf(res);
      const source = payload["source"] as Record<string, unknown>;
      expect(source["status"]).toBe("settings-unavailable");
      expect(String(source["message"])).toMatch(/ctx\.settings/u);
      expect(payload["providers"]).toStrictEqual([]);
    });

    it("describe() 里没有 llm-pi-ai 那条 ⇒ namespace-unavailable", async () => {
      const host = makeHost({ descriptors: [{ ns: "ui-theme", value: { preference: "system" } }] });
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH);
      const source = bodyOf(res)["source"] as Record<string, unknown>;
      expect(source["status"]).toBe("namespace-unavailable");
      expect(String(source["message"])).toMatch(/llm-pi-ai/u);
      expect(bodyOf(res)["providers"]).toStrictEqual([]);
    });

    it("凭据服务半装配（只有 describe、没有 resolve）⇒ 一律按缺席降级", async () => {
      const host = makeHost({ partialCredentials: true });
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH);
      expect((bodyOf(res)["source"] as Record<string, unknown>)["status"]).toBe(
        "credentials-unavailable",
      );
      expect(host.describedRefs).toStrictEqual([]);
    });

    it("探测通过后服务被卸载 ⇒ settings-failed（端点绝不抛穿成裸错误）", async () => {
      const host = makeHost({ settingsVanishes: true });
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH);
      const source = bodyOf(res)["source"] as Record<string, unknown>;
      expect(res.statusCode).toBe(200);
      expect(source["status"]).toBe("settings-failed");
      expect(String(source["message"])).toMatch(/已不可用/u);
    });

    it("设置项 ocrConfigPath 覆盖默认位置：卡片读写的就是那个文件", async () => {
      const custom = path.join(HOME, "elsewhere", "ocr.json");
      mkdirSync(path.dirname(custom), { recursive: true });
      writeFileSync(custom, '{"provider":"fromcustom","custom_providers":{}}');
      const host = makeHost();
      applyPlugin(host);
      host.settingsValue["ocrConfigPath"] = custom;
      const res = await get(host, PROVIDERS_PATH);
      expect((bodyOf(res)["current"] as Record<string, unknown>)["provider"] as string).toBe(
        "fromcustom",
      );
      expect(existsSync(OCR_CONFIG)).toBe(false);
    });

    it("ocrConfigPath 留空白 ⇒ 仍按 os.homedir() 派生默认位置", async () => {
      const host = makeHost();
      applyPlugin(host);
      host.settingsValue["ocrConfigPath"] = "   ";
      writeOcrConfig('{"provider":"bydefault"}');
      const res = await get(host, PROVIDERS_PATH);
      expect((bodyOf(res)["current"] as Record<string, unknown>)["provider"]).toBe("bydefault");
    });

    it("ocrConfigPath 是相对路径 ⇒ 500 + 可读原因（配置绝不落到当时工作区）", async () => {
      const host = makeHost();
      applyPlugin(host);
      host.settingsValue["ocrConfigPath"] = "relative/ocr.json";
      const res = await get(host, PROVIDERS_PATH);
      expect(res.statusCode).toBe(500);
      expect(String(bodyOf(res)["error"])).toMatch(/必须是绝对路径/u);
    });
  });

  describe("POST select", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("应用 provider/model：原子写 + .bak + 同条目其它键与未知顶层键保留", async () => {
      writeOcrConfig(
        JSON.stringify(
          {
            language: "en",
            mcp_servers: { zvec: { cmd: "x" } },
            custom_providers: {
              sensenova: {
                api_key: PLAIN_KEY,
                extra_headers: { "x-a": "1" },
                temperature: 0.3,
                timeout_seconds: 99,
              },
            },
          },
          null,
          2,
        ),
      );
      host.shell.scripts.push({ exitCode: 0, stdoutText: "llm ok" });
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "sensenova", model: SENSENOVA_MODEL }),
      });
      expect(res.statusCode).toBe(200);
      const doc = configDoc();
      const entry = doc.custom_providers?.["sensenova"];
      expect(entry?.["api_key"]).toBeUndefined();
      expect(String(entry?.["api_key_cmd"])).toContain("get-cred.mjs");
      expect(entry?.["extra_headers"]).toStrictEqual({ "x-a": "1" });
      expect(entry?.["temperature"]).toBe(0.3);
      expect(entry?.["timeout_seconds"]).toBe(99);
      expect(doc["mcp_servers"]).toStrictEqual({ zvec: { cmd: "x" } });
      expect(doc.provider).toBe("sensenova");
      expect(doc.language).toBe("中文");
      expect(existsSync(`${OCR_CONFIG}.bak`)).toBe(true);
      expect(statSync(OCR_CONFIG).mode % 0o1000).toBe(0o600);
      expect(res.body).not.toContain(PLAIN_KEY);
      const payload = bodyOf(res);
      expect((payload["llmTest"] as Record<string, unknown>)["ok"]).toBe(true);
      expect(payload["applied"]).toStrictEqual({
        provider: "sensenova",
        model: SENSENOVA_MODEL,
        url: "https://token.sensenova.cn/v1",
        protocol: "openai",
      });
    });

    it("autoVerify=false ⇒ 不调 llm test；language 设置随 config 落盘", async () => {
      host.settingsValue["autoVerify"] = false;
      host.settingsValue["language"] = "English";
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "amd", model: AMD_MODEL }),
      });
      expect(bodyOf(res)["llmTest"]).toBeNull();
      expect(configDoc().language).toBe("English");
      expect(host.shell.resolveCalls).toHaveLength(0);
    });

    it("设置语言非卡片两选项 ⇒ 不写 language 键；llm test 失败仍算应用成功", async () => {
      host.settingsValue["language"] = "日本語";
      host.shell.scripts.push({ exitCode: 1, stderrText: "401 unauthorized" });
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "amd", model: AMD_MODEL }),
      });
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)["ok"]).toBe(true);
      expect((bodyOf(res)["llmTest"] as Record<string, unknown>)["ok"]).toBe(false);
      expect(configDoc().language).toBeUndefined();
    });

    it("缺 csrf / 错 csrf / 跨站 / 非 POST / 超限 body / 断流各有专属回执", async () => {
      const missing = await post(host, SELECT_PATH, { token: "", body: "{}" });
      expect(missing.statusCode).toBe(403);
      expect(bodyOf(missing)["error"]).toMatch(/csrf/u);
      const wrong = await post(host, SELECT_PATH, { token: "nope", body: "{}" });
      expect(wrong.statusCode).toBe(403);
      const cross = await post(host, SELECT_PATH, {
        body: "{}",
        headers: { "sec-fetch-site": FETCH_SITE_CROSS_SITE },
      });
      expect(cross.statusCode).toBe(403);
      const notPost = await get(host, SELECT_PATH);
      expect(notPost.statusCode).toBe(405);
      expect(notPost.headers["Allow"]).toBe("POST");
      const declared = await post(host, SELECT_PATH, {
        body: "x".repeat(9000),
        headers: { "content-length": "9000" },
      });
      expect(declared.statusCode).toBe(413);
      const streamed = await post(host, SELECT_PATH, { body: "x".repeat(9000) });
      expect(streamed.statusCode).toBe(413);
      const abortedRes = makeRes();
      await routeOf(host, SELECT_PATH).handler(
        makeReq({
          method: "POST",
          url: SELECT_PATH,
          headers: { [CSRF_HEADER]: await csrfOf(host) },
          broken: true,
        }),
        asRes(abortedRes),
      );
      expect(abortedRes.statusCode).toBe(400);
      expect(bodyOf(abortedRes)["error"]).toMatch(/unreadable/u);
    });

    it("body 非对象 / provider+model 缺失 / 应用失败 ⇒ 400 且错误可读", async () => {
      const notObject = await post(host, SELECT_PATH, { body: "[1,2]" });
      expect(notObject.statusCode).toBe(400);
      expect(bodyOf(notObject)["error"]).toMatch(/body 解析失败/u);
      const missingModel = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "x" }),
      });
      expect(bodyOf(missingModel)["error"]).toMatch(/必填/u);
      const nonStringProvider = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: 42, model: "m" }),
      });
      expect(bodyOf(nonStringProvider)["error"]).toMatch(/必填/u);
      const garbage = await post(host, SELECT_PATH, { body: "{ nope" });
      expect(bodyOf(garbage)["error"]).toMatch(/body 解析失败/u);
      const unknown = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "nope", model: "m" }),
      });
      expect(bodyOf(unknown)["error"]).toMatch(/不在 dsh 配置的 llm-pi-ai\.providers 列表/u);
    });
  });

  describe("POST select 的凭据闸与降级", () => {
    it("应用成功：api_key_cmd 里只有 ref 名，凭据服务给的明文绝不出回执与配置", async () => {
      const host = makeHost();
      applyPlugin(host);
      host.shell.scripts.push({ exitCode: 0, stdoutText: "ok" });
      // 先单独取 token：post 帮助函数内部的 GET providers 也会问一遍 describe，
      // 只有先记下次数才能证明「select 这一步走的是 resolve，不是 describe」。
      const token = await csrfOf(host);
      const describedBefore = host.describedRefs.length;
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "amd", model: AMD_MODEL }),
        token,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(LIVE_KEY);
      expect(host.resolvedRefs).toStrictEqual(["AMD_API_KEY"]);
      expect(host.describedRefs).toHaveLength(describedBefore);
      const doc = configDoc();
      expect(String(doc.custom_providers?.["amd"]?.["api_key_cmd"])).toContain("AMD_API_KEY");
      expect(readFileSync(OCR_CONFIG, "utf8")).not.toContain(LIVE_KEY);
    });

    it("凭据 resolve 未命中 ⇒ 400 并点名 ref（不写半截配置）", async () => {
      const host = makeHost({ configured: ["SENSENOVA_API_KEY"] });
      applyPlugin(host);
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "amd", model: AMD_MODEL }),
      });
      expect(res.statusCode).toBe(400);
      expect(String(bodyOf(res)["error"])).toMatch(/未解析到 AMD_API_KEY/u);
      expect(existsSync(OCR_CONFIG)).toBe(false);
    });

    it("provider 未声明 apiKeyEnv ⇒ 400（OCR 自定义 provider 不支持无 key）", async () => {
      const host = makeHost({
        descriptors: descriptorsWithValue({
          providers: { nokey: { baseURL: "https://n", models: [] } },
        }),
      });
      applyPlugin(host);
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "nokey", model: "m" }),
      });
      expect(String(bodyOf(res)["error"])).toMatch(/未声明 apiKeyEnv/u);
      expect(host.resolvedRefs).toStrictEqual([]);
    });

    it("apiKeyEnv 不合官方 ref 语法 ⇒ 判未配置且不去烦凭据服务", async () => {
      const host = makeHost({
        descriptors: descriptorsWithValue({
          providers: {
            weird: {
              baseURL: "https://w",
              apiKeyEnv: "bad key!",
              models: [{ id: "m", name: "m" }],
            },
          },
        }),
      });
      applyPlugin(host);
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "weird", model: "m" }),
      });
      expect(String(bodyOf(res)["error"])).toMatch(/未解析到 bad key!/u);
      expect(host.resolvedRefs).toStrictEqual([]);
    });

    it("数据源不可用 ⇒ 400 直接给降级原因", async () => {
      const host = makeHost({ credentialsService: false });
      applyPlugin(host);
      const res = await post(host, SELECT_PATH, {
        body: JSON.stringify({ provider: "amd", model: AMD_MODEL }),
      });
      expect(res.statusCode).toBe(400);
      expect(String(bodyOf(res)["error"])).toMatch(/ctx\.credentials/u);
    });
  });

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

    it("credentialConfigured 走 describe、credentialResolvable 走 resolve，两者都只回布尔", async () => {
      const host = makeHost();
      const gateway = createGateway(host as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(true);
      await expect(gateway.credentialResolvable("AMD_API_KEY")).resolves.toBe(true);
      await expect(gateway.credentialConfigured("MISSING_KEY")).resolves.toBe(false);
      await expect(gateway.credentialResolvable("MISSING_KEY")).resolves.toBe(false);
      expect(host.describedRefs).toStrictEqual(["AMD_API_KEY", "MISSING_KEY"]);
      expect(host.resolvedRefs).toStrictEqual(["AMD_API_KEY", "MISSING_KEY"]);
    });

    it("服务缺席时两个凭据问题一律回 false（不抛）", async () => {
      const gateway = createGateway(
        makeHost({ credentialsService: false }) as unknown as GatewayArg,
      );
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(false);
      await expect(gateway.credentialResolvable("AMD_API_KEY")).resolves.toBe(false);
    });

    it("不合 ref 语法的名不去烦凭据服务（官方 isCredentialRefName 的语义）", async () => {
      const host = makeHost();
      const gateway = createGateway(host as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("9BAD-KEY")).resolves.toBe(false);
      await expect(gateway.credentialResolvable("")).resolves.toBe(false);
      expect(host.describedRefs).toStrictEqual([]);
      expect(host.resolvedRefs).toStrictEqual([]);
    });

    it("resolve 命中但值为空串 ⇒ 按未配置处理（凭据层「空值即不存在」的同款规则）", async () => {
      const gateway = createGateway(makeHost({ emptyValue: true }) as unknown as GatewayArg);
      await expect(gateway.credentialResolvable("AMD_API_KEY")).resolves.toBe(false);
    });

    it("凭据服务 describe 抛错 ⇒ 与「未配置」同一降级面，不外抛成 500", async () => {
      const gateway = createGateway(makeHost({ credentialsReject: true }) as unknown as GatewayArg);
      await expect(gateway.credentialConfigured("AMD_API_KEY")).resolves.toBe(false);
    });

    it("凭据服务 resolve 抛错 ⇒ 按不可解析处理（应用据此拒绝，热路径不炸）", async () => {
      const gateway = createGateway(makeHost({ credentialsReject: true }) as unknown as GatewayArg);
      await expect(gateway.credentialResolvable("AMD_API_KEY")).resolves.toBe(false);
    });
  });

  describe("POST migrate / test", () => {
    let host: FakeHost;
    beforeEach(() => {
      host = makeHost();
      applyPlugin(host);
    });

    it("migrate 读尽 body 并迁移明文 key（未知 provider 只报不动）", async () => {
      writeOcrConfig(
        JSON.stringify({
          custom_providers: {
            sensenova: { api_key: PLAIN_KEY },
            mystery: { api_key: `sk-${"z".repeat(20)}1234` },
          },
        }),
      );
      const res = await post(host, MIGRATE_PATH, { body: "ignored-but-drained" });
      expect(res.statusCode).toBe(200);
      const payload = bodyOf(res);
      expect(payload["migrated"]).toStrictEqual(["sensenova"]);
      expect(payload["skippedUnknown"]).toStrictEqual(["mystery"]);
      expect(existsSync(`${OCR_CONFIG}.bak`)).toBe(true);
      expect(configDoc().custom_providers?.["sensenova"]?.["api_key"]).toBeUndefined();
    });

    it("坏 config.json ⇒ migrate 抛错被兜成 400（不再静默覆盖用户配置）", async () => {
      writeOcrConfig("{ broken");
      const res = await post(host, MIGRATE_PATH);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)["error"]).toMatch(/已中止写入以保护既有配置/u);
      expect(readFileSync(OCR_CONFIG, "utf8")).toBe("{ broken");
    });

    it("test 走 ocr llm test 并把 key 形态脱敏后回执", async () => {
      host.shell.scripts.push({
        exitCode: 0,
        stdoutText: "ok provider=sensenova",
        stderrText: `note ${PLAIN_KEY} accepted`,
      });
      const res = await post(host, TEST_PATH);
      expect(bodyOf(res)["ok"]).toBe(true);
      expect(String(bodyOf(res)["output"])).toContain("provider=sensenova");
      expect(res.body).not.toContain(PLAIN_KEY);
      expect(host.shell.resolveCalls[0]?.command).toBe("ocr llm test --color never");
      expect(host.shell.resolveCalls[0]?.workdir).toBe(HOME);
    });

    it("test 只有 stderr 时也能回执", async () => {
      host.shell.scripts.push({ exitCode: 1, stdoutText: "", stderrText: "仅错误输出" });
      const res = await post(host, TEST_PATH);
      expect(bodyOf(res)["ok"]).toBe(false);
      expect(String(bodyOf(res)["output"])).toBe("仅错误输出");
    });

    it("llm test 回显的 8000 码元切点咬住代理对 ⇒ 回执不留孤立代理", async () => {
      // runCollect 的 8000 切点只到设置页 HTTP 回显（不进会话日志），但半枚代理同样
      // 让卡片上长出乱码。8001 = 4 + 11×727 ⇒ 第 8000 码元正是 👦 的高代理。
      const stdoutText = `前缀哨兵${FAMILY.repeat(727)}`;
      expect(stdoutText).toHaveLength(8001);
      // 牙齿：裸切在这里确实留下了一枚孤高代理。
      expect(stdoutText.slice(0, 8000).isWellFormed()).toBe(false);
      host.shell.scripts.push({ exitCode: 0, stdoutText, stderrText: "" });
      const res = await post(host, TEST_PATH);
      const output = String(bodyOf(res)["output"]);
      // 7999 = 8000 预算减掉 truncateEnd 丢掉的那枚高代理；仍是从头截起，不是截中间。
      expect(output).toHaveLength(7999);
      expect(output.isWellFormed()).toBe(true);
      expect(stdoutText.startsWith(output)).toBe(true);
    });

    it("test 的 shell 抛非 Error 值 ⇒ 400 + String(error)", async () => {
      host.shell.scripts.push({ throws: "shell exploded" });
      const res = await post(host, TEST_PATH);
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)["error"]).toBe("shell exploded");
    });

    it("HOME 未设置 ⇒ llm test 的工作区兜底到根目录", async () => {
      const saved = process.env["HOME"];
      delete process.env["HOME"];
      host.shell.scripts.push({ exitCode: 0, stdoutText: "ok" });
      try {
        const res = await post(host, TEST_PATH);
        expect(bodyOf(res)["ok"]).toBe(true);
        expect(host.shell.resolveCalls[0]?.workdir).toBe("/");
      } finally {
        if (saved !== undefined) {
          process.env["HOME"] = saved;
        }
      }
    });

    it("migrate/test 非 POST 一律 405，不读 body", async () => {
      const migrated = await get(host, MIGRATE_PATH);
      const tested = await get(host, TEST_PATH);
      expect(migrated.statusCode).toBe(405);
      expect(tested.statusCode).toBe(405);
    });
  });

  describe("parseJsonBody", () => {
    it("空 body 视为 {}，非对象抛错", () => {
      expect(parseJsonBody("   ", zh)).toStrictEqual({});
      expect(parseJsonBody('{"a":1}', zh)).toStrictEqual({ a: 1 });
      expect(() => parseJsonBody("[1]", zh)).toThrow(/必须是 JSON 对象/u);
    });
  });

  describe("配置端点的生命周期：四条路由的释放器", () => {
    const FOUR_PATHS = [MIGRATE_PATH, PROVIDERS_PATH, SELECT_PATH, TEST_PATH];

    it("释放器挂在注入子 fiber 上：摘干净后能重新注册，热重载不撞名", async () => {
      const host = makeHost();
      applyPlugin(host);
      expect(host.registeredRoutes.map((route) => route.path).toSorted()).toStrictEqual(FOUR_PATHS);
      // 先跑**主 fiber** 那一队（只该有后台作业那条效应）：四条路由不该归它管。
      // 归了管这条就红——子 fiber 才是 webServer 换实例时先卸后装的那一层
      // （cordis registry.d.ts:97），挂错地方的后果是重载时旧路由还占着路径。
      for (const dispose of host.effectDisposers) {
        dispose();
      }
      expect(host.registeredRoutes, "主 fiber 的效应不该管路由").toHaveLength(4);
      for (const dispose of host.injectEffectDisposers) {
        dispose();
      }
      expect(host.registeredRoutes, "子 fiber 释放后四条路由都该摘掉").toStrictEqual([]);
      // 摘得干净才谈得上重装：DSH_HOT_RELOAD=1 下改本文件任意一行，走的正是
      // 「旧 fiber dispose ⇒ 新 apply」这一对。
      // `applyPlugin` 返回 void ⇒ 箭头必须带花括号（本仓 lint 的 no-confusing-void-expression：
      // 简写箭头把 void 表达式当返回值交出去，读起来像"断言在检查那个值"）。
      expect(() => {
        applyPlugin(host);
      }).not.toThrow();
      expect(host.registeredRoutes.map((route) => route.path).toSorted()).toStrictEqual(FOUR_PATHS);
      const res = await get(host, PROVIDERS_PATH);
      expect(res.statusCode).toBe(200);
    });

    it("不摘就再 apply ⇒ 当场撞名抛错（钉住替身复刻了官方查重，不是假件放行）", () => {
      const host = makeHost();
      applyPlugin(host);
      // 官方判据：installed dsh-host-webserver/lib/index.js:179。替身若不抛，上面那条
      // "摘干净才能重装"就没有对照物。
      expect(() => {
        applyPlugin(host);
      }).toThrow(/webserver: duplicate exact route/u);
    });
  });

  describe("registerConfigEndpoints 的 token 来源", () => {
    it("csrf 由调用方给定 ⇒ providers 原样下发（host 只负责每次 apply 换新值）", async () => {
      const host = makeHost();
      registerConfigEndpoints(
        // 直接调用时 ctx 给的是同一枚替身：它有 `effect`（FakeHost 的那一队），也有 `get`。
        host as unknown as Parameters<typeof registerConfigEndpoints>[0],
        host as unknown as Parameters<typeof registerConfigEndpoints>[1],
        // 替身只复刻「稳定引用 + 现读值」这一语义，逐字段的 Volatile<T> 类型面由
        // host.ts 那侧的 Config 声明守住（这里按形参类型收口，不必逐字段造引用）。
        liveConfig(host) as unknown as Parameters<typeof registerConfigEndpoints>[2],
        "fixed-token",
      );
      const res = await get(host, PROVIDERS_PATH);
      expect(bodyOf(res)["csrf"]).toBe("fixed-token");
    });

    it("同一宿主两次 apply 得到不同 token（旧 token 随即失效）", async () => {
      const host = makeHost();
      applyPlugin(host);
      const first = await csrfOf(host);
      const secondHost = makeHost();
      applyPlugin(secondHost);
      const second = await csrfOf(secondHost);
      expect(first).toMatch(/[0-9a-f-]{36}/u);
      expect(second).not.toBe(first);
      const stale = await post(host, MIGRATE_PATH, { token: second });
      expect(stale.statusCode).toBe(403);
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
      await expect(review.execute({ repo: "/repo" }, makeExec())).rejects.toThrow(
        /^ocr timed out \(effective 2 min = min\(request, shell\.maxTimeoutMs\)\)/u,
      );
      host.shell.scripts.push({ output: `{"error":"auth failed api_key=${PLAIN_KEY}"}` });
      const failed = (await review.execute({ repo: "/repo" }, makeExec())) as string;
      expect(failed).toMatch(
        /ocr output parsing failed: OCR output has an invalid or missing status: \(none\)/u,
      );
      // 单位口径锁：{limit} 插的是 RAW_ECHO_LIMIT=500，而 echoRaw→truncateEnd 那一刀按
      // **UTF-16 码元**数计（一张 emoji 占 2 枚）——写 "characters"/"字符" 会把给模型的说明
      // 夸大约一倍。故这里钉的是单位词本身：换成"码元"以外的任何写法这条就红。
      expect(failed).toContain("first 500 UTF-16 code units of the raw output (redacted)");
      expect(failed).not.toContain(PLAIN_KEY);
      host.shell.scripts.push({ output: REVIEW_JSON });
      const ok = (await review.execute({ repo: "/repo" }, makeExec())) as { hint: string };
      expect(ok.hint).toBe(MESSAGES.en.reviewSummaryHint);
    });

    it("命令构造层的拒绝理由也随 en（绝对路径 / 错类型 / 空清单三类闸判定不变）", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      const review = toolOf(host, "ocr_review");
      await expect(review.execute({ repo: "relative" }, makeExec())).rejects.toThrow(
        "repo must be an absolute path (starting with /): relative",
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
      ).rejects.toThrow("repo 必须是绝对路径（以 / 开头）：relative");
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
      const badPreview = (await preview.execute({ repo: "/repo" }, makeExec())) as string;
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

    it("端点回执按 en：必填闸、body 闸、降级原因与 500 的可读 error", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      const missing = await post(host, SELECT_PATH, { body: JSON.stringify({ provider: "amd" }) });
      expect(String(bodyOf(missing)["error"])).toBe(MESSAGES.en.providerModelRequired);
      const garbage = await post(host, SELECT_PATH, { body: "[1,2]" });
      expect(String(bodyOf(garbage)["error"])).toBe(
        "failed to parse the body: body must be a JSON object",
      );
      host.settingsValue["ocrConfigPath"] = "relative/ocr.json";
      const broken = await get(host, PROVIDERS_PATH);
      expect(broken.statusCode).toBe(500);
      expect(String(bodyOf(broken)["error"])).toBe(
        "the ocrConfigPath setting must be absolute or start with ~: relative/ocr.json",
      );
      const credless = makeHost({ locale: { preference: "en" }, credentialsService: false });
      applyPlugin(credless);
      const degraded = await get(credless, PROVIDERS_PATH);
      expect(String((bodyOf(degraded)["source"] as Record<string, unknown>)["message"])).toBe(
        MESSAGES.en.sourceCredentialsUnavailable,
      );
      expect(degraded.body).not.toContain(LIVE_KEY);
      const vanished = makeHost({ locale: { preference: "en" }, settingsVanishes: true });
      applyPlugin(vanished);
      const gone = await get(vanished, PROVIDERS_PATH);
      const goneSource = bodyOf(gone)["source"] as Record<string, unknown>;
      expect(String(goneSource["status"])).toBe("settings-failed");
      expect(String(goneSource["message"])).toBe(
        "calling the dsh settings service failed: the settings service holding llm-pi-ai became unavailable while being read",
      );
    });

    it("migrate 的写侧错误按 en 回执（坏 JSON 仍绝不覆盖用户配置）", async () => {
      const host = makeHost({ locale: { preference: "en" } });
      applyPlugin(host);
      writeOcrConfig("{ broken");
      const res = await post(host, MIGRATE_PATH);
      expect(res.statusCode).toBe(400);
      expect(String(bodyOf(res)["error"])).toMatch(/is not valid JSON; the write was aborted/u);
      expect(readFileSync(OCR_CONFIG, "utf8")).toBe("{ broken");
    });
  });

  describe("信任闸门：/_dsh/ocr-review/* 的四条路由", () => {
    /** DNS 重绑定：Host 是外域，sec-fetch-site 与 Origin 都自洽 ⇒ 只有 Host 腿拒得了。 */
    const REBINDING: Record<string, string> = {
      host: "evil.test:8787",
      origin: "http://evil.test:8787",
      "sec-fetch-site": FETCH_SITE_SAME_ORIGIN,
    };

    it("providers GET（发 token 的那条）被重绑定 ⇒ 403，体里不许带出 csrf 与任何 key", async () => {
      const host = makeHost();
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH, REBINDING);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/untrusted host/u);
      expect(res.body).not.toMatch(/csrf/u);
      expect(res.body).not.toMatch(/sk-/u);
    });

    it("select POST 带着合法 token 也照样被权威判据拒", async () => {
      const host = makeHost();
      applyPlugin(host);
      const res = await post(host, SELECT_PATH, { body: "{}", headers: REBINDING });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/untrusted host/u);
    });

    it("判据次序：恶意 Host 与 cross-site 同现时报 Host 腿那句", async () => {
      const host = makeHost();
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH, {
        host: "evil.test:8787",
        "sec-fetch-site": FETCH_SITE_CROSS_SITE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/untrusted host/u);
    });

    it("四条路由逐条都被拒（防「只在一条 handler 装了闸门」的漏装）", async () => {
      const host = makeHost();
      applyPlugin(host);
      const routes: readonly ["GET" | "POST", string][] = [
        ["GET", PROVIDERS_PATH],
        ["POST", SELECT_PATH],
        ["POST", MIGRATE_PATH],
        ["POST", TEST_PATH],
      ];
      // 闸门在 handler 的第一条语句、且判据与写响应都是同步的 ⇒ 不必逐条 await
      // （oxlint 的 no-await-in-loop 也不许那样写），先全部打完再一次批断言。
      const hits: { method: string; url: string; res: FakeRes }[] = [];
      for (const [method, url] of routes) {
        const res = makeRes();
        void routeOf(host, url).handler(
          makeReq({
            method,
            url,
            headers: REBINDING,
            ...(method === "POST" ? { body: "{}" } : {}),
          }),
          asRes(res),
        );
        hits.push({ method, url, res });
      }
      await Promise.resolve();
      for (const one of hits) {
        expect(one.res.statusCode, `${one.method} ${one.url}`).toBe(403);
        expect(one.res.body, `${one.method} ${one.url} 该报 Host 腿`).toMatch(/untrusted host/u);
      }
    });

    it("回环 Host + 异源 Origin ⇒ 拒（钉 Origin 腿没被删）", async () => {
      const host = makeHost();
      applyPlugin(host);
      const res = await get(host, PROVIDERS_PATH, {
        host: "127.0.0.1:8787",
        origin: "http://evil.test:8787",
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/cross-origin/u);
    });

    it("servingNonLoopback 是**接**出来的：只有 webServer.host 声明 0.0.0.0 才放本机网卡权威", async () => {
      // 这条钉的是 host.ts 那一行的**接线**（`webServer.host === "0.0.0.0"`），不是 trust 的
      // 纯函数判据（那份在 shared/test/trust.test.ts 里已经钉过）。把 `===` 改成 `!==`、或把
      // 整条删掉写死 false，下面两个断言会一起反掉 ⇒ 变异跑不掉。
      const lan = `${lanIpv4()}:8787`;
      const headers = {
        host: lan,
        origin: `http://${lan}`,
        "sec-fetch-site": FETCH_SITE_SAME_ORIGIN,
      };
      // 替身没声明服务面 ⇒ 保守拒：这是"宿主只绑回环"的常态。
      const loopbackOnly = makeHost();
      applyPlugin(loopbackOnly);
      const refused = await get(loopbackOnly, PROVIDERS_PATH, headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toMatch(/untrusted host/u);
      // 声明绑了 0.0.0.0 ⇒ 同一个请求过闸门，往后是 providers 的正常应答。
      const bound = makeHost({ webServerHost: "0.0.0.0" });
      applyPlugin(bound);
      const allowed = await get(bound, PROVIDERS_PATH, headers);
      expect(allowed.statusCode).toBe(200);
      expect(bodyOf(allowed)["csrf"]).toMatch(/[0-9a-f-]{36}/u);
    });
  });

  // ── 三个部署级调优值进 entry config（默认＝现值、非 volatile 不占设置卡）──────

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

    it("llmTestTimeoutMs：/test 端点把配置值当 resolve 的 deadline 下发", async () => {
      const host = makeHost();
      host.settingsValue["llmTestTimeoutMs"] = 7000;
      applyPlugin(host);
      const res = await post(host, TEST_PATH);
      expect(res.statusCode).toBe(200);
      expect(host.shell.resolveCalls[0]?.timeoutMs).toBe(7000);
      // llm test 的输出上限与前台共用同一字段（未覆盖时落 schema 默认）
      expect(host.shell.resolveCalls[0]?.stdoutMaxBytes).toBe(400_000);
    });

    it("三个新字段都不标 volatile ⇒ 不进设置卡表单", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      expect(form?.toSorted()).toStrictEqual(EDITABLE);
      for (const key of DEPLOYMENT) {
        expect(configDict()[key]?.meta?.["volatile"]).toBeUndefined();
      }
    });
  });
});
