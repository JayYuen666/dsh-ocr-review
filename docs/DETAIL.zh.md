# 代码评审（open-code-review）

调用外部 `ocr` 命令行评审一个变更集，回报它给出的意见，并管理用来评审的模型。

## 设置卡上改的是什么

- **模型** — `ocrProvider` 与 `ocrModel` 不是本插件存的值：它们是宿主模型命名空间的投影，没有可用密钥的条目照样列出但禁用。`chatGptModel` 是本插件写进外部命令行自己配置的 model slug（provider 置为 `chatgpt`，同时删掉 `api_key` / `api_key_cmd`）；该提供方背后的凭据来自命令行自己的登录态，本插件只查询 `ocr auth`，不保存。
- **审查参数** — `effort`（`auto`/`low`/`medium`/`high`）是跑几轮审查，越深越费时；**它只作用于 `ocr_review`**——外部命令行只在 review 上注册了 `--effort`，而它唯一改的「几轮」在 scan 模板里根本不存在，调它不会让扫描更深（扫描深度用下面那组 `scan*` 设置）。`language` 选中文或英文输出。`autoVerify`（默认开）在选完提供方与模型后跑一次 `ocr llm test`，选错当场就知道，而不是等第一次评审失败。`maxComments`（默认 12；0 表示全部，包括钉不到行上的意见）。`timeoutMinutes`（0 表示向宿主要上限；正数是分钟数，由本插件计时兜底，宿主的钳制不再截短它）。`ocrConfigPath`——留空就是 `~/.opencodereview/config.json`；填了就必须是 `<目录>/.opencodereview/config.json` 的形状，生效方式是重定向 `HOME`；Windows 上值能通过形状校验但不会重定向，命令行仍读默认路径。

`effort`、`maxComments`、`timeoutMinutes`、`ocrConfigPath`、`scanMaxTokens` 与 `scanConcurrency` 每次调用现读，改完下一次调用生效，不需要重启宿主。`language` 与 `autoVerify` 在应用一次 provider/model 选择时读取：`language` 当场写进命令行配置，`autoVerify` 只决定那时是否跑 `ocr llm test`。

## 扫描深度（`ocr_scan` 的缺省值）

卡上「扫描深度」那一节的两位是 `ocr_scan` 的**缺省值**，模型在调用里显式传了就听模型的：

- `scanMaxTokens` — `--max-tokens`，缺省 0 = 不传、用外部命令行的模板值 58888。它在提示词超过这个数的 80%（47110）时告警并收敛，大文件反复撞这道闸时把它调大；调 `--max-tools` 治不了这条。
- `scanConcurrency` — `--concurrency`，缺省 0 = 不传、用模板的 8。想对 provider 限速更温和就调小。

另三个不进卡（部署级，写在 `cordis.patch.yml` 注册行的 `config:` 块，改值随重启生效）：`scanMaxTools`（缺省 0 = 用模板的 60；scan 侧**只升不降**，小于 60 完全无效）、`scanNoPlan`、`scanNoDedup`（缺省 false；为真时每次调用都带上对应的 `--no-*`）。

## 两处都叫 MCP，但不是同一件事

卡上的 MCP servers 编辑器改的是**外部 `ocr` 工具自己的**配置。它与「Scrapling 网页抓取」那套 `integrationMode` / `mcpPort` 的 MCP 面没有关系，本插件也不对外提供 MCP 服务。

## 要重启的值

`llmTestTimeoutMs`（90000）、`startupVerify`（默认开：装载时只做一次本地 CLI 版本测量，不联网；装载期永远不打上游端点——端点检查只发生在「测试连接」或 `autoVerify` 应用时）、`ocrBackgroundMaxMs`（0 表示不设兜底窗口）、`stdoutMaxBytes`（400000）、`ocrNoAutoUpdate`（默认 false，即保留上游的自动升级，除非你明确关掉）、`ocrInstallHint`（`both`/`brew`/`npm`），以及 `ocrSandbox`（`full` 表示每个 ocr 子进程都请求 `danger-full-access`；`inherit` 表示跟随宿主执行器自报的沙箱模式——`workspace-write` 另加 OCR 状态目录与临时区的可写根，`read-only` 直接拒绝；Windows 上的 `workspace-write` 也直接拒绝，因为 dsh 0.2.2-rc.2 起 Windows 的额外可写目录不下发给受限子进程；继承档不带上部署自己配的 additional roots）。写在本插件于 `cordis.patch.yml` 注册行的 `config:` 块，改值随重启生效。

## 需要外部提供什么

`ocr` 命令行，期望版本 **1.13.10**；这个期望唯一声明在 `package.json` 的 `ocrCliVersion`，代码常量与两份 README 镜像同一个字符串，版本不符只作为提示报出，从不中断评审。装法是 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review@1.13.10`。PATH 上一个候选都没有时，预检报「no ocr candidate on either path」并附安装提示；「command not found」（exit 127）是另一种情况：候选在，但真二进制跑不起来。版本探测一律强制 `OCR_NO_UPDATE=1`，以免探测顺手触发升级。

API 凭据不存这里：本插件写的是一个 `api_key_cmd`，运行时的密钥由那支辅助脚本现取，不进配置文件。脚本缺失时卡上给出告警，而不是发一次没有鉴权的请求。

## 更完整的说明

暴露给模型的工具清单、后台评审如何落成宿主作业、参数守卫的旗标对照表都写在随包 README（`README.md` / `README.zh-CN.md`）。

## 反馈

欢迎提 issue 和 PR：[https://github.com/JayYuen666/dsh-ocr-review/issues](https://github.com/JayYuen666/dsh-ocr-review/issues)。

插件启动失败时，请附上 dsh 宿主版本、profile 安装形态和浏览器控制台原文。`missed the module table` 这一行尤其有用：它能直接说明 shared 客户端供应行有没有被物化。
