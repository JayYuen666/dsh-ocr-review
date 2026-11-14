// dsh-ocr-review/lib/duration.ts —— 把毫秒排成人读的时长。
//
// 只给「前台长任务回执」用：一次 ocr review 可以跑几分钟到几小时，模型拿到一个裸毫秒数
// （`312000`）既判断不了这次是不是异常慢，也没法和自己上一次的记录比对。排成 `5m12s`
// 之后，同一个数在两次回执之间可以直接比。
//
// 单位一律用缩写（h/m/s/ms）而不是「小时/分钟/秒」或 "hour/minute/second"：中文栏与英文栏
// 共用同一份排好的字符串，语言差异留给外层模板的一句解释，这里不做本地化。
//
// 引用面（新建时探查，均零命中）：
// · 仓库根 grep `duration.ts` → No matches found（无 import/引用者）
// · test 层 grep `duration.ts` → No matches found（无测试触达；本轮新建 test/duration.test.ts）
// · 文档层 grep `duration.ts|formatDuration` → No matches found（README/DETAIL/CHANGELOG 未提及）
//
// 用户指令原文（m25736 第 ④ 项裁定）：「sessionStats 不做 rtk，改为给 ocr 的前台作业加耗时
// 统计，后台运行的不加」—— 所以计时只加在 runForeground（前台唯一入口），
// startBackground 那条路径一个字都不动。
//
// 受影响的导出：本文件新增 `formatDuration(elapsedMs: number): string`，是 host.ts 的
// 唯一消费者；不改任何既有导出、不改 render/schema 形状（耗时拼在 hint 尾部，属于既有的
// string 字段，输出契约不变）。

/**
 * 两位补零。
 *
 * @param value - 0 到 59 之间的整数
 * @returns 至少两位的数字串（`7` → `07`）
 */
function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * 把毫秒排成 `<h>h<m>m<s>s` 形式的缩写时长。
 *
 * 取舍：只保留两个量级 —— 顶上那一位加下一位（`1h02m`、`5m12s`），因为回执里这一位是给人
 * 快速判断量级用的，`1h02m03s` 多出来的秒数毫无信息量；短于 1 分钟时保留秒（`42s`），
 * 短于 1 秒保留毫秒（`820ms`），否则一次 800ms 的前台调用会印成 `0s`。
 *
 * @param elapsedMs - 实际墙钟毫秒（负数、NaN、Infinity 都按 0 处理：这一位只是说明，不该
 *   因为时钟回拨或调用方传错就把整条回执变成错误）
 * @returns 已排好的时长，如 `1h02m` / `5m12s` / `42s` / `820ms`
 */
export function formatDuration(elapsedMs: number): string {
  const total = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs) : 0;
  if (total < 1000) {
    return `${total}ms`;
  }
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${pad2(seconds % 60)}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${pad2(minutes % 60)}m`;
}
