// dsh-ocr-review/test/duration.test.ts —— 前台耗时排版。
//
// 这一组的期望值全部独立写死（不从实现推导）：hint 里报给模型的那个字符串是模型
// 「这次是不是慢得不正常」的唯一依据，四舍五入错一位它就判断反了。

import { describe, it, expect } from "vitest";
import { formatDuration } from "../lib/duration.ts";

describe("前台耗时排版", () => {
  it("短于一秒按毫秒报（不能印成 0s）", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("一秒到一分钟按整秒报（不足一秒的零头截掉）", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("一分钟到一小时报分钟加两位秒", () => {
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(312_000)).toBe("5m12s");
    expect(formatDuration(3_599_000)).toBe("59m59s");
  });

  it("超过一小时报小时加两位分钟（秒不报：多出来的秒数对量级判断没有信息量）", () => {
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(7_320_000)).toBe("2h02m");
    expect(formatDuration(21_600_000)).toBe("6h00m");
  });

  it("坏输入一律按 0 处理：这一位只是说明，不该把整条回执变成错误", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
  });

  it("小数向下取整（墙钟不会因为 999.9ms 被印成 1s）", () => {
    expect(formatDuration(999.9)).toBe("999ms");
    expect(formatDuration(1999.9)).toBe("1s");
  });
});
