// Web Client 工具行：7 个 wire 名由 apply 注册进 keyed slot；组件只从官方
// ToolCallBlock 派生摘要，不读会话状态。这里直接展开函数组件树（无 jsdom）。
import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { OcrToolRow, OCR_TOOLVIEW_NAMES } from "../../src/toolview.ts";
import { UI_MESSAGES } from "../../src/ui-messages.ts";
import type { Translate } from "../../src/ui-messages.ts";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";

const t = ((key: string): string =>
  (UI_MESSAGES.zh as Record<string, string>)[key] ?? key) as Translate;

function expand(node: ReactNode): ReactNode {
  if (!isValidElement(node)) {
    return node;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  return typeof element.type === "function"
    ? expand((element.type as (props: Record<string, unknown>) => ReactNode)(element.props))
    : node;
}

function textOf(node: ReactNode): string {
  const expanded = expand(node);
  if (typeof expanded === "string" || typeof expanded === "number") {
    return String(expanded);
  }
  if (Array.isArray(expanded)) {
    return expanded.map((child) => textOf(child as ReactNode)).join(" ");
  }
  if (isValidElement(expanded)) {
    const { children } = expanded.props as { children?: ReactNode };
    return textOf(children);
  }
  return "";
}

function classNamesOf(node: ReactNode): string[] {
  const expanded = expand(node);
  if (Array.isArray(expanded)) {
    return expanded.flatMap((child) => classNamesOf(child as ReactNode));
  }
  if (!isValidElement(expanded)) {
    return [];
  }
  const props = expanded.props as { className?: string; children?: ReactNode };
  const own = props.className === undefined ? [] : [props.className];
  return [...own, ...classNamesOf(props.children)];
}

const noop = (): void => {
  /* 展示测试不驱动展开状态 */
};

function disclosure(): ReturnType<ToolCallViewProps["useDisclosure"]> {
  return { expanded: false, setExpanded: noop, toggle: noop };
}

const block = {
  kind: "tool-result",
  seq: 1,
  time: 1,
  callId: "call-1",
  name: "ocr_session",
  args: { text: (): undefined => undefined },
  call: {
    name: "ocr_session",
    argsRaw: JSON.stringify({ action: "comments", repo: "/repo", id: "s1" }),
  },
  callTime: 1,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        sessionOutput: JSON.stringify({
          kind: "comments",
          value: { session_id: "s1", items: [1, 2, 3], comments: [{ body: "a" }, { body: "b" }] },
        }),
        hint: "resume",
      }),
    },
  ],
  isError: false,
  subCalls: [],
} as unknown as ToolCallViewProps["block"];

const props = {
  block,
  toolName: "ocr_session",
  phase: "result" as const,
  useDisclosure: disclosure,
  t,
} as unknown as Parameters<typeof OcrToolRow>[0];

const renderRow = OcrToolRow;

describe("ocr Web Client 工具行", () => {
  it("七个 key 与宿主 wire 名逐字一致", () => {
    expect(OCR_TOOLVIEW_NAMES).toStrictEqual([
      "ocr_review",
      "ocr_scan",
      "ocr_session",
      "ocr_delegate_preview",
      "ocr_delegate_rule",
      "ocr_rules_check",
      "ocr_llm",
    ]);
  });

  it("已完成会话行走 shared ToolRow，并从 sessionOutput 里解出键值", () => {
    const element = renderRow(props);
    const html = textOf(element);
    expect(classNamesOf(element)).toContain("dsu-toolrow");
    expect(html).toContain("ocr_session");
    expect(html).toContain("完成");
    expect(html).toContain("repo");
    expect(html).toContain("/repo");
    expect(html).toContain("comments");
    expect(html).toContain("s1");
    expect(html).toContain("3");
    expect(html).toContain("2");
    // 工具行只画摘要，不把 sessionOutput 原文再塞回来。
    expect(html).not.toContain("sessionOutput");
  });

  it("comments 工具行显示截断前的 total，不回退到 comments 数组长度", () => {
    const truncated = renderRow({
      ...props,
      block: {
        ...block,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sessionOutput: JSON.stringify({
                kind: "comments",
                total: 97,
                comments: [{ content: "只有一条被展示" }],
              }),
              hint: "resume",
            }),
          },
        ],
      },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(truncated)).toContain("97");
  });

  it("运行中与失败态只按宿主 phase / isError 着色，不伪造错误原因", () => {
    const running = {
      ...props,
      phase: "start",
      block: {
        kind: "tool-call",
        seq: 1,
        time: 1,
        callId: "call-2",
        name: "ocr_review",
        argsRaw: JSON.stringify({ repo: "/repo", paths: ["a.ts", "b.ts"] }),
        phase: "start",
      },
    } as unknown as Parameters<typeof OcrToolRow>[0];
    const runningElement = renderRow(running);
    expect(textOf(runningElement)).toContain("运行中");
    expect(textOf(runningElement)).toContain("2");

    const failed = { ...props, block: { ...block, isError: true } } as unknown as Parameters<
      typeof OcrToolRow
    >[0];
    const failedElement = renderRow(failed);
    expect(textOf(failedElement)).toContain("失败");
    const tones = classNamesOf(failedElement);
    expect(tones.some((className) => className.includes("dsu-badgeErr"))).toBe(true);
  });

  it("preview 的 dropped 只在非零时出现，且不丢总数", () => {
    const previewBlock = {
      ...block,
      name: "ocr_delegate_preview",
      toolName: "ocr_delegate_preview",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            totalFiles: 5000,
            reviewableCount: 0,
            excludedCount: 5000,
            reviewableDropped: 0,
            excludedDropped: 4000,
          }),
        },
      ],
    } as unknown as ToolCallViewProps["block"];
    const preview = renderRow({
      ...props,
      block: previewBlock,
      toolName: "ocr_delegate_preview",
    } as Parameters<typeof OcrToolRow>[0]);
    const html = textOf(preview);
    expect(html).toContain("5000");
    expect(html).toContain("4000");
    expect(html).toContain("已省略");
  });

  it("review 用 totalCommentCount，不把 topComments 数组长度当成总数", () => {
    const reviewBlock = {
      ...block,
      name: "ocr_review",
      toolName: "ocr_review",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "complete",
            totalCommentCount: 4,
            topComments: [{ content: "a" }, { content: "b" }],
          }),
        },
      ],
    } as unknown as ToolCallViewProps["block"];
    const review = renderRow({
      ...props,
      block: reviewBlock,
      toolName: "ocr_review",
    } as Parameters<typeof OcrToolRow>[0]);
    const html = textOf(review);
    expect(html).toContain("complete");
    expect(html).toContain("4");
    expect(html).not.toContain("2 条评论");
  });

  it("delegate rule 读 host 的 groupCount，不把 groups 数组当成分组数", () => {
    const rule = renderRow({
      ...props,
      toolName: "ocr_delegate_rule",
      block: {
        ...block,
        content: [
          {
            type: "text",
            text: JSON.stringify({ groupCount: 3, groups: [{ files: ["a"] }] }),
          },
        ],
      },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(rule)).toContain("3");
  });

  it("compare 是平铺 canonical 形状，工具行仍能读到四桶 counts", () => {
    const compare = renderRow({
      ...props,
      block: {
        ...block,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              before: { sessionId: "a", reviewMode: "workspace", range: "x" },
              after: { sessionId: "b", reviewMode: "workspace", range: "y" },
              new: [],
              persisting: [],
              resolved: [],
              notReviewed: [],
              counts: { new: 1, persisting: 2, resolved: 3, notReviewed: 0 },
              droppedCount: 0,
              hint: "compare",
            }),
          },
        ],
      },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(compare)).toContain("new 1");
    expect(textOf(compare)).toContain("resolved 3");
  });

  it("host 的 show/comments 投影直接带 sessionId/items；文本型规则与 LLM 不编结构化字段", () => {
    const showContent = JSON.stringify({
      sessionOutput: JSON.stringify({
        kind: "show",
        summary: { sessionId: "s2", repoDir: "/repo" },
        items: [1, 2],
      }),
    });
    const show = renderRow({
      ...props,
      block: { ...block, content: [{ type: "text", text: showContent }] },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(show)).toContain("s2");
    expect(textOf(show)).toContain("2");

    const rules = renderRow({
      ...props,
      toolName: "ocr_rules_check",
      block: {
        ...block,
        content: [{ type: "text", text: JSON.stringify({ output: "rule rows", hint: "read" }) }],
      },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(rules)).not.toContain("rule rows");
    const llm = renderRow({
      ...props,
      toolName: "ocr_llm",
      block: {
        ...block,
        content: [
          { type: "text", text: JSON.stringify({ output: "provider rows", hint: "read" }) },
        ],
      },
    } as Parameters<typeof OcrToolRow>[0]);
    expect(textOf(llm)).not.toContain("provider rows");
  });

  it("非 OCR wire 名返回 null，不抢别的工具的 key", () => {
    expect(renderRow({ ...props, toolName: "bash" })).toBeNull();
  });
});
