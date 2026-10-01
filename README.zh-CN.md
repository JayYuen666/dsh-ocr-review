# @jayyuen66/dsh-ocr-review

[English](README.md) · 中文

## 它做什么

- 把外部 `ocr`（open-code-review）CLI 封装成 dsh 的 5 个模型工具 + 1 张 web 设置卡片；宿主对工具入参零校验，形状与类型闸全在本包内做。
- Host 半（`host.ts`）声明 6 个 `.volatile()` 设置项（0.1.7 起命名空间是隐式的：宿主按 profile 条目 id `ocr-review` 投影表单，插件不再 `settings.register`）、注册 5 个模型工具、一段 systemPrompt 路由（`ocr-review-routing`，order 1555）与 4 个 `/_dsh/ocr-review/*` 端点。
- Client 半（`src/client-entry.ts` → `client.js`）是设置卡片，provider/model 取自设置服务的 `llm-pi-ai` 命名空间。
- 卡片把 provider/model 落盘到外部 ocr CLI 自己的 `~/.opencodereview/config.json`，写进去的是 `api_key_cmd` 命令而非明文 key。

## 前置条件（外部 CLI）

- 本包不 import 任何 OCR 库，只起进程：`ocr review` / `ocr scan` / `ocr delegate preview` / `ocr delegate rule` / `ocr session` / `ocr llm test`。
- 命令按 v1.12.x 源码逐一核对（`lib/cli.ts`、`lib/parse.ts` 头注释），形如 `ocr review --audience agent --format json --effort medium --output <临时文件>`。
- 多值 `--exclude`/`--path` 合并成一个逗号分隔 flag，`--format` 只认 json/text/sarif。
- 命令解析优先级：先解析**随包装上**的 `@alibaba-group/open-code-review`（`optionalDependencies`，平台二进制由它自己的 optionalDependencies 选一），取其 `bin/ocr.js` 绝对路径；解析不到才回落到 PATH 上的裸 `ocr`——两种装法都继续支持，装上本插件即工具可用，不必用户自己再 brew/npm i -g 一遍。解析是惰性的且每进程只做一次（与 dsh 核心解析 `@vscode/ripgrep` 同款），解析失败不在装载期抛，否则整包会因一个可选二进制而下线。
- 两条路径都没有时子进程 exit 127，工具报「ocr 命令不存在」并给出 `brew install open-code-review` 或 `npm i -g @alibaba-group/open-code-review`。
- 平台：目标平台是 macOS / Linux。进程收割（`ocr_review` / `ocr_scan` 的 reaper 守护）依赖 POSIX 工具链——bash 的 trap 与作业控制，加上 `ps` / `pgrep` / `kill` 的进程组语义。Windows 上这层整体缺席，本包按 `process.platform` 直接放行裸命令（不收割但能跑）；代价是宿主硬退出后 OCR 可能留下孤儿进程。
- provider 清单与 key 状态走宿主官方通道 `ctx.settings.describe()`（`llm-pi-ai` 那条的 `value.providers`）与 `ctx.credentials`。
- 两者缺席时卡片显示降级原因，工具与设置照常可用。
- 宿主版本要求 `>=0.2.0-rc.2`：写在 `peerDependencies`（0.1.7-rc 起宿主装插件时校验它；alpha.1 还没有这道门）与 `engines.dsh`（同值、无人读）。

## 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-ocr-review
```

- 包在公共 npm 上，安装不需要凭据。
- 发布面只含 `host.js`、`client.js`、`cordis.patch.yml`、`scripts`（`prepack` 重建两个 bundle），源码仓见 package.json 的 `repository.url`。

## 安装时 pnpm 拦下依赖脚本（ERR_PNPM_IGNORED_BUILDS）

本包把 `@alibaba-group/open-code-review` 放在 `optionalDependencies`，上游带一个 `postinstall`（`scripts/install.js`）。pnpm 10+ 默认不执行依赖的构建脚本，于是安装会以这个错误收尾：

```
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: @alibaba-group/open-code-review@1.12.11
```

**这只需要放行一次，且只有装本包时才会遇到**（其余插件无需要构建脚本的依赖）。

推荐做法 —— 在 profile 的 `pnpm-workspace.yaml` 里放行（`<dsh 数据目录>` 下的 `profiles/<profile>/`）：

```yaml
allowBuilds:
  '@alibaba-group/open-code-review': true
```

改完重跑 `pnpm i` 即可。授权按精确包名保存在该 profile，再次安装失败后仍然有效。

也可以走宿主自带的审批流程：失败时 Web 插件页会给出「允许这些脚本并重试」，或在对话里说明同意后让 Agent 通过 `install_bundle` 的 `approvedBuilds` 代为授权。宿主只校验待决定的包名，不核实对话里的批准，所以需要你先明确同意。

**关于这个 postinstall：** 它在正常路径下什么都不做。平台二进制由上游的 `optionalDependencies`（`@alibaba-group/ocr-<os>-<arch>`，各自带 `os` / `cpu` 字段，pnpm 只装匹配当前平台的那个）提供，`install.js` 检测到就打印 `Binary provided by platform package, skipping download.` 后直接返回。实测放行与不放行都能让 `ocr` 正常执行，差别只是要不要在安装期跑那段脚本——它只在平台包装不上时才下载兜底，而在 pnpm 下平台包必然装得上。

如果你更希望完全不执行安装期脚本，可以写 `'@alibaba-group/open-code-review': false`：`ocr` 同样可用（launcher 直接从平台包目录取二进制），但宿主 `readPendingBuilds()` 只认值为 `set this to true or false` 的条目，改成 `false` 后官方审批流程就不再能代为授权，只能手工维护。
- 运行期值依赖 `@jayyuen66/dsh-plugin-shared`、`@deepseek-ai/schemastery`（宿主 fork 的 schemastery，0.1.7 的 `.volatile()` 解析只在它有实现）与 `js-yaml`（后者只被 `scripts/get-cred.mjs` 用）。

## 在 dsh 里启用

- 包内 `cordis.patch.yml` 声明 `- id: ocr-review` / `name: "@jayyuen66/dsh-ocr-review"`，由 `package.json` 的 `dsh.bundle.patch` 指向。
- `dsh plugin --profile web add/remove` 负责登记与摘除，改完重启 dsh。
- 卡片要 web profile（`dsh.client.platform: web`、`immediately: true`）。
- 4 个 `/_dsh/ocr-review/*` 端点挂在 `inject(["webServer"])` 的子 fiber 上：宿主没有 webServer（如 TUI）时子 fiber 不激活、端点不存在，工具与设置照常。真实宿主上 webServer 比本条目晚到位约 1 秒，所以它必须是依赖而不是在 apply 里 `ctx.get` 读一次。
- 部署默认可写在 profile 注册行的 `config:` 上（cordis 按导出的 `Config` schema 校验并填默认），优先级：设置卡运行时值 > 行 config > 内置默认。

## 提供给模型的工具

| 工具                                         | 入参与约束                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocr_review`                                 | repo（绝对路径，缺省=当前会话工作区）、scope workspace/commit/branch（branch 需同时给 from+to，且与 commit 互斥）、effort、background、exclude（最多 50 条）、provider/model/resume（resume 仅 commit/branch，workspace 不支持恢复）、wait                                                                        |
| 数值参数组（`ocr_review` 的入参）            | concurrency/timeoutMinutes/maxTools/maxTokens/maxTokensBudget，落 `--concurrency` `--timeout` `--max-tools` `--max-tokens` `--max-tokens-budget`，非整数或小于下限即报错（注意 `--max-tools` 的 1-49 会被 OCR 抬到 50，其帮助文本写明 min 50）                                                              |
| `ocr_scan`                                   | repo、path（最多 100 条）、exclude（50）、batch none/by-language/by-directory、provider/model（scan_cmd 原生共享 flags，与 review 对齐）、同一组数值参数、wait；无需 git diff                                                                                                                                               |
| `ocr_delegate_preview` / `ocr_delegate_rule` | 前者：repo、scope/commit/from/to、exclude 50、background；后者：repo、paths 必填 1–200 条，经 `--` 分隔的位置参数逐条转义。OCR 端零 LLM 消耗，只回文件清单与规则分组                                                                                             |
| `ocr_session`                                | repo、action list/show/comments（白名单，越界即报错）、id、limit（钳到 1–100，缺省 10）；show/comments 缺 id 时回落 list                                                                                                                                         |
| 后台与回收                                   | `wait: false`（后台启动、不挂宿主 deadline、2 小时后兜底回收、不写 `--output`，结果用 `ocr_session` 轮询）与宿主回收守护只作用于 review/scan 这两条分钟级命令。**那次子进程同时是一枚官方作业**（见下面的「后台作业面」一节），工具回执那份 JSON 在换装那次一字未改（输出契约后来另改为 canonical 对象直返，见下节） |

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
| `ocrBackgroundMaxMs` | `7200000` | 后台评审的兜底回收窗口（`jobs.wait` 等到 deadline 即经注册表 `kill`，即 2 小时）          |
| `stdoutMaxBytes`     | `400000`  | shell 执行器的 stdout 缓冲上限，前台与后台共用同一字段                                    |

## 凭据与配置文件

| 面                     | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config 里的凭据形态    | 写进去的是命令不是明文：`api_key_cmd` = `node '<本包 scripts/get-cred.mjs 的路径>' '<REF>' '<dsh 数据目录>'`（三段都过单引号转义；第三段是宿主此刻 `resolveDshHome()` 的解析值，HOME 重定向或非 env 指定 dsh home 时 get-cred 的兜底层才不会跑偏），REF 名必须匹配 `^[A-Z0-9_]+$`，否则拒绝构造                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 写入方式               | 只走原子替换（交官方 `@deepseek-ai/dsh-atomic-write`）：同目录随机后缀 `.<hex>.tmp` → rename，新文件权限 0600 由新 inode 携带、父目录 0700；备份 `.bak` 由本包在 rename **之前**复制并 chmod 0600；整段「读→判→写」由官方 `withFileLock` 串行化，RMW 期间同目录会短暂出现 `config.json.lock`（正常路径下 `finally` 删除，持锁进程崩溃时按 pid 探活接管）；现有 config 是坏 JSON 或顶层非对象时中止写入，绝不「按空配置覆盖」。**已知不一致**：并发争用超过官方默认 2s 等待上限时，写会以 `atomic-write: timed out waiting for the writer lock at …` 抛出并回 400 JSON，这条文本来自官方件、不走 `lib/messages.ts`（本包其余用户可见错误都在消息表里）；换装前 RMW 同处一个 tick、没有超时这条路，是异步化换来的新失败模式，映射它需要给锁等待时间加注入缝并为 2s 超时写测试，本包选择记录而不是静默扩面 |
| `POST migrate`         | 把 custom provider 条目里的明文 `api_key` 换成 `api_key_cmd` 并删除明文；settings 里查不到 `apiKeyEnv` 的条目原样不动、列进 `skippedUnknown`；一条都没迁移成功时不写盘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scripts/get-cred.mjs` | 由外部 ocr CLI 自己起进程调用，是本包唯一还在读宿主凭据文件的地方。数据目录按「命令行第三参数 > `$DSH_HOME` > `~/.dsh`」定位，取值层序为继承来的进程环境变量 > `<dsh 数据目录>/.credentials.yaml` 的 `refs.<REF>` > `<dsh 数据目录>/.env`。刻意不读被审查仓库的项目 `.env`；三层全落空即非零退出，并把查过的位置一并报出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 对外接口

| 路由                         | 方法 | 入参                                                         | 成功回执                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/_dsh/ocr-review/providers` | GET  | —                                                            | `{providers（每条附 hasKey 布尔）, current, getCredReady, source, csrf}`，不含任何 key 明文                                                                                                                                                                                                                                                                        |
| `/_dsh/ocr-review/select`    | POST | body `{provider, model}`，两者必须命中 `describe()` 给的清单 | `{ok, applied, llmTest}`（`autoVerify` 关闭时 `llmTest` 为 null）                                                                                                                                                                                                                                                                                                  |
| `/_dsh/ocr-review/migrate`   | POST | —                                                            | `{ok, migrated, skippedUnknown}`                                                                                                                                                                                                                                                                                                                                   |
| `/_dsh/ocr-review/test`      | POST | —                                                            | `{ok, output}`（output 先脱敏再截 8000 字符）                                                                                                                                                                                                                                                                                                                      |
| 三个写端点的统一前置         | —    | —                                                            | handler 第一句是 `guardTrust`（Host 权威 → `sec-fetch-site` 白名单 → `origin` 逐字比对，不过则 403 + `{ok:false,error:"untrusted host authority" \| "cross-origin request rejected"}`）；非 POST 405 带 `Allow: POST` 与 `{ok:false,error:"POST only"}`；缺或错 `x-ocr-csrf` 头 403、body 超 8KB 413、流中断 400；token 每次插件 apply 重新生成，旧 token 随即失效 |

这四条路由随插件的注入子 fiber 生灭。官方 `webServer.register` 交回的是**必须自己调用**的释放器，且对重复路径当场抛错（installed dsh-host-webserver/lib/index.js:177-184），而路由表挂在宿主提供的 webServer 实例上、**不**随本插件卸载而死。本包把四枚释放器挂在 `inject(["webServer"])` 子 fiber 的效应上，于是：热重载（旧 fiber dispose ⇒ 新 apply）不会撞名而挂掉整张设置卡，禁用或卸载插件后这四条端点也不再可达。

## 后台作业面（官方 `ctx.jobs`）

`wait: false` 起的那只外部 `ocr` 子进程，从今天起同时登记为宿主 `ctx.jobs` 里的一枚**未拥有**作业（`kind: "ocr-review"` ⇒ id `ocr-review-N`）。改的是"谁能看见并停掉它"，不是"模型拿到什么"：

| 面               | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型的观察面     | 多了三位：官方 `job_list` 列得出这次评审、`job_output` 读得到它的 stdout/stderr（注册表按自己的节奏从 `proc.observed` 拉，非消费式，与 `readOutput()` 游标互不争夺 — 官方 d.ts 明写 "without stealing bytes from `readOutput`"）、`job_kill` 停得掉它。评审结果本身仍以 `ocr_session` 会话记录为准；工具回执的内容自换装起未变，其后随输出契约改造改为 canonical 对象直返（不再把回执 stringify 进 `{ text }` 双重编码）                                                                              |
| 坏掉的执行器读者 | 官方泵对"源抛错"的答法是只往宿主日志写一行、此后这一路读作空（实测）⇒ 本包额外写**一条**"这段不完整"进环，只写一次、也不再去敲坏掉的读者                                                                                                                                                                                                                                                                                                                                                                       |
| controller 寿命  | 只挂在 `start` 那一瞬：官方件在"没有 controller 服务这个 owner"时拒绝 `start`，而 web 面宿主的 `tool-jobs` 在各 preset realm 内（宿主平面那一行被 disabled）⇒ 未拥有作业必须自己挂一枚。挂完立刻摘（实测：摘掉即恢复拒绝、后续 read/kill/落定都不依赖它）——常驻等于在"宿主故意没装 job 工具"的组成里替全宿主开着那道闸门                                                                                                                                                                                       |
| 三条取消路径     | 工具调用被中止、插件卸载、2 小时兜底 deadline 都是 `jobs.kill(id, undefined, reason)` 而不是绕过它杀进程 ⇒ 记录推到 `stopping`、reason 落进 `detail`（实测绕过那一层，名册里这条会永远停在 `running`）。三条可以叠加（实测对 `stopping` 再 kill 仍回 `requested`、`proc.kill()` 幂等）。reason 是模型可见文本 ⇒ 取双语字典                                                                                                                                                                                     |
| 取消链里不许抛   | `abort` 监听器里抛出的错误由 Node 以 `process.nextTick` 重抛 ⇒ 未捕获异常 ⇒ **整个宿主进程退出**（本机实跑复现：`Error: unknown job ...` + `EXIT=1`）。官方件也不替生产者兜：`killJob` 裸调 `job.cancel()`（installed dsh-jobs-local:611-622，只有 teardown 那一臂逐条 try/catch），注册表被重载/关掉时对陌生 id 抛（同文件 `:554-558`）。于是两层各兜一次：`cancel` 经 `killProc` 吞掉"进程早就不在了"那一类，`stop` 兜住注册表那一臂，兜不住时退化成直接杀我们自己的进程（各有一条用例，删掉任一层那条就红） |
| 2 小时兜底       | 本包仍不给外部 CLI 套宿主 `timeoutMs`（长评审会被误砍），但"完全没有终点"在换装后有了新受害者：未拥有的 10 格桶是**全宿主共用**的（实测 `running` 与 `stopping` 都计数、满员直接拒绝新 `start`）⇒ 一条挂死的 CLI 会永久占一格。收法用注册表自己的 `wait(id, ms)` + `kill`，不用宿主 timer 也不裸 `setTimeout`                                                                                                                                                                                                  |
| 未拥有的暴露面   | 官方件按 owner 隔离，未拥有作业任何 caller 都能 `list`/`read`/`kill`。这是本波已知并接受的暴露面（受有作业要 `dsh-agent` 注册表，实测不可得）；回滚这次换装是唯一的收回方式                                                                                                                                                                                                                                                                                                                                    |
| 落定记录窗口     | 注册表不会自行回收已落定的记录，而它随宿主活着、不随本插件卸载而死 ⇒ 本包在每次登记前剪掉 `ocr-review` 这一 kind 最老的已落定记录，剪到 9 条再起新的 ⇒ 在册任何时刻都不超过 10 条（每条最多带一只 256 KiB 的环）。卸载时两件事都做：活着的经注册表 kill，已落定的 remove —— 用户直接禁用本包就没有"下一次 apply"来剪窗口了。在跑与正在收的一条都不被剪 —— 官方件对超额的答法是**拒绝新 start**（实测未拥有桶 10），不是替我们杀评审                                                                            |
| 没注册表没后台   | 宿主没装 `dsh-jobs-local` 时，`wait: false` 直接抛出点名缺件的错误，**不会**先把子进程起在没人看得见的地方。前台（`wait: true`）不受影响                                                                                                                                                                                                                                                                                                                                                                       |

## 数据与隐私

| 面           | 事实                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程边界     | 被审查仓库的路径与 diff 内容进 `ocr` 子进程，OCR 再把它发给自己在 config.json 里配置的 LLM 端点；这条外发是审查功能本身，不经 dsh 宿主。明文 key 不进工具返回、不进 `/_dsh/*`，宿主侧 `resolve()` 拿到的值只用于确认「现在解析得到」，当场丢弃                                                           |
| 原始输出脱敏 | OCR 的原始 stdout/stderr（失败详情、llm test、解析失败回显、session 透传）出宿主前统一过 `redactKeyMaterial()`：Bearer 与赋值形态从严抹除，独立 key 形态额外要求随机串特征，以免把要交给模型的文件路径一起抹掉                                                                                           |
| 写盘范围     | 本包写盘只有两处：外部 ocr CLI 的 `config.json`（含同目录随机后缀 `.tmp`、备份 `.bak`，以及 RMW 期间短暂存在、正常路径下即删的 `config.json.lock`）与系统临时目录下的 `ocr-review-*`/`ocr-scan-*`（读完即删）。迁移前的明文可能仍留在同一次写入产生的 `.bak` 里（权限 0600），要彻底清掉需自行删除该备份 |

## 常见问题

| 现象                   | 结论                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exit 0 就以为评审成功  | exit 0 不等于评审成功：`status` 不在 success/complete/**partial**/completed_with_warnings/completed_with_errors/skipped 白名单内即按失败报（`{"error": …}` 属这类；partial 是 manifest 终态之一，部分文件失败但整体有覆盖，评论仍有效），解析失败时回显脱敏后的原文前 500 码元（UTF-16，一张 emoji 占 2 枚） |
| 摘要是否覆盖了全部产出 | `droppedCount` 与 `invalidCommentCount` 同时为 0 才覆盖 OCR 全部产出，否则调大 `maxComments`（或置 0）再复核；stdout 侧另有 400000 字节上限，所以评审结果统一走 `--output` 临时文件                                          |
| dsh 退出时的后台进程   | dsh 以任何方式退出（含 kill -9 后被 launchd 收养）时，review/scan 的 OCR 进程树由命令内守护 TERM→1s→KILL 收走；取消工具调用即终止对应的后台进程                                                                              |

## 开发

- `npm run check` 是发布前的一条门：typecheck（两侧 tsconfig）+ `oxlint` + 重建两个 bundle + `npm test`（vitest 带 coverage）+ `oxfmt --check`。
- `npm test` 带 `--coverage`，全局阈值 **100%**（lines/statements/branches/functions）——任何一行或分支没被用例钉住，测试套件当场红，这是本仓的既定质量门。
- `npm run build` / `npm run build:client` 产出发布物 `host.js` / `client.js`；改动 `host.ts`、`lib/*` 或 `src/*` 后必须重建（`test/build-host.test.ts` 钉了产物与源码的新鲜度，过期产物会让套件变红）。发布物不手改。
- 插件源码是 TS，由宿主的 cordis Loader 直接加载（Node ≥ 22.18 类型剥离）；bundle 只为 npm 发布面存在。

## 许可证

MIT，见 [LICENSE](LICENSE)。

