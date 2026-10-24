<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-ocr-review@main/icon.svg" width="96" height="96" alt="dsh-ocr-review logo" />
</p>

<h1 align="center">dsh-ocr-review</h1>

<p align="center"><em>把外部 `ocr`（open-code-review）CLI 封装成 dsh 的七个模型工具与一张设置卡片——CLI 由你自己装，插件只发现、核对并驱动它。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-ocr-review"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-ocr-review?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-ocr-review"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-ocr-review?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-ocr-review/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-ocr-review/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 代码审查桥：七个模型工具（`ocr_review`、`ocr_scan`、delegate preview 与 rule、`ocr_session`、`ocr_rules_check`、`ocr_llm`）加一张设置卡片，把宿主的 provider/model 选择落到外部 CLI 自己的配置里——写进去的是运行期命令，绝不是明文 key。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [外部 CLI](#外部-cli)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [提供给模型的工具](#提供给模型的工具)
- [设置项](#设置项)
- [对外接口](#对外接口)
- [凭据与 OCR 配置文件](#凭据与-ocr-配置文件)
- [后台运行与官方作业](#后台运行与官方作业)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **设置卡还承载两块管理面**：可校验的 MCP servers JSON 编辑器（保存只改 `mcp_servers`），以及报告 `ocr auth` 登录态并切换 OCR provider/model 的 ChatGPT 区。两块都由人操作，不是模型工具（stdio MCP server 会执行命令，OAuth 登录需要浏览器与本地回调）。
- **把外部 `ocr`（open-code-review）CLI 封装成七个模型工具。** 宿主对工具入参零校验，形状、类型与枚举闸全在本包内：用户可控字符串一律单引号转义，枚举一律白名单钳制，错类型直接报错——绝不静默收窄或放宽审查范围。
- **一张设置卡片**（client 半）从宿主自己的 `llm-pi-ai` 设置条目取 provider/model 清单、从宿主凭据服务取 key 状态。两个服务缺席时卡片显示降级原因，工具与设置照常可用。
- **应用一次选择写的是 CLI 自己的 `~/.opencodereview/config.json`**——写进去的是 `api_key_cmd` 命令，OCR 运行期经它读宿主凭据 ref；任何地方都不落明文 key。
- **评审结果是一份结构化摘要，字段分两套口径**：OCR 审出了什么（`status`/`aggregation`/`topComments`/`warnings`），以及这一场有没有真把选中的文件审完（`coverage`/`budgetExceeded`/`toolCalls`）。CLI 以 `--audience agent` 被调用，进度输出被它压掉——后一套口径只能从这些字段里读。
- **CLI 可得性只有一份判据**（`lib/cli.ts` 的 `resolveOcrAvailability`）：纯读文件系统、绝不起进程、每次调用现读。设置卡状态行、插件详情页徽标与启用指引渲染的都是这同一份答案，「用的是哪一份」不许有三套说法。
- **后台运行（`wait: false`）是官方宿主作业**：`job_list` / `job_output` / `job_kill` 看得见、读得到、也停得掉一场超出工具调用生命周期的评审。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-ocr-review
```

卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-ocr-review`。包在公共 npm 上，安装不需要凭据。

- **升级已装的那一份要「先 remove 再 add」。** profile 跑着 HMR（出厂那几个都跑）时，`add` 一个 profile 已经依赖着的包会在 pnpm 动手之前就被拒（`already-installed`）——先 `remove` 再 `add` 目标版本，新版不必重启就起跑。没跑 HMR 时同一个 `add` 照样走 pnpm，报 `restart-required`。
- **要求 Node.js `>= 22.12`，宿主 dsh 在 `0.2.1-rc.3` 线上。** 宿主只读 `engines.dsh`（`^0.2.1-rc.3`）并独立裁决，预发布号参与比较。不合的宿主要显式登记风险豁免：`dsh plugin --profile <p> allow-version @jayyuen66/dsh-ocr-review@<版本> --dsh-version <确切运行版本> --accept-risk`。
- **`dependencies` 里不放任何 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts` 钉着）。消费方 profile 用 `nodeLinker: hoisted` 与 `autoInstallPeers: false` 安装，宿主包进了那张表就会落成真实目录，与宿主进程已加载的那份并存。`@deepseek-ai/dsh-tools` 的调度器键是普通 `Symbol`（不是 `Symbol.for`），符号身份按实例计算——那个 profile 里**每一次原生工具调用都抛**，而本包的构建、类型检查与覆盖率门在此前一路绿。
- **`host.js` 以值导入的五枚宿主包是非 optional 的 peer**：`@deepseek-ai/schemastery`（宿主 fork——`.volatile()` 的解析只在它有实现）、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write` 与 `@deepseek-ai/dsh-typert-protocol`（Remote 的 Service 基类）。五枚同时以同一钉版另列进 `devDependencies`，本仓自己的类型检查才解析得到；构建对 manifest 三张表一律外部化，产物里保持裸说明符。
- **发布面**：`host.js`、`client.js`、`cordis.patch.yml`、`scripts/`、`icon.svg`、`CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md`。`prepack` 重建两个 bundle，发出去的永远是当前源码的产物。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个钉住的值必须不低于本包声明的版本。钉得更低就会装到一份缺少本包运行期所导入的名字的产物，宿主起来时报 `N entries did not activate` 加 `does not provide an export named ...`——包装得上、永远不生效，而各仓单仓 CI 看不见这一类。

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 外部 CLI

本包只 spawn `ocr`，从不安装或升级它。命令契约按 **1.13.3** 核对（`lib/cli.ts` 的 `EXPECTED_OCR_CLI_VERSION`，版本号只在 package.json 的 `ocrCliVersion` 声明一次——测试把 manifest、代码常量与两侧 README 钉成同一个串）。

```sh
brew install open-code-review                        # formula 只跟上游最新版
npm i -g @alibaba-group/open-code-review@1.13.3      # 钉在本包核对的那一版
```

- **brew 钉不住版本。** `homebrew/core` 里只有一份 stable formula、没有版本化变体，`brew install` / `brew upgrade` 拿到的永远是上游最新。带得上核对版本的只有 npm 那条。
- **PATH 优先，拒绝也说人话。** 命令词解析先取 PATH 上第一个 `ocr`，其次本包依赖树里那份兜底（Windows 整体跳过——shebang 脚本 pwsh/cmd 执行不了）；两处都没有时，工具在起进程之前就拒绝，并把带版本的装法交给模型。「怎么装上的」看 bin 软链真正指向的文件：落在 `node_modules` 下是 npm 一类，落在 `Cellar` / `Homebrew` 下是 formula，都不是就报「未识别」而不猜。
- **版本是量出来的，不是猜出来的。** 读版本要 spawn 一次 `ocr version`（15 秒墙钟，恒定带 `OCR_NO_UPDATE=1`）——两处会跑：卡片上的「检测版本」按钮，以及 `startupVerify` 开着时装载期那一次。页面渲染绝不起进程：卡片只显示最近一次测量，没测过就不显示。版本对不上时两个数字并列、徽标改口、摘要 `hint` 加一句说明；从不当成硬失败，本包也不执行任何安装动作。
- **上游会自己升级。** npm 包装层会在调用过程中自行执行 `npm i -g @alibaba-group/open-code-review@<latest>`。版本探测恒定拦住这条路；`ocrNoAutoUpdate` 再把拦截扩到本包起的每一条命令（见「设置项」）。
- **从随包分发过 CLI 的版本升上来**（`optionalDependencies`，0.1.5-rc 及更早）：什么都不必做——现在 PATH 优先，旧的那份不再遮蔽你自装的。想清掉 profile 依赖树里那份，在该 profile 目录下移除该包，并删掉当初写在它 `pnpm-workspace.yaml` 里的 `allowBuilds` 条目。
- **平台。** 目标是 macOS 与 Linux：进程收割与自定义 `ocrConfigPath` 背后的 `HOME=` 注入都是 POSIX 专属。Windows 按裸命令执行、不收割（宿主硬退出可能留下孤儿 OCR 进程），且要求 PATH 上有全局 `ocr`。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已挂载**：`dsh --profile web --dump-config` 末尾有本包的层行（`# == @jayyuen66/dsh-ocr-review`）。
   - 这条命令是唯一被认的「层进了栈」判据，而且它**不是只读的**——会把该 profile 的根装配文件重写一遍。层行从 stdout 读、stderr 另行检查：未匹配的 patch 目标只出现在 stderr，光看退出码什么也证明不了。`# == <层>` 与 `# == <层>, patched by <路径>` 两种形态都要认。
2. **卡片渲染**：设置页出现本包卡片，外部 CLI 那一行写明用的是哪一份、什么装法、本插件按哪一版核对。
3. **检测版本可用**：按下后跑一次 `ocr version`，把实测版本填进那一行——失败时点名是哪一档（找不到命令词、非零退出、超时、读不出版本号）。
4. **没有 CLI 时工具答得诚实**：机器上没有 `ocr` 时，`ocr_review` 在起进程之前就拒绝，并返回带核对版本的装法命令——而不是让模型去反推一个 exit 127。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **它不安装、不升级 CLI。** brew/npm 命令只展示、不执行；没有更新动作，也不接剪贴板 API（非安全上下文会静默失败，看上去像按钮没反应）。
- **没有自己的 HTTP 路由。** 数据面是一枚官方 Typert Remote 命名空间（`ocrReview`），经宿主 `/api` 网关到达；认证、Host / DNS 重绑定 / Origin 判据与请求体上限都是网关的。本包没有 CSRF token、没有 body 上限，也没有路由释放器。
- **没有 CLI 子命令。** 不存在 `dsh ocr …`。
- **不读以下范围之外的文件**：CLI 配置路径、自己创建的临时文件、以及宿主交给它的设置 / 凭据服务。
- 它*确实*消费的：宿主 `settings` 与 `credentials` 服务（provider 清单、key 状态）、`shell`（每一条 `ocr` 子进程）、`jobs`（后台运行）与 `systemPrompt`（一段路由）。settings 或 credentials 缺席只降级卡片——工具照常可用。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其唯一注册行是 `- id: ocr-review`、`name` 为裸包名——宿主只按裸包名扫描 client 半。
- 卡片要 web profile（`dsh.client.platform: web`、`immediately: true`）。五个 `ocrReview` 方法由 apply fiber 无条件注册，宿主的 web 层从不起（如 TUI）时工具与设置照常在。
- 网关只把方法暴露给本 profile 的客户端；本包不在它前面再加一层。
- 部署默认写在注册行的 `config:` 上（cordis 按导出的 `Config` schema 校验）；优先级：设置卡运行时值 > 行 config > 内置默认。

## <img src="https://api.iconify.design/lucide/hammer.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 提供给模型的工具

| 工具 | 入参与约束 |
| --- | --- |
| `ocr_review` | repo（绝对路径，缺省=当前会话工作区）、scope workspace/commit/branch（branch 需同时给 from+to，且与 commit 互斥）、effort、background、exclude、provider/model/resume——resume 仅限 commit/branch，workspace 不支持恢复。preview（只做文件选择）、noFilter、maxGitProcs、rule/backgroundFile（仅 repo 根内文件）、wait |
| 数值参数组（review 与 scan） | concurrency / timeoutMinutes / maxTools / maxTokens / maxTokensBudget，落 `--concurrency` `--timeout` `--max-tools` `--max-tokens` `--max-tokens-budget`。取值忠实透传；下限 concurrency 为 1、其余为 0，非整数或低于下限直接报错，不钳制 |
| `ocr_scan` | repo、path、exclude、batch none/by-language/by-directory、provider/model（CLI 原生共享旗标）、同一组数值参数、preview、noPlan/noDedup/noSummary、resume、maxGitProcs、rule（repo 根内文件）、wait。整仓扫描，无需 git diff |
| `ocr_delegate_preview` / `ocr_delegate_rule` | preview：repo、scope/commit/from/to、exclude、background、backgroundFile/rule/maxGitProcs。rule：repo 加 paths——必填、最多 200 条、经 `--` 分隔作位置参数、逐条转义——外加 rule。OCR 端零 LLM 消耗：只回文件清单与规则分组 |
| `ocr_session` | repo、action list/show/comments/compare/export、id、before/after（compare）、severity/category（comments 过滤）、limit——缺省 10；显式给出必须是 1–100 的整数，越界报错而不是钳制。compare 返回四桶，export 返回 HTML 路径 |
| `ocr_rules_check` | repo、path（必填）、rule（repo 根内文件）：打印命中的规则层、glob 与正文；不调 LLM |
| `ocr_llm` | action providers/models：只读查询 LLM 清单；不评审、不测连通性 |
| 清单上限 | exclude 与 path 各收 2000 条；超限直接拒绝整次调用。条目绝不静默丢弃——「比清单少审了几份」不许以成功的口径上报 |

`wait: false` 起后台运行、不挂宿主 deadline（用 `ocr_session` 轮询；该子进程同时是一枚官方作业，见[后台运行与官方作业](#后台运行与官方作业)）；dsh 以任何方式退出时，收割守护把 OCR 进程树收走。取消工具调用即终止对应的后台进程。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间是条目 id `ocr-review`；卡片上的字段是 `.volatile()` 的那几枚。

| 字段 | 取值、默认与用途 |
| --- | --- |
| `effort` | auto/low/medium/high，内置默认 auto；`auto` 不传 `--effort`，让 OCR 自己的配置生效。`ocr_review` 未显式传 effort 时用它 |
| `language` | 中文/English，默认 中文；应用选择时作为顶层 `language` 键写进 CLI config |
| `autoVerify` | 默认 true；select 成功后自动跑一次 `ocr llm test`（上限由 `llmTestTimeoutMs` 管） |
| `maxComments` | 默认 12，即摘要保留条数；0 = 不截断，非整数或负数回退 12 |
| `timeoutMinutes` | 默认 0 = 请求宿主上限（宿主按 min(请求, shell.maxTimeoutMs) 收口）；大于 0 为分钟数 |
| `ocrConfigPath` | CLI 配置的位置；留空按 `<home>/.opencodereview/config.json` 派生，接受 `~` 与 `~/` 前缀，相对路径直接报错。自定义值必须是 `<X>/.opencodereview/config.json` 布局——CLI 没有配置文件级的路径覆盖，插件靠给子进程注入 `HOME=<X>` 让它生效（config 与 sessions 一并重定向）；布局外的路径在设置层就拒绝。仅 POSIX：Windows 无此通道 |

下面这些**部署键**刻意不进设置卡——它们是导出 `Config` 上的普通（非 volatile）字段，只能写在 profile 注册行的 `config:` 上，改值随重启生效：

| 键 | 默认 | 用途 |
| --- | --- | --- |
| `llmTestTimeoutMs` | `90000` | `ocr llm test` 的墙钟，autoVerify 与卡片「测试连接」共用；评审机慢就调大 |
| `startupVerify` | `true` | 装载期跑一次端点自检（顺带量一次版本）。两条归同一开关，因为判据同是「装载期允不允许起进程」；要求装载零进程的部署关掉它 |
| `ocrBackgroundMaxMs` | `0` | 后台评审的兜底回收窗口（注册表等到 deadline 即 kill）；0 = 不设窗口——只有宿主退出、会话停止、插件卸载或作业被杀才结束 |
| `stdoutMaxBytes` | `400000` | shell 执行器的 stdout 缓冲上限，前台与后台共用（评审结果走 `--output` 临时文件，正是为了绕开它） |
| `ocrNoAutoUpdate` | `false` | 置真时本包起的每条命令都带 `OCR_NO_UPDATE=1`，拦住上游在评审中途把新版 `npm i -g` 装上；置假保持上游行为。版本探测不受本开关影响，恒定带上该变量 |
| `ocrInstallHint` | `both` | 还没装时先推哪条装法：`both` / `brew` / `npm`。只是兜底而非覆盖——机器上已有一份时按那份自己的来源说，因为对着 brew 用户端出 `npm i -g` 会多出第二份、PATH 上还是旧的。npm 那条恒带核对版本，brew 那条恒带不了 |

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

一枚官方 Typert Remote 命名空间 `ocrReview`（`lib/remote-shape.ts` 的 `OCR_REMOTE_NAMESPACE`），九个方法在 `host.ts` 里以程序化方式打标记。服务在构造时注册、随所属 fiber 撤回，热重载留不下没人撤的旧命名空间。

| 方法 | 入参 | 成功回执 |
| --- | --- | --- |
| `providers()` | — | `{providers（每条附 hasKey 布尔）, current, getCredReady, source, endpointVerify, ocrBinary}`，不含任何明文 key。`ocrBinary` 是那份纯文件系统的可得性判定再补上版本上下文（`source`、`channel`、`expectedVersion`、`measuredVersion: string \| null`、`installHint`）；读这个方法不起进程 |
| `select(request)` | `{provider, model}`，两者必须命中 `describe()` 给的清单 | `{ok, applied, llmTest}`（`autoVerify` 关闭时 `llmTest` 为 null） |
| `migrate()` | — | `{ok, migrated, skippedUnknown}` |
| `test()` | — | `{ok, output}`——`ok` 是**测试结论**，不是这次调用成没成；output 先脱敏再截 8000 字符 |
| `probe()` | — | `{ok, version, expectedVersion, consistent, output, reason, changeText}`——15 秒墙钟内跑一次 `ocr version`，恒定带 `OCR_NO_UPDATE=1`。`consistent` 是三态（`null` = 没量到，此时宣称「不一致」就是把没证据的事说成结论）；`reason` 点名失败那一档；`changeText` 只在真有一条该给的命令时非空 |
| `mcp()` | — | `{ok, json}`——只回 `mcp_servers` 对象（pretty JSON），不含 providers/keys |
| `saveMcp(request)` | `{json}`——原始 JSON 文本，上限 64 KiB；stdio/remote 条目逐字段校验 | `{ok, count}`——只写 `mcp_servers`，其他配置原样保留 |
| `auth()` | — | `{ok, output, loginCommand}`——只读 `ocr auth status --provider chatgpt`；登录本身要浏览器与本地回调，仍留在终端执行 |
| `chatGpt(request)` | `{model}` | `{ok, model}`——写 `provider: "chatgpt"` 与 `providers.chatgpt.model`，不写 key |

被拒时答 `{ok: false, error, status}`，其中 `status` 是**保留下来的语义码、不是 HTTP 状态**（选择为空或不在清单上是 400，写失败或凭据脚本缺失是 500）——那个数字的作用是让测试钉住是哪条判据拦的，客户端只渲染 `error`。这些调用刻意不带客户端墙钟：超时归网关管，卡片再设一枚就是「写得慢的那次被判成丢了，而它其实落了」。

## <img src="https://api.iconify.design/lucide/key-round.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 凭据与 OCR 配置文件

| 面 | 事实 |
| --- | --- |
| 写进 config 的是什么 | 命令不是明文：`api_key_cmd` = `node '<本包 scripts/get-cred.mjs 的路径>' '<REF>' '<dsh 数据目录>'`——POSIX 单引号转义，Windows 双引号转义（CLI 在那边经 `cmd.exe` 跑凭据命令）。数据目录是宿主此刻解析出的 home，HOME 被重定向时 get-cred 的兜底层不会跑偏；REF 名必须满足官方 ref 名规则，否则拒绝构造 |
| 取值层序 | get-cred 三层的先后照抄官方 credentials-local：托管凭据文件里的 `refs.<REF>` 优先，其次继承来的进程环境，再次 `$DSH_HOME/.env`。宿主认「托管文件里那一份才是有效的」，排错一位不会报错——OCR 打的是另一个 key，而卡片与 OCR 两边都显示成功 |
| 可达性闸 | select 与 migrate 拒绝「CLI 运行时取不到」的 key：dsh 起 shell 会剥掉名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 或 `DSH_` 前缀的变量，被审查仓库的 `.env` 也刻意不读。只存在于 dsh 进程环境或工作区 `.env` 的 key 在宿主侧解析得到、CLI 运行时却取不到——旧行为是「select 成功、OCR 401」的假绿。拒绝发生在写盘之前，错误文本写明补救方式 |
| 写入方式 | 走官方原子替换：同目录随机后缀临时文件 → rename，新 inode 携带 0600；`.bak` 备份由本包在 rename 之前复制。整段「读→判→写」由官方文件锁串行化——`config.json.lock` 短暂出现、`finally` 里删除。现有 config 是坏 JSON 或顶层非对象时中止写入，绝不「按空配置覆盖」 |
| `migrate()` | 把 custom provider 条目里的明文 `api_key` 换成 `api_key_cmd` 并删除明文；key 所在层在 CLI 运行时不可达（与 select 同一道闸）或 settings 里查不到 `apiKeyEnv` 的条目原样不动、列进 `skippedUnknown`；一条都没迁移成功时不写盘 |
| `scripts/get-cred.mjs` | 由 CLI 自己起进程调用，是本包唯一还在读宿主凭据文件的地方。三层全落空时非零退出，并把查过的位置一并报出 |

## <img src="https://api.iconify.design/lucide/hourglass.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 后台运行与官方作业

| 面 | 事实 |
| --- | --- |
| 模型多看到的 | `job_list` 列得出这场评审、`job_output` 读得到它的 stdout/stderr（非消费式——不会从会话读取器那里抢字节）、`job_kill` 停得掉它。评审结果仍以 `ocr_session` 会话记录为准 |
| 没注册表就没后台 | 宿主没有 jobs 服务时，`wait: false` 直接抛错点名缺件，而不是起一个没人看得见的子进程；前台运行不受影响 |
| 共用桶 | 未拥有的作业槽全宿主共用，满员直接拒绝新 start，一条挂死的 CLI 会永久占一格。`ocrBackgroundMaxMs` 那个可选兜底窗口就是为它设的——用注册表自己的 wait + kill，不用宿主 timer |
| 清理 | 每次登记前把本 kind 的已落定记录剪到固定窗口；在跑与正在收的一条不剪（注册表对超额的答法是拒绝，不是替人杀评审）。卸载时，活着的经注册表 kill，已落定的 remove |
| 暴露面 | 未拥有意味着任何 caller 都能 list / read / kill。这是本次换装已知并接受的暴露面；收回它的唯一方式是回滚作业登记 |
| 取消链里不许抛 | 宿主事件处理器里抛出的错误会把整个宿主进程带下来，官方件也不替生产者兜——取消链在两层各兜一次，每层各有一条用例钉着 |

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 面 | 事实 |
| --- | --- |
| 进程边界 | 被审查仓库的路径与 diff 内容进 `ocr` 子进程，CLI 再把它们发给自己在 config.json 里配置的 LLM 端点——这条外发是审查功能本身，不经 dsh 宿主。明文 key 不进工具返回、也不进 Remote 应答；宿主侧解析到的值只用于确认「现在解析得到」，当场丢弃 |
| 原始输出脱敏 | 本包出去的 CLI 原始 stdout/stderr（失败详情、llm test、解析失败回显、session 透传）统一过 `redactKeyMaterial()`：Bearer 与赋值形态从严抹除，独立 key 形态额外要求随机串特征，免得把要交给模型的文件路径一起抹掉 |
| 写盘范围 | 只有两处：CLI 的 `config.json`（含临时文件、`.bak` 备份与短暂的锁）与系统临时目录下的 `ocr-review-*` / `ocr-scan-*`（读完即删）。迁移前的明文可能留在那次写入产生的 `.bak` 里（权限 0600）——要彻底清掉需自行删除该备份。这两处之外，`ocrNoAutoUpdate` 没置真时唯一的写者就是 CLI 自己那层 npm 包装 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **Windows 没有收割、也没有自定义配置路径。** 两者都立在 POSIX 工具链上（bash trap、进程组语义、`HOME=` 赋值前缀）；Windows 上本包按裸命令执行、不收割，宿主硬退出可能留下孤儿 OCR 进程。
- **版本对不上从不当硬失败。** 新版 CLI 通常照样能用；两个数字并列显示、徽标改口、摘要 `hint` 加一句。本包从不执行安装动作。
- **读版本要起一次进程**，页面渲染绝不触发；卡片只显示最近一次测量或什么都不显示——渲染一页装不了、更不了、也探不了任何东西。
- **原子写的锁超时以英文出现。** 争用超过官方等待上限时抛的是官方件自己的超时文本——这是本包唯一一条绕过双语消息表的用户可见错误。
- **`partial` 是终态里的成功档。** 部分文件失败但覆盖仍成立、评论仍有效；既不被抬成成功，也不被折进失败。
- **未拥有的后台作业对所有会话可见**（见「后台运行与官方作业」）——随本次换装一并接受，收回它的唯一方式是回滚登记。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 现象 / 问题 | 结论 |
| --- | --- |
| 把 exit 0 当成评审成功 | exit 0 不等于成功：`status` 不在 success / complete / partial / completed_with_warnings / completed_with_errors / skipped 白名单内即按失败报。`partial` 指部分文件失败、但覆盖与评论仍有效。解析失败时回显脱敏后原文的前 500 个 UTF-16 码元 |
| 摘要有没有覆盖全部产出？ | 两件不同的事，不能互相替代。`droppedCount` / `invalidCommentCount` 只说明**本摘要**有没有列全评论（调大 `maxComments` 或置 0 再复核）。**这一场**有没有把选中的文件审完看 `coverage`（`selected` 是分母，`failedItems` 给出文件名与原因）、`budgetExceeded` 与 `toolCalls` |
| `add` 被拒，报 `already-installed` | HMR profile 对已装包的 `add` 在 pnpm 动手之前就拒——先 `remove` 再 `add` 目标版本（见「安装」） |
| dsh 退出时后台进程怎么办？ | 收割守护在任何宿主退出方式下（含 kill -9 后被收养）以 TERM→1s→KILL 收走 review/scan 的进程树；取消工具调用即终止对应的后台进程 |
| 明文 key 还可能留在哪？ | 本包写盘的地方没有它。迁移前配置里的明文可能留在迁移后第一次写入产生的 `.bak` 里（权限 0600）；删掉那份备份即彻底清除 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # typecheck（两侧）→ lint → client 构建 → host 构建 → 带 coverage 的测试 → 格式检查
```

- 覆盖率阈值**四项 100%**，分母是 `vitest.config.ts` 里 `coverageInclude` 选定的那一面（`host.ts` + `lib/**`）；两块刻意在分母外：客户端半（`src/**`）经 bundle 与设置卡用例覆盖，`scripts/get-cred.mjs` 由进程级用例另起进程驱动（v8 覆盖率看不到子进程），它的行为门禁在 `test/get-cred.test.ts`。
- 往 profile 加本包的**本地目录**（`pnpm add <路径>`）需要 pnpm ≥ 12.3.0：更早的 pnpm 12 把无别名的本地路径当 registry 包名解析（上游 #14437，12.3.0 修复）。从 registry 装不受影响。
- 产物新鲜度由 `test/build-host.test.ts` 钉着：`host.js` / `client.js` 落后于源码就红。发布物不手改；`prepack` 重建。
- 插件源码是 TypeScript，由宿主的 cordis Loader 直接加载（Node ≥ 22.18 类型剥离）；bundle 只为 npm 发布面存在。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT，源码在 [github.com/JayYuen666/dsh-ocr-review](https://github.com/JayYuen666/dsh-ocr-review)，问题提该仓的 tracker。

运行时依赖各有自己的许可证；[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录这一产物边界与复核方法。
