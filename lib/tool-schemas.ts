// 输出 schema 单源：host.ts 只负责注册与执行，schema 的形状与关键字子集在这里维护。
// 所有 schema 必须留在官方子集内（lib/output.ts 的守卫会逐关键字检查）。
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

// 故 review/scan/preview/rule 的根是 oneOf（官方子集表达「多选一」的唯一关键字，
// exact-one 语义），session 的诚实值本来就是对象。
// 可空字段注意：子集是单类型，`string | null` 用 oneOf 表达；直接写 `type:"string"`
// 会在宿主校验里把 null 判成违规。

/** 可空 string 字段的 schema 片段（官方子集单类型，null 分支用 oneOf 表达）。 */
const NULLABLE_STRING = {
  oneOf: [{ type: "string" }, { type: "null" }],
} satisfies JsonSchemaNode;

/** ocr_review / ocr_scan 的 wait=false 回执（startBackground 的返回对象）。 */
const BACKGROUND_RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["started", "mode", "tool", "repo", "processStatus", "jobId", "polling"],
  properties: {
    started: { type: "boolean", const: true },
    mode: { type: "string", const: "background" },
    tool: { type: "string" },
    repo: { type: "string" },
    // ShellProcessStatus（dsh-shell）：注册表收尾后进程的落定态只有这三种。
    processStatus: { type: "string", enum: ["running", "completed", "killed"] },
    // 官方作业 id（ctx.jobs 发号，形如 `ocr-review-<16 位 hex>`）。这是后台评审**一定有结果**
    // 的句柄：`job_output` 按 id 读得到增量 stdout/stderr 与最终结局；而 polling 里
    // 那条 `ocr_session(action=list)` 路线依赖会话已落盘且 --repo 能对上，启动早期
    // 这两件事都可能还不成立，于是模型手里就只剩一个查不出东西的 running 回执。
    jobId: { type: "string" },
    polling: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** summarizeReview(...) 的对象形状（lib/parse.ts 的 ReviewSummaryView，逐字段对齐）。 */
const REVIEW_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "skipped",
    "message",
    "summary",
    "budgetExceeded",
    "limitReached",
    "llm",
    "projectSummary",
    "projectSummaryTruncated",
    "resume",
    "groupCount",
    "retry",
    "traceId",
    "sessionId",
    "aggregation",
    "totalCommentCount",
    "droppedCount",
    "invalidCommentCount",
    "topComments",
    "warnings",
    "toolCalls",
    "coverage",
    "hint",
  ],
  properties: {
    // summarizeReview 只在 parseReviewOutput ok=true 时被调用 ⇒ status 落在白名单内。
    // partial 是 manifest 终态之一（manifest.go:167，exit 0），部分文件失败但整体有覆盖。
    status: {
      type: "string",
      enum: [
        "success",
        "complete",
        "partial",
        "completed_with_warnings",
        "completed_with_errors",
        "skipped",
      ],
    },
    skipped: { type: "boolean" },
    message: NULLABLE_STRING,
    summary: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "filesReviewed",
            "comments",
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "elapsed",
          ],
          properties: {
            // num() 经 nonNegativeInt 收口，返回值恒为非负安全整数；这里仍写 number 是
            // 刻意放宽，解析层将来若调整边界时输出契约不必跟着改。同款字段同理。
            filesReviewed: { type: "number" },
            comments: { type: "number" },
            totalTokens: { type: "number" },
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            cacheReadTokens: { type: "number" },
            cacheWriteTokens: { type: "number" },
            elapsed: { type: "string" },
          },
        },
      ],
    },
    // 被 token 预算截断过：status 只写 partial，说不出「是预算花完才收的工」。
    budgetExceeded: { type: "boolean" },
    // 1.13.3 的 review_limit_reached / scan 的 token_budget_reached：与 budgetExceeded
    // 分开，因为 max tool rounds 触发的那条不是 token 预算。
    limitReached: { type: "boolean" },
    llm: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["provider", "model"],
          properties: {
            provider: NULLABLE_STRING,
            model: { type: "string" },
          },
        },
      ],
    },
    projectSummary: NULLABLE_STRING,
    projectSummaryTruncated: { type: "boolean" },
    groupCount: { type: "integer" },
    retry: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["totalRetries", "recoveredRequests", "failedRequests"],
          properties: {
            totalRetries: { type: "number" },
            recoveredRequests: { type: "number" },
            failedRequests: { type: "number" },
          },
        },
      ],
    },
    traceId: NULLABLE_STRING,
    resume: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["resumedFrom", "reusedFiles", "rerunFiles", "previousModel", "currentModel"],
          properties: {
            resumedFrom: { type: "string" },
            reusedFiles: { type: "number" },
            rerunFiles: { type: "number" },
            previousModel: { type: "string" },
            currentModel: { type: "string" },
          },
        },
      ],
    },
    sessionId: NULLABLE_STRING,
    aggregation: {
      type: "object",
      additionalProperties: false,
      required: ["total", "bySeverity", "byCategory", "unknownSeverityCount"],
      properties: {
        total: { type: "integer" },
        // 未知等级（OCR 自造 blocker / 严重 / 带空白的 "critical "）一律按 medium 归一，
        // 降级必须发生但不该无痕：这个数让契约异常在聚合里看得见，而不是悄悄混进 medium。
        unknownSeverityCount: { type: "integer" },
        bySeverity: {
          type: "object",
          additionalProperties: false,
          required: ["critical", "high", "medium", "low"],
          properties: {
            critical: { type: "integer" },
            high: { type: "integer" },
            medium: { type: "integer" },
            low: { type: "integer" },
          },
        },
        // Record<string, number>：键开放，而官方子集的 additionalProperties 只收布尔
        // ⇒ 开放映射只能声明成无约束对象。
        byCategory: { type: "object" },
      },
    },
    totalCommentCount: { type: "integer" },
    droppedCount: { type: "integer" },
    invalidCommentCount: { type: "integer" },
    topComments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["location", "severity", "category", "content", "suggestion"],
        properties: {
          location: { type: "string" },
          severity: { type: "string" },
          category: { type: "string" },
          content: { type: "string" },
          suggestion: NULLABLE_STRING,
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    // LLM 工具调用统计。`--audience agent` 下 OCR 把进度行写进 io.Discard，
    // "No tool calls parsed" 一类文本永远不会出现在输出里，这个字段是模型侧
    // 「是模型不会调工具，而不是代码没问题」的唯一可见口径。
    toolCalls: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["total", "failure", "failures"],
          properties: {
            total: { type: "integer" },
            failure: { type: "integer" },
            failures: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    // 运行覆盖度（manifest 的五个互斥集合大小 + 失败条目明细）。带 manifest 时 CLI
    // 把子任务失败从 warnings 里摘掉、只由 coverage.failed 承载，两处缺一处就有一半
    // 失败看不见，所以这枚字段与 warnings 必须同时在。
    coverage: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["selected", "completed", "reused", "failed", "waived", "failedItems"],
          properties: {
            selected: { type: "integer" },
            completed: { type: "integer" },
            reused: { type: "integer" },
            failed: { type: "integer" },
            waived: { type: "integer" },
            failedItems: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** preview 文件条目里两个输出共有的四字段（review/scan 的预览与 delegate preview
 *  的文件清单都从这里取，避免两份 additionalProperties:false 各自演进后一边通过、
 *  另一边被守卫拒绝）。 */
const PREVIEW_FILE_FIELDS = {
  path: { type: "string" },
  status: { type: "string" },
  insertions: { type: "number" },
  deletions: { type: "number" },
} satisfies Record<string, JsonSchemaNode>;

const PREVIEW_FILE_REQUIRED = ["path", "status", "insertions", "deletions"] as const;

/** review/scan `preview:true` 的文件清单对象（lib/parse.ts 的 PreviewView）。 */
const PREVIEW_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...PREVIEW_FILE_REQUIRED, "willReview", "excludeReason"],
  properties: {
    ...PREVIEW_FILE_FIELDS,
    willReview: { type: "boolean" },
    excludeReason: { type: "string" },
  },
} satisfies JsonSchemaNode;

const FILE_PREVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "totalFiles",
    "reviewableCount",
    "excludedCount",
    "totalInsertions",
    "totalDeletions",
    "reviewableFiles",
    "excludedFiles",
    "truncated",
    "hint",
  ],
  properties: {
    totalFiles: { type: "number" },
    reviewableCount: { type: "number" },
    excludedCount: { type: "number" },
    totalInsertions: { type: "number" },
    totalDeletions: { type: "number" },
    reviewableFiles: { type: "array", items: PREVIEW_FILE_SCHEMA },
    excludedFiles: { type: "array", items: PREVIEW_FILE_SCHEMA },
    truncated: { type: "boolean" },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** ocr_review / ocr_scan 的输出：wait=false = 后台回执对象；前台成功 = 摘要对象；
 *  preview=true = 文件预览对象；前台解析失败 = 一段诚实的说明字符串。四者恰一。 */
export const REVIEW_OUTPUT_SCHEMA = {
  oneOf: [
    BACKGROUND_RECEIPT_SCHEMA,
    REVIEW_SUMMARY_SCHEMA,
    FILE_PREVIEW_SCHEMA,
    { type: "string" },
  ],
} satisfies JsonSchemaNode;

/** ocr_delegate_preview：成功 = 清单对象；解析失败 = 说明字符串。 */
export const PREVIEW_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "mode",
        "repository",
        "mergeBase",
        "reviewableCount",
        "insertions",
        "deletions",
        "reviewableFiles",
        "excludedFiles",
        "hint",
      ],
      properties: {
        mode: { type: "string" },
        repository: { type: "string" },
        // OCR 端 merge_base 带 omitempty（delegate_cmd.go:263）：缺席落 null。
        mergeBase: NULLABLE_STRING,
        reviewableCount: { type: "integer" },
        // num() 经 nonNegativeInt 收口后恒为整数；写 number 是与 summary 同一条放宽口径。
        insertions: { type: "number" },
        deletions: { type: "number" },
        reviewableFiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [...PREVIEW_FILE_REQUIRED],
            properties: { ...PREVIEW_FILE_FIELDS },
          },
        },
        excludedFiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        hint: { type: "string" },
      },
    },
    { type: "string" },
  ],
} satisfies JsonSchemaNode;

/** ocr_delegate_rule：成功 = 分组对象；解析失败 = 说明字符串。 */
export const RULES_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["groupCount", "groups", "hint"],
      properties: {
        groupCount: { type: "integer" },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "pattern", "files", "rule"],
            properties: {
              source: { type: "string" },
              pattern: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              rule: { type: "string" },
            },
          },
        },
        hint: { type: "string" },
      },
    },
    { type: "string" },
  ],
} satisfies JsonSchemaNode;

/** ocr_session：sessionOutput 本身就是一手透传的字符串（诚实的值），外层仍是对象
 *  好让 hint 有处安放。 */
const SESSION_RAW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionOutput", "hint"],
  properties: {
    sessionOutput: { type: "string" },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

/** compare 的结构化四桶（lib/parse.ts 的 CompareView）。 */
const COMPARE_COMMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["location", "severity", "category", "content"],
  properties: {
    location: { type: "string" },
    severity: { type: "string" },
    category: { type: "string" },
    content: { type: "string" },
  },
} satisfies JsonSchemaNode;

const COMPARE_SIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "reviewMode", "range"],
  properties: {
    sessionId: { type: "string" },
    reviewMode: { type: "string" },
    range: { type: "string" },
  },
} satisfies JsonSchemaNode;

const SESSION_COMPARE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "before",
    "after",
    "new",
    "persisting",
    "resolved",
    "notReviewed",
    "counts",
    "droppedCount",
    "hint",
  ],
  properties: {
    before: COMPARE_SIDE_SCHEMA,
    after: COMPARE_SIDE_SCHEMA,
    new: { type: "array", items: COMPARE_COMMENT_SCHEMA },
    persisting: { type: "array", items: COMPARE_COMMENT_SCHEMA },
    resolved: { type: "array", items: COMPARE_COMMENT_SCHEMA },
    notReviewed: { type: "array", items: COMPARE_COMMENT_SCHEMA },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["new", "persisting", "resolved", "notReviewed"],
      properties: {
        new: { type: "integer" },
        persisting: { type: "integer" },
        resolved: { type: "integer" },
        notReviewed: { type: "integer" },
      },
    },
    droppedCount: { type: "integer" },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;

export const SESSION_OUTPUT_SCHEMA = {
  oneOf: [SESSION_RAW_SCHEMA, SESSION_COMPARE_SCHEMA],
} satisfies JsonSchemaNode;

/** rules check / llm 这类只读文本诊断工具：一手输出 + hint。 */
export const TEXT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["output", "hint"],
  properties: {
    output: { type: "string" },
    hint: { type: "string" },
  },
} satisfies JsonSchemaNode;
