// test/sandbox-policy.test.ts —— 部署级 `ocrSandbox` 的判决表：五条分支逐条钉住。
//
// 这一层不经过 host：`chooseOcrSandboxPolicy` 是纯判定（唯一副作用是放行根的
// mkdir+realpath，且由用例注入）。接线是否正确（把 `host.shell.sandboxMode` 与
// `ocrStateHome` 递进来、三处 spawn 都走它）由 test/host.test.ts 的接线用例钉住。

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES, format } from "../lib/messages.ts";
import { chooseOcrSandboxPolicy } from "../lib/sandbox-policy.ts";
import type { OcrSandboxRequest } from "../lib/sandbox-policy.ts";

const WORKSPACE_ROOT = "/workspace/repo";
const STATE_HOME = "/home/user";
const TEMP_ROOT = "/tmp/scratch";
const WORKSPACE_WRITE = "workspace-write";
const FULL_ACCESS = "danger-full-access";
const UNKNOWN_MODE = "landlock-only";
/** 注入式解析器回传的「已规范化」标记：用例据以判「解析器拿到的就是哪一个目录」。 */
const PREPARED_MARK = "#ok";

/** 判定入参的基准值（每个用例只改它关心的那一枚，避免六行样板散在各处）。 */
function request(overrides: Partial<OcrSandboxRequest> = {}): OcrSandboxRequest {
  return {
    mode: "inherit",
    hostMode: WORKSPACE_WRITE,
    workspaceRoot: WORKSPACE_ROOT,
    stateHome: STATE_HOME,
    tempRoot: TEMP_ROOT,
    messages: MESSAGES.zh,
    ...overrides,
  };
}

/** 注入式放行根解析：原样回传「已规范化」的标记串。 */
async function echoRoot(dir: string): Promise<string> {
  return `${dir}${PREPARED_MARK}`;
}

/** `<stateHome>/.opencodereview`（判定层自己算出来的那个放行根）。 */
function stateDirOf(stateHome: string): string {
  return path.join(stateHome, ".opencodereview");
}

describe("chooseOcrSandboxPolicy：放开档", () => {
  it("mode=full 时无论执行器自报什么都不收窄", async () => {
    const hostModes: (string | undefined)[] = [
      FULL_ACCESS,
      WORKSPACE_WRITE,
      "read-only",
      undefined,
    ];
    const policies = await Promise.all(
      hostModes.map((hostMode) => chooseOcrSandboxPolicy(request({ mode: "full", hostMode }))),
    );
    for (const policy of policies) {
      expect(policy).toStrictEqual({ mode: FULL_ACCESS, workspaceRoot: WORKSPACE_ROOT });
    }
  });

  it("inherit + 执行器不报模式（非沙箱执行器）等效放开", async () => {
    await expect(chooseOcrSandboxPolicy(request({ hostMode: undefined }))).resolves.toStrictEqual({
      mode: FULL_ACCESS,
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  it("inherit + 执行器自报 danger-full-access 同样放开", async () => {
    await expect(chooseOcrSandboxPolicy(request({ hostMode: FULL_ACCESS }))).resolves.toStrictEqual(
      { mode: FULL_ACCESS, workspaceRoot: WORKSPACE_ROOT },
    );
  });
});

describe("chooseOcrSandboxPolicy：拒绝档", () => {
  it("inherit + read-only 直接拒绝，并点名它写不了的状态目录", async () => {
    const err = await chooseOcrSandboxPolicy(request({ hostMode: "read-only" })).catch(
      (error: unknown) => error as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      format(MESSAGES.zh.ocrSandboxReadOnly, { path: stateDirOf(STATE_HOME) }),
    );
  });

  it("inherit + 认不出的模式拒绝，不猜成 full", async () => {
    const err = await chooseOcrSandboxPolicy(request({ hostMode: UNKNOWN_MODE })).catch(
      (error: unknown) => error as Error,
    );
    expect((err as Error).message).toBe(
      format(MESSAGES.zh.ocrSandboxUnknownMode, { mode: UNKNOWN_MODE }),
    );
  });

  it("放行根解析失败时整体拒绝（不静默放宽成 full）", async () => {
    const err = await chooseOcrSandboxPolicy(
      request({
        prepareRoot: (dir) =>
          Promise.reject(new Error(dir === stateDirOf(STATE_HOME) ? "EACCES" : "?")),
      }),
    ).catch((error: unknown) => error as Error);
    expect((err as Error).message).toBe(
      format(MESSAGES.zh.ocrSandboxRootUnavailable, {
        path: stateDirOf(STATE_HOME),
        reason: "EACCES",
      }),
    );
  });
});

describe("chooseOcrSandboxPolicy：workspace-write 收窄", () => {
  it("放行状态目录与系统临时区，工作区根照旧", async () => {
    const policy = await chooseOcrSandboxPolicy(request({ prepareRoot: echoRoot }));
    expect(policy).toStrictEqual({
      mode: WORKSPACE_WRITE,
      workspaceRoot: WORKSPACE_ROOT,
      additionalWritableRoots: [
        `${stateDirOf(STATE_HOME)}${PREPARED_MARK}`,
        `${TEMP_ROOT}${PREPARED_MARK}`,
      ],
    });
  });

  it("两个根解析成同一目录时去重（宿主会按条校验，重复项没有意义）", async () => {
    const policy = await chooseOcrSandboxPolicy(
      request({ stateHome: TEMP_ROOT, tempRoot: TEMP_ROOT, prepareRoot: echoRoot }),
    );
    expect(policy.additionalWritableRoots).toStrictEqual([
      `${stateDirOf(TEMP_ROOT)}${PREPARED_MARK}`,
      `${TEMP_ROOT}${PREPARED_MARK}`,
    ]);
  });

  it("缺省解析器真的建目录并折成真实绝对路径（重定向 HOME 的部署才能跑）", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ocr-sandbox-home-"));
    try {
      const policy = await chooseOcrSandboxPolicy(request({ stateHome: home, tempRoot: home }));
      const roots = policy.additionalWritableRoots ?? [];
      expect(roots).toHaveLength(2);
      // 两条都必须是 realpath 后的绝对路径：`/var/folders/...` 在 macOS 上会被折成
      // `/private/...`，所以与 mkdtemp 的原样值比对是不成立的；用 realpath 重算期望值。
      expect(roots).toStrictEqual([await realpath(stateDirOf(home)), await realpath(home)]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
