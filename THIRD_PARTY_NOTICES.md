# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**与第三方的边界**：
哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码的分界在哪里。

## 结论：随包分发的第三方内容只有一处

`host.ts`、`lib/`、`src/`、`scripts/` 下全部是本仓原创代码，不含任何第三方源码或文案。
`@alibaba-group/open-code-review`（外部 `ocr` CLI）与 `js-yaml` 都是**运行期才涉及的东西**——
本包通过它们的公开入口调用它们，许可文本随各自的包走，本文件不重复其文本；见下面的运行期依赖表。
外部 CLI 尤其如此：它**不在本包的依赖表里**，由用户自己装（brew formula 或 npm 全局包），
本包只 spawn 它的可执行体。

唯一随包分发的第三方内容是**图标**（`icon.svg`），见下节。

## 图标：open-code-review 官方标记

- 上游项目：`open-code-review`
- 上游仓库：https://github.com/alibaba-group/open-code-review
- 上游资源：https://open-codereview.ai/dbd8996c7419925db8e3.svg（64×64 SVG）
- 上游许可：Apache-2.0

`icon.svg` 就是这份官方 SVG 的**原样副本**：图形、配色（`#2BDE5E` 绿底 + 黑色眼睛）
与圆角全部来自上游，形状与路径数据一字未改（只压掉了标签之间的换行空白）。同一份字节也
内联在 `client.js` 里，作为设置页导航图标的背景图。

与另外两个仓不同，这里**不需要**按主题重新上色：官方标记自带绿底，深色与浅色主题下都看得清。
Apache-2.0 的再分发义务是保留版权与许可声明（并在修改的文件上说明）——本节即为此而设。

## 机制与接口来源：open-code-review（ocr CLI）

- 上游项目：`open-code-review`
- 上游仓库：https://github.com/alibaba/open-code-review
- 上游许可：Apache-2.0，Copyright 2026 Alibaba
- 验证版本：1.13.9（声明在 package.json 的 `ocrCliVersion`，代码里的镜像常量、两侧 README 和随包文档由一条门禁对齐到同一个数字）

本包**使用**而非**包含**以下接口（`host.ts` / `lib/cli.ts` 的头注释按该版本源码逐条核对）：

| 接口 | 用途 |
| --- | --- |
| `ocr review` / `ocr scan` | diff 审查与全文件扫描（`--audience agent --format json --output` 输出机器可读的结果；`--preview`、`--no-filter`、scan 的 `--no-plan/--no-dedup/--no-summary/--resume`、`--max-git-procs`、`--rule`、`--background-file`） |
| `ocr delegate preview` / `ocr delegate rule` | 委托模式脚手架（文件清单 + 规则分组，OCR 端零 LLM 消耗；含 `--rule`/`--background-file`/`--max-git-procs`） |
| `ocr session list/show/comments/compare/export` | 会话查询、四桶比较与 HTML 导出（含 `--resume` 恢复） |
| `ocr rules check` | 单文件规则层/glob/正文诊断 |
| `ocr llm test` / `providers` / `models` | select 后的连通性验证与 LLM 清单查询 |
| `ocr auth status` | 设置卡查询 ChatGPT 登录态；登录/登出仍由用户在终端执行 |
| `config.json` 的 `mcp_servers` 与 `providers.chatgpt.model` | MCP 管理区与 ChatGPT provider 选择；只改对应分支，不写 key |
| `config.json` 的 `providers.<name>` / `custom_providers.<name>.{url,protocol,model,api_key_cmd}` | provider/model 的应用配置（内置名落 `providers`，自定义名落 `custom_providers`）；key 经 `api_key_cmd` 动态读取，绝不落明文 |

这些都是 CLI 的外层面，但不是任何文档承诺过的稳定 API——本包把约定钉在上面那一版正是为了
守住这一组接口；上游变更时以本包的契约闸测试（`test/cli.test.ts`、`test/parse.test.ts`）为
首道防线，版本对不上时卡片、徽标与工具回执都会说（见 README 的 “The external CLI” 一节）。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不重复其文本：

| 依赖 | 版本 | 许可 | 引入方 |
| --- | --- | --- | --- |
| `@alibaba-group/open-code-review` | 1.13.9（核对版本，非依赖） | Apache-2.0（Alibaba） | **不在依赖表里**：用户自选 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review@<版本>`，本包只 spawn 它 |
| `js-yaml` | 5.5.0（精确钉版） | MIT | `scripts/get-cred.mjs` 读 dsh 托管凭据文档 |
| `@jayyuen66/dsh-plugin-shared` | catalog（伞根 ^0.2.8） | MIT | `host.ts` / `lib/*` / `src/*` 的 job-outcome、locale、record、errors、card-* 等公共模块（值导入，构建时外部化） |
| `zod` | catalog（伞根 4.6.7） | MIT | 设置卡 `src/remote.ts` 的 strict codec 形状校验；client 产物由宿主 `PLATFORM_MODULES` 提供 |

dsh 宿主侧的包分两档：产物里以**值**导入、且列在 `peerDependencies` 的五枚（`@deepseek-ai/schemastery` 宿主 fork、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write` 与 `@deepseek-ai/dsh-typert-protocol`）由宿主在场提供、不随本包分发；其余 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 只在 `devDependencies` 里，用途是把类型绑到官方声明上（type-only 绑定），产物里不留说明符。本包按 dsh `0.2.2-rc.2` 逐条核对过（同版的 cordis `4.1.0` 与 schemastery `3.19.0` fork 一并核对）。
