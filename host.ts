// ocr-review dsh 插件 Host 半。
//
// 职责：
//   1. 声明设置面（effort/language/autoVerify/maxComments/timeoutMinutes/
//      ocrConfigPath）。0.1.7 起命名空间是**隐式**的：宿主把本包导出 `Config` 里标了
//      `.volatile()` 的字段投影成设置表单，ns = profile 条目 id（`ocr-review`，见
//      cordis.patch.yml），不再有 `settings.register(ns, schema, { base })` 这一层；
//      原内置底座逐字段落成 schema 的 `.default()`，读本包设置一律 `config.<field>.get()`。
//      本包自带卡片，故只登记一次页面策略 `{ auto: false }`，不让宿主再生成一份自动页。
//   2. 注册 5 个模型工具：ocr_review（自驱 diff 审查）、ocr_scan（全文件扫描）、
//      ocr_delegate_preview / ocr_delegate_rule（委托模式脚手架）、ocr_session（会话内复查）。
//   3. 注册 webServer 端点：GET providers（列表+hasKey，不含 key 明文）、
//      POST select（把 settings 服务里选中的 provider/model 应用到外部 ocr CLI 的
//      config.json，key 走 api_key_cmd 动态读取）、
//      POST migrate（明文 key 一键迁移到 api_key_cmd）、POST test（ocr llm test）。
//   4. 注册 systemPrompt 路由段（order 1555，紧邻 zg 1550 之后；不与 lesson-loop 1560 撞车）。
//
// provider 与 key 的来源（现全部走宿主官方通道，见 createGateway）：
//   - 清单：ctx.settings.describe() 里 llm-pi-ai 那条的 value.providers。本包不再
//     解析 settings.yaml，也不再假设私有键路径。
//   - key：ctx.credentials 的 describe(ref)/resolve(ref)。本包不再读 .credentials.yaml。
//   - 两个服务都可能缺席（非 web profile、未装配 base bundle）→ 端点回可读的降级
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
//   - POST 端点做 CORS 同源校验 + 会话内 CSRF token（shared.guardBody），body
//     统一读尽并限制 8KB；provider/model 必须命中 settings 服务返回的列表（白名单）。
//   - 评审/扫描输出统一走 --output 临时文件（防宿主 stdout 截断），解析后即删。
//   - review/scan 命令经 wrapWithHostReaper 包装（lib/cli.ts）：dsh 任何方式退出
//     （含 kill -9 后 macOS launchd 收养）OCR 进程都会被 TERM→1s→KILL 回收；
//     后台模式另把 exec.signal 接到 proc.kill()，工具调用被取消即停进程。
//
// 运行方式：dsh 的 cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 运行时值导入只有 @deepseek-ai/schemastery（Config schema：`.volatile()` 与
// volatile 字段的引用化只在这个宿主 fork 里有实现，公共 schemastery@3.18 没有，
// 用它的产物在 0.1.7 上设置卡写得进、读不到）、@deepseek-ai/dsh-credentials（在
// dependencies，只取两枚纯语法件，见下面的 import 注释）与 @jayyuen66/dsh-plugin-shared；
// cordis / dsh-settings / dsh-tools / dsh-shell / dsh-host-webserver / dsh-system-prompt
// 一律 type-only（运行时服务由 ctx 注入，见 plugins/README.md 的解耦原则；工具面与
// shell/webServer/systemPrompt 三面的类型绑官方见下面 import 段）。dsh-credentials 是
// **值导入且在 dependencies**，但只取它两枚纯语法件（见下面的 import 注释），凭据读写仍走
// ctx.credentials——服务面没有因此开口。

import Schema from "@deepseek-ai/schemastery";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, Fiber, Volatile } from "@deepseek-ai/cordis";
// 类型侧绑定官方声明：describe() 的字段名（ns/value）与凭据读的返回形状一旦在上游
// 改动，typecheck 立刻报错，而不是运行时静默读不到 provider。
import type { SettingsDescriptor, SettingsForms } from "@deepseek-ai/dsh-settings";
// 值导入：`isCredentialRefName` / `credentialRef` 是凭据包自己交出的**官方**校验与
// 品牌构造（installed lib/index.js:13 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`、
// :21-36），本包原先自己抄了同一条正则当 ref 语法——抄一条规则就多一处会跟着宿主漂移的
// 判据。两者都是纯字符串函数；官方品牌没有 type-only 的构造方式，故落
// `dependencies`、产物留裸说明符（`test/build-host.test.ts` 同时钉"说明符在"与"函数体不在"，
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
// shell / webServer / systemPrompt 三面同批绑官方声明（三个 devDependency 与运行宿主
// 同版本）。服务成员一律经 `Pick<官方类, "方法名">` 投影而不是重抄签名：载荷与返回
// （resolve 的 ShellExecRequest、execute 的 ShellExecSpec / ShellExecution、
// register 的 WebRoute、section 的 PromptSection、result() 的 ShellRunResult）由官方
// 给出，上游改名/换形状就是本包编译错误，而不是运行时静默读不到。
// 仍是 type-only：产物里不得出现这三个说明符（锁见 test/build-host.test.ts）。
import type {
  ShellExecution,
  ShellExecutor,
  ShellProcessStatus,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
// 后台评审的子进程登记为官方作业（ctx.jobs）。口径与上面三件套一致——type-only +
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
// 落定进程 → 作业结局的映射与 zvec-grep 共用 shared 那一份（口径抄的是宿主 bash 工具）。
import { jobOutcomeOf } from "@jayyuen66/dsh-plugin-shared/lib/job-outcome";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
// 共享 webServer 样板：sendJson/isCrossOrigin/guardBody（跨域 + CSRF + 字节级
// body 上限）与 session-rescue/lesson-loop/zvec-grep 统一由 shared 提供。
import { sendJson, guardBody } from "@jayyuen66/dsh-plugin-shared/lib/http";
// 信任闸门：四条路由 handler 的第一条语句。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
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
import { assertToolOutput, redactKeyMaterial } from "./lib/output.ts";
import {
  buildReviewCommand,
  buildScanCommand,
  wrapWithHostReaper,
  buildDelegatePreviewCommand,
  buildDelegateRuleCommand,
  buildSessionCommand,
  buildLlmTestCommand,
  withHomeEnv,
  describeValue,
  resolveRoot,
} from "./lib/cli.ts";
import { clampEffort } from "./lib/argv-guard.ts";
import {
  parseReviewOutput,
  parseDelegatePreview,
  parseDelegateRules,
  summarizeReview,
} from "./lib/parse.ts";
import { ROUTING_NAME, ROUTING_ORDER } from "./lib/routing.ts";
import {
  providersForCard,
  applyProviderSelection,
  migratePlaintextKeys,
  resolveOcrConfigPath,
  ocrHomeOverride,
} from "./lib/ocr-config.ts";
// provider 清单的来源层与外部 config.json 的落点层各自成模块（判据分家，见那两个文件的头
// 注释）：命名空间常量在 lib/provider-source.ts，脚本落点在 lib/config-store.ts。
import { PI_AI_NAMESPACE } from "./lib/provider-source.ts";
import { defaultCredScriptPath } from "./lib/config-store.ts";
import type { DshConfigGateway, ProviderDescriptor } from "./lib/provider-source.ts";
import type { OcrPaths } from "./lib/config-store.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

// 官方给生产者的 kind 扩展点（installed dsh-jobs/lib/types/view.d.ts 的 JobKindMap，
// dsh-tool-pwsh / dsh-tool-workflow 同款写法）：kind 既是命名空间也是 id 前缀。
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "ocr-review": "ocr-review";
  }
}

// ── 常量 ────────────────────────────────────────────────────────────────────

// 设置命名空间不再由本包持有：0.1.7 隐式注册后 ns = profile 条目 id（`ocr-review`，
// 见 cordis.patch.yml），可编辑字段由 `Config` 上的 `.volatile()` 声明（见下文）。

const PLUGIN_DIR = import.meta.dirname;
// 前台超时语义（宿主 shell = bash-local）：resolve 以
// clampTimeout(请求, timeoutMs, maxTimeoutMs) = min(请求 ?? 120s, maxTimeoutMs) 收口，
// maxTimeoutMs 由 settings.yaml `shell:` 段配置（缺省 600000=10 分钟）。foreground
// 不存在"不限时"：本插件 0/未设置 = 请求宿主上限（下发本常量，被 clamp 到
// maxTimeoutMs）；后台通道（wait=false）不给进程挂宿主 deadline（resolve 里显式带
// onExpiry:"none"，0.1.7 缺省是 'kill'），但本包给它加了 OCR_BACKGROUND_MAX_MS 那一档
// 兜底回收——所以"真不限时"这句在文案里也不许再写（连卡片与工具参数说明都钉住了）。
// 2^31-1 = 宿主 timer 上限。
const MAX_TIMEOUT_REQUEST_MS = 2_147_483_647;
const LLM_TEST_TIMEOUT_MS = 90_000;
const STDOUT_MAX_BYTES = 400_000;
/** 解析失败时回显给模型的原始内容长度上限（UTF-16 码元；已脱敏）。
 *  单位写码元而不是"字符"：本常量喂给 `echoRaw`→`truncateEnd`，那一刀按码元数计
 *  （一张 emoji = 2 枚），写"字符"会把给模型的说明夸大约一倍。 */
const RAW_ECHO_LIMIT = 500;
const BODY_MAX_BYTES = 8 * 1024;
/** 评论截断条数的内置默认（旧 BUILTIN_BASE 的那一项）：schema 的 `.default()` 与
 *  「读到坏值时的回退」（readMaxComments）共用这一个数，两处不许各写一份字面量。 */
const MAX_COMMENTS_DEFAULT = 12;
/** 会话内 CSRF token 头名（与 lesson-loop/zvec-grep 同族命名）。 */
const OCR_CSRF_HEADER = "x-ocr-csrf";

const PROVIDERS_PATH = "/_dsh/ocr-review/providers";
const SELECT_PATH = "/_dsh/ocr-review/select";
const MIGRATE_PATH = "/_dsh/ocr-review/migrate";
const TEST_PATH = "/_dsh/ocr-review/test";

// ── 宿主服务面（运行时由 ctx 注入，一律 type-only）──────────────────────────
// 工具面（`ToolRuntime` 的成员面 + ToolRunContext / ToolOutputDefinition / JsonSchemaNode）
// 与 shell / webServer / systemPrompt 三面都已绑 `@deepseek-ai/*` 官方声明，本文件不再
// 手抄它们的形状：字段可选性过去是「一律对齐 harness 声明」的手工纪律
// （packages/shell/shell/src/types.ts、packages/subprocess/subprocess/src/types.ts），
// 现在由 `Pick` 保证——官方把必有字段改成可选、或给载荷添一个必填字段，这里立刻是编译错误，
// 而不是调用点静默放过 undefined。
//
// 四个官方服务面都是 `Service` 子类（`ShellExecutor` 还是 abstract）：基类的 protected
// `ctx` 加各自的 private 字段（WebServer 的 exact/prefixes/…，SystemPrompt 的 layers，
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
 *  可选，由实现方按 settings.yaml 的 `shell:` 段填默认并 clamp），`execute` 只收 `resolve`
 *  交回的已解析 `ShellExecSpec`。0.1.7 唯一的执行入口：前台 await 句柄的 result()（仅基础
 *  设施故障才 reject），后台直接留句柄不等运行结束；组合 teardown 时仍在运行的进程由宿主
 *  接管清理。`onExpiry` 缺省 'kill'，后台任务显式传 'none' 才取到无界。
 *  句柄的 done 在进程关闭时落定且从不 reject；kill() 幂等，已退出时返回 false。 */
export type ShellService = Pick<ShellExecutor, "resolve" | "execute">;

/**
 * 官方 JobRegistry（@deepseek-ai/dsh-jobs，abstract Service + protected ctx → 名义比较）
 * 的方法面投影：本包用这五位，缺一位都跑不通——
 *  - `start`：把后台评审的子进程登记成作业（`kind: "ocr-review"` ⇒ id `ocr-review-N`）；
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

/** 官方注册表里本包作业的 kind；宿主据此签发的 id 形如 `ocr-review-N`。 */
const OCR_JOB_KIND = "ocr-review";

/**
 * 本 kind 在注册表里的**已落定**记录上限。同时能跑几个不在这里——那是注册表的容量闸
 * （实测未拥有桶 10，满员是**拒绝**新 start，不是淘汰旧的）。
 */
const OCR_JOB_HISTORY_MAX = 10;

/**
 * 后台评审的兜底上限。本包刻意不套宿主 timeoutMs（`onExpiry: "none"`：外部 CLI 的正常
 * 时长跨度太大，套了就等于替用户砍掉长评审），但换装后"完全没有终点"有了新的受害者——
 * 未拥有作业共用一只 10 格的桶（实测 `running` 与 `stopping` 都计数，满员是**拒绝**
 * 后来的 start），一条挂死的 CLI 会永久占一格，连别的插件也起不来。2 小时远超正常评审，
 * 到点经注册表收：记录推到 stopping，理由落进模型可见的 detail。
 */
const OCR_BACKGROUND_MAX_MS = 120 * 60_000;

/** "仍在跑"的两枚官方状态：`stopping` 是取消已发出、进程还没收完。 */
function isLiveOcrStatus(status: JobStatus): boolean {
  return status === "running" || status === "stopping";
}

/**
 * 剪掉本 kind 最老的已落定记录，给下一次登记腾出窗口（注册表按登记序返回，故取头部）。
 * 在跑与正在收的一条不动：官方件对活作业的 remove 直接抛，而"静默杀掉用户发起的评审"
 * 正是这次换装要消灭的形态。
 * @param jobs 官方注册表
 * @returns {void}
 */
function pruneOcrJobHistory(jobs: JobsService): void {
  const settled = jobs
    .list()
    .filter((job) => job.kind === OCR_JOB_KIND && !isLiveOcrStatus(job.status));
  // 剪到 MAX-1 而不是 MAX：这一趟在 `start` **之前**跑，起完就是 MAX 条。按 MAX 剪等于
  // 每次登记后窗口里都是 MAX+1 条，而文案与卡片说的是"保留最近 MAX 条"（差的那一格
  // 复核时记过账，修的是剪枝边界而不是把 MAX 改成 11）。
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
 * @returns 等完这一条的兜底窗口；抛错一律就地收敛（记录没了就等于无事可做）
 */
async function enforceOcrDeadline(
  jobs: JobsService,
  id: JobId,
  reason: string,
  backgroundMaxMs: number,
): Promise<void> {
  try {
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

/** webServer 的 `register` 方法面投影：载荷绑官方 `WebRoute`，`kind` 因此是
 *  `WebRouteKind`（"exact" | "prefix"）而不是自由字符串——kind 写错在注册期只会表现为
 *  一条永不命中的路由或撞名抛错，绑上去就提前到编译期。handler 的 req/res 取的就是
 *  官方那一份（node:http，见文件头的 type-only import）。 */
type WebServerService = Pick<WebServer, "register" | "host">;

/** 0.1.7 的 settings 面（packages/settings/settings/src/index.ts 的 SettingsForms）：
 *  `register(ns, schema, { base })` 与 `get(ns)` 都已删除——命名空间由宿主按导出的
 *  `Config` 隐式投影，插件侧只剩两件事：登记本页的页面策略、跨命名空间读。 */
/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations`
 * → 名义比较）的方法面投影：本包只用 `configure`（页面策略）与 `describe`（跨命名空间读）。
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
 * ctx.credentials 在本包用到的面（credentials/src/index.ts:183-191）。
 * 官方签名收的是品牌类型 CredentialRef；credentialRef() 只做「语法校验 + 编译期
 * brand」，运行时值就是字符串（credentials-local 的 resolve/describe 直接拿它当
 * Map 键，index.ts:617-639），所以这里按 string 收参并在调用前用官方语法自行校验，
 * 换掉一次值导入（见文件头：服务面 cordis/dsh-settings/dsh-tools 等仍一律 type-only，
 * 值导入的只有宿主 fork 的 schemastery 与凭据包的两枚 branded-string 语法件）。
 * 返回形状仍绑官方类型。
 */
/**
 * 官方凭据服务（installed `@deepseek-ai/dsh-credentials/lib/types/index.d.ts:99` 的
 * `Context.credentials: CredentialProvider`）的方法面投影：本包只 `describe`（探一眼
 * 记录种类）与 `resolve`（取值）。返回值 `CredentialInfo` / `ResolvedCredential` 原本
 * 就已绑官方，两位**方法签名**改由官方成员交出，不再本地裁定入参与可选性。
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
   *  本地不再重述一枚 `get`。本包读的 `webServer` / `settings` / `credentials` 三个名字**都**是
   *  官方声明进 `Context` 的成员（installed `@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:15-18`、
   *  `@deepseek-ai/dsh-settings/lib/types/index.d.ts:24-29`、
   *  `@deepseek-ai/dsh-credentials/lib/types/index.d.ts:98-102`），故全部走泛型臂拿到
   *  `undefined | 官方服务类`，**不走**那条 `get(name: string): any` 兜底（reflect.d.ts:17）。
   *  旧镜像尾臂 `(name: string): unknown` 是「还会读别的名字」的占位，实际没有——删它不减防御，
   *  少的是一个人人都能塞名字的自由入口。
   *  返回整类而不是本包的 `Pick` 投影也不是加宽：投影留在**使用点**上（`registerConfigEndpoints`
   *  的显式标注、`createGateway` 里那两个 `usableService` 的返回类型）。
   *  `undefined` 是官方语义（"or `undefined` when not (yet) provided"）：base bundle 未装配
   *  （非 web profile / 精简 profile）时宿主确实交不出服务，下面三处运行时闸照旧。 */
  get: Context["get"];
}

/** 服务面校验：对象存在且声明的方法全部可调用。
 *  只做 `typeof value["shell"] === "object"` 的话，守卫声称的是「有 shell 服务」
 *  而实际证明的只是「有个对象」——运行到一半才炸。逐个点名方法，守卫才名副其实
 *  （HostCtx 用到的每个方法都在这里被验证过一遍）。 */
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      return false;
    }
  }
  return true;
}

/** host 是否为本插件所需服务面（settings/shell/tools/systemPrompt/get/inject 及
 *  其上要调用的方法）。守卫仅压缩类型面、避开 `as unknown as HostCtx` 断言。
 *  settings 这里点名的两个方法都会被调用：configure 登记本页的页面策略、describe
 *  跨命名空间读（provider 清单 + 官方 locale 偏好）；inject 挂那条页面策略的 effect。
 *  0.1.7 起 settings 再无 register/get，多点名一个就是永不成立的死分支。 */
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

/** describe() 行里按命名空间取解析值（0.1.7 的跨命名空间读只有 describe() 一条路：
 *  `settings.get(ns)` 已删）。未注册该命名空间 → undefined，调用侧按默认值降级。
 *  @param rows - `ctx.settings.describe()` 的返回（全部条目的表单投影）。
 *  @param ns - 要读的命名空间（官方字段名是 `ns`，上游有改名 namespace 的 TODO）。
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
  required: ["started", "mode", "tool", "repo", "processStatus", "polling"],
  properties: {
    started: { type: "boolean", const: true },
    mode: { type: "string", const: "background" },
    tool: { type: "string" },
    repo: { type: "string" },
    // ShellProcessStatus（dsh-shell）：注册表收尾后进程的落定态只有这三种。
    processStatus: { type: "string", enum: ["running", "completed", "killed"] },
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
    "sessionId",
    "aggregation",
    "totalCommentCount",
    "droppedCount",
    "invalidCommentCount",
    "topComments",
    "warnings",
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
    sessionId: NULLABLE_STRING,
    aggregation: {
      type: "object",
      additionalProperties: false,
      required: ["total", "bySeverity", "byCategory"],
      properties: {
        total: { type: "integer" },
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
}

/** 前台执行：失败抛错（含给模型的行动提示），成功返回 stdout 文本。
 * timeoutMs 恒有值（tuningOf(config)），宿主按 min(请求, shell.maxTimeoutMs) 收口。
 * signal 必传：harness ToolExecution.signal 是必填的调用方取消权。 */
async function runForeground(
  host: HostCtx,
  command: string,
  workdir: string,
  run: RunTuning,
  signal: AbortSignal,
): Promise<string> {
  const messages = localeMessages(host);
  const spec = host.shell.resolve({
    command,
    workdir,
    timeoutMs: run.timeoutMs,
    stdoutMaxBytes: run.stdoutMaxBytes,
    signal,
  });
  const exec = await host.shell.execute(spec);
  const result = await exec.result();
  const failed = result.exitCode !== 0 || result.timedOut || result.aborted;
  if (failed) {
    if (result.timedOut) {
      const minutes = Math.round(run.timeoutMs / 60_000);
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
  if (truncated) {
    const spill =
      typeof spillPath === "string" ? format(messages.outputSpill, { path: spillPath }) : "";
    // 原文照抄在前、截断说明在后（位置不变，只换说明文案）。
    return `${text}\n${format(messages.stdoutTruncated, {
      limit: String(run.stdoutMaxBytes),
      spill,
    })}`;
  }
  return text;
}

/** 后台任务描述（>5 参数会撞 max-params，收成对象）。 */
interface BackgroundJob {
  command: string;
  workdir: string;
  tool: string;
  repo: string;
  /** 执行器 stdout 缓冲上限（entry config `stdoutMaxBytes`，与前台同一字段）。 */
  stdoutMaxBytes: number;
  /** 兜底回收窗口（entry config `ocrBackgroundMaxMs`，判据见 OCR_BACKGROUND_MAX_MS）。 */
  backgroundMaxMs: number;
}

/**
 * 终止 OCR 进程，忽略"已经没有必要杀"的那一类异常（进程自然退出、已被注册表或宿主回收）。
 *
 * 这层兜不是风格：官方契约明写生产者的 `cancel` 会往上抛（installed
 * `dsh-jobs/lib/types/types.d.ts:98-102` "throws propagate"），而 `killJob` 裸调
 * `job.cancel(reason)`、只有 teardown 那一臂逐条 try/catch（同包 `lib/index.js:611-622`
 * 对照 `:805-824`）。本包的 `cancel` 是从 `AbortSignal` 监听器里被回调的，Node 对监听器
 * 抛出的处理是 `process.nextTick(() => { throw err })` ⇒ **未捕获异常、宿主进程退出**
 * （本机实跑复现）。一次取消杀掉整个 dsh 不是可接受的失败形态。
 */
function killProc(proc: ShellExecution): void {
  try {
    proc.kill();
  } catch {
    // 忽略：见上。
  }
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

/** 子进程落定后摘掉 abort 监听：fire-and-forget 的一臂，等的是收尾而不是启动。 */
async function detachWhenSettled(proc: ShellExecution, detach: () => void): Promise<void> {
  await proc.done;
  detach();
}

/** 后台启动回执（模型侧契约：wait=false 时 ocr_review/ocr_scan 的 canonical 返回值）。 */
interface BackgroundReceipt {
  started: true;
  mode: "background";
  tool: string;
  repo: string;
  processStatus: ShellProcessStatus;
  polling: string;
}

/**
 * 后台启动：resolve 显式带 `onExpiry: "none"`，故不套宿主 deadline（0.1.7 起
 * bash-local 缺省是 'kill'，不传就会被缺省 timeoutMs 杀掉），启动准备完成即返回，不等
 * 运行结束、不写 --output。结果以 OCR 会话记录为准（增量落盘），由模型经
 * ocr_session 工具轮询。dsh 无论优雅退出（teardown 组 TERM→KILL）还是硬退出
 * （kill -9/崩溃后被 launchd 收养），命令里的宿主回收守护（cli.ts
 * wrapWithHostReaper）都会把 OCR 一并结束，不留孤儿进程烧 token。
 *
 * 那次子进程现在同时是一枚**官方作业**（kind `ocr-review`）：官方 `job_list` /
 * `job_output` / `job_kill` 从此看得见它，本包不再需要为"起完就没人管"负责。
 * 工具的返回值是下面的结构化回执对象（canonical 值直返；作业面换装只动了"谁能看见
 * 并停掉它"，这份回执的内容自此未变——变的只是不再包一层 `{ text }` 字符串）。
 *
 * 取消语义（此前句柄被直接丢弃 → 工具调用被中止后外部 CLI 仍在跑）：
 *  - spec 带 signal：取消落在「启动准备阶段」时由宿主直接拒绝启动；
 *  - 已拿到句柄后 abort：经注册表 `kill(id, undefined, reason)` 收，它把记录推到
 *   stopping、把 reason 落进 detail，再回调本包的 `cancel()` 去杀进程；
 *  - 进程自然落定（done 永不 reject）后摘掉 abort 监听，不在长会话里堆监听器。
 * `kill` 的 reason 只在这一处带：注册表在 killed 时会把同一个 reason 追加进 detail，
 * 生产者的 `done` 结局再带一遍就是把同一句写两遍（`jobOutcomeOf` 因此刻意不带）。
 *
 * @param host 宿主服务面
 * @param job 这次后台评审的描述
 * @param signal 工具调用的中止信号
 * @returns 后台启动回执（canonical 对象，模型侧契约）
 */
async function startBackground(
  host: HostCtx,
  job: BackgroundJob,
  signal: AbortSignal,
): Promise<BackgroundReceipt> {
  const registry: JobsService | undefined = host.get("jobs");
  if (registry === undefined) {
    // 没有注册表就不起进程：本包不再自带一张作业表，"起了但谁也看不见、谁也停不掉"
    // 正是这次换装要消灭的形态。前台（wait:true）路径不受影响。
    throw new Error(
      "background review unavailable: the host provides no ctx.jobs (load @deepseek-ai/dsh-jobs-local); run it with wait:true instead",
    );
  }
  const spec = host.shell.resolve({
    command: job.command,
    workdir: job.workdir,
    onExpiry: "none",
    stdoutMaxBytes: job.stdoutMaxBytes,
    signal,
  });
  const proc = await host.shell.execute(spec);
  // 先剪窗口再起：注册表的容量闸只管"活的"，已落定的旧记录只有我们 remove 才会消失。
  pruneOcrJobHistory(registry);
  const messages = localeMessages(host);
  let jobId: JobId;
  try {
    jobId = startUnderOcrController(registry, {
      kind: OCR_JOB_KIND,
      label: `${job.tool} ${job.repo}`,
      output: reviewSources(proc, messages),
      run: () => ({
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
  // 兜底 deadline（时长来自 entry config，判据见 OCR_BACKGROUND_MAX_MS）。
  void enforceOcrDeadline(registry, jobId, messages.jobReasonTimeout, job.backgroundMaxMs);
  const stop = (): void => {
    // 监听器里不许抛（判据见 `killProc`）：注册表被重载/关掉时它对陌生 id 抛
    // `unknown job ...`（installed dsh-jobs-local/lib/index.js:554-558 的 `expect`），
    // 那一刻进程还在收尾、监听器还挂着。这一臂兜住它，然后退化成只收我们手里的进程。
    try {
      registry.kill(jobId, undefined, messages.jobReasonAborted);
    } catch {
      killProc(proc);
    }
  };
  const detach = (): void => {
    signal.removeEventListener("abort", stop);
  };
  if (signal.aborted) {
    stop();
  } else {
    signal.addEventListener("abort", stop, { once: true });
    void detachWhenSettled(proc, detach);
  }
  return {
    started: true,
    mode: "background",
    tool: job.tool,
    repo: job.repo,
    processStatus: proc.status,
    polling: messages.backgroundPolling,
  };
}

/** 只收集不抛错（llm test 等需要展示原始失败的命令）。输出必先脱敏（直通卡片）。 */
async function runCollect(
  host: HostCtx,
  command: string,
  workdir: string,
  run: RunTuning,
): Promise<{ exitCode: number | null; output: string }> {
  const spec = host.shell.resolve({
    command,
    workdir,
    timeoutMs: run.timeoutMs,
    stdoutMaxBytes: run.stdoutMaxBytes,
  });
  const exec = await host.shell.execute(spec);
  const result = await exec.result();
  const joined =
    result.stdout.text === "" || result.stderr.text === ""
      ? result.stdout.text + result.stderr.text
      : `${result.stdout.text}\n${result.stderr.text}`;
  return { exitCode: result.exitCode, output: truncateEnd(redactKeyMaterial(joined), 8000) };
}

// ── 设置读取 ────────────────────────────────────────────────────────────────
// 0.1.7：`settings.register()` 交回的 scope.get() 没了，cordis 直接把按 `Config`
// 校验并填过默认的那份 config 交进 apply，其中 volatile 字段是 **引用**——每读一次
// 取一次当前值，所以设置卡改完下一次工具调用/端点请求即生效（语义同旧 scope.get()）。
// 引用背后的类型由 schema 保证，但**不保证它是唯一写入者**（profile 补丁里的裸 YAML
// 手改同样进得来），故下面每个读数仍按 unknown 复核形态再落回安全默认。

function readEffort(config: Config): "low" | "medium" | "high" {
  const raw: unknown = config.effort.get();
  return raw === "low" || raw === "high" ? raw : "medium";
}

function readLanguage(config: Config): string | undefined {
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

/** 一次前台执行的两枚部署值：墙钟每次现读（`timeoutMinutes` 是 volatile 设置项），
 *  stdout 上限取 entry config（非 volatile，装载期定值）。 */
function tuningOf(config: Config): RunTuning {
  return { timeoutMs: readTimeoutMinutes(config), stdoutMaxBytes: config.stdoutMaxBytes };
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

// ── 设置端点辅助（sendJson/isCrossOrigin/guardBody 样板由 shared 提供）──────

/** body 文本 → JSON 对象（空 body = {}；非对象抛错）。 */
export function parseJsonBody(text: string, messages: OcrReviewMessages): Record<string, unknown> {
  if (text.trim() === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(messages.bodyMustBeObject);
  }
  return parsed;
}

/**
 * POST 端点统一前置：405 → 跨域 → CSRF → body 上限（shared.guardBody）。
 *
 * 此前只有 sec-fetch-site（curl/本地进程可伪造头，且空头直通），而写端点会改
 * ~/.opencodereview/config.json；/migrate 与 /test 甚至从不读 body——keep-alive
 * 连接上未读尽的请求体会把残余字节留给后续响应，且超限请求可以一直占内存。
 * 返回 null 表示已就地响应，调用方必须立即返回。
 */
async function guardPost(
  req: IncomingMessage,
  res: ServerResponse,
  csrf: string,
): Promise<string | null> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "POST only" });
    return null;
  }
  const read = await guardBody(req, res, {
    maxBytes: BODY_MAX_BYTES,
    csrf: { token: csrf, headerName: OCR_CSRF_HEADER },
  });
  return read;
}

/** 原始输出回显给模型/卡片前的两道收口：截断 + 明文 key 脱敏。 */
function echoRaw(text: string, limit: number): string {
  return redactKeyMaterial(truncateEnd(text, limit));
}

/** 读 --output 落盘结果。OCR exit 0 却没写出文件（版本漂移/被中途 kill）时给
 *  可行动的错误，而不是把裸 ENOENT 栈丢给模型。 */
function readOutFile(outPath: string, messages: OcrReviewMessages): string {
  try {
    return readFileSync(outPath, "utf8");
  } catch (error) {
    throw new Error(
      format(messages.outputFileMissing, { path: outPath, cause: errorText(error) }),
      { cause: error },
    );
  }
}

// ── 插件体 ─────────────────────────────────────────────────────────────────

/**
 * OCR 原生数值参数的 tool schema 片段（忠实透传语义，桥接层不设钳制）。
 * unit 区分 review（每组）/ scan（每文件）的措辞（取消息表的 unitGroup/unitFile，
 * 语言随设置页偏好走）；OCR 侧语义见 shared_flags.go:52-58 与 scan_cmd.go:231-236。
 */
function tuningParams(messages: OcrReviewMessages, unit: string): Record<string, unknown> {
  const of = (template: string): { type: "integer"; description: string } => ({
    type: "integer",
    description: format(template, { unit }),
  });
  return {
    concurrency: of(messages.tuningConcurrency),
    timeoutMinutes: of(messages.tuningTimeout),
    maxTools: of(messages.tuningMaxTools),
    maxTokens: of(messages.tuningMaxTokens),
    maxTokensBudget: {
      type: "integer",
      description: messages.tuningMaxTokensBudget,
    },
  };
}

/** 本包设置项（0.1.7 隐式注册）。行级 config 由 cordis 按导出的 `Config` schema
 *  校验并填默认后交进 apply，优先级：设置卡运行时值 > 行 config > schema 默认。
 *  命名空间不再是本包持有的字符串：宿主按 `.volatile()` 投影表单，ns = profile 条目
 *  id（`ocr-review`，见 cordis.patch.yml）；0.1.6 那份 `settings.register(ns, schema,
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
  /** 后台评审的兜底回收窗口（毫秒）：`jobs.wait` 到点即 kill 在跑的作业。 */
  ocrBackgroundMaxMs: number;
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
  // 三个部署级调优值。默认与上面的常量同值（行为冻结），min(1) 挡掉 0 ——
  // 0 会让 resolve 收到「零毫秒 deadline」、兜底窗口归零，比不给配置更糟。
  llmTestTimeoutMs: Schema.natural().min(1).default(LLM_TEST_TIMEOUT_MS),
  ocrBackgroundMaxMs: Schema.natural().min(1).default(OCR_BACKGROUND_MAX_MS),
  stdoutMaxBytes: Schema.natural().min(1).default(STDOUT_MAX_BYTES),
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

/** 运行 ocr llm test 校验当前配置（select 后自动验证 / 手动测试共用）。
 *  命令词与五个工具同一解析源（buildLlmTestCommand：随包 launcher 装法下 PATH 上
 *  没有裸 `ocr`），HOME 随 ocrConfigPath 重定向。墙钟与输出上限都是 entry config
 *  字段（非 volatile，改值随重启生效）。 */
async function runLlmTest(host: HostCtx, config: Config): Promise<{ ok: boolean; output: string }> {
  const { exitCode, output } = await runCollect(
    host,
    withHomeEnv(buildLlmTestCommand(), ocrHome(config)),
    process.env["HOME"] ?? "/",
    { timeoutMs: config.llmTestTimeoutMs, stdoutMaxBytes: config.stdoutMaxBytes },
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

/** wait 入参闸：undefined → true（前台缺省）；布尔透传；其余类型抛错——字符串
 *  "false" 若被 `!== false` 当真值处理会静默从后台变前台，吞掉用户的等待语义。 */
function waitOf(value: unknown, messages: OcrReviewMessages): boolean {
  if (value === undefined || value === null) {
    return true;
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
    credentialResolvable: async (envKey: string): Promise<boolean> => {
      const svc = credentialsService();
      if (svc === undefined || !isCredentialRefName(envKey)) {
        return false;
      }
      try {
        const resolved = await svc.resolve(credentialRef(envKey));
        return resolved !== undefined && resolved.value.length > 0;
      } catch {
        // 同上：resolve 抛错按「不可解析」处理，应用面据此拒绝而不是外抛。
        return false;
      }
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

/** select 端点过了 trust 闸门与 guardPost 之后那一段的依赖（对象化以受 max-params 约束）。 */
interface SelectEndpointDeps {
  config: Config;
  gateway: DshConfigGateway;
  host: HostCtx;
  messages: () => OcrReviewMessages;
}

/** POST select 的响应：把 body 里的 provider/model 应用到 OCR 配置，按需附带 llm test 回执。 */
async function sendSelectResponse(
  text: string,
  res: ServerResponse,
  deps: SelectEndpointDeps,
): Promise<void> {
  const msgs = deps.messages();
  let body: Record<string, unknown>;
  try {
    body = parseJsonBody(text, msgs);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: format(msgs.bodyParseFailed, { message: errorText(error) }),
    });
    return;
  }
  const provider = typeof body["provider"] === "string" ? body["provider"] : "";
  const model = typeof body["model"] === "string" ? body["model"] : "";
  if (provider === "" || model === "") {
    sendJson(res, 400, { ok: false, error: msgs.providerModelRequired });
    return;
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
    sendJson(res, 200, { ok: true, applied, llmTest });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorText(error) });
  }
}

/** 注册 webServer 配置端点（卡片专用：providers/select/migrate/test）。
 *  csrf 为每次 apply 生成的会话内 token：GET providers 下发、三个写端点回填
 *  校验（sec-fetch-site 只挡浏览器，挡不住能构造请求头的本地进程）。
 *  ctx 只用来挂释放器，给的是 `inject(["webServer"])` 子 fiber 的上下文。 */
export function registerConfigEndpoints(
  ctx: Pick<Context, "effect">,
  host: HostCtx,
  config: Config,
  csrf: string,
): void {
  // 官方 `Context["get"]` 交出整个 `WebServer` 类；这里显式收回本包的方法面投影，
  // 于是「只用 register」仍是编译期约束（误用别的成员即报错），不必再镜像一次签名。
  const webServer: WebServerService | undefined = host.get("webServer");
  if (!webServer) {
    // 无 webServer 服务（未起 web 组合）→ 卡片不可用，工具与设置照常。
    return;
  }
  // 非回环服务面唯一的可读信号（installed dsh-host-webserver d.ts `:50`/`:83`）。
  const servingNonLoopback = webServer.host === "0.0.0.0";
  const gateway = createGateway(host);
  // 端点回执是给人看的：每个请求现取一份文案（用户在「设置 → 常规」换语言后，
  // 下一次请求即换新文案，不必重启）。
  const messages = (): OcrReviewMessages => localeMessages(host);

  // GET providers：设置页数据（无 key 明文）+ csrf token。
  const disposeProviders = webServer.register({
    kind: "exact",
    path: PROVIDERS_PATH,
    handler: async (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      // 闸门之后这一段本包的 isCrossOrigin 已不可达（trust 的 sec-fetch-site 白名单更严、
      // 且给出同一句错误文本），留着它就是一条永不被执行的分支 ⇒ 删。既有那条
      // 「跨源 403」用例仍然通过：拒它的换成了 trust，文案一字不差。
      try {
        const msgs = messages();
        const payload = await providersForCard(gateway, pluginPaths(config, msgs), msgs);
        sendJson(res, 200, { ...payload, csrf });
      } catch (error) {
        // 装配期之后的意外（设置项里的路径不合法、宿主服务抛错）也要回可读 JSON：
        // 卡片读的是 error 文本，让它卡在「加载 providers…」比让它报错更难排查。
        sendJson(res, 500, { ok: false, error: errorText(error) });
      }
    },
  });

  // POST select：把 provider/model 应用到 OCR 配置（api_key_cmd 动态读 key）。
  const disposeSelect = webServer.register({
    kind: "exact",
    path: SELECT_PATH,
    handler: async (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      const text = await guardPost(req, res, csrf);
      if (text === null) {
        return;
      }
      await sendSelectResponse(text, res, { config, gateway, host, messages });
    },
  });

  // POST migrate：明文 api_key → api_key_cmd 一键迁移。
  const disposeMigrate = webServer.register({
    kind: "exact",
    path: MIGRATE_PATH,
    handler: async (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      const text = await guardPost(req, res, csrf);
      if (text === null) {
        return;
      }
      try {
        const msgs = messages();
        const result = await migratePlaintextKeys(gateway, pluginPaths(config, msgs), msgs);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        // 坏 config.json / settings 读不到都会抛（写侧 fail-loud），必须回 JSON
        // 错误而不是让请求挂到 webserver 兜底——卡片要能读出「为什么没迁移」。
        sendJson(res, 400, { ok: false, error: errorText(error) });
      }
    },
  });

  // POST test：手动触发 ocr llm test。
  const disposeTest = webServer.register({
    kind: "exact",
    path: TEST_PATH,
    handler: async (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      const text = await guardPost(req, res, csrf);
      if (text === null) {
        return;
      }
      try {
        const llmTest = await runLlmTest(host, config);
        sendJson(res, 200, { ok: llmTest.ok, output: llmTest.output });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorText(error) });
      }
    },
  });

  // 四条路由的释放器必须自己收。官方 `register` 只做「查重 + 塞进路由表」并交回一枚
  // **必须调用**的 disposer（installed dsh-host-webserver/lib/index.js:172-183），而路由表
  // 挂在宿主提供的 webServer 实例上，**不**随本插件 fiber 死。留着的两种后果：
  //  1. 热重载即坏：旧 fiber dispose 完路由原封不动，新 apply 再注册同一路径 ⇒ 官方件当场抛
  //     `webserver: duplicate exact route "..."`（DSH_HOT_RELOAD=1 下改本文件任意一行）。
  //  2. 禁用/卸载后端点仍可达：四条路由继续经那枚已死 fiber 的闭包写
  //     ~/.opencodereview/config.json、起 `ocr llm test` 进程。
  // 挂在注入子 fiber 的效应上（而不是 apply 的 ctx）：webServer 换实例时子 fiber 先卸后装
  // （cordis registry.d.ts:97），释放器因此也覆盖「服务重启后重新注册」这一档。
  ctx.effect(
    () => () => {
      disposeProviders();
      disposeSelect();
      disposeMigrate();
      disposeTest();
    },
    "ocr-review: config endpoints",
  );
}

// ── 5 个工具各自的注册函数（apply 只做编排，否则单个函数会长过
//    max-lines-per-function 上限）────────────────────────────────────────────

function registerReviewTool(host: HostCtx, config: Config): void {
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
        ...tuningParams(msgs, msgs.unitGroup),
        wait: { type: "boolean", description: msgs.paramWait },
        provider: { type: "string", description: msgs.paramProvider },
        model: { type: "string", description: msgs.paramModel },
        resume: { type: "string", description: msgs.paramResume },
      },
    },
    schema: REVIEW_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      const repo = ocrRepo(args, exec, runMsgs);
      // effort 未显式传入时取设置卡默认（effortOf 内做类型闸与白名单钳制）。
      const eff = effortOf(args["effort"], config, runMsgs);
      // wait=false = 后台：无 tmp、无 --output，结果以会话记录为准（ocr_session 轮询）。
      const wait = waitOf(args["wait"], runMsgs);
      // 评审可能是长任务：临时目录落盘 --output，避免宿主 stdout 截断丢评论。
      const tmp = wait ? mkdtempSync(path.join(tmpdir(), "ocr-review-")) : undefined;
      const outPath = tmp === undefined ? undefined : path.join(tmp, "out.json");
      // ocrConfigPath 自定义时的 HOME 重定向（withHomeEnv 内部对 undefined/win32
      // 原样放行）。先注环境再套回收守护：守护把整条命令 shq 进 bash -c，前缀必须在最内层。
      const homeOverride = ocrHome(config);
      try {
        const { command, workdir } = buildReviewCommand(
          { ...args, repo, effort: eff },
          outPath,
          runMsgs,
        );
        // 分钟级长任务：套宿主回收守护，dsh 任何方式退出（含 kill -9 后 launchd
        // 收养）OCR 进程都会被 TERM→1s→KILL，不留孤儿烧 token（lib/cli.ts）。
        const guarded = wrapWithHostReaper(withHomeEnv(command, homeOverride));
        if (outPath === undefined) {
          return await startBackground(
            host,
            {
              command: guarded,
              workdir,
              tool: "ocr_review",
              repo,
              stdoutMaxBytes: config.stdoutMaxBytes,
              backgroundMaxMs: config.ocrBackgroundMaxMs,
            },
            exec.signal,
          );
        }
        await runForeground(host, guarded, workdir, tuningOf(config), exec.signal);
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
        return summarizeReview(parsed, runMsgs, { maxComments: readMaxComments(config) });
      } finally {
        if (tmp !== undefined) {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    },
  });
}

function registerScanTool(host: HostCtx, config: Config): void {
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
        // OCR scan 原生 --provider/--model（shared_flags.go:223-247 共享 flags），
        // 与 ocr_review 对齐。
        provider: { type: "string", description: msgs.paramProvider },
        model: { type: "string", description: msgs.paramModel },
        ...tuningParams(msgs, msgs.unitFile),
        wait: { type: "boolean", description: msgs.paramWait },
      },
    },
    schema: REVIEW_OUTPUT_SCHEMA,
    run: async (args, exec) => {
      const runMsgs = localeMessages(host);
      const repo = ocrRepo(args, exec, runMsgs);
      // wait=false = 后台：无 tmp、无 --output，结果以会话记录为准（ocr_session 轮询）。
      const wait = waitOf(args["wait"], runMsgs);
      const tmp = wait ? mkdtempSync(path.join(tmpdir(), "ocr-scan-")) : undefined;
      const outPath = tmp === undefined ? undefined : path.join(tmp, "out.json");
      // 同 ocr_review：先注 HOME 重定向再套守护（前缀必须在最内层）。
      const homeOverride = ocrHome(config);
      try {
        const { command, workdir } = buildScanCommand({ ...args, repo }, outPath, runMsgs);
        // 同 ocr_review：宿主回收守护（lib/cli.ts wrapWithHostReaper）。
        const guarded = wrapWithHostReaper(withHomeEnv(command, homeOverride));
        if (outPath === undefined) {
          return await startBackground(
            host,
            {
              command: guarded,
              workdir,
              tool: "ocr_scan",
              repo,
              stdoutMaxBytes: config.stdoutMaxBytes,
              backgroundMaxMs: config.ocrBackgroundMaxMs,
            },
            exec.signal,
          );
        }
        await runForeground(host, guarded, workdir, tuningOf(config), exec.signal);
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
        return summarizeReview(parsed, runMsgs, { maxComments: readMaxComments(config) });
      } finally {
        if (tmp !== undefined) {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    },
  });
}

function registerDelegatePreviewTool(host: HostCtx, config: Config): void {
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
      const repo = ocrRepo(args, exec, runMsgs);
      const homeOverride = ocrHome(config);
      const { command, workdir } = buildDelegatePreviewCommand({ ...args, repo }, runMsgs);
      const text = await runForeground(
        host,
        withHomeEnv(command, homeOverride),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      const parsed = parseDelegatePreview(text);
      if (!parsed.ok) {
        // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支）。
        return format(runMsgs.parseFailedPlain, {
          tool: "ocr delegate preview",
          limit: String(RAW_ECHO_LIMIT),
          raw: echoRaw(text, RAW_ECHO_LIMIT),
        });
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

function registerDelegateRuleTool(host: HostCtx, config: Config): void {
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
      const repo = ocrRepo(args, exec, runMsgs);
      const { command, workdir } = buildDelegateRuleCommand(
        { repo, paths: args["paths"] },
        runMsgs,
      );
      const text = await runForeground(
        host,
        withHomeEnv(command, ocrHome(config)),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      const parsed = parseDelegateRules(text);
      if (!parsed.ok) {
        // 解析失败分支的诚实值就是一段说明字符串（schema 的 string 分支）。
        return format(runMsgs.parseFailedPlain, {
          tool: "ocr delegate rule",
          limit: String(RAW_ECHO_LIMIT),
          raw: echoRaw(text, RAW_ECHO_LIMIT),
        });
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

function registerSessionTool(host: HostCtx, config: Config): void {
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
      const repo = ocrRepo(args, exec, runMsgs);
      const { command, workdir } = buildSessionCommand({ ...args, repo }, runMsgs);
      // session 也读 OCR 家目录（sessions 清单），随 ocrConfigPath 一并重定向。
      const text = await runForeground(
        host,
        withHomeEnv(command, ocrHome(config)),
        workdir,
        tuningOf(config),
        exec.signal,
      );
      // 无会话时 OCR 返回 JSON null → 转友好提示，避免模型困惑。
      const stripped = text.trim();
      const empty = stripped === "null" || stripped === "[]";
      // session 输出体量小，直接透传（含长度保护，避免假完整 + 明文 key 脱敏）。
      const capped =
        text.length > 12_000
          ? `${echoRaw(text, 11_900)}\n${runMsgs.sessionTruncated}`
          : redactKeyMaterial(text);
      // 对象直返（canonical value）；sessionOutput 保持一手透传字符串的诚实值。
      return {
        sessionOutput: empty ? runMsgs.sessionEmpty : capped,
        hint: runMsgs.sessionResumeHint,
      };
    },
  });
}

function apply(ctx: Context, config: Config): void {
  const host = resolveHost(ctx);
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
  // 0.1.7 起本包不再 `settings.register(...)`：宿主把导出的 `Config` 里标了
  // `.volatile()` 的字段隐式投影成设置表单（ns = profile 条目 id `ocr-review`），
  // 行 config 与默认值在装载期就已合并完，交下来的 `config` 就是运行时值。
  // 插件侧只剩页面策略这一件事：本包自带卡片，别让宿主再生成一份自动表单页。
  // owner 必须显式传本插件 fiber（缺省是 settings 服务自己的 fiber），且经
  // child.effect 挂载以便随注入子上下文回收——宿主 dsh-client-locale 同款写法。
  host.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, host.fiber));
  });

  registerReviewTool(host, config);
  registerScanTool(host, config);
  registerDelegatePreviewTool(host, config);
  registerDelegateRuleTool(host, config);
  registerSessionTool(host, config);

  // systemPrompt 路由段（正文是文案，随官方 locale 偏好走）。
  host.systemPrompt.section({
    name: ROUTING_NAME,
    order: ROUTING_ORDER,
    text: localeMessages(host).routingText,
  });

  // 卡片端点组（providers / select / migrate / test）。
  // ⚠ 必须对 webServer **建立依赖**，不能在 apply 里读一次：`ctx.get` 是无 inject 语义的
  // 存储读，官方注释就写着 "or `undefined` when not (**yet**) provided"（installed
  // @deepseek-ai/cordis/lib/types/reflect.d.ts:10-14）。真实宿主上 webServer 比本条目晚到位
  // （隔离 DSH_HOME 实测：apply 当场 get 返回 undefined，约 1s 后才交得出实例），旧写法的后果是
  // 四条端点在 web profile 上永不注册，卡片永远读不到 provider 清单。子 fiber 在依赖到位时
  // 才激活、依赖换实例时先卸后装（同文件 registry.d.ts:97）。不写进插件级 inject：那会让没有
  // webServer 的宿主（TUI）连 5 个工具与路由段一并失活。
  // 效应挂在**子上下文**上（第一个参数）：路由释放器随子 fiber 一起收，故 webServer 换实例、
  // 插件重载、插件卸载三种场合都不会把旧路由留在那里占住路径（详见该函数里的注释）。
  host.inject(["webServer"], (child) => {
    registerConfigEndpoints(child, host, config, randomUUID());
  });
}

export default {
  inject: ["settings", "shell", "tools", "systemPrompt"],
  Config: configSchema,
  apply,
};
