// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化**那条 register 重载
// （`ctx.locale.register(ns, dicts)`，一次交齐两语）+ `ctx.locale.bind(ns)`，语言切换由
// 宿主驱动、无需重载页面（见 client-entry.ts 的 apply）。键集之所以能由官方表达式给出，
// 靠的是本文件把 `ocr-review` merge 进了官方 `LocaleNamespaceMap`（见下面）。
// 插值留在字典里：官方字典是扁平字符串表，`t(key, params)` 的 `{name}` 语法是官方
// 能力，所以带变量的整行（currentConfig / applied / loadProvidersFailed /
// readProvidersFailed / saveRefused）直接在本表留占位符，由调用点传 params，不在调用点拼模板。
//
// 不在此列的中文：`{ value: "中文", label: "中文" }` 那一行——value 是写进
// config.language 并透传给外部 ocr CLI 的枚举值，label 是语言的自称（任何界面语言
// 里「中文」都写作「中文」，翻成 Chinese 反而认错）。二者都不是界面文案。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么。 */
  readonly cardDescription: string;
  /** 作用域只读时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 保存失败前缀（后接错误摘要）。 */
  readonly saveFailed: string;
  /** 宿主拒收/跳过的字段整行（{fields} 为逗号分隔的字段名）。 */
  readonly saveRefused: string;
  /** providers 端点请求失败整行（含原因与自救提示）。 */
  readonly loadProvidersFailed: string;
  /** 当前部署没有远程面（或网关没挂上命名空间）时的可行动文案。 */
  readonly remoteUnavailable: string;
  /** providers 首次加载中的占位。 */
  readonly loadingProviders: string;
  /** provider 下拉里没有 key 的条目后缀。 */
  readonly noKeySuffix: string;
  /** 选中 provider 没有任何 model 时的占位。 */
  readonly noModel: string;
  /** Provider 行说明。 */
  readonly providerHint: string;
  /** 应用按钮（空闲态）。 */
  readonly applyToOcr: string;
  /** 应用按钮（写入中）。 */
  readonly applying: string;
  /** 测试连接按钮。 */
  readonly testConnection: string;
  /** 迁移明文 key 按钮。 */
  readonly migrateKeys: string;
  /** 当前 OCR 配置整行模板。 */
  readonly currentConfig: string;
  /** currentConfig 里 model 那段（有 model 时才拼）。 */
  readonly modelPart: string;
  /** 当前 key 走 api_key_cmd 动态读取。 */
  readonly dynamicKey: string;
  /** 当前 key 是明文，建议迁移。 */
  readonly plainKeyWarning: string;
  /** OCR 配置里还没有 provider。 */
  readonly noProvider: string;
  /** 数据源不可用但宿主没给原因时的兜底说明。 */
  readonly noReason: string;
  /** 数据源不可用整行（含宿主给的原因）。 */
  readonly readProvidersFailed: string;
  /** 装载期端点自检未通过的一行（含宿主给的原始输出）。 */
  readonly endpointVerifyFailed: string;
  /** 回执：应用成功。 */
  readonly applied: string;
  /** 回执：未自动验证。 */
  readonly notVerified: string;
  /** 回执：llm test 通过。 */
  readonly llmTestPassed: string;
  /** 回执：llm test 失败前缀（后接输出摘要）。 */
  readonly llmTestFailed: string;
  /** 回执：请先选 provider 与 model。 */
  readonly pickProviderModel: string;
  /** 回执：应用失败（宿主没给原因时）。 */
  readonly applyFailed: string;
  /** 回执：请求失败前缀（后接错误摘要）。 */
  readonly requestFailed: string;
  /** 回执：迁移成功前缀（后接 provider 名单）。 */
  readonly migratedPrefix: string;
  /** 回执：没有明文 key 可迁。 */
  readonly noPlainKey: string;
  /** 回执：跳过项前缀（后接 provider 名单）。 */
  readonly skippedPrefix: string;
  /** 回执：迁移失败。 */
  readonly migrateFailed: string;
  /** effort 行标题。 */
  readonly effortLabel: string;
  /** effort 行说明。 */
  readonly effortHint: string;
  readonly effortAuto: string;
  readonly effortLow: string;
  readonly effortMedium: string;
  readonly effortHigh: string;
  /** 评审语言行标题。 */
  readonly languageLabel: string;
  /** 评审语言行说明。 */
  readonly languageHint: string;
  /** 自动验证行标题。 */
  readonly autoVerifyLabel: string;
  /** 自动验证行说明。 */
  readonly autoVerifyHint: string;
  /** 开关选项：开。 */
  readonly onLabel: string;
  /** 开关选项：关。 */
  readonly offLabel: string;
  /** maxComments 行标题。 */
  readonly maxCommentsLabel: string;
  /** maxComments 行说明。 */
  readonly maxCommentsHint: string;
  /** timeoutMinutes 行标题。 */
  readonly timeoutLabel: string;
  /** timeoutMinutes 行说明。 */
  readonly timeoutHint: string;
  /** ocrConfigPath 行标题。 */
  readonly configPathLabel: string;
  /** ocrConfigPath 行说明。 */
  readonly configPathHint: string;
  /** MCP 管理区标题。 */
  readonly mcpTitle: string;
  readonly mcpHint: string;
  readonly mcpSave: string;
  readonly mcpSaving: string;
  readonly mcpSaved: string;
  readonly mcpLoadFailed: string;
  /** ChatGPT 管理区标题。 */
  readonly chatGptTitle: string;
  readonly chatGptHint: string;
  readonly chatGptCheck: string;
  readonly chatGptChecking: string;
  readonly chatGptModelLabel: string;
  readonly chatGptUse: string;
  readonly chatGptUsing: string;
  readonly chatGptSaved: string;
  readonly chatGptLoginHint: string;
  /** 当前部署没有远程面。 */
  readonly adminUnavailable: string;
  /** 设置快照还在加载时的提示。 */
  readonly settingsLoading: string;
  /** key 走动态读取的说明。 */
  readonly keyDynamicHint: string;
  /** get-cred 脚本缺失的警告。 */
  readonly keyScriptMissing: string;
  // ── 外部 CLI 可得性与版本探测 ──────────────────────────────────────────────
  /** 状态行的小标题。 */
  readonly binaryTitle: string;
  /** 宿主没报可得性（载荷缺字段或形状不合）。 */
  readonly binaryUnknown: string;
  /** 随包兜底入口在盘上：{path} 绝对路径，{channel} 装法。 */
  readonly binaryBundled: string;
  /** PATH 上的全局安装：{path} 是命中的绝对路径，{channel} 是那份的装法。 */
  readonly binaryPath: string;
  /** 两条路都没有候选。 */
  readonly binaryNone: string;
  /** 命中那份是 brew formula 装的。 */
  readonly channelBrew: string;
  /** 命中那份是 npm 一类的包管理器装的。 */
  readonly channelNpm: string;
  /** 路径落在两种典型布局之外（手工 cp、npx、别的前缀），不猜。 */
  readonly channelUnknown: string;
  /** 本插件契约核对所依据的版本那一行：{expected}。 */
  readonly versionExpected: string;
  /** 实测版本与核对版本一致：{actual}。 */
  readonly versionMatched: string;
  /** 实测版本与核对版本不一致：{actual} 实测、{expected} 核对。 */
  readonly versionDiverged: string;
  /** 徽标在「实测过且不一致」时改口的那句短文案。 */
  readonly badgeDiverged: string;
  /** 「检测」按钮（空闲态）。 */
  readonly detectCli: string;
  /** 「检测」按钮（进行中）。 */
  readonly detecting: string;
  /** 探测成功：{version} 是从 `ocr version` 回执里取出的版本串。 */
  readonly probeVersion: string;
  /** 探测失败：{reason} 是宿主给的理由，原文另起一行附在其后。 */
  readonly probeReason: string;
  /** 详情页徽标（短文案，四档与 `binary*` 一一对应）。 */
  readonly badgeBundled: string;
  readonly badgePath: string;
  readonly badgeNone: string;
  readonly badgeUnknown: string;
  /** 详情页区块里那句「版本号要在配置卡片里点检测」。 */
  readonly binaryProbeHint: string;
  /** 启用后指引上的两个按钮。 */
  readonly binaryGuideDetails: string;
  readonly binaryGuideDismiss: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:22-31`「Locale namespace table. Dictionary
 * owners extend via declaration merging (exactly like {@link SlotMap} …)」）。这不是可选
 * 的美化：官方 `LocaleRuntime.bind` 有两条重载（installed
 * `dsh-client-locale/lib/types/client/index.d.ts:219` 的类型化那条、:226 的
 * `bind(ns: string): Translate` 未类型化那条），不 merge 时本包命名空间只能落到后面那条，
 * 拿回来的 `t` 键域是宽 `string`——卡片要的键集收窄的 `t` 于是**没有任何官方来源**，
 * 本地只好继续手写一个官方给不出的函数形状。实测撤掉下面这一行（本包不再 merge），
 * 官方 `LocaleDictOf` / `TranslateNS` 的约束域立刻只剩宿主包 merge 的那三个命名空间
 * （`Type '"ocr-review"' does not satisfy the constraint
 * '"common" | "pluginManager" | "settings.locale"'`，TS2344）：merge 是键域的**唯一**入口。
 * merge 之后键集由官方 `TranslateNS<NS>`（`index.d.ts:67`，`= Translate<LocaleKeysOf<N>>`，
 * :45/:59）表达，`t("拼错的键")` 在编译期红。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面的等式常量是本源，
 * client-entry.ts 的 `NS` 按它的类型 `LocaleNs` 标注：两边哪天分叉，那行编译期就红。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键。 */
    "ocr-review": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 用它取 `TranslateNS`）与卡片
 *  条目 id 必须是同一个串——改任何一处都要动这一行才会红。 */
const LOCALE_NS_KEY = "ocr-review" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "ocr-review"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `index.d.ts:67`，
 * `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) => string`，
 * `index.d.ts:45`）——键域就是上面 merge 的 `keyof UiMessages` **并上**官方 `common`
 * 命名空间的共享词（官方 `LocaleKeysOf` 的并集：宿主查找链在本命名空间 miss 之后确实
 * 会去 consult common），函数面完全归官方。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "open-code-review 代码审查",
    cardDescription:
      "ocr 工具配置：选择 provider/model 应用到 OCR（应用后 key 由 api_key_cmd 动态读取，不再写入明文）+ 审查参数设置",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：",
    saveRefused: "未写入（宿主拒收或跳过）：{fields}",
    loadProvidersFailed: "加载 providers 失败：{error}（远程面未就绪？重启 dsh 后重试）",
    remoteUnavailable: "远程服务不可用：宿主没有挂上本插件的设置通道。",
    loadingProviders: "加载 providers…",
    noKeySuffix: "（未配置 key）",
    noModel: "（无模型）",
    providerHint: "来自 dsh 配置服务的 llm-pi-ai 命名空间（无 API key 的已禁用）",
    applyToOcr: "应用到 OCR 配置",
    applying: "应用中…",
    testConnection: "测试连接",
    migrateKeys: "迁移明文 key",
    currentConfig: "当前配置：{provider}{modelPart}{keyPart}",
    modelPart: " / {model}",
    dynamicKey: "（动态 key）",
    plainKeyWarning: "（⚠ 明文 key，建议迁移）",
    noProvider: "当前未配置 provider",
    noReason: "宿主未给出原因（重启 dsh 或重试可恢复）",
    readProvidersFailed: "未能从 dsh 配置服务读取 provider 列表：{reason}",
    endpointVerifyFailed:
      "装载期端点自检未通过：{reason}（这条是端点给的回执，不是本插件的故障；配置照样能改，也可点「测试连接」重跑）",
    applied: "已应用：{provider} / {model}\n{test}",
    notVerified: "（未自动验证，可点「测试连接」手动验证）",
    llmTestPassed: "✓ ocr llm test 通过",
    llmTestFailed: "✗ ocr llm test 失败：",
    pickProviderModel: "请先选择 provider 与 model",
    applyFailed: "应用失败",
    requestFailed: "请求失败：",
    migratedPrefix: "已迁移明文 key → api_key_cmd：",
    noPlainKey: "没有需要迁移的明文 key",
    skippedPrefix: "\n跳过（settings 中无对应 apiKeyEnv）：",
    migrateFailed: "迁移失败",
    effortLabel: "审查深度 (effort)",
    effortHint:
      "auto=跟随 OCR 自身配置 / low=1 轮快速反馈 / medium=2 轮 / high=3 轮深查（越深越贵）",
    effortAuto: "auto — 跟随 OCR 配置",
    effortLow: "low — 快速",
    effortMedium: "medium — 均衡",
    effortHigh: "high — 深入",
    languageLabel: "评审语言",
    languageHint: "OCR 评论输出语言（写入 config.language）",
    autoVerifyLabel: "应用后自动验证",
    autoVerifyHint: "选择 provider/model 后自动跑 ocr llm test",
    onLabel: "开启",
    offLabel: "关闭",
    maxCommentsLabel: "摘要评论条数 (maxComments)",
    maxCommentsHint:
      "返回给模型的 top 评论条数；0 = 全部（含未锚定行，输出大）（默认见本行设置项的初值）",
    timeoutLabel: "运行超时 (timeoutMinutes)",
    timeoutHint:
      "前台墙钟超时（分钟）；0 = 请求宿主上限（实际生效值由 shell 执行器自己的 maxTimeoutMs 设置项决定，可在 bash-local / pwsh-local 的设置行里改）；更长的评审用工具 wait=false 后台模式（不设宿主 deadline，兜底窗口看设置项 ocrBackgroundMaxMs，默认 0 = 不设窗口）（默认 0）",
    configPathLabel: "OCR 配置文件 (ocrConfigPath)",
    configPathHint:
      "外部 open-code-review CLI 自己的配置位置；留空 = ~/.opencodereview/config.json。自定义时必须是 <X>/.opencodereview/config.json 布局（OCR 只认该形状，插件经 HOME 重定向让它生效）",
    mcpTitle: "MCP servers",
    mcpHint:
      "编辑外部 OCR 的 mcp_servers（JSON）。stdio server 会在评审时执行命令，只在这里由人配置；保存只改这一支，其他配置原样保留。",
    mcpSave: "保存 MCP",
    mcpSaving: "保存中…",
    mcpSaved: "MCP servers 已保存",
    mcpLoadFailed: "读取 MCP 配置失败：",
    chatGptTitle: "ChatGPT（OCR auth）",
    chatGptHint: "登录态由 ocr auth 管理；本卡片只读查询状态，并在登录后把 provider 切到 chatgpt。",
    chatGptCheck: "检查登录态",
    chatGptChecking: "检查中…",
    chatGptModelLabel: "ChatGPT 模型 slug",
    chatGptUse: "使用 ChatGPT",
    chatGptUsing: "应用中…",
    chatGptSaved: "已切换到 ChatGPT provider",
    chatGptLoginHint: "登录请在终端运行：",
    adminUnavailable: "当前部署没有远程面，MCP/ChatGPT 管理区不可用",
    settingsLoading: "设置加载中，稍候可改",
    keyDynamicHint: "key 走 get-cred.mjs 动态读取，OCR 配置不留明文",
    keyScriptMissing: "⚠ get-cred 脚本缺失，api_key_cmd 无法工作",
    binaryTitle: "外部 CLI（ocr）",
    binaryUnknown: "状态未取到：刷新本页，或确认 dsh 的 web 服务已起来",
    binaryBundled: "随本插件分发的兜底入口已就位：{path}（{channel}）",
    binaryPath: "用 PATH 上的全局安装：{path}（{channel}）",
    binaryNone:
      "未找到 ocr：PATH 与随包兜底两条路都没有可执行候选。装法与版本看下一行（由插件按核对版本给出）",
    channelBrew: "brew formula",
    channelNpm: "npm 全局包",
    channelUnknown: "装法未识别",
    versionExpected: "本插件的契约按 ocr {expected} 逐条核对",
    versionMatched: "本机实测 {actual}，与核对版本一致",
    versionDiverged: "本机实测 {actual}，与核对版本 {expected} 不一致：评论口径可能随版本漂移",
    badgeDiverged: "ocr 版本不一致",
    detectCli: "检测版本",
    detecting: "检测中…",
    probeVersion: "ocr 版本：{version}",
    probeReason: "未取到版本号：{reason}",
    badgeBundled: "ocr 走随包兜底",
    badgePath: "ocr 来自 PATH",
    badgeNone: "未找到 ocr",
    badgeUnknown: "ocr 状态未取到",
    binaryProbeHint: "版本号要在「配置」页点「检测版本」取——那要起一次 ocr 进程，不在本页顺手跑。",
    binaryGuideDetails: "打开插件详情",
    binaryGuideDismiss: "知道了",
  },
  en: {
    cardTitle: "open-code-review code review",
    cardDescription:
      "ocr tool setup: pick a provider/model and apply it to OCR (once applied, keys are read dynamically via api_key_cmd and no longer written in plain text) + review parameters",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "save failed: ",
    saveRefused: "not written (host refused or skipped): {fields}",
    loadProvidersFailed:
      "failed to load providers: {error} (remote face not ready? restart dsh and retry)",
    remoteUnavailable:
      "remote service unavailable: the host did not mount this plugin's settings channel",
    loadingProviders: "loading providers…",
    noKeySuffix: " (no key configured)",
    noModel: " (no model)",
    providerHint:
      "From the llm-pi-ai namespace of the dsh settings service (entries without an API key are disabled)",
    applyToOcr: "Apply to OCR config",
    applying: "applying…",
    testConnection: "Test connection",
    migrateKeys: "Migrate plain-text keys",
    currentConfig: "Current config: {provider}{modelPart}{keyPart}",
    modelPart: " / {model}",
    dynamicKey: " (dynamic key)",
    plainKeyWarning: " (⚠ plain-text key, migration recommended)",
    noProvider: "No provider configured yet",
    noReason: "the host gave no reason (restart dsh or retry to recover)",
    readProvidersFailed: "Could not read the provider list from the dsh settings service: {reason}",
    endpointVerifyFailed:
      "Startup endpoint check did not pass: {reason} (this is the endpoint's reply, not a fault of this plugin; the config stays editable, and “Test connection” reruns it)",
    applied: "Applied: {provider} / {model}\n{test}",
    notVerified: "(not verified automatically — use “Test connection” to check manually)",
    llmTestPassed: "✓ ocr llm test passed",
    llmTestFailed: "✗ ocr llm test failed: ",
    pickProviderModel: "Pick a provider and a model first",
    applyFailed: "apply failed",
    requestFailed: "request failed: ",
    migratedPrefix: "Migrated plain-text keys → api_key_cmd: ",
    noPlainKey: "no plain-text keys to migrate",
    skippedPrefix: "\nSkipped (no apiKeyEnv in settings): ",
    migrateFailed: "migration failed",
    effortLabel: "Review depth (effort)",
    effortHint:
      "auto = follow the OCR config / low = 1 pass quick feedback / medium = 2 passes / high = 3 passes deep review (deeper costs more)",
    effortAuto: "auto — follow the OCR config",
    effortLow: "low — quick",
    effortMedium: "medium — balanced",
    effortHigh: "high — thorough",
    languageLabel: "Review language",
    languageHint: "Output language of OCR comments (written into config.language)",
    autoVerifyLabel: "Verify after applying",
    autoVerifyHint: "Run `ocr llm test` automatically after picking a provider/model",
    onLabel: "On",
    offLabel: "Off",
    maxCommentsLabel: "Summary comment cap (maxComments)",
    maxCommentsHint:
      "Top comments returned to the model; 0 = all (including unanchored lines, large output) (default: the row's initial value)",
    timeoutLabel: "Run timeout (timeoutMinutes)",
    timeoutHint:
      "Foreground wall-clock timeout in minutes; 0 = ask for the host cap (the effective value comes from the maxTimeoutMs setting of the shell executor itself — edit it on the bash-local / pwsh-local settings row); for longer reviews use the tool's wait=false background mode (no host deadline; the backstop window is the ocrBackgroundMaxMs setting, default 0 = none) (default 0)",
    configPathLabel: "OCR config file (ocrConfigPath)",
    configPathHint:
      "Where the external open-code-review CLI keeps its own config; empty = ~/.opencodereview/config.json. A custom value must follow the <X>/.opencodereview/config.json layout (OCR only reads that shape; the plugin makes it effective via a HOME redirect)",
    mcpTitle: "MCP servers",
    mcpHint:
      "Edit the external OCR mcp_servers JSON. A stdio server runs commands during reviews, so this is human-managed here; saving touches only this key and preserves everything else.",
    mcpSave: "Save MCP",
    mcpSaving: "Saving…",
    mcpSaved: "MCP servers saved",
    mcpLoadFailed: "Failed to read the MCP config: ",
    chatGptTitle: "ChatGPT (OCR auth)",
    chatGptHint:
      "Sign-in is managed by ocr auth; this card only reports the status and switches OCR's provider to chatgpt after you sign in.",
    chatGptCheck: "Check sign-in",
    chatGptChecking: "Checking…",
    chatGptModelLabel: "ChatGPT model slug",
    chatGptUse: "Use ChatGPT",
    chatGptUsing: "Applying…",
    chatGptSaved: "Switched to the ChatGPT provider",
    chatGptLoginHint: "Run the sign-in in a terminal:",
    adminUnavailable:
      "No remote surface in this deployment; the MCP/ChatGPT admin section is unavailable",
    settingsLoading: "settings still loading — editable in a moment",
    keyDynamicHint: "Keys are read dynamically via get-cred.mjs; OCR config keeps no plain text",
    keyScriptMissing: "⚠ get-cred script missing, api_key_cmd cannot work",
    binaryTitle: "External CLI (ocr)",
    binaryUnknown: "status not reported: reload this page, or check that the dsh web server is up",
    binaryBundled: "bundled fallback entry in place: {path} ({channel})",
    binaryPath: "using the global install on PATH: {path} ({channel})",
    binaryNone:
      "ocr not found: neither PATH nor the bundled fallback has an executable candidate. The install command and version are on the next line (this plugin states the version its contract was verified against)",
    channelBrew: "brew formula",
    channelNpm: "npm global package",
    channelUnknown: "install method unrecognised",
    versionExpected: "this plugin's contract was verified against ocr {expected}",
    versionMatched: "this machine reports {actual}, matching it",
    versionDiverged:
      "this machine reports {actual}, which is not the verified {expected}: comment wording and severity may drift between versions",
    badgeDiverged: "ocr version differs",
    detectCli: "Detect version",
    detecting: "Detecting...",
    probeVersion: "ocr version: {version}",
    probeReason: "no version read: {reason}",
    badgeBundled: "ocr from bundled fallback",
    badgePath: "ocr from PATH",
    badgeNone: "ocr not found",
    badgeUnknown: "ocr status unavailable",
    binaryProbeHint:
      "the version comes from the Detect action on the configuration page — that spawns an ocr process, so it is not run here",
    binaryGuideDetails: "Open plugin details",
    binaryGuideDismiss: "Got it",
  },
};
