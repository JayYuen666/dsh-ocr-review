// lib/preview-params.ts —— preview 模式下“显式给出但不会生效”的参数清单。
//
// preview 不建 LLM 运行时：effort/provider/model/background 一类只作用于后续 LLM 阶段。
// 这里把它们点名交回调用方，而不是静默丢弃；清单与工具参数表一一对应，新增 LLM-only
// 参数时在这里补一格即可。

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";

/** review preview 下无效的参数；exclude/rule/maxGitProcs/maxTokens 与范围参数仍生效。 */
export const REVIEW_PREVIEW_IGNORED = [
  "effort",
  "provider",
  "model",
  "background",
  "backgroundFile",
  "concurrency",
  "timeoutMinutes",
  "maxTools",
  "maxTokensBudget",
  "noFilter",
] as const;
/** scan preview 下无效的参数；path/exclude/rule/maxGitProcs/maxTokens 仍生效。 */
export const SCAN_PREVIEW_IGNORED = [
  "batch",
  "provider",
  "model",
  "background",
  "concurrency",
  "timeoutMinutes",
  "maxTools",
  "maxTokensBudget",
  "noPlan",
  "noDedup",
  "noSummary",
] as const;

/** 显式给出的无效参数名（undefined/null 是“没给”，不算）。 */
export function ignoredPreviewParams(
  args: Record<string, unknown>,
  names: readonly string[],
): string[] {
  return names.filter((name) => args[name] !== undefined && args[name] !== null);
}

/** 在预览 hint 尾部补一句“这些参数被忽略了”；没有忽略项时原样交回。 */
export function withPreviewIgnoredNote(
  base: string,
  ignored: readonly string[],
  messages: OcrReviewMessages,
): string {
  if (ignored.length === 0) {
    return base;
  }
  return `${base}\n${format(messages.previewIgnoredParams, { params: ignored.join(", ") })}`;
}
