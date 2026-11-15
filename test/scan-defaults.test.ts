// scan-defaults 的逐格判据：这条语义（「只补缺的」＋「0/false 不落键」）在工具级
// 用例里只能看到最终命令，分不清「模型没给、用了设置」与「模型给了、被覆盖」。
import { describe, expect, it } from "vitest";
import {
  applyScanDefaults,
  readScanNumber,
  SCAN_CONCURRENCY_DEFAULT,
  SCAN_MAX_TOKENS_DEFAULT,
  SCAN_MAX_TOOLS_DEFAULT,
} from "../lib/scan-defaults.ts";

/** volatile 引用的替身：`get()` 现读，改 ref.value 即改设置（与 cosmokit 同构）。 */
function refOf(value: unknown): { readonly get: () => unknown; value: unknown } {
  const holder = {
    value,
    get: (): unknown => holder.value,
  };
  return holder;
}

/** 设置面替身：五个旋钮全给 0/false（= 交回 OCR 模板默认），逐用例覆盖需要的位。 */
function configOf(over: Partial<Record<string, unknown>> = {}): {
  scanMaxTokens: { get: () => unknown };
  scanConcurrency: { get: () => unknown };
  scanMaxTools: number;
  scanNoPlan: boolean;
  scanNoDedup: boolean;
} {
  return {
    scanMaxTokens: refOf(over["scanMaxTokens"] ?? SCAN_MAX_TOKENS_DEFAULT),
    scanConcurrency: refOf(over["scanConcurrency"] ?? SCAN_CONCURRENCY_DEFAULT),
    scanMaxTools: (over["scanMaxTools"] as number | undefined) ?? SCAN_MAX_TOOLS_DEFAULT,
    scanNoPlan: (over["scanNoPlan"] as boolean | undefined) ?? false,
    scanNoDedup: (over["scanNoDedup"] as boolean | undefined) ?? false,
  };
}

describe("readScanNumber：非负安全整数才收，否则回落", () => {
  it("volatile 引用里是合法值时现读它（改 ref 即改结果）", () => {
    const field = refOf(1024);
    expect(readScanNumber(field, 7)).toBe(1024);
    field.value = 2048;
    expect(readScanNumber(field, 7)).toBe(2048);
  });

  it("部署级直接给数字：合法就用、非法回落", () => {
    expect(readScanNumber(4096, 7)).toBe(4096);
    expect(readScanNumber(0, 7)).toBe(0);
    expect(readScanNumber(-1, 7)).toBe(7);
    expect(readScanNumber(1.5, 7)).toBe(7);
    expect(readScanNumber(Number.NaN, 7)).toBe(7);
    expect(readScanNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });

  it("字符串数字按数值收（宿主可能把设置读成字符串）", () => {
    expect(readScanNumber(refOf("300"), 7)).toBe(300);
    expect(readScanNumber(refOf("300abc"), 7)).toBe(7);
  });
});

describe("applyScanDefaults：只补缺的，且 0/false 不落键", () => {
  it("设置全为 0/false ⇒ 一个键都不补，入参原样", () => {
    const args = { repo: "/repo", path: ["a.ts"] };
    expect(applyScanDefaults(args, configOf())).toStrictEqual(args);
  });

  it("设置非零 ⇒ 补进对应键（这是被 0 提前短路掉的那条路径）", () => {
    const filled = applyScanDefaults(
      { repo: "/repo" },
      configOf({ scanMaxTokens: 30_000, scanConcurrency: 4, scanMaxTools: 120 }),
    );
    expect(filled["maxTokens"]).toBe(30_000);
    expect(filled["concurrency"]).toBe(4);
    expect(filled["maxTools"]).toBe(120);
    // 布尔位没开 ⇒ 仍然不落键。
    expect("noPlan" in filled).toBe(false);
    expect("noDedup" in filled).toBe(false);
  });

  it("布尔位打开 ⇒ 落 true；打开的那一位不影响另一位", () => {
    const onlyPlan = applyScanDefaults({ repo: "/repo" }, configOf({ scanNoPlan: true }));
    expect(onlyPlan["noPlan"]).toBe(true);
    expect("noDedup" in onlyPlan).toBe(false);
    const onlyDedup = applyScanDefaults({ repo: "/repo" }, configOf({ scanNoDedup: true }));
    expect(onlyDedup["noDedup"]).toBe(true);
    expect("noPlan" in onlyDedup).toBe(false);
  });

  it("模型显式给了值就跑在设置前面（哪怕给的是 0）", () => {
    // 0 在这里是「模型自己说不要这个 flag」，与「没给」不同：只补缺的，不覆盖。
    const explicit = applyScanDefaults(
      { repo: "/repo", maxTokens: 0, concurrency: 0, noPlan: false },
      configOf({ scanMaxTokens: 99_999, scanConcurrency: 16, scanNoPlan: true }),
    );
    expect(explicit["maxTokens"]).toBe(0);
    expect(explicit["concurrency"]).toBe(0);
    expect(explicit["noPlan"]).toBe(false);
  });

  it("不改入参（返回新对象）", () => {
    const args = { repo: "/repo" };
    const filled = applyScanDefaults(args, configOf({ scanMaxTokens: 1024 }));
    expect(filled).not.toBe(args);
    expect("maxTokens" in args).toBe(false);
  });
});
