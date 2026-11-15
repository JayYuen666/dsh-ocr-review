// lib/scan-defaults.ts —— ocr_scan 的深度旋钮缺省值：把设置里的值补进模型入参。
//
// 为什么单独一层：host.ts 贴着 max-lines 上限，而这段是纯数据映射（不碰 host、不碰
// 文件系统），独立出来还能把「只补缺的」这条语义逐格钉住——工具级用例只能看到最终命令，
// 分不清「模型没给、用了设置」与「模型给了、被设置覆盖」。
//
// 语义：**只补缺的**。模型显式传了 `maxTokens` 就用它的；没传才落设置里的缺省值。
// 三个数值位一律 0 = 不传该 flag、用 OCR 模板自己的值（MAX_TOKENS = 58888、
// 并发 8、MAX_TOOL_REQUEST_TIMES = 60）——不给非零默认，等于不把作者的经验塞进别人的机器。

/** 三个数值旋钮的默认值：0 = 「不传该 flag」。 */
export const SCAN_MAX_TOKENS_DEFAULT = 0;
export const SCAN_CONCURRENCY_DEFAULT = 0;
export const SCAN_MAX_TOOLS_DEFAULT = 0;

/** 本模块要的那几位设置：前两枚是 volatile 引用（现读 `.get()`），后三枚是部署级普通值。 */
export interface ScanDefaultsInput {
  readonly scanMaxTokens: { readonly get: () => unknown };
  readonly scanConcurrency: { readonly get: () => unknown };
  readonly scanMaxTools: number;
  readonly scanNoPlan: boolean;
  readonly scanNoDedup: boolean;
}

/** volatile 数值项现读；同时收 volatile 引用与部署级普通值，两档在此合流。
 *  非「非负安全整数」一律回落默认（0 是合法值 = 不传 flag；负数与小数不是，
 *  OCR 侧 `validateScanOptions` 只校验非负）。 */
export function readScanNumber(
  field: { readonly get: () => unknown } | number,
  fallback: number,
): number {
  const raw: unknown = typeof field === "number" ? field : field.get();
  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isSafeInteger(num) && num >= 0) {
    return num;
  }
  return fallback;
}

/** 非零才落键：0 在这里是「不传该 flag」，见 `applyScanDefaults` 的注释。 */
function positiveOf(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

/** 把设置里的 scan 缺省值补进模型入参，返回新对象（不改入参）。
 *
 *  为什么不写成 tool schema 的 `default`：那会变成「模型没传时我们假装它传了」，
 *  而这里的语义是「这一档由部署决定」——两者在 `--max-tools` 的「只升不降」语义上
 *  会分不清（0 与「未给」在 OCR 侧同义，但在透传链上是两件事）。
 *
 *  @param args - 模型给的原始入参（只读）
 *  @param config - 本包的设置项
 *  @returns 补完缺省值的新入参 */
export function applyScanDefaults(
  args: Record<string, unknown>,
  config: ScanDefaultsInput,
): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...args };
  // 只补缺的：模型显式给了（哪怕给 0 / false）就不动它。
  // 数值位：解析后 <= 0 一律**不落键**。0 的语义是「不传该 flag」，落成 0 会被下游
  // `pushIntFlag` 当成「模型显式传了 0」——`--concurrency` 的下限是 1，那会当场抛
  // 「--concurrency 需要为 ≥1 的整数，收到 0」。不落键 = 下游当作未给，两条路径一致。
  // 布尔位同理：设置里关着就不落键，别把 `noPlan: false` 塞进去——那会让
  // 「模型给了哪些参数」一类的判据多出一项并不存在的入参。
  const assign = (key: string, value: unknown): void => {
    if (args[key] === undefined && value !== undefined) {
      filled[key] = value;
    }
  };
  assign("maxTokens", positiveOf(readScanNumber(config.scanMaxTokens, SCAN_MAX_TOKENS_DEFAULT)));
  assign(
    "concurrency",
    positiveOf(readScanNumber(config.scanConcurrency, SCAN_CONCURRENCY_DEFAULT)),
  );
  assign("maxTools", positiveOf(readScanNumber(config.scanMaxTools, SCAN_MAX_TOOLS_DEFAULT)));
  assign("noPlan", config.scanNoPlan ? true : undefined);
  assign("noDedup", config.scanNoDedup ? true : undefined);
  return filled;
}
