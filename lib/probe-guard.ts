/** 装载期自检（`startupVerify` 的 `ocr version` 测量）的兜底：`runCollect` 自己仍会抛
 *  （`host.shell.resolve`/`execute`/`result` 任一基础设施故障都是 reject），而 apply 里是
 *  fire-and-forget——漏出去就是未处理 rejection，Node ≥22 默认终止宿主进程，一次自检失败
 *  不值得杀掉整个 dsh。结论留空（卡片显示「未实测」），人按「检测」键会走同一条路径现取。
 *
 *  放在 lib 里而不是 host.ts：后者贴着 `max-lines` 的上限，且这段与 ocr 无关，是纯粹的
 *  异步兜底。 */
export async function containedProbe(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    /* 静默：插件侧不打日志，失败也不写成成功。 */
  }
}
