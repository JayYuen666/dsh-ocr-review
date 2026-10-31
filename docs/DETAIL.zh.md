# 代码评审（open-code-review）

调用外部 `ocr` 命令行评审一个变更集，回报它给出的意见，并管理用来评审的模型。

## 设置卡上改的是什么

- **模型** — `ocrProvider` 与 `ocrModel` 不是本插件存的值：它们是宿主模型命名空间的投影，没有可用密钥的条目照样列出但禁用。`chatGptModel` 是本插件写进外部命令行自己配置的 model slug（provider 置为 `chatgpt`，同时删掉 `api_key` / `api_key_cmd`）；该提供方背后的凭据来自命令行自己的登录态，本插件只查询 `ocr auth`，不保存。
- **审查参数** — `effort`（`auto`/`low`/`medium`/`high`）是跑几轮审查，越深越费时。`language` 选中文或英文输出。`autoVerify`（默认开）在选完提供方与模型后跑一次 `ocr llm test`，选错当场就知道，而不是等第一次评审失败。`maxComments`（默认 12；0 表示全部，包括钉不到行上的意见）。`timeoutMinutes`（0 表示向宿主要上限；正数是分钟数，仍由宿主收口）。`ocrConfigPath`——留空就是 `~/.opencodereview/config.json`；填了就必须是 `<目录>/.opencodereview/config.json` 的形状，生效方式是重定向 `HOME`；Windows 上值能通过形状校验但不会重定向，命令行仍读默认路径。

`effort`、`maxComments`、`timeoutMinutes` 与 `ocrConfigPath` 每次调用现读，改完下一次评审生效，不需要重启宿主。`language` 与 `autoVerify` 在应用一次 provider/model 选择时读取：`language` 当场写进命令行配置，`autoVerify` 只决定那时是否跑 `ocr llm test`。

## 两处都叫 MCP，但不是同一件事

卡上的 MCP servers 编辑器改的是**外部 `ocr` 工具自己的**配置。它与「Scrapling 网页抓取」那套 `integrationMode` / `mcpPort` 的 MCP 面没有关系，本插件也不对外提供 MCP 服务。

## 要重启的值

`llmTestTimeoutMs`（90000）、`startupVerify`（默认开：装载时自检端点）、`ocrBackgroundMaxMs`（0 表示不设兜底窗口）、`stdoutMaxBytes`（400000）、`ocrNoAutoUpdate`（默认 false，即保留上游的自动升级，除非你明确关掉）、`ocrInstallHint`（`both`/`brew`/`npm`）。写在本插件于 `cordis.patch.yml` 注册行的 `config:` 块，改值随重启生效。

## 需要外部提供什么

`ocr` 命令行，期望版本 **1.13.3**；这个期望唯一声明在 `package.json` 的 `ocrCliVersion`，代码常量与两份 README 镜像同一个字符串，版本不符只作为提示报出，从不中断评审。装法是 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review@1.13.3`。PATH 上一个候选都没有时，预检报「no ocr candidate on either path」并附安装提示；「command not found」（exit 127）是另一种情况：候选在，但真二进制跑不起来。版本探测一律强制 `OCR_NO_UPDATE=1`，以免探测顺手触发升级。

API 凭据不存这里：本插件写的是一个 `api_key_cmd`，运行时的密钥由那支辅助脚本现取，不进配置文件。脚本缺失时卡上给出告警，而不是发一次没有鉴权的请求。

## 更完整的说明

暴露给模型的工具清单、后台评审如何落成宿主作业、参数守卫的旗标对照表都写在随包 README（`README.md` / `README.zh-CN.md`）。
