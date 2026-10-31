// 跨平台判据：根校验「形态优先于平台」的契约（POSIX 形处处收、win32 形只在 win32 收）、
// ocr 二进制定位的 PATHEXT/PATH 分号语义（platform/env 可注入，探针用它真造临时 bin）、
// HOME 前缀与回收守护的 win32 放行。win32 分支在本机经 process.platform 桩触达，
// 在 Windows CI 上则由平台常量自然生效——两路都真跑。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertAbsoluteRoot, commaList } from "../../lib/argv-guard.ts";
import { resolveOcrAvailability, withHomeEnv, wrapWithHostReaper } from "../../lib/cli.ts";
import { MESSAGES } from "../../lib/messages.ts";

const { zh } = MESSAGES;

/** process.platform 桩：win32 分支在本机不可达，这一桩是官方文档化的触达方式之一。 */
function withPlatform<Result>(platform: NodeJS.Platform, body: () => Result): Result {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

describe("assertAbsoluteRoot 的「形态优先于平台」契约", () => {
  it("posix 形在任何平台都收并归一；盘符与 UNC 形在 posix 上拒绝（不跨平台放宽）", () => {
    assert.equal(assertAbsoluteRoot("/repo/src", zh), "/repo/src");
    for (const winShape of [String.raw`C:\repo`, String.raw`\\host\share\dir`, "C:repo"]) {
      assert.throws(() => assertAbsoluteRoot(winShape, zh), /absolute|绝对/u, winShape);
    }
  });

  it("win32 桩下：盘符形收下并归一；盘符根与 UNC 共享根拒绝；POSIX 形照常收", () => {
    withPlatform("win32", () => {
      assert.equal(assertAbsoluteRoot(String.raw`C:\repo\src`, zh), String.raw`C:\repo\src`);
      assert.throws(() => assertAbsoluteRoot(`${String.raw`C:`}\\`, zh), /root|根/u);
      assert.throws(() => assertAbsoluteRoot(String.raw`\\host\share`, zh), /root|根/u);
      assert.equal(assertAbsoluteRoot("/repo/src", zh), "/repo/src");
    });
  });

  it("NUL 与空串在任何平台都拒绝", () => {
    for (const platform of ["linux", "win32"] as const) {
      withPlatform(platform, () => {
        assert.throws(() => assertAbsoluteRoot("/a\u0000b", zh));
        assert.throws(() => assertAbsoluteRoot("   ", zh));
      });
    }
  });
});

describe("resolveOcrAvailability 的 windows 定位语义（platform/env 全注入）", () => {
  it("win32 桩：PATH 按分号切、空段滤掉、PATHEXT 后缀逐个试", () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), "ocr-path-"));
    try {
      mkdirSync(path.join(binDir, "sub"), { recursive: true });
      // 文件名与 PATHEXT 项精确同大小写：case-insensitive 的 macOS 盘上 lower-case 文件
      // 会被 .CMD 档以另一拼写探到，路径归属就说不清了。
      writeFileSync(path.join(binDir, "sub", "ocr.CMD"), "stub", "utf8");
      const status = resolveOcrAvailability(
        { PATH: `${binDir};;${path.join(binDir, "sub")}`, PATHEXT: ".COM;.CMD" },
        () => null,
        "win32",
      );
      assert.equal(status.source, "path");
      assert.equal(status.path, path.join(binDir, "sub", "ocr.CMD"));
      assert.equal(status.channel !== undefined, true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("posix 定位：PATH 按冒号切、无后缀探测；两处都落空回 source:none", () => {
    const status = resolveOcrAvailability({ PATH: "/nonexistent-ocr-path" }, () => null, "linux");
    assert.equal(status.source, "none");
  });
});

describe("home 前缀与回收守护的平台放行", () => {
  it("withHomeEnv：POSIX 加 HOME= 前缀（shq 转义）；win32 桩与缺省都原样返回", () => {
    const command = "/usr/bin/ocr review";
    assert.equal(withHomeEnv(command, "/sandbox/home"), "HOME='/sandbox/home' /usr/bin/ocr review");
    assert.equal(withHomeEnv(command, undefined), command);
    withPlatform("win32", () => {
      assert.equal(withHomeEnv(command, "/sandbox/home"), command);
    });
  });

  it("wrapWithHostReaper：win32 桩原样放行（POSIX 守护只在 POSIX 上包）", () => {
    withPlatform("win32", () => {
      const command = "/usr/bin/ocr review";
      assert.equal(wrapWithHostReaper(command, zh), command);
    });
  });
});

describe("commaList 的平台无关边界", () => {
  it("含逗号的元素被拒（探针实测的负例），普通列表按序保留", () => {
    assert.throws(() => commaList(["a,b"], "paths", 32, zh));
    assert.deepEqual(commaList(["a.ts", "b.ts"], "paths", 32, zh), ["a.ts", "b.ts"]);
  });
});
