// lib/session-tool.ts —— `ocr_session` 的注册与执行路径。
//
// 从 host.ts 拆出来的理由有两条：host.ts 顶着 2000 行上限，而 session 这条路径
// 既有一个 131 行的 run 闭包、又有 19 的认知复杂度；把命令构造、投影、导出三个分支
// 分成独立函数后，每一段都回到 lint 能读的尺寸。宿主侧只注入真正依赖 ctx 的几件事
// （define、locale、repo 归一、前台执行、截断说明），其余全是本模块可单测的纯逻辑。
//
// 这里的判据与 host.ts 的注释同源：stdout 可能被 400KB 上限截断（comments 实测
// 828KB），完整文本要从 spillPath 读回；list/show/comments 走结构化投影；export 要
// 核对 HTML 真的出现。

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { format } from "./messages.ts";
import { completeOutputText, echoRaw } from "./output-file.ts";
import { redactKeyMaterial } from "./output.ts";
import { RAW_ECHO_LIMIT } from "./foreground-summary.ts";
import { parseSessionCompare } from "./parse.ts";
import { parseSessionText } from "./session-view.ts";
import { SESSION_OUTPUT_SCHEMA } from "./tool-schemas.ts";
import { SESSION_EXPORT_PREFIX, sweepStaleSessionExports } from "./tmp-cleanup.ts";
import { buildSessionCommand, describeValue } from "./cli.ts";
import { OCR_TOOL_ERROR_CODES, OcrToolError } from "./tool-error.ts";
import type { OcrReviewMessages } from "./messages.ts";
import type { OcrBinaryStatus } from "./cli.ts";

/** 本模块只读 exec.signal；其余宿主上下文不存在依赖。 */
interface ToolExec {
  signal: AbortSignal;
}

/** host.ts 的 ToolSpec 在本模块里的只读形状；由宿主侧把 define 闭包进来。 */
export interface SessionToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: JsonSchemaNode;
  concurrencySafe: boolean;
  run: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
}

/** 前台结果的结构形状；host.ts 的 ForegroundRun 比它多 elapsedMs。 */
export interface SessionRunResult {
  text: string;
  truncated: boolean;
  spillPath: string | undefined;
  elapsedMs: number;
}

export interface SessionToolDeps {
  define: (spec: SessionToolSpec) => void;
  messages: () => OcrReviewMessages;
  probe: () => OcrBinaryStatus;
  assertPresent: (status: OcrBinaryStatus, messages: OcrReviewMessages) => void;
  resolveRepo: (
    args: Record<string, unknown>,
    exec: ToolExec,
    messages: OcrReviewMessages,
  ) => Promise<string>;
  run: (command: string, workdir: string, signal: AbortSignal) => Promise<SessionRunResult>;
  note: (run: SessionRunResult, messages: OcrReviewMessages) => string;
}

function actionOf(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function boolOfArg(value: unknown, name: string, messages: OcrReviewMessages): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new OcrToolError(
      OCR_TOOL_ERROR_CODES.badArguments,
      format(messages.boolMustBeBoolean, { name, received: describeValue(value) }),
    );
  }
  return value;
}

function commentLimitOf(value: unknown, messages: OcrReviewMessages): number {
  if (value === undefined || value === null) {
    return 100;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new OcrToolError(
      OCR_TOOL_ERROR_CODES.badArguments,
      format(messages.sessionCommentLimitRange, { received: describeValue(value) }),
    );
  }
  return value;
}

function sessionParameters(messages: OcrReviewMessages): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      repo: { type: "string", description: messages.paramRepo },
      action: {
        type: "string",
        enum: ["list", "show", "comments", "compare", "export"],
        description: messages.paramSessionAction,
      },
      id: { type: "string", description: messages.paramSessionId },
      before: { type: "string", description: messages.paramSessionBefore },
      after: { type: "string", description: messages.paramSessionAfter },
      severity: {
        type: "array",
        items: { type: "string" },
        description: messages.paramSessionSeverity,
      },
      category: {
        type: "array",
        items: { type: "string" },
        description: messages.paramSessionCategory,
      },
      branch: { type: "string", description: messages.paramSessionBranch },
      limit: { type: "integer", description: messages.paramSessionLimit },
      commentLimit: { type: "integer", description: messages.paramSessionCommentLimit },
      includeThinking: { type: "boolean", description: messages.paramSessionIncludeThinking },
    },
  };
}

async function runCompare(
  deps: SessionToolDeps,
  repo: string,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: OcrReviewMessages,
): Promise<unknown> {
  const { command, workdir } = buildSessionCommand({ ...args, repo }, messages);
  const stdout = await deps.run(command, workdir, exec.signal);
  const parsed = parseSessionCompare(stdout.text, messages);
  if (parsed.ok) {
    return { ...parsed.view, hint: messages.sessionCompareHint };
  }
  return {
    sessionOutput: echoRaw(stdout.text, RAW_ECHO_LIMIT) + deps.note(stdout, messages),
    hint: messages.sessionCompareHint,
  };
}

async function runExport(
  deps: SessionToolDeps,
  repo: string,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: OcrReviewMessages,
): Promise<unknown> {
  // 旧导出目录按 TTL 收走：HTML 是用户产物，不成功后立刻删，但也不能让
  // tmpdir 无限增长。放在 mkdtemp 之前，本次新目录永远不会被这一趟清掉。
  await sweepStaleSessionExports(tmpdir());
  const exportDir = mkdtempSync(path.join(tmpdir(), SESSION_EXPORT_PREFIX));
  const output = path.join(exportDir, "review.html");
  try {
    const { command, workdir } = buildSessionCommand({ ...args, repo, output }, messages);
    await deps.run(command, workdir, exec.signal);
    if (!existsSync(output)) {
      throw new Error(format(messages.sessionExportMissing, { path: output }));
    }
    return { sessionOutput: output, hint: messages.sessionExportHint };
  } catch (error) {
    rmSync(exportDir, { recursive: true, force: true });
    throw error;
  }
}

async function runProjection(
  deps: SessionToolDeps,
  repo: string,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: OcrReviewMessages,
): Promise<unknown> {
  const { command, workdir } = buildSessionCommand({ ...args, repo }, messages);
  const stdout = await deps.run(command, workdir, exec.signal);
  const full = completeOutputText(stdout, messages);
  const stripped = full.trim();
  const id = typeof args["id"] === "string" ? args["id"].trim() : "";
  const action = actionOf(args["action"]);
  let expected: "list" | "show" | "comments" = "list";
  if (id !== "") {
    expected = action === "comments" ? "comments" : "show";
  }
  // comments 空数组是「这个会话没有评论」，不是「没有任何历史会话」。两者都走
  // sessionEmpty 会把一次成功的查询说成没跑过评审；投影解析器已经能表达 total=0。
  if (stripped === "null" || (stripped === "[]" && expected !== "comments")) {
    return {
      sessionOutput: messages.sessionEmpty + deps.note(stdout, messages),
      hint: messages.sessionResumeHint,
    };
  }
  const projected = parseSessionText(full, expected, {
    includeThinking: boolOfArg(args["includeThinking"], "includeThinking", messages),
    commentLimit: commentLimitOf(args["commentLimit"], messages),
  });
  if (projected !== null) {
    return {
      // 投影同样是模型可见的原始输出出口：comments 的 content / existingCode / suggestionCode
      // 与 items 的 error 都可能带着 OCR 回显的密钥或鉴权头；旧路径对短输出做过
      // redactKeyMaterial，这里不能因为换成结构化 JSON 就绕过那道闸。
      sessionOutput: redactKeyMaterial(
        JSON.stringify({ kind: projected.kind, ...projected.value }),
      ),
      hint: messages.sessionResumeHint,
    };
  }
  return {
    sessionOutput: echoRaw(full, RAW_ECHO_LIMIT) + deps.note(stdout, messages),
    hint: messages.sessionResumeHint,
  };
}

async function runSession(
  deps: SessionToolDeps,
  args: Record<string, unknown>,
  exec: ToolExec,
): Promise<unknown> {
  const messages = deps.messages();
  deps.assertPresent(deps.probe(), messages);
  const repo = await deps.resolveRepo(args, exec, messages);
  const action = actionOf(args["action"]);
  const before = typeof args["before"] === "string" ? args["before"].trim() : "";
  const after = typeof args["after"] === "string" ? args["after"].trim() : "";
  if (action === "compare" || (action === "" && (before !== "" || after !== ""))) {
    return runCompare(deps, repo, args, exec, messages);
  }
  if (action === "export") {
    return runExport(deps, repo, args, exec, messages);
  }
  return runProjection(deps, repo, args, exec, messages);
}

/** 注册 `ocr_session`；宿主依赖全部由 deps 注入。 */
export function registerSessionTool(deps: SessionToolDeps): void {
  const messages = deps.messages();
  deps.define({
    name: "ocr_session",
    description: messages.sessionToolDescription,
    parameters: sessionParameters(messages),
    // 同 repo 的两次 ocr_session 会争同一份 sessions JSONL（O_TRUNC） ⇒ 并行不安全。
    concurrencySafe: false,
    schema: SESSION_OUTPUT_SCHEMA,
    run: (args, exec) => runSession(deps, args, exec),
  });
}
