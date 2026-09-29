// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：设置卡的 UI 文案走官方 @deepseek-ai/dsh-client-locale
// （client 侧 `ctx.locale.register(ns, dicts)` 一次交齐两语 + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，工具 description、工具回显、端点回执这些由宿主进程产出的
// 文本只能自带字典；语言取官方 settings 的 `locale.preference`
// （shared 的 resolveLocalePreference），未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 OcrReviewMessages 类型，
// 少键多键都在编译期红。
//
// 插值：卡片侧有官方 `{name}` 插值，host 侧没有，故本文件自带同语法的 format()。
// 只替换 `\w+` 命名的占位符——文案里成对的 `{path, content, ...}` 这类字面花括号
// （非 \w+ 键）因此天然不会被吃掉。
//
// 不在此列的中文（刻意留下，逐条都是数据或读不到的偏好）：
//   - console.* 日志与注释；
//   - 真正进 argv 的值与枚举字面量：language 的「中文/English」（含 host.ts 的 Config
//     联合值与 BUILTIN_BASE 默认值、卡片里那条下拉项的 value）、scope/action 白名单、
//     逗号拼接后进 argv 的路径与模式串；卡片那条下拉项的 label 是语言自称，
//     任何界面语言下「中文」都写作「中文」（见 src/ui-messages.ts 头注释）；
//   - host.ts resolveHost 的装载期守卫：此刻 settings 面还没验过，语言偏好无从读取。
// lib/cli.ts 与 lib/output.ts 里被迁走的只是**拒绝理由那半句人话**：shq() 转义、
// 白名单钳制与 key 脱敏的调用位置一字未动，各道校验闸的先后次序也没变。
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案。 */
export interface OcrReviewMessages {
  // ── shell 执行回显 ────────────────────────────────────────────────────────
  /** 失败详情超 800 字符时的中段省略标记。 */
  readonly middleEllipsis: string;
  /** 前台超时（含实际生效分钟数）。 */
  readonly execTimedOut: string;
  /** 调用被取消。 */
  readonly execAborted: string;
  /** exit 127：外部 ocr CLI 未安装。 */
  readonly execNotFound: string;
  /** 非零退出（不含详情）。 */
  readonly execFailed: string;
  /** 详情前的分隔符（中文全角冒号、英文半角冒号 + 空格）。 */
  readonly detailSeparator: string;
  /** stdout 触到字节上限的说明。 */
  readonly stdoutTruncated: string;
  /** 截断后完整输出的落盘位置。 */
  readonly outputSpill: string;
  /** 后台模式的轮询指引（ocr_session 三步）。 */
  readonly backgroundPolling: string;
  // ── 官方作业面（ctx.jobs）：写进模型可见 detail / 环里的说明 ──────────────
  /** 工具调用被中止时 `job_kill` 的理由（模型侧 job_output 读得到）。 */
  readonly jobReasonAborted: string;
  /** 兜底 deadline 到点时 `job_kill` 的理由。 */
  readonly jobReasonTimeout: string;
  /** 插件卸载时 `job_kill` 的理由。 */
  readonly jobReasonUnload: string;
  /** 源读失败一次时进环的一次性说明（不宣称丢了字节：下一拍可能原样续上）。 */
  readonly jobOutputGap: string;
  // ── 入参闸与输出守卫（host 侧）────────────────────────────────────────────
  readonly requiredNotArray: string;
  readonly requiredItemNotString: string;
  readonly argsMustBeObject: string;
  readonly missingRequiredArgs: string;
  readonly bodyMustBeObject: string;
  readonly outputFileMissing: string;
  /** describe() 之后 settings 服务被卸载（createGateway 的降级出口）。 */
  readonly settingsServiceGone: string;
  // ── 命令构造层的入参拒绝理由（lib/cli.ts 消费本表）──────────────────────────
  /** repo 缺失/空串。 */
  readonly repoRequired: string;
  /** repo 缺失且当前会话工作区也不可知。 */
  readonly repoRequiredUnknownWorkspace: string;
  /** repo 不是绝对路径（点名收到的值）。 */
  readonly repoMustBeAbsolute: string;
  /** 任意字符串参数里出现 NUL 字节。 */
  readonly noNulBytes: string;
  /** 字符串标量参数错类型（点名参数与收到的形态）。 */
  readonly mustBeString: string;
  /** 数组型参数的元素错类型。 */
  readonly listItemsMustBeString: string;
  /** 数组型参数既不是字符串也不是数组。 */
  readonly mustBeStringOrList: string;
  /** 数值 flag 非整数或越界（点名 flag 与下限）。 */
  readonly intFlagMustBeInt: string;
  /** branch 与 commit 同时给出。 */
  readonly scopeBranchCommitExclusive: string;
  /** branch 模式缺 from 或 to。 */
  readonly branchNeedsFromAndTo: string;
  /** commit 模式缺 commit 值。 */
  readonly commitNeedsValue: string;
  /** scope 白名单外。 */
  readonly unknownScope: string;
  /** delegate rule 的 paths 为空。 */
  readonly pathsRequired: string;
  /** session action 白名单外（点名期望值）。 */
  readonly invalidAction: string;
  // ── 工具返回形态守卫（lib/output.ts 消费本表）───────────────────────────────
  /** 返回值不符合该工具的 output schema（violation 明细列表）。 */
  readonly resultSchemaViolation: string;
  /** 守卫不支持 schema 里的某个关键字（插件内 bug：关键字子集没跟上 schema）。 */
  readonly resultSchemaUnsupported: string;
  // ── 解析结果回显（lib/parse.ts 消费本表）───────────────────────────────────
  readonly ocrNotJson: string;
  readonly ocrNotObject: string;
  readonly ocrStatusInvalid: string;
  /** status 缺失时的占位。 */
  readonly statusNone: string;
  readonly ocrCommentsNotArray: string;
  /** warnings 里 `{file,error}` 两条的连接器。 */
  readonly warningSeparator: string;
  readonly reviewSummaryHint: string;
  readonly lineZeroNote: string;
  /** 工具回显：解析失败（带解析器给出的原因）。 */
  readonly parseFailedWithReason: string;
  /** 工具回显：解析失败（delegate 两工具，无原因）。 */
  readonly parseFailedPlain: string;
  // ── provider 配置通道（lib/ocr-config.ts 消费本表）─────────────────────────
  readonly sourceSettingsUnavailable: string;
  readonly sourceSettingsFailed: string;
  readonly sourceNamespaceUnavailable: string;
  readonly sourceCredentialsUnavailable: string;
  readonly badEnvKey: string;
  readonly configNotJson: string;
  readonly configNotObject: string;
  readonly providerNotInList: string;
  readonly modelNotInList: string;
  readonly ocrConfigPathInvalid: string;
  readonly noApiKeyEnv: string;
  readonly keyNotResolvable: string;
  readonly credScriptMissing: string;
  // ── 端点回显 ──────────────────────────────────────────────────────────────
  readonly providerModelRequired: string;
  readonly bodyParseFailed: string;
  // ── 五个工具的 description ────────────────────────────────────────────────
  readonly reviewToolDescription: string;
  readonly scanToolDescription: string;
  readonly previewToolDescription: string;
  readonly ruleToolDescription: string;
  readonly sessionToolDescription: string;
  // ── 工具参数 description ───────────────────────────────────────────────────
  readonly paramRepo: string;
  readonly paramScope: string;
  readonly paramCommit: string;
  readonly paramFrom: string;
  readonly paramTo: string;
  readonly paramCommitShort: string;
  readonly paramFromShort: string;
  readonly paramToShort: string;
  readonly paramEffort: string;
  readonly paramBackground: string;
  readonly paramBackgroundShort: string;
  readonly paramBackgroundPreview: string;
  readonly paramExclude: string;
  readonly paramExcludeShort: string;
  readonly paramWait: string;
  readonly paramProvider: string;
  readonly paramModel: string;
  readonly paramResume: string;
  readonly paramScanPath: string;
  readonly paramBatch: string;
  readonly paramPaths: string;
  readonly paramSessionAction: string;
  readonly paramSessionId: string;
  readonly paramSessionLimit: string;
  /** tuningParams 的「组」量词（OCR review 以组为单位）。 */
  readonly unitGroup: string;
  /** tuningParams 的「文件」量词（OCR scan 以文件为单位）。 */
  readonly unitFile: string;
  readonly tuningConcurrency: string;
  readonly tuningTimeout: string;
  readonly tuningMaxTools: string;
  readonly tuningMaxTokens: string;
  readonly tuningMaxTokensBudget: string;
  // ── 工具结果里的 hint ─────────────────────────────────────────────────────
  readonly previewHint: string;
  readonly ruleHint: string;
  readonly sessionEmpty: string;
  readonly sessionTruncated: string;
  readonly sessionResumeHint: string;
  // ── systemPrompt 注入段 ───────────────────────────────────────────────────
  readonly routingText: string;
}

export const MESSAGES: MessagesCatalog<OcrReviewMessages> = {
  zh: {
    middleEllipsis: " …[中间省略]… ",
    execTimedOut:
      "ocr 执行超时（实际生效 {minutes} 分钟 = min(请求, shell.maxTimeoutMs)）：" +
      "请缩小审查范围（exclude/--commit/更小改动）、调低 OCR 每组 --timeout，" +
      "调大 settings.yaml shell.maxTimeoutMs，或改用 wait=false 后台模式（无超时）",
    execAborted: "ocr 执行被中止",
    execNotFound:
      "ocr 命令不存在：请先 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review`",
    execFailed: "ocr 执行失败（exit={exitCode}）",
    detailSeparator: "：",
    stdoutTruncated: "[ocr-review] 注意：输出超过 {limit} 字节上限已截断{spill}",
    outputSpill: "（完整输出已落盘：{path}）",
    backgroundPolling:
      "稍候用 ocr_session(action=list) 找本仓库最新会话（启动几秒后出现，按 scanPaths/时间匹配）；" +
      "completed_files == selected_files 即已完成；再 ocr_session(action=comments, id) 取全部评论、" +
      "ocr_session(action=show, id) 看元数据与逐文件检查点。后台运行不设宿主超时，只在 2 小时" +
      "后兜底回收（挂死不动会一直占着官方作业桶），取消本工具调用即终止该后台 OCR" +
      "（宿主 kill + 命令内回收守护）。",
    jobReasonAborted: "ocr-review 工具调用被中止",
    jobReasonTimeout: "ocr-review 后台评审超过 2 小时，兜底回收",
    jobReasonUnload: "ocr-review 插件卸载",
    jobOutputGap: "\n[ocr-review] 注意：有一次输出读取失败，已按原游标重试（这段可能不完整）",
    requiredNotArray: "parameters.required 必须是字符串数组",
    requiredItemNotString: "parameters.required 元素必须是字符串",
    argsMustBeObject: "ocr {name}: 入参必须是 JSON 对象（收到 {received}）",
    missingRequiredArgs: "ocr {name}: 缺少必填参数 {keys}（缺失即拒绝，不产生副作用）",
    bodyMustBeObject: "body 必须是 JSON 对象",
    outputFileMissing:
      "ocr 未写出 --output 文件（{path}）：{cause}——请确认 ocr 版本支持 --output，或用 ocr_session 查询会话结果",
    settingsServiceGone: "{ns} 所在的设置服务在读取过程中已不可用",
    repoRequired: "repo 必填，且为 Git 仓库绝对路径",
    repoRequiredUnknownWorkspace: "repo 必填：当前会话工作区未知，请显式传入 Git 仓库绝对路径",
    repoMustBeAbsolute: "repo 必须是绝对路径（以 / 开头）：{root}",
    noNulBytes: "{name} 不能包含 NUL 字节",
    mustBeString: "{name} 必须是字符串（收到 {received}）",
    listItemsMustBeString: "{name} 数组元素必须是字符串",
    mustBeStringOrList: "{name} 必须是字符串或字符串数组",
    intFlagMustBeInt: "{flag} 需要为 ≥{min} 的整数，收到 {received}",
    scopeBranchCommitExclusive: "scope=branch/from/to 与 commit 互斥（一次只能选一种审查范围）",
    branchNeedsFromAndTo: "scope=branch 需要同时提供 from 与 to",
    commitNeedsValue: "scope=commit 需要 commit 参数",
    unknownScope: "未知 scope：{scope}（workspace/commit/branch）",
    pathsRequired: "paths 必填：至少传一个待审查文件的仓库相对路径",
    invalidAction: "action 非法：{action}（期望 {expected}）",
    resultSchemaViolation: "ocr {tool}: 返回值不符合该工具的 output schema：{violations}",
    resultSchemaUnsupported:
      "ocr {tool}: 返回形态守卫不支持 output schema 关键字 {keyword}（插件内 bug：lib/output.ts 的关键字子集没跟上 schema）",
    ocrNotJson: "OCR 未返回合法 JSON 输出",
    ocrNotObject: "OCR JSON 输出不是对象",
    ocrStatusInvalid:
      "OCR 输出 status 非法或缺失：{status}（期望 {expected}）；" +
      "exit 0 不代表评审完成，请查 stderr 与 ~/.opencodereview/sessions/",
    statusNone: "（无）",
    ocrCommentsNotArray: "OCR 输出 comments 字段不是数组，无法确认评论完整性",
    warningSeparator: "：",
    reviewSummaryHint:
      "完整评论与逐文件失败详情请用 `ocr session show <session_id>` 查看；start_line=0 表示 OCR 未能锚定行号，" +
      "可依据 suggestion/existing_code 在文件中定位。" +
      "判读口径：droppedCount 与 invalidCommentCount 同时为 0 时本摘要才覆盖 OCR 的全部产出；" +
      "否则请调大 maxComments（或置 0 = 不截断）后复核，切勿把「本摘要无 critical」当作「代码干净」。",
    lineZeroNote: "(line 0: 定位失败，按 existing_code 手动定位)",
    parseFailedWithReason:
      "{tool} 输出解析失败：{message}\n原始内容前 {limit} 码元（已脱敏）：\n{raw}",
    parseFailedPlain: "{tool} 输出解析失败\n原始内容前 {limit} 码元（已脱敏）：\n{raw}",
    sourceSettingsUnavailable:
      "dsh 设置服务（ctx.settings）未装配：本插件需要它读取已配置的 provider 列表",
    sourceSettingsFailed: "调用 dsh 设置服务失败：{message}",
    sourceNamespaceUnavailable:
      "dsh 配置里没有 {ns} 命名空间：未安装 pi-ai 适配器，或还没配置任何 provider",
    sourceCredentialsUnavailable:
      "dsh 凭据服务（ctx.credentials）未装配：无法确认 provider 的 API key 是否已配置",
    badEnvKey: "非法 env key：{key}",
    configNotJson:
      "{where} 不是合法 JSON，已中止写入以保护既有配置（请先修复或删掉该文件）：{cause}",
    configNotObject: "{where} 顶层不是 JSON 对象，已中止写入以保护既有配置",
    providerNotInList: "provider 不在 dsh 配置的 {ns}.providers 列表：{provider}",
    modelNotInList: "model 不在 {provider} 的 models 列表中：{model}",
    ocrConfigPathInvalid: "设置项 ocrConfigPath 必须是绝对路径或 ~ 开头的路径：{path}",
    noApiKeyEnv:
      "provider {provider} 未声明 apiKeyEnv，无法动态读取 key（OCR 自定义 provider 不支持无 key 解析）",
    keyNotResolvable: "provider {provider} 的 API key 未配置：dsh 凭据服务未解析到 {ref}",
    credScriptMissing: "get-cred 脚本缺失：{path}（api_key_cmd 无法工作）",
    providerModelRequired: "provider 与 model 必填",
    bodyParseFailed: "body 解析失败：{message}",
    reviewToolDescription:
      "用 open-code-review（ocr）对 Git 变更做深度学习代码审查：OCR 调用其自身配置的 LLM（provider/model 在 ocr-review 设置卡选择）独立审查，返回按严重度/类别聚合的评论摘要。scope=workspace 审工作区 staged+unstaged+untracked 变更（默认）；scope=commit 审单个提交；scope=branch 用从/到分支对比（merge-base）。常用先 ocr_delegate_preview 看范围。effort 控制深度（low=1 轮/medium=2/high=3，越深越贵）。background 提供需求/业务上下文能显著提升质量。首次审查前确保 ocr 已配置且 'ocr llm test' 通过。",
    scanToolDescription:
      "用 open-code-review（ocr）做全文件扫描审查（无需 Git 变更/无 diff，适合审计陌生代码库或指定目录）。--path 逗号分隔的仓库相对目录/文件（缺省整个仓库）。与 ocr_review 一样由 OCR 自身 LLM 独立审查，返回聚合评论摘要。",
    previewToolDescription:
      "open-code-review 委托模式第 1 步：列出待审查文件清单（mode/ref/merge_base/reviewable 文件路径+状态+增删行/被排除文件及原因），不调 LLM、秒级返回。用于确认 ocr_review/ocr_scan 的审查范围，或配合 ocr_delegate_rule 后由你自己（dsh 会话模型）读取 diff 完成审查。scope 与 ocr_review 一致（workspace/commit/branch）。",
    ruleToolDescription:
      "open-code-review 委托模式第 2 步：按文件路径返回适配的审查规则（按规则内容分组，共享规则的多个文件归一组）。把 ocr_delegate_preview 得到的 reviewable 路径传进来，作为你自己审查时的检查清单。规则文本较长时按批传入。",
    sessionToolDescription:
      "查询 open-code-review 的历史评审会话：action=list 列最近会话（含 session_id/mode/model/评论数，可用于 ocr_review --resume 恢复中断的评审）；action=show 查看单个会话元数据与逐文件检查点；action=comments 取单个会话的评论明细。session_id 也可从 ocr_review/ocr_scan 的返回结果直接获取。",
    paramRepo: "Git 仓库绝对路径（可选：缺省=当前会话工作区）",
    paramScope: "审查范围（缺省 workspace）",
    paramCommit: "scope=commit 时必填：提交哈希",
    paramFrom: "scope=branch 时必填：对比起点 ref（如 main）",
    paramTo: "scope=branch 时必填：对比终点 ref（如 feature/x）",
    paramCommitShort: "scope=commit 时必填",
    paramFromShort: "scope=branch 时必填",
    paramToShort: "scope=branch 时必填",
    paramEffort: "投入档位（缺省 medium）",
    paramBackground:
      "需求/业务上下文（官方 skill 推荐：调用前先用 git log/diff/提交信息快速分析变更意图，提取 3-5 句业务背景传入，是提升评审质量最有效的参数；从其它 agent 调用时始终携带 PR 描述/需求）",
    paramBackgroundShort: "需求/业务上下文",
    paramBackgroundPreview: "业务上下文（会出现在输出中供审查参考）",
    paramExclude: "gitignore 风格排除模式（可多值）",
    paramExcludeShort: "排除模式",
    paramWait:
      "true（缺省）=等待完成并返回聚合摘要；false=后台启动立即返回（2 小时后兜底回收），用 ocr_session 轮询结果。两种模式都带宿主回收守护：dsh 退出（含 kill -9）时 OCR 进程一并结束",
    paramProvider: "本次运行临时指定已配置 provider",
    paramModel: "本次运行临时覆盖 model",
    paramResume: "从之前中断的会话 id 恢复（会话 id 在返回结果里）",
    paramScanPath: "仓库相对目录或文件（缺省整仓，可多值）",
    paramBatch: "分批策略",
    paramPaths: "待查询的仓库相对文件路径（至少 1 个，最多 200）",
    paramSessionAction: "list：列最近会话（缺省）/ show：查看单个 / comments：取评论",
    paramSessionId: "action=show/comments 时的会话 id",
    paramSessionLimit: "list 上限 1-100（缺省 10）",
    unitGroup: "组",
    unitFile: "文件",
    tuningConcurrency: "并发{unit}数（OCR --concurrency；缺省不传=OCR 原生 8）",
    tuningTimeout: "每{unit}任务超时分钟（OCR --timeout；0=不限时；缺省不传=OCR 原生 15）",
    tuningMaxTools: "每{unit}工具调用轮数上限（OCR --max-tools；0=模板默认；缺省不传=模板默认）",
    tuningMaxTokens:
      "每{unit}提示词 token 上限（OCR --max-tokens；0=配置/模板默认；缺省不传=模板默认）",
    tuningMaxTokensBudget:
      "本次运行 total token（input+output）预算闸门，超出即停止派发部分结果（OCR --max-tokens-budget；0=不限；缺省不传=不限）",
    previewHint:
      "对每个 reviewable 文件：用 git diff <merge_base>..<to> -- <path>（branch）/" +
      "git show <commit> -- <path>（commit）/ git diff HEAD -- <path> 或直接读文件（workspace 新文件）取 diff。",
    ruleHint:
      "按分组规则逐个审查对应文件，输出评论建议格式：{path, content, start_line, end_line, category, severity}。",
    sessionEmpty: "（暂无历史评审会话：先跑一次 ocr_review/ocr_scan 再查询）",
    sessionTruncated: "…[截断] 完整内容见 ~/.opencodereview/sessions/",
    sessionResumeHint:
      "要恢复中断的区间/commit 评审：ocr_review ... --resume <session_id>（工作区评审不支持恢复）。",
    routingText: `
- 用户要求「审查代码/Review/检查我的改动/审这个 commit/PR」时，用 ocr 工具做代码审查：
  - ocr_review：OCR 用自己配置的 LLM 独立审查工作区/commit/分支变更（effort 控制深度，可给 background 上下文）。
  - ocr_scan：对无 git 历史的目录或指定路径做全文件审查。
  - ocr_delegate_preview / ocr_delegate_rule：只取「文件清单 + 适配规则」的确定性脚手架（OCR 端零 LLM 消耗），
    配合 git diff 由你自己完成审查——适合复用本会话模型能力、或先确认审查范围再决定是否跑 ocr_review。
  - 审查前若不确定范围，先 ocr_delegate_preview（不花 token）；范围过大时用 exclude 收敛或按 commit 拆。
- OCR 端点/provider/model 由「设置 → 插件 → ocr-review 卡片」从 dsh 的 settings.yaml providers 选择；
  也可在工具参数里用 --provider/--model 临时覆盖。
- 调用 ocr_review / ocr_scan 前，先用 git log/diff/提交信息快速分析变更意图，提取 3-5 句业务上下文
  传入 background（open-code-review 官方 skill 明确推荐"始终携带"，是质量提升最有效的单一参数）。
- 若 ocr_review/ocr_scan 输出含 "No tool calls parsed" 或大量 "Max tool requests reached"，
  是当前模型的工具调用能力问题——建议在 ocr-review 卡片换一个支持原生工具调用的模型（sensenova、deepseek、glm、qwen 系），
  不要反复重试同一个模型。
- LLM 调用本身有重试：OCR 内置重试（429/408/409 与 5xx 自动退避重试）；per-file 组失败被隔离并进 warnings，不整体重跑。
  工具层超时（10 分钟）或部分文件失败后，可 ocr_session 查 session_id、用 ocr_review --resume 恢复中断的区间/commit 评审。
`.trim(),
  },
  en: {
    middleEllipsis: " …[middle omitted]… ",
    execTimedOut:
      "ocr timed out (effective {minutes} min = min(request, shell.maxTimeoutMs)): " +
      "narrow the review scope (exclude / --commit / a smaller diff), lower OCR's per-group --timeout, " +
      "raise shell.maxTimeoutMs in settings.yaml, or switch to background mode with wait=false (no timeout)",
    execAborted: "ocr execution aborted",
    execNotFound:
      "ocr command not found: install it first with `brew install open-code-review` or `npm i -g @alibaba-group/open-code-review`",
    execFailed: "ocr failed (exit={exitCode})",
    detailSeparator: ": ",
    stdoutTruncated:
      "[ocr-review] note: output exceeded the {limit}-byte cap and was truncated{spill}",
    outputSpill: " (full output spilled to {path})",
    backgroundPolling:
      "Look up this repository's newest session shortly with ocr_session(action=list) (it appears a few " +
      "seconds after start; match by scanPaths/time); completed_files == selected_files means it is done. " +
      "Then ocr_session(action=comments, id) for all comments and ocr_session(action=show, id) for metadata " +
      "and per-file checkpoints. Background runs get reclaimed by a 2-hour backstop (a wedged one would " +
      "otherwise keep occupying the official job bucket); cancelling this tool call terminates " +
      "the background OCR (host kill + the reaper guard inside the command).",
    jobReasonAborted: "ocr-review tool call aborted",
    jobReasonTimeout: "ocr-review background review exceeded 2 hours and was reclaimed",
    jobReasonUnload: "ocr-review plugin unloaded",
    jobOutputGap:
      "\n[ocr-review] note: one output read failed and was retried from the same offset (this stretch " +
      "may be incomplete)",
    requiredNotArray: "parameters.required must be an array of strings",
    requiredItemNotString: "parameters.required items must be strings",
    argsMustBeObject: "ocr {name}: arguments must be a JSON object (got {received})",
    missingRequiredArgs:
      "ocr {name}: missing required parameter(s) {keys} (rejected outright, no side effects)",
    bodyMustBeObject: "body must be a JSON object",
    outputFileMissing:
      "ocr did not write the --output file ({path}): {cause} — check that your ocr version supports --output, or query the session with ocr_session",
    settingsServiceGone: "the settings service holding {ns} became unavailable while being read",
    repoRequired: "repo is required and must be the absolute path of a Git repository",
    repoRequiredUnknownWorkspace:
      "repo is required: the current session workspace is unknown, pass the absolute path of a Git repository explicitly",
    repoMustBeAbsolute: "repo must be an absolute path (starting with /): {root}",
    noNulBytes: "{name} must not contain NUL bytes",
    mustBeString: "{name} must be a string (got {received})",
    listItemsMustBeString: "the items of {name} must be strings",
    mustBeStringOrList: "{name} must be a string or an array of strings",
    intFlagMustBeInt: "{flag} must be an integer ≥ {min}, got {received}",
    scopeBranchCommitExclusive:
      "scope=branch/from/to and commit are mutually exclusive (only one review scope at a time)",
    branchNeedsFromAndTo: "scope=branch requires both from and to",
    commitNeedsValue: "scope=commit requires the commit parameter",
    unknownScope: "unknown scope: {scope} (workspace/commit/branch)",
    pathsRequired: "paths is required: pass at least one repo-relative path of a file to review",
    invalidAction: "invalid action: {action} (expected {expected})",
    resultSchemaViolation:
      "ocr {tool}: the tool result does not match its output schema: {violations}",
    resultSchemaUnsupported:
      "ocr {tool}: the result guard does not support the output schema keyword {keyword} (plugin bug: the keyword subset in lib/output.ts lags the schema)",
    ocrNotJson: "OCR returned no valid JSON output",
    ocrNotObject: "the OCR JSON output is not an object",
    ocrStatusInvalid:
      "OCR output has an invalid or missing status: {status} (expected {expected}); " +
      "exit 0 does not mean the review completed — check stderr and ~/.opencodereview/sessions/",
    statusNone: "(none)",
    ocrCommentsNotArray:
      "the comments field of the OCR output is not an array, comment completeness cannot be confirmed",
    warningSeparator: ": ",
    reviewSummaryHint:
      "Use `ocr session show <session_id>` for the full comments and per-file failure details; start_line=0 " +
      "means OCR could not anchor a line — locate it via suggestion/existing_code. " +
      "How to read this summary: only when droppedCount and invalidCommentCount are both 0 does it cover " +
      "everything OCR produced; otherwise raise maxComments (or set 0 = no truncation) and re-check — " +
      'never treat "no critical in this summary" as "the code is clean".',
    lineZeroNote: "(line 0: not anchored, locate it via existing_code)",
    parseFailedWithReason:
      "{tool} output parsing failed: {message}\nfirst {limit} UTF-16 code units of the raw output (redacted):\n{raw}",
    parseFailedPlain:
      "{tool} output parsing failed\nfirst {limit} UTF-16 code units of the raw output (redacted):\n{raw}",
    sourceSettingsUnavailable:
      "the dsh settings service (ctx.settings) is not wired up: this plugin needs it to read the configured provider list",
    sourceSettingsFailed: "calling the dsh settings service failed: {message}",
    sourceNamespaceUnavailable:
      "the dsh configuration has no {ns} namespace: the pi-ai adapter is not installed, or no provider is configured yet",
    sourceCredentialsUnavailable:
      "the dsh credentials service (ctx.credentials) is not wired up: cannot confirm whether a provider's API key is configured",
    badEnvKey: "invalid env key: {key}",
    configNotJson:
      "{where} is not valid JSON; the write was aborted to protect the existing configuration (fix or delete that file first): {cause}",
    configNotObject:
      "the top level of {where} is not a JSON object; the write was aborted to protect the existing configuration",
    providerNotInList: "provider is not in the {ns}.providers list configured by dsh: {provider}",
    modelNotInList: "model is not in the models list of {provider}: {model}",
    ocrConfigPathInvalid: "the ocrConfigPath setting must be absolute or start with ~: {path}",
    noApiKeyEnv:
      "provider {provider} declares no apiKeyEnv, so the key cannot be read dynamically (OCR custom providers do not support keyless resolution)",
    keyNotResolvable:
      "the API key of provider {provider} is not configured: the dsh credentials service resolved no {ref}",
    credScriptMissing: "get-cred script missing: {path} (api_key_cmd cannot work)",
    providerModelRequired: "provider and model are both required",
    bodyParseFailed: "failed to parse the body: {message}",
    reviewToolDescription:
      "Deep code review of Git changes with open-code-review (ocr): OCR runs its own configured LLM " +
      "(provider/model picked in the ocr-review settings card) as an independent reviewer and returns " +
      "comments aggregated by severity/category. scope=workspace reviews staged+unstaged+untracked " +
      "changes (default); scope=commit reviews one commit; scope=branch compares from/to branches " +
      "(merge-base). Commonly start with ocr_delegate_preview to see the scope. effort controls depth " +
      "(low=1 pass / medium=2 / high=3, deeper costs more). Passing requirements/business context via " +
      "background markedly improves quality. Before the first review make sure ocr is configured and " +
      "'ocr llm test' passes.",
    scanToolDescription:
      "Whole-file scan review with open-code-review (ocr) — no Git changes or diff required, good for " +
      "auditing an unfamiliar repository or given directories. --path takes comma-separated repo-relative " +
      "directories/files (default: the whole repo). Like ocr_review, OCR's own LLM reviews independently " +
      "and an aggregated comment summary is returned.",
    previewToolDescription:
      "Step 1 of open-code-review delegate mode: list the files to review (mode/ref/merge_base/reviewable " +
      "path+status+added/removed lines, plus excluded files and why). No LLM call, returns in seconds. Use " +
      "it to confirm the scope of ocr_review/ocr_scan, or together with ocr_delegate_rule to review the " +
      "diffs yourself (the dsh session model). scope matches ocr_review (workspace/commit/branch).",
    ruleToolDescription:
      "Step 2 of open-code-review delegate mode: return the review rules that fit the given file paths " +
      "(grouped by rule content; files sharing a rule land in one group). Feed the reviewable paths from " +
      "ocr_delegate_preview and use the rules as your own review checklist. Pass paths in batches when " +
      "the rule text is long.",
    sessionToolDescription:
      "Query open-code-review's past review sessions: action=list shows recent sessions (session_id/mode/" +
      "model/comment counts, usable for ocr_review --resume of interrupted reviews); action=show prints one " +
      "session's metadata and per-file checkpoints; action=comments returns one session's comment details. " +
      "session_id is also returned by ocr_review/ocr_scan.",
    paramRepo:
      "Absolute path to the Git repository (optional: default = current session workspace)",
    paramScope: "Review scope (default workspace)",
    paramCommit: "Required with scope=commit: commit hash",
    paramFrom: "Required with scope=branch: comparison start ref (e.g. main)",
    paramTo: "Required with scope=branch: comparison end ref (e.g. feature/x)",
    paramCommitShort: "Required with scope=commit",
    paramFromShort: "Required with scope=branch",
    paramToShort: "Required with scope=branch",
    paramEffort: "Effort level (default medium)",
    paramBackground:
      "Requirements/business context (official skill recommends: analyse the change intent via git " +
      "log/diff/commit messages first and pass 3-5 sentences of context — the single most effective " +
      "parameter for review quality; always carry the PR description/requirements when called from " +
      "another agent)",
    paramBackgroundShort: "Requirements/business context",
    paramBackgroundPreview: "Business context (it shows up in the output for review reference)",
    paramExclude: "gitignore-style exclusion patterns (multiple allowed)",
    paramExcludeShort: "Exclusion patterns",
    paramWait:
      "true (default) = wait for completion and return the aggregated summary; false = start in the " +
      "background and return immediately (a 2-hour backstop reclaims it), poll with ocr_session. Both " +
      "modes carry the host reaper guard: when dsh exits (including kill -9) the OCR process is terminated too",
    paramProvider: "Temporarily use a configured provider for this run",
    paramModel: "Temporarily override the model for this run",
    paramResume: "Resume from a previously interrupted session id (the id is in the result)",
    paramScanPath: "Repo-relative directories or files (default: whole repo, multiple allowed)",
    paramBatch: "Batching strategy",
    paramPaths: "Repo-relative file paths to look up (at least 1, at most 200)",
    paramSessionAction:
      "list: recent sessions (default) / show: one session / comments: comment list",
    paramSessionId: "Session id for action=show/comments",
    paramSessionLimit: "list cap 1-100 (default 10)",
    unitGroup: "group",
    unitFile: "file",
    tuningConcurrency: "Concurrent {unit} count (OCR --concurrency; unset = OCR native 8)",
    tuningTimeout:
      "Per-{unit} task timeout in minutes (OCR --timeout; 0 = unlimited; unset = OCR native 15)",
    tuningMaxTools:
      "Per-{unit} tool-call round cap (OCR --max-tools; 0 = template default; unset = template default)",
    tuningMaxTokens:
      "Per-{unit} prompt token cap (OCR --max-tokens; 0 = config/template default; unset = template default)",
    tuningMaxTokensBudget:
      "Total token (input+output) budget gate for this run; dispatch stops once exceeded (OCR --max-tokens-budget; 0 = unlimited; unset = unlimited)",
    previewHint:
      "For each reviewable file, get its diff with git diff <merge_base>..<to> -- <path> (branch) / " +
      "git show <commit> -- <path> (commit) / git diff HEAD -- <path>, or read the file directly " +
      "(new workspace files).",
    ruleHint:
      "Review the files of each group against its rule and emit comment suggestions in the shape " +
      "{path, content, start_line, end_line, category, severity}.",
    sessionEmpty: "(no review sessions yet: run ocr_review/ocr_scan once before querying)",
    sessionTruncated: "…[truncated] full content in ~/.opencodereview/sessions/",
    sessionResumeHint:
      "To resume an interrupted range/commit review: ocr_review ... --resume <session_id> (workspace reviews cannot be resumed).",
    routingText: `
- When the user asks to "review the code / Review / check my changes / review this commit or PR", use the ocr tools:
  - ocr_review: OCR reviews workspace/commit/branch changes with its own configured LLM (effort controls depth, background carries context).
  - ocr_scan: whole-file review of directories without git history, or of given paths.
  - ocr_delegate_preview / ocr_delegate_rule: deterministic scaffolding that only returns "file list + fitting rules"
    (zero LLM cost on the OCR side); pair it with git diff and review yourself — good for reusing this session's model,
    or for confirming the scope before deciding to run ocr_review.
  - Unsure about the scope? Run ocr_delegate_preview first (costs no tokens); if the scope is huge, narrow it with
    exclude or split by commit.
- The OCR endpoint/provider/model comes from "Settings → Plugins → ocr-review card", fed by dsh's settings.yaml
  providers; --provider/--model can override per call.
- Before ocr_review / ocr_scan, analyse the change intent via git log/diff/commit messages and pass 3-5 sentences of
  business context as background (the official open-code-review skill says "always carry it" — the single most
  effective quality knob).
- If ocr_review/ocr_scan output contains "No tool calls parsed" or many "Max tool requests reached", the current
  model's tool-calling ability is the problem — switch to a model with native tool calls in the ocr-review card
  (sensenova, deepseek, glm, qwen families) instead of retrying the same one.
- LLM calls retry themselves: OCR has built-in backoff retries (429/408/409 and 5xx); per-file group failures are
  isolated and land in warnings instead of re-running everything. After a tool-layer timeout (10 minutes) or partial
  file failures, use ocr_session to find the session_id and ocr_review --resume to continue an interrupted
  range/commit review.
`.trim(),
  },
};

/** format() 的插值参数（调用方负责把值变成文本）。 */
export type MessageParams = Record<string, string>;

/** 花括号占位符（键限 \w+；`{path, content}` 这类字面花括号不匹配）。 */
const PLACEHOLDER = /\{(?<key>\w+)\}/gu;

/**
 * host 半的 `{name}` 插值：与卡片侧官方 Translate 同语法（宿主那份实现在
 * dsh-client-locale 里，host 侧没有 i18n 面，只能自带这一小段）。
 * @param template - 带 `{name}` 占位符的文案模板。
 * @param params - 占位符 → 已字符串化的值；缺项替换为空串（不抛）。
 * @returns 插值后的文本。
 */
export function format(template: string, params: MessageParams): string {
  return template.replaceAll(PLACEHOLDER, (_all: string, key: string) => params[key] ?? "");
}
