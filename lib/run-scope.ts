/** 一次插件生命周期的取消域：apply 建、卸载收。
 *
 *  为什么必须有它：工具注册摘条目**不**中止在跑的调用，宿主的 subprocess 回收也只在
 *  它自己卸载时发生——于是「插件已卸载、ocr 还在跑完整场评审」只能由本包自己收。
 *  弱表而非字段：宿主服务对象不是本包的所有物，不在它上面留状态。
 */
interface Lifetime {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

const LIFETIMES = new WeakMap<object, Lifetime>();

/** 给这次 apply 的生命周期登记一个取消域，返回可绑到卸载钩子的 `release`。 */
export function bindLifetime(host: object): Lifetime {
  const controller = new AbortController();
  const lifetime: Lifetime = {
    signal: controller.signal,
    release: () => {
      LIFETIMES.delete(host);
      controller.abort(new Error("ocr-review: plugin unloaded"));
    },
  };
  LIFETIMES.set(host, lifetime);
  return lifetime;
}

/** 当前 apply 的取消域（宿主替身 / 未装载时 undefined）。 */
function lifetimeOf(host: object): AbortSignal | undefined {
  return LIFETIMES.get(host)?.signal;
}

/** 把「调用方取消」与「插件卸载」合成一条 signal（谁先断都算断）；全空时 undefined
 *  （收集式路径原本就不挂 signal，宿主 resolve 允许省略）。 */
export function combineSignals(
  candidateSignals: readonly (AbortSignal | undefined)[],
  host: object,
): AbortSignal | undefined {
  const live = [...candidateSignals, lifetimeOf(host)].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return live.length === 0 ? undefined : AbortSignal.any(live);
}

/** 2^31-1：宿主 timer 的上限，也是「0 = 请求宿主上限」那一档的请求值。 */
export const MAX_TIMEOUT_REQUEST_MS = 2_147_483_647;

/** 显式分钟数由本包自管截止：宿主 `onExpiry:'kill'` 会按 `min(请求, shell.maxTimeoutMs)`
 *  收敛（该值默认 600000 = 10 分钟，ShellService 又不暴露它），显式值大于该上限时会被
 *  悄悄截短。0/未设置仍交宿主，那一档的语义本来就是「请求宿主上限」。 */
const EXPLICIT_TIMEOUT_REASON = new Error("ocr-review: explicit timeout");

export interface RunDeadline {
  readonly controller: AbortController;
  /** 到点后为真（读的是可变状态，别让类型收窄把闭包里的赋值当成不可达）。 */
  readonly fired: () => boolean;
  readonly cancel: () => void;
}

export function startDeadline(milliseconds: number): RunDeadline {
  const controller = new AbortController();
  const state = { fired: false };
  const timer = setTimeout(() => {
    state.fired = true;
    controller.abort(EXPLICIT_TIMEOUT_REASON);
  }, milliseconds);
  return {
    controller,
    fired: () => state.fired,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/** 前台的截止策略：显式分钟数走本包自管（见 EXPLICIT_TIMEOUT_REASON），0/未设置交宿主
 *  （请求宿主上限，宿主按 min(请求, shell.maxTimeoutMs) 收敛）。 */
export interface RunExpiry {
  readonly signal: AbortSignal | undefined;
  readonly spec: { readonly timeoutMs: number; readonly onExpiry?: "none" };
  readonly deadline: RunDeadline | undefined;
}

export function runExpiry(host: object, requestedMs: number, callerSignal: AbortSignal): RunExpiry {
  const explicit = requestedMs < MAX_TIMEOUT_REQUEST_MS ? requestedMs : undefined;
  const deadline = explicit === undefined ? undefined : startDeadline(explicit);
  return {
    signal: combineSignals([callerSignal, deadline?.controller.signal], host),
    spec:
      explicit === undefined
        ? { timeoutMs: requestedMs }
        : { timeoutMs: explicit, onExpiry: "none" },
    deadline,
  };
}
