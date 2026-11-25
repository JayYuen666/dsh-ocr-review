import { describe, expect, it } from "vitest";

import { parseSessionText } from "../lib/session-view.ts";

const FLOOR_PATH = "test/floors.ts";

const SUMMARY = {
  session_id: "s1",
  file_path: "/repo/.opencodereview/sessions/abc/s1.jsonl",
  repo_dir: "/repo",
  git_branch: "main",
  model: "claude",
  review_mode: "workspace",
  start_time: "2026-11-17T16:00:00Z",
  end_time: "2026-11-17T16:05:00Z",
  duration_ns: 123_456_789,
  selected_files: 5,
  completed_files: 3,
  failed_files: 1,
  reused_files: 1,
  waived_files: 0,
  total_comments: 4,
  llm_failures: 1,
  aborted: false,
  legacy: false,
  analysis: { enabled: true },
  run_manifest: {
    schema_version: "1",
    operation: "review",
    terminal_state: "completed_with_errors",
    elapsed_ms: 123,
    run_failure: { classification: "provider", reason: "boom" },
    coverage: {
      selected: ["a", "b"],
      completed: ["a"],
      reused: ["b"],
      failed: ["c"],
      waived: [],
      excluded: ["d"],
    },
  },
};

describe("parseSessionText — list", () => {
  it("投影摘要：计数、duration、analysisDir 与 manifest 终态/覆盖度", () => {
    const parsed = parseSessionText(JSON.stringify([SUMMARY]), "list", {
      includeThinking: false,
      commentLimit: 100,
    });
    expect(parsed?.kind).toBe("list");
    if (parsed?.kind !== "list") {
      return;
    }
    expect(parsed.value.sessions).toHaveLength(1);
    expect(parsed.value.sessions[0]).toMatchObject({
      sessionId: "s1",
      filePath: SUMMARY.file_path,
      repoDir: "/repo",
      gitBranch: "main",
      durationMs: 123,
      selectedFiles: 5,
      completedFiles: 3,
      failedFiles: 1,
      reusedFiles: 1,
      totalComments: 4,
      analysisDir: "/repo/.opencodereview/sessions/abc/s1/analysis",
    });
    expect(parsed.value.sessions[0]?.manifest).toStrictEqual({
      schemaVersion: "1",
      operation: "review",
      terminalState: "completed_with_errors",
      elapsedMs: 123,
      runFailure: { classification: "provider", reason: "boom" },
      coverage: { selected: 2, completed: 1, reused: 1, failed: 1, waived: 0, excluded: 1 },
    });
  });

  it("空 file_path 的 analysisDir / 非数组 coverage / 全空 run_failure 都按空值归零", () => {
    const parsed = parseSessionText(
      JSON.stringify([
        {
          ...SUMMARY,
          file_path: "",
          analysis: { enabled: true },
          run_manifest: {
            ...SUMMARY.run_manifest,
            run_failure: {},
            coverage: { selected: "a", completed: 1 },
          },
        },
      ]),
      "list",
      { includeThinking: false, commentLimit: 100 },
    );
    expect(parsed?.kind).toBe("list");
    if (parsed?.kind !== "list") {
      return;
    }
    expect(parsed.value.sessions[0]?.analysisDir).toBeNull();
    expect(parsed.value.sessions[0]?.manifest?.runFailure).toBeNull();
    expect(parsed.value.sessions[0]?.manifest?.coverage).toStrictEqual({
      selected: 0,
      completed: 0,
      reused: 0,
      failed: 0,
      waived: 0,
      excluded: 0,
    });
  });

  it("没有 analysis 的会话不给 analysisDir；坏条目被丢弃而不是伪造", () => {
    const parsed = parseSessionText(
      JSON.stringify([{ ...SUMMARY, analysis: { enabled: false } }, "not-an-object", 3]),
      "list",
      { includeThinking: false, commentLimit: 100 },
    );
    expect(parsed?.kind).toBe("list");
    if (parsed?.kind !== "list") {
      return;
    }
    expect(parsed.value.sessions).toHaveLength(1);
    expect(parsed.value.sessions[0]?.analysisDir).toBeNull();
    expect(parsed.value.sessions[0]?.manifest?.runFailure).toStrictEqual({
      classification: "provider",
      reason: "boom",
    });
  });
});

describe("parseSessionText — show", () => {
  it("items 只保留检查点形状", () => {
    const parsed = parseSessionText(
      JSON.stringify({
        summary: SUMMARY,
        items: [
          {
            type: "done",
            timestamp: "2026-11-17T16:04:54Z",
            file_path: FLOOR_PATH,
            old_path: FLOOR_PATH,
            new_path: FLOOR_PATH,
            comments: 1,
            fingerprint: "deadbeef",
          },
          { type: "error", error: "provider failed" },
          "bad",
        ],
      }),
      "show",
      { includeThinking: false, commentLimit: 100 },
    );
    expect(parsed?.kind).toBe("show");
    if (parsed?.kind !== "show") {
      return;
    }
    expect(parsed.value.items).toStrictEqual([
      {
        type: "done",
        timestamp: "2026-11-17T16:04:54Z",
        filePath: FLOOR_PATH,
        oldPath: FLOOR_PATH,
        newPath: FLOOR_PATH,
        comments: 1,
        error: "",
      },
      {
        type: "error",
        timestamp: "",
        filePath: "",
        oldPath: "",
        newPath: "",
        comments: 0,
        error: "provider failed",
      },
    ]);
  });

  it("run_failure 不是对象时按没有失败归因，不编造 classification", () => {
    const parsed = parseSessionText(
      JSON.stringify({
        summary: { ...SUMMARY, run_manifest: { ...SUMMARY.run_manifest, run_failure: "boom" } },
        items: [],
      }),
      "show",
      { includeThinking: false, commentLimit: 100 },
    );
    expect(parsed?.kind).toBe("show");
    if (parsed?.kind !== "show") {
      return;
    }
    expect(parsed.value.summary.manifest?.runFailure).toBeNull();
  });

  it("summary 缺失 / items 不是数组时判失败", () => {
    expect(
      parseSessionText('{"items":[]}', "show", { includeThinking: false, commentLimit: 1 }),
    ).toBeNull();
    expect(
      parseSessionText('{"summary":{}}', "show", { includeThinking: false, commentLimit: 1 }),
    ).toBeNull();
  });
});

describe("parseSessionText — comments", () => {
  const comments = [
    {
      path: "a.ts",
      content: "空指针风险",
      thinking: "我觉得可能为空",
      severity: "critical",
      category: "bug",
      start_line: 10,
      end_line: 12,
      existing_code: "x := p",
      suggestion_code: "x := p.withDefault()",
    },
    {
      path: "b.ts",
      content: "缺少错误处理",
      severity: "HIGH",
      category: "security",
      start_line: 0,
      end_line: 0,
    },
    {
      path: "c.ts",
      content: "",
      thinking: "",
      severity: "low",
    },
  ];

  it("默认丢弃 thinking、保留正文与归一等级，并报告省略条数", () => {
    const parsed = parseSessionText(JSON.stringify(comments), "comments", {
      includeThinking: false,
      commentLimit: 100,
    });
    expect(parsed?.kind).toBe("comments");
    if (parsed?.kind !== "comments") {
      return;
    }
    expect(parsed.value.total).toBe(2);
    expect(parsed.value.droppedInvalid).toBe(1);
    expect(parsed.value.thinkingOmitted).toBe(1);
    expect(parsed.value.comments[0]).not.toHaveProperty("thinking");
    expect(parsed.value.comments[0]).toMatchObject({
      path: "a.ts",
      content: "空指针风险",
      severity: "critical",
      level: "critical",
      category: "bug",
      startLine: 10,
      endLine: 12,
    });
    expect(parsed.value.comments[1]).toMatchObject({ severity: "HIGH", level: "high" });
  });

  it("没有 path 的评论用 file_path 归一", () => {
    const parsed = parseSessionText(
      JSON.stringify([{ content: "正文" }, { file_path: "b.ts", content: "第二条" }]),
      "comments",
      { includeThinking: false, commentLimit: 100 },
    );
    expect(parsed?.kind).toBe("comments");
    if (parsed?.kind !== "comments") {
      return;
    }
    expect(parsed.value.comments[1]?.path).toBe("b.ts");
  });

  it("comments 首个条目既无 content 也无 path 时按 list 形状返回，不当作评论", () => {
    const parsed = parseSessionText(JSON.stringify([{}]), "comments", {
      includeThinking: false,
      commentLimit: 100,
    });
    expect(parsed?.kind).toBe("list");
  });

  it("includeThinking 与 commentLimit 只影响展示，不影响 total", () => {
    const parsed = parseSessionText(JSON.stringify(comments), "comments", {
      includeThinking: true,
      commentLimit: 1,
    });
    expect(parsed?.kind).toBe("comments");
    if (parsed?.kind !== "comments") {
      return;
    }
    expect(parsed.value.total).toBe(2);
    expect(parsed.value.comments).toHaveLength(1);
    expect(parsed.value.comments[0]?.thinking).toBe("我觉得可能为空");
    expect(parsed.value.thinkingOmitted).toBe(0);
  });

  it("空数组按 expected 区分：comments 与 list 都不伪造条目", () => {
    const parsedComments = parseSessionText("[]", "comments", {
      includeThinking: false,
      commentLimit: 100,
    });
    expect(parsedComments?.kind).toBe("comments");
    if (parsedComments?.kind !== "comments") {
      return;
    }
    expect(parsedComments.value.total).toBe(0);
    expect(parsedComments.value.comments).toHaveLength(0);
    const parsedList = parseSessionText("[]", "list", {
      includeThinking: false,
      commentLimit: 100,
    });
    expect(parsedList?.kind).toBe("list");
    if (parsedList?.kind !== "list") {
      return;
    }
    expect(parsedList.value.sessions).toHaveLength(0);
  });

  it("comments 里的非对象条目计入 droppedInvalid，不伪造评论", () => {
    const parsed = parseSessionText(
      JSON.stringify([{ path: "a.ts", content: "正文" }, "bad", null, 3]),
      "comments",
      {
        includeThinking: false,
        commentLimit: 100,
      },
    );
    expect(parsed?.kind).toBe("comments");
    if (parsed?.kind !== "comments") {
      return;
    }
    expect(parsed.value.total).toBe(1);
    expect(parsed.value.droppedInvalid).toBe(3);
    expect(parsed.value.comments[0]?.content).toBe("正文");
  });

  it("不是 JSON / 顶层是标量都返回 null，让 host 回退到原文", () => {
    expect(
      parseSessionText("not json", "comments", { includeThinking: false, commentLimit: 1 }),
    ).toBeNull();
    expect(
      parseSessionText("42", "comments", { includeThinking: false, commentLimit: 1 }),
    ).toBeNull();
  });
});
