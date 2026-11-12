// lib/sandbox-policy.ts —— ocr 子进程的文件围栏：部署级开关 `ocrSandbox` 的落地层。
//
// 为什么单列一个模块：host.ts 贴着 max-lines 预算，而这段判据自成一件事——把「执行器自报的
// 沙箱模式」折成**按调用携带**的 `SandboxExecutionPolicy`，并在收窄时把 OCR 自己必须写的
// 目录补进 `additionalWritableRoots`。分支只有三条，但每一条的依据都来自宿主源码现量：
//
//   宿主 `ShellService` 报 `sandboxMode`（dsh-shell 的类型面；非沙箱执行器不报 ⇒ undefined）；
//   `bash-sandbox` 的 `resolve()` 把 `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`
//   逐字交给执行器，所以**调用方传入什么就按什么围栏**——这正是可收窄、也可放开的那一个口子。
//   `danger-full-access` 在 `bash-sandbox` 里直接走 super.execute（不受围栏），于是「放开」
//   与 0.1.14 起的既有行为逐字节相同，不需要另一条实现路径。
//
// 三档行为的边界（这是本模块的全部语义，也是 README/DETAIL 里那张表的来源）：
//   `full`（默认）：一律 `danger-full-access`，保持 0.1.14 起的既有行为；
//   `inherit` + 执行器不报模式（非沙箱执行器）或自报 `danger-full-access`：等效放开；
//   `inherit` + `workspace-write`：收窄到该档，并放行 OCR 的两条工作区外落点
//     ——`$HOME/.opencodereview`（config.json 与会话记录）与系统临时区（`--output` 临时文件、
//       session export 目录）；两个根都先「建出 + 折成真实绝对路径」再交下去，因为 enforcing
//       host 每次调用都会拒收不存在/不是目录/是软链的条目（拒收是整条 spawn 失败，不是降级）；
//   `inherit` + `read-only`：直接拒绝——OCR 连自己的会话记录都写不了，这一档下没有可用形态，
//       报错让用户换档（说清楚换成什么），而不是静默退回放开；
//   `inherit` + 认不出的新档：同样拒绝并点名那个值——比已知档更宽的新档若被当成 `full`，
//       等于把「宿主以为更严」的用户悄悄放到全盘。
//   `inherit` + Windows + `workspace-write`：拒绝——dsh 0.2.2-rc.2 起 Windows 的额外可写目录
//       只作用于宿主的文件工具、不下发给受限子进程，OCR 的状态目录放不进去；报错让用户换
//       `full`，而不是让 ocr 跑到 finalize session 才丢结果。
//
// 为什么不继承部署自己的 `additionalWritableRoots`：那一位只有 `ctx.sandboxPolicy.resolve()`
// 读得到（`SandboxPolicyRequest` 只带 `session`/`mode`），而本包不依赖那个服务——执行器自报的
//   `ShellService.sandboxMode` 已经够判收不收窄。要放行更多路径的部署用 `full`；这条取舍写在
// README 的部署级字段行里，别让用户以为 `inherit` 也会带上他们配的那些根。

import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";
import type { OcrSandboxMode } from "./ocr-config.ts";
import { OCR_CONFIG_DIR } from "./ocr-config.ts";

/** 部署级字段 `ocrSandbox` 的取值：`full` = 保持既有行为（默认），`inherit` = 随宿主收窄。 */
export type { OcrSandboxMode } from "./ocr-config.ts";

/**
 * 一次 `chooseOcrSandboxPolicy` 的输入。全字段只读：判定本身是纯函数，副作用只剩
 * `prepareRoot` 那两个目录的 mkdir/realpath（由调用方注入，测试因此不依赖真实 $TMPDIR 布局）。
 */
export interface OcrSandboxRequest {
  readonly mode: OcrSandboxMode;
  /**
   * 执行器自报的模式（`ShellService.sandboxMode`）；undefined = 该执行器不沙箱（如 bash-local）。
   * 刻意收成 `string`：已知三档之外若有新档，按「认不出」拒绝，而不是按 `SandboxMode` 的
   * 类型假设它不可能出现。
   */
  readonly hostMode: string | undefined;
  /** 这次执行的 workdir：官方要求「即使不消费也携带」，也是 `workspace-write` 的可写根。 */
  readonly workspaceRoot: string;
  /** OCR 的 HOME（`ocrConfigPath` 覆盖后的值，否则宿主 HOME）：状态目录是 `<stateHome>/.opencodereview`。 */
  readonly stateHome: string;
  /** 系统临时区：`--output` 临时文件与 session export 目录都建在它下面。 */
  readonly tempRoot: string;
  /**
   * 执行宿主所在平台（生产侧传 `process.platform`）。
   *
   * 单列成入参而不是在判定层读 `process.platform`：这条判据只有 Windows 一档，
   * 测试在任何 CI 上都能把两条分支钉住。dsh 0.2.2-rc.2 起，Windows 的
   * `additionalWritableRoots` 只作用于宿主的文件工具、不下发给受限子进程，
   * 于是 `workspace-write` 下 OCR 的状态目录放不进去——这一档在 Windows 上不可用。
   */
  readonly platform: NodeJS.Platform;
  /** 文案表：调用方现取（它只决定拒绝时的措辞，不参与判决）。 */
  readonly messages: OcrReviewMessages;
  /** 目录「建出来 + 折成真实绝对路径」的实现；缺省用 `mkdir(recursive)+realpath`。 */
  readonly prepareRoot?: (dir: string) => Promise<string>;
}

const FULL_ACCESS = "danger-full-access";
const WORKSPACE_WRITE = "workspace-write";
const READ_ONLY = "read-only";

function fullAccess(workspaceRoot: string): SandboxExecutionPolicy {
  return { mode: FULL_ACCESS, workspaceRoot };
}

/** `<stateHome>/.opencodereview`：config.json 与会话记录（`sessions/`）都在这一个目录下。 */
function stateDirOf(stateHome: string): string {
  return path.join(stateHome, OCR_CONFIG_DIR);
}

async function defaultPrepareRoot(dir: string): Promise<string> {
  // 0o700 与 OCR 自己建目录的意图一致（`~/.opencodereview` 里放的是 config.json 与会话记录）。
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return realpath(dir);
}

/** 逐条解析放行根：任一条建不出来/折不出来就整体报错（收窄方案不成立时不能静默放宽）。 */
async function preparedRoots(
  dirs: readonly string[],
  prepare: (dir: string) => Promise<string>,
  messages: OcrReviewMessages,
): Promise<string[]> {
  const prepared = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return await prepare(dir);
      } catch (error) {
        throw new Error(
          format(messages.ocrSandboxRootUnavailable, { path: dir, reason: errorText(error) }),
          { cause: error },
        );
      }
    }),
  );
  return [...new Set(prepared)];
}

/**
 * 把「部署级开关 + 执行器自报模式」折成这次 spawn 要携带的 `SandboxExecutionPolicy`。
 *
 * @throws 错误文案来自消息表：`ocrSandboxReadOnly` / `ocrSandboxUnknownMode` /
 *   `ocrSandboxWindowsUnsupported` / `ocrSandboxRootUnavailable`（四条合起来覆盖 inherit 的
 *   所有失败形态，模型与用户读得到成因）。
 */
export async function chooseOcrSandboxPolicy(
  request: OcrSandboxRequest,
): Promise<SandboxExecutionPolicy> {
  const { hostMode, messages, mode, platform, stateHome, tempRoot, workspaceRoot } = request;
  if (mode === "full" || hostMode === undefined || hostMode === FULL_ACCESS) {
    return fullAccess(workspaceRoot);
  }
  if (hostMode === READ_ONLY) {
    throw new Error(format(messages.ocrSandboxReadOnly, { path: stateDirOf(stateHome) }));
  }
  if (hostMode !== WORKSPACE_WRITE) {
    throw new Error(format(messages.ocrSandboxUnknownMode, { mode: hostMode }));
  }
  // Windows 的受限进程不收额外可写目录（rc.2 起显式只作用于文件工具），OCR 的状态目录
  // 因此放不进 workspace-write；在这里拒绝，而不是让 ocr 跑到 finalize session 才丢结果。
  if (platform === "win32") {
    throw new Error(format(messages.ocrSandboxWindowsUnsupported, { path: stateDirOf(stateHome) }));
  }
  const prepare = request.prepareRoot ?? defaultPrepareRoot;
  const roots = await preparedRoots([stateDirOf(stateHome), tempRoot], prepare, messages);
  return { mode: WORKSPACE_WRITE, workspaceRoot, additionalWritableRoots: roots };
}

/** host 侧三处 spawn 的接线口：把部署值（`sandbox`/`stateHome`）、执行器自报的 `hostMode`、
 *  每次不同的 `workspaceRoot` 交进来；判据只在上面那位函数里。放在这里而不是 host.ts，
 *  是因为 host.ts 贴着 max-lines 预算，而这三行的组合与判据是同一件事。 */
export async function hostSandboxPolicy(
  host: { readonly shell: { readonly sandboxMode: string | undefined } },
  run: { readonly sandbox: OcrSandboxMode; readonly stateHome: string },
  workspaceRoot: string,
  messages: OcrReviewMessages,
): Promise<SandboxExecutionPolicy> {
  return chooseOcrSandboxPolicy({
    mode: run.sandbox,
    hostMode: host.shell.sandboxMode,
    workspaceRoot,
    stateHome: run.stateHome,
    tempRoot: tmpdir(),
    platform: process.platform,
    messages,
  });
}
