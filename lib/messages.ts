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
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案。 */
export interface OcrReviewMessages {
  // ── shell 执行回显 ────────────────────────────────────────────────────────
  /** 失败详情超 800 字符时的中段省略标记。 */
  readonly middleEllipsis: string;
  /** 前台超时（含实际生效分钟数）。 */
  readonly execTimedOut: string;
  /** 调用被取消。 */
  readonly execAborted: string;
  /** exit 127：命令词交下去没被系统找到（候选文件在 fs 判据之后消失了）。 */
  readonly execNotFound: string;
  /** 前置短路的拒绝理由：随包依赖与 PATH 两条路都没有候选，连进程都不起。
   *  与 `execNotFound` 的分工是「找都没找到」对「找到了但跑不起来」，两条都留着。
   *  `{install}` = 下面三条形装法文案之一（host 按来源/部署偏好挑）。 */
  readonly ocrBinaryMissing: string;
  /** 装法文案：两条都给，让用户自己选（部署偏好 `ocrInstallHint=both` 或来源判不出来时用）。 */
  readonly installHintBoth: string;
  /** 装法文案：已判定是 brew 装的，或部署偏好 brew。 */
  readonly installHintBrew: string;
  /** 装法文案：已判定是 npm 全局装的，或部署偏好 npm。 */
  readonly installHintNpm: string;
  /** 工具回显里的版本核对提示（`{actual}`/`{expected}`）：实测与契约核对版本不一致时追加。 */
  readonly versionMismatch: string;
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
  /** 会话被停止/关闭时 `job_kill` 的理由（模型侧 job_output 读得到）。 */
  readonly jobReasonSessionStopped: string;
  /** 兜底 deadline 到点时 `job_kill` 的理由（{minutes} = 实际窗口的分钟数）。 */
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
  /** --output 落盘结果超过读取上限（不整份读进内存）。 */
  readonly outputFileTooLarge: string;
  /** 非零退出时附上 --output 里已发布的 coverage.failed 明细。 */
  readonly failureCoverage: string;
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
  /** 布尔参数收到非布尔值。 */
  readonly boolMustBeBoolean: string;
  /** repo 根目录本身解析不了（不存在/无权限）。 */
  readonly repoRootUnreadable: string;
  /** rule/background-file 指定的文件不存在。 */
  readonly repoFileMissing: string;
  /** rule/background-file 指向 repo 根之外（含符号链接逃逸）。 */
  readonly repoFileOutside: string;
  /** rule/background-file 指向的不是普通文件。 */
  readonly repoFileNotFile: string;
  /** rule/background-file 超过大小上限。 */
  readonly repoFileTooLarge: string;
  /** preview 与显式 wait=false 冲突（预览是秒级前台操作）。 */
  readonly previewNeedsForeground: string;
  /** preview 与 resume 冲突（预览不读写会话）。 */
  readonly previewRejectsResume: string;
  /** 列表取值超上限（{name} 字段名、{dropped} 超出条数、{limit} 上限）。超限整条拒绝，
   *  命令不构造、一条都不审——文案必须把「没有开始」说出口，不能让模型以为已按子集开跑。 */
  readonly listOverLimit: string;
  /** 字符串标量参数错类型（点名参数与收到的形态）。 */
  readonly mustBeString: string;
  /** 数组型参数的元素错类型。 */
  readonly listItemsMustBeString: string;
  /** 数组型参数既不是字符串也不是数组。 */
  readonly mustBeStringOrList: string;
  /** 数值 flag 非整数或越界（点名 flag 与下限）。 */
  readonly intFlagMustBeInt: string;
  /** --format 只支持 json：text/sarif 没有解析层（直连调用方能传进这个不在 schema 里的参数）。 */
  readonly formatNotJson: string;
  /** branch 与 commit 同时给出。 */
  readonly scopeBranchCommitExclusive: string;
  /** branch 模式缺 from 或 to。 */
  readonly branchNeedsFromAndTo: string;
  /** commit 模式缺 commit 值。 */
  readonly commitNeedsValue: string;
  /** scope 白名单外。 */
  readonly unknownScope: string;
  /** scope 与范围参数组合矛盾（例如 scope=workspace 却给了 commit）。 */
  readonly scopeMismatch: string;
  /** resume 与 workspace 同给（OCR 契约：workspace 不支持恢复）。 */
  readonly resumeNeedsScope: string;
  /** wait 非布尔（字符串 "false" 若按真值处理会静默从后台变前台）。 */
  readonly waitMustBeBoolean: string;
  /** delegate rule 的 paths 为空。 */
  readonly pathsRequired: string;
  /** session action 白名单外（点名期望值）。 */
  readonly invalidAction: string;
  /** session limit 显式给出但不是 1-100 整数（不再静默钳制）。 */
  readonly sessionLimitRange: string;
  /** action=list 与 id 同给（自相矛盾，不再静默改写成 show）。 */
  readonly listRejectsId: string;
  // ── 工具返回形态守卫（lib/output.ts 消费本表）───────────────────────────────
  /** 返回值不符合该工具的 output schema（violation 明细列表）。 */
  readonly resultSchemaViolation: string;
  /** 守卫不支持 schema 里的某个关键字（插件内 bug：关键字子集没跟上 schema）。 */
  readonly resultSchemaUnsupported: string;
  /** 工具回显：output schema 自身的形态不合法（插件的代码问题）。 */
  readonly resultSchemaMalformed: string;
  // ── 解析结果回显（lib/parse.ts 消费本表）───────────────────────────────────
  readonly ocrNotJson: string;
  readonly ocrNotObject: string;
  readonly ocrStatusInvalid: string;
  /** status 缺失时的占位。 */
  readonly statusNone: string;
  /** 回执自报 status=failed（全场失败）时的说明。 */
  readonly ocrStatusFailed: string;
  readonly ocrCommentsNotArray: string;
  /** warnings 里 `{file,message}` 两条的连接器。 */
  readonly warningSeparator: string;
  readonly reviewSummaryHint: string;
  readonly lineZeroNote: string;
  /** 工具回显：解析失败（带解析器给出的原因）。 */
  readonly parseFailedWithReason: string;
  /** 工具回显：解析失败（delegate 两工具，无原因）。 */
  readonly parseFailedPlain: string;
  /** 工具回显：--preview 回执不是可识别的文件清单。 */
  readonly previewParseFailed: string;
  /** rules check 的 path 必填。 */
  readonly rulesPathRequired: string;
  /** 只读诊断工具的输出被截断。 */
  readonly textTruncated: string;
  /** 卡片 MCP 配置读不动。 */
  readonly mcpReadFailed: string;
  /** MCP JSON 不是合法 JSON。 */
  readonly mcpJsonInvalid: string;
  /** MCP JSON 超过大小上限。 */
  readonly mcpJsonTooLarge: string;
  /** MCP 顶层必须是「name → entry」对象。 */
  readonly mcpShapeInvalid: string;
  /** MCP server 条数超限。 */
  readonly mcpTooManyServers: string;
  /** 某个 MCP server 条目的字段不合法。 */
  readonly mcpServerInvalid: string;
  /** MCP 保存成功。 */
  readonly mcpSaved: string;
  /** ChatGPT 模型必填。 */
  readonly chatGptModelRequired: string;
  /** ChatGPT 配置写入成功。 */
  readonly chatGptSaved: string;
  /** ChatGPT 配置写入失败。 */
  readonly chatGptSaveFailed: string;
  /** compare 需要 before 与 after 两个会话 id。 */
  readonly compareNeedsBoth: string;
  /** compare 不接受 id/limit。 */
  readonly compareRejectsArgs: string;
  /** export 不接受 before/after/limit/severity/category。 */
  readonly exportRejectsArgs: string;
  /** export 必须由宿主给出输出路径。 */
  readonly exportOutputRequired: string;
  /** before/after 只适用于 action=compare。 */
  readonly beforeAfterOnlyForCompare: string;
  /** severity/category 过滤只适用于 action=comments。 */
  readonly filtersOnlyForComments: string;
  /** 过滤需要同时给 id。 */
  readonly filtersNeedId: string;
  /** severity 过滤值不在白名单。 */
  readonly invalidSeverity: string;
  /** 会话比较结果的 hint。 */
  readonly sessionCompareHint: string;
  /** 会话导出结果的 hint。 */
  readonly sessionExportHint: string;
  // ── provider 配置通道（lib/ocr-config.ts 消费本表）─────────────────────────
  readonly sourceSettingsUnavailable: string;
  readonly sourceSettingsFailed: string;
  readonly sourceNamespaceUnavailable: string;
  readonly sourceCredentialsUnavailable: string;
  readonly badEnvKey: string;
  readonly configNotJson: string;
  readonly configNotObject: string;
  /** 配置文件读不动（权限/IO 等）：写侧必须中止，不能当成空文档整份覆盖。 */
  readonly configUnreadable: string;
  readonly providerNotInList: string;
  readonly modelNotInList: string;
  /** provider 的 api 协议无法映射到 OCR 的 protocol（投影透传的未知值）。 */
  readonly protocolUnsupported: string;
  readonly ocrConfigPathInvalid: string;
  /** ocrConfigPath 不是 <X>/.opencodereview/config.json 布局（OCR 无文件级覆盖）。 */
  readonly configPathLayoutInvalid: string;
  readonly noApiKeyEnv: string;
  readonly keyNotResolvable: string;
  /**
   * key 存在于 OCR 运行时不可达的凭据层（{source}）：宿主 resolve 得到、OCR 子进程
   * 取不到（宿主净化环境 / get-cred 刻意不读被审查仓库）。写盘前拒绝的假绿闸。
   */
  readonly keyNotReachable: string;
  readonly credScriptMissing: string;
  /** 收割器降级：进程信息命令不可用，已把进程树交回宿主管（stderr 只报一次，不每轮刷）。 */
  readonly reaperDegraded: string;
  /** warnings 字段形状不符（不是数组 / 条目读不出 file+message+type）：占位而非静默丢弃。 */
  readonly warningUnreadable: string;
  /** 诊断字段（tool_calls / manifest.coverage）存在却读不出：说明是哪一条读不出。 */
  readonly diagnosticUnreadable: string;
  /** 明细行超上限：说明省略了多少条，避免模型把截断读成「就只有这些」。 */
  readonly diagnosticOmitted: string;
  /** 逗号列表的数组形式里，某一项自身含逗号（含逗号的模式经逗号拼接无法表达）。 */
  readonly commaInListItem: string;
  /** 逗号列表的字符串形式里，glob 花括号内出现逗号（split 后花括号被撕成无效模式）。 */
  readonly commaInStringBraces: string;
  /** 状态探测跑通了、exit 0，但回执里读不出版本号（未发布构建的 `dev` 就落这里）。 */
  readonly probeNoVersion: string;
  /** 状态探测被墙钟收走：与 `execFailed` 分开，否则用户看到的是一个不存在的退出码。 */
  readonly probeTimedOut: string;
  // ── 端点回显 ──────────────────────────────────────────────────────────────
  readonly providerModelRequired: string;
  readonly bodyParseFailed: string;
  // ── 五个工具的 description ────────────────────────────────────────────────
  readonly reviewToolDescription: string;
  readonly scanToolDescription: string;
  readonly previewToolDescription: string;
  readonly ruleToolDescription: string;
  readonly sessionToolDescription: string;
  readonly rulesCheckToolDescription: string;
  readonly llmToolDescription: string;
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
  readonly paramPreview: string;
  readonly paramNoFilter: string;
  readonly paramMaxGitProcs: string;
  readonly paramRule: string;
  readonly paramBackgroundFile: string;
  readonly paramNoPlan: string;
  readonly paramNoDedup: string;
  readonly paramNoSummary: string;
  readonly paramScanResume: string;
  readonly paramBatch: string;
  readonly paramPaths: string;
  readonly paramSessionAction: string;
  readonly paramSessionId: string;
  readonly paramSessionBefore: string;
  readonly paramSessionAfter: string;
  readonly paramSessionSeverity: string;
  readonly paramSessionCategory: string;
  readonly paramSessionLimit: string;
  readonly paramRulesPath: string;
  readonly paramLlmAction: string;
  /** tuningParams 的「组」量词（OCR review 以组为单位）。 */
  readonly unitGroup: string;
  /** tuningParams 的「文件」量词（OCR scan 以文件为单位）。 */
  readonly unitFile: string;
  readonly tuningConcurrency: string;
  readonly tuningTimeout: string;
  readonly tuningMaxTools: string;
  /** scan 的 maxTools：scan 侧不抬到 50，只在大于模板默认时生效（review 侧才是 min 50）。 */
  readonly tuningMaxToolsScan: string;
  readonly tuningMaxTokens: string;
  readonly tuningMaxTokensBudget: string;
  // ── 工具结果里的 hint ─────────────────────────────────────────────────────
  readonly previewHint: string;
  readonly filePreviewHint: string;
  readonly ruleHint: string;
  readonly sessionEmpty: string;
  readonly sessionTruncated: string;
  readonly sessionResumeHint: string;
  readonly rulesCheckHint: string;
  readonly llmHint: string;
  // ── systemPrompt 注入段 ───────────────────────────────────────────────────
  readonly routingText: string;
}

export const MESSAGES: MessagesCatalog<OcrReviewMessages> = {
  zh: {
    middleEllipsis: " …[中间省略]… ",
    execTimedOut:
      "ocr 执行超时（实际生效 {minutes} 分钟 = min(请求, shell.maxTimeoutMs)）：" +
      "请缩小审查范围（exclude/--commit/更小改动）、调低 OCR 每组 --timeout，" +
      "抬高 shell 执行器（bash-local/pwsh-local）设置项里的 maxTimeoutMs，" +
      "或改用 wait=false 后台模式（默认不设时限）",
    execAborted: "ocr 执行被中止",
    execNotFound:
      "ocr 命令不存在：命令词交下去没被系统找到（PATH 上那份可能刚被移走或改名）。" +
      "请到「设置 → 插件 → ocr-review」的外部 CLI 那一行看与本插件核对版本一致的装法，装完直接重试本工具即可",
    ocrBinaryMissing:
      "两条路都没找到 ocr：PATH 上没有可执行候选，本插件也不随包分发它（装法由你选，" +
      "免得装上本插件就顺带改了全局工具链）。{install} 装完直接重试本工具即可，不必重启 dsh" +
      "（每次调用都重新判一次，结果不缓存）。",
    installHintBoth:
      "两条命令任选：brew 那条 `{brewCmd}`；npm 那条 `{npmCmd}`（brew 的 formula 只跟上游" +
      "最新版，钉不住 {version}；要严格装上这一版只能走 npm）",
    installHintBrew:
      "brew 那条命令：`{brewCmd}`。brew 的 formula 只跟上游最新版，钉不住 {version}——" +
      "本机装的那一版与本插件核对的版本不一致时，结论口径可能有差异；" +
      "要严格这一版请用 npm 那条：`{npmCmd}`",
    installHintNpm:
      "npm 那条命令：`{npmCmd}`（版本钉在本插件核对过的那一版，换版要显式改这条命令）",
    versionMismatch:
      "版本核对：外部 ocr CLI 实测 {actual}，而本插件的契约按 {expected} 逐条核对。" +
      "两个版本之间的评论口径、字段形态与 flag 语义都可能漂移，别把这份摘要的结构当作" +
      "「与插件同版本」的结果；换版命令见「设置 → 插件 → ocr-review」的外部 CLI 那一行。",
    execFailed: "ocr 执行失败（exit={exitCode}）",
    detailSeparator: "：",
    stdoutTruncated: "[ocr-review] 注意：输出超过 {limit} 字节上限已截断{spill}",
    outputSpill: "（完整输出已落盘：{path}）",
    backgroundPolling:
      "先 job_output(job_id=<本回执的 jobId>) 读这条后台评审的实时输出与最终结局——按 id 走，" +
      "启动即可读，一定有结果；要停它就 job_kill(job_id=<同一 id>)。会话落盘后再走 ocr_session：" +
      "ocr_session(action=list) 找本仓库最新会话（启动几秒后出现，按 scanPaths/时间匹配）；" +
      "completed_files == selected_files 即已完成；再 ocr_session(action=comments, id) 取全部评论、" +
      "ocr_session(action=show, id) 看元数据与逐文件检查点。后台评审不随工具调用结束而停止，" +
      "默认也不设时限（ocrBackgroundMaxMs=0 表示无兜底窗口）；只有 dsh 宿主退出、本会话被停止、" +
      "插件卸载或显式 job_kill 才会结束。",
    jobReasonSessionStopped: "ocr-review 会话已停止，回收在跑的后台评审",
    jobReasonTimeout: "ocr-review 后台评审超过兜底窗口（{minutes} 分钟），兜底回收",
    jobReasonUnload: "ocr-review 插件卸载",
    jobOutputGap: "\n[ocr-review] 注意：有一次输出读取失败，已按原游标重试（这段可能不完整）",
    requiredNotArray: "parameters.required 必须是字符串数组",
    requiredItemNotString: "parameters.required 元素必须是字符串",
    argsMustBeObject: "ocr {name}: 入参必须是 JSON 对象（收到 {received}）",
    missingRequiredArgs: "ocr {name}: 缺少必填参数 {keys}（缺失即拒绝，不产生副作用）",
    bodyMustBeObject: "body 必须是 JSON 对象",
    outputFileMissing:
      "ocr 未写出 --output 文件（{path}）：{cause}——请确认 ocr 版本支持 --output，或用 ocr_session 查询会话结果",
    outputFileTooLarge:
      "ocr 的 --output 文件过大（{path}，{size} 字节 > {limit} 字节上限）：不整份读进内存。" +
      "请缩小审查范围（exclude / --commit / 更小的目录）后重试，或用 ocr_session 查这一场的结果",
    failureCoverage:
      "\n这一场未完成的文件（取自 OCR 已发布的 --output）：{items}；完整清单见 ocr_session(action=comments/show)",
    settingsServiceGone: "{ns} 所在的设置服务在读取过程中已不可用",
    repoRequired: "repo 必填，且为 Git 仓库绝对路径",
    repoRequiredUnknownWorkspace: "repo 必填：当前会话工作区未知，请显式传入 Git 仓库绝对路径",
    repoMustBeAbsolute: "repo 必须是绝对路径（以 / 开头）：{root}",
    noNulBytes: "{name} 不能包含 NUL 字节",
    boolMustBeBoolean: "{name} 必须是布尔值（true/false），收到 {received}",
    repoRootUnreadable: "repo 根目录不可读：{path}",
    repoFileMissing: "{name} 指向的文件不存在：{path}",
    repoFileOutside: "{name} 必须指向 repo 根目录内的文件：{path}",
    repoFileNotFile: "{name} 必须指向普通文件：{path}",
    repoFileTooLarge: "{name} 文件过大（{path}，上限 {limit} 字节）",
    previewNeedsForeground: "preview 是秒级前台操作，不能与 wait=false 同用",
    previewRejectsResume: "preview 不读写会话，不能与 resume 同用",
    listOverLimit:
      "{name} 超过 {limit} 条上限（多出 {dropped} 条）——命令未构造，本轮一条都没有审：" +
      "请精简清单后重试，或按 commit/目录拆成多批分别调用",
    mustBeString: "{name} 必须是字符串（收到 {received}）",
    listItemsMustBeString: "{name} 数组元素必须是字符串",
    mustBeStringOrList: "{name} 必须是字符串或字符串数组",
    intFlagMustBeInt: "{flag} 需要为 ≥{min} 的整数，收到 {received}",
    formatNotJson:
      "本包只支持 --format json（收到 {format}）：text/sarif 没有解析层，" +
      "交下去只会把参数错报成「OCR 输出解析失败」",
    scopeBranchCommitExclusive: "scope=branch/from/to 与 commit 互斥（一次只能选一种审查范围）",
    branchNeedsFromAndTo: "scope=branch 需要同时提供 from 与 to",
    commitNeedsValue: "scope=commit 需要 commit 参数",
    unknownScope: "未知 scope：{scope}（workspace/commit/branch）",
    scopeMismatch:
      "scope={scope} 与 {given} 不能同时给（scope 是声明，{given} 属于另一种范围；两者冲突时按哪个审没有正确答案）",
    resumeNeedsScope:
      "resume 需要 scope=commit 或 scope=branch（workspace 工作区评审不支持恢复，OCR 会直接拒绝）；请同时给出 commit 或 from/to",
    waitMustBeBoolean: "wait 必须是布尔值（true/false），收到 {received}",
    pathsRequired: "paths 必填：至少传一个待审查文件的仓库相对路径",
    invalidAction: "action 非法：{action}（期望 {expected}）",
    sessionLimitRange: "limit 需要为 1-100 的整数（缺省 10），收到 {received}",
    listRejectsId: "action=list 不接受 id（查单个会话请用 action=show 或 action=comments）",
    resultSchemaViolation: "ocr {tool}: 返回值不符合该工具的 output schema：{violations}",
    resultSchemaUnsupported:
      "ocr {tool}: 返回形态守卫不支持 output schema 关键字 {keyword}（插件内 bug：lib/output.ts 的关键字子集没跟上 schema）",
    resultSchemaMalformed:
      "ocr {tool}: output schema 自身不合法——{detail}（插件内 bug：schema 的写法超出了返回形态守卫支持的官方子集）",
    ocrNotJson: "OCR 未返回合法 JSON 输出",
    ocrNotObject: "OCR JSON 输出不是对象",
    ocrStatusInvalid:
      "OCR 输出 status 非法或缺失：{status}（期望 {expected}）；" +
      "exit 0 不代表评审完成，请查 stderr 与 ~/.opencodereview/sessions/",
    statusNone: "（无）",
    ocrStatusFailed: "OCR 回执自报 status=failed（这一场评审没有成功完成）",
    ocrCommentsNotArray: "OCR 输出 comments 字段不是数组，无法确认评论完整性",
    warningSeparator: "：",
    reviewSummaryHint:
      "完整评论与逐文件失败详情请用 `ocr_session(action=show/comments, id=<session_id>)` 查看；" +
      "start_line=0 表示 OCR 未能锚定行号，可依据 suggestion/existing_code 在文件中定位。" +
      "两套口径不要混：droppedCount 与 invalidCommentCount 同时为 0 只说明**本摘要**列全了 OCR " +
      "产出的评论（否则调大 maxComments 或置 0 后复核）；而**这一场有没有审完**看 coverage" +
      "（selected 是分母，completed/reused/failed/waived 是它的互斥划分；coverage 为 null 时退回看 " +
      "warnings 与 status=partial）和 budgetExceeded（true = token 预算花完提前收工，status 里只写 " +
      "partial，看不出这一层）。toolCalls.failure 大于 0 说明当前模型的工具调用没跑通，换模型比重试同一个更省 token。" +
      "切勿把「本摘要无 critical」当作「代码干净」。",
    lineZeroNote: "(line 0: 定位失败，按 existing_code 手动定位)",
    parseFailedWithReason:
      "{tool} 输出解析失败：{message}\n原始内容前 {limit} 码元（已脱敏）：\n{raw}",
    parseFailedPlain: "{tool} 输出解析失败\n原始内容前 {limit} 码元（已脱敏）：\n{raw}",
    previewParseFailed: "OCR 的 --preview 回执不是可识别的文件清单（files 缺失或条目形状不合）",
    rulesPathRequired: "rules check 的 path 必填（待查询的文件路径）",
    textTruncated: "…[截断] 输出超过 {limit} 字符上限",
    mcpReadFailed: "读取 MCP 配置失败（{where}）：{cause}",
    mcpJsonInvalid: "MCP 配置不是合法 JSON：{cause}",
    mcpJsonTooLarge: "MCP 配置超过 {limit} 字节上限",
    mcpShapeInvalid: "MCP 配置必须是 {{name: entry}} 形式的对象",
    mcpTooManyServers: "MCP servers 最多 {limit} 个",
    mcpServerInvalid: "MCP server「{name}」的 {field} 不合法：{reason}",
    mcpSaved: "MCP servers 已保存（{count} 个）",
    chatGptModelRequired: "ChatGPT 模型名必填",
    chatGptSaved: "已切换到 ChatGPT provider，模型：{model}",
    chatGptSaveFailed: "写入 ChatGPT 配置失败：{cause}",
    compareNeedsBoth: "action=compare 需要同时给出 before 与 after 两个会话 id",
    compareRejectsArgs: "action=compare 不接受 id/limit/severity/category",
    exportRejectsArgs: "action=export 不接受 before/after/limit/severity/category",
    exportOutputRequired: "action=export 需要宿主给出输出路径",
    beforeAfterOnlyForCompare: "before/after 只适用于 action=compare",
    filtersOnlyForComments: "severity/category 过滤只适用于 action=comments",
    filtersNeedId: "severity/category 过滤需要同时给出会话 id",
    invalidSeverity: "severity 过滤值必须是 critical/high/medium/low 之一，收到 {value}",
    sessionCompareHint:
      "四桶含义：new=只在后一次出现；persisting=两次都有；resolved=只在前一次出现且后一次审过该文件；not_reviewed=只在前一次出现且后一次没审该文件（不算已解决）。",
    sessionExportHint:
      "已导出为自包含 HTML 文件；路径在 sessionOutput 里，直接用浏览器打开即可（文件留在临时目录，不会自动删除）。",
    sourceSettingsUnavailable:
      "dsh 设置服务（ctx.settings）未装配：本插件需要它读取已配置的 provider 列表",
    sourceSettingsFailed: "调用 dsh 设置服务失败：{message}",
    sourceNamespaceUnavailable:
      "dsh 配置里没有 {ns} 命名空间：未安装 pi-ai 适配器，或还没配置任何 provider",
    sourceCredentialsUnavailable:
      "dsh 凭据服务（ctx.credentials）未装配：无法确认 provider 的 API key 是否已配置",
    badEnvKey:
      "非法 env key：{key}（get-cred 只接受 ^[A-Z0-9_]+$ 的大写 ref 名；" +
      "请在 dsh 配置里把该 provider 的 apiKeyEnv 改成大写字母/数字/下划线）",
    configNotJson:
      "{where} 不是合法 JSON，已中止写入以保护既有配置（请先修复或删掉该文件）：{cause}",
    configNotObject: "{where} 顶层不是 JSON 对象，已中止写入以保护既有配置",
    configUnreadable: "{where} 读不动，已中止写入以保护既有配置（既有文件不会被覆盖）：{cause}",
    providerNotInList: "provider 不在 dsh 配置的 {ns}.providers 列表：{provider}",
    modelNotInList: "model 不在 {provider} 的 models 列表中：{model}",
    protocolUnsupported:
      "provider {provider} 的 api 协议 {protocol} 无法映射到 OCR 支持的 protocol" +
      "（openai/openai-responses/anthropic）；请在 dsh 配置里改用 openai-completions/" +
      "openai-responses/anthropic-messages，或升级本插件",
    ocrConfigPathInvalid: "设置项 ocrConfigPath 必须是绝对路径或 ~ 开头的路径：{path}",
    configPathLayoutInvalid:
      "设置项 ocrConfigPath 必须是 <X>/.opencodereview/config.json 布局：{path}。" +
      "OCR 端没有配置文件级的路径覆盖（只按 <HOME>/.opencodereview/config.json 定位），" +
      "本插件通过给 ocr 子进程注入 HOME=<X> 让它生效；任意形状的文件路径写下去 OCR 也不会读",
    noApiKeyEnv:
      "provider {provider} 未声明 apiKeyEnv，无法动态读取 key（OCR 自定义 provider 不支持无 key 解析）",
    keyNotResolvable: "provider {provider} 的 API key 未配置：dsh 凭据服务未解析到 {ref}",
    keyNotReachable:
      "provider {provider} 的 API key 存在于凭据层「{source}」，OCR 运行时取不到它：" +
      "dsh 起 shell 会剥掉名字含 KEY/PASSWORD/SECRET/TOKEN 或 DSH_ 前缀的环境变量，" +
      "get-cred 也刻意不读被审查仓库的 .env。请把 key 存入 dsh 托管凭据" +
      "（$DSH_HOME/.credentials.yaml 的 refs.{ref}）或 $DSH_HOME/.env 后重试",
    credScriptMissing: "get-cred 脚本缺失：{path}（api_key_cmd 无法工作）",
    reaperDegraded:
      "[ocr-review] 宿主回收守护已降级：ps/pgrep 不可用（进程信息命令被沙箱拒绝），改由宿主管进程树。" +
      "dsh 硬退出时 ocr 可能留孤儿进程。",
    warningUnreadable:
      "（一条格式无法解析的 warning：既不是字符串，也没有 file/message/type 字段）",
    diagnosticUnreadable: "（OCR 的 {field} 字段形态不合，这一场的诊断数据读不出来）",
    diagnosticOmitted: "（另有 {count} 条同类明细已省略，全量见 ocr_session 的 show/comments）",
    commaInListItem:
      "{name} 的数组形式里有一项自身含逗号：{item}。值最终按逗号拼接传给 ocr，含逗号的" +
      "模式必被拆开、静默改变审查/过滤范围。请改写成不含逗号的等价模式（如把 {ts,tsx} " +
      "展开成两条），或去掉该条",
    commaInStringBraces:
      "{name} 的字符串形式里有 glob 花括号内含逗号：{item}。按逗号拆分后花括号会被撕成" +
      "多个无效模式，过滤条件失效、审查范围被无声扩大。请把花括号展开成多条模式" +
      "（{ts,tsx} 即两条）后再传入",
    probeNoVersion: "ocr version 跑通了（exit 0），但回执里读不出版本号：那通常是未发布构建。",
    probeTimedOut:
      "ocr version 超时（{seconds} 秒内没回来）：那条进程已被收走。稍后重试，" +
      "或直接在终端里跑 ocr version——本插件不会替它代跑安装或升级。",
    providerModelRequired: "provider 与 model 必填",
    bodyParseFailed: "body 解析失败：{message}",
    reviewToolDescription:
      "用 open-code-review（ocr）对 Git 变更做深度学习代码审查：OCR 调用其自身配置的 LLM（provider/model 在 ocr-review 设置卡选择）独立审查，返回按严重度/类别聚合的评论摘要。scope=workspace 审工作区 staged+unstaged+untracked 变更（默认）；scope=commit 审单个提交；scope=branch 用从/到分支对比（merge-base）。常用先 ocr_delegate_preview 看范围。effort 控制深度（low=1 轮/medium=2/high=3，越深越贵）。background 提供需求/业务上下文能显著提升质量。preview=true 只做文件选择（零 LLM、不建会话）；noFilter 保留全部评论；rule/backgroundFile 只收 repo 根内文件。首次审查前确保 ocr 已配置且 'ocr llm test' 通过。",
    scanToolDescription:
      "用 open-code-review（ocr）做全文件扫描审查（无需 Git 变更/无 diff，适合审计陌生代码库或指定目录）。--path 逗号分隔的仓库相对目录/文件（缺省整个仓库，路径不存在会报错）。与 ocr_review 一样由 OCR 自身 LLM 独立审查，返回聚合评论摘要。preview=true 只列扫描范围；noPlan/noDedup/noSummary 降本；resume 续扫；rule 只收 repo 根内文件。",
    previewToolDescription:
      "open-code-review 委托模式第 1 步：列出待审查文件清单（mode/ref/merge_base/reviewable 文件路径+状态+增删行/被排除文件及原因），不调 LLM、秒级返回。用于确认 ocr_review/ocr_scan 的审查范围，或配合 ocr_delegate_rule 后由你自己（dsh 会话模型）读取 diff 完成审查。scope 与 ocr_review 一致（workspace/commit/branch）。",
    ruleToolDescription:
      "open-code-review 委托模式第 2 步：按文件路径返回适配的审查规则（按规则内容分组，共享规则的多个文件归一组）。把 ocr_delegate_preview 得到的 reviewable 路径传进来，作为你自己审查时的检查清单。规则文本较长时按批传入。",
    sessionToolDescription:
      "查询 open-code-review 的历史评审会话：action=list 列最近会话（含 session_id/mode/model/评论数，可用于 ocr_review/ocr_scan --resume 恢复中断的评审）；action=show 查看单个会话元数据与逐文件检查点；action=comments 取单个会话的评论明细（可按 severity/category 过滤）；action=compare 比较两次会话的 new/persisting/resolved/not_reviewed 四桶；action=export 导出自包含 HTML。session_id 也可从 ocr_review/ocr_scan 的返回结果直接获取。",
    rulesCheckToolDescription:
      "调试 open-code-review 的规则解析：对给定文件路径打印最终命中的规则层（--rule/项目/全局/内置）、glob 模式与规则正文。不调用 LLM、不建会话；用于排查「我的规则为什么没生效」。",
    llmToolDescription:
      "只读查询 open-code-review 的 LLM 配置面：action=providers 列内置 provider；action=models 列当前 ChatGPT 账号可用的模型（需要先完成 ocr auth 登录）。不发起评审、不测试连通性。",
    paramRepo: "Git 仓库绝对路径（可选：缺省=当前会话工作区）",
    paramScope: "审查范围（缺省 workspace）",
    paramCommit: "scope=commit 时必填：提交哈希",
    paramFrom: "scope=branch 时必填：对比起点 ref（如 main）",
    paramTo: "scope=branch 时必填：对比终点 ref（如 feature/x）",
    paramCommitShort: "scope=commit 时必填",
    paramFromShort: "scope=branch 时必填",
    paramToShort: "scope=branch 时必填",
    paramEffort: "投入档位 low/medium/high；不给时取设置卡默认（出厂 auto=跟随 OCR 自身配置）",
    paramBackground:
      "需求/业务上下文（官方 skill 推荐：调用前先用 git log/diff/提交信息快速分析变更意图，提取 3-5 句业务背景传入，是提升评审质量最有效的参数；从其它 agent 调用时始终携带 PR 描述/需求）",
    paramBackgroundShort: "需求/业务上下文",
    paramBackgroundPreview: "业务上下文（会出现在输出中供审查参考）",
    paramExclude: "gitignore 风格排除模式（可多值；上限 2000 条，超出会直接报错而不是静默丢弃）",
    paramExcludeShort: "排除模式（上限 2000 条，超出会报错）",
    paramWait:
      "false（缺省）=后台启动、立即返回作业 id，用 ocr_session 轮询结果——一次 review 是分钟级长任务，" +
      "阻塞等待会占住整轮；true=前台阻塞到完成并直接返回聚合摘要。后台模式的兜底窗口由设置项 " +
      "ocrBackgroundMaxMs 给出（默认 0 = 不设窗口）。两种模式都带宿主回收守护：" +
      "dsh 退出（含 kill -9）时 OCR 进程一并结束",
    paramProvider: "本次运行临时指定已配置 provider",
    paramModel: "本次运行临时覆盖 model",
    paramResume: "从之前中断的会话 id 恢复（会话 id 在返回结果里）",
    paramScanPath:
      "仓库相对目录或文件（缺省整仓，可多值；上限 2000 条，超出会直接报错；路径不存在会报错而不是空扫描）",
    paramPreview:
      "true=只列文件清单与排除原因，不调用 LLM、不建会话（秒级返回）；与 resume/wait=false 互斥",
    paramNoFilter: "true=跳过 OCR 的 LLM 评论后过滤，保留全部评论（召回优先，噪音更多）",
    paramMaxGitProcs: "git 子进程并发上限（OCR --max-git-procs；缺省不传=原生 16）",
    paramRule: "repo 根内的自定义规则 JSON 路径（OCR --rule；只允许仓库内普通文件）",
    paramBackgroundFile:
      "repo 根内的 Markdown 需求文件路径（OCR --background-file；优先于 background）",
    paramNoPlan: "true=跳过 scan 的逐文件 PLAN_TASK 预检（降本）",
    paramNoDedup: "true=跳过 scan 的批内 DEDUP_TASK（降本）",
    paramNoSummary: "true=跳过 scan 结束后的 PROJECT_SUMMARY_TASK（降本）",
    paramScanResume: "从之前中断的 scan 会话 id 恢复",
    paramBatch: "分批策略",
    paramPaths: "待查询的仓库相对文件路径（至少 1 个，最多 200）",
    paramSessionAction:
      "list：列最近会话（缺省）/ show：查看单个 / comments：取评论 / compare：比较两次会话 / export：导出 HTML",
    paramSessionId: "action=show/comments/export 时的会话 id（export 缺省=最新一场）",
    paramSessionBefore: "action=compare 时必填：较早的会话 id",
    paramSessionAfter: "action=compare 时必填：较晚的会话 id",
    paramSessionSeverity: "action=comments 时按严重度过滤（critical/high/medium/low）",
    paramSessionCategory: "action=comments 时按类别过滤（如 bug/security）",
    paramSessionLimit: "list 上限 1-100（缺省 10）",
    paramRulesPath: "待查询的文件路径（仓库相对或绝对；仅用于规则匹配）",
    paramLlmAction: "providers：内置 provider 列表 / models：ChatGPT 账号模型列表",
    unitGroup: "组",
    unitFile: "文件",
    tuningConcurrency: "并发{unit}数（OCR --concurrency；缺省不传=OCR 原生 8）",
    tuningTimeout:
      "每{unit}任务超时分钟（OCR --timeout；review 会按 effort 轮数线性放大，scan 不放大；0=不限时；缺省不传=OCR 原生 15）",
    tuningMaxTools:
      "每{unit}工具调用轮数上限（OCR --max-tools；0=模板默认；1-49 会被 OCR 抬到 50，帮助文本 min 50；缺省不传=模板默认）",
    tuningMaxToolsScan:
      "每{unit}工具调用轮数上限（OCR --max-tools；0=模板默认；只在大于模板默认值时生效，不抬到 50；缺省不传=模板默认）",
    tuningMaxTokens:
      "每{unit}提示词 token 上限（OCR --max-tokens；0=配置/模板默认；缺省不传=模板默认）",
    tuningMaxTokensBudget:
      "本次运行 total token（input+output）预算闸门，超出即停止派发部分结果（OCR --max-tokens-budget；0=不限；缺省不传=不限）",
    previewHint:
      "对每个 reviewable 文件：用 git diff <merge_base>..<to> -- <path>（branch）/" +
      "git show <commit> -- <path>（commit）/ git diff HEAD -- <path> 或直接读文件（workspace 新文件）取 diff。",
    filePreviewHint:
      "这是文件选择预览：没有调用 LLM、没有创建会话。要真正审查请去掉 preview 后重跑。" +
      "列表按上限截断；truncated=true 时请用 exclude/path 缩小范围。",
    ruleHint:
      "按分组规则逐个审查对应文件，输出评论建议格式：{path, content, start_line, end_line, category, severity}。",
    sessionEmpty: "（暂无历史评审会话：先跑一次 ocr_review/ocr_scan 再查询）",
    sessionTruncated: "…[截断] 完整内容见 ~/.opencodereview/sessions/",
    sessionResumeHint:
      "要恢复中断的区间/commit 评审：ocr_review ... --resume <session_id>（工作区评审不支持恢复）；scan 会话用 ocr_scan ... --resume <session_id>。",
    rulesCheckHint:
      "输出里的 Source 是命中的层（--rule/项目/全局/内置），Pattern 是命中的 glob；规则按声明顺序先到先得。",
    llmHint:
      "providers 是内置清单，models 是 ChatGPT 账号专属列表；评审实际用哪个 provider/model 仍以 OCR 配置为准。",
    routingText: `
- 用户要求「审查代码/Review/检查我的改动/审这个 commit/PR」时，用 ocr 工具做代码审查：
  - ocr_review：OCR 用自己配置的 LLM 独立审查工作区/commit/分支变更（effort 控制深度，可给 background 上下文）。
  - ocr_scan：对无 git 历史的目录或指定路径做全文件审查。
  - ocr_delegate_preview / ocr_delegate_rule：只取「文件清单 + 适配规则」的确定性脚手架（OCR 端零 LLM 消耗），
    配合 git diff 由你自己完成审查——适合复用本会话模型能力、或先确认审查范围再决定是否跑 ocr_review。
  - ocr_review / ocr_scan 的 preview=true：只列文件选择与排除原因，零 LLM、不建会话；scan 还支持
    noPlan/noDedup/noSummary 降本与 resume 续扫。
  - ocr_session：list/show/comments（可按 severity/category 过滤）/compare（new/persisting/resolved/not_reviewed）/export。
  - ocr_rules_check / ocr_llm：规则解析与 LLM 清单的只读诊断，不评审、不花 token。
  - 审查前若不确定范围，先 ocr_delegate_preview 或 preview=true（不花 token）；范围过大时用 exclude 收敛或按 commit 拆。
- OCR 端点/provider/model 由「设置 → 插件 → ocr-review 卡片」从宿主设置服务的 provider 清单选择
  （key 只按 api_key_cmd 动态读取，不落盘明文）；也可在工具参数里用 provider/model 逐次覆盖。
- 调用 ocr_review / ocr_scan 前，先用 git log/diff/提交信息快速分析变更意图，提取 3-5 句业务上下文
  传入 background（open-code-review 官方 skill 明确推荐"始终携带"，是质量提升最有效的单一参数）。
- 读结果分两套口径，不要互相替代：coverage（selected 是分母）与 budgetExceeded 说「这一场有没有审完」，
  droppedCount/invalidCommentCount 只说「本摘要有没有列全」。toolCalls.failure 大于 0 是当前模型不会调
  工具——换支持原生工具调用的模型（sensenova、deepseek、glm、qwen 系），别重试同一个；OCR 以
  --audience agent 运行时进度行被丢弃，"No tool calls parsed" 这类文本永远不会出现在输出里，
  只能看这个字段。
- LLM 调用本身有重试：OCR 内置重试（429/408/409 与 5xx 自动退避重试）；per-file 组失败被隔离，进
  coverage.failedItems（产出里没有 manifest 时进 warnings），不整体重跑。
  工具层超时（min(请求, shell 执行器自己设置项里的 maxTimeoutMs)，缺省 10 分钟）或部分文件失败后，可
  ocr_session 查 session_id、用 ocr_review --resume 恢复中断的区间/commit 评审，或 ocr_scan --resume 续扫。
`.trim(),
  },
  en: {
    middleEllipsis: " …[middle omitted]… ",
    execTimedOut:
      "ocr timed out (effective {minutes} min = min(request, shell.maxTimeoutMs)): " +
      "narrow the review scope (exclude / --commit / a smaller diff), lower OCR's per-group --timeout, " +
      "raise maxTimeoutMs in the shell executor's own settings (bash-local/pwsh-local), " +
      "or switch to background mode with wait=false (no time limit by default)",
    execAborted: "ocr execution aborted",
    execNotFound:
      "ocr command not found: the command word was handed to the shell and nothing answered it " +
      "(the PATH candidate may have just been moved or renamed). Open the External CLI row in " +
      "Settings → Plugins → ocr-review for an install that matches the version this plugin was " +
      "verified against, then retry this call",
    ocrBinaryMissing:
      "no ocr candidate on either path: PATH has none, and this plugin no longer ships the CLI " +
      "(installing the plugin should not silently change your global toolchain). {install} Once " +
      "installed, just retry this call - the verdict is re-read per call, so no dsh restart is needed",
    installHintBoth:
      "either command works: the brew one `{brewCmd}`; the npm one `{npmCmd}` (the brew formula " +
      "only tracks the newest upstream release and cannot pin {version}; npm is the only way to " +
      "install exactly that version)",
    installHintBrew:
      "the brew command: `{brewCmd}`. The brew formula only tracks the newest upstream release and " +
      "cannot pin {version} - when the version on this machine differs from the one this plugin was " +
      "verified against, the reported conclusions may differ too. To get exactly {version} use the " +
      "npm one: `{npmCmd}`",
    installHintNpm:
      "the npm command: `{npmCmd}` (the version is pinned to the one this plugin was verified " +
      "against; changing it means editing this command)",
    versionMismatch:
      "Version check: the external ocr CLI reports {actual}, while this plugin's contract was " +
      "verified against {expected}. Comment wording, output shapes and flag semantics can drift " +
      "between versions, so do not treat this summary as if it came from the verified version - the " +
      "upgrade command is on the External CLI row of Settings → Plugins → ocr-review",
    execFailed: "ocr failed (exit={exitCode})",
    detailSeparator: ": ",
    stdoutTruncated:
      "[ocr-review] note: output exceeded the {limit}-byte cap and was truncated{spill}",
    outputSpill: " (full output spilled to {path})",
    backgroundPolling:
      "First read this background review's live output and final outcome with " +
      "job_output(job_id=<the jobId in this receipt>) — that path goes by id, so it is readable " +
      "immediately after start and always has a result; job_kill(job_id=<the same id>) stops it. " +
      "Once the session has landed, use ocr_session: ocr_session(action=list) finds this " +
      "repository's newest session (it appears a few seconds after start; match by scanPaths/time); " +
      "completed_files == selected_files means it is done. Then ocr_session(action=comments, id) for " +
      "all comments and ocr_session(action=show, id) for metadata " +
      "and per-file checkpoints. A background run does not stop when the tool call ends and has no " +
      "time limit by default (ocrBackgroundMaxMs=0 means no backstop window); it ends only when the " +
      "dsh host exits, this session is stopped, the plugin unloads, or you call job_kill.",
    jobReasonSessionStopped:
      "the ocr-review session stopped; running background reviews were reclaimed",
    jobReasonTimeout:
      "the ocr-review background review exceeded its backstop window ({minutes} minutes) and was reclaimed",
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
    outputFileTooLarge:
      "the ocr --output file is too large ({path}, {size} bytes > {limit}-byte cap): refusing to read " +
      "it whole. Narrow the review scope (exclude / --commit / smaller directory) and retry, or read " +
      "this run's results with ocr_session",
    failureCoverage:
      "\nfiles that did not finish in this run (from the --output OCR already published): {items}; " +
      "full list via ocr_session(action=comments/show)",
    settingsServiceGone: "the settings service holding {ns} became unavailable while being read",
    repoRequired: "repo is required and must be the absolute path of a Git repository",
    repoRequiredUnknownWorkspace:
      "repo is required: the current session workspace is unknown, pass the absolute path of a Git repository explicitly",
    repoMustBeAbsolute: "repo must be an absolute path (starting with /): {root}",
    boolMustBeBoolean: "{name} must be a boolean (true/false), got {received}",
    repoRootUnreadable: "the repo root is not readable: {path}",
    repoFileMissing: "{name} points at a file that does not exist: {path}",
    repoFileOutside: "{name} must point at a file inside the repo root: {path}",
    repoFileNotFile: "{name} must point at a regular file: {path}",
    repoFileTooLarge: "{name} file is too large ({path}, cap {limit} bytes)",
    previewNeedsForeground:
      "preview is a fast foreground operation and cannot be combined with wait=false",
    previewRejectsResume:
      "preview does not read or write sessions and cannot be combined with resume",
    listOverLimit:
      "{name} exceeds the {limit}-item cap ({dropped} extra) - the command was not constructed " +
      "and nothing has been reviewed: trim the list and retry, or split the run into smaller " +
      "batches by commit/directory",
    noNulBytes: "{name} must not contain NUL bytes",
    mustBeString: "{name} must be a string (got {received})",
    listItemsMustBeString: "the items of {name} must be strings",
    mustBeStringOrList: "{name} must be a string or an array of strings",
    intFlagMustBeInt: "{flag} must be an integer ≥ {min}, got {received}",
    formatNotJson:
      "this package supports --format json only (got {format}): text/sarif have no parser here, " +
      "so passing them through reports a bad parameter as an OCR output failure",
    scopeBranchCommitExclusive:
      "scope=branch/from/to and commit are mutually exclusive (only one review scope at a time)",
    branchNeedsFromAndTo: "scope=branch requires both from and to",
    commitNeedsValue: "scope=commit requires the commit parameter",
    unknownScope: "unknown scope: {scope} (workspace/commit/branch)",
    scopeMismatch:
      "scope={scope} cannot be combined with {given} (scope declares one range, {given} belongs to another; there is no correct way to pick one)",
    resumeNeedsScope:
      "resume requires scope=commit or scope=branch (workspace reviews cannot be resumed; OCR rejects it outright); pass commit or from/to as well",
    waitMustBeBoolean: "wait must be a boolean (true/false), got {received}",
    pathsRequired: "paths is required: pass at least one repo-relative path of a file to review",
    invalidAction: "invalid action: {action} (expected {expected})",
    sessionLimitRange: "limit must be an integer 1-100 (default 10), got {received}",
    listRejectsId:
      "action=list does not take an id (use action=show or action=comments for a single session)",
    resultSchemaViolation:
      "ocr {tool}: the tool result does not match its output schema: {violations}",
    resultSchemaUnsupported:
      "ocr {tool}: the result guard does not support the output schema keyword {keyword} (plugin bug: the keyword subset in lib/output.ts lags the schema)",
    resultSchemaMalformed:
      "ocr {tool}: the output schema itself is malformed — {detail} (plugin bug: the schema goes beyond the official subset the result guard supports)",
    ocrNotJson: "OCR returned no valid JSON output",
    ocrNotObject: "the OCR JSON output is not an object",
    ocrStatusInvalid:
      "OCR output has an invalid or missing status: {status} (expected {expected}); " +
      "exit 0 does not mean the review completed — check stderr and ~/.opencodereview/sessions/",
    statusNone: "(none)",
    ocrStatusFailed: "the OCR receipt reports status=failed (this review run did not complete)",
    ocrCommentsNotArray:
      "the comments field of the OCR output is not an array, comment completeness cannot be confirmed",
    warningSeparator: ": ",
    reviewSummaryHint:
      "Use `ocr_session(action=show/comments, id=<session_id>)` for the full comments and per-file failure " +
      "details; start_line=0 means OCR could not anchor a line — locate it via suggestion/existing_code. " +
      "Keep the two notions apart: droppedCount and invalidCommentCount both being 0 only means THIS SUMMARY " +
      "listed every comment OCR produced (otherwise raise maxComments, or set it to 0, and re-check). Whether " +
      "the run itself covered everything is answered by coverage (selected is the denominator, " +
      "completed/reused/failed/waived are its disjoint partition; fall back to warnings and status=partial when " +
      "coverage is null) and by budgetExceeded (true = the token budget stopped the run early — status still " +
      "only says partial). A toolCalls.failure above 0 means the current model's tool calls did not work: switch " +
      'models instead of retrying the same one. Never treat "no critical in this summary" as "the code is clean".',
    lineZeroNote: "(line 0: not anchored, locate it via existing_code)",
    parseFailedWithReason:
      "{tool} output parsing failed: {message}\nfirst {limit} UTF-16 code units of the raw output (redacted):\n{raw}",
    parseFailedPlain:
      "{tool} output parsing failed\nfirst {limit} UTF-16 code units of the raw output (redacted):\n{raw}",
    previewParseFailed:
      "the OCR --preview receipt is not a recognizable file list (files missing or every entry malformed)",
    rulesPathRequired: "rules check requires path (the file to look up)",
    textTruncated: "…[truncated] output exceeded the {limit}-character cap",
    mcpReadFailed: "failed to read the MCP config ({where}): {cause}",
    mcpJsonInvalid: "the MCP config is not valid JSON: {cause}",
    mcpJsonTooLarge: "the MCP config exceeds the {limit}-byte cap",
    mcpShapeInvalid: "the MCP config must be an object of {name: entry}",
    mcpTooManyServers: "at most {limit} MCP servers are allowed",
    mcpServerInvalid: 'MCP server "{name}" has an invalid {field}: {reason}',
    mcpSaved: "MCP servers saved ({count})",
    chatGptModelRequired: "a ChatGPT model slug is required",
    chatGptSaved: "switched to the ChatGPT provider, model: {model}",
    chatGptSaveFailed: "failed to write the ChatGPT config: {cause}",
    compareNeedsBoth: "action=compare requires both before and after session ids",
    compareRejectsArgs: "action=compare does not take id/limit/severity/category",
    exportRejectsArgs: "action=export does not take before/after/limit/severity/category",
    exportOutputRequired: "action=export requires an output path from the host",
    beforeAfterOnlyForCompare: "before/after only apply to action=compare",
    filtersOnlyForComments: "severity/category filters only apply to action=comments",
    filtersNeedId: "severity/category filters require a session id",
    invalidSeverity: "severity filter values must be one of critical/high/medium/low, got {value}",
    sessionCompareHint:
      "Bucket meanings: new = only in the later run; persisting = in both; resolved = only in the earlier run and the later run reviewed that file; not_reviewed = only in the earlier run and the later run never looked at that file (not resolved).",
    sessionExportHint:
      "Exported as a self-contained HTML file; the path is in sessionOutput — open it in a browser. It stays in the temp directory and is not deleted automatically.",
    sourceSettingsUnavailable:
      "the dsh settings service (ctx.settings) is not wired up: this plugin needs it to read the configured provider list",
    sourceSettingsFailed: "calling the dsh settings service failed: {message}",
    sourceNamespaceUnavailable:
      "the dsh configuration has no {ns} namespace: the pi-ai adapter is not installed, or no provider is configured yet",
    sourceCredentialsUnavailable:
      "the dsh credentials service (ctx.credentials) is not wired up: cannot confirm whether a provider's API key is configured",
    badEnvKey:
      "invalid env key: {key} (get-cred only accepts uppercase ref names matching ^[A-Z0-9_]+$; " +
      "change the provider's apiKeyEnv in the dsh configuration to uppercase letters/digits/underscores)",
    configNotJson:
      "{where} is not valid JSON; the write was aborted to protect the existing configuration (fix or delete that file first): {cause}",
    configNotObject:
      "the top level of {where} is not a JSON object; the write was aborted to protect the existing configuration",
    configUnreadable:
      "{where} could not be read; the write was aborted so the existing configuration is left untouched: {cause}",
    providerNotInList: "provider is not in the {ns}.providers list configured by dsh: {provider}",
    modelNotInList: "model is not in the models list of {provider}: {model}",
    protocolUnsupported:
      "the api protocol {protocol} of provider {provider} cannot be mapped to an OCR-supported protocol " +
      "(openai/openai-responses/anthropic); use openai-completions/openai-responses/anthropic-messages " +
      "in the dsh configuration, or upgrade this plugin",
    ocrConfigPathInvalid: "the ocrConfigPath setting must be absolute or start with ~: {path}",
    configPathLayoutInvalid:
      "the ocrConfigPath setting must follow the <X>/.opencodereview/config.json layout: {path}. " +
      "OCR has no file-level path override (it only looks at <HOME>/.opencodereview/config.json); " +
      "this plugin makes it effective by injecting HOME=<X> into the ocr subprocess. A file path of any " +
      "other shape would never be read by OCR",
    noApiKeyEnv:
      "provider {provider} declares no apiKeyEnv, so the key cannot be read dynamically (OCR custom providers do not support keyless resolution)",
    keyNotResolvable:
      "the API key of provider {provider} is not configured: the dsh credentials service resolved no {ref}",
    keyNotReachable:
      'the API key of provider {provider} lives in the credential source "{source}", which OCR ' +
      "cannot reach at runtime: dsh strips variables named KEY/PASSWORD/SECRET/TOKEN or prefixed " +
      "DSH_ from spawned shells, and get-cred deliberately does not read the reviewed repository's " +
      ".env. Store the key in the dsh managed credentials ($DSH_HOME/.credentials.yaml refs.{ref}) " +
      "or $DSH_HOME/.env and retry",
    credScriptMissing: "get-cred script missing: {path} (api_key_cmd cannot work)",
    reaperDegraded:
      "[ocr-review] host reaper degraded: ps/pgrep are unavailable (process-info commands denied by " +
      "the sandbox), so the host manages the process tree. dsh may leave an orphaned ocr process.",
    warningUnreadable:
      "(one unreadable warning entry: neither a string nor an object with file/message/type)",
    diagnosticUnreadable:
      "(the {field} field of the OCR output is malformed; its diagnostics cannot be read for this run)",
    diagnosticOmitted:
      "({count} more entries of the same kind were omitted; use ocr_session show/comments for the full list)",
    commaInListItem:
      "an item of the array form of {name} contains a comma itself: {item}. Values reach ocr " +
      "comma-joined, so a pattern containing a comma is certain to be torn apart, silently " +
      "changing the review/filter scope. Rewrite it as comma-free equivalents (e.g. expand " +
      "{ts,tsx} into two patterns) or drop the item",
    commaInStringBraces:
      "the string form of {name} contains a comma inside a glob brace: {item}. Splitting on " +
      "commas tears the brace into several invalid patterns, silently changing the " +
      "review/filter scope. Expand the brace into separate patterns ({ts,tsx} means two) and " +
      "pass those",
    probeNoVersion:
      "ocr version ran fine (exit 0), yet no version could be read from its output: that usually means an unreleased build",
    probeTimedOut:
      "ocr version timed out (nothing back within {seconds}s): that process was reaped. Retry later, " +
      "or run ocr version in a terminal yourself — this plugin never runs an install or upgrade on your behalf",
    providerModelRequired: "provider and model are both required",
    bodyParseFailed: "failed to parse the body: {message}",
    reviewToolDescription:
      "Deep code review of Git changes with open-code-review (ocr): OCR runs its own configured LLM " +
      "(provider/model picked in the ocr-review settings card) as an independent reviewer and returns " +
      "comments aggregated by severity/category. scope=workspace reviews staged+unstaged+untracked " +
      "changes (default); scope=commit reviews one commit; scope=branch compares from/to branches " +
      "(merge-base). Commonly start with ocr_delegate_preview to see the scope. effort controls depth " +
      "(low=1 pass / medium=2 / high=3, deeper costs more). Passing requirements/business context via " +
      "background markedly improves quality. preview=true selects files only (no LLM, no session); " +
      "noFilter keeps every comment; rule/backgroundFile accept repo-root files only. Before the first " +
      "review make sure ocr is configured and 'ocr llm test' passes.",
    scanToolDescription:
      "Whole-file scan review with open-code-review (ocr) — no Git changes or diff required, good for " +
      "auditing an unfamiliar repository or given directories. --path takes comma-separated repo-relative " +
      "directories/files (default: the whole repo; a nonexistent path errors). Like ocr_review, OCR's " +
      "own LLM reviews independently and an aggregated comment summary is returned. preview=true lists " +
      "the scan scope only; noPlan/noDedup/noSummary reduce cost; resume continues an interrupted scan; " +
      "rule accepts a repo-root file only.",
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
      "model/comment counts, usable for ocr_review/ocr_scan --resume of interrupted reviews); action=show " +
      "prints one session's metadata and per-file checkpoints; action=comments returns one session's " +
      "comment details (optionally filtered by severity/category); action=compare compares two sessions " +
      "into new/persisting/resolved/not_reviewed; action=export writes a self-contained HTML file. " +
      "session_id is also returned by ocr_review/ocr_scan.",
    rulesCheckToolDescription:
      "Debug open-code-review rule resolution: for a given file path, print the winning rule layer " +
      "(--rule/project/global/built-in), the glob pattern and the rule body. No LLM call and no session; " +
      "use it when a custom rule is not firing.",
    llmToolDescription:
      "Read-only queries over open-code-review's LLM configuration: action=providers lists built-in " +
      "providers; action=models lists the current ChatGPT account's models (requires an ocr auth sign-in " +
      "first). It never runs a review or a connectivity test.",
    paramRepo:
      "Absolute path to the Git repository (optional: default = current session workspace)",
    paramScope: "Review scope (default workspace)",
    paramCommit: "Required with scope=commit: commit hash",
    paramFrom: "Required with scope=branch: comparison start ref (e.g. main)",
    paramTo: "Required with scope=branch: comparison end ref (e.g. feature/x)",
    paramCommitShort: "Required with scope=commit",
    paramFromShort: "Required with scope=branch",
    paramToShort: "Required with scope=branch",
    paramEffort:
      "Effort level low/medium/high; when omitted the settings card default applies (factory auto = follow the OCR config)",
    paramBackground:
      "Requirements/business context (official skill recommends: analyse the change intent via git " +
      "log/diff/commit messages first and pass 3-5 sentences of context — the single most effective " +
      "parameter for review quality; always carry the PR description/requirements when called from " +
      "another agent)",
    paramBackgroundShort: "Requirements/business context",
    paramBackgroundPreview: "Business context (it shows up in the output for review reference)",
    paramExclude:
      "gitignore-style exclusion patterns (multiple allowed; cap 2000 - exceeding it is an error, never a silent drop)",
    paramExcludeShort: "Exclusion patterns (cap 2000; exceeding it errors out)",
    paramWait:
      "false (default) = start in the background, return the job id immediately and poll with ocr_session - " +
      "a review is a minutes-long task and blocking the call ties up the whole turn; true = block until it " +
      "finishes and return the aggregated summary directly. The background backstop window is the " +
      "ocrBackgroundMaxMs setting (default 0 = none). Both modes carry the host reaper guard: when dsh " +
      "exits (including kill -9) the OCR process is terminated too",
    paramProvider: "Temporarily use a configured provider for this run",
    paramModel: "Temporarily override the model for this run",
    paramResume: "Resume from a previously interrupted session id (the id is in the result)",
    paramScanPath:
      "Repo-relative directories or files (default: whole repo, multiple allowed; cap 2000 - exceeding it is an error; a nonexistent path errors instead of scanning nothing)",
    paramPreview:
      "true = list files and exclusion reasons only; no LLM call, no session, returns in seconds. Mutually exclusive with resume/wait=false",
    paramNoFilter: "true = skip OCR's LLM post-filter and keep every comment (recall over noise)",
    paramMaxGitProcs: "Concurrent git subprocess cap (OCR --max-git-procs; unset = native 16)",
    paramRule: "Path to a custom rule JSON inside the repo root (OCR --rule; regular files only)",
    paramBackgroundFile:
      "Path to a Markdown requirements file inside the repo root (OCR --background-file; takes precedence over background)",
    paramNoPlan: "true = skip scan's per-file PLAN_TASK pre-pass (cheaper)",
    paramNoDedup: "true = skip scan's per-batch DEDUP_TASK (cheaper)",
    paramNoSummary: "true = skip scan's post-run PROJECT_SUMMARY_TASK (cheaper)",
    paramScanResume: "Resume a previously interrupted scan session id",
    paramBatch: "Batching strategy",
    paramPaths: "Repo-relative file paths to look up (at least 1, at most 200)",
    paramSessionAction:
      "list: recent sessions (default) / show: one session / comments: comment list / compare: two sessions / export: HTML",
    paramSessionId: "Session id for action=show/comments/export (export defaults to the newest)",
    paramSessionBefore: "Required for action=compare: the older session id",
    paramSessionAfter: "Required for action=compare: the newer session id",
    paramSessionSeverity: "action=comments severity filter (critical/high/medium/low)",
    paramSessionCategory: "action=comments category filter (e.g. bug/security)",
    paramSessionLimit: "list cap 1-100 (default 10)",
    paramRulesPath: "File path to look up (repo-relative or absolute; used only for rule matching)",
    paramLlmAction: "providers: built-in provider list / models: ChatGPT account model list",
    unitGroup: "group",
    unitFile: "file",
    tuningConcurrency: "Concurrent {unit} count (OCR --concurrency; unset = OCR native 8)",
    tuningTimeout:
      "Per-{unit} task timeout in minutes (OCR --timeout; review scales it by the effort round count, scan does not; 0 = unlimited; unset = OCR native 15)",
    tuningMaxTools:
      "Per-{unit} tool-call round cap (OCR --max-tools; 0 = template default; 1-49 is raised to 50 by OCR, help text says min 50; unset = template default)",
    tuningMaxToolsScan:
      "Per-{unit} tool-call round cap (OCR --max-tools; 0 = template default; only takes effect above the template default, never raised to 50; unset = template default)",
    tuningMaxTokens:
      "Per-{unit} prompt token cap (OCR --max-tokens; 0 = config/template default; unset = template default)",
    tuningMaxTokensBudget:
      "Total token (input+output) budget gate for this run; dispatch stops once exceeded (OCR --max-tokens-budget; 0 = unlimited; unset = unlimited)",
    previewHint:
      "For each reviewable file, get its diff with git diff <merge_base>..<to> -- <path> (branch) / " +
      "git show <commit> -- <path> (commit) / git diff HEAD -- <path>, or read the file directly " +
      "(new workspace files).",
    filePreviewHint:
      "This is a file-selection preview: no LLM call and no session were created. Drop preview and " +
      "rerun to actually review. Lists are capped; when truncated=true, narrow the scope with " +
      "exclude/path.",
    ruleHint:
      "Review the files of each group against its rule and emit comment suggestions in the shape " +
      "{path, content, start_line, end_line, category, severity}.",
    sessionEmpty: "(no review sessions yet: run ocr_review/ocr_scan once before querying)",
    sessionTruncated: "…[truncated] full content in ~/.opencodereview/sessions/",
    sessionResumeHint:
      "To resume an interrupted range/commit review: ocr_review ... --resume <session_id> (workspace reviews cannot be resumed); scan sessions use ocr_scan ... --resume <session_id>.",
    rulesCheckHint:
      "Source names the winning layer (--rule/project/global/built-in) and Pattern the glob; rules are first-match in declaration order.",
    llmHint:
      "providers is the built-in catalogue; models is the ChatGPT account-specific list; the effective review provider/model still comes from OCR's own config.",
    routingText: `
- When the user asks to "review the code / Review / check my changes / review this commit or PR", use the ocr tools:
  - ocr_review: OCR reviews workspace/commit/branch changes with its own configured LLM (effort controls depth, background carries context).
  - ocr_scan: whole-file review of directories without git history, or of given paths.
  - ocr_delegate_preview / ocr_delegate_rule: deterministic scaffolding that only returns "file list + fitting rules"
    (zero LLM cost on the OCR side); pair it with git diff and review yourself — good for reusing this session's model,
    or for confirming the scope before deciding to run ocr_review.
  - preview=true on ocr_review / ocr_scan: list the file selection and exclusion reasons only — zero LLM, no session;
    scan also supports noPlan/noDedup/noSummary to cut cost and resume to continue an interrupted scan.
  - ocr_session: list/show/comments (severity/category filters)/compare (new/persisting/resolved/not_reviewed)/export.
  - ocr_rules_check / ocr_llm: read-only diagnostics for rule resolution and the LLM catalogue; no review, no tokens.
  - Unsure about the scope? Run ocr_delegate_preview or preview=true first (costs no tokens); if the scope is huge, narrow it with
    exclude or split by commit.
- The OCR endpoint/provider/model comes from "Settings → Plugins → ocr-review card", fed by the provider list of
  the host settings service (the key is read dynamically through api_key_cmd and never stored in plaintext);
  provider/model can also be overridden per call.
- Before ocr_review / ocr_scan, analyse the change intent via git log/diff/commit messages and pass 3-5 sentences of
  business context as background (the official open-code-review skill says "always carry it" — the single most
  effective quality knob).
- Read the result through two separate notions, neither replaces the other: coverage (selected is the denominator)
  and budgetExceeded say whether the run finished covering everything, while droppedCount/invalidCommentCount only
  say whether this summary listed everything OCR produced. A toolCalls.failure above 0 means the current model does
  not drive tool calls — switch to a model with native tool calls (sensenova, deepseek, glm, qwen families) instead
  of retrying the same one; when OCR runs with --audience agent its progress lines are dropped, so text such as
  "No tool calls parsed" can never show up in the output and this field is the only way to see it.
- LLM calls retry themselves: OCR has built-in backoff retries (429/408/409 and 5xx); per-file group failures are
  isolated and land in coverage.failedItems (in warnings when the output carries no manifest) instead of re-running
  everything. After a tool-layer timeout (min(request, the maxTimeoutMs setting of the shell executor itself,
  10 minutes by default) or partial file failures, use ocr_session to find the session_id and ocr_review --resume
  to continue an interrupted range/commit review, or ocr_scan --resume to continue a scan.
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
