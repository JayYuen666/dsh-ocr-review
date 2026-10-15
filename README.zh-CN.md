# @jayyuen66/dsh-ocr-review

[English](README.md) · 中文

## 它做什么

- 把外部 `ocr`（open-code-review）CLI 封装成 dsh 的 5 个模型工具 + 1 张 web 设置卡片；宿主对工具入参零校验，形状与类型闸全在本包内做。
- Host 半（`host.ts`）声明 6 个 `.volatile()` 设置项（命名空间是隐式的：宿主按 profile 条目 id `ocr-review` 投影表单，插件不调 `settings.register`）。
- 同时注册 5 个模型工具、一段 systemPrompt 路由（`ocr-review-routing`，order 1555）与 5 个 `/_dsh/ocr-review/*` 端点。
- Client 半（`src/client-entry.ts` → `client.js`）是设置卡片，provider/model 取自设置服务的 `llm-pi-ai` 命名空间；此外还贡献三处只读显示：插件详情页标题旁的徽标、页面内容之下的区块，以及启用本包那一刻的指引——三处说的都是「这台机器上的外部 CLI 是什么状态」。
- 卡片把 provider/model 落盘到外部 ocr CLI 自己的 `~/.opencodereview/config.json`，写进去的是 `api_key_cmd` 命令而非明文 key。
- 评审结果回给模型的是一份结构化摘要，字段分两套口径：OCR 审出了什么（`status`/`aggregation`/`topComments`/`warnings`），以及这一场有没有真把选中的文件审完（`coverage`/`budgetExceeded`/`toolCalls`）。`--audience agent` 下 CLI 把进度行写进 `io.Discard`，后一套口径只能从这些字段里读。

## 前置条件（外部 CLI）

- 本包不 import 任何 OCR 库，只起进程：`ocr review` / `ocr scan` / `ocr delegate preview` / `ocr delegate rule` / `ocr session` / `ocr llm test`。
- 命令按 **1.13.0** 源码逐一核对（`lib/cli.ts`、`lib/parse.ts` 头注释），形如 `ocr review --audience agent --format json --effort medium --output <临时文件>`。这一版号只写在 package.json 的 `ocrCliVersion` 一处，`lib/cli.ts` 里的 `EXPECTED_OCR_CLI_VERSION` 是它在本包代码里的唯一镜像：`test/publish-manifest.test.ts` 断言两处逐字相等，`test/readme-parity.test.ts` 断言这一句写的也是它。「README 教用户装 A、代码却按 B 核对」这种两边各自自洽的错，只有并排断言才拦得住。
- 多值 `--exclude`/`--path` 合并成一个逗号分隔 flag，`--format` 只认 json/text/sarif。
- **CLI 由你自己装。** 本包刻意不带 `optionalDependencies`：把 `@alibaba-group/open-code-review` 列成依赖，一是让「装一个插件」顺带改了用户的全局工具链，二是那条绝对路径解析得比 PATH 上用户自装那份更靠前——用户在终端升了级，插件仍在跑随包那一份旧版，卡片报的版本与他实际跑的永远对不上，而且没有任何线索指向「机器上有两份」。
- 于是命令词的解析顺序是：PATH 上第一个能命中的 `ocr`（取它的绝对路径），其次才是本包依赖树里那一份兜底，两处都没有候选时才是裸 `ocr`（也就是下面那条拒绝要处理的情形）。设置页状态行、五个工具的前置短路、真正下发的那条命令词都读这同一份判据，「用的是哪一份」不许有三套说法。Windows 上随包兜底整体跳过（`bin/ocr.js` 是 shebang 脚本，pwsh/cmd 无法直执行），命令词也保持裸 `ocr`——带反斜杠的绝对路径在 `cmd` 里不靠单引号成对。
- 装法两条任选，npm 那条带得上核对版本，brew 那条带不上：

  ```sh
  brew install open-code-review                        # formula 只跟上游最新版
  npm i -g @alibaba-group/open-code-review@1.13.0      # 钉在本包核对的那一版
  ```

  `homebrew/core` 里 `open-code-review` 只有一份 stable formula，没有 `open-code-review@x.y` 这种版本化 formula，所以 brew 钉不住版本，装出来就是最新的那一版。它与上面那一版不一致时，工具与卡片都会说（见「外部 CLI 的状态与版本」）。没装时先推哪一条由部署项 `ocrInstallHint` 决定；机器上已经有一份候选时，文案按那一份自己的来源说，部署偏好让位。
- 两条路都没有候选时，工具在起进程之前就拒绝，并把带版本的装法一起交给模型；如果判据拿到候选、子进程那边却执行不了（exit 127），工具报「ocr 命令不存在」并指到卡片上外部 CLI 那一行。
- 平台：目标平台是 macOS / Linux。进程收割（`ocr_review` / `ocr_scan` 的 reaper 守护）依赖 POSIX 工具链——bash 的 trap 与作业控制，加上 `ps` / `pgrep` / `kill` 的进程组语义；自定义 `ocrConfigPath` 背后的 `HOME=` 赋值前缀同样是 POSIX 专属。Windows 上这层整体缺席：本包按 `process.platform` 直接放行裸命令（不收割但能跑），并跳过随包 launcher（Windows 需 PATH 上的全局 `ocr`）；`api_key_cmd` 在 Windows 按双引号转义写出（ocr 在那边经 `cmd.exe` 跑凭据命令）。代价是宿主硬退出后 OCR 可能留下孤儿进程。
- provider 清单与 key 状态走宿主官方通道 `ctx.settings.describe()`（`llm-pi-ai` 那条的 `value.providers`）与 `ctx.credentials`。
- 两者缺席时卡片显示降级原因，工具与设置照常可用。
- 宿主版本要求 `>= 0.2.1-alpha.3`：这条写在 `engines.dsh`，属于文档性声明，装载器与安装器都不读它。真正拦安装的是那四枚 peer 的精确钉：宿主拿运行时版本逐条比对 peer 范围（预发布号参与比对），不合就以 `incompatible-version` 拒装。跑 dsh 0.2.1-alpha.2 的机器要先升 dsh，或在 profile 的 `compatibility.json` 里给本包登记豁免（`dsh plugin --profile <profile> allow-version <name@version> --dsh-version <运行时版本> --accept-risk`）。本包也不从 `@deepseek-ai/dsh` 主包导入任何符号（服务面全部来自 `@deepseek-ai/dsh-*` 子包），所以它在任何一张依赖表里都不出现。

## 外部 CLI 的状态与版本

判据只有一处，`lib/cli.ts` 的 `resolveOcrAvailability`，回答「这台机器有没有 ocr、用的是哪一份、那一份是谁装上的」：先扫 PATH 上第一个命中的可执行体（Windows 按 `PATHEXT` 补后缀），其次才是本包依赖树里那份兜底。「怎么装上的」看的是 bin 里那条软链**真正指向**的文件（`realpathSync`）：落在 `node_modules` 下就是 npm 一类的包管理器，落在 `Cellar` / `Homebrew` 下就是 formula，两者都不是就报「未识别」而不猜。两条判据的顺序是有讲究的：用 brew 装的 node 跑 `npm i -g` 时，那条路径同时含 homebrew 与 node_modules，先判 homebrew 就会把 npm 装法说成 brew。整件事纯读文件系统——`statSync(...).isFile()`，绝不起进程——因此它答的是**找没找到候选**，不是**跑不跑得起来**：文件在但执行不了（丢了执行位，或随包入口在而平台二进制缺失）仍会通过前置检查，那一路由真实 spawn 报出来，所以「命令不存在」那句兜底文案必须留着。

| 显示面 | 拿到这份判据后做什么 |
| ------ | -------------------- |
| 五个工具 | 起任何进程之前先现读一次。两条路都没有候选就直接拒绝，模型看到的是「两条路都没找到 + 这么装（命令里带着核对版本）」，而不是子进程 exit 127 之后反推出来的那句「命令不存在」。每次调用现读、不按进程缓存：装完 CLI 直接重试即可，不必重启 dsh |
| 设置卡片 | provider 表单**之外**的一行状态（「这台机器有没有 ocr」与「宿主能不能列出 provider」是两件事，缺 CLI 的机器必须连原因都看得见）：用的是哪一份、什么装法、本插件按哪一版核对、最近一次实测是哪一版，没装时再附一句装法；外加一枚「检测版本」按钮 |
| 插件详情页 | 标题旁一只徽标 + 页面自身内容之下一个区块；页面说的不是本包、或状态还没回来时两处都渲染 null。实测过且与核对版本不一致时，徽标改口说「版本不一致」，来源那一档让位 |
| 启用之后 | 启用指引只在判据为 `none` 时说话，说的就是带版本的装法——那是第三方 bundle 能渲染的最外侧位置 |

- 插件**列表**卡片上那排标签不归插件管：它们是宿主对条目自身的判定（`running` / `off` / `problem`）。上面两处就是能显示的最外一侧，而它们都属于 client 半——插件被禁用时 client 半一并撤下，没有谁还能在那里提示「CLI 没装」。
- 三处显示面读的都是 `GET providers` 里同一个 `ocrBinary` 字段，且都不在本地自己算可得性、判装法、写装法命令：判据算三份就会分叉，命令写两处就会漂成「卡片教的版本与插件核对的版本不是一版」。
- **版本号不是白来的**：取版本要 spawn `ocr version`。跑它的时机有两处——按下卡片上的「检测版本」，以及 `startupVerify` 开着时装载期那一次（管它的是同一条开关，因为那条设置的判据就是「装载期允不允许起进程」）。页面渲染时绝不起进程：`GET providers` 只交最近一次实测到的那个值，没测过就是 `null`，卡片于是只说「本插件按 1.13.0 核对」，不替你编一个本机版本。
- **版本对不上既显示也说出口**：回执那一行把两个数字并列，徽标改口，`ocr_review` / `ocr_scan` 的摘要 `hint` 尾部多一句「这份结果不是按核对版本跑出来的」，让模型也读到。它从不当成硬失败——新版 CLI 通常照样能用——本包也不替你执行升级：给的那条命令按那份 CLI 自己的来源说（formula 说 `brew upgrade open-code-review`，全局包说 `npm i -g …@<核对版本>`），来源判不出时按部署偏好说，并且始终把「brew 钉不住版本」那句一并说了。
- 回执在版本行之下附上 CLI 自己的输出，并剥掉终端控制序列（上游 launcher 那句「有新版本」的颜色码是硬编码的，而且打在 JS 包装层，`--color never` 管不到它）——要给人复制的那行是 `npm i -g …`，复制时不该拖着转义字节。一次来回走完后卡片会重读载荷，让状态行与刚取到的版本描述的是同一时刻（页面开着的时候装上 CLI，那一行也不会再跟回执自相矛盾）。本包刻意不提供更新动作，也不接剪贴板 API（非安全上下文会静默失败，看上去像按钮没反应）。
- **上游会自己升级**：`ocr` 的 npm 包装层会在调用过程中自行跑 `scripts/update.js`（默认 18 分钟冷却 + pid 锁），而那个脚本执行的是 `npm i -g @alibaba-group/open-code-review@<latest>`。部署项 `ocrNoAutoUpdate` 置真时，本包起的每一条 `ocr` 命令都带 `OCR_NO_UPDATE=1`，于是一场评审不会中途改动你的全局 npm；默认为假，即保持上游行为。版本探测无论这个开关怎么设都会带上该变量——读状态不该有写侧副作用。launcher 那句「有新版本」提示写在 `OCR_NO_UPDATE` 那道闸**之前**，所以它照样会出现在回执文本里。

## 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-ocr-review
```

- **升级已装的那一份要「先 remove 再 add」。** profile 跑着 HMR（出厂那几个 profile 都跑）时，`add` 一个 profile 已经依赖着的包会在 **pnpm 动手之前**就被拒：`application: 'failed'` 带 `error.code: 'already-installed'`，profile 的文件一字不改；网页上那个安装框同理。所以先 `dsh plugin --profile web remove @jayyuen66/dsh-ocr-review`，再 `add` 目标版本——remove 会停掉旧 bundle 的插件并摘掉它的模块映射，新版就此起跑、不必重启。没跑 HMR 时同一个 `add` 照样走 pnpm，报 `restart-required`。
- 包在公共 npm 上，安装不需要凭据。
- 发布面只含 `host.js`、`client.js`、`cordis.patch.yml`、`scripts` 与 `THIRD_PARTY_NOTICES.md`（随包运行时依赖的第三方许可证；`prepack` 重建两个 bundle），源码仓见 package.json 的 `repository.url`。

## 外部 CLI 的安装与升级

本包只 spawn `ocr`，不安装它。两条命令任选：

```sh
brew install open-code-review                        # formula 只跟上游最新版
npm i -g @alibaba-group/open-code-review@1.13.0      # 钉在本包核对的那一版
```

- **brew 钉不住版本。** `homebrew/core` 里 `open-code-review` 只有一份 stable formula，没有 `open-code-review@1.12` 这种版本化 formula，`brew install` / `brew upgrade` 拿到的永远是上游最新。需要与本插件同版本时只能走 npm；卡片上凡是出现 brew 那条命令的地方都会把这句一并说了。
- **本包不执行任何一条。** 版本探测恒定带 `OCR_NO_UPDATE=1`，读状态不许顺带装东西；`ocrNoAutoUpdate` 再把这条覆盖到本包起的每一条命令。
- **换版命令按那份 CLI 自己的来源给**：formula 给 `brew upgrade open-code-review`，全局包给 `npm i -g @alibaba-group/open-code-review@<核对版本>`。来源判不出来（手工 `cp` 到 `~/bin`、`npx`、别的前缀）就按部署项 `ocrInstallHint` 说，不猜。
- **从随包分发过 CLI 的版本升上来**（`optionalDependencies` 那几版，0.1.5-rc 及更早）：什么都不必做——现在 PATH 上的那份优先，那份旧的不再遮蔽它。想把 profile 依赖树里那份清掉，在该 profile 目录（`<dsh 数据目录>` 下的 `profiles/<profile>/`）执行 `pnpm remove @alibaba-group/open-code-review`，或重装这个 profile；当初为它写的 `allowBuilds: {'@alibaba-group/open-code-review': true}` 也可以一并删掉。
- **`ERR_PNPM_IGNORED_BUILDS` 不再来自本包。** 之前会撞上，是因为上游包装层带一个 `postinstall`（`scripts/install.js`），而 pnpm 10+ 默认不执行依赖的构建脚本。本包现在没有需要跑脚本的依赖，这条报错只可能来自别的包——那种情况下宿主的审批流程照旧可用（Web 插件页的「允许这些脚本并重试」，或在对话里明确同意后由 Agent 经 `install_bundle` 的 `approvedBuilds` 代为授权；宿主只校验待决定的包名，不核实对话里的批准，所以仍需你明确同意）。
- `dependencies` 里不放任何 `@deepseek-ai/*`，这不是风格偏好。本包的消费方是 dsh 插件，被装进 profile（`nodeLinker: hoisted`、`autoInstallPeers: false`），只要宿主包出现在 `dependencies`，pnpm 就会把它在那颗 profile 里落成**真实目录**，与宿主进程已经加载的那份并存。而 `@deepseek-ai/dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例计算——宿主 `dsh-agent-loop` 拿自己那份的 Symbol 去读由副本挂载出来的 `ToolRuntime`，得到 `undefined`，于是**每一次原生工具调用都抛** `Cannot read properties of undefined (reading 'prepare')`，整个 profile 的工具一起失效。本包的构建、类型检查与测试在这之前全部照绿，所以判据只能由 `test/publish-manifest.test.ts` 落在 manifest 面。
- 产物里以**值**导入的四枚宿主包是非 optional 的 `peerDependencies`：`@deepseek-ai/schemastery`（宿主 fork 的 schemastery，`.volatile()` 的解析只在它有实现）、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`。运行期由宿主在场提供，而 profile 不装 peer，所以不产生副本；`build-host.mjs` 对 `dependencies`、`peerDependencies` 与 `optionalDependencies` 三张表一律外部化，`host.js` 里的裸说明符因此一字不变。
- 这四枚同时另列一份进 `devDependencies`——那才是本包自己的 typecheck、build、test 解析得到它们的方式。其余 `@deepseek-ai/*` 全是 type-only（构建即擦除，`host.js` 里不留说明符），只留在 `devDependencies`。
- `dependencies` 剩下的确实是本包自己的运行期代码：`@jayyuen66/dsh-plugin-shared` 与 `js-yaml`（后者只被 `scripts/get-cred.mjs` 用）。

## 在 dsh 里启用

- 包内 `cordis.patch.yml` 声明 `- id: ocr-review` / `name: "@jayyuen66/dsh-ocr-review"`，由 `package.json` 的 `dsh.bundle.patch` 指向。
- `dsh plugin --profile web add/remove` 负责登记与摘除，改完重启 dsh。
- 卡片要 web profile（`dsh.client.platform: web`、`immediately: true`）。
- 5 个 `/_dsh/ocr-review/*` 端点挂在 `inject(["webServer"])` 的子 fiber 上：宿主没有 webServer（如 TUI）时子 fiber 不激活、端点不存在，工具与设置照常。真实宿主上 webServer 比本条目晚到位约 1 秒，所以它必须是依赖而不是在 apply 里 `ctx.get` 读一次。
- 部署默认可写在 profile 注册行的 `config:` 上（cordis 按导出的 `Config` schema 校验并填默认），优先级：设置卡运行时值 > 行 config > 内置默认。

## 提供给模型的工具

| 工具                                         | 入参与约束                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocr_review`                                 | repo（绝对路径，缺省=当前会话工作区）、scope workspace/commit/branch（branch 需同时给 from+to，且与 commit 互斥）、effort、background、exclude（最多 50 条）、provider/model/resume（resume 仅 commit/branch，workspace 不支持恢复）、wait                                                                        |
| 数值参数组（`ocr_review` 的入参）            | concurrency/timeoutMinutes/maxTools/maxTokens/maxTokensBudget，落 `--concurrency` `--timeout` `--max-tools` `--max-tokens` `--max-tokens-budget`，非整数或小于下限即报错（注意 `--max-tools` 的 1-49 会被 OCR 抬到 50，其帮助文本写明 min 50）                                                              |
| `ocr_scan`                                   | repo、path（最多 100 条）、exclude（50）、batch none/by-language/by-directory、provider/model（scan_cmd 原生共享 flags，与 review 对齐）、同一组数值参数、wait；无需 git diff                                                                                                                                               |
| `ocr_delegate_preview` / `ocr_delegate_rule` | 前者：repo、scope/commit/from/to、exclude 50、background；后者：repo、paths 必填 1–200 条，经 `--` 分隔的位置参数逐条转义。OCR 端零 LLM 消耗，只回文件清单与规则分组                                                                                             |
| `ocr_session`                                | repo、action list/show/comments（白名单，越界即报错）、id、limit（钳到 1–100，缺省 10）；show/comments 缺 id 时回落 list                                                                                                                                         |
| 后台与回收                                   | `wait: false`（后台启动、不挂宿主 deadline、默认不设时限、不写 `--output`，结果用 `ocr_session` 轮询）与宿主回收守护只作用于 review/scan 这两条分钟级命令。**那次子进程同时是一枚官方作业**（见下面的「后台作业面」一节），工具回执那份 JSON 在换装那次一字未改（输出契约后来另改为 canonical 对象直返，见下节） |

## 设置项

| 字段             | 取值、默认与用途                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `effort`         | low/medium/high，内置默认 medium；`ocr_review` 未显式传 effort 时用它                                                    |
| `language`       | 中文/English，默认 中文；应用选择时作为顶层 `language` 键写进 OCR config                                                 |
| `autoVerify`     | 默认 true；true 时 `/select` 成功后自动跑一次 `ocr llm test --color never`（90 秒上限）                                  |
| `maxComments`    | 默认 12，即摘要保留条数；0 = 不截断，非整数或负数回退 12                                                                 |
| `timeoutMinutes` | 默认 0 = 请求宿主上限（宿主按 min(请求, shell.maxTimeoutMs) 收口），>0 为分钟数                                          |
| `ocrConfigPath`  | 外部 ocr CLI 配置的位置；留空按 `os.homedir()/.opencodereview/config.json` 派生，接受 `~` 与 `~/` 前缀，相对路径直接报错。**自定义值必须是 `<X>/.opencodereview/config.json` 布局**：OCR 端没有配置文件级的路径覆盖（只认 `<HOME>/.opencodereview/config.json`，`config_cmd.go:92-99`），插件通过给 ocr 子进程注入 `HOME=<X>` 让它生效（config 与 sessions 一并重定向，`api_key_cmd` 会带上宿主侧解析出的数据目录作 get-cred 的显式定位档）；布局外的任何路径在设置层直接报错，绝不静默失配（HOME 注入是 POSIX 赋值前缀形态，Windows 无此通道，自定义路径仅在 macOS/Linux 生效） |

另有三枚**部署级**调优值，刻意不进设置卡——它们是导出 `Config` 上的普通（非 volatile）字段，只能写在 profile 注册行的 `config:` 上，改值随重启生效：

| 键                   | 默认      | 用途                                                                                     |
| -------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `llmTestTimeoutMs`   | `90000`   | `ocr llm test` 的墙钟（autoVerify 与卡片「测试连接」共用）；评审机慢就调大                |
| `ocrBackgroundMaxMs` | `0` | 后台评审的兜底回收窗口（`jobs.wait` 等到 deadline 即经注册表 `kill`）；0 = 不设窗口，只有宿主退出、会话停止、插件卸载或显式 `job_kill` 才结束 |
| `stdoutMaxBytes`     | `400000`  | shell 执行器的 stdout 缓冲上限，前台与后台共用同一字段                                    |

第四枚非 volatile 字段是**部署决策**而不是调优值，理由与上面同一类（它改变一场运行对这台机器能做什么，不该放在一张用户可以在审查中途随手翻动的卡片上）：

| 键                | 默认    | 用途                                                                                                                   |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ocrNoAutoUpdate` | `false` | 置真时本包起的每条 `ocr` 命令都带 `OCR_NO_UPDATE=1`，拦住上游 npm 包装层在评审中途执行 `npm i -g @alibaba-group/open-code-review@<latest>`；置假保持上游行为（18 分钟冷却 + pid 锁）。版本探测不受本开关影响，恒定带上该变量 |

第五枚管的是「给用户看哪条装法命令」，同一个理由让它也不上卡片（一个统一用 brew 或统一用 npm 的部署，不该让每台机器各自在页面上发现这件事）：

| 键               | 默认   | 用途                                                                                                                   |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `ocrInstallHint` | `both` | 还没装时，工具拒绝、卡片状态行与启用指引先推哪条命令：`both`（两条都给）/ `brew` / `npm`。它只是兜底而非覆盖——机器上已有一份候选时按那份自己的来源说，因为要给的是「替换他手上那一份」的命令：对着 brew 装的用户端出 `npm i -g`，机器上会多出第二份 ocr，而 PATH 上那条还是旧的。npm 那条恒带核对版本，brew 那条恒带不了 |

## 凭据与配置文件

| 面                     | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config 里的凭据形态    | 写进去的是命令不是明文：POSIX 上 `api_key_cmd` = `node '<本包 scripts/get-cred.mjs 的路径>' '<REF>' '<dsh 数据目录>'`（三段都过单引号转义）；Windows 上按双引号转义（ocr 在那边经 `cmd.exe` 跑凭据命令，单引号是普通字符）。第三段是宿主此刻 `resolveDshHome()` 的解析值，HOME 重定向或非 env 指定 dsh home 时 get-cred 的兜底层才不会跑偏；REF 名必须匹配 `^[A-Z0-9_]+$`，否则拒绝构造                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 取值层序               | get-cred 三层的先后**照抄**官方 credentials-local：`$DSH_HOME/.credentials.yaml` 的 `refs.<REF>` > 继承来的进程环境 > `$DSH_HOME/.env`。排错一位不会报错：宿主认「托管文件里那一份才是有效的」，脚本若先交环境里那份，OCR 就打的是另一个 key，而卡片与 OCR 两边都显示成功。dsh 0.2.1-alpha.3 把环境层从最高降到了托管文件之后，本包的脚本与 `test/get-cred.test.ts` 同步跟上 |
| 可达性闸               | `/select` 与 `/migrate` 会拒绝「OCR 运行时取不到」的 key：dsh 起 shell 会剥掉名字命中 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 或 `DSH_` 前缀的环境变量（`scrubbedParentEnv`），get-cred 也刻意不读被审查仓库的 `.env`——只存在于 dsh 进程环境或工作区 `.env` 的 key 在宿主侧解析得到、OCR 运行时却取不到，旧行为是「select 成功 → OCR 401」的假绿。`file`（`$DSH_HOME/.credentials.yaml`）与 `user-env`（`$DSH_HOME/.env`）两层放行；`env` 仅当 ref 名不被净化模式命中才放行；`project-env` 一律不放行。拒绝发生在写盘之前，错误文本写明补救方式（把 key 存入托管凭据或 `$DSH_HOME/.env`） |
| 写入方式               | 只走原子替换（交官方 `@deepseek-ai/dsh-atomic-write`）：同目录随机后缀 `.<hex>.tmp` → rename，新文件权限 0600 由新 inode 携带、父目录 0700；备份 `.bak` 由本包在 rename **之前**复制并 chmod 0600；整段「读→判→写」由官方 `withFileLock` 串行化，RMW 期间同目录会短暂出现 `config.json.lock`（正常路径下 `finally` 删除，持锁进程崩溃时按 pid 探活接管）；现有 config 是坏 JSON 或顶层非对象时中止写入，绝不「按空配置覆盖」。**已知不一致**：并发争用超过官方默认 2s 等待上限时，写会以 `atomic-write: timed out waiting for the writer lock at …` 抛出并回 400 JSON，这条文本来自官方件、不走 `lib/messages.ts`（本包其余用户可见错误都在消息表里）；换装前 RMW 同处一个 tick、没有超时这条路，是异步化换来的新失败模式，映射它需要给锁等待时间加注入缝并为 2s 超时写测试，本包选择记录而不是静默扩面 |
| `POST migrate`         | 把 custom provider 条目里的明文 `api_key` 换成 `api_key_cmd` 并删除明文；key 所在层在 OCR 运行时不可达（与 `/select` 同一道闸）或 settings 里查不到 `apiKeyEnv` 的条目原样不动、列进 `skippedUnknown`；一条都没迁移成功时不写盘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scripts/get-cred.mjs` | 由外部 ocr CLI 自己起进程调用，是本包唯一还在读宿主凭据文件的地方。数据目录按「命令行第三参数 > `$DSH_HOME` > `~/.dsh`」定位，取值层序就是上面「取值层序」那一行（托管文档 > 继承环境 > `.env`）——注意「继承环境」这一层对凭据 ref 实际常为空：dsh 起 shell 会剥掉名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 或 `DSH_` 前缀的变量。刻意不读被审查仓库的项目 `.env`；三层全落空即非零退出，并把查过的位置一并报出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 对外接口

| 路由                         | 方法 | 入参                                                         | 成功回执                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/_dsh/ocr-review/providers` | GET  | —                                                            | `{providers（每条附 hasKey 布尔）, current, getCredReady, source, csrf, endpointVerify, ocrBinary}`，不含任何明文 key。`ocrBinary` 是那份纯文件系统的可得性判定再补上版本核对所需的两样：`{source: "path" \| "bundled" \| "none", path?, channel?: "brew" \| "npm" \| "unknown", expectedVersion, measuredVersion: string \| null, installHint}`——`measuredVersion` 是最近一次 `ocr version` 落下的值（装载期自检或按下「检测」），还没测过就是 `null`，读这条路由**不起进程**；`installHint` 是那句装法原文，语言随偏好、命令随来源，都在 host 侧一次组好，卡片不再另写一份（命令写两处就会漂成「卡片教的版本 ≠ 插件核对的版本」）。`endpointVerify` 是 apply 期那次 `ocr llm test` 的结论，没跑过则为 null |
| `/_dsh/ocr-review/select`    | POST | body `{provider, model}`，两者必须命中 `describe()` 给的清单 | `{ok, applied, llmTest}`（`autoVerify` 关闭时 `llmTest` 为 null）                                                                                                                                                                                                                                                                                                  |
| `/_dsh/ocr-review/migrate`   | POST | —                                                            | `{ok, migrated, skippedUnknown}`                                                                                                                                                                                                                                                                                                                                   |
| `/_dsh/ocr-review/test`      | POST | —                                                            | `{ok, output}`（output 先脱敏再截 8000 字符）                                                                                                                                                                                                                                                                                                                      |
| `/_dsh/ocr-review/probe`     | POST | —                                                            | `{ok, version, expectedVersion, consistent, output, reason, changeText}`——起一次 `ocr version`（15 秒墙钟，恒定带 `OCR_NO_UPDATE=1`），从它的输出里读版本串，并把读到的值写进本次 apply 的闭包，下一次 `GET providers` 与下一条 `ocr_review`/`ocr_scan` 回执说的就是同一份测量。命令没跑成功或读不出版本时 `version` 为 null；`consistent` 是**三态**（`true` / `false` / `null`，null 表示压根没读出版本，此时宣称「不一致」就是把没证据的事说成结论）；`reason` 点名失败那一档（找不到命令词、被墙钟收走、非零退出、跑通了但没有版本号——未发布构建就是最后一档）；`changeText` 只在真有一条该给的命令时非空——实测到别的版本，或文件系统那边根本没有候选；候选仍在、只是那条命令超时，它是空串；`output` 与 `/test` 同样先脱敏再截断，并剥掉终端控制序列后原样保留，好让上游那句升级提示还能被干净地复制 |
| 四个写端点的统一前置         | —    | —                                                            | handler 第一句是 `guardTrust`（Host 权威 → `sec-fetch-site` 白名单 → `origin` 逐字比对，不过则 403 + `{ok:false,error:"untrusted host authority" \| "cross-origin request rejected"}`）；非 POST 405 带 `Allow: POST` 与 `{ok:false,error:"POST only"}`；缺或错 `x-ocr-csrf` 头 403、body 超 8KB 413、流中断 400；token 每次插件 apply 重新生成，旧 token 随即失效 |

这五条路由随插件的注入子 fiber 生灭。官方 `webServer.register` 交回的是**必须自己调用**的释放器，且对重复路径当场抛错（installed dsh-host-webserver/lib/index.js:177-184），而路由表挂在宿主提供的 webServer 实例上、**不**随本插件卸载而死。本包把五枚释放器挂在 `inject(["webServer"])` 子 fiber 的效应上，于是：热重载（旧 fiber dispose ⇒ 新 apply）不会撞名而挂掉整张设置卡，禁用或卸载插件后这五条端点也不再可达。

## 后台作业面（官方 `ctx.jobs`）

`wait: false` 起的那只外部 `ocr` 子进程同时登记为宿主 `ctx.jobs` 里的一枚**未拥有**作业（`kind: "ocr-review"` ⇒ id `ocr-review-<16 位 hex>`，由注册表按 randomUUID 截短发号，不是递增序号；未拥有 ⇒ 官方那份 `job/registered` / `job/settled` 会话生命周期记录也不写，它只给有 owner 的作业记）。改的是"谁能看见并停掉它"，不是"模型拿到什么"：

| 面               | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型的观察面     | 多了三位：官方 `job_list` 列得出这次评审、`job_output` 读得到它的 stdout/stderr（注册表按自己的节奏从 `proc.observed` 拉，非消费式，与 `readOutput()` 游标互不争夺 — 官方 d.ts 明写 "without stealing bytes from `readOutput`"）、`job_kill` 停得掉它。评审结果本身仍以 `ocr_session` 会话记录为准；工具回执的内容自换装起未变，其后随输出契约改造改为 canonical 对象直返（不再把回执 stringify 进 `{ text }` 双重编码）                                                                              |
| 坏掉的执行器读者 | 官方泵对"源抛错"的答法是只往宿主日志写一行、此后这一路读作空（实测）⇒ 本包额外写**一条**"这段不完整"进环，只写一次、也不再去敲坏掉的读者                                                                                                                                                                                                                                                                                                                                                                       |
| controller 寿命  | 只挂在 `start` 那一瞬：官方件在"没有 controller 服务这个 owner"时拒绝 `start`，而 web 面宿主的 `tool-jobs` 在各 preset realm 内（宿主平面那一行被 disabled）⇒ 未拥有作业必须自己挂一枚。挂完立刻摘（实测：摘掉即恢复拒绝、后续 read/kill/落定都不依赖它）——常驻等于在"宿主故意没装 job 工具"的组成里替全宿主开着那道闸门                                                                                                                                                                                       |
| 三条回收路径     | 可选的兜底窗口、插件卸载、会话 dispose 都是 `jobs.kill(id, undefined, reason)` 而不是绕过它杀进程 ⇒ 记录推到 `stopping`、reason 落进 `detail`（实测绕过那一层，名册里这条会永远停在 `running`）。三条可以叠加（实测对 `stopping` 再 kill 仍回 `requested`、`proc.kill()` 幂等）。reason 是模型可见文本 ⇒ 取双语字典                                                                                                                                                                                     |
| 取消链里不许抛   | 宿主事件处理器里抛出的错误由 Node 以 `process.nextTick` 重抛 ⇒ 未捕获异常 ⇒ **整个宿主进程退出**（本机实跑复现：`Error: unknown job ...` + `EXIT=1`）。官方件也不替生产者兜：`killJob` 裸调 `job.cancel()`（dsh-jobs-local 的 `killJob`，只有 teardown 那一臂逐条 try/catch），注册表被重载/关掉时对陌生 id 抛（同文件 `expect` 那一处 throw）。于是两层各兜一次：`cancel` 经 `killProc` 吞掉"进程早就不在了"那一类，`stop` 兜住注册表那一臂，兜不住时退化成直接杀我们自己的进程（各有一条用例，删掉任一层那条就红） |
| 可选兜底窗口       | 本包仍不给外部 CLI 套宿主 `timeoutMs`（长评审会被误砍），但"完全没有终点"在换装后有了新受害者：未拥有的 10 格桶是**全宿主共用**的（实测 `running` 与 `stopping` 都计数、满员直接拒绝新 `start`）⇒ 一条挂死的 CLI 会永久占一格。收法用注册表自己的 `wait(id, ms)` + `kill`，不用宿主 timer 也不裸 `setTimeout`                                                                                                                                                                                                  |
| 未拥有的暴露面   | 官方件按 owner 隔离，未拥有作业任何 caller 都能 `list`/`read`/`kill`。这是本波已知并接受的暴露面（受有作业要 `dsh-agent` 注册表，实测不可得）；回滚这次换装是唯一的收回方式                                                                                                                                                                                                                                                                                                                                    |
| 落定记录窗口     | 注册表不会自行回收已落定的记录，而它随宿主活着、不随本插件卸载而死 ⇒ 本包在每次登记前剪掉 `ocr-review` 这一 kind 最老的已落定记录，剪到 9 条再起新的 ⇒ 在册任何时刻都不超过 10 条（每条最多带一只 256 KiB 的环）。卸载时两件事都做：活着的经注册表 kill，已落定的 remove —— 用户直接禁用本包就没有"下一次 apply"来剪窗口了。在跑与正在收的一条都不被剪 —— 官方件对超额的答法是**拒绝新 start**（实测未拥有桶 10），不是替我们杀评审                                                                            |
| 没注册表没后台   | 宿主没装 `dsh-jobs-local` 时，`wait: false` 直接抛出点名缺件的错误，**不会**先把子进程起在没人看得见的地方。前台（`wait: true`）不受影响                                                                                                                                                                                                                                                                                                                                                                       |

## 数据与隐私

| 面           | 事实                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程边界     | 被审查仓库的路径与 diff 内容进 `ocr` 子进程，OCR 再把它发给自己在 config.json 里配置的 LLM 端点；这条外发是审查功能本身，不经 dsh 宿主。明文 key 不进工具返回、不进 `/_dsh/*`，宿主侧 `resolve()` 拿到的值只用于确认「现在解析得到」，当场丢弃                                                           |
| 原始输出脱敏 | OCR 的原始 stdout/stderr（失败详情、llm test、解析失败回显、session 透传）出宿主前统一过 `redactKeyMaterial()`：Bearer 与赋值形态从严抹除，独立 key 形态额外要求随机串特征，以免把要交给模型的文件路径一起抹掉                                                                                           |
| 写盘范围     | 本包写盘只有两处：外部 ocr CLI 的 `config.json`（含同目录随机后缀 `.tmp`、备份 `.bak`，以及 RMW 期间短暂存在、正常路径下即删的 `config.json.lock`）与系统临时目录下的 `ocr-review-*`/`ocr-scan-*`（读完即删）。迁移前的明文可能仍留在同一次写入产生的 `.bak` 里（权限 0600），要彻底清掉需自行删除该备份。这两处之外仍可能被改动的是 **CLI 自己那层 npm 包装**：`ocrNoAutoUpdate` 没置真时，一次 `ocr` 调用会触发上游把新版全局 `npm i -g` 装上。本包自己从不执行安装动作，版本探测那条恒定拦住这条路 |

## 常见问题

| 现象                   | 结论                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exit 0 就以为评审成功  | exit 0 不等于评审成功：`status` 不在 success/complete/**partial**/completed_with_warnings/completed_with_errors/skipped 白名单内即按失败报（`{"error": …}` 属这类；partial 是 manifest 终态之一，部分文件失败但整体有覆盖，评论仍有效），解析失败时回显脱敏后的原文前 500 码元（UTF-16，一张 emoji 占 2 枚） |
| 摘要是否覆盖了全部产出 | 两件不同的事，不能互相替代：`droppedCount` 与 `invalidCommentCount` 只说明**本摘要**有没有列全 OCR 产出的评论（否则调大 `maxComments` 或置 0 再复核）。**这一场**有没有把选中的文件审完看 `coverage`（`selected` 是分母，`completed`/`reused`/`failed`/`waived` 是它的互斥划分，`failedItems` 给出文件名与分类、原因）和 `budgetExceeded`（token 预算提前收工，`status` 里仍只写 `partial`），模型工具调用的失败数看 `toolCalls`。stdout 侧另有 400000 字节上限，所以评审结果统一走 `--output` 临时文件                                          |
| dsh 退出时的后台进程   | dsh 以任何方式退出（含 kill -9 后被 launchd 收养）时，review/scan 的 OCR 进程树由命令内守护 TERM→1s→KILL 收走；取消工具调用即终止对应的后台进程                                                                              |

## 开发

- `npm run check` 是发布前的一条门：typecheck（两侧 tsconfig）+ `oxlint` + 重建两个 bundle + `npm test`（vitest 带 coverage）+ `oxfmt --check`。
- `npm test` 带 `--coverage`，全局阈值 **100%**（lines/statements/branches/functions）——任何一行或分支没被用例钉住，测试套件当场红，这是本仓的既定质量门。
- `npm run build` / `npm run build:client` 产出发布物 `host.js` / `client.js`；改动 `host.ts`、`lib/*` 或 `src/*` 后必须重建（`test/build-host.test.ts` 钉了产物与源码的新鲜度，过期产物会让套件变红）。发布物不手改。
- 插件源码是 TS，由宿主的 cordis Loader 直接加载（Node ≥ 22.18 类型剥离）；bundle 只为 npm 发布面存在。

## 许可证

MIT，见 [LICENSE](LICENSE)。

