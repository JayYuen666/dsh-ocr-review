# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)，最新版本在最上。条目自 0.1.0 起；更早的
1.0.0 / 0.6.x 是作用域迁移前的历史编号，npm 已永久记录，不在本文件重建。

## 0.1.8

这一版把外部 OCR 契约从 1.13.0 抬到 **1.13.3**，并把模型工具面从「审查/扫描/委托/会话」扩到
文件预览、会话比较、规则与 LLM 诊断；设置卡同时补上 MCP servers 与 ChatGPT 两块人工管理面。
所有新增参数仍遵守原有纪律：错类型、越界与互斥组合在起进程之前拒绝，不静默改范围。

### Added

- **review/scan 的 `preview`**：只列文件选择与排除原因，不调用 LLM、不创建会话；与 `resume`、
  `wait=false` 互斥。预览回执与 review/scan 摘要分开解析，坏形状要如实报解析失败。
- **scan 降本与续扫**：`noPlan` / `noDedup` / `noSummary` 跳过对应的 LLM 阶段，`resume` 从
  中断的 scan 会话继续。
- **review/scan 的 `maxGitProcs`**：透传 `--max-git-procs`，控制 git 子进程并发。
- **review 的 `noFilter`**：透传 `--no-filter`，保留全部评论并跳过 LLM 后过滤。
- **`rule` 与 `backgroundFile`**：只接受 repo 根内的普通文件；写侧经 `realpath` 防止符号链接
  逃逸，并限制规则 256 KiB、背景 1 MiB。`--rule` 同时接入 delegate preview/rule 与 rules check。
- **`ocr_session` 的 `compare` / `export` 与 comments 过滤**：compare 返回
  new/persisting/resolved/not_reviewed 四桶与计数；export 写出自包含 HTML 并返回路径；
  comments 支持按 severity/category 过滤。
- **`ocr_rules_check` 与 `ocr_llm`**：前者打印单文件命中的规则层、glob 与正文，后者只读查询
  providers/models；两者都不评审、不建会话。
- **摘要字段**：`limitReached`、`llm`、`projectSummary`（4000 字符上限）、`resume`、
  cache tokens、`groupCount`、`retry`、`traceId`；`review_limit_reached` 与
  `token_budget_reached` 不再只藏在 warnings 文本里。
- **MCP 管理面**：设置卡新增 `mcp_servers` 编辑器，Remote 新增 `mcp()` / `saveMcp({json})`。
  写侧只改 `mcp_servers`，整体 64 KiB、最多 100 个 server；stdio/remote 按各自字段校验，
  未知字段、非法 URL、坏 `KEY=VALUE` 与超长数组都拒绝。
- **ChatGPT 管理面**：Remote 新增 `auth()`（只读 `ocr auth status --provider chatgpt`）与
  `chatGpt({model})`（写 provider/model、清理同条目 key、不写明文）。卡片显示登录命令与模型
  输入；OAuth 登录本身仍留在终端，因为需要浏览器与本地回调。
- **`effort` 新增 `auto`**：auto 时不传 `--effort`，让 OCR 自己的配置生效；卡片默认改为 auto。

### Changed

- **外部 OCR 契约从 1.13.0 抬到 1.13.3**：`ocrCliVersion`、代码常量、双语 README 与
  `THIRD_PARTY_NOTICES` 同步；1.13.3 的 scan path、provider 点号、grace round 与
  `review_limit_reached` 行为纳入夹具。
- **宿主开发线从 rc.2 抬到 rc.3**：`engines.dsh`、peer/dev 依赖与 README 徽标/正文一致。
- **工具数 5 → 7，Remote 方法 5 → 9**：README、routing、parity/publish 门禁与包描述同步；
  输出 schema 抽到 `lib/tool-schemas.ts`，`host.ts` 只保留注册与执行。
- **写配置统一走严格读**：`readExistingText` 把 ENOENT 与 EACCES/EIO 分开，读不动时中止写入，
  不再用空文档覆盖既有 providers/keys/mcp_servers。
- **provider 名校验对齐 OCR 1.13.3**：点号分段不能为空/全空白；`__proto__` 等危险键继续丢弃。
- **列表超限从静默截断改为整条拒绝**：`exclude`/`path` 上限 2000，delegate rule 的 paths 上限
  200；超出时命令不构造，一条都不审。

### Fixed

- **`status:"failed"` 被认出来但仍判失败**：非零退出时 manifest 里的失败明细仍可读取，而 exit 0
  的 failed 不会被摘要成「0 条评论」。
- **小数不再被截断成整数**：`start_line: 3.7` 与 `tool_calls.total: 2.5` 按无效值处理，避免行号
  与统计被静默改写。
- **显式 scope 与范围参数冲突时报错**：`scope=workspace` 加 commit/from-to、未知 scope 配
  from/to 都不再被静默降级成另一种审查。
- **repo 类型与路径归一**：非字符串 repo 报错而不是回退到当前工作区；重复分隔符、`.`/`..` 与
  尾随斜杠归一成同一形态。
- **session id 作为位置参数时加 `--`**：以 `-` 开头的 id 不再被 cobra 当成 flag。
- **glob 花括号内的逗号显式拒绝**：字符串与数组两种列表形式都不再把 `{ts,tsx}` 撕成无效模式。
- **脱敏补齐环境变量与 GitHub token**：`DEEPSEEK_API_KEY=` 这类下划线形态与 `ghp_` /
  `github_pat_` 都会被抹掉，同时保留 kebab 路径可读性。
- **output schema 守卫校验取值形态**：`type` 数组、单分支 `oneOf`、`enum` 字符串等写法在
  插件侧当场报错，而不是拿错误判据继续校验模型数据。
- **大数组违规不再爆调用栈**：守卫改为逐条 push，几十万条违规也能给出可读结论。
- **Windows 矩阵首跑暴露的平台假设**：工具根路径现在接受盘符/UNC 绝对路径（POSIX 形
  仍按 `/` 归一）；POSIX 分支的 PATH 候选改用相对 cwd 的目录，避免 Windows 盘符里的
  `:` 被当成 PATH 分隔符；`stat.mode` 与 `~\` 前缀用例按真实平台判；`get-cred` 路径
  断言先归一分隔符；输出临时文件正则接受 `\\`。win32 轨道仍由既有的 win32 桩用例覆盖。

### Verification

- `npm run check`：typecheck、lint、build、全部用例、四项覆盖率 100%、`oxfmt --check` 全绿。
- 伞根 `pnpm --config.verify-deps-before-run=false run check dsh-ocr-review`：噪点 0 条、
  零输出腿 0 条、没跑到的腿 0 条，两仓全绿。
- 本机 `ocr` 升级到 1.13.3；伞根 `verify:env` 报实测与期望一致。
- 没有在真实 dsh 宿主里点开设置卡（需要 profile 与登录态）；卡片由纯渲染测试覆盖标签、
  禁用态、回调与双语文案。

## 0.1.7

### Fixed

- **被排除文件清单读错键名**：`toExcludedFiles` 改读 CLI 侧的 `exclude_reason`
  （`delegate_cmd.go` 的 `json:"exclude_reason,omitempty"`）。旧代码读 `reason`——真回执里
  那个键不存在，`str()` 把缺失读成空串，于是「被排除文件及原因」永远只有文件没有原因，
  而 schema 与工具描述都在承诺后者。`reason` 留作旧形态回退。
- **REVIEW_STATUSES 补 `failed`**：真回执里有这个状态，漏了它会让整份回执判为不可解析。
- CLI 参数校验、argv 转义与消息表同步收口。

## 0.1.6

### Changed

- **数据面迁移收尾**：五条 `/_dsh/ocr-review/*` HTTP 端点改为官方 Typert Remote 的
  `ocrReview` 命名空间（providers/select/migrate/test/probe）；README 的「Public endpoints」
  改为「Public methods」，readme-parity 门从端点路径改为方法名 + 命名空间。

### Fixed

- **脱敏正则的二次方回溯**：`STANDALONE_KEY` 前瞻对每个候选起点回溯整段 run，长小写串上是
  O(n²)——默认 400 KB 上限实测 51.7 秒同步阻塞宿主事件循环。把随机串特征移进替换回调后
  1.3 ms；120,024 条输入与旧实现逐条一致，两个轴各做过变异实测。
- 注释里的上游行号引用漂移（含一处指向另一个文件）改为按符号命名；迁移残留的 HTTP 文案与
  随包 `cordis.patch.yml` 的过期描述清理。

## 0.1.5

### Changed

- **外部 ocr CLI 改由用户自装**：判据先扫 PATH、其次才是随包兜底，装法由用户自选；版本声明
  一处（package.json 的 `ocrCliVersion`），代码镜像与两侧 README 由门禁对齐。按安装来源
  （brew / npm）给对应的那条安装命令；来源判不出来时退回部署项 `ocrInstallHint` 的偏好。
- **实测版本与声明不符时不只说给人听**：probe 端点回 `expectedVersion`/`consistent`，工具回执
  的 hint 也带上那句不一致说明。
- **依赖同步 dsh 0.2.1-alpha.3**（含 cordis / schemastery 的 alpha.2 fork）。peer 的精确钉
  就是安装闸：宿主按运行时版本逐条比对。
- **get-cred 的取值层序改回与官方同源**：alpha.3 把「继承环境」从最高降到托管文件之后，
  排错一位不会报错，只会让 OCR 打的 key 与卡片认的那一份分叉。
- **跟上上游形状变化**：`ConfigFormSnapshot` 去掉 `mode`；作业 id 是 `<kind>-<16 hex>` 而非
  序号，用例握住当场登记的 id 断言，不再拼字面量。
- **publishConfig 不再写 dist-tag**：留着 `tag: "next"` 会让稳定发布落到 next；去掉后稳定版
  走 npm 默认的 latest，预发布版缺旗标即拒绝发布。

## 0.1.5-rc

### Added

- **外部 ocr CLI 的可得性与版本状态**：判据只有一处（`resolveOcrAvailability` 用纯文件系统
  事实回答「装没装、从哪条路来」，绝不起进程）；五个工具起任何进程之前现读它并短路，四处
  显示面共用同一条 `ocrBinary`。版本号只在按下「检测版本」时经 probe 端点跑一次
  `ocr version`（15 秒墙钟、恒定带 `OCR_NO_UPDATE=1`），回执把上游原文附在版本行之下供
  选中复制。部署级开关 `ocrNoAutoUpdate` 拦住上游 npm 包装层在评审中途执行的 `npm i -g`。

### Fixed

- 两轮 review + 真机验证的缺陷：`parseOcrVersion` 只认带 `v` 的自述（brew 装的那份没有
  `v`，检测按钮对 PATH 装法永久失败）、探测超时被写成「执行失败（exit=null）」、四条动作
  共用一个布尔在飞旗标导致「应用」按钮读成「应用中…」、检测完成后状态行不重读载荷、
  回执里的 ANSI 颜色码。另归位数处文档注释错位与端点/载荷计数漂移。

## 0.1.4

0.1.4-rc / 0.1.4-rc.1 转正。

### Fixed

- **select/migrate 按 `credentials.resolve` 的 source 层判定 OCR 运行时可达性**：
  env/project-env 层的 key 写盘前拒绝，消灭「select 成功 → OCR 401」的假绿；get-cred 与
  双语 README 的「继承环境层」说法一并纠正。
- **webserver host 判定改为非回环 IP 字面量**：宿主 config 拒绝通配地址，旧的
  `=== "0.0.0.0"` 是永假死分支，LAN IP 绑定此前被信任闸整批 403。
- **后台兜底回收理由按 `ocrBackgroundMaxMs` 实际窗口换算**，不再写死 2 小时；
  delegate/session 回显补上 spill 落盘路径。
- **Windows**：`ocrCommand` 恒走 PATH 裸 `ocr`（shebang launcher 不可直执行）；
  `api_key_cmd` 双引号转义（ocr 经 cmd.exe 跑凭据命令）；`parseApiKeyCmd` 双形态反解。

### Changed

- 依赖升级 `@deepseek-ai/*` alpha.2、`@alibaba-group/open-code-review` ^1.12.13、
  `@jayyuen66/dsh-plugin-shared` ^0.1.4；工具链 catalog 同步（rolldown 1.2.13 /
  vitest 5.0.3 / oxlint 1.87 / oxfmt 0.72 等）。

### Added

- `THIRD_PARTY_NOTICES.md`：随包分发的第三方内容边界（图标改绘归属 / ocr CLI 接口面 /
  运行期依赖许可表 / dsh peer 不随包分发）。
- `test/readme-parity.test.ts`：双语 README 结构闸（互链/章节/工具/部署键/声明）。
- `publish.yml`：action 钉 commit SHA，发布步 `--provenance` 与 `--publish-wait-timeout`
  （OIDC 优先、静态 token 回落）。

## 0.1.4-rc.1

OCR 全文件审查发现的确认缺陷。

### Fixed

- **脱敏只认 bearer 一种认证方案**：Basic / Token / Digest / proxy-authorization 以及
  `token: Basic <base64>` 全部原样进入模型输出与 session log——改为认 authorization 头名
  （覆盖任意 scheme，避开正文里 token based 这类措辞被误抹），并给赋值形态加可选 scheme 词
  与 `{4,}` 下限。另修：`additionalProperties:false` 被原型链绕过（constructor/toString 取到
  `Object.prototype` 上的成员）、`oneOf` 命中后跳过同级 const/enum、违规清单无上限且未脱敏
  就进 session log。
- **迁移删明文前从不确认新命令解析得到值**：凭据服务缺席时一条本来能用的明文 key 被换成
  解析不出值的命令；缺 get-cred 脚本时端点给 200 ok:true，把「没做」报成「没有」，明文其实
  还在盘上。两处改为抛错与「解析不到就不删」，并给 apply 侧补形状闸（空串 model 会写进
  config.json）。
- **`pushIntFlag` 用 `Number()` 收任意类型**：`true` / `[]` 被静默强转，`{timeoutMinutes:
  false}` 变成 `--timeout 0`，而 OCR 侧 0 的语义是「不限时」——错类型悄悄改掉的是有没有
  超时上限。只接受 number 与纯十进制串。
- **非负整数闸只挡 `isFinite`**（`1e300` 原样传播）、`num()` 走 `Number()` 会把 `0x10`
  读成 16——改用 `isSafeInteger` 且只认十进制串。delegate 两个解析器：源数组非空却一条都
  解析不出来时仍报 ok:true + 空清单（「0 个文件可审」比解析失败更难察觉），改为判失败。
- **`get-cred.mjs`**：CRLF 的 `.env` 让整层查找对所有 key 静默失配；YAML 引号内空白值跳过
  本来可用的 `.env` 回退；引号未配对时无条件砍首尾字符，凭据被改短一位后拿错 key。错误兜底
  不再走带 `mark.snippet`（邻近行的明文 key）的 message，改为 reason + 行列自拼。

## 0.1.4-rc

OCR 自审缺陷修复。

### Fixed

- **P0 凭据泄漏（`scripts/get-cred.mjs`）**：js-yaml 的 YAMLException 有两条路会把
  `mark.snippet`（出错点邻域的原文，含明文 key）附在文本后面；实测只有 `toString(true)`
  干净，定位信息（line:column）完整保留。
- **P1 收割器 pgrep 盲区（`lib/cli.ts`）**：此前只探测 ps，而 pgrep 只出现在后代快照里——
  它不可用时 reap 只杀得掉中间 bash 壳，真 ocr 命令与其孙进程全部存活。补 `pgrep -P 1`
  探测，并改成任一不可用即整条不挂守护：挂一个残缺版本比不挂更危险。
- **P0 `api_key_cmd` 指针自愈**：该命令烤的是写那一刻的插件安装绝对路径，插件重装/换
  profile 即悬空，五个工具一起挂且错误与真因毫无关系。执行前校验并重建指向已不存在目录的
  路径，路径一律取自 `PLUGIN_DIR`；当前脚本自己缺失、旧脚本还活着、命令串读不懂这三种
  不越界。
- **契约闸假阴性**：preview/rule 的清单此前只查「键在不在」，类型不对时一律放过并产出
  ok:true + 空清单；warnings 条目被 `filter(Boolean)` 静默丢弃。argv 闸收紧（NUL 拒绝、
  数组项含逗号拒绝、limit NaN 回落保守默认）；severity 与协议映射表的原型污染改走 Map。
- **`build-client.mjs` 包名缺失改为 fail loud**：退化成 `unknown` 会让产物 id 与宿主模块表
  键对不上——设置卡静默不渲染，而新鲜度门禁用同一段退化逻辑做比对，门禁照样绿。

### Changed

- 依赖迁移至 dsh 0.2.1-alpha.1。

## 0.1.3

### Fixed

- **会话根归一化**：OCR 内部把 review 的 RepoDir 锚定在 git 顶层，插件此前原样透传模型给的
  子目录，于是 review 写进顶层、`ocr_session` 查子目录——两个不同的 `sessions/<encoded>`
  目录，「写得出会话却永远列不出来」。回退链 git 顶层 → realpath → 原值，任一环失败都不让
  评审挂掉。刻意不接 `ocr_scan`：scan 靠 workdir 限定子目录，一并提升会把扫描范围扩到整个
  monorepo。
- **超时文案报实际生效值**：改报 `spec.timeoutMs` 而非请求值——后者留空时是 2^31-1，照它算
  会把「实际生效 N 分钟」印成 35791 这种天文数字。
- **后台回执带上官方作业 id**：此前回执无任何句柄，polling 把模型导向可能还没落盘的
  session list。jobId 按 id 寻址、启动即可读且一定有结果。

## 0.1.2

### Fixed

对照 ocr 1.12.10 与 dsh 0.2.0-rc.2 源码逐条核对后的修复：

- **status 白名单收 `partial`**：manifest 终态以 exit 0 输出，此前整场部分成功的评审被误报
  「status 非法」并丢弃全部评论；输出 schema enum 与摘要 hint 同步。
- **provider 协议映射改三值**：llm-pi-ai 的 anthropic-messages 映射为 OCR 的 anthropic
  （此前一律写成 openai，按 OpenAI 线协议打 Anthropic 端点必失败）；api 缺省按上游
  openai-completions 兜底；表外值透传给写侧白名单拒绝，绝不静默降级。
- **`ocr llm test` 与五个工具同一命令词解析源**：随包 launcher 装法下 PATH 无裸 ocr，
  autoVerify/测试连接不再恒 exit 127。
- **`ocrConfigPath` 真正生效**：自定义值须呈 `<X>/.opencodereview/config.json` 布局（OCR
  无文件级路径覆盖），插件给 ocr 子进程注入 `HOME=<X>`（POSIX 赋值前缀，win32 放行）；
  `api_key_cmd` 增加宿主 `resolveDshHome()` 第三段；布局外路径在设置层直接报错。
- **入参闸严格化**：resume+workspace 前置拒绝（OCR 契约 workspace 禁恢复）；effort/wait
  错类型抛错；session limit 越界抛错而非静默钳制（0 不再钳成 1）；action=list+id 抛错而非
  静默改写 show。

### Changed

- README 拆分为英文主文档与 `README.zh-CN.md`（顶部互链、14 节对照），补部署级调优值
  （llmTestTimeoutMs / ocrBackgroundMaxMs / stdoutMaxBytes）、「开发」与「许可证」两节；
  中文版不进 npm 发布面。

## 0.1.1

### Added

- **安装节说明依赖脚本放行**：上游 postinstall 的 `ERR_PNPM_IGNORED_BUILDS` 报错原文与
  放行写法、宿主自带的审批流程（Web 插件页的「允许并重试」/ install_bundle 的
  approvedBuilds），以及这个 postinstall 实际不做事的实测依据——平台二进制由上游平台包
  提供，install.js 检测到就跳过下载直接返回。同时写明 false 与 true 的取舍：false 同样可用
  且不执行安装期脚本，但宿主 `readPendingBuilds()` 只认值为 `true or false` 的条目，改成
  false 后官方审批流程不再能代为授权。

## 0.1.0

首个发布版本。1.0.0 与更早的 0.6.x 已被 npm 永久记录（删除也不回收），本组统一以 0.1.0 为
首个发布版本号。

### Changed

- **发布凭据改走 `NODE_AUTH_TOKEN`**：setup-node 配了 registry-url 后会设
  `NPM_CONFIG_USERCONFIG` 指向它自己生成的那份 .npmrc，npm 只读那一份，写 `$HOME/.npmrc`
  等于没写。token 形态校验保留（空值、GitHub token 前缀、混入非 token 字符），改成只读
  不写盘。
