# 代码评审（open-code-review）

调用外部 `ocr` 命令行评审一个变更集，回报它给出的意见，并管理用来评审的模型。

## 设置卡上改的是什么

- **模型** — `ocrProvider` 与 `ocrModel` 不是本插件存的值：它们是宿主模型命名空间的投影，没有可用密钥的条目照样列出但禁用。`chatGptModel` 反映的是外部命令行自己的登录态，本插件读它但不拥有它。
- **审查参数** — `effort`（`auto`/`low`/`medium`/`high`）是跑几轮审查，越深越费时。`language` 选中文或英文输出。`autoVerify`（默认开）在选完提供方与模型后跑一次 `ocr llm test`，选错当场就知道，而不是等第一次评审失败。`maxComments`（默认 12；0 表示全部，包括钉不到行上的意见）。`timeoutMinutes`（0 表示向宿主要上限；正数是分钟数，仍由宿主收口）。`ocrConfigPath`——留空就是 `~/.opencodereview/config.json`；填了就必须是 `<目录>/.opencodereview/config.json` 的形状，生效方式是重定向 `HOME`（仅 POSIX）。

其中六项每次调用现读，改完下一次评审生效，不需要重启宿主。

## 两处都叫 MCP，但不是同一件事

卡上的 MCP servers 编辑器改的是**外部 `ocr` 工具自己的**配置。它与「Scrapling 网页抓取」那套 `integrationMode` / `mcpPort` 的 MCP 面没有关系，本插件也不对外提供 MCP 服务。

## 要重启的值

`llmTestTimeoutMs`（90000）、`startupVerify`（默认开：装载时自检端点）、`ocrBackgroundMaxMs`（0 表示不设兜底窗口）、`stdoutMaxBytes`（400000）、`ocrNoAutoUpdate`（默认 false，即保留上游的自动升级，除非你明确关掉）、`ocrInstallHint`（`both`/`brew`/`npm`）。写在本插件注册行的 `config:` 块，改值随重启生效。

## 需要外部提供什么

`ocr` 命令行，期望版本 **1.13.3**；这个期望写在代码里，并镜像到包清单与两份 README，所以版本不符是被报出来的，不是被掩盖的。装法是 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review@1.13.3`。命令行不存在时按「找不到命令」报；只有垫片没有真二进制时说的也是这一件。版本探测一律强制 `OCR_NO_UPDATE=1`，以免探测顺手触发升级。

API 凭据不存这里：本插件写的是一个 `api_key_cmd`，运行时的密钥由那支辅助脚本现取，不进配置文件。脚本缺失时卡上给出告警，而不是发一次没有鉴权的请求。

## 更完整的说明

暴露给模型的工具清单、后台评审如何落成宿主作业、参数守卫的旗标对照表都写在随包 README（`README.md` / `README.zh-CN.md`）。
