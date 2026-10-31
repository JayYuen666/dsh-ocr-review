#!/usr/bin/env node
/// <reference types="node" />
// get-cred.mjs —— open-code-review 的 api_key_cmd 入口（本包唯一还在读宿主凭据
// 文件的地方，且**只读不问服务**）。
//
// 为什么这个脚本必须存在：
//   - dsh 侧的 provider 清单与 key 状态已经改走官方通道（ctx.settings.describe() /
//     ctx.credentials），但 OCR 是**另一个进程树**里的外部 CLI：它只会按
//     ~/.opencodereview/config.json 里的 api_key_cmd 起子进程取 key，够不到 cordis
//     容器，也没有 dsh 的依赖注入。api_key_cmd 就是它唯一的动态 key 通道。
//   - 用户决策「key 不落 OCR 配置」：落盘的是命令字符串，明文只在取用时出现一次。
//     宿主侧写这条命令前已经用 credentials.resolve() 确认过 key 解析得到（host.ts
//     createGateway），本脚本负责让 OCR 自己也能取到同一个值。
//
// 谁调用它：外部 ocr CLI 本身（每次取 key 起一个进程，60s 超时），命令串由
// lib/config-store.ts buildApiKeyCmd() 生成：`node <本文件绝对路径> <REF_NAME>`。
// 本包代码不会 import 它，也没有别的调用点。
//
// 数据目录怎么找（刻意不写死 ~/.dsh）：显式第三参数 > $DSH_HOME > os.homedir()/.dsh
//   —— 与宿主 util/home-paths 的 resolveDshHome 优先级一致（configured > env > 默认）。
//   第三参数由 buildApiKeyCmd（lib/config-store.ts）在写 api_key_cmd 时带上：值是
//   **宿主进程此刻** resolveDshHome() 的解析结果。必须显式钉住的原因：设置项
//   ocrConfigPath 会给 ocr 子进程注入 HOME（<X>/.opencodereview/config.json 布局），
//   本脚本的 homedir() 兜底随之读 X/.dsh 就跑偏了；部署若以非 env 方式指定 dsh home，
//   env 档同样不可靠。
//
// 取值的层序必须与宿主**同源**：官方 credentials-local 的 LocalCredentialProvider
// 按「托管文件 > 继承环境 > .env」取值，本脚本只要排得不一样，同一 ref 在两处都有值
// 时 OCR 拿到的 key 就和宿主卡片认下的有效 key 分叉——两边都"成功"，打的是不同账号。
// 照抄官方优先级里本脚本**够得到**的那三层：
//   1. `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`（version: 1 托管文档，格式来源
//      packages/credentials/credentials-local 的 parseCredentialsDocument）；
//   2. 继承来的进程环境。注意：dsh 起 shell 会经 scrubbedParentEnv 剥掉名字命中
//      KEY/PASSWORD/SECRET/TOKEN 或 DSH_ 前缀的变量——凭据 ref 几乎全中招，所以对
//      经 dsh shell 起的 OCR，这一层对凭据 ref 实际常为空；它只在 ref 名不被净化
//      模式命中、或调用链不经 dsh shell（手工在终端跑 ocr）时才有值。宿主侧的
//      select/migrate 已按同一事实加闸（keyReachableAtOcrRuntime）：key 只存在于
//      环境层/项目 .env 的配置会在写盘前被拒绝，而不是等 OCR 401。
//   3. `$DSH_HOME/.env`（用户级回退层）。
//   **项目 .env 刻意不读**：本脚本的 cwd 是 OCR 当时所在的仓库，跟 dsh 的启动工作区
//   不是一回事，去读它等于把「被审查仓库」里的键当成用户的凭据。
//
// OCR api_key_cmd 契约（docs/configuration）：
//   - 命令去除首尾空白后的单行 stdout 即 key；多行/空/非零退出 = 硬错误，OCR
//     绝不静默回退（保持硬失败语义）。
//   - config.json 中的 api_key_cmd 属于可信输入（用户权限 0600）。
//
// 防注入：ref 名白名单校验 ^[A-Z0-9_]+$，绝不做 shell 拼接。
//
// 顶部 node reference：oxlint 类型检查对 .mjs 不自动加载 @types/node，需显式
// 声明才能解析 node:fs/node:os/node:process/process（否则整文件按 error 类型
// 误报 unsafe）。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";

/** 官方 ref 语法（credentials/src/index.ts:19 REF_PATTERN）。 */
const REF_PATTERN = /^[A-Z0-9_]+$/u;

/** 托管凭据文档的固定文件名（credentials-local 的 CREDENTIALS_FILENAME）。 */
const CREDENTIALS_FILENAME = ".credentials.yaml";

/**
 * 失败出口：写 stderr 并置退出码，**不**硬杀进程。
 *
 * process.stderr.write 对管道是异步的，紧随其后的 process.exit(1) 会在缓冲未清空时把
 * 诊断截成半句；置 exitCode 让事件循环自然排空后以非零收场，报错全文有保证。
 * @param {string} message
 * @returns {void}
 */
function fail(message) {
  process.stderr.write(message);
  process.exitCode = 1;
}

/**
 * 对象守卫（shared/lib/tool-events 同款防御）：typeof 收窄为 Record 而不经断言。
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 数据目录：显式参数 > $DSH_HOME > homedir()/.dsh（空/全空白按未设置处理）。
 * 只做**选择**；绝对性校验在调用点（main）做——那是一条要报错退出的硬门，与本函数
 * 「挑出候选目录」的职责分开。
 * @param {string | undefined} fromArg
 * @returns {string}
 */
function dataDirFrom(fromArg) {
  const arg = typeof fromArg === "string" ? fromArg.trim() : "";
  const { DSH_HOME: rawHome } = process.env;
  const fromEnv = typeof rawHome === "string" ? rawHome.trim() : "";
  let chosen = path.join(homedir(), ".dsh");
  if (fromEnv !== "") {
    chosen = fromEnv;
  }
  if (arg !== "") {
    chosen = arg;
  }
  return chosen;
}

/** 取值过程中遇到的坏消息（文件损坏/权限/引号写坏）；收集但不提前退出——某一层的
 *  小毛病不能把后面的合法层堵掉。出口只有两处：最终取不到时随失败原因一并报出，
 *  或取到了值时以警告形式报出（用户必须知道查过的层里有坏消息）。
 *  全程脱敏：明文值不进这条列表，YAML 报错走 yamlErrorDetail。
 * @type {string[]} */
const problems = [];

/**
 * 缺字段时的空映射：解构取值同时满足 tsc 的 `noPropertyAccessFromIndexSignature`
 * 与 lint 的点号规则，不必二选一。
 * @type {Record<string, unknown>}
 */
const EMPTY_RECORD = {};

/**
 * ENOENT 判定（文件不存在是正常态，别把它当损坏报出去）。
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  if (!isRecord(error)) {
    return false;
  }
  const { code } = error;
  return code === "ENOENT";
}

/**
 * YAML 解析错误的**脱敏**描述：只留 reason + 行列定位，不带出错位置前后若干行的原文。
 *
 * 为什么必须自己拼：js-yaml 的 YAMLException 会把 mark.snippet（出错点邻域的**原文**）
 * 附在 message 上——构造函数里的 `this.message = formatError(this, false)` 与
 * `toString()` 的非紧凑分支都是这样。而 .credentials.yaml 的 refs.<REF> 里放的就是
 * 明文 key，于是一处缩进/引号笔误就会把邻近行的真实 key 写进 stderr（OCR 会记录
 * api_key_cmd 的 stderr，也可能进宿主日志），直接违反「明文只在取用时出现一次」。
 * 因此这里既不读 message 也不调 toString：只取 YAMLException 的 reason 与 mark
 * 两个数据字段。非 YAMLException 的 Error 没有这两个字段，退回 name——同样不碰
 * message。
 *
 * @param {unknown} error
 * @returns {string}
 */
function yamlErrorDetail(error) {
  if (!(error instanceof Error)) {
    // 不是 Error 实例：String(error) 只会得到 "[object Object]" 一类无信息文本。
    return "";
  }
  const { reason: rawReason, mark } = isRecord(error) ? error : EMPTY_RECORD;
  const reason = typeof rawReason === "string" && rawReason !== "" ? rawReason : error.name;
  const { line, column } = isRecord(mark) ? mark : EMPTY_RECORD;
  const located =
    typeof line === "number" && typeof column === "number" ? ` (${line + 1}:${column + 1})` : "";
  return `${reason}${located}`;
}

/**
 * 读取并解析托管文档；读不到或解析失败都留一条 problem，交回 undefined。
 * @param {string} credPath
 * @returns {unknown}
 */
function parseCredentialsDocument(credPath) {
  let text;
  try {
    text = readFileSync(credPath, "utf8");
  } catch (error) {
    // 文档不存在是正常态（只用环境/`.env` 的部署），不当错误报。
    if (!isNotFound(error)) {
      problems.push(`读取凭证文件失败：${credPath} ${String(error)}`);
    }
    text = undefined;
  }
  let doc;
  if (text !== undefined) {
    try {
      doc = load(text);
    } catch (error) {
      problems.push(`凭证文件不是合法 YAML：${credPath} ${yamlErrorDetail(error)}`);
      doc = undefined;
    }
  }
  return doc;
}

/**
 * 取文档里的 refs 映射；顶层不是映射、或 refs 存在却不是映射时记 problem。
 * 文件能解析但形状不对时，静默回退到环境层会让用户以为托管文档仍生效，实际拿的
 * 是另一份旧 key；这里记一条不含任何值的 problem，成功回退时一并转述。
 * refs 键缺席不算坏形状：没有要取的 ref 时它本来就是可选的。
 * @param {unknown} doc
 * @param {string} credPath
 * @returns {Record<string, unknown> | undefined}
 */
function refsMapOf(doc, credPath) {
  const { refs } = isRecord(doc) ? doc : EMPTY_RECORD;
  if (doc !== undefined && (!isRecord(doc) || (refs !== undefined && !isRecord(refs)))) {
    problems.push(`凭证文件顶层不是 { refs: { … } } 映射：${credPath}`);
  }
  return isRecord(refs) ? refs : undefined;
}

/**
 * OCR 的 api_key_cmd 契约只认**单行** stdout（空/多行都是硬错误）。托管文档里
 * 引号内的空白与块标量（| / >）分别产出空白值与多行值：交给 OCR 只会换来隔了
 * 一层的「resolve LLM endpoint」报错，而这一层本可以当没有值、继续往下回退。
 * @param {unknown} value
 * @param {string} refName
 * @param {string} credPath
 * @returns {string | undefined}
 */
function singleLineKeyOf(value, refName, credPath) {
  let key;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      problems.push(`凭证文件 refs.${refName} 为空白值，按未配置处理：${credPath}`);
    } else if (/[\r\n]/u.test(trimmed)) {
      problems.push(`凭证文件 refs.${refName} 为多行值，按未配置处理：${credPath}`);
    } else {
      key = trimmed;
    }
  }
  return key;
}

/**
 * 托管 YAML 文档里的 refs.<REF>（形状不合一律回 undefined，不抛）。
 * 解析失败走 `yamlErrorDetail`，绝不把邻域原文带进 stderr。
 * @param {string} credPath
 * @param {string} refName
 * @returns {string | undefined}
 */
function fromCredentialsDoc(credPath, refName) {
  const refs = refsMapOf(parseCredentialsDocument(credPath), credPath);
  let value;
  if (refs !== undefined) {
    const { [refName]: selected } = refs;
    value = selected;
  }
  let key;
  if (value !== undefined && typeof value !== "string") {
    // 只报形状，绝不把值本身写进 problems（明文不落日志）。refs.<REF> 被写成
    // 数字/布尔/映射时若静默当「没有值」，用户改了托管文档却拿到下一层的旧值，
    // 全程零提示。
    problems.push(
      `凭证文件 refs.${refName} 不是字符串（是 ${Array.isArray(value) ? "数组" : typeof value}）：${credPath}`,
    );
  } else {
    key = singleLineKeyOf(value, refName, credPath);
  }
  return key;
}

/**
 * 继承来的进程环境层：去首尾空白，空白按「这一层没有值」处理；含内嵌换行的值整层作废。
 *
 * 单行是 OCR 的 api_key_cmd 契约（多行 stdout = 硬错误，见文件头），托管文档层已按同一条
 * 判据丢弃——环境层不能是例外：把带内嵌换行的值原样吐出去，用户拿到的是隔了一层的
 * 「resolve LLM endpoint」报错，而这一层本可以当没有值、继续往下回退。
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
function fromInheritedEnv(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" || /[\r\n]/u.test(value) ? undefined : value;
}

/**
 * 未加引号的取值：trim，含「 #」时从那里剥离行内注释；剥完为空白按没有值。
 * @param {string} trimmed
 * @returns {{ value: string | undefined, problem: string | undefined }}
 */
function unquotedValueOf(trimmed) {
  const commentAt = trimmed.indexOf(" #");
  const bare = commentAt === -1 ? trimmed : trimmed.slice(0, commentAt).trim();
  return { value: bare === "" ? undefined : bare, problem: undefined };
}

/**
 * 扫描带引号的值：交出引号内文本、是否闭合、闭合后的游标。双引号内 `\"` 与 `\\`
 * 是转义（交出的文本已还原），单引号内全部字面——与 dotenv 的两套引号语义一致。
 * @param {string} trimmed
 * @param {string} quote
 * @returns {{ value: string, closed: boolean, end: number }}
 */
function scanQuoted(trimmed, quote) {
  let value = "";
  let index = 1;
  while (index < trimmed.length) {
    const ch = trimmed[index];
    const escaped =
      quote === '"' && ch === "\\" && (trimmed[index + 1] === '"' || trimmed[index + 1] === "\\");
    if (escaped) {
      value += trimmed[index + 1];
      index += 2;
    } else if (ch === quote) {
      return { value, closed: true, end: index + 1 };
    } else {
      value += ch;
      index += 1;
    }
  }
  return { value, closed: false, end: index };
}

/**
 * 带引号形态的取值：成对才剥；闭引号之后只允许空白或行内注释。单边引号、闭引号后跟
 * 多余字符都记 problem——硬砍首尾等于把凭据改短一位，拿一个错 key 去打上游（401），
 * 比报「未配置」难排查得多。剥引号后再 trim 并判空：`KEY=""` / `KEY="   "` 与另两层
 * （托管文档、进程环境）的口径一致——纯空白不是可用凭据，按「该行没有值」处理。
 * @param {string} trimmed
 * @param {string} quote
 * @returns {{ value: string | undefined, problem: string | undefined }}
 */
function quotedValueOf(trimmed, quote) {
  const scanned = scanQuoted(trimmed, quote);
  if (!scanned.closed) {
    return { value: undefined, problem: "引号未配对" };
  }
  const rest = trimmed.slice(scanned.end).trim();
  if (rest !== "" && !rest.startsWith("#")) {
    return { value: undefined, problem: "闭引号之后还有多余字符" };
  }
  const unquoted = scanned.value.trim();
  return { value: unquoted === "" ? undefined : unquoted, problem: undefined };
}

/**
 * .env 一行里「=」右侧的取值：按首字符分派到未加引号 / 带引号两条解析路径（判据各自
 * 见下）。只实现与官方 dotenv 相交且本脚本用得到的语义；拿不准的形态 fail-closed
 * （按该行未配置处理并记 problem），绝不猜一个值出去。
 * @param {string} raw
 * @returns {{ value: string | undefined, problem: string | undefined }}
 */
function parseDotEnvValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { value: undefined, problem: undefined };
  }
  const quote = trimmed.charAt(0);
  if (quote === '"' || quote === "'") {
    return quotedValueOf(trimmed, quote);
  }
  return unquotedValueOf(trimmed);
}

/**
 * $DSH_HOME/.env 的 KEY=VALUE（文件不存在按「该层没有值」处理）。
 *
 * 同名 key 取**最后一行**的值（dotenv 语义：后者覆盖前者）；空值行同样参与覆盖——
 * 最后一行写 `KEY=` 就是把这层 unset。解析出 problem 的行不参与覆盖（该行整条作废，
 * 不能拿一个坏行抹掉前面好好的值），但会记进 problems。
 * @param {string} envPath
 * @param {string} refName
 * @returns {string | undefined}
 */
function fromUserDotEnv(envPath, refName) {
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      problems.push(`读取 ${envPath} 失败：${String(error)}`);
    }
  }
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${refName}\\s*=\\s*(?<value>.*)$`, "u");
  let hit;
  // 按 /\r?\n/ 拆而不是 "\n"：上面那条正则的 `.*` 不匹配 \r、`$` 又要求串尾，
  // 而按 "\n" 拆出来的 CRLF 行每行都带尾随 \r，于是每一行都匹配不上——整个 .env
  // 层对所有 key 静默失配，用户只看到隔了一层的「取不到凭据」。
  const lines = (text ?? "").split(/\r?\n/u);
  for (const [offset, line] of lines.entries()) {
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }
    const { value: rawValue } = match.groups ?? EMPTY_RECORD;
    const parsed = parseDotEnvValue(typeof rawValue === "string" ? rawValue : "");
    if (parsed.problem === undefined) {
      hit = parsed.value;
    } else {
      problems.push(
        `${envPath} 第 ${offset + 1} 行（${refName}）${parsed.problem}，该行按未配置处理`,
      );
    }
  }
  return hit;
}

function main() {
  const refName = process.argv[2] ?? "";
  if (!REF_PATTERN.test(refName)) {
    fail(`[get-cred] 非法 env key 名：${JSON.stringify(refName)}\n`);
    return;
  }
  const home = dataDirFrom(process.argv[3]);
  // 相对路径在这里是硬错误而不是照用：本脚本的 cwd 是 OCR 当时所在的那个仓库，
  // 相对路径会被解析成 `<被审查仓库>/.dsh/…`——正是文件头声明要避免的「拿被审查
  // 仓库里的文件当用户凭据」。猜不出用户指的是哪个目录，就不猜。
  if (!path.isAbsolute(home)) {
    fail(`[get-cred] dsh 数据目录必须是绝对路径，收到 ${JSON.stringify(home)}\n`);
    return;
  }
  const credPath = path.join(home, CREDENTIALS_FILENAME);
  const envPath = path.join(home, ".env");
  let found = fromCredentialsDoc(credPath, refName);
  let source = credPath;
  if (found === undefined) {
    found = fromInheritedEnv(process.env[refName]);
    source = "进程环境";
  }
  if (found === undefined) {
    found = fromUserDotEnv(envPath, refName);
    source = envPath;
  }

  if (found === undefined) {
    // 硬失败：OCR 契约里非零退出/空输出都不回退，所以原因必须写全（含查过的目录与
    // 各层的坏消息），否则用户只能看到「llm 请求 401」这种隔了一层的症状。
    const notes = problems.length === 0 ? "" : `；${problems.join("；")}`;
    fail(`[get-cred] 取不到 ${refName}：查过 ${credPath}、进程环境与 ${envPath}${notes}\n`);
    return;
  }
  // 成功回退也要说话：查过的层里有坏消息时，用户必须知道生效的 key 得自哪一层。
  // problems 在收集时已按脱敏口径拼装（YAML 报错走 yamlErrorDetail，绝不带邻域
  // 原文），这里原样转述。只报实际来源，不推断「更低的一层」——坏消息可能来自
  // .env 自己的坏行，而值也正是同一层给的。
  if (problems.length > 0) {
    process.stderr.write(
      `[get-cred] 注意：查凭据时遇到坏消息（${problems.join("；")}），${refName} 实际取自 ${source}\n`,
    );
  }
  process.stdout.write(`${found}\n`);
}

main();
