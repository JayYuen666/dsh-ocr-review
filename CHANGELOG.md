# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)，最新版本在最上。这里的偏离是刻意的：版本标题不写
发布日期（各版发布时间以 npm registry 为准，`npm view <包名> time` 取得到），并按需增设标准六类
之外的小节（如 `Docs`、`Verification`）。条目自 0.1.0 起；更早的
1.0.0 / 0.6.x 是作用域迁移前的历史编号，npm 已永久记录，不在本文件重建。

## 0.1.17

设置卡的下拉候选与说明浮层不再漂到浏览器最左边；shared 抬到 `^0.2.8`（含运行时几何自检），CI 的 action 钉版升到最新。对外工具与 Remote 方法名单不变。

### Fixed

- **下拉候选与说明浮层被钉在视口左边缘**：`.dsu-menu` 与 `.dsu-tip` 的 `position-area: block-end span-inline-start` 选中的是「行内起始列 + 中间列」，而 `position: fixed` 下该区域的起始边是**视口左边缘**、不是触发器左边缘，再叠一条 `justify-self: start`，浮层就落在 `x=0`。改为 `block-end span-inline-end`——真实 Chromium（patchright headless，156.0.8078.4）实测：1440px 视口、触发器左边缘 860px，改前浮层左边缘 0，改后 860；触发器贴到右侧时 `flip-inline` 会改成右边缘对齐，贴到视口底部时 `flip-block` 翻到上方。
- **锚定没兑现时改回 JS 矩形定位**：`select.ts` 与 `field.ts` 的 `place()` 此前只要 `CSS.supports("position-area: block-end")` 为真就直接 `return`，方向性错误没有任何兜底。现在锚定后先量一次浮层矩形，用 shared 0.2.8 的 `anchorPlacementOff` 判它是否真贴在触发器上（行内起始边或结束边任一在 2px 容差内贴住，且块向落在触发器下方或上方），不通过才把 `position-area` 显式置 `none` 再写 `left` / `top`。顺序是承重的：实测同时留着 `position-area` 只写坐标时块向仍由锚定决定（浮层 `y` 落在 314 而不是 160），必须先关。回退是单向的——同一个浮层一旦走过 JS 路径，后续 `resize` 不再尝试锚定，避免两个定位源来回抢。
- **回归测试**：`test/card-ui.test.ts` 新增 `anchorPlacementOff` 的四种对齐形态（左边缘对齐、`flip-inline` 右对齐、`flip-block` 翻上方、两轴都不沾）与容差边界，以及三条锚定用例（浮层真贴住时不写 JS 坐标、被钉到视口左侧时改写坐标并关掉 `position-area`、回退过的浮层不再重试锚定）。

### Changed

- **运行时依赖 shared 抬到 `^0.2.8`**：`pnpm-workspace.yaml` 的 catalog 由根 `sync` 投影，`pnpm-lock.yaml` 随 `sync:lock` 重解；`client.js` 按新 shared 重建，内联的 `CARD_UI_CSS` 逐字节等于已装 shared 导出的那一份。0.2.8 新增的 `anchorPlacementOff` / `ANCHOR_PLACEMENT_TOLERANCE` 只被卡片内部使用，本包对外工具与 Remote 方法名单不变。
- **CI 的 action 钉版升到最新**：`github/codeql-action` 的 `init` / `analyze` / `upload-sarif` 由 `v4.39.2` 升到 `v4.39.3`（`33d7b85da1a04171e211befe2c739303b9a4c066`）。钉版仍是 40 位 commit SHA + 版本注释，由根 `scripts/upgrade-actions.mjs` 现量比对上游 tag 后改写，`--check` 可复跑。

## 0.1.16

外部 `ocr` 契约抬到 `1.13.7`；宿主开发基线抬到 `0.2.2-rc.2`，支持窗口收到 `^0.2.2-rc.1`。对外工具与 Remote 方法名单不变。

### Changed

- **OCR 契约抬到 `1.13.7`**：`package.json` 的 `ocrCliVersion`、`lib/cli.ts` 的 `EXPECTED_OCR_CLI_VERSION`、两份 README、随包文档与 `THIRD_PARTY_NOTICES` 统一到 `1.13.7`（readme-parity 门禁对齐）。1.13.7 的命令形态与回执 envelope 与 1.13.6 兼容（真二进制 e2e 取证）；`--no-plan` 文案补出 1.13.7 起不足 200 行的文件已自动跳过 PLAN_TASK 预检。上游移除 `--tools` 的破坏性变更在 1.13.7 之后的未发布 master，本包不用该旗标，不受影响。
- **宿主开发基线抬到 `0.2.2-rc.2`**：`devDependencies` 整组 `@deepseek-ai/dsh-*` 抬到 `0.2.2-rc.2`，并补上 rc.2 新增的 `@deepseek-ai/dsh-error`（`dsh-llm` 的精确 peer，`autoInstallPeers: false` 下须显式声明）。
- **支持窗口收到 `^0.2.2-rc.1`**：`engines.dsh` 与 `@deepseek-ai/dsh*` peer 由 `^0.2.1-rc.5 || ^0.2.2-alpha.3` 改为 `^0.2.2-rc.1`（单条 0.2.2 线）；`@deepseek-ai/schemastery` peer 由 `^3.18.5 || ^3.18.6-alpha.1` 收到 `^3.19.0`。devDependencies 仍精确钉版。

### Fixed

- **Windows + `ocrSandbox=inherit` 不再静默跑不通**：dsh 0.2.2-rc.2 起，Windows 的
  `additionalWritableRoots` 只作用于宿主的文件工具、不再下发给受限子进程（rc.1 是直接抛
  `SANDBOX_UNSUPPORTED_POLICY`）。`inherit` + `workspace-write` 在 Windows 上现在与
  `read-only` 同样在起进程前拒绝，并点名 OCR 写不了的状态目录、让部署改用 `full`；
  `platform` 由 `hostSandboxPolicy` 从 `process.platform` 注入判定层，中英文案、两份 README
  与两份详情文档同步。测试：`test/sandbox-policy.test.ts` 两条平台判决（win32 拒绝、
  win32 + `full` 照常放开）+ `test/host.test.ts` 一条接线用例（拒绝且不起进程；POSIX 的
  两条放行用例把宿主平台钉成 POSIX，Windows CI 上仍验接线而不是平台判据）。

## 0.1.15

跟随 open-code-review 上游 `1.13.6`（npm latest）：版本核对契约抬到 1.13.6，`--max-tools`
的帮助文案按 1.13.5 起的精确语义纠正，`ocr_review` 的工具描述补出 workspace 模式不再套
`.gitignore` 这条行为；上游其余变化随 CLI 生效，本包只透传并在此记清。对外工具与 Remote
方法名单不变。

### Added

- **部署级开关 `ocrSandbox`**（默认 `full`）：`full` 保持 0.1.14 起的行为——每个 ocr
  子进程都按 `danger-full-access` 请求；`inherit` 改为跟随宿主执行器自报的
  `ShellService.sandboxMode`，`workspace-write` 时只放行工作区根，另把 OCR 状态目录
  （`$HOME/.opencodereview`，随 `ocrConfigPath` 重定向）与系统临时区作为
  `additionalWritableRoots` 交下去，`read-only` 与认不出的模式直接拒绝并报出它写不了的那个
  路径。判定与放行根的 mkdir+realpath 收在 `lib/sandbox-policy.ts`；三条新报错文案（中英）
  进 `lib/messages.ts`；`README.md`/`README.zh-CN.md` 的部署键表与两份详情文档的清单各加
  `ocrSandbox` 一行。测试：`test/sandbox-policy.test.ts`（9 条判定表）+ `test/host.test.ts`
  四条接线用例（前台/后台带放行根、`read-only` 拒绝且不起进程、认不出的值回落 `full`）。
  默认取 `full` 是刻意的：收窄会改变既有部署的权限面，想要围栏的部署显式写那一行。

### Changed

- **OCR 契约抬到 `1.13.6`**：`package.json` 的 `ocrCliVersion`、`lib/cli.ts` 的
  `EXPECTED_OCR_CLI_VERSION` 与代码里那处注释样例、`test/remote.test.ts` 的 stub 回执与断言、
  两份 README、`docs/DETAIL.md` 与 `docs/DETAIL.zh.md` 的期望版本和钉版本的装法行、
  `THIRD_PARTY_NOTICES.md` 的验证版本行，统一到 1.13.6；`lib/config-store.ts` 的内置 provider
  名注释随同一版更新。此前停在 1.13.5，而 `ocr version` 自述不带 `v` 前缀，用户装完 1.13.6
  会在每次评审时收到「实测与核对版本不一致」的提示（只是提示，不中断评审）。
- **`maxTools` 文案按精确语义纠正**（`lib/messages.ts`、`host.ts`）：1.13.5 起 review 的
  `--max-tools` 正值是**精确设置**——`1-49` 仍由 OCR 抬到 50，`≥50` 直接生效（review 模板默认
  100，所以 `50-99` 会把上限从 100 压到该值，超过 100 才往上抬）；scan 侧不变，只在大于模板
  默认（60）时生效、`1-49` 也不抬。旧文案「1-49 会被抬到 50，帮助文本 min 50」会让 `50-99`
  看起来无效，而它从 1.13.5 起就是能生效的（上游 #1118）。
- **`ocr_review` 描述补出 workspace 的忽略规则**（`lib/messages.ts`）：1.13.5 起 workspace
  模式不再套 `.gitignore`（上游 #1837），被 ignore 的**跟踪**文件同样计入审查范围；描述里
  写明这句，模型不会再按旧印象认为它们被排除。

- **`timeoutMinutes` 的正值改由本包自管**（`lib/run-scope.ts` + `host.ts` 的 `runForeground`）：
  宿主 `bash-local` 把 `shell.maxTimeoutMs` 默认钉在 60 万毫秒，且 `ShellService` 不暴露这个
  上限，所以插件原先「0 = 请求宿主上限」的写法让所有请求都在 10 分钟被截短。现在：0/未设置
  仍是「请求宿主上限」（语义不变，确实由宿主收敛）；**大于 0 的分钟数由本包自己计时**
  （请求宿主时 `onExpiry: "none"`，到点由插件 abort 并按配置的分钟数报错）。超时文案也分开：
  原 `execTimedOut` 说明「= min(请求, 宿主上限)」，新增 `execTimedOutExplicit` 只说
  timeoutMinutes 与「宿主的 maxTimeoutMs 不参与」，不让用户去调错那一格。
- **`startupVerify` 只做本地版本测量**：装载期不再真跑 `ocr llm test`——那是一次真实的
  provider 请求，付费 provider 每次宿主装载都会计费一次调用。端点检查改由卡片既有的
  「测试连接」与「应用」时的 `autoVerify` 触发；`GET providers` 载荷里也不再带
  `endpointVerify` 那一格（卡片没有可显示的装载期结论）。探针本身仍经 `lib/probe-guard.ts`
  的 `containedProbe` 兜住异常，并随插件卸载一起 abort。

### Docs

- `README.md` 的验收清单里一处包名笔误（`@jayyuen666/dsh-ocr-review`，三个 6）改回
  `@jayyuen66/dsh-ocr-review`，与 `package.json` 的 `name` 一致。

### Fixed

- **`ocrBackgroundMaxMs` 兜底窗口对有主作业真的生效了**（`host.ts` 的
  `enforceOcrDeadline`）：走查宿主 `dsh-jobs-local` 的 `assertAccess` 发现，作业一旦带
  owner，`wait`/`kill` 就必须带同一个 caller，否则抛 `job … belongs to another session`；
  原实现两处都不传 caller，异常又被就地接住，于是这个部署级开关在有主作业上**配了也不触发**
  （工具调用永远带会话 id，真实后台评审几乎全是有主作业）。现在把作业 owner 当 caller 传下去，
  并新增一条用例钉住这条路径；README 里「到点经注册表 kill」的描述这才与实现一致。

- **卸载/热重载会取消在跑的前台评审**（`lib/run-scope.ts`）：此前前台只接调用方的
  `exec.signal`，插件卸载时 `ctx.effect` 只回收后台作业，一条跑到一半的 `ocr review` 会继续
  占着进程直到宿主上限。现在插件在 `apply` 里绑定一个生命周期 `AbortController`，前台请求的
  signal 是 `AbortSignal.any([调用方取消, 插件卸载])`；`shell.maxTimeoutMs` 之外的那条自管截止
  也接在同一张取消域里。用例：卸载后断言 rejects `execAborted` 且执行器收到的 signal 已 aborted。
- **跨进程写 `config.json` 不再静默丢更新**（`lib/config-store.ts`）：上游 `ocr config` 是
  非原子截断写、没有 flock，插件的 `withFileLock` 只串行化自己。现在 `writeConfigAtomic`
  写完立即回读，不一致即抛 `ConfigWriteConflict`；`updateConfigLocked` 对这类冲突把
  「锁内重读→改→写」整段重试三次，仍不一致才报 `configWriteConflict`（点名路径、明说这次
  改动没有落盘）。回读可注入（`ConfigWriteIo`）以便测试这一档；非冲突错误立刻上抛不重试。
- **显式超时到点的报错不再归因于宿主**：见 Changed 第一条——那条 `= min(请求, 宿主上限)`
  的文案在自管路径上会误导用户去调 `shell.maxTimeoutMs`，现由独立的 `execTimedOutExplicit` 说清楚。

### Upstream

以下随上游 `1.13.5`/`1.13.6` 生效，本包未改码、只透传——用户看到的评审范围与回执会变：

- 新增文件类型覆盖：`.jsonc`、`.ejs`/`.liquid`/`.njk`、`.haml`/`.slim`、`.erb`、`.scala`
  （1.13.5）；`.cs`（1.13.6）；`.bzl`/`.bazel`/`.star` 与无扩展名的 `BUILD`/`WORKSPACE`（1.13.6）。
- diff 解析两处修复：裸 `diff --git` 头在分隔符处切开；hunk 在 new-side 去空行后再匹配一轮。
- LLM 客户端对 `extra_body.stream` 的显式 `false` 改为一律放行（给默认为 SSE 的网关可回
  JSON），`true` 与非布尔值丢弃。
- manifest 的 `execution` 段新增 `max_tool_request_times`；本包只读 `coverage`/`status`，
  解析不受影响。

### Verification

- `pnpm run check`：typecheck、lint、双构建、**709 用例**、四项 100% 覆盖率与 oxfmt 全绿。
- Windows 门禁根因修复：`fs/promises` 的 `realpath` 走 libuv 原生实现，会把 runner 临时区的
  8.3 短名（`RUNNER~1`）折成长名（`runneradmin`）；`realpathSync` 的 JS 实现不解短名，
  两条放行根断言的期望值改用 `realpathSync.native` 与实现同口径（macOS 的
  `/var → /private/var` 折叠两口径一致，本机全量复核通过）。

## 0.1.14

一轮审计收口：provider 写入按 OCR 的内置名分桶、key 状态改按「静态 `api_key` 优先」判定，
`ocr_scan` 会话可见性、preview 无效参数、导出目录 TTL、delegate preview 回执与 MCP
URL/header 校验一并修正。对外工具与 Remote 方法名单不变；`saveMcp` 成功回执新增
`warnings`（旧客户端忽略即可）。

### Fixed

- **provider 按名字分桶**（`lib/config-store.ts`、`lib/ocr-config.ts`）：OCR 的 resolver
  先查内置名表 `providers.<name>`，未命中才读 `custom_providers.<name>`。此前一律写
  `custom_providers`，dsh 的 provider 名只要命中内置名（`deepseek`、`openai`…），OCR
  解析端点就直接报 "provider … is not configured in providers section"（`ocr llm test`
  真机复现）。现在按 1.13.5 的 30 个内置名（trim + 小写比较）选桶；读当前配置、明文迁移
  与悬空 `api_key_cmd` 重指向都覆盖两个桶，旧版本写错桶的配置仍能显示与自愈。
- **key 状态按文档优先级**（`lib/config-store.ts`）：静态 `api_key` 优先于 `api_key_cmd`，
  旧卡片只看后者，已配静态 key 的条目会被误报成「动态 key」。`keyIsDynamic` 现在要求
  「有命令且无明文」；迁移写命令时同时删除明文，避免命令永远不生效。
- **`ocr_scan` 会话可见性**（`host.ts`、`lib/scan-scope.ts`、`lib/cli.ts`）：scan 也会
  经 `session.New` 落会话，而 `ocr_session` 总按 git 顶层查询；此前保留 CWD，子目录发起的
  scan 会话永远列不出来。现在 workdir 规范到 git 顶层，`path`/`exclude` 从原始目录重基，
  `rule` 仍按原始 repo 解析（`fileRoot`），扫描范围不变；重基后的相对 `path` 统一用 `/`
  （Windows 也一致，与 `exclude` 模式同一表示）。
- **preview 忽略参数回执**（`lib/preview-params.ts`、`host.ts`）：preview 不运行 LLM，
  显式传入的 `provider`/`model`/`effort` 等参数现在回在 `ignoredParams` 里并附提示，
  不再静默丢弃。
- **delegate preview 回执与旗标**（`lib/cli.ts`、`host.ts`）：回执补
  `totalFiles`/`excludedCount`（清单保持完整）；命令构建不再拼 `--provider`/`--model`
  ——OCR 的 delegate flag 组只注册了 `--background`，传了会变成 cobra unknown flag。
- **MCP URL 跨解析器歧义**（`lib/mcp-config.ts`）：`http:///nohost`、反斜杠、空白/控制
  字符此前能过 WHATWG `new URL()`，Go 侧 `url.Parse` 却给出空 Host。现在先要求显式
  authority、拒绝反斜杠与空白，再交 `URL.canParse` 复核。
- **MCP header 环境变量**（`lib/mcp-config.ts`、`lib/remote-shape.ts`、`src/client-entry.ts`）：
  remote header 里 `$VAR` 在 OCR 运行时展开为空会直接连接失败。保存成功时回非阻断
  `warnings`，设置卡在「已保存」后逐条显示，不再把保存成功当成连接一定成功。
- **导出目录 TTL**（`lib/tmp-cleanup.ts`、`host.ts`）：`ocr-session-export-*` 保留 7 天，
  每次导出前按 mtime 清掉过期目录；只删本包前缀、只删真实目录，清理失败不挡导出。
- **状态契约补 `failed`**（`lib/parse.ts`、`lib/tool-schemas.ts`）：摘要枚举补齐 OCR
  manifest 的完整状态集；解析层对 `failed` 仍判 `ok=false`，不进摘要。

### Verification

- `npm run check`：typecheck、lint、双构建、**681 用例**、四项 100% 覆盖率与 oxfmt 全绿。
- 真机核对：隔离 profile 启动 dsh 并成功调用 `ocr_llm`；`ocr llm test` 复现内置 provider
  分桶报错后验证修复；scan 子目录会话不可见由真实 OCR + mock LLM 复现后验证修复。

## 0.1.13

修复 0.1.12 引入的 web 启动失败：设置卡组件收回 `client.js` 内联，移除对 `@jayyuen66/dsh-plugin-shared/client` 的模块表外置与 `cordis.patch.yml` 里的 shared 供应行。对外工具与 Remote 方法名单不变；0.1.12 里遇到「应用无法启动或已意外停止」的用户升级本版即可，不需要再把 shared 装成 profile 的直接依赖。

### Fixed

- **设置卡组件内联进 `client.js`，产物自足**：0.1.12 把 `@jayyuen66/dsh-plugin-shared/client` 外置给宿主模块表，靠 `cordis.patch.yml` 插入的一条**不写 id** 的 shared 组件行把 shared 装载成供应方。这份供应链在 shared 只作为传递依赖装进 profile 时（`dsh plugin add @jayyuen66/dsh-ocr-review` 的正常结果）没有保证——宿主侧可以既不报错也不把 shared 的 client 产物排进启动图，页面启动时 `require("@jayyuen66/dsh-plugin-shared/client")` 落进 `missed the module table`，整窗报「应用无法启动或已意外停止」（GitHub issue #2，宿主 0.2.2-rc.1 dsh desktop；把 shared 装成 profile 直接依赖可绕过，回归 0.1.11 也可绕过）。`build-client.mjs` 的外置清单收回 react / zod 两族（宿主 `PLATFORM_MODULES` 供给，内联反而会产生第二份身份），卡片组件、`claimApply`/`diffTouched`/`isRecord` 等工具全部内联；`package.json` 的 `dsh.bundle.client.external` 与 patch 里的 shared 供应行随之移除，`cordis.patch.yml` 回到只声明本包一行。`client.js` 体积由 73.5 KB 增至 96.4 KB，仍在 `test/dist-size.test.ts` 的 116 KB 预算内；`test/build-client.test.ts` 新增两条产物自足判据（零 shared/client 请求、单层 ModuleLoader 外壳），工厂替身对未知请求的抛出把外置回流挡在装配层。

## 0.1.12

外部 `ocr`契约抬到 `1.13.5`，宿主开发基线抬到 `0.2.2-rc.1`、支持窗口由 `^0.2.1-rc.3 || ^0.2.2-alpha.2` 滚到 `^0.2.1-rc.5 || ^0.2.2-alpha.3`，`engines.node` 下限抬到 `>=24.9.0`；卡片组件改由 shared 的 `./client` 供。对外工具与 Remote 方法名单不变，需要留意的是 `engines.node` 抬高后 node 22 装不上本包。

### Changed

- **shared 抬到 0.2.4**：catalog、生成物与 lockfile 随之同步；shared 新增的 `apply_patch` 目标解析由它自己的普通依赖 `@deepseek-ai/dsh-fs-patch` 提供，本包不需要重复声明。
- **OCR 契约抬到 `1.13.5`**：`lib/cli.ts` 的 `EXPECTED_OCR_CLI_VERSION` 与 `package.json` 的 `ocrCliVersion` 同值，两份 README、四份安装文档里钉版本的装法行、`THIRD_PARTY_NOTICES.md` 的验证版本与运行期依赖行都由 `test/readme-parity.test.ts` 核到同一枚数字——期望版本改了而装法行停在旧版时，用户照着装完会永远收到「实测与核对版本不一致」，而两侧文档各自自洽。
- **宿主开发基线**：`devDependencies` 的 dsh 家族抬到 `0.2.2-rc.1`，`@deepseek-ai/cordis` 抬到 `4.1.0`，cordis 插件组两枚抬到 `1.1.0`，`@deepseek-ai/schemastery` 抬到 `3.19.0`；`@deepseek-ai/dsh-ptc-runtime` 从 devDependencies 移除（源码与测试都不再引用它）。根 catalog 与 overrides 的投影同步，`pnpm-lock.yaml` 随之重解。
- **支持窗口与 Node 下限**：`engines.dsh` 与四枚 `@deepseek-ai/dsh*` peer 由 `^0.2.1-rc.3 || ^0.2.2-alpha.2` 改为 `^0.2.1-rc.5 || ^0.2.2-alpha.3`；`@deepseek-ai/schemastery` 的 peer 放宽为 `^3.18.5 || ^3.18.6-alpha.1`，与两条宿主线各自的实装版本对齐；`engines.node` 由 `>=22.12.0` 抬到 `>=24.9.0`（宿主 `0.2.2` 线自己声明的下限）。
- **卡片组件改由 shared 的 `./client` 供**：`src/client-entry.ts` 与 `src/remote.ts` 的运行期值导入迁到 `./client`，`package.json` 新增 `dsh.bundle.client.external`，`build-client.mjs` 的外置清单同步；`cordis.patch.yml` 因此插入一条**不写 id** 的 `@jayyuen66/dsh-plugin-shared` 组件行（写 id 会在插件页多出一个可关闭的组件，关掉后设置卡失去组件供应）。
- **`js-yaml` 抬到 5.5.0**：本包唯一直接消费它的解析路径不变，取值随伞根 catalog 与 overrides 同源。
- **CI 的 node 矩阵收敛**：`ci.yml` 的 `node: [22, 24]` 加 macOS 排除改为单格 `node: [24.9]`，两份 workflow 的 `node-version` 由 `24` 改为 `24.9`，与 `engines.node` 同值。
- **文档纠偏**：dsh 徽章由 `^0.2.1-rc.3` 抬到 `^0.2.1-rc.5`，与 `engines.dsh` 首条同值；`cordis.patch.yml` 的注册行由「唯一一行」改写为「两条条目」并说明 shared 那行为何不写 id；「本地目录安装需要 Node ≥ 22.18」那句原文推论成「`>= 24.9` 只约束发布产物」，而 `engines.node` 是 manifest 字段、不分安装路线，改为两条并列陈述（读源码需 ≥22.18，本包声明的下限是 `>=24.9.0`），中文侧此前完全没有这一句；`THIRD_PARTY_NOTICES.md` 指向的 README 小节名 `External CLI status and version` 在两份 README 里都不存在，改为实际标题 “The external CLI”；`docs/DETAIL.zh.md` 的 `startupVerify` 补上「同时门控版本测量」那半，此前只有英文侧写了。

## 0.1.11

这一版把宿主开发基线抬到 `0.2.2-alpha.3`，同步 shared `0.2.3`，并把外部 `ocr`
对外声明抬到 `1.13.4`；随包文档里的版本声明改由一条门禁与 manifest、catalog 对齐，测试补上
平台桩与几处会随环境变脸的断言。对外工具与 Remote 方法名单不变。

### Changed

- **宿主开发基线与支持窗口**：`devDependencies` 的 dsh 家族抬到 `0.2.2-alpha.3`，
  cordis 抬到 `4.0.6-alpha.2`，schemastery fork 抬到 `3.18.6-alpha.2`；`engines.dsh`
  与 dsh 家族 peer 保持 `^0.2.1-rc.3 || ^0.2.2-alpha.2` 并集窗口，同时覆盖 rc 线与
  alpha 线。
- **shared 抬到 `0.2.3`**：catalog、单仓 overrides 与 lockfile 同源到 0.2.3；
  THIRD_PARTY_NOTICES 的依赖表同步。
- **OCR 契约抬到 `1.13.4`**：`package.json` 的 `ocrCliVersion`、`lib/cli.ts` 的
  `EXPECTED_OCR_CLI_VERSION`、两侧 README、两份 DETAIL 与 THIRD_PARTY_NOTICES 的验证
  版本和运行期依赖那几行都由同一条核对检查对上同一个数字。
- **发布链**：CI 与 publish 的 pnpm 固定到 `12.11.2`；registry 预检的包名与 shared
  依赖名改从 `package.json` 读取，不再维护第二份字面量。
- **测试**：新增 `test/fixtures/platform-stub.ts`，平台相关用例统一走它；Windows
  非提权环境跳过符号链接越界用例（跳过的是 symlink 前提，不是用例意图）；CLI
  默认解析改用全新记忆槽；临时目录回收移到文件顶层；飞行中的 `busy` 断言收紧为必须
  为 `true`。
- **随包文档**：图标来源补上上游 path 的几何取值；README 说明本地目录安装需要
  Node ≥ 22.18；DETAIL 明确 `startupVerify` 同时门控装载期的端点自检与版本测量。

### Verification

- `npm run check`：typecheck、lint、双构建、全套用例、四项 100% 覆盖率与 oxfmt 全绿。
- `pnpm install --frozen-lockfile --ignore-scripts`（pnpm `12.11.2`）通过；
  `pnpm run sync --check` 与 `node scripts/bump-manifests.mjs` 无漂移。
- `smoke dsh-ocr-review --tarball` 在 dsh `0.2.2-alpha.3` 沙箱命中本包层；tarball
  含 `host.js`、`client.js`、`docs/`、`locale/`、`CHANGELOG.md` 与
  `THIRD_PARTY_NOTICES.md`。

## 0.1.10

一轮跨模块的审查修复：路径的把关、MCP 配置的写入与并发覆盖、provider 数据与解析后的统一处理处理；设置卡和工具出口同步加固。对外的工具与 Remote 方法名单不变。

### Changed

- **MCP 写入增加 revision 基线**：`mcp()` 的回执新增 `revision`，`saveMcp` 的入参增加可选的 `revision`——带基线时在锁内比对，过期就整笔拒绝并返回 `mcpSaveConflict`；不带基线沿用原来的后写覆盖行为（兼容旧客户端）。同时开着两张卡或手改 config.json 时，后保存的人不再静默抹掉别人的更新。
- **发布链加固**（`.github/workflows/publish.yml`）：发布步 `pnpm install --ignore-scripts`、构建移至无凭据步、`pnpm publish --ignore-scripts`，生命周期脚本不再能接触发布凭据；`prepack` 删除改 `prepare`（同为双构建）。
- **依赖与元数据**：js-yaml 改精确钉 `5.4.3`；`@deepseek-ai/schemastery` peer 放宽为 `^3.18.6-alpha.1`；catalog 的 shared 抬到 0.2.2；author 改对象形（name+url）。

### Fixed

- **路径闸**（`lib/argv-guard.ts`）：归一后落在文件系统根（`/`、盘符根、UNC 根）一律拒绝，堵 `--rule /etc/passwd` 被当仓内文件读进 OCR；`statSync` 改 `throwIfNoEntry: false`；会话根判定改 `path.isAbsolute`（Windows `C:/…` 不再落相对分支）。
- **Remote 拒绝回执的判断条件**（`lib/remote-shape.ts`）：`isRemoteRefused` 接受 `unknown`，要同时满足 `ok===false`、`error` 非空、`status` 是整数，null、NaN 和原始值不再误判；状态码集中成导出常量 `OCR_REFUSE_STATUS`。
- **MCP 配置**（`lib/mcp-config.ts`）：写失败独立文案；输出容器改 null 原型（`__proto__` 键不再丢失/污染）；写入那侧把磁盘上同一条目里的未知字段接回来；providers.chatgpt 不合法时改成显式报错；读取那侧加 64 KiB 上限；URL 的判断会拒绝空主机。
- **OCR config 迁移**（`lib/ocr-config.ts`）：不覆写已有非空 `api_key_cmd`；provider/model 入口一次 trim；空白 `language` 不落键；迁移写回统一走 `renderConfigDoc`。
- **provider 面**（`lib/provider-projection.ts`、`lib/provider-source.ts`）：baseURL 禁内嵌 `user:pass@`、空白/控制字符与无主机；`apiKeyEnv` 按导出的白名单统一处理，非法的 ref 单独暴露出来；health 和探测的异常统一处理，失败的出口都走 `settingsFailed()`。
- **解析与聚合**（`lib/parse.ts`、`lib/severity.ts`）：`isCount` 限制在安全整数范围、`toolCallsOf` 统一总数的算法、warnings 限流；`hitsContract` 只认可审查的文件和分组，`{"error":…}` 的载荷不再误报成 0 个文件；`byCategory` 用 null 原型。
- **工具出口守卫**（`lib/output.ts`）：新增容器形状闸；违规收集改 `ViolationSink`，收集期截断 20 条/2000 字，不再先攒几十万条。
- **host**（`host.ts`）：后台作业剪枝与取文案包 try 并先 killProc（不留无主 OCR 进程）；saveMcp/chatGpt 加外层 try 回可读回执；装载期 fire-and-forget 自检包 try（防未处理 rejection 终止宿主）；effort 未知值回落设置卡值。
- **设置卡**（`src/client-entry.ts`）：channel 改逐值比对；MCP 未读成功时禁编辑/保存；llmTest 失败按失败着色；refresh 并发只认最后一次。
- **CLI 与凭据脚本**（`lib/cli.ts`、`scripts/get-cred.mjs`）：pgrep 探针退出码 1（无匹配）不再算被拒；preview 也转发 `--max-tokens`；YAML 报错不再读 message/toString，防明文 snippet 外泄。

### Added

- **测试三层**：`test/e2e/stub-ocr.e2e.test.ts`（官方执行器真 spawn stub 全链路）、`test/e2e/real-cli.e2e.test.ts`（真 ocr 二进制对照，缺席显式跳过）、`test/platform/guards.platform.test.ts`、`test/property/parse-chain.property.test.ts`（fast-check）、`test/ref-syntax-parity.test.ts`、`test/write-surface.test.ts`；devDependencies 新增 fast-check 4.10.2 与 `@deepseek-ai/dsh-bash-local` / `@deepseek-ai/dsh-subprocess-local`。

## 0.1.9

这一版把后台评审的作业归属绑到发起它的会话，并把设置卡与读取结果的校验统一到 shared 组件和 zod；
插件页展示进包，宿主开发线抬到 0.2.2-alpha.2。对外工具与 Remote 方法名单不变，后台作业的可见性按发起会话收紧。

### Changed

- **后台作业按会话归属**：能解析到活 Agent 时，`jobs.start` 带 `owner`；`job_list` / `job_output` /
  `job_kill` 对该作业只在所属会话可见。会话销毁只回收它自己的作业（活的 kill、已落定的 remove），
  不再按 kind 全量回收别的会话的评审；解析不到活 Agent 的调用仍起无主作业，只在插件卸载时统一收。
- **作业记录**：新增一份 id → 发起会话的最小记录。注册表会向没有 caller 的视图隐藏有主人的作业，卸载时靠它
  枚举；已落定记录的裁剪按 caller 可见面（无主桶 + 自己的）计算。
- **设置卡迁到 shared 组件与 zod**：`src/remote.ts` 的三个 strict codec 改由 zod schema 生成；
  `src/client-entry.ts` 的枚举、计数与 providers 载荷改 zod 逐层校验，控件改用 shared 的
  `CARD_UI_CSS` / `CardForm` / `Field` 等。`zod` 进 `dependencies`，client 产物按宿主
  `PLATFORM_MODULES` 外置。
- **插件页展示进包**：新增 `locale/en.json`、`locale/zh.json` 与 `docs/DETAIL.md`、
  `docs/DETAIL.zh.md`；`exports` 增加 `./locale/*.json`，`files` 收进 locale 与 docs。
- **宿主开发线抬到 `0.2.2-alpha.2`**：devDependencies 与 catalog/overrides 同值；`engines.dsh`
  与 peer 写支持窗口 `^0.2.1-rc.3`，README 补滚动窗口说明。
- **正则常量提升**：argv-guard / config-store / mcp-config / output / parse / provider-projection
  的内联正则提取成命名常量，行为不变，满足 lint 的重复字面量检查。

### Fixed

- **脱敏不再误伤路径段**：独立 key 形态的匹配落在 `/` 或 `\` 两侧时按路径段保留，不再把带大写
  组件的仓库路径（例如 `Documents/...`）抹成 `***REDACTED***`。
- **会话销毁的回收范围**：`session/disposed` 过去按 kind 回收全部 OCR 作业，会把别的会话正在读的
  评审一并杀掉；现在只收 payload 那条会话的作业，认不出会话就什么都不做。

### Docs

- README 双语补后台作业的归属、容量桶、清理与残留暴露面，改正 `ocrReview` 方法数与 peer 枚数；
  DETAIL 改正了没有 key 的 provider（列出但禁用）和 `timeoutMinutes` 的取值规则；`THIRD_PARTY_NOTICES`
  同步 zod 依赖与 dsh 0.2.2-alpha.2 的核对基线。

## 0.1.8

这一版把外部 OCR 约定从 1.13.0 抬到 **1.13.3**，并把模型工具清单从「审查/扫描/委托/会话」扩到
文件预览、会话比较、规则与 LLM 诊断；设置卡同时补上 MCP servers 与 ChatGPT 两块人工管理区。
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
- **MCP 管理区**：设置卡新增 `mcp_servers` 编辑器，Remote 新增 `mcp()` / `saveMcp({json})`。
  写侧只改 `mcp_servers`，整体 64 KiB、最多 100 个 server；stdio/remote 按各自字段校验，
  未知字段、非法 URL、坏 `KEY=VALUE` 与超长数组都拒绝。
- **ChatGPT 管理区**：Remote 新增 `auth()`（只读 `ocr auth status --provider chatgpt`）与
  `chatGpt({model})`（写 provider/model、清理同条目 key、不写明文）。卡片显示登录命令与模型
  输入；OAuth 登录本身仍留在终端，因为需要浏览器与本地回调。
- **`effort` 新增 `auto`**：auto 时不传 `--effort`，让 OCR 自己的配置生效；卡片默认改为 auto。

### Changed

- **外部 OCR 契约从 1.13.0 抬到 1.13.3**：`ocrCliVersion`、代码常量、双语 README 与
  `THIRD_PARTY_NOTICES` 同步；1.13.3 的 scan path、provider 点号、grace round 与
  `review_limit_reached` 的行为纳入夹具。
- **宿主开发线从 rc.2 抬到 rc.3**：`engines.dsh`、peer/dev 依赖与 README 徽标/正文一致。
- **工具数 5 → 7，Remote 方法 5 → 9**：README、routing、parity 和 publish 那几条检查与包描述同步；
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
  插件侧当场报错，而不是拿一份过时的判据继续校验模型数据。
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
- CLI 参数校验、argv 转义和消息表统一整理。

## 0.1.6

### Changed

- **数据那一栏迁移收尾**：五条 `/_dsh/ocr-review/*` HTTP 端点改为官方 Typert Remote 的
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

- **外部 ocr CLI 改由用户自己安装**：先看 PATH，其次才是随包那一份，装法由用户自选；版本声明
  一处（package.json 的 `ocrCliVersion`，初值 1.13.0；此前的随包 CLI 不记版本），代码里的镜像常量和两侧 README 由同一条门禁对齐。按安装来源
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

- **外部 ocr CLI 的可得性与版本状态**：判断只有一处（`resolveOcrAvailability` 只读文件系统
  事实回答「装没装、从哪条路来」，绝不起进程）；五个工具起任何进程之前现读它并短路，四处
  界面显示共用同一条 `ocrBinary`。版本号只在按下「检测版本」时经 probe 端点跑一次
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
  env 和 project-env 层的 key 在写到磁盘之前就拒绝，消掉「select 成功 → OCR 401」这种漏报；get-cred 与
  双语 README 的「继承环境层」说法一并纠正。
- **webserver host 判定改为非回环 IP 字面量**：宿主 config 拒绝通配地址，旧的
  `=== "0.0.0.0"` 是永假死分支，LAN IP 绑定此前被信任闸整批 403。
- **后台兜底回收的理由按 `ocrBackgroundMaxMs` 的实际窗口换算**，不再写死 2 小时；
  delegate/session 回显补上 spill 写到磁盘路径。
- **Windows**：`ocrCommand` 恒取不带路径的 `ocr`（shebang launcher 不可直执行）；
  `api_key_cmd` 双引号转义（ocr 经 cmd.exe 跑凭据命令）；`parseApiKeyCmd` 双形态反解。

### Changed

- 依赖升级 `@deepseek-ai/*` alpha.2、`@alibaba-group/open-code-review` ^1.12.13、
  `@jayyuen66/dsh-plugin-shared` ^0.1.4；工具链 catalog 同步（rolldown 1.2.13 /
  vitest 5.0.3 / oxlint 1.87 / oxfmt 0.72 等）。

### Added

- `THIRD_PARTY_NOTICES.md`：随包分发的第三方内容边界（图标改绘归属 / ocr CLI 接口 /
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
- **约定闸假阴性**：preview/rule 的清单此前只查「键在不在」，类型不对时一律放过并产出
  ok:true + 空清单；warnings 条目被 `filter(Boolean)` 静默丢弃。argv 闸收紧（NUL 拒绝、
  数组项含逗号拒绝、limit NaN 回落保守默认）；severity 与协议映射表的原型污染改走 Map。
- **`build-client.mjs` 包名缺失改为 fail loud**：退化成 `unknown` 会让产物 id 与宿主模块表
  键对不上——设置卡静默不渲染，而产物一致性检查用同一段退化逻辑做比对，检查照样报通过。

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
- **后台回执带上官方作业 id**：此前回执无任何句柄，polling 把模型导向可能还没写到磁盘的
  session list。jobId 按 id 寻址、启动即可读且一定有结果。

## 0.1.2

### Fixed

对照 ocr 1.12.10 与 dsh 0.2.0-rc.2 源码逐条核对后的修复：

- **status 白名单收 `partial`**：manifest 终态以 exit 0 输出，此前整场部分成功的评审被误报
  「status 非法」并丢弃全部评论；输出 schema enum 与摘要 hint 同步。
- **provider 协议映射改三值**：llm-pi-ai 的 anthropic-messages 映射为 OCR 的 anthropic
  （此前一律写成 openai，按 OpenAI 线协议打 Anthropic 端点必失败）；api 缺省按上游
  openai-completions 兜底；表外值透传给写侧白名单拒绝，绝不静默降级。
- **`ocr llm test` 与五个工具同一命令词解析源**：随包 launcher 装法下 PATH 上解析不到 ocr，
  autoVerify/测试连接不再恒 exit 127。
- **`ocrConfigPath` 真正生效**：自定义值须呈 `<X>/.opencodereview/config.json` 布局（OCR
  无文件级路径覆盖），插件给 ocr 子进程注入 `HOME=<X>`（POSIX 赋值前缀，win32 放行）；
  `api_key_cmd` 增加宿主 `resolveDshHome()` 第三段；布局外路径在设置层直接报错。
- **入参闸严格化**：resume+workspace 前置拒绝（OCR 约定 workspace 禁恢复）；effort/wait
  错类型抛错；session limit 越界抛错而非静默钳制（0 不再钳成 1）；action=list+id 抛错而非
  静默改写 show。

### Changed

- README 拆分为英文主文档与 `README.zh-CN.md`（顶部互链、14 节对照），补部署级调优值
  （llmTestTimeoutMs / ocrBackgroundMaxMs / stdoutMaxBytes）、「开发」与「许可证」两节；
  中文版不进 npm 发布清单。

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
