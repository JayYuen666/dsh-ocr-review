# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**与第三方的边界**：
哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码的分界在哪里。

## 结论：随包分发的第三方内容只有一处

`host.ts`、`lib/`、`src/`、`scripts/` 下全部是本仓原创代码，不含任何第三方源码或文案。
`@alibaba-group/open-code-review`（外部 `ocr` CLI）与 `js-yaml` 都是**运行期依赖**——本包
通过它们的公开入口调用它们，许可文本随各自的包走，本文件不重复其文本；见下面的运行期依赖表。

唯一随包分发的第三方内容是**图标**（`icon.svg`），见下节。

## 图标：Tabler Icons

- 上游项目：`Tabler Icons`
- 上游仓库：https://github.com/tabler/tabler-icons
- 上游许可：MIT，Copyright (c) Paweł Kuna
- 取用图标：`code`（https://icones.js.org/icons/tabler/code）

`icon.svg` 的形状取自该图标的**两枚尖括号**：坐标整体平移（+1, −1）并去掉中间的斜杠笔画，
另加一枚对勾段（形态对齐 Tabler `check` 的笔画风格）。改动都不引入新的第三方形状：把
`currentColor` 换成本包插件图标配色（`#658EFF` 主色 + `#54ECE7` 底衬），并把外层 `<g>` 与
画布尺寸对齐本族插件统一的 `36×36` / `viewBox 0 0 24 24` 规格。

## 机制与接口来源：open-code-review（ocr CLI）

- 上游项目：`open-code-review`
- 上游仓库：https://github.com/alibaba/open-code-review
- 上游许可：Apache-2.0，Copyright 2026 Alibaba
- 验证版本：1.12.13（`optionalDependencies` 钉 `^1.12.13`）

本包**使用**而非**包含**以下接口（`host.ts` / `lib/cli.ts` 的头注释按该版本源码逐条核对）：

| 接口 | 用途 |
| --- | --- |
| `ocr review` / `ocr scan` | diff 审查与全文件扫描（`--audience agent --format json --output` 机器可读面） |
| `ocr delegate preview` / `ocr delegate rule` | 委托模式脚手架（文件清单 + 规则分组，OCR 端零 LLM 消耗） |
| `ocr session list/show/comments` | 会话查询闭环（含 `--resume` 恢复） |
| `ocr llm test` | select 后的连通性验证 |
| `config.json` 的 `custom_providers.<name>.{url,protocol,model,api_key_cmd}` | provider/model 应用面；key 经 `api_key_cmd` 动态读取，绝不落明文 |

这些都是 CLI 的外层面，但不是任何文档承诺过的稳定 API——本包把版本钉在 `^1.12.13` 正是为了
守住这一组契约；上游变更时以本包的契约闸测试（`test/cli.test.ts`、`test/parse.test.ts`）为
首道防线。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不重复其文本：

| 依赖 | 版本 | 许可 | 引入方 |
| --- | --- | --- | --- |
| `@alibaba-group/open-code-review` | ^1.12.13 | Apache-2.0（Alibaba） | `optionalDependencies`；平台二进制由它自己的 `@alibaba-group/ocr-<os>-<arch>` 选一 |
| `js-yaml` | ^5.4.3 | MIT | `scripts/get-cred.mjs` 读 dsh 托管凭据文档 |

dsh 宿主包（`@deepseek-ai/dsh` 及其子包）是 peer 依赖，由宿主提供、不随本包分发。
