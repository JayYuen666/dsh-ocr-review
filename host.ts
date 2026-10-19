// ocr-review dsh 插件 Host 半。
//
// 职责：
//   1. 声明设置面（effort/language/autoVerify/maxComments/timeoutMinutes/
//      ocrConfigPath）。命名空间是**隐式**的：宿主把本包导出 `Config` 里标了
//      `.volatile()` 的字段投影成设置表单，ns = profile 条目 id（`ocr-review`，见
//      cordis.patch.yml），没有 `settings.register(ns, schema, { base })` 这一层；
//      内置底座逐字段落成 schema 的 `.default()`，读本包设置一律 `config.<field>.get()`。
//      本包自带卡片，故只登记一次页面策略 `{ auto: false }`，不让宿主再生成一份自动页。
//   2. 注册 5 个模型工具：ocr_review（自驱 diff 审查）、ocr_scan（全文件扫描）、
//      ocr_delegate_preview / ocr_delegate_rule（委托模式脚手架）、ocr_session（会话内复查）。
//   3. 设置卡的官方读面（Typert Remote，namespace `ocrReview`）：providers / select /
//      migrate / test / probe 五个方法经宿主网关暴露给本 profile 的客户端。
//   4. 注册 systemPrompt 路由段（order 1555，紧邻 zg 1550 之后；不与 lesson-loop 1560 撞车）。
//
// provider 与 key 的来源（全部走宿主官方通道，见 createGateway）：
//   - 清单：ctx.settings.describe() 里 llm-pi-ai 那条的 value.providers。本包不读宿主
//     的私有配置文件，也不假设私有键路径。
//   - key：ctx.credentials 的 describe(ref)/resolve(ref)。本包不再读 .credentials.yaml。
//   - 两个服务都可能缺席（非 web profile、未装配 base bundle）→ 读面回可读的降级
//     原因，卡片显示「为什么不可用」；任何一条都不许在会话热路径抛穿。
//
// 安全要点：
//   - 所有用户可控字符串经 lib/argv-guard.ts 的 shq() 单引号转义；枚举型参数
//     （--format、session 子命令）走白名单钳制；错类型的字符串参数一律抛错（静默回落会扩大
//     审查范围）。repo 走 workdir 字段或转义后的位置参数，绝不裸拼。
//   - key 只在 get-cred.mjs 内部读取并按需输出给 OCR，绝不经 HTTP/工具返回；宿主侧
//     resolve() 拿到值也只用于确认「解析得到」，当场丢弃。
//     OCR 原始 stdout/stderr（错误详情、llm test、解析失败回显、session 透传）
//     出宿主前统一过 redactKeyMaterial()。
//   - Remote 读面只经官方网关暴露给**本 profile 的客户端**，来源校验与鉴权由网关承担；
//     provider/model 必须命中 settings 服务返回的列表（白名单），这条闸门护的是动作本身，
//     与传输方式无关。
//   - 评审/扫描输出统一走 --output 临时文件（防宿主 stdout 截断），解析后即删。
//   - review/scan 命令经 wrapWithHostReaper 包装（lib/cli.ts）：dsh 任何方式退出
//     （含 kill -9 后 macOS launchd 收养）OCR 进程都会被 TERM→1s→KILL 回收。
//     前台另把 exec.signal 交下去（调用被中止即停进程）；后台**不接**那个信号，
//     否则一次程序执行结束就会停掉后台评审（见 startBackground 的生命周期注释）。
//
// 运行方式：dsh 的 cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 运行时值导入只有 @deepseek-ai/schemastery（Config schema：`.volatile()` 与
// volatile 字段的引用化只在这个宿主 fork 里有实现，公共 schemastery@3.18 没有，
// 用它的产物，设置卡写得进、读不到）、@deepseek-ai/dsh-credentials（在
// peerDependencies，只取两枚纯语法件，见下面的 import 注释）、
// @deepseek-ai/dsh-typert-protocol（Remote 的 Service 基类与装饰器工厂，同在
// peerDependencies）、@deepseek-ai/dsh-home-paths 与 @deepseek-ai/dsh-atomic-write
// （lib/ocr-config.ts 与 lib/config-store.ts 取 resolveDshHome/expandHomePath 与
// writeFileAtomic/withFileLock——外部 config.json 的定位与落盘锁都归官方件，这两件也在
// peerDependencies）以及 @jayyuen66/dsh-plugin-shared；
// cordis / dsh-settings / dsh-tools / dsh-shell / dsh-system-prompt
// 一律 type-only（运行时服务由 ctx 注入，见 plugins/README.md 的解耦原则；工具面与
// shell/systemPrompt 两面的类型绑官方见下面 import 段）。dsh-credentials 是
// **值导入且在 peerDependencies**，但只取它两枚纯语法件（见下面的 import 注释），凭据读写仍走
// ctx.credentials——服务面没有因此开口。

import Schema from "@deepseek-ai/schemastery";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context, Fiber, Volatile } from "@deepseek-ai/cordis";
// 设置卡的官方读面：`TypertRemoteService` 是**类**（要 `extends`），`Remote` 是装饰器
// 工厂，二者都没有 type-only 的造法，故落 peerDependencies（`dependencies` 是禁区，由
// test/publish-manifest.test.ts 钉着），产物里保持裸说明符（build-host.mjs 的外部化
// 名单读 dependencies ∪ peerDependencies）。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
// 类型侧绑定官方声明：describe() 的字段名（ns/value）与凭据读的返回形状一旦在上游
// 改动，typecheck 立刻报错，而不是运行时静默读不到 provider。
import type { SettingsDescriptor, SettingsForms } from "@deepseek-ai/dsh-settings";
// 值导入：`isCredentialRefName` / `credentialRef` 是凭据包自己交出的**官方**校验与
// 品牌构造（installed lib/index.js:13 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`、
// :21-36），本包原先自己抄了同一条正则当 ref 语法——抄一条规则就多一处会跟着宿主漂移的
// 判据。两者都是纯字符串函数；官方品牌没有 type-only 的构造方式，故落
// `peerDependencies`（值导入必须由宿主在场提供，而 profile 不装 peer，所以不产生第二份；
// `dependencies` 是禁区，理由见 `test/publish-manifest.test.ts`）、产物留裸说明符
// （`test/build-host.test.ts` 同时钉"说明符在"与"函数体不在"，
// 并钉 `dsh-brand` 不得出现在本包产物里——brand 是 credentials 自己的依赖）。
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import type { CredentialProvider } from "@deepseek-ai/dsh-credentials";
// 工具注册/执行面绑官方声明（devDependency @deepseek-ai/dsh-tools，与运行宿主同版本）：
// 注册面直接 `Pick` 官方服务类 `ToolRuntime` 的成员（不再重述 register 的签名），
// 执行面/输出面载荷（ToolRunContext / ToolOutputDefinition / JsonSchemaNode）一旦在上游
// 改名或换形状，typecheck 立刻在本包报错，而不是运行时静默注册不上。仍是 type-only——
// 产物里不留说明符（锁见 test/build-host.test.ts）。
import type {
  JsonSchemaNode,
  ToolOutputDefinition,
  ToolRunContext,
  ToolRuntime,
} from "@deepseek-ai/dsh-tools";
// shell / jobs / systemPrompt 这几面同批绑官方声明（各自的 devDependency 与运行宿主
// 同版本）。服务成员一律经 `Pick<官方类, "方法名">` 投影而不是重抄签名：载荷与返回
// （resolve 的 ShellExecRequest、execute 的 ShellExecSpec / ShellExecution、
// section 的 PromptSection、result() 的 ShellRunResult）由官方
// 给出，上游改名/换形状就是本包编译错误，而不是运行时静默读不到。
// 仍是 type-only：产物里不得出现这些说明符（锁见 test/build-host.test.ts）。
import type {
  ShellExecution,
  ShellExecutor,
  ShellProcessStatus,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
// 沙箱策略按调用携带（官方 `SandboxExecutionPolicy` 定义在 dsh-sandbox，dsh-shell 自己
// 只内部 import、并不再导出，所以取类型必须直引）。同样是 type-only，产物里不得出现该
// 说明符（锁见 test/build-host.test.ts）；包本身已在 devDependencies 声明，不需要进运行时。
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
// 后台评审的子进程登记为官方作业（ctx.jobs）。口径与上面几面一致——type-only +
// `Pick<官方类, 方法>` 投影，注册表实例由宿主注入（dsh-base 默认装载 dsh-jobs-local），
// 产物里不得出现这两个说明符（针在 test/build-host.test.ts）。
import type {
  JobId,
  JobOutcome,
  JobOutputSource,
  JobRegistry,
  JobSourceRead,
  JobSpec,
  JobStatus,
} from "@deepseek-ai/dsh-jobs";
// 落定进程 → 作业结局的映射与收子进程的 killProc 都取 shared 那一份（口径抄的是宿主 bash 工具；
// killProc 吞掉的那条异常为什么承重，看 startBackground 里 cancel 那一臂的注释）。
import { jobOutcomeOf, killProc } from "@jayyuen66/dsh-plugin-shared/lib/job-outcome";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
// 代理对安全的定长截断（前切面已交官方 output-retention，后切面仍在本仓；
// 语义与官方件的实测差异见 shared/lib/text.ts 头注释）：
// 进会话日志的自制切点一律走这里，裸 slice 会在切点留下孤立高/低代理。
import { truncateEnd, truncateStart } from "@jayyuen66/dsh-plugin-shared/lib/text";
import { MESSAGES, format } from "./lib/messages.ts";
import type { OcrReviewMessages } from "./lib/messages.ts";
import { assertToolOutput, redactKeyMaterial, stripAnsi } from "./lib/output.ts";
import {
  buildReviewCommand,
  buildScanCommand,
  wrapWithHostReaper,
  buildDelegatePreviewCommand,
  buildDelegateRuleCommand,
  buildSessionCommand,
  buildLlmTestCommand,
  buildVersionCommand,
  parseOcrVersion,
  resolveOcrAvailability,
  withHomeEnv,
  describeValue,
  resolveRoot,
  EXPECTED_OCR_CLI_VERSION,
  ocrCommandsFor,
} from "./lib/cli.ts";
import type { OcrBinaryStatus, OcrInstallChannel, OcrInstallPreference } from "./lib/cli.ts";
import { clampEffort } from "./lib/argv-guard.ts";
import {
  parseReviewOutput,
  parseDelegatePreview,
  parseDelegateRules,
  summarizeReview,
} from "./lib/parse.ts";
import type { ReviewSummaryView } from "./lib/parse.ts";
import { ROUTING_NAME, ROUTING_ORDER } from "./lib/routing.ts";
import {
  providersForCard,
  applyProviderSelection,
  ensureKeyScriptPointer,
  migratePlaintextKeys,
  resolveOcrConfigPath,
  ocrHomeOverride,
} from "./lib/ocr-config.ts";
import type { EndpointVerify } from "./lib/ocr-config.ts";
import { OCR_REMOTE_NAMESPACE } from "./lib/remote-shape.ts";
import type {
  OcrMigrateReply,
  OcrProbeReply,
  OcrSelectReply,
  OcrSelectRequest,
  OcrTestReply,
} from "./lib/remote-shape.ts";
// provider 清单的来源层与外部 config.json 的落点层各自成模块（判据分家，见那两个文件的头
// 注释）：命名空间常量在 lib/provider-source.ts，脚本落点在 lib/config-store.ts。
import { PI_AI_NAMESPACE } from "./lib/provider-source.ts";
import { defaultCredScriptPath } from "./lib/config-store.ts";
import type { DshConfigGateway, ProviderDescriptor } from "./lib/provider-source.ts";
import type { OcrPaths } from "./lib/config-store.ts";
import { hasMethods, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

// 官方给生产者的 kind 扩展点（installed dsh-jobs/lib/types/view.d.ts 的 JobKindMap，
// dsh-tool-pwsh / dsh-tool-workflow 同款写法）：kind 既是命名空间也是 id 前缀。
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "ocr-review": "ocr-review";
  }
}

// ── 常量 ────────────────────────────────────────────────────────────────────

// 设置命名空间不由本包持有：隐式注册下 ns = profile 条目 id（`ocr-review`，
// 见 cordis.patch.yml），可编辑字段由 `Config` 上的 `.volatile()` 声明（见下文）。

const PLUGIN_DIR = import.meta.dirname;
// 前台超时语义（宿主 shell = bash-local）：resolve 以
// clampTimeout(请求, timeoutMs, maxTimeoutMs) = min(请求 ?? 120s, maxTimeoutMs) 收口，
// maxTimeoutMs 是 shell 执行器插件自己的 volatile 设置项（bash-local 缺省
// 600000 = 10 分钟），在它的设置行/设置页上改，没有配置文件级的段落可写。foreground
// 不存在"不限时"：本插件 0/未设置 = 请求宿主上限（下发本常量，被 clamp 到
// maxTimeoutMs）；后台通道（wait=false）不给进程挂宿主 deadline（resolve 里显式带
// onExpiry:"none"，官方缺省是 'kill'），但本包给它加了 OCR_BACKGROUND_MAX_MS 那一档
// 兜底回收——所以"真不限时"这句在文案里也不许再写（连卡片与工具参数说明都钉住了）。
// 2^31-1 = 宿主 timer 上限。
const MAX_TIMEOUT_REQUEST_MS = 2_147_483_647;
const LLM_TEST_TIMEOUT_MS = 90_000;
/** 状态探测（`ocr version`）的墙钟（毫秒）。CLI 自己那层 npm 包装给同一件事是 3 秒
 *  （`scripts/update.js` 里 `spawnSync(bin, ["version"], {timeout: 3000})`），但那是
 *  直跑原生二进制；我们从 shell 起、还要过一层 JS launcher，故放宽到 15 秒。它只在
 *  人按下「检测」时跑，不进任何热路径，因此不做成设置项。 */
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const STDOUT_MAX_BYTES = 400_000;
/** `--output` 落盘结果的读取上限（字节）。**刻意不取 STDOUT_MAX_BYTES**：`--output` 存在的
 *  理由正是「结果比 stdout 缓冲大」，用 400 KB 卡它等于把正常的大仓评审判死。这一枚只是
 *  护栏，把「整份读进内存」的失败形态从 OOM 换成一条点名文件的错误。 */
const OUT_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** 解析失败时回显给模型的原始内容长度上限（UTF-16 码元；已脱敏）。
 *  单位写码元而不是"字符"：本常量喂给 `echoRaw`→`truncateEnd`，那一刀按码元数计
 *  （一张 emoji = 2 枚），写"字符"会把给模型的说明夸大约一倍。 */
const RAW_ECHO_LIMIT = 500;
/** 评论截断条数的内置默认（旧 BUILTIN_BASE 的那一项）：schema 的 `.default()` 与
 *  「读到坏值时的回退」（readMaxComments）共用这一个数，两处不许各写一份字面量。 */
const MAX_COMMENTS_DEFAULT = 12;

// ── 宿主服务面（运行时由 ctx 注入，一律 type-only）──────────────────────────
// 工具面（`ToolRuntime` 的成员面 + ToolRunContext / ToolOutputDefinition / JsonSchemaNode）
// 与 shell / jobs / systemPrompt 等服务面都已绑 `@deepseek-ai/*` 官方声明，本文件不再
// 手抄它们的形状：字段可选性过去是「一律对齐 harness 声明」的手工纪律
// （packages/shell/shell/src/types.ts、packages/subprocess/subprocess/src/types.ts），
// 现在由 `Pick` 保证——官方把必有字段改成可选、或给载荷添一个必填字段，这里立刻是编译错误，
// 而不是调用点静默放过 undefined。
//
// 这些官方服务面都是 `Service` 子类（`ShellExecutor` 还是 abstract）：基类的 protected
// `ctx` 加各自的 private 字段（SystemPrompt 的 layers，
// ToolRuntime 的 deferredContexts/layers/…），
// TS 对带这类成员的类按名义比 → 结构替身永远满足不了整个类类型（test/host.test.ts 的
// 替身就是结构替身）。故服务成员只取 `Pick<官方类, "方法名">` 的**方法面投影**：投影本身
// 是结构类型，被 Pick 的那个方法的入参与返回仍是官方类型（载荷/返回一律不复述）。
//
// 官方名与旧镜像名的差异（绑定后以官方名为准）：前台结果 `ShellResult` →
// `ShellRunResult`；带 result() 的执行句柄 `ShellProcess` → `ShellExecution`（官方
// `ShellProcess` 只有后台进程面，没有 result()）；`CollectedOutput` 与旧手抄逐字段一致
// （text 是截断后的尾部、truncated 必有布尔、spillPath 可选），故不再本地声明。
// 旧手抄还整体偏窄：`ShellRunResult` 另有 signal / timeoutMs / sandbox?，
// `ShellExecRequest` 另有 stdin / dshEnv / sandboxPolicy，`ShellExecution` 另有
// readOutput() / observed / signal，`PromptSection` 另有 interpolate / complete。

/** shell 执行面的方法投影。官方 `ShellExecutor` 只有 `resolve`/`execute` 两个抽象方法，
 *  且二者**收的不是同一个类型**：`resolve` 调用方给 `ShellExecRequest`（workdir/timeoutMs
 *  可选，由实现方按自己的 volatile 设置项填默认并 clamp），`execute` 只收 `resolve`
 *  交回的已解析 `ShellExecSpec`。唯一的执行入口：前台 await 句柄的 result()（仅基础
 *  设施故障才 reject），后台直接留句柄不等运行结束；组合 teardown 时仍在运行的进程由宿主
 *  接管清理。`onExpiry` 缺省 'kill'，后台任务显式传 'none' 才取到无界。
 *  句柄的 done 在进程关闭时落定且从不 reject；kill() 幂等，已退出时返回 false。 */
export type ShellService = Pick<ShellExecutor, "resolve" | "execute">;

/**
 * 官方 JobRegistry（@deepseek-ai/dsh-jobs，abstract Service + protected ctx → 名义比较）
 * 的方法面投影：本包用这五位，缺一位都跑不通——
 *  - `start`：把后台评审的子进程登记成作业（`kind: "ocr-review"` ⇒ id `ocr-review-<16 位 hex>`，
 *   注册表按 randomUUID 截短发号，不是递增序号）；
 *  - `kill`：工具调用被中止时经注册表收，而不是绕过它直接杀进程（否则官方名册里那条
 *   永远停在 running，环也一直不关——实测同 zvec-grep）；
 *  - `attachController`：实测官方件在「没有 controller 服务这个 owner」时**拒绝 start**，
 *   而本包的作业是**未拥有**的（受有作业要 dsh-agent 注册表）。web 面上宿主自己的
 *   `tool-jobs` 被移进了各 preset realm（packages/bundle/web-app/cordis.patch.yml 把它
 *   在宿主平面 disabled）⇒ 未拥有那一桶只有从无作用域上下文 attach 的 controller 服务得到，
 *   本包必须自己挂一枚——但**只在 start 那一瞬**（见 `startUnderOcrController`）；
 *  - `list` / `remove`：登记新作业前剪掉本 kind 最老的**已落定**记录。注册表不替生产者
 *   回收记录（官方契约："A settled record stays listed until its owner's disposal,
 *   service disposal, or an explicit remove"），而它随宿主活着、不随本插件卸载而死 ⇒
 *   不剪就是每次后台评审永久留一条记录外加一只最多 256 KiB 的环。
 */
type JobsService = Pick<
  JobRegistry,
  "start" | "list" | "get" | "kill" | "remove" | "wait" | "attachController"
>;

/** 官方注册表里本包作业的 kind；宿主据此签发的 id 形如 `ocr-review-<16 位 hex>`。 */
const OCR_JOB_KIND = "ocr-review";

/**
 * 本 kind 在注册表里的**已落定**记录上限。同时能跑几个不在这里——那是注册表的容量闸
 * （实测未拥有桶 10，满员是**拒绝**新 start，不是淘汰旧的）。
 */
const OCR_JOB_HISTORY_MAX = 10;

/**
 * 后台评审的兜底回收窗口（毫秒）；0 = 不设窗口，进程只由宿主退出、会话 dispose、插件卸载
 * 或显式 job_kill 结束。
 *
 * 本包刻意不套宿主 timeoutMs（`onExpiry: "none"`：外部 CLI 的正常时长跨度太大，套了就等于
 * 替用户砍掉长评审）。不设窗口的代价落在注册表上：未拥有作业共用一只 10 格的桶（实测
 * `running` 与 `stopping` 都计数，满员是**拒绝**后来的 start），一条挂死的 CLI 就永久占一格，
 * 连别的插件也起不来。要给这一格腾位的部署把本项设成非零毫秒数：到点经注册表收，记录推到
 * stopping，理由落进模型可见的 detail。
 */
const OCR_BACKGROUND_MAX_MS = 0;

/** "仍在跑"的两枚官方状态：`stopping` 是取消已发出、进程还没收完。 */
function isLiveOcrStatus(status: JobStatus): boolean {
  return status === "running" || status === "stopping";
}

/**
 * 剪掉本 kind 最老的已落定记录，给下一次登记腾出窗口（注册表按登记序返回，故取头部）。
 * 在跑与正在收的一条不动：官方件对活作业的 remove 直接抛，而"静默杀掉用户发起的评审"
 * 正是本包要消灭的形态。
 * @param jobs 官方注册表
 * @returns {void}
 */
function pruneOcrJobHistory(jobs: JobsService): void {
  const settled = jobs
    .list()
    .filter((job) => job.kind === OCR_JOB_KIND && !isLiveOcrStatus(job.status));
  // 剪到 MAX-1 而不是 MAX：这一趟在 `start` **之前**跑，起完就是 MAX 条。按 MAX 剪等于
  // 每次登记后窗口里都是 MAX+1 条，而文案与卡片说的是"保留最近 MAX 条"（差的那一格
  // 选择在剪枝边界修，而不是把 MAX 改成 11）。
  const excess = settled.length - (OCR_JOB_HISTORY_MAX - 1);
  for (const job of settled.slice(0, Math.max(excess, 0))) {
    jobs.remove(job.id);
  }
}

/**
 * 在 controller 闸门下起一条未拥有作业，起完立刻摘掉。
 *
 * 实测：挂上即放行、摘掉即恢复"没有 controller 服务这个 owner"的拒绝、可反复；而 global 层
 * 那串 token 只被 `servesOwner` 读（installed dsh-jobs-local 全文唯一消费点），作业后续的
 * read/kill/落定都不依赖它。所以常驻一枚等于在"宿主故意没装 job 工具"的组成里替全宿主
 * 开着那道闸门——官方契约写的是"生产者不能起一台 owner 收不掉、停不掉的作业"。
 */
function startUnderOcrController(jobs: JobsService, spec: JobSpec): JobId {
  const detach = jobs.attachController("ocr-review: background");
  try {
    return jobs.start(spec);
  } finally {
    detach();
  }
}

/**
 * 等到兜底 deadline 到点，然后把仍在跑的那条经注册表收掉。
 *
 * 用注册表自己的 `wait(id, ms)` 而不是宿主 timer，也不是裸 `setTimeout`：前者要把
 * `timer` 写进 HostCtx 的**必需**服务面（装载守卫一扩，没装那件的宿主连前台评审都装载
 * 不了），后者会活过插件卸载。实测 `wait` 只等不杀、作业一落定就解掉它内部的定时器，
 * 也不推进输出游标（模型侧 job_output 的读数不受影响）——所以落定时这里看一眼状态就返回。
 * @param jobs 官方注册表
 * @param id 这次后台评审的作业 id
 * @param reason 到点回收时写进模型可见 detail 的理由
 * @param backgroundMaxMs 窗口毫秒数；`<= 0`（部署级设置项 `ocrBackgroundMaxMs` 的默认值）
 *   表示这条不设兜底窗口，直接返回、不去敲 `wait`
 * @returns 等完这一条的兜底窗口；抛错一律就地收敛（记录没了就等于无事可做）
 */
async function enforceOcrDeadline(
  jobs: JobsService,
  id: JobId,
  reason: string,
  backgroundMaxMs: number,
): Promise<void> {
  try {
    if (backgroundMaxMs <= 0) {
      return;
    }
    const view = await jobs.wait(id, backgroundMaxMs);
    if (view.status === "running") {
      jobs.kill(id, undefined, reason);
    }
  } catch {
    // 这条已经不在了（记录被窗口裁剪收走、或服务被重载）⇒ 兜底本来就无事可做。
  }
}

/**
 * 卸载时收掉本包仍在跑（或正在收尾）的作业。
 *
 * 注册表随宿主活着，不会因为我们卸载而杀进程：一条留在 `running` 的 OCR 既继续占着未拥有
 * 那一桶的容量位（实测满员是拒绝别人的 start），又没人再等它的输出。遍历的是注册表的
 * `list()` 而不是本包记的账——本包不留常驻状态，跨会话/跨 fiber 起的作业也要能被收掉。
 * @param jobs 官方注册表
 * @param reason 写进模型可见 detail 的理由（双语字典取）
 * @returns {void}
 */
function reclaimOcrJobs(jobs: JobsService, reason: string): void {
  const mine = jobs.list().filter((job) => job.kind === OCR_JOB_KIND);
  for (const job of mine) {
    if (isLiveOcrStatus(job.status)) {
      jobs.kill(job.id, undefined, reason);
    } else {
      // 已落定的也要 remove：本包不留常驻状态、也没有"下一次 apply 来剪窗口"（用户直接
      // 禁用本包就再没有 apply），留着就是每条最多 256 KiB 的环永久钉在宿主里。
      jobs.remove(job.id);
    }
  }
}

/** ctx.tools 的方法面投影。官方 `ToolRuntime` 是带私有字段的 `Service` **类**（installed
 *  `@deepseek-ai/dsh-tools/lib/types/index.d.ts:512`，`Context.tools: ToolRuntime` 的增强在
 *  同文件 `:34`），结构替身不可能满足它（TS 对类按名义比），故与上面 `ShellService` / 下面
 *  `SystemPromptService` 同一口径：只 `Pick` 本包要调的那一个方法，不再复述它的签名。
 *  载荷与 disposer 自此全部由官方成员交出（installed 同文件 `:619`
 *  `register(definition: ToolDefinition): () => void`——`ToolDefinition` 的
 *  name/description/parameters 来自 ToolSchema，output 是 ToolOutputDefinition，execute 收
 *  ToolRunContext）：旧镜像把这一位重抄了一遍，官方改参数名/加必填参数时镜像照样编译通过、
 *  调用点静默拿到错形状；绑上去后那就是本文件的一枚编译错误。 */
export type ToolsService = Pick<ToolRuntime, "register">;

/** systemPrompt 的 `section` 方法面投影：载荷绑官方 `PromptSection`（name/order 必填，
 *  text 除字符串外还可以是逐次装配求值的 provider，另有 interpolate/complete 两个本包
 *  不用的可选旗标），disposer 按官方的 `() => void` 收——旧镜像把返回写成 `unknown`，
 *  等于宣称宿主可能交不出撤销句柄。 */
export type SystemPromptService = Pick<SystemPrompt, "section">;

/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations`
 * → 名义比较）的方法面投影。命名空间由宿主按导出的 `Config` 隐式投影，插件侧不调
 * `settings.register`，所以本包只用两位：`configure`（登记本页的页面策略）与
 * `describe`（跨命名空间读）。
 * 旧镜像有两处自己裁定：`owner?: unknown`（把官方 `owner?: Fiber` 放宽，好让
 * `HostCtx.fiber: unknown` 能塞进来）与 `describe: () => SettingsDescriptor[]`（丢了官方
 * 那个可选的 `SettingsDescribeOptions` 入参，installed :96）。现在两处都归官方。
 */
export type SettingsFormsService = Pick<SettingsForms, "configure" | "describe">;

/** `ctx.inject(deps, callback)` 回调收到的子上下文（本包只用到 settings + effect）。 */
export interface InjectedCtx {
  settings: SettingsFormsService;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`，两条重载）——本地不再重述工厂签名。
   *  官方返回域不收 `undefined`，而本包唯一的挂载点交回的就是 `configure` 的 disposer。 */
  effect: Context["effect"];
}

/**
 * 官方凭据服务（installed `@deepseek-ai/dsh-credentials/lib/types/index.d.ts:99` 的
 * `Context.credentials: CredentialProvider`）的方法面投影：本包只 `describe`（探一眼
 * 记录种类）与 `resolve`（取值）。返回值 `CredentialInfo` / `ResolvedCredential` 原本
 * 就已绑官方，两位**方法签名**改由官方成员交出，不再本地裁定入参与可选性。
 * 官方签名收的是品牌类型 CredentialRef；credentialRef() 只做「语法校验 + 编译期 brand」，
 * 运行时值就是字符串（credentials-local 的 resolve/describe 直接拿它当 Map 键，
 * index.ts:617-639），所以本包按 string 收参并在调用前用官方语法自行校验，换掉一次值导入
 * （见文件头：服务面 cordis/dsh-settings/dsh-tools 等仍一律 type-only，值导入的只有宿主
 * fork 的 schemastery 与凭据包的两枚 branded-string 语法件）。
 */
type CredentialsService = Pick<CredentialProvider, "describe" | "resolve">;

export type ToolRunAgent = NonNullable<ToolRunContext["agent"]>;
export type ToolRunSession = ToolRunAgent["session"];
export type ToolRunSessionHeader = ToolRunSession["header"];

/**
 * `agent` 的**走线投影**：三级成员名全部 `Pick`/`Omit` 自官方声明
 * （`dsh-tools/lib/types/index.d.ts:229` `readonly agent?: Agent`、
 * `dsh-agent/lib/types/runtime-types.d.ts:143` `readonly session: Session`、
 * `dsh-session/lib/types/index.d.ts:119` `readonly header: SessionHeader`），
 * 只有**可空性**按运行时事实放宽：递给工具的那位是跨进程装配出来的对象，
 * 官方必填的 `session`/`header` 实测可能缺席（test/host.test.ts 钉住这些 fail-closed
 * 路径）。上游改名照样红在编译期，而 `sessionHeaderCwd` 的逐层 `?.` 从此是真守卫。
 */
export type SessionHeaderWire = Pick<ToolRunSessionHeader, "cwd">;
export type SessionWire = Omit<ToolRunSession, "header"> & { readonly header?: SessionHeaderWire };
export type AgentWire = Omit<ToolRunAgent, "session"> & { readonly session?: SessionWire };

/** harness 执行面里本包真正读到的两个成员，`signal` 直接 `Pick` 官方 `ToolRunContext`
 *  （= `ToolDefinition.execute` 的第二参）：必填性由官方决定，不再本地裁定——
 *  `signal` 必填（ToolExecutionInput 注释 "Required caller-owned cancellation for this
 *  invocation"，声明成可选等于把取消能力在 5 个调用点静默降级）。`agent` 走上面的
 *  走线投影。 */
export type ToolExec = Pick<ToolRunContext, "signal"> & { readonly agent?: AgentWire };

/** 当前会话工作区（repo 缺省回退源）；非字符串视为缺。
 *  官方形状：`agent?: Agent` → `session: Session` → `header: SessionHeader` →
 *  `cwd?: string`。下面的逐层 `?.` 与 `typeof` 复核是跨进程契约的运行时闸：宿主半装配
 *  递来的 agent 可能是 `null`、也可能没有 `session`/`header`（test/host.test.ts 钉住
 *  这两条 fail-closed 路径），值一律经 `unknown` 读，绝不只信声明。 */
function sessionHeaderCwd(exec: ToolExec): string | undefined {
  const raw: unknown = exec.agent?.session?.header?.cwd;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export interface HostCtx {
  settings: SettingsFormsService;
  shell: ShellService;
  tools: ToolsService;
  systemPrompt: SystemPromptService;
  /** 本插件 fiber：`configure` 的 owner 必须显式传它（缺省是 settings 服务自己的 fiber）。
   *  类型即官方 `configure(presentation, owner?: Fiber)` 的那位 `Fiber`。 */
  fiber: Fiber;
  /** 隐式注册后本包不再持有 scope，只经子上下文挂页面策略（宿主 client-locale 同款）。 */
  inject: (deps: readonly string[], callback: (child: InjectedCtx) => void) => unknown;
  /** 服务读取面取官方 `Context["get"]`（installed `@deepseek-ai/cordis/lib/types/reflect.d.ts:14`
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`），
   *  本地不再重述一枚 `get`。本包读的 `settings` / `credentials` 两个名字**都**是官方声明进
   *  `Context` 的成员（`@deepseek-ai/dsh-settings/lib/types/index.d.ts:24-29`、
   *  `@deepseek-ai/dsh-credentials/lib/types/index.d.ts:98-102`），故走泛型臂拿到
   *  `undefined | 官方服务类`，**不走**那条 `get(name: string): any` 兜底（reflect.d.ts:17）。
   *  旧镜像尾臂 `(name: string): unknown` 是「还会读别的名字」的占位，实际没有——删它不减防御，
   *  少的是一个人人都能塞名字的自由入口。
   *  返回整类而不是本包的 `Pick` 投影也不是加宽：投影留在**使用点**上（`createGateway`
   *  里那两个 `usableService` 的返回类型）。
   *  `undefined` 是官方语义（"or `undefined` when not (yet) provided"）：base bundle 未装配
   *  （精简 profile）时宿主确实交不出服务，下面两处运行时闸照旧。 */
  get: Context["get"];
}

/** host 是否为本插件所需服务面（settings/shell/tools/systemPrompt/get/inject 及
 *  其上要调用的方法）。守卫仅压缩类型面、避开 `as unknown as HostCtx` 断言。
 *  settings 这里点名的两个方法都会被调用：configure 登记本页的页面策略、describe
 *  跨命名空间读（provider 清单 + 官方 locale 偏好）；inject 挂那条页面策略的 effect。
 *  settings 面没有 register/get，多点名一个就是永不成立的死分支。 */
function isOcrReviewHost(value: unknown): value is HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { settings, shell, tools, systemPrompt, inject, get } = value;
  return (
    hasMethods(settings, ["configure", "describe"]) &&
    hasMethods(shell, ["resolve", "execute"]) &&
    hasMethods(tools, ["register"]) &&
    hasMethods(systemPrompt, ["section"]) &&
    typeof inject === "function" &&
    typeof get === "function"
  );
}

/** 从插件 Context 解析宿主服务面（守卫收窄，不做 `as unknown as` 断言）。 */
function resolveHost(ctx: Context): HostCtx {
  if (!isOcrReviewHost(ctx)) {
    // 装载期守卫：此刻连 settings 面都还没验过，语言偏好无从读取，故这条只以中文报出。
    throw new Error(
      "ocr-review: 宿主缺少所需的 shell/tools/settings/systemPrompt/inject 服务界面（或其方法）",
    );
  }
  return ctx;
}

/** describe() 行里按命名空间取解析值（跨命名空间读只有 describe() 一条路：
 *  `settings.get(ns)` 已删）。未注册该命名空间 → undefined，调用侧按默认值降级。
 *  @param rows - `ctx.settings.describe()` 的返回（全部条目的表单投影）。
 *  @param ns - 要读的命名空间（官方字段名是 `ns`）。
 */
function describedValue(rows: readonly SettingsDescriptor[], ns: string): unknown {
  return rows.find((row) => row.ns === ns)?.value;
}

/**
 * 取本包 host 侧文案（按官方 locale 偏好现取现用）：设置页「常规」里换语言后，
 * 下一次工具调用/端点请求即换新文案，不需要重启或重装插件。
 * locale 命名空间未注册（无官方 client-locale 包）→ describe() 里没有这条 →
 * undefined → 中文默认。
 */
function localeMessages(host: HostCtx): OcrReviewMessages {
  const preference = describedValue(host.settings.describe(), LOCALE_SETTINGS_NAMESPACE);
  return messagesFor(MESSAGES, resolveLocalePreference(preference));
}

// ── 工具输出：canonical JSON 值 ─────────────────────────────────────────────

/** 官方 `output.render` 的返回类型（`ContentBlock[]`）：从 `ToolOutputDefinition` 取，
 *  不再手抄 `{ type: "text"; text: string }` ——抄的那份不会随官方块类型演化而漂。 */
type RenderedContent = ReturnType<ToolOutputDefinition["render"]>;

/**
 * render 只做 model-facing 展示：把 canonical value 本身 pretty-print 成文本块。
 * execute 直返结构化对象（不再 stringify 进 `{ text }`），所以这里 stringify 的是
 * 第一层也是唯一一层 JSON；循环结构/不可序列化值的两级兜底是防御，不是常规路径。
 */
function textBlock(value: unknown): RenderedContent {
  let text: string;
  try {
    // 官方 lib 把 `JSON.stringify` 的返回写成 `string`，规范上却允许返回 `undefined`
    //（值为 undefined / 函数 / Symbol 时 step 1 直接给 undefined）⇒ 这里显式收成
    // `unknown` 再判类型，兜底那一臂才是真守卫而不是恒假条件。
    const json: unknown = JSON.stringify(value, null, 2);
    text = typeof json === "string" ? json : String(value);
  } catch {
    try {
      text = String(value);
    } catch {
      text = "[unrenderable value]";
    }
  }
  return [{ type: "text", text }];
}

// 每个工具自己的 output schema（官方 `ToolOutputDefinition.schema` 收的类型是
// `JsonSchemaNode`，不是任意 Record：`satisfies` 让每个关键字都在官方子集里点名过，
// 写了子集外的关键字就是编译错误，而不是宿主运行期 ToolOutputError）。
//
// 契约（docs/cookbook/adding-a-tool.md）：execute 只返回推断出的 canonical JSON 值，
// 不再把结构化对象 stringify 进 `{ text }`（双重编码会让 PTC 的
// `await tools.<name>(args)` 拿到字符串化的 JSON 而非对象），human explanation 留在
// render。schema 与 execute 返回逐分支对齐；解析失败分支的诚实值是一段说明字符串，
// 故 review/scan/preview/rule 的根是 oneOf（官方子集表达「多选一」的唯一关键字，
// exact-one 语义），session 的诚实值本来就是对象。
// 可空字段注意：子集是单类型，`string | null` 用 oneOf 表达；直接写 `type:"string"`
// 会在宿主校验里把 null 判成违规。

/** 可空 string 字段的 schema 片段（官方子集单类型，null 分支用 oneOf 表达）。 */
const NULLABLE_STRING = {
  oneOf: [{ type: "string" }, { type: "null" }],
} satisfies JsonSchemaNode;

/** ocr_review / ocr_scan 的 wait=false 回执（startBackground 的返回对象）。 */
const BACKGROUND_RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["started", "mode", "tool", "repo", "processStatus", "jobId", "polling"],
  properties: {
    started: { type: "boolean", const: true },
    mode: { type: "string", const: "background" },
    tool: { type: "string" },
    repo: { type: "string" },
    // ShellProcessStatus（dsh-shell）：注册表收尾后进程的落定态只有这三种。
    processStatus: { type: "string", enum: ["running", "completed", "killed"] },
    // 官方作业 id（ctx.jobs 发号，形如 `ocr-review-<16 位 hex>`）。这是后台评审**一定有结果**
    // 的句柄：`job_output` 按 id 读得到增量 stdout/stderr 与最终结局；而 polling 里
    // 那条 `ocr_session(action=list)` 路线依赖会话已落盘且 --repo 能对上，启动早期
    // 这两件事都可能还不成立，于是模型手里就只剩一个查不出东西的 running 回执。
    jobId: { type: "string" },
    polling: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** summarizeReview(...) 的对象形状（lib/parse.ts 的 ReviewSummaryView，逐字段对齐）。 */
const REVIEW_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "skipped",
    "message",
    "summary",
    "budgetExceeded",
    "sessionId",
    "aggregation",
    "totalCommentCount",
    "droppedCount",
    "invalidCommentCount",
    "topComments",
    "warnings",
    "toolCalls",
    "coverage",
    "hint",
  ],
  properties: {
    // summarizeReview 只在 parseReviewOutput ok=true 时被调用 ⇒ status 落在白名单内。
    // partial 是 manifest 终态之一（manifest.go:167，exit 0），部分文件失败但整体有覆盖。
    status: {
      type: "string",
      enum: [
        "success",
        "complete",
        "partial",
        "completed_with_warnings",
        "completed_with_errors",
        "skipped",
      ],
    },
    skipped: { type: "boolean" },
    message: NULLABLE_STRING,
    summary: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "filesReviewed",
            "comments",
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "elapsed",
          ],
          properties: {
            // num() 收「数字字符串」，可能落成小数 ⇒ 用 number 不用 integer。
            filesReviewed: { type: "number" },
            comments: { type: "number" },
            totalTokens: { type: "number" },
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            elapsed: { type: "string" },
          },
        },
      ],
    },
    // 被 token 预算截断过：status 只写 partial，说不出「是预算花完才收的工」。
    budgetExceeded: { type: "boolean" },
    sessionId: NULLABLE_STRING,
    aggregation: {
      type: "object",
      additionalProperties: false,
      required: ["total", "bySeverity", "byCategory", "unknownSeverityCount"],
      properties: {
        total: { type: "integer" },
        // 未知等级（OCR 自造 blocker / 严重 / 带空白的 "critical "）一律按 medium 归一，
        // 降级必须发生但不该无痕：这个数让契约异常在聚合里看得见，而不是悄悄混进 medium。
        unknownSeverityCount: { type: "integer" },
        bySeverity: {
          type: "object",
          additionalProperties: false,
          required: ["critical", "high", "medium", "low"],
          properties: {
            critical: { type: "integer" },
            high: { type: "integer" },
            medium: { type: "integer" },
            low: { type: "integer" },
          },
        },
        // Record<string, number>：键开放，而官方子集的 additionalProperties 只收布尔
        // ⇒ 开放映射只能声明成无约束对象。
        byCategory: { type: "object" },
      },
    },
    totalCommentCount: { type: "integer" },
    droppedCount: { type: "integer" },
    invalidCommentCount: { type: "integer" },
    topComments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["location", "severity", "category", "content", "suggestion"],
        properties: {
          location: { type: "string" },
          severity: { type: "string" },
          category: { type: "string" },
          content: { type: "string" },
          suggestion: NULLABLE_STRING,
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    // LLM 工具调用统计。`--audience agent` 下 OCR 把进度行写进 io.Discard，
    // "No tool calls parsed" 一类文本永远不会出现在输出里，这个字段是模型侧
    // 「是模型不会调工具，而不是代码没问题」的唯一可见口径。
    toolCalls: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["total", "failure", "failures"],
          properties: {
            total: { type: "integer" },
            failure: { type: "integer" },
            failures: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    // 运行覆盖度（manifest 的五个互斥集合大小 + 失败条目明细）。带 manifest 时 CLI
    // 把子任务失败从 warnings 里摘掉、只由 coverage.failed 承载，两处缺一处就有一半
    // 失败看不见，所以这枚字段与 warnings 必须同时在。
    coverage: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["selected", "completed", "reused", "failed", "waived", "failedItems"],
          properties: {
            selected: { type: "integer" },
            completed: { type: "integer" },
            reused: { type: "integer" },
            failed: { type: "integer" },
            waived: { type: "integer" },
            failedItems: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** ocr_review / ocr_scan 的输出：wait=false = 后台回执对象；前台成功 = 摘要对象；
 *  前台解析失败 = 一段诚实的说明字符串。三者恰一（required 逐字段声明保证两个
 *  对象分支互斥）。 */
const REVIEW_OUTPUT_SCHEMA = {
  oneOf: [BACKGROUND_RECEIPT_SCHEMA, REVIEW_SUMMARY_SCHEMA, { type: "string" }],
} satisfies JsonSchemaNode;

/** ocr_delegate_preview：成功 = 清单对象；解析失败 = 说明字符串。 */
const PREVIEW_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "mode",
        "repository",
        "mergeBase",
        "reviewableCount",
        "insertions",
        "deletions",
        "reviewableFiles",
        "excludedFiles",
        "hint",
      ],
      properties: {
        mode: { type: "string" },
        repository: { type: "string" },
        // OCR 端 merge_base 带 omitempty（delegate_cmd.go:263）：缺席落 null。
        mergeBase: NULLABLE_STRING,
        reviewableCount: { type: "integer" },
        // 计数来自 num()（收「数字字符串」）⇒ 用 number 不用 integer。
        insertions: { type: "number" },
        deletions: { type: "number" },
        reviewableFiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "status", "insertions", "deletions"],
            properties: {
              path: { type: "string" },
              status: { type: "string" },
              insertions: { type: "number" },
              deletions: { type: "number" },
            },
          },
        },
        excludedFiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        hint: { type: "string" },
      },
    },
    { type: "string" },
  ],
} satisfies JsonSchemaNode;

/** ocr_delegate_rule：成功 = 分组对象；解析失败 = 说明字符串。 */
const RULES_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["groupCount", "groups", "hint"],
      properties: {
        groupCount: { type: "integer" },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "pattern", "files", "rule"],
            properties: {
              source: { type: "string" },
              pattern: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              rule: { type: "string" },
            },
          },
        },
        hint: { type: "string" },
      },
    },
    { type: "string" },
  ],
} satisfies JsonSchemaNode;

/** ocr_session：sessionOutput 本身就是一手透传的字符串（诚实的值），外层仍是对象
 *  好让 hint 有处安放。 */
const SESSION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionOutput", "hint"],
  properties: {
    sessionOutput: { type: "string" },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

// ── shell 执行与错误映射 ────────────────────────────────────────────────────

/**
 * ocr 子进程一律按 `danger-full-access` 请求（官方按调用携带的 `SandboxExecutionPolicy`）。
 *
 * 为什么必须显式要：ocr CLI 的状态目录是 `$HOME/.opencodereview`（Go 侧 `os.UserHomeDir()`，
 * 无 `--config` 可改），落在 workspace 之外，而宿主沙箱的 `workspace-write` 只放行
 * workspaceRoot 与后端临时区——于是每次会话写入被 EPERM 拒绝。后果不是"少个功能"而是
 * **跑完的评审被丢掉**：同步调用在最后一步 `finalize session` 失败、对外整体报错；
 * 后台调用则落不了盘，作业列表、`--resume` 与进度可观测性同时失效。
 *
 * 为什么不给 `workspace-write` + 重定向 HOME 兜着：那样得把 `config.json` 搬进 workspace，
 * 密钥与状态管理跟着进仓，且换发布形态就要再搬一次——为绕开一条策略把用户目录写进用户仓。
 * owner 口径是「状态归 ocr 自己，围栏由本包显式放开」，故直接要 `danger-full-access`。
 *
 * **「能不能只放开需要写的那一条路径」：不能。** 两样东西一起锁死了这条路：
 * 按调用携带的 `SandboxPolicyRequest` 只有 `session` 与 `mode` 两个字段，**没有**附加可写
 * 路径、没有自定义 HOME、没有目录级豁免；而 `SandboxMode` 的取值只有
 * `read-only | workspace-write | danger-full-access` 三档，中间那一档的可写根就是
 * `workspaceRoot` 一枚。两处声明都取自本包实际解析到的那版（dsh-sandbox-policy 与
 * dsh-sandbox 的 0.2.1-rc.2，`lib/types/index.d.ts`）。
 * 可选的收紧路径只有「改 ocr 自己的状态落点」或「等上游加字段」，两者都不是本包能在
 * 一次补丁里做完的事。故此处维持放开，但把边界写明：放开的是 ocr 这一个子进程的整棵
 * 文件系统写权限，不是宿主其它能力；且 ocr 读什么、写什么仍由上面那条 argv 闸与
 * 凭据链约束。
 *
 * `workspaceRoot` 在这个模式下不被消费，但官方要求「即使不消费也照样携带」（让调用方
 * 先解析一次策略、再选执行路径），故传 workdir 而不是编一个占位根。
 */
function ocrSandboxPolicy(workspaceRoot: string): SandboxExecutionPolicy {
  return { mode: "danger-full-access", workspaceRoot };
}

/** 失败详情：stderr 优先、空则退 stdout；先脱敏再截断（明文 key 绝不进工具错误
 *  ——错误文本会被持久化进会话日志）。省略标记是文案，故脱敏与截断的位置不变，
 *  只把中间的连接标记换成当前语言的那一份。两半各用一个函数，因为它们是两种缺陷：
 *  前切点会留下孤立**高**代理（`truncateEnd` 丢掉它），后切点会留下孤立**低**代理
 *  （`truncateStart` 丢掉它）。把两个函数对调同样不留孤立代理，只是头尾内容掉头
 *  ——故 test/host.test.ts 里另有一组哨兵断言钉住顺序。 */
function failureDetail(result: ShellRunResult, messages: OcrReviewMessages): string {
  const raw = result.stderr.text === "" ? result.stdout.text : result.stderr.text;
  const detail = redactKeyMaterial(raw);
  return detail.length <= 800
    ? detail
    : `${truncateEnd(detail, 400)}${messages.middleEllipsis}${truncateStart(detail, 400)}`;
}

/** 一次 shell 执行的两个部署级时长/上限（>5 参数会撞 max-params，收成对象，
 *  与下面 BackgroundJob 同一取舍）。timeoutMs 由调用方算好：前台取
 *  readTimeoutMinutes(config)，llm test 取 entry config 的 llmTestTimeoutMs。 */
interface RunTuning {
  timeoutMs: number;
  /** entry config `stdoutMaxBytes`：截断说明里报的必须是同一个数。 */
  stdoutMaxBytes: number;
  /** 随本次执行下发的普通环境变量（官方 `ShellExecRequest.env`，在凭据净化之后合并）。
   *  只有一个用途：`ocrNoAutoUpdate` 开着时给 ocr 子进程带 `OCR_NO_UPDATE=1`，
   *  挡住 CLI 那层 npm 包装的自动 `npm i -g`。缺省 = 不注入，维持上游行为。
   *  `| undefined` 是 `exactOptionalPropertyTypes` 要求的：`tuningOf` 会把「不注入」
   *  显式写成 undefined，光有 `?` 反而不收。 */
  env?: Record<string, string> | undefined;
}

/** 前台执行的一手结果：stdout 文本与截断事实。
 *  截断说明刻意**不**拼进 text：delegate/session 的 text 是载荷本体，拼进去会破坏
 *  JSON，而解析失败只回显前 500 码元（头部）——尾部的说明连同 spill 落盘路径会一起
 *  变得不可见（被截断的 JSON 恰恰必然解析失败，说明必须另有出口）。载荷型调用方用
 *  stdoutTruncationNote 按各自形态把说明拼进自己的回显；review/scan 走 --output，
 *  stdout 恒空，截断位对它们只是形式上存在。 */
interface ForegroundRun {
  text: string;
  /** stdout 触到 `stdoutMaxBytes` 上限被截断。 */
  truncated: boolean;
  /** 完整输出的落盘位置（截断且执行器给得出落盘路径时才有）。 */
  spillPath: string | undefined;
}

/** 截断说明（stdoutTruncated 文案 + 可选的落盘位置），判据见 ForegroundRun 的注释。 */
function stdoutTruncationNote(
  limitBytes: number,
  run: ForegroundRun,
  messages: OcrReviewMessages,
): string {
  if (!run.truncated) {
    return "";
  }
  const spill =
    run.spillPath === undefined ? "" : format(messages.outputSpill, { path: run.spillPath });
  return `\n${format(messages.stdoutTruncated, { limit: String(limitBytes), spill })}`;
}

/** 前台执行：失败抛错（含给模型的行动提示），成功返回 stdout 的一手结果。
 * timeoutMs 恒有值（tuningOf(config)），宿主按 min(请求, shell.maxTimeoutMs) 收口。
 * signal 必传：harness ToolExecution.signal 是必填的调用方取消权。 */
async function runForeground(
  host: HostCtx,
  command: string,
  workdir: string,
  run: RunTuning,
  signal: AbortSignal,
): Promise<ForegroundRun> {
  const messages = localeMessages(host);
  const spec = host.shell.resolve({
    command,
    workdir,
    timeoutMs: run.timeoutMs,
    stdoutMaxBytes: run.stdoutMaxBytes,
    signal,
    env: run.env,
    sandboxPolicy: ocrSandboxPolicy(workdir),
  });
  const exec = await host.shell.execute(spec);
  const result = await exec.result();
  const failed = result.exitCode !== 0 || result.timedOut || result.aborted;
  if (failed) {
    if (result.timedOut) {
      // 报 spec.timeoutMs 而不是 run.timeoutMs：resolve 已按
      // min(请求, shell.maxTimeoutMs) 收口，spec 里那个才是**实际生效**的值。
      // run.timeoutMs 是请求值，timeoutMinutes 留空时为 MAX_TIMEOUT_REQUEST_MS
      // (2^31-1)，照它算会把「实际生效 N 分钟」印成 35791 这种天文数字。
      const minutes = Math.round(spec.timeoutMs / 60_000);
      throw new Error(format(messages.execTimedOut, { minutes: String(minutes) }));
    }
    if (result.aborted) {
      throw new Error(messages.execAborted);
    }
    if (result.exitCode === 127) {
      throw new Error(messages.execNotFound);
    }
    const detail = failureDetail(result, messages);
    const head = format(messages.execFailed, { exitCode: String(result.exitCode) });
    throw new Error(detail === "" ? head : `${head}${messages.detailSeparator}${detail}`);
  }
  const { text, truncated, spillPath } = result.stdout;
  return { text, truncated, spillPath };
}

/** 后台任务描述（>5 参数会撞 max-params，收成对象）。 */
interface BackgroundJob {
  command: string;
  workdir: string;
  tool: string;
  repo: string;
  /** 执行器 stdout 缓冲上限（entry config `stdoutMaxBytes`，与前台同一字段）。 */
  stdoutMaxBytes: number;
  /** 兜底回收窗口（entry config `ocrBackgroundMaxMs`；0 = 无窗口，判据见 OCR_BACKGROUND_MAX_MS）。 */
  backgroundMaxMs: number;
  /** 与前台同一份 `ocrNoAutoUpdate` 落地值（`| undefined` 同 RunTuning 的理由）。 */
  env?: Record<string, string> | undefined;
}

/**
 * 进程的两条流作为注册表 pull source（与宿主 bash 工具的 processSources 同一形状）。
 * 交给注册表按它自己的节奏泵 ⇒ 没人来看时输出也照样进环；dsh-shell 的 `observed` 是
 * **非消费**的按偏移读，与 `readOutput()` 的游标互不争夺（installed
 * dsh-shell/lib/types/types.d.ts:196-203）。
 *
 * 外面再兜一道：官方泵对"源抛错"的答法是**此后不再排这一路**（实测——作业照样落定，
 * 但后续增量一条都不进环，环上一个标记也没有）。所以这里把抛错翻译成"游标原地不动 +
 * 一次性说明"：读得回来时下一拍照常续读，读不回来模型至少知道这段不可靠。说明只写一次，
 * 免得每拍 150ms 把同一句话灌进环里。
 */
function reviewSources(proc: ShellExecution, messages: OcrReviewMessages): JobOutputSource[] {
  const source = (channel: "stdout" | "stderr"): JobOutputSource => {
    // 官方 `guardSource` 已经含住抛错（读码 + 实测：首次抛错记一条宿主日志，此后这一路
    // 读作空）——所以这层兜不是防崩，是把"少了"这件事说给模型听：官方那一次只进宿主日志。
    // 同时照官方那样不再反复敲一只已经坏掉的读者。
    let failed = false;
    return {
      channel,
      read: (fromByte: number): JobSourceRead => {
        if (failed) {
          return { text: "", nextOffset: fromByte, lossy: true };
        }
        try {
          return proc.observed[channel].readFrom(fromByte);
        } catch {
          failed = true;
          return { text: messages.jobOutputGap, nextOffset: fromByte, lossy: true };
        }
      },
    };
  };
  return [source("stdout"), source("stderr")];
}

/**
 * 作业生产者的 `done`：等子进程落定，再把终态折算成注册表结局。
 * 注册表在 `start` 那一刻就要拿到这个 Promise，所以由 async 函数现造一个，
 * 而不是在 spec 字面量里挂 `.then`（本仓口径见 lint 基线 `promise/prefer-await-to-then`）。
 */
async function outcomeWhenSettled(proc: ShellExecution): Promise<JobOutcome> {
  await proc.done;
  return jobOutcomeOf(proc);
}

/** 后台启动回执（模型侧契约：wait=false 时 ocr_review/ocr_scan 的 canonical 返回值）。 */
interface BackgroundReceipt {
  started: true;
  mode: "background";
  tool: string;
  repo: string;
  processStatus: ShellProcessStatus;
  jobId: string;
  polling: string;
}

/**
 * 后台启动：resolve 显式带 `onExpiry: "none"`，故不套宿主 deadline（宿主
 * bash-local 缺省是 'kill'，不传就会被缺省 timeoutMs 杀掉），启动准备完成即返回，不等
 * 运行结束、不写 --output。结果以 OCR 会话记录为准（增量落盘），由模型经
 * ocr_session 工具轮询。dsh 无论优雅退出（teardown 组 TERM→KILL）还是硬退出
 * （kill -9/崩溃后被 launchd 收养），命令里的宿主回收守护（cli.ts
 * wrapWithHostReaper）都会把 OCR 一并结束，不留孤儿进程烧 token。
 *
 * 那次子进程现在同时是一枚**官方作业**（kind `ocr-review`）：官方 `job_list` /
 * `job_output` / `job_kill` 从此看得见它，本包不再需要为"起完就没人管"负责。
 * 工具的返回值是下面的结构化回执对象（canonical 值直返，不包一层 `{ text }` 字符串；
 * 作业面只管"谁能看见并停掉它"，不改这份回执的内容）。
 *
 * 生命周期（任何模式下都可后台运行）：
 *  - 不接工具调用的中止信号：program 模式在程序结束时会对活跃调用发 abort，
 *  接上它就等于「后台评审随一次程序执行结束而停」，与后台语义矛盾；
 *  - 结束只发生在四处：宿主退出（命令内的回收守护）、会话 dispose（apply 里那条
 *  效应）、插件卸载、或显式 `job_kill`；
 *  - 可选时限由 `ocrBackgroundMaxMs` 给（0 = 无窗口，默认），到点经注册表 kill。
 *
 * @param host 宿主服务面
 * @param job 这次后台评审的描述
 * @returns 后台启动回执（canonical 对象，模型侧契约）
 */
async function startBackground(host: HostCtx, job: BackgroundJob): Promise<BackgroundReceipt> {
  const registry: JobsService | undefined = host.get("jobs");
  if (registry === undefined) {
    // 没有注册表就不起进程：本包不再自带一张作业表，"起了但谁也看不见、谁也停不掉"
    // 正是本包要消灭的形态。前台（wait:true）路径不受影响。
    throw new Error(
      "background review unavailable: the host provides no ctx.jobs (load @deepseek-ai/dsh-jobs-local); run it with wait:true instead",
    );
  }
  const spec = host.shell.resolve({
    command: job.command,
    workdir: job.workdir,
    onExpiry: "none",
    stdoutMaxBytes: job.stdoutMaxBytes,
    env: job.env,
    sandboxPolicy: ocrSandboxPolicy(job.workdir),
  });
  const proc = await host.shell.execute(spec);
  // 剪枝先于作业**登记**（进程已在上面起来）：注册表的容量闸只管"活的"，已落定的
  // 旧记录只有我们 remove 才会消失。
  pruneOcrJobHistory(registry);
  const messages = localeMessages(host);
  let jobId: JobId;
  try {
    jobId = startUnderOcrController(registry, {
      kind: OCR_JOB_KIND,
      label: `${job.tool} ${job.repo}`,
      output: reviewSources(proc, messages),
      run: () => ({
        // 这层吞异常不是风格：官方契约明写生产者的 `cancel` 会往上抛（dsh-jobs 的
        // types.d.ts "throws propagate"），注册表的 `killJob` 裸调 `job.cancel(reason)`、
        // 只有 teardown 那一臂逐条 try/catch。而本包的 `cancel` 是从 `AbortSignal` 监听器里
        // 被回调的，Node 对监听器抛出的处理是 `process.nextTick(() => { throw err })`
        // ⇒ **未捕获异常、宿主进程退出**（本机实跑复现）。一次取消杀掉整个 dsh 不是可接受
        // 的失败形态，所以这里走 `killProc` 而不是裸调 `proc.kill()`。
        cancel: () => {
          killProc(proc);
        },
        done: outcomeWhenSettled(proc),
      }),
    });
  } catch (error) {
    // 注册表在 preflight（controller/容量/入参）就把作业拒了：进程已经起来，
    // 不能留一条没登记、谁也停不掉的 OCR 在烧 token。
    killProc(proc);
    throw error;
  }
  // 兜底 deadline（时长来自 entry config；kill 理由按实际窗口换算，别把可配置的
  // 窗口说成写死的"2 小时"——理由是模型可见的 detail）。
  const backstopMinutes = Math.round(job.backgroundMaxMs / 60_000);
  void enforceOcrDeadline(
    registry,
    jobId,
    format(messages.jobReasonTimeout, { minutes: String(backstopMinutes) }),
    job.backgroundMaxMs,
  );
  return {
    started: true,
    mode: "background",
    tool: job.tool,
    repo: job.repo,
    processStatus: proc.status,
    jobId,
    polling: messages.backgroundPolling,
  };
}

/** 只收集不抛错（llm test 等需要展示原始失败的命令）。输出必先脱敏（直通卡片）。
 *  `timedOut` 必须一起交回：被墙钟收走的那条进程没有退出码可报，只留 exitCode 的调用方
 *  会把「超时」写成「执行失败（exit=null）」，把用户指到不存在的那个退出码上。 */
/** 两路输出合并：任一路为空就不添分隔符（空 stderr 也常见，别在正文后留一条空行）。 */
export function joinedOutput(stdout: string, stderr: string): string {
  return stdout === "" || stderr === "" ? stdout + stderr : `${stdout}\n${stderr}`;
}

async function runCollect(
  host: HostCtx,
  command: string,
  workdir: string,
  run: RunTuning,
): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  const spec = host.shell.resolve({
    command,
    workdir,
    timeoutMs: run.timeoutMs,
    stdoutMaxBytes: run.stdoutMaxBytes,
    env: run.env,
    sandboxPolicy: ocrSandboxPolicy(workdir),
  });
  const exec = await host.shell.execute(spec);
  const result = await exec.result();
  const joined = joinedOutput(result.stdout.text, result.stderr.text);
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: truncateEnd(redactKeyMaterial(joined), 8000),
  };
}

// ── 设置读取 ────────────────────────────────────────────────────────────────
// `settings.register()` 交回的 scope.get() 已不存在，cordis 直接把按 `Config`
// 校验并填过默认的那份 config 交进 apply，其中 volatile 字段是 **引用**——每读一次
// 取一次当前值，所以设置卡改完下一次工具调用/端点请求即生效（语义同旧 scope.get()）。
// 引用背后的类型由 schema 保证，但**不保证它是唯一写入者**（profile 补丁里的裸 YAML
// 手改同样进得来），故下面每个读数仍按 unknown 复核形态再落回安全默认。

function readEffort(config: Config): "low" | "medium" | "high" {
  const raw: unknown = config.effort.get();
  return raw === "low" || raw === "high" ? raw : "medium";
}

export function readLanguage(config: Config): string | undefined {
  const lang: unknown = config.language.get();
  return typeof lang === "string" && (lang === "中文" || lang === "English") ? lang : undefined;
}

function readAutoVerify(config: Config): boolean {
  const raw: unknown = config.autoVerify.get();
  return raw !== false;
}

function readMaxComments(config: Config): number {
  const raw: unknown = config.maxComments.get();
  const num = typeof raw === "number" ? raw : Number(raw);
  // 0 = 不截断（全量评论），>=1 = top N；非法值回退内置默认（= schema 的 `.default()`）。
  if (Number.isSafeInteger(num) && num >= 0) {
    return num;
  }
  return MAX_COMMENTS_DEFAULT;
}

/**
 * 外层墙钟超时（分钟）→ 实际请求毫秒。0/未设置 = 请求宿主上限（宿主按
 * min(请求, shell.maxTimeoutMs) 收口，见 MAX_TIMEOUT_REQUEST_MS 注释）；
 * >0 = 指定分钟（同样被宿主 clamp）。非法值按 0 处理。
 */
function readTimeoutMinutes(config: Config): number {
  const raw: unknown = config.timeoutMinutes.get();
  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isSafeInteger(num) && num > 0) {
    return num * 60_000;
  }
  return MAX_TIMEOUT_REQUEST_MS;
}

/** 关掉上游自动更新的那一枚变量（`ocrNoAutoUpdate` 与状态探测共用同一个值）。 */
const NO_UPDATE_ENV: Record<string, string> = { OCR_NO_UPDATE: "1" };

/**
 * `ocrNoAutoUpdate` 落地的那一枚环境变量：开着就给 `{OCR_NO_UPDATE:"1"}`，关着给
 * undefined（不注入，维持上游行为）。每次现读并给新对象，不让执行器与本包共享同一份
 * 引用——被净化环境是宿主的事，本包只保证「这条命令带上/不带这个变量」。
 */
export function ocrEnv(config: Config): Record<string, string> | undefined {
  return config.ocrNoAutoUpdate ? { ...NO_UPDATE_ENV } : undefined;
}

/** 一次前台执行的下发值：墙钟每次现读（`timeoutMinutes` 是 volatile 设置项），stdout 上限
 *  与自动更新开关取装载期 config（非 volatile）。后台与 llm test 各有各的墙钟来源，但那一枚
 *  开关三条路径都经 `ocrEnv` 现取，所以不会在某一条 spawn 上漏。 */
function tuningOf(config: Config): RunTuning {
  return {
    timeoutMs: readTimeoutMinutes(config),
    stdoutMaxBytes: config.stdoutMaxBytes,
    env: ocrEnv(config),
  };
}

// ── 工具注册辅助 ────────────────────────────────────────────────────────────

/** parameters.required 的读取（本插件自己写的 schema，但门缺一即放行 = 副作用
 *  照跑，故不合形态就抛错，绝不静默当「无必填」）。 */
export function requiredKeys(
  parameters: Record<string, unknown>,
  messages: OcrReviewMessages,
): string[] {
  const raw = parameters["required"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TypeError(messages.requiredNotArray);
  }
  const out: string[] = [];
  for (const key of raw) {
    if (typeof key !== "string") {
      throw new TypeError(messages.requiredItemNotString);
    }
    out.push(key);
  }
  return out;
}

/** 宿主对工具入参零校验（execute 收原始 arguments）→ 非对象入参必须当场拒绝，
 *  否则 spread / 必填门都会按「缺省」语义静默跑一次真实评审。 */
function execArgs(
  args: unknown,
  name: string,
  messages: OcrReviewMessages,
): Record<string, unknown> {
  if (!isRecord(args)) {
    throw new TypeError(
      format(messages.argsMustBeObject, {
        name,
        received: Array.isArray(args) ? "array" : typeof args,
      }),
    );
  }
  return args;
}

/** define() 的注册清单（>5 参数会撞 max-params，收成对象）。 */
interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 该工具自己的 canonical 输出契约（与 execute 返回逐分支对齐）。 */
  schema: JsonSchemaNode;
  run: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
}

function define(host: HostCtx, spec: ToolSpec): void {
  const { name, description, parameters, schema, run } = spec;
  const required = requiredKeys(parameters, localeMessages(host));
  host.tools.register({
    name,
    description,
    parameters,
    output: {
      schema,
      // 不写形参标注：官方 `ToolOutputDefinition.render(args: unknown, value: JsonValue)`
      // 直接交出（installed dsh-tools/lib/types/index.d.ts:110）。原先把 value 抄成
      // `unknown` 是放宽——JsonValue 才是宿主承诺的形状。render 只做 model-facing
      // 展示：canonical value 本身 pretty-print 成文本块（execute 已直返结构化对象，
      // 这里 stringify 的就是唯一一层 JSON）。
      render: (_args, value) => textBlock(value),
    },
    execute: async (args: unknown, exec: ToolExec) => {
      // 入参闸与必填门的文本按当前语言现取（切了语言的下一个调用就是新文案）。
      const messages = localeMessages(host);
      const values = execArgs(args, name, messages);
      const missing = required.filter((key) => values[key] === undefined);
      if (missing.length > 0) {
        throw new Error(format(messages.missingRequiredArgs, { name, keys: missing.join(", ") }));
      }
      // 出口自检：返回值必须命中该工具自己的 output schema（违规 = 指向工具名的
      // 插件内错误，而不是 harness 深处的 INVALID_TOOL_OUTPUT 丢掉整次结果）。
      return assertToolOutput(schema, await run(values, exec), name, messages);
    },
  });
}

// ── 输出收口 ────────────────────────────────────────────────────────────────

/** 原始输出回显给模型/卡片前的两道收口：截断 + 明文 key 脱敏。 */
function echoRaw(text: string, limit: number): string {
  return redactKeyMaterial(truncateEnd(text, limit));
}

/** 读 --output 落盘结果。OCR exit 0 却没写出文件（版本漂移/被中途 kill）时给
 *  可行动的错误，而不是把裸 ENOENT 栈丢给模型。
 *  超过 OUT_FILE_MAX_BYTES 的先拒掉：`readFileSync` + `JSON.parse` 是两倍内存的整份读，
 *  病理级的大回执只该换回一条点名文件的错误。大小探测失败（文件不在）不在这里报——
 *  交给下面那条 `outputFileMissing` 统一说话。 */
function readOutFile(outPath: string, messages: OcrReviewMessages): string {
  let size = 0;
  try {
    ({ size } = statSync(outPath));
  } catch {
    // 读不到大小：读文件那一步会给出同一条可行动错误，这里不重复造文案。
  }
  if (size > OUT_FILE_MAX_BYTES) {
    throw new Error(
      format(messages.outputFileTooLarge, {
        path: outPath,
        size: String(size),
        limit: String(OUT_FILE_MAX_BYTES),
      }),
    );
  }
  try {
    return readFileSync(outPath, "utf8");
  } catch (error) {
    throw new Error(
      format(messages.outputFileMissing, { path: outPath, cause: errorText(error) }),
      { cause: error },
    );
  }
}

/**
 * 非零退出时把 `--output` 里已经发布的 coverage.failed 明细附到失败详情上。
 *
 * 上游的退出契约只对 run-level 失败、或「每个被选中的文件都失败」给非零，而那份 manifest
 * 照发（`review_cmd.go` 的 reviewResultError：“Partial results are published regardless”）
 * ——只回 stderr 的话模型读到「N of M selected item(s) failed」，却不知道是哪些文件、
 * 哪一类失败。读不出或没有失败明细时原样交回那个错误，不改变既有失败形态。
 *
 * 这里刻意不复用 `readOutFile`：那条路会给「文件缺失/过大」抛错，而失败详情里再加一层
 * 「读不到落盘结果」的错误只会盖住 OCR 自己的报错。
 */
function withCoverageDetail(error: unknown, outPath: string, messages: OcrReviewMessages): unknown {
  let text: string;
  try {
    text = readFileSync(outPath, "utf8");
  } catch {
    return error;
  }
  const items = parseReviewOutput(text, messages).coverage?.failedItems ?? [];
  if (items.length === 0) {
    return error;
  }
  const note = format(messages.failureCoverage, {
    items: redactKeyMaterial(items.join("; ")),
  });
  return new Error(`${errorText(error)}${note}`, { cause: error });
}

// ── 插件体 ─────────────────────────────────────────────────────────────────

/**
 * OCR 原生数值参数的 tool schema 片段（忠实透传语义，桥接层不设钳制）。
 * unit 区分 review（每组）/ scan（每文件）的措辞；maxToolsTemplate 也按命令分开，因为
 * 两侧的 --max-tools 语义本就不同：review 把 1-49 抬到 50，scan 只在大于模板默认时生效。
 * 语言随设置页偏好走；OCR 侧语义见 shared_flags.go 的 registerReviewFlags/registerScanFlags。
 */
function tuningParams(
  messages: OcrReviewMessages,
  unit: string,
  maxToolsTemplate: string,
): Record<string, unknown> {
  const of = (template: string): { type: "integer"; description: string } => ({
    type: "integer",
    description: format(template, { unit }),
  });
  return {
    concurrency: of(messages.tuningConcurrency),
    timeoutMinutes: of(messages.tuningTimeout),
    maxTools: of(maxToolsTemplate),
    maxTokens: of(messages.tuningMaxTokens),
    maxTokensBudget: {
      type: "integer",
      description: messages.tuningMaxTokensBudget,
    },
  };
}

/** 本包设置项（隐式注册）。行级 config 由 cordis 按导出的 `Config` schema
 *  校验并填默认后交进 apply，优先级：设置卡运行时值 > 行 config > schema 默认。
 *  命名空间不再是本包持有的字符串：宿主按 `.volatile()` 投影表单，ns = profile 条目
 *  id（`ocr-review`，见 cordis.patch.yml）；原先那份 `settings.register(ns, schema,
 *  { base })` 的 `base` 底座已删除，逐字段落成下面的 `.default(...)`（本包没有数组
 *  字段——数组是整体替换，默认值必须是完整的一份）。设置卡上那六项全是用户随时翻的
 *  开关，故标 `.volatile()`；一个都不标会让整条从 describe() 消失、写入抛
 *  `has no volatile fields`。volatile 字段以引用形态交进来，读当前值一律 `.get()`。
 *  下面另三项是**部署级**调优值，刻意不标 volatile：它们不进设置卡，改值随重启
 *  生效，以普通值形态交进来（官方 config.md:78-92 的判据是「行 config 能否不改代码改值」，
 *  不是「能不能在页面上改」）。 */
export interface Config {
  /** 评审强度（透传 OCR `--effort`）；工具入参可逐次覆盖。 */
  effort: Volatile<"low" | "medium" | "high">;
  /** OCR 输出语言（透传外部 CLI 的 `language`）。 */
  language: Volatile<"中文" | "English">;
  /** select 应用后是否顺手跑一次 `ocr llm test`。 */
  autoVerify: Volatile<boolean>;
  /** 回显给模型的评论条数（0 = 全量）。 */
  maxComments: Volatile<number>;
  /** ocr_* 外层墙钟超时（分钟）；0 = 请求宿主上限（OCR 原生每组 --timeout 管控）。 */
  timeoutMinutes: Volatile<number>;
  /**
   * 外部 ocr CLI 配置文件路径；**刻意不给默认**：内置底座一旦写死绝对路径就又回到
   * 「作者机器布局」。undefined（或空白）= 按 os.homedir() 派生。
   */
  ocrConfigPath: Volatile<string | undefined>;
  /** `ocr llm test` 的墙钟（毫秒）。评审机慢就抬，不占设置卡。 */
  llmTestTimeoutMs: number;
  /** 装载期是否跑一次端点自检（`ocr llm test`）：部署值，改值要重启。默认开——端点配错
   *  时让卡片早点看到，而不是等逐文件 400；不想让装载期起进程的部署可以关掉。 */
  startupVerify: boolean;
  /** 后台评审的兜底回收窗口（毫秒）：0 = 无窗口（默认，评审可一直跑到宿主退出或会话停止）。 */
  ocrBackgroundMaxMs: number;
  /**
   * 关掉被封装的 OCR 那层自动更新：true 时本包起的每个 ocr 子进程都带
   * `OCR_NO_UPDATE=1`。默认 false = 维持上游行为——CLI 的 JS launcher 层在冷却窗口外
   * 会 detached 地跑 `npm i -g @alibaba-group/open-code-review@<latest>`（实测见
   * `scripts/update.js`），也就是「跑一次评审可能顺带改全局工具链」。部署上不想接受
   * 这件事就把它开起来；设置页的状态探测不受本项影响，恒定带该变量。
   */
  ocrNoAutoUpdate: boolean;
  /**
   * 没装 ocr 时先推哪一条装法：`both` = 两条都给（缺省），`brew` / `npm` = 按部署偏好。
   * 只在**来源判不出来**时才起作用——本机已经有一份候选时，文案按那一份的真实来源说
   * （brew 装的提示 brew，npm 装的提示 npm），部署偏好不会被它盖掉。
   * npm 那条恒带 `EXPECTED_OCR_CLI_VERSION` 那一版（npm 能钉版本，brew 的 formula 不能），
   * 所以选 `npm` 的部署拿到的是「装完就和插件契约同版本」的命令。
   */
  ocrInstallHint: OcrInstallPreference;
  /** shell 执行器的 stdout 缓冲上限（字节）：前台与后台共用同一字段。 */
  stdoutMaxBytes: number;
}

/** settings 命名空间与 loader 行 config 共用同一 schema（单源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare；
 *  外部仍以 `Config` 名导入（export as），公开 API 不变。 */
const configSchema = Schema.object({
  effort: Schema.union(["low", "medium", "high"]).default("medium").volatile(),
  language: Schema.union(["中文", "English"]).default("中文").volatile(),
  autoVerify: Schema.boolean().default(true).volatile(),
  maxComments: Schema.natural().default(MAX_COMMENTS_DEFAULT).volatile(),
  // 0 = 「请求宿主上限」这个语义本身，不是「未设置」，故默认值就写在 schema 上。
  timeoutMinutes: Schema.natural().default(0).volatile(),
  // 外部 ocr CLI 自己的配置文件位置。留空 = 按 os.homedir()/.opencodereview/config.json
  // 派生；写死进默认就等于把作者机器的布局重新钉回包里。
  ocrConfigPath: Schema.string().volatile(),
  // 下面这几枚都是**部署级**值（不标 volatile ⇒ 不进设置卡，只能写在 profile 注册行的
  // config: 上，改值随重启生效）。llmTestTimeoutMs / stdoutMaxBytes 的 min(1) 挡掉 0 ——
  // 0 会让 resolve 收到「零毫秒 deadline」或零字节输出上限。ocrBackgroundMaxMs
  // 相反：0 是合法语义「不设兜底窗口」，故只保留 natural。
  llmTestTimeoutMs: Schema.natural().min(1).default(LLM_TEST_TIMEOUT_MS),
  // 装载期端点自检：默认开（端点配错时卡片早点看到），部署可关。
  startupVerify: Schema.boolean().default(true),
  // 默认 0：后台评审不设时限。允许 0 是刻意的——`enforceOcrDeadline` 对 0 直接返回，
  // 不再走 `jobs.wait`。
  ocrBackgroundMaxMs: Schema.natural().default(OCR_BACKGROUND_MAX_MS),
  stdoutMaxBytes: Schema.natural().min(1).default(STDOUT_MAX_BYTES),
  // 默认关：维持上游行为（CLI 的 npm 包装层会自行 `npm i -g` 升到 latest）。
  ocrNoAutoUpdate: Schema.boolean().default(false),
  // 缺省 both：把两条装法都给用户，替他选装法是部署的决定而不是本包的偏好。
  ocrInstallHint: Schema.union(["both", "brew", "npm"]).default("both"),
});
export { configSchema as Config };

/** 设置项里的 ocrConfigPath：非字符串或空白一律视为「未覆盖」。 */
function readOcrConfigPath(config: Config): string | undefined {
  const raw: unknown = config.ocrConfigPath.get();
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** 本包剩下的文件路径：只剩外部 ocr CLI 的 config.json（可被设置项覆盖）+ 脚本位置。
 *  messages 只用于「设置项里的路径不合形态」那条可读错误。 */
function pluginPaths(config: Config, messages: OcrReviewMessages): OcrPaths {
  const configured = readOcrConfigPath(config);
  return {
    ocrConfigJson: resolveOcrConfigPath(configured, messages),
    homeOverride: ocrHomeOverride(configured),
    pluginDir: PLUGIN_DIR,
    getCredScript: defaultCredScriptPath(PLUGIN_DIR),
  };
}

/**
 * ocr 子进程的 HOME 重定向值（工具执行侧专用，**不抛错**）：设置项命中
 * `<X>/.opencodereview/config.json` 布局 → X；未设置/坏设置 → undefined。工具不
 * 走 pluginPaths（那会在坏设置下把五个工具一并拖死），坏设置的错误由端点侧的
 * resolveOcrConfigPath 报给卡片——「工具与设置照常可用」的口径不变。
 */
function ocrHome(config: Config): string | undefined {
  return ocrHomeOverride(readOcrConfigPath(config));
}

/**
 * 调用 ocr 之前的一次性 api_key_cmd 指针自愈（lib/ocr-config.ts 的
 * ensureKeyScriptPointer）。
 *
 * 为什么必须在这一层而不是启动时：config.json 里的脚本路径是**写那一刻**的插件安装
 * 目录，而插件会被重装、换 profile（desktop / browser / 任意自定义名）、换发布形态。
 * 目录一变那条命令就悬空，ocr 侧报的是「resolve LLM endpoint 失败」，与真因毫无
 * 关系——五个工具一次性全挂，而配置文件里没有任何线索指向「本包被挪了地方」。
 * 当前路径一律取自 PLUGIN_DIR（import.meta.dirname），与 profile 命名
 * 无关，故 desktop / browser / 自定义名走的是同一条路径。
 *
 * 与 ocrHome 同一口径：**不抛错**。pluginPaths 在坏设置下会抛，而那正是「工具照常
 * 可用、错误由端点侧报给卡片」的分工，不能因为一次自愈把工具拖死。
 */
async function healKeyScriptPointer(host: HostCtx, config: Config): Promise<void> {
  const messages = localeMessages(host);
  try {
    await ensureKeyScriptPointer(pluginPaths(config, messages), messages);
  } catch {
    // 坏设置/读不动配置：一律放过，让 ocr 报它自己的原始错误。
  }
}

/**
 * 探测失败的理由分三档，各说各的话：
 *  - exit 127 说明连命令词都没找到，报「执行失败（exit=127）」是把用户往错方向指
 *    （与 runForeground 里同一分工）。
 *  - 超时那条进程是被墙钟收走的，压根没有退出码，报 `exit=null` 等于让用户去查一个
 *    不存在的返回值。
 *  - 余下才是真退出码。随包入口在、平台二进制缺失那一档是 exit 1 带
 *    `[ERROR] OpenCodeReview binary not found`，那句原文已在 output 里。
 * @param messages - 文案表（理由是人读文本，随官方 locale 偏好走）。
 * @param exitCode - 执行器交回的退出码（被杀为 null）。
 * @param timedOut - 执行器是否把它按超时收走。
 * @returns 给人看的那一句失败理由。
 */
function probeFailureReason(
  messages: OcrReviewMessages,
  exitCode: number | null,
  timedOut: boolean,
): string {
  if (exitCode === 127) {
    return messages.execNotFound;
  }
  if (timedOut) {
    return format(messages.probeTimedOut, {
      seconds: String(VERSION_PROBE_TIMEOUT_MS / 1000),
    });
  }
  return format(messages.execFailed, { exitCode: String(exitCode) });
}

/**
 * 跑一次 `ocr version`，把外部 CLI 的自述取回来给设置页。
 *
 * 两条必须写死的口径：
 *  - 带 `OCR_NO_UPDATE=1`。不加这一条，「查一下版本」就顺带触发了 CLI 那层 npm 包装的
 *    **全局安装**（`scripts/update.js` 见到更新版本就 spawnSync `npm i -g <pkg>@<latest>`，
 *    默认 18 分钟冷却一次）。状态读侧不该有写侧副作用，所以这条不受 `ocrNoAutoUpdate`
 *    那个部署开关影响，恒定带上。
 *  - HOME 与五个工具走同一个重定向口。launcher 那句「自动更新没成功，请手工执行」的
 *    提示写在 `$HOME/.opencodereview/` 下，不带重定向就会去读另一个世界的状态，
 *    卡片报的与评审实际吃到的就不是同一份。
 * @param host 宿主服务面
 * @param config 本次 apply 的配置
 * @param messages 文案表（回执里给人看的理由）
 * @returns 是否取到版本、版本串（取不到为 null）、一手输出（已脱敏、已截断、已去色）、失败理由。
 */
async function runVersionProbe(
  host: HostCtx,
  config: Config,
  messages: OcrReviewMessages,
): Promise<{ ok: boolean; version: string | null; output: string; reason: string }> {
  const raw = await runCollect(
    host,
    withHomeEnv(buildVersionCommand(), ocrHome(config)),
    process.env["HOME"] ?? "/",
    {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      stdoutMaxBytes: config.stdoutMaxBytes,
      // 恒定注入，不吃 ocrNoAutoUpdate 那个开关：状态读侧不该有写侧副作用。
      env: { ...NO_UPDATE_ENV },
    },
  );
  const { exitCode, timedOut } = raw;
  // 这段文本是要显示在页面上给人选中复制的（那句 `npm i -g …` 尤其），故剥掉终端控制序列；
  // 版本串也从这份清洗后的文本里读，两处看到的是同一份。
  const output = stripAnsi(raw.output);
  if (exitCode !== 0) {
    return {
      ok: false,
      version: null,
      output,
      reason: probeFailureReason(messages, exitCode, timedOut),
    };
  }
  const version = parseOcrVersion(output);
  return {
    ok: version !== null,
    version,
    output,
    reason: version === null ? messages.probeNoVersion : "",
  };
}

/** 三条装法文案的键，按「来源 / 部署偏好」这个联合取值挑。收成一张表是因为
 *  `variant === "brew" ? … : variant === "npm" ? … : …` 那种嵌套三元在本仓是 lint 级禁令。 */
const INSTALL_HINT_KEYS = {
  both: "installHintBoth",
  brew: "installHintBrew",
  npm: "installHintNpm",
} as const satisfies Record<OcrInstallPreference, keyof OcrReviewMessages>;

/**
 * 「怎么把外部 CLI 装/换成核对过的这一版」那一句文案。
 *
 * 两条判据的分工是刻意的：本机已有一份候选时**按那份的真实来源说**（brew 装的提示 brew，
 * npm 装的提示 npm），因为用户要执行的是替换他手上那一份的命令；判不出来源（unknown）或
 * 压根没装时才退到部署偏好 `ocrInstallHint`。反过来让偏好盖来源，就会给 brew 装的用户端出
 * 一条 `npm i -g`，装完机器上出现第二份 ocr 而 PATH 上那条还是旧的。
 * @param status - 现读口交回的可用性判定（来源、命中路径与那份的渠道）。
 * @param config - 本次 apply 的配置（取 `ocrInstallHint`）。
 * @param messages - 文案表。
 * @returns 给人照抄的那一句（含命令原文）。
 */
function ocrInstallText(
  status: OcrBinaryStatus,
  config: Config,
  messages: OcrReviewMessages,
): string {
  const channel: OcrInstallChannel = status.channel ?? "unknown";
  const variant: OcrInstallPreference = channel === "unknown" ? config.ocrInstallHint : channel;
  const commands = ocrCommandsFor(channel, status.path !== undefined);
  return format(messages[INSTALL_HINT_KEYS[variant]], {
    brewCmd: commands.brew,
    npmCmd: commands.npm,
    version: EXPECTED_OCR_CLI_VERSION,
  });
}

/**
 * GET providers 里 `ocrBinary` 那半份载荷：文件系统的事实 + 版本核对所需的两样 + 装法文案。
 * 三个显示面（卡片状态行、详情页徽标/区块、启用指引）都读这一份，凑不出两处口径差。
 * @param status - 现读口交回的可用性判定。
 * @param config - 本次 apply 的配置（装法文案的部署偏好）。
 * @param messages - 文案表。
 * @param measured - 最近一次实测到的版本；null = 还没测过。
 * @returns 给卡片的对象。
 */
function cliStatusPayload(
  status: OcrBinaryStatus,
  config: Config,
  messages: OcrReviewMessages,
  measured: string | null,
): OcrBinaryStatus & {
  expectedVersion: string;
  measuredVersion: string | null;
  installHint: string;
} {
  return {
    ...status,
    expectedVersion: EXPECTED_OCR_CLI_VERSION,
    measuredVersion: measured,
    installHint: ocrInstallText(status, config, messages),
  };
}

/**
 * 把版本核对提示追加到摘要的 `hint` 尾部，让模型读得到「这份结果不是按插件核对的版本跑的」。
 *
 * 为什么写在 hint 里而不是新增一枚字段：output schema 是 `additionalProperties: false` +
 * 逐字段 `required`，加一枚要同时动 schema、必填表和 lib/output.ts 的形态闸三处；而这条信息
 * 的全部价值就是「模型读到它」，hint 那段本来就是教模型怎么读这份结果。
 * 没实测值（装载期自检关着、或那条命令跑砸了）就原样交回：不知道就是不知道，
 * 编一句「版本可能不一致」会让模型把没发生过的事转述给用户。
 * @param summary - summarizeReview 的产物。
 * @param measured - 最近一次实测到的外部 CLI 版本；null = 还没测过。
 * @param messages - 文案表。
 * @returns 同一份摘要，或 hint 尾部多了一句的副本。
 */
function withCliVersionNote(
  summary: ReviewSummaryView,
  measured: string | null,
  messages: OcrReviewMessages,
): ReviewSummaryView {
  if (measured === null || measured === EXPECTED_OCR_CLI_VERSION) {
    return summary;
  }
  const note = format(messages.versionMismatch, {
    actual: measured,
    expected: EXPECTED_OCR_CLI_VERSION,
  });
  return { ...summary, hint: `${summary.hint}\n${note}` };
}

/** 运行 ocr llm test 校验当前配置（select 后自动验证 / 手动测试共用）。
 *  命令词与五个工具同一解析源（buildLlmTestCommand 走 ocrCommand()：卡片验的那一份与评审
 *  吃的那一份必须同一个二进制），HOME 随 ocrConfigPath 重定向。墙钟与输出上限都是 entry
 *  config 字段（非 volatile，改值随重启生效）。 */
async function runLlmTest(host: HostCtx, config: Config): Promise<{ ok: boolean; output: string }> {
  const { exitCode, output } = await runCollect(
    host,
    withHomeEnv(buildLlmTestCommand(), ocrHome(config)),
    process.env["HOME"] ?? "/",
    {
      timeoutMs: config.llmTestTimeoutMs,
      stdoutMaxBytes: config.stdoutMaxBytes,
      env: ocrEnv(config),
    },
  );
  return { ok: exitCode === 0, output };
}

/** effort 入参闸：undefined/null → 设置卡默认；字符串 → 白名单钳制（未知值回落
 *  medium，与 --format 同一纪律）；其余类型抛错——静默回落会改变审查深度。 */
function effortOf(value: unknown, config: Config, messages: OcrReviewMessages): string {
  if (value === undefined || value === null) {
    return readEffort(config);
  }
  if (typeof value !== "string") {
    throw new TypeError(
      format(messages.mustBeString, { name: "effort", received: describeValue(value) }),
    );
  }
  return clampEffort(value, "medium");
}

/**
 * wait 入参闸：undefined → **false（后台缺省）**；布尔透传；其余类型抛错——字符串
 * "false" 若被 `!== false` 当真值处理会静默从后台变前台，吞掉用户的等待语义。
 *
 * 为什么缺省改成后台：一次 review 是分钟级长任务（真跑过 8 分钟以上），前台缺省会让模型
 * 在一次工具调用里干等，既占住轮次又容易撞上宿主超时；后台立刻返回作业 id，模型用
 * `ocr_session` 轮询，等待因此发生在**模型自己的节奏里**而不是一次阻塞调用里。
 * 想要旧行为（一次拿到结果）显式传 `wait: true` 即可。
 */
function waitOf(value: unknown, messages: OcrReviewMessages): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(format(messages.waitMustBeBoolean, { received: describeValue(value) }));
  }
  return value;
}

/** 服务界面齐备才算可用（get() 可能返回半装配对象，也可能返回 undefined）。 */
function usableService<Svc>(value: Svc | undefined, methods: readonly string[]): Svc | undefined {
  return value !== undefined && hasMethods(value, methods) ? value : undefined;
}

/**
 * 装配 dsh 官方配置/凭据通道（lib/provider-source.ts 只认这个门面）。
 *
 * 探测放 host 侧：只有这里知道 ctx 上到底装没装那两个服务；lib 拿到的是 health 布尔
 * + 已收窄的服务，据此产出卡片可读的降级原因。所有分支都不许抛穿到会话热路径。
 * credentials 的 describe/resolve 只回「是否已配置 / 值能否解析」，resolve 拿到的
 * 值当场丢弃——明文 key 绝不出宿主（更不进 HTTP）。
 */
export function createGateway(host: HostCtx): DshConfigGateway {
  const settingsService = (): SettingsFormsService | undefined =>
    usableService(host.get("settings"), ["describe"]);
  const credentialsService = (): CredentialsService | undefined =>
    usableService(host.get("credentials"), ["describe", "resolve"]);
  return {
    health: () => ({
      settings: settingsService() !== undefined,
      credentials: credentialsService() !== undefined,
    }),
    descriptors: (): ProviderDescriptor[] => {
      const svc = settingsService();
      if (svc === undefined) {
        // health() 之后服务才被卸载才会走到这里；宁可报一条可显示的错，
        // 也不返回空数组——那会被读成「一个 provider 都没配」。
        throw new Error(format(localeMessages(host).settingsServiceGone, { ns: PI_AI_NAMESPACE }));
      }
      return svc.describe();
    },
    credentialConfigured: async (envKey: string): Promise<boolean> => {
      const svc = credentialsService();
      // 不合官方 ref 语法的名根本不是一个 ref：按「未配置」处理而不是抛错
      // （官方 isCredentialRefName 的既定语义，见文件头）。过了这道判据才 brand。
      if (svc === undefined || !isCredentialRefName(envKey)) {
        return false;
      }
      try {
        const info = await svc.describe(credentialRef(envKey));
        return info.configured;
      } catch {
        // 凭据服务 reject 与「未配置」是同一类结论：都拿不到值。让它冒到卡片上
        // 会变成 500，而本包对 settings 不可用早已走 ProviderSourceStatus 降级面——
        // 两侧口径必须一致，否则一个宿主侧故障就把整张 provider 卡打死。
        return false;
      }
    },
    credentialSource: async (envKey: string): Promise<string | undefined> => {
      const svc = credentialsService();
      // 不合官方 ref 语法的名根本不是一个 ref：按「未配置」处理而不是抛错
      // （官方 isCredentialRefName 的既定语义，见文件头）。过了这道判据才 brand。
      let resolved: Awaited<ReturnType<CredentialsService["resolve"]>> | undefined;
      if (svc !== undefined && isCredentialRefName(envKey)) {
        try {
          resolved = await svc.resolve(credentialRef(envKey));
        } catch {
          // 凭据服务 reject 与「未配置」是同一类结论：都拿不到值。让它冒到卡片上
          // 会变成 500，而本包对 settings 不可用早已走 ProviderSourceStatus 降级面——
          // 两侧口径必须一致，否则一个宿主侧故障就把整张 provider 卡打死。
          resolved = undefined;
        }
      }
      // resolve 的值当场丢弃，只带出 source 层 id（可达性判定用，见 lib/ocr-config.ts）；
      // 空值按「未配置」处理（凭据层「空值即不存在」的同款规则），明文 key 绝不进
      // 配置/回执/日志。
      return resolved !== undefined && resolved.value.length > 0 ? resolved.source : undefined;
    },
  };
}

/** repo 解析：显式绝对路径优先，缺省回退当前会话工作区（导出仅供单测，
 *  同 plugin-hot-reload 把内部纯函数导出的惯例）。 */
export function ocrRepo(
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: OcrReviewMessages,
): string {
  return resolveRoot(args["repo"], sessionHeaderCwd(exec), messages);
}

/** git rev-parse 的墙钟上限：一条本地命令，失败即回退，不值得占用评审预算。 */
const GIT_TOPLEVEL_TIMEOUT_MS = 10_000;

/** realpath，失败则原样返回（路径可能已不存在：归档后的 checkout 仍要能查会话）。 */
function realpathOrSelf(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * 把审查根归一化成 **canonical 的 git 顶层**，让 review 与 ocr_session 落到同一个会话目录。
 *
 * 为什么插件侧要管这件事：OCR 把 review 的 RepoDir 锚定在 git 顶层（`shared.go` 的
 * requireGit=true 分支），而会话目录正是由 RepoDir 编码而来。插件若把模型给的子目录
 * 原样喂给 `--repo`，`ocr review` 写进顶层、`ocr_session` 查子目录 —— 两个不同的
 * `~/.opencodereview/sessions/<encoded>` 目录，查询侧命中「目录不存在」分支静默返回
 * 空，表现为「写得出会话却永远列不出来」。符号链接前缀同理：git 报的是 realpath，
 * 而 filepath.Abs 保留 `/tmp` 这类前缀。
 *
 * 为什么不统一提升所有工具：scan 靠 workdir 限定子目录（OCR 的 scan 路径
 * requireGit=false，保留 CWD 以免 `git ls-files` 走遍整个仓库），一并提升会把扫描
 * 范围扩到整个 monorepo。scan 又不落会话（只有 review 经 agent.New → session.New
 * 建会话），所以它保持原样即可，两侧口径本来就一致。
 *
 * 非 git 目录（归档后的 checkout 等）回退到 realpath：会话仍按同一路径寻址。
 *
 * 刻意不缓存：一次本地 git 命令相对一次评审（分钟级）可忽略，换来的是没有陈旧值，
 * 也不会让「仓库被 git init / 顶层变动」后读到旧结果。
 */
async function canonicalReviewRoot(host: HostCtx, root: string): Promise<string> {
  try {
    const { exitCode, output } = await runCollect(host, "git rev-parse --show-toplevel", root, {
      timeoutMs: GIT_TOPLEVEL_TIMEOUT_MS,
      stdoutMaxBytes: 4096,
    });
    const top = exitCode === 0 ? output.trim() : "";
    if (top.startsWith("/")) {
      return top;
    }
  } catch {
    // 落到下面的 realpath 回退：git 缺席 / 非仓库 / 进程被杀，都不该让评审失败。
  }
  return realpathOrSelf(root);
}

/** select 读面的依赖（对象化以受 max-params 约束）。 */
interface SelectEndpointDeps {
  config: Config;
  gateway: DshConfigGateway;
  host: HostCtx;
  messages: () => OcrReviewMessages;
}

/**
 * 应用一次 provider/model 选择。
 *
 * 缺字段就地回 400 而不是让 applyProviderSelection 抛：那句文案与卡片「选一个」的提示
 * 同源，走异常只会让调用方看见一层包装。其余失败一律折成 `{ ok: false, status }`：
 * `status` 是本包保留的语义码（见 `lib/remote-shape.ts` 的 OcrRemoteRefused），不是 HTTP 状态。
 */
async function selectReply(
  provider: string,
  model: string,
  deps: SelectEndpointDeps,
): Promise<OcrSelectReply> {
  const msgs = deps.messages();
  if (provider === "" || model === "") {
    return { ok: false, error: msgs.providerModelRequired, status: 400 };
  }
  try {
    const language = readLanguage(deps.config);
    const applied = await applyProviderSelection(
      deps.gateway,
      pluginPaths(deps.config, msgs),
      { provider, model, ...(language === undefined ? {} : { language }) },
      msgs,
    );
    let llmTest: { ok: boolean; output: string } | null = null;
    if (readAutoVerify(deps.config)) {
      llmTest = await runLlmTest(deps.host, deps.config);
    }
    return { ok: true, applied, llmTest };
  } catch (error) {
    return { ok: false, error: errorText(error), status: 400 };
  }
}

/** probe 读面的依赖（与 select 同一取舍：>5 参数会撞 max-params）。 */
interface ProbeEndpointDeps {
  config: Config;
  host: HostCtx;
  messages: () => OcrReviewMessages;
  /** 外部 CLI 可用性的现读口（与五个工具同一个）：换版命令要按那份候选的真实来源说。 */
  availability: OcrAvailabilityProbe;
  /** 实测版本的落态口：检测一次就覆盖装载期那一次，卡片与工具回执从此读同一份。 */
  versionSink: { value: string | null };
}

/**
 * 跑一次状态探测并落成卡片吃得下的那份载荷。
 *
 * `reason` 与 `output` 的分工：`output` 是外部 CLI 的一手回执（`runCollect` 已脱敏、
 * 已按码元截断），那句「自动更新没成功，请手工执行 npm i -g …」就原样活在里面——本包
 * 不去正则它，因为那句措辞归上游改，抄一份判据就多一处会跟着漂的地方；卡片把整段
 * 显示出来供人选中文本复制即可。`reason` 只说这一路为什么没取到版本。
 *
 * `consistent` 是三态而不是布尔：`null` = 压根没读出版本（未发布构建、超时、没装），
 * 这时对用户宣称「不一致」是把没证据的事说成结论。`changeText` 只在**有把握给出命令**
 * 时才非空——实测到别的版本，或文件系统那边根本没有候选。
 */
async function probeReply(deps: ProbeEndpointDeps): Promise<OcrProbeReply> {
  try {
    const messages = deps.messages();
    const probe = await runVersionProbe(deps.host, deps.config, messages);
    deps.versionSink.value = probe.version;
    const status = deps.availability();
    const consistent = probe.version === null ? null : probe.version === EXPECTED_OCR_CLI_VERSION;
    const showCommand = consistent === false || status.source === "none";
    return {
      ok: probe.ok,
      version: probe.version,
      expectedVersion: EXPECTED_OCR_CLI_VERSION,
      consistent,
      output: probe.output,
      reason: probe.reason,
      changeText: showCommand ? ocrInstallText(status, deps.config, messages) : "",
    };
  } catch (error) {
    // shell 服务本身抛错（不是非零退出）也要回可读回执，理由同 migrate。
    return { ok: false, error: errorText(error), status: 400 };
  }
}

/** 读面额外现读的三口：装载期自检结论、外部 CLI 可用性、最近一次实测版本。收成对象是因为
 *  逐项平铺会撞 max-params；这几口本来就是同一类东西。 */
interface EndpointExtras {
  /** 装载期端点自检结果的现读口（apply 的闭包变量，见 probeEndpointAtApply）。 */
  readonly verifyOf: () => EndpointVerify | null;
  /** 外部 CLI 可用性的现读口（与五个工具同一个），设置页据此显示装没装。 */
  readonly availability: OcrAvailabilityProbe;
  /** 实测版本的落态口（本包只有跑过 `ocr version` 才有值：装载期自检或人按下「检测」）。
   *  给对象而不是给读口，是因为 POST probe 这一侧要往里写。 */
  readonly versionSink: { value: string | null };
}

/** providers 读面的依赖（与 select/probe 同一取舍：>5 参数会撞 max-params）。 */
interface ProvidersEndpointDeps {
  config: Config;
  gateway: DshConfigGateway;
  messages: () => OcrReviewMessages;
  extras: EndpointExtras;
}

/**
 * 组好设置页那份载荷（**不含 csrf**：本包不再持有任何写侧闸门，鉴权归宿主网关）。
 *
 * `ocrBinary` 只用文件系统的事实（不起进程），卡片据此显示「装没装、走的哪条路、那一份是什么
 * 装法」。实测版本不在这里 spawn——这里只交最近一次检测落在闭包里的那个值（没测过就是 null）；
 * 现跑一次 `ocr version` 归 probe，由人按下「检测」才拿。
 */
async function providersReply(deps: ProvidersEndpointDeps): Promise<Record<string, unknown>> {
  try {
    const msgs = deps.messages();
    const payload = await providersForCard(
      deps.gateway,
      pluginPaths(deps.config, msgs),
      msgs,
      deps.extras.verifyOf(),
    );
    return {
      ...payload,
      ocrBinary: cliStatusPayload(
        deps.extras.availability(),
        deps.config,
        msgs,
        deps.extras.versionSink.value,
      ),
    };
  } catch (error) {
    // 装配期之后的意外（设置项里的路径不合法、宿主服务抛错）也要回可读回执：
    // 卡片读的是 error 文本，让它卡在「加载 providers…」比让它报错更难排查。
    return { ok: false, error: errorText(error), status: 500 };
  }
}

/** 明文 key 一键迁移。 */
async function migrateReply(deps: SelectEndpointDeps): Promise<OcrMigrateReply> {
  try {
    const msgs = deps.messages();
    const result = await migratePlaintextKeys(deps.gateway, pluginPaths(deps.config, msgs), msgs);
    return { ok: true, ...result };
  } catch (error) {
    // 坏 config.json / settings 读不到都会抛（写侧 fail-loud），必须回可读错误：
    // 卡片要能读出「为什么没迁移」。
    return { ok: false, error: errorText(error), status: 400 };
  }
}

/** 手动 `ocr llm test`：`ok` 是测试结论，不是调用成败。 */
async function testReply(deps: SelectEndpointDeps): Promise<OcrTestReply> {
  try {
    const llmTest = await runLlmTest(deps.host, deps.config);
    return { ok: llmTest.ok, output: llmTest.output };
  } catch (error) {
    return { ok: false, error: errorText(error), status: 400 };
  }
}

/** 卡片读面（官方 Typert Remote）的全部依赖。 */
export interface OcrReviewRemoteDeps {
  host: HostCtx;
  config: Config;
  gateway: DshConfigGateway;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messages: () => OcrReviewMessages;
  extras: EndpointExtras;
}

/**
 * 设置卡的五条读/写方法（providers / select / migrate / test / probe）。
 *
 * ⚠ 服务在**构造时**注册（cordis `Service` 的契约：`ctx.reflect.provide`，随所属 fiber
 * 卸载自动撤），所以调用方拿实例没有任何用处——装入口 `installOcrRemote` 说明了这一点。
 * 五个方法都不依赖可选宿主服务（gateway 与取用口都由 apply 交进来），故它跟着 apply
 * 无条件上线：宿主没有 web 层（TUI）时这五条照样在。
 */
export class OcrReviewRemoteService extends TypertRemoteService {
  private readonly deps: OcrReviewRemoteDeps;

  public constructor(ctx: Context, deps: OcrReviewRemoteDeps) {
    super(ctx, OCR_REMOTE_NAMESPACE);
    this.deps = deps;
  }

  /** 设置页数据：provider 清单 + 当前 OCR 配置 + 降级原因 + 外部 CLI 状态（无 key 明文）。 */
  public async providers(): Promise<Record<string, unknown>> {
    return providersReply(this.deps);
  }

  /** 应用 provider/model 选择；回执里按 autoVerify 决定是否带 llm test。 */
  public async select(request: OcrSelectRequest): Promise<OcrSelectReply> {
    // 入参来自网线：类型说的是 descriptor 的承诺，交付仍按 unknown 面守卫。
    const provider =
      isRecord(request) && typeof request.provider === "string" ? request.provider : "";
    const model = isRecord(request) && typeof request.model === "string" ? request.model : "";
    return selectReply(provider, model, this.deps);
  }

  /** 明文 api_key → api_key_cmd 一键迁移。 */
  public async migrate(): Promise<OcrMigrateReply> {
    return migrateReply(this.deps);
  }

  /** 手动触发 ocr llm test。 */
  public async test(): Promise<OcrTestReply> {
    return testReply(this.deps);
  }

  /** 跑一次 `ocr version`，取外部 CLI 的自述给状态行（不前置可用性：检测就是为了知道装没装）。 */
  public async probe(): Promise<OcrProbeReply> {
    return probeReply({
      config: this.deps.config,
      host: this.deps.host,
      messages: this.deps.messages,
      availability: this.deps.extras.availability,
      versionSink: this.deps.extras.versionSink,
    });
  }
}

/**
 * 标准装饰器的**程序化调用**：`@Remote` 的全部作用就是往类原型写一枚描述符，而标准装饰器
 * 语法需要一条 tsc 降级管线（本仓的测试/构建解析器都不降级它）。这里直接按 TC39 的
 * `ClassMethodDecoratorContext` 形状调同一个 decorator 函数，把标记落到真正的原型上。
 */
function markRemote(prototype: OcrReviewRemoteService, methodName: string): void {
  // 官方 `Remote` 的运行时只读 name/private/static 与 addInitializer（TC39 的 access/metadata
  // 它一概不读），故这里只给这四位；`Reflect.apply` 让装饰器工厂保持未类型化的调用面。
  const context = {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    addInitializer: (initializer: (this: unknown) => void): void => {
      // 初始器只做 `Object.getPrototypeOf(this)` 后落标记；用原型造一枚替身实例即可。
      Reflect.apply(initializer, Object.create(prototype), []);
    },
  };
  // oxlint-disable-next-line eslint/new-cap -- `Remote(…)` 是装饰器工厂，不是大写开头的构造调用
  const decorate = Remote(methodName);
  Reflect.apply(decorate, undefined, [Reflect.get(prototype, methodName), context]);
}

markRemote(OcrReviewRemoteService.prototype, "providers");
markRemote(OcrReviewRemoteService.prototype, "select");
markRemote(OcrReviewRemoteService.prototype, "migrate");
markRemote(OcrReviewRemoteService.prototype, "test");
markRemote(OcrReviewRemoteService.prototype, "probe");

/**
 * 把读面装到这个上下文上（构造即注册，见类文档；host 侧唯一该调的口）。
 *
 * 注册口先探一次（`ctx.reflect.provide`）：替身/畸形上下文未必给，少了它只该少掉卡片
 * 这一栏，绝不该让 apply 当场炸掉。本服务没有自己的收尾资源——卸载由 Service 基类登记的
 * 反射面 disposer 负责，不另挂 effect。
 *
 * @param ctx - 宿主上下文
 * @param deps - 读面的全部依赖（见 OcrReviewRemoteDeps）
 * @returns 装上了没有（调用方不需要它——返回它只是让这条路可断言）
 */
export function installOcrRemote(ctx: Context, deps: OcrReviewRemoteDeps): boolean {
  if (!isRecord(ctx)) {
    return false;
  }
  const { reflect } = ctx;
  if (!isRecord(reflect) || typeof reflect.provide !== "function") {
    return false;
  }
  // oxlint-disable-next-line eslint/no-new -- 见函数文档：构造即注册，返回值无意义
  new OcrReviewRemoteService(ctx, deps);
  return true;
}

// ── 外部 CLI 可用性前置 ─────────────────────────────────────────────────────

/**
 * 可用性的**现读口**：每次工具调用现问一次文件系统。
 * 不做进程级缓存是刻意的——`PATH` 与随包依赖都会在 dsh 运行期间被改（装了就直接重试，
 * 不必重启宿主），而一次 statSync 的代价远低于一次误判成「没装」把可用环境挡掉。
 */
export type OcrAvailabilityProbe = () => OcrBinaryStatus;

/**
 * 生产侧的可用性现读口：每次调用问一次真实文件系统。
 * 单独具名导出是为了让它能被结构性地钉住（单测拿它和 `lib/cli.ts` 那份判据逐字比），
 * 而不必让任何用例去分支「这台机器恰好装没装 ocr」。
 */
export const productionProbe: OcrAvailabilityProbe = () => resolveOcrAvailability();

/**
 * 两条路都没有候选时就地抛，让模型与用户看到的是「哪条路都没找到 + 怎么装（带核对版本）」，
 * 而不是子进程 exit 127 之后那句反推出来的「ocr 命令不存在」。
 * 判据只回答「找不找得到」：丢执行位、随包平台二进制缺失这些「找到了但跑不起来」的事实
 * 仍由真实 spawn 报（lib/cli.ts 的 resolveOcrAvailability 头注释写了同一口径），
 * 所以 `execNotFound` 那条兜底文案必须留着。
 * @param status - 现读口交回的可用性判定。
 * @param messages - 文案表（拒绝理由是人读文本，随官方 locale 偏好走）。
 * @param install - 那条装法文案（`ocrInstallText` 现组；只有真要拒时才付这次拼接）。
 */
export function assertOcrPresent(
  status: OcrBinaryStatus,
  messages: OcrReviewMessages,
  install: string,
): void {
  if (status.source === "none") {
    throw new Error(format(messages.ocrBinaryMissing, { install }));
  }
}

// ── 5 个工具各自的注册函数（apply 只做编排，否则单个函数会长过
//    max-lines-per-function 上限）────────────────────────────────────────────

function registerReviewTool(
  host: HostCtx,
  config: Config,
  probe: OcrAvailabilityProbe,
  versionSink: { value: string | null },
): void {
  // 注册期快照一份文案（工具 description 随注册进 tools 服务，换语言要重新 apply）；
  // 执行期每次现取，回显文本立即跟随设置页偏好。
  const msgs = localeMessages(host);
  // ocr_review：自驱 diff 审查。
  define(host, {
    name: "ocr_review",
    description: msgs.reviewToolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: msgs.paramRepo },
        scope: {
          type: "string",
          enum: ["workspace", "commit", "branch"],
          description: msgs.paramScope,
        },
        commit: { type: "string", description: msgs.paramCommit },
        from: { type: "string", description: msgs.paramFrom },
        to: { type: "string", description: msgs.paramTo },
        effort: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: msgs.paramEffort,
        },
        background: { type: "string", description: msgs.paramBackground },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: msgs.paramExclude,
        },
        ...tuningParams(msgs, msgs.unitGroup, msgs.tuningMaxTools),
        wait: { type: "boolean", description: msgs.paramWait },
        provider: { type: "string", description: msgs.paramProvider },
        model: { type: "string", description: msgs.paramModel },
        resume: { type: "string", description: msgs.paramResume },
      },
    },
    schema: REVIEW_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      // 先问文件系统再决定要不要起进程：两条路都没有候选时，这里就给模型「哪条路都没
      // 找到 + 怎么装」，而不是让 bash 跑到 exit 127 再反推。
      const cliStatus = probe();
      assertOcrPresent(cliStatus, runMsgs, ocrInstallText(cliStatus, config, runMsgs));
      // 归一化到 git 顶层：OCR 内部本就如此锚定（审查范围不变），但会话目录由
      // RepoDir 编码而来——不归一化，ocr_session 就查不到（见 canonicalReviewRoot）。
      const repo = await canonicalReviewRoot(host, ocrRepo(args, exec, runMsgs));
      // effort 未显式传入时取设置卡默认（effortOf 内做类型闸与白名单钳制）。
      const eff = effortOf(args["effort"], config, runMsgs);
      // wait=false = 后台：无 tmp、无 --output，结果以会话记录为准（ocr_session 轮询）。
      const wait = waitOf(args["wait"], runMsgs);
      // 评审可能是长任务：临时目录落盘 --output，避免宿主 stdout 截断丢评论。
      const tmp = wait ? mkdtempSync(path.join(tmpdir(), "ocr-review-")) : undefined;
      const outPath = tmp === undefined ? undefined : path.join(tmp, "out.json");
      // ocrConfigPath 自定义时的 HOME 重定向（withHomeEnv 内部对 undefined/win32
      // 原样放行）。先注环境再套回收守护：守护把整条命令 shq 进 bash -c，前缀必须在最内层。
      // 指针自愈先行：api_key_cmd 指向已不存在的安装目录时，ocr 会在解析 LLM 端点
      // 那一步就失败，五个工具一起挂，而报错与真因毫无关系（详见 healKeyScriptPointer）。
      await healKeyScriptPointer(host, config);
      const homeOverride = ocrHome(config);
      try {
        const { command, workdir } = buildReviewCommand(
          { ...args, repo, effort: eff },
          outPath,
          runMsgs,
        );
        // 分钟级长任务：套宿主回收守护，dsh 任何方式退出（含 kill -9 后 launchd
        // 收养）OCR 进程都会被 TERM→1s→KILL，不留孤儿烧 token（lib/cli.ts）。
        const guarded = wrapWithHostReaper(withHomeEnv(command, homeOverride), runMsgs);
        if (outPath === undefined) {
          return await startBackground(host, {
            command: guarded,
            workdir,
            tool: "ocr_review",
            repo,
            stdoutMaxBytes: config.stdoutMaxBytes,
            backgroundMaxMs: config.ocrBackgroundMaxMs,
            env: ocrEnv(config),
          });
        }
        try {
          await runForeground(host, guarded, workdir, tuningOf(config), exec.signal);
        } catch (error) {
          // 非零退出时 CLI 仍会写出 --output：那里面才有「哪些文件没审成」。
          throw withCoverageDetail(error, outPath, runMsgs);
        }
        const text = readOutFile(outPath, runMsgs);
        const parsed = parseReviewOutput(text, runMsgs);
        if (!parsed.ok) {
          // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支），
          // 不报假干净也不假装结构化。
          return format(runMsgs.parseFailedWithReason, {
            tool: "ocr",
            message: parsed.message,
            limit: String(RAW_ECHO_LIMIT),
            // 脱敏与截断的次序不变：仍是 echoRaw(原文, 上限)
            raw: echoRaw(text, RAW_ECHO_LIMIT),
          });
        }
        // summarizeReview 的结构化对象直返（canonical value，不再 stringify 进 {text}）。
        const summary = summarizeReview(parsed, runMsgs, { maxComments: readMaxComments(config) });
        return withCliVersionNote(summary, versionSink.value, runMsgs);
      } finally {
        if (tmp !== undefined) {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    },
  });
}

function registerScanTool(
  host: HostCtx,
  config: Config,
  probe: OcrAvailabilityProbe,
  versionSink: { value: string | null },
): void {
  const msgs = localeMessages(host);
  // ocr_scan：无 git diff 的全文件扫描。
  define(host, {
    name: "ocr_scan",
    description: msgs.scanToolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: msgs.paramRepo },
        path: {
          type: "array",
          items: { type: "string" },
          description: msgs.paramScanPath,
        },
        background: { type: "string", description: msgs.paramBackgroundShort },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: msgs.paramExclude,
        },
        batch: {
          type: "string",
          enum: ["none", "by-language", "by-directory"],
          description: msgs.paramBatch,
        },
        // OCR scan 原生 --provider/--model（shared_flags.go 的 registerScanFlags），
        // 与 ocr_review 对齐。
        provider: { type: "string", description: msgs.paramProvider },
        model: { type: "string", description: msgs.paramModel },
        ...tuningParams(msgs, msgs.unitFile, msgs.tuningMaxToolsScan),
        wait: { type: "boolean", description: msgs.paramWait },
      },
    },
    schema: REVIEW_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      // 先问文件系统再决定要不要起进程：两条路都没有候选时，这里就给模型「哪条路都没
      // 找到 + 怎么装」，而不是让 bash 跑到 exit 127 再反推。
      const cliStatus = probe();
      assertOcrPresent(cliStatus, runMsgs, ocrInstallText(cliStatus, config, runMsgs));
      const repo = ocrRepo(args, exec, runMsgs);
      // wait=false = 后台：无 tmp、无 --output，结果以会话记录为准（ocr_session 轮询）。
      const wait = waitOf(args["wait"], runMsgs);
      const tmp = wait ? mkdtempSync(path.join(tmpdir(), "ocr-scan-")) : undefined;
      const outPath = tmp === undefined ? undefined : path.join(tmp, "out.json");
      // 同 ocr_review：先注 HOME 重定向再套守护（前缀必须在最内层）。
      // 指针自愈先行：api_key_cmd 指向已不存在的安装目录时，ocr 会在解析 LLM 端点
      // 那一步就失败，五个工具一起挂，而报错与真因毫无关系（详见 healKeyScriptPointer）。
      await healKeyScriptPointer(host, config);
      const homeOverride = ocrHome(config);
      try {
        const { command, workdir } = buildScanCommand({ ...args, repo }, outPath, runMsgs);
        // 同 ocr_review：宿主回收守护（lib/cli.ts wrapWithHostReaper）。
        const guarded = wrapWithHostReaper(withHomeEnv(command, homeOverride), runMsgs);
        if (outPath === undefined) {
          return await startBackground(host, {
            command: guarded,
            workdir,
            tool: "ocr_scan",
            repo,
            stdoutMaxBytes: config.stdoutMaxBytes,
            backgroundMaxMs: config.ocrBackgroundMaxMs,
            env: ocrEnv(config),
          });
        }
        try {
          await runForeground(host, guarded, workdir, tuningOf(config), exec.signal);
        } catch (error) {
          // 非零退出时 CLI 仍会写出 --output：那里面才有「哪些文件没审成」。
          throw withCoverageDetail(error, outPath, runMsgs);
        }
        const text = readOutFile(outPath, runMsgs);
        const parsed = parseReviewOutput(text, runMsgs);
        if (!parsed.ok) {
          // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支）。
          return format(runMsgs.parseFailedWithReason, {
            tool: "ocr scan",
            message: parsed.message,
            limit: String(RAW_ECHO_LIMIT),
            raw: echoRaw(text, RAW_ECHO_LIMIT),
          });
        }
        // 结构化摘要直返（同 ocr_review 的 canonical 契约）。
        const summary = summarizeReview(parsed, runMsgs, { maxComments: readMaxComments(config) });
        return withCliVersionNote(summary, versionSink.value, runMsgs);
      } finally {
        if (tmp !== undefined) {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    },
  });
}

function registerDelegatePreviewTool(
  host: HostCtx,
  config: Config,
  probe: OcrAvailabilityProbe,
): void {
  const msgs = localeMessages(host);
  // ocr_delegate_preview：文件清单 + 模式元数据（零 LLM 消耗）。
  define(host, {
    name: "ocr_delegate_preview",
    description: msgs.previewToolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: msgs.paramRepo },
        scope: {
          type: "string",
          enum: ["workspace", "commit", "branch"],
          description: msgs.paramScope,
        },
        commit: { type: "string", description: msgs.paramCommitShort },
        from: { type: "string", description: msgs.paramFromShort },
        to: { type: "string", description: msgs.paramToShort },
        background: { type: "string", description: msgs.paramBackgroundPreview },
        exclude: { type: "array", items: { type: "string" }, description: msgs.paramExcludeShort },
      },
    },
    schema: PREVIEW_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      // 先问文件系统再决定要不要起进程：两条路都没有候选时，这里就给模型「哪条路都没
      // 找到 + 怎么装」，而不是让 bash 跑到 exit 127 再反推。
      const cliStatus = probe();
      assertOcrPresent(cliStatus, runMsgs, ocrInstallText(cliStatus, config, runMsgs));
      const repo = ocrRepo(args, exec, runMsgs);
      // 指针自愈先行：api_key_cmd 指向已不存在的安装目录时，ocr 会在解析 LLM 端点
      // 那一步就失败，五个工具一起挂，而报错与真因毫无关系（详见 healKeyScriptPointer）。
      await healKeyScriptPointer(host, config);
      const homeOverride = ocrHome(config);
      const { command, workdir } = buildDelegatePreviewCommand({ ...args, repo }, runMsgs);
      const stdout = await runForeground(
        host,
        withHomeEnv(command, homeOverride),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      const parsed = parseDelegatePreview(stdout.text);
      if (!parsed.ok) {
        // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支）。截断说明
        // 单独拼在尾部：载荷被截断恰恰必然解析失败，而 raw 只回显头部，spill 落盘
        // 路径只有从这里才到得了模型。
        return (
          format(runMsgs.parseFailedPlain, {
            tool: "ocr delegate preview",
            limit: String(RAW_ECHO_LIMIT),
            raw: echoRaw(stdout.text, RAW_ECHO_LIMIT),
          }) + stdoutTruncationNote(config.stdoutMaxBytes, stdout, runMsgs)
        );
      }
      // 清单对象直返（canonical value）。mergeBase 一并带出：previewHint 让模型用
      // `git diff <merge_base>..<to>` 取 diff，此前解析了却没交出去，模型只能再跑一次。
      return {
        mode: parsed.mode,
        repository: parsed.repository,
        mergeBase: parsed.mergeBase === "" ? null : parsed.mergeBase,
        reviewableCount: parsed.reviewable.length,
        insertions: parsed.reviewable.reduce((acc, file) => acc + file.insertions, 0),
        deletions: parsed.reviewable.reduce((acc, file) => acc + file.deletions, 0),
        reviewableFiles: parsed.reviewable,
        excludedFiles: parsed.excluded,
        hint: runMsgs.previewHint,
      };
    },
  });
}

function registerDelegateRuleTool(
  host: HostCtx,
  config: Config,
  probe: OcrAvailabilityProbe,
): void {
  const msgs = localeMessages(host);
  // ocr_delegate_rule：规则分组（零 LLM 消耗）。
  define(host, {
    name: "ocr_delegate_rule",
    description: msgs.ruleToolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: msgs.paramRepo },
        paths: {
          type: "array",
          items: { type: "string" },
          description: msgs.paramPaths,
        },
      },
      required: ["paths"],
    },
    schema: RULES_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      // 先问文件系统再决定要不要起进程：两条路都没有候选时，这里就给模型「哪条路都没
      // 找到 + 怎么装」，而不是让 bash 跑到 exit 127 再反推。
      const cliStatus = probe();
      assertOcrPresent(cliStatus, runMsgs, ocrInstallText(cliStatus, config, runMsgs));
      const repo = ocrRepo(args, exec, runMsgs);
      const { command, workdir } = buildDelegateRuleCommand(
        { repo, paths: args["paths"] },
        runMsgs,
      );
      const stdout = await runForeground(
        host,
        withHomeEnv(command, ocrHome(config)),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      const parsed = parseDelegateRules(stdout.text);
      if (!parsed.ok) {
        // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支）；截断说明
        // 单独拼在尾部（判据同 ocr_delegate_preview）。
        return (
          format(runMsgs.parseFailedPlain, {
            tool: "ocr delegate rule",
            limit: String(RAW_ECHO_LIMIT),
            raw: echoRaw(stdout.text, RAW_ECHO_LIMIT),
          }) + stdoutTruncationNote(config.stdoutMaxBytes, stdout, runMsgs)
        );
      }
      // 分组对象直返（canonical value）。
      return {
        groupCount: parsed.groups.length,
        groups: parsed.groups.map((group) => ({
          source: group.source,
          pattern: group.pattern,
          files: group.files,
          rule: group.rule,
        })),
        hint: runMsgs.ruleHint,
      };
    },
  });
}

function registerSessionTool(host: HostCtx, config: Config, probe: OcrAvailabilityProbe): void {
  const msgs = localeMessages(host);
  // ocr_session：历史评审会话（恢复中断 review 的配套闭环）。
  define(host, {
    name: "ocr_session",
    description: msgs.sessionToolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: msgs.paramRepo },
        action: {
          type: "string",
          enum: ["list", "show", "comments"],
          description: msgs.paramSessionAction,
        },
        id: { type: "string", description: msgs.paramSessionId },
        limit: { type: "integer", description: msgs.paramSessionLimit },
      },
    },
    schema: SESSION_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      // 先问文件系统再决定要不要起进程：两条路都没有候选时，这里就给模型「哪条路都没
      // 找到 + 怎么装」，而不是让 bash 跑到 exit 127 再反推。
      const cliStatus = probe();
      assertOcrPresent(cliStatus, runMsgs, ocrInstallText(cliStatus, config, runMsgs));
      // 与 ocr_review 同一个归一化：两侧必须落在同一个会话目录，否则 review 写进去、
      // 这里查的是另一个目录（缺陷 1）。
      const repo = await canonicalReviewRoot(host, ocrRepo(args, exec, runMsgs));
      const { command, workdir } = buildSessionCommand({ ...args, repo }, runMsgs);
      // session 也读 OCR 家目录（sessions 清单），随 ocrConfigPath 一并重定向。
      const stdout = await runForeground(
        host,
        withHomeEnv(command, ocrHome(config)),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      const { text } = stdout;
      // 无会话时 OCR 返回 JSON null → 转友好提示，避免模型困惑。
      const stripped = text.trim();
      const empty = stripped === "null" || stripped === "[]";
      // session 输出体量小，直接透传（含长度保护，避免假完整 + 明文 key 脱敏）。
      // 截断说明拼在尾部：stdout 被截断时 session JSON 也会缺尾，模型需要知道去哪读全。
      const capped =
        text.length > 12_000
          ? `${echoRaw(text, 11_900)}\n${runMsgs.sessionTruncated}`
          : redactKeyMaterial(text);
      // 对象直返（canonical value）；sessionOutput 保持一手透传字符串的诚实值。
      return {
        sessionOutput:
          (empty ? runMsgs.sessionEmpty : capped) +
          stdoutTruncationNote(config.stdoutMaxBytes, stdout, runMsgs),
        hint: runMsgs.sessionResumeHint,
      };
    },
  });
}

/** 装载期自检结论里保留的输出上限（字符）：卡片只用来提示，留全量没有意义。 */
const ENDPOINT_VERIFY_CHARS = 400;

/** 装载期端点自检（fire-and-forget）：跑一次 `ocr llm test`，把结论写进本次 apply 的闭包，
 *  经 GET providers 随载荷交给卡片。
 *
 *  为什么需要：卡片写盘只写 url/model/key 通道，**不验端点能力**。实测踩到过——网关强制
 *  要求一枚能力头，缺了它每个文件都 400，而模型侧看到的是「N 个文件审查失败」，与真因
 *  （端点配置）隔着一层。自检失败不抛、不阻塞装载：它只负责让这件事早点可见。
 * @param host 宿主服务面
 * @param config 本次 apply 的配置
 * @param sink 本次 apply 的闭包槽（不是常驻状态）
 */
/** 装载期自检结果 → 卡片读的那一格（成功不占文案，失败截到预算内）。 */
export function endpointVerifyOf(result: { ok: boolean; output: string }): EndpointVerify {
  return result.ok
    ? { ok: true, message: "" }
    : { ok: false, message: result.output.trim().slice(0, ENDPOINT_VERIFY_CHARS) };
}

async function probeEndpointAtApply(
  host: HostCtx,
  config: Config,
  sink: { value: EndpointVerify | null },
): Promise<void> {
  // runCollect 自身「只收集不抛错」：命令跑不动时它把失败折进 exitCode/output，
  // 故这里没有可抛路径，也就不需要 catch（本仓覆盖率 100%，写一条走不到的分支
  // 只会逼出一条假用例）。
  const result = await runLlmTest(host, config);
  sink.value = endpointVerifyOf(result);
}

/**
 * 装载期版本自检（fire-and-forget）：跑一次 `ocr version`，把实测版本落在本次 apply 的闭包里。
 *
 * 为什么要有这一次：工具回执里那句「实测与核对版本不一致」只能来自一次真实测量，而按下
 * 「检测」是人在页面上的动作——把它留给用户，模型侧的版本提示就永远晚一步。与端点自检同批、
 * 同受 `startupVerify` 管：那条设置的判据就是「装载期允不允许起进程」，这里起的同样是进程。
 * 关掉它的部署退化成「页面上点过检测之后，工具才开始报」，那也是一句实话。
 * @param host 宿主服务面
 * @param config 本次 apply 的配置
 * @param sink 本次 apply 的闭包槽（与 POST probe 写的是同一个）
 */
async function probeVersionAtApply(
  host: HostCtx,
  config: Config,
  sink: { value: string | null },
): Promise<void> {
  const probe = await runVersionProbe(host, config, localeMessages(host));
  sink.value = probe.version;
}

export function apply(ctx: Context, config: Config, probe: OcrAvailabilityProbe): void {
  const host = resolveHost(ctx);
  // 装载期自检：startupVerify 开着时顺手验一次端点、测一次外部 CLI 版本（结论都落在本次
  // apply 的闭包里，无常驻状态）。
  const endpointVerify: { value: EndpointVerify | null } = { value: null };
  // 外部 CLI 的实测版本同样落在这次 apply 的闭包里：装载期填一次，之后每次「检测」覆盖它。
  const versionSink: { value: string | null } = { value: null };
  if (config.startupVerify) {
    void probeEndpointAtApply(host, config, endpointVerify);
    void probeVersionAtApply(host, config, versionSink);
  }
  // 本包的后台作业登记为**未拥有**的官方作业，controller 只在 start 那一瞬挂
  // （见 `startUnderOcrController`），所以这里没有需要在卸载时摘的 token；但**在跑的
  // 作业**必须卸载时收掉——注册表随宿主活着，不等本插件。
  ctx.effect(
    () => () => {
      const jobs: JobsService | undefined = ctx.get("jobs");
      if (jobs !== undefined) {
        reclaimOcrJobs(jobs, localeMessages(ctx).jobReasonUnload);
      }
    },
    "ocr-review: background jobs",
  );
  // 会话被停止/关闭（session/disposed）即回收本包在跑的后台评审：后台进程不随工具
  // 调用中止而停（任何模式下都能后台运行），但会话本身结束时不留孤儿进程与在跑作业。
  ctx.effect(
    () =>
      ctx.on("session/disposed", () => {
        const jobs: JobsService | undefined = ctx.get("jobs");
        if (jobs === undefined) {
          return;
        }
        // 事件处理器里不许抛：注册表被重载/关掉时 kill 会对陌生 id 抛
        // （installed dsh-jobs-local/lib/index.js:554-558 的 expect）。会话都已结束，
        // 这里再炸一次宿主没有任何补救价值。
        try {
          reclaimOcrJobs(jobs, localeMessages(ctx).jobReasonSessionStopped);
        } catch {
          // 记录已被注册表收走：无事可做。
        }
      }),
    "ocr-review: session stop reaps background runs",
  );
  // 本包不调 `settings.register(...)`：宿主把导出的 `Config` 里标了
  // `.volatile()` 的字段隐式投影成设置表单（ns = profile 条目 id `ocr-review`），
  // 行 config 与默认值在装载期就已合并完，交下来的 `config` 就是运行时值。
  // 插件侧只剩页面策略这一件事：本包自带卡片，别让宿主再生成一份自动表单页。
  // owner 必须显式传本插件 fiber（缺省是 settings 服务自己的 fiber），且经
  // child.effect 挂载以便随注入子上下文回收——宿主 dsh-client-locale 同款写法。
  host.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, host.fiber));
  });

  registerReviewTool(host, config, probe, versionSink);
  registerScanTool(host, config, probe, versionSink);
  registerDelegatePreviewTool(host, config, probe);
  registerDelegateRuleTool(host, config, probe);
  registerSessionTool(host, config, probe);

  // systemPrompt 路由段（正文是文案，随官方 locale 偏好走）。
  host.systemPrompt.section({
    name: ROUTING_NAME,
    order: ROUTING_ORDER,
    text: localeMessages(host).routingText,
  });

  // 设置卡的官方读面（Typert Remote）：五条方法经宿主网关暴露给**本 profile 的客户端**。
  // 无条件上线——依赖都由这里交进去；来源校验与鉴权由宿主网关承担。
  installOcrRemote(ctx, {
    host,
    config,
    gateway: createGateway(host),
    messages: () => localeMessages(host),
    extras: { verifyOf: () => endpointVerify.value, availability: probe, versionSink },
  });
}

export default {
  inject: ["settings", "shell", "tools", "systemPrompt"],
  Config: configSchema,
  // cordis 只交 `(ctx, config)` 两个参数，所以入口在这一层把生产现读口接上；
  // 具名导出的 `apply` 保留第三个参数，用例据此注入可用性替身——否则每个工具用例
  // 都得看「这台机器恰好装没装 ocr」的脸色，而那条判据在无头机器上根本不可复现。
  apply: (ctx: Context, config: Config): void => {
    apply(ctx, config, productionProbe);
  },
};
