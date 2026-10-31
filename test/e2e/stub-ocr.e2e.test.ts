// 端到端：**真进程**跑通「命令构造 → 官方本地执行器 spawn → stub `ocr` 落产物 →
// 读产物 → 解析 → 摘要 → 工具出口语义校验」整条链。test/host.test.ts 的工具链用的是
// 回放式 shell 替身（fixture 反写 --output）；这一层换真件：LocalSubprocessRuntime +
// LocalBashExecutor（与宿主同一对官方执行器）真 spawn PATH 上的 stub `ocr`，
// 「summarize 产物恒过 REVIEW_OUTPUT_SCHEMA」这句此前没有直接证据的段间契约在这里落锤。
import { beforeEach, afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

import { buildReviewCommand } from "../../lib/cli.ts";
import { parseReviewOutput, summarizeReview } from "../../lib/parse.ts";
import { REVIEW_OUTPUT_SCHEMA } from "../../lib/tool-schemas.ts";
import { assertToolOutput } from "../../lib/output.ts";
import { MESSAGES } from "../../lib/messages.ts";

const { zh } = MESSAGES;

/** stub `ocr`：把 `--output <path>` 指到的路径写上 fixture 回执，并把 argv 留档。 */
const STUB_OCR = `#!/bin/bash
for index in "$@"; do :; done
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output" ]; then out="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$*" >> "$(dirname "$out")/ocr-args.log"
cat > "$out" <<'JSON'
__FIXTURE_JSON__
JSON
exit 0
`;

interface Rig {
  ctx: Context;
  project: string;
  binDir: string;
  argsLog: string;
  output: string;
}

let rig: Rig | undefined;
const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "../fixtures/ocr-review-complete.json"),
  "utf8",
);

async function boot(): Promise<Rig> {
  const made = await mkdtemp(path.join(os.tmpdir(), "ocr-e2e-"));
  const dir = await realpath(made);
  const ctx = new Context();
  try {
    ctx.provide("settings", {
      describe: () => [],
      mutate: async (): Promise<void> => undefined,
      configure: () => (): void => {
        void 0;
      },
    });
    await ctx.plugin(LocalJobRegistry);
    await ctx.plugin(LocalSubprocessRuntime);
    (ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir: path.join(dir, ".spill") };
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 20_000, graceMs: 300 });
    const fs = await import("node:fs/promises");
    const project = path.join(dir, "repo");
    await fs.mkdir(project, { recursive: true });
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = path.join(binDir, "ocr");
    await writeFile(stubPath, STUB_OCR.replace("__FIXTURE_JSON__", FIXTURE), { mode: 0o755 });
    const argsLog = path.join(dir, "ocr-args.log");
    const output = path.join(dir, "ocr-output.json");
    process.env["PATH"] = `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`;
    return { ctx, project, binDir, argsLog, output };
  } catch (error) {
    await ctx.fiber.dispose().catch(() => null);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

describe("stub ocr 真进程全链", () => {
  beforeEach(async () => {
    rig = await boot();
  });

  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await rm(path.dirname(current.output), { recursive: true, force: true });
    }
  });

  it("构造的命令经真执行器 spawn：stub 收到完整 argv、产物落盘、解析链到 schema 校验全通过", async () => {
    const current = rig;
    assert.ok(current !== undefined);
    const { ctx, project, argsLog, output } = current;
    const { command } = buildReviewCommand({ repo: project }, output, zh);
    assert.ok(command.includes("review --audience agent --format json"), command);

    const shell = ctx.shell as unknown as {
      resolve: (request: { command: string; workdir: string; timeoutMs: number }) => unknown;
      execute: (spec: unknown) => Promise<{ result: () => Promise<{ exitCode: number }> }>;
    };
    const spec = shell.resolve({ command, workdir: project, timeoutMs: 30_000 });
    const execution = await shell.execute(spec);
    const result = await execution.result();
    assert.equal(result.exitCode, 0, "stub ocr 真进程退出码 0");

    // stub 真收到了这条命令（argv 留档第一行含命令词本身）。
    const logged = readFileSync(argsLog, "utf8").split("\n").at(0) ?? "";
    assert.ok(logged.includes("review"), logged);
    assert.ok(logged.includes("--audience"), logged);

    // 产物 → 解析 → 摘要 → 出口语义校验：段间契约的直接证据。
    const parsed = parseReviewOutput(readFileSync(output, "utf8"), zh);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.comments.length, 3, "fixture 的三条评论经真进程链原样到达");
    const summary = summarizeReview(parsed, zh);
    const validated = assertToolOutput(REVIEW_OUTPUT_SCHEMA, summary, "ocr_review", zh);
    assert.ok(validated !== null && typeof validated === "object");
  }, 60_000);
});
