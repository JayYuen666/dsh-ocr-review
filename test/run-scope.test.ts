// run-scope / probe-guard：插件生命周期的取消域、前台截止策略与装载期兜底。
//
// 这三样本轮都是「宿主状态下才暴露」的行为（卸载、显式超时、自检失败），单靠 host 侧
// 用例既难造又易漏，所以把判定收成纯函数/弱表，在这里按分支钉住。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindLifetime,
  combineSignals,
  MAX_TIMEOUT_REQUEST_MS,
  runExpiry,
} from "../lib/run-scope.ts";
import { containedProbe } from "../lib/probe-guard.ts";

describe("生命周期取消域", () => {
  it("release 断掉 signal，且之后不再把这个宿主当已装载", () => {
    const host = {};
    const lifetime = bindLifetime(host);
    expect(lifetime.signal.aborted).toBe(false);
    lifetime.release();
    expect(lifetime.signal.aborted).toBe(true);
    // 释放之后 combineSignals 读不到它：卸载后的调用不该再拿到一条已经断掉的 signal
    //（拿到也没害，但「已注销」这件事必须能被观察到）。
    expect(combineSignals([], host)).toBeUndefined();
  });

  it("combineSignals：全空给 undefined，单条原样透传，两条谁断都断", () => {
    const host = {};
    expect(combineSignals([], host)).toBeUndefined();
    const caller = new AbortController();
    const single = combineSignals([caller.signal], host);
    expect(single).toBeDefined();
    caller.abort();
    expect(single?.aborted).toBe(true);
    const live = new AbortController();
    const lifetime = bindLifetime(host);
    const owner = new AbortController();
    const combined = combineSignals([owner.signal], host);
    expect(combined).toBeDefined();
    owner.abort();
    expect(combined?.aborted).toBe(true);
    const other = combineSignals([live.signal], host);
    lifetime.release();
    expect(other?.aborted).toBe(true);
  });
});

describe("前台截止策略", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("请求宿主的 0 档：请求值原样、不开 onExpiry、没有 deadline", () => {
    const host = {};
    const caller = new AbortController();
    const expiry = runExpiry(host, MAX_TIMEOUT_REQUEST_MS, caller.signal);
    expect(expiry.spec).toStrictEqual({ timeoutMs: MAX_TIMEOUT_REQUEST_MS });
    expect(expiry.deadline).toBeUndefined();
    // 调用方取消仍要能传下去：这是前台唯一的取消权。
    caller.abort();
    expect(expiry.signal?.aborted).toBe(true);
  });

  it("显式分钟数：onExpiry 关掉宿主的截短，deadline 到点自杀且 fired 可读", () => {
    vi.useFakeTimers();
    const host = {};
    const caller = new AbortController();
    const expiry = runExpiry(host, 30 * 60_000, caller.signal);
    expect(expiry.spec).toStrictEqual({ timeoutMs: 30 * 60_000, onExpiry: "none" });
    expect(expiry.deadline).toBeDefined();
    expect(expiry.deadline?.fired()).toBe(false);
    vi.advanceTimersByTime(30 * 60_000);
    expect(expiry.deadline?.fired()).toBe(true);
    expect(expiry.signal?.aborted).toBe(true);
    expiry.deadline?.cancel();
  });

  it("显式档正常完成时 cancel 掉定时器：别让一次成功评审仍留下待触发的 abort", () => {
    vi.useFakeTimers();
    const host = {};
    const expiry = runExpiry(host, 60_000, new AbortController().signal);
    expiry.deadline?.cancel();
    vi.advanceTimersByTime(60_000);
    expect(expiry.deadline?.fired()).toBe(false);
    expect(expiry.signal?.aborted).toBe(false);
  });
});

describe("装载期兜底", () => {
  it("任务成功时原样返回", async () => {
    let ran = false;
    await containedProbe(async () => {
      ran = true;
      await Promise.resolve();
    });
    expect(ran).toBe(true);
  });

  it("任务 reject 时不抛出：一次自检失败不许杀掉宿主", async () => {
    await expect(
      containedProbe(async () => {
        await Promise.reject(new Error("shell down"));
      }),
    ).resolves.toBeUndefined();
  });
});
