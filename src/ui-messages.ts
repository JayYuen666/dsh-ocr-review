// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化**那条 register 重载
// （`ctx.locale.register(ns, dicts)`，一次交齐两语）+ `ctx.locale.bind(ns)`，语言切换由
// 宿主驱动、无需重载页面（见 client-entry.ts 的 apply）。键集之所以能由官方表达式给出，
// 靠的是本文件把 `ocr-review` merge 进了官方 `LocaleNamespaceMap`（见下面）。
// 插值不放进字典（官方字典是扁平字符串表）：带变量的整行由调用点用固定模板 + 本表片段拼。
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
  /** providers 端点请求失败整行（含原因与自救提示）。 */
  readonly loadProvidersFailed: string;
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
  /** 设置快照还在加载时的提示。 */
  readonly settingsLoading: string;
  /** key 走动态读取的说明。 */
  readonly keyDynamicHint: string;
  /** get-cred 脚本缺失的警告。 */
  readonly keyScriptMissing: string;
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
      "ocr 工具配置：选择 provider/model 应用到 OCR（key 走 api_key_cmd 动态读取，不落明文）+ 审查参数设置",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：",
    loadProvidersFailed: "加载 providers 失败：{error}（端点未就绪？重启 dsh 后重试）",
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
    effortHint: "low=1 轮快速反馈 / medium=2 轮默认 / high=3 轮深查（越深越贵）",
    effortLow: "low — 快速",
    effortMedium: "medium — 均衡（默认）",
    effortHigh: "high — 深入",
    languageLabel: "评审语言",
    languageHint: "OCR 评论输出语言（写入 config.language）",
    autoVerifyLabel: "应用后自动验证",
    autoVerifyHint: "选择 provider/model 后自动跑 ocr llm test",
    onLabel: "开启",
    offLabel: "关闭",
    maxCommentsLabel: "摘要评论条数 (maxComments)",
    maxCommentsHint: "返回给模型的 top 评论条数；0 = 全部（含未锚定行，输出大）（默认 12）",
    timeoutLabel: "运行超时 (timeoutMinutes)",
    timeoutHint:
      "前台墙钟超时（分钟）；0 = 宿主上限（shell.maxTimeoutMs，当前 60 分钟）；更长的评审用工具 wait=false 后台模式（不设宿主 deadline，2 小时后兜底回收）（默认 0）",
    configPathLabel: "OCR 配置文件 (ocrConfigPath)",
    configPathHint:
      "外部 open-code-review CLI 自己的配置位置；留空 = ~/.opencodereview/config.json。自定义时必须是 <X>/.opencodereview/config.json 布局（OCR 只认该形状，插件经 HOME 重定向让它生效）",
    settingsLoading: "设置加载中，稍候可改",
    keyDynamicHint: "key 走 get-cred.mjs 动态读取，OCR 配置不留明文",
    keyScriptMissing: "⚠ get-cred 脚本缺失，api_key_cmd 无法工作",
  },
  en: {
    cardTitle: "open-code-review code review",
    cardDescription:
      "ocr tool setup: pick a provider/model and apply it to OCR (keys are read dynamically via api_key_cmd, never stored in plain text) + review parameters",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "save failed: ",
    loadProvidersFailed:
      "failed to load providers: {error} (endpoint not ready? restart dsh and retry)",
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
      "low = 1 pass quick feedback / medium = 2 passes default / high = 3 passes deep review (deeper costs more)",
    effortLow: "low — quick",
    effortMedium: "medium — balanced (default)",
    effortHigh: "high — thorough",
    languageLabel: "Review language",
    languageHint: "Output language of OCR comments (written into config.language)",
    autoVerifyLabel: "Verify after applying",
    autoVerifyHint: "Run `ocr llm test` automatically after picking a provider/model",
    onLabel: "On",
    offLabel: "Off",
    maxCommentsLabel: "Summary comment cap (maxComments)",
    maxCommentsHint:
      "Top comments returned to the model; 0 = all (including unanchored lines, large output) (default 12)",
    timeoutLabel: "Run timeout (timeoutMinutes)",
    timeoutHint:
      "Foreground wall-clock timeout in minutes; 0 = host cap (shell.maxTimeoutMs, currently 60 min); for longer reviews use the tool's wait=false background mode (no host deadline, reclaimed by a 2-hour backstop) (default 0)",
    configPathLabel: "OCR config file (ocrConfigPath)",
    configPathHint:
      "Where the external open-code-review CLI keeps its own config; empty = ~/.opencodereview/config.json. A custom value must follow the <X>/.opencodereview/config.json layout (OCR only reads that shape; the plugin makes it effective via a HOME redirect)",
    settingsLoading: "settings still loading — editable in a moment",
    keyDynamicHint: "Keys are read dynamically via get-cred.mjs; OCR config keeps no plain text",
    keyScriptMissing: "⚠ get-cred script missing, api_key_cmd cannot work",
  },
};
