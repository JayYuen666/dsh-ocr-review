#!/usr/bin/env node
/// <reference types="node" />
// get-cred.mjs —— open-code-review 的 api_key_cmd 入口（本包唯一还在读宿主凭据
// 文件的地方，且**只读不问服务**）。
//
// 为什么这个脚本必须存在（官方通道改造后仍然保留）：
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
// 取值的层序镜像官方 credentials-local 的优先级里**够得到**的那两层：
//   1. 继承来的进程环境（dsh 的 env 层就是最高层：`DEEPSEEK_API_KEY=… dsh` 时，
//      OCR 作为孙进程本来就继承得到，过去只读文件反而把它丢了）；
//   2. `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`（version: 1 托管文档，
//      格式来源 packages/credentials/credentials-local/src/index.ts:169-216）；
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
 * 对象守卫（shared/lib/tool-events 同款防御）：typeof 收窄为 Record 而不经断言。
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 数据目录：显式参数 > $DSH_HOME > homedir()/.dsh（空/全空白按未设置处理）。
 *
 * 相对路径在这里是硬错误而不是照用：本脚本的 cwd 是 OCR 当时所在的那个仓库，
 * 相对路径会被解析成 `<被审查仓库>/.dsh/…`——正是文件头声明要避免的「拿被审查
 * 仓库里的文件当用户凭据」。猜不出用户指的是哪个目录，就不猜。
 * @param {string | undefined} fromArg
 * @returns {string}
 */
function dataDirFrom(fromArg) {
  const arg = typeof fromArg === "string" ? fromArg.trim() : "";
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  let chosen = path.join(homedir(), ".dsh");
  if (fromEnv !== "") {
    chosen = fromEnv;
  }
  if (arg !== "") {
    chosen = arg;
  }
  if (!path.isAbsolute(chosen)) {
    process.stderr.write(`[get-cred] dsh 数据目录必须是绝对路径，收到 ${JSON.stringify(chosen)}\n`);
    process.exit(1);
  }
  return chosen;
}

/** 取值过程中遇到的坏消息（文件损坏/权限）；只在最终失败时一并报出，
 *  免得某一层的小毛病提前 exit 1 把后面的合法层也堵掉。 */
const problems = [];

/**
 * ENOENT 判定（文件不存在是正常态，别把它当损坏报出去）。
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * 托管 YAML 文档里的 refs.<REF>（形状不合一律回 undefined，不抛）。
 * @param {string} credPath
 * @param {string} refName
 * @returns {string | undefined}
 */
/**
 * YAML 解析错误的**脱敏**描述：只留 reason + 行列定位，不带出错位置前后若干行的原文。
 *
 * 为什么必须自己拼：js-yaml 的 YAMLException 有两处会把 mark.snippet（出错点邻域的
 * **原文**）附在文本后面——构造函数里的 `this.message = formatError(this, false)`，以及
 * `toString()` 在 compact 为假时的分支。而 .credentials.yaml 的 refs.<REF> 里放的就是
 * 明文 key，于是一处缩进/引号笔误就会把邻近行的真实 key 写进 stderr（OCR 会记录
 * api_key_cmd 的 stderr，也可能进宿主日志），直接违反「明文只在取用时出现一次」。
 * 实测 `String(err)` 与 `err.message` 两条路都会带出 snippet，只有 toString(true)
 * （紧凑格式）是干净的。
 *
 * @param {unknown} error
 * @returns {string}
 */
function yamlErrorDetail(error) {
  if (error instanceof Error) {
    // js-yaml 的 YAMLException 覆盖了 toString(compact)：传 true 走紧凑分支，
    // 只有这一条路不带 snippet。别的 Error 会忽略这个参数，返回普通的
    // "Name: message"，同样不含出错点邻域的原文。
    const compact = error.toString(true);
    if (typeof compact === "string" && compact !== "") {
      return compact;
    }
    // 拿不到紧凑形态时**不能**退回 error.message：js-yaml 构造器里赋的就是
    // this.message = formatError(this, false)，那份 message 正是带 snippet 的
    // 那一条。改用 reason + 行列定位自行拼装，两者都不含原文。
    const reason = typeof error.reason === "string" ? error.reason : "";
    const { mark } = error;
    const line = isRecord(mark) ? mark.line : undefined;
    const column = isRecord(mark) ? mark.column : undefined;
    const located =
      typeof line === "number" && typeof column === "number"
        ? ` (line:${line + 1}, column:${column + 1})`
        : "";
    return `${reason}${located}`;
  }
  // 到这里 error 不是 Error 实例：String(error) 会隐式走 Object.prototype.toString
  // 产出 "[object Object]" 这种毫无信息量的文本，直接给空串。
  return "";
}

function fromCredentialsDoc(credPath, refName) {
  let text;
  try {
    text = readFileSync(credPath, "utf8");
  } catch (error) {
    // 文档不存在是正常态（只用环境/`.env` 的部署），不当错误报。
    if (!isNotFound(error)) {
      problems.push(`读取凭证文件失败：${credPath} ${String(error)}`);
    }
  }
  /** @type {unknown} */
  let doc;
  if (text !== undefined) {
    try {
      doc = load(text);
    } catch (error) {
      problems.push(`凭证文件不是合法 YAML：${credPath} ${yamlErrorDetail(error)}`);
    }
  }
  const refs = isRecord(doc) ? doc.refs : undefined;
  let value = isRecord(refs) ? refs[refName] : undefined;
  if (value !== undefined && typeof value !== "string") {
    // 只报形状，绝不把值本身写进 problems（明文不落日志）。refs.<REF> 被写成
    // 数字/布尔/映射时若静默当「没有值」，用户改了托管文档却拿到下一层的旧值，
    // 全程零提示。
    problems.push(
      `凭证文件 refs.${refName} 不是字符串（是 ${Array.isArray(value) ? "数组" : typeof value}）：${credPath}`,
    );
    value = undefined;
  }
  // OCR 的 api_key_cmd 契约只认**单行** stdout（空/多行都是硬错误）。托管文档里
  // 引号内的空白与块标量（| / >）分别产出空白值与多行值：交给 OCR 只会换来隔了
  // 一层的「resolve LLM endpoint」报错，而这一层本可以当没有值、继续往下回退。
  const key = typeof value === "string" ? value.trim() : "";
  return key !== "" && !/[\r\n]/u.test(key) ? key : undefined;
}

/**
 * `.env` 的单行取值：去首尾空白，长度 > 1 且以引号开头时剥掉包裹引号。
 * @param {string} raw
 * @returns {string}
 */
function unquotedValue(raw) {
  const trimmed = raw.trim();
  const [first] = trimmed;
  // 只有首尾**配对**的引号才剥。单边引号是用户写坏了，硬砍首尾等于把凭据改短
  // 一位，拿一个错 key 去打上游（401），比报「未配置」难排查得多。
  if (trimmed.length > 1 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * $DSH_HOME/.env 的 KEY=VALUE（去掉可选引号；文件不存在按「该层没有值」处理）。
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
  let hit = "";
  // 按 /\r?\n/ 拆而不是 "\n"：上面那条正则的 `.*` 不匹配 \r、`$` 又要求串尾，
  // 而按 "\n" 拆出来的 CRLF 行每行都带尾随 \r，于是每一行都匹配不上——整个 .env
  // 层对所有 key 静默失配，用户只看到隔了一层的「取不到凭据」。
  for (const line of (text ?? "").split(/\r?\n/u)) {
    const value = unquotedValue(pattern.exec(line)?.groups?.value ?? "");
    if (value.length > 0) {
      hit = value;
      break;
    }
  }
  return hit === "" ? undefined : hit;
}

const refName = process.argv[2] ?? "";
if (!REF_PATTERN.test(refName)) {
  process.stderr.write(`[get-cred] 非法 env key 名：${JSON.stringify(refName)}\n`);
  process.exit(1);
}

const inherited = process.env[refName];
const home = dataDirFrom(process.argv[3]);
const found =
  (typeof inherited === "string" && inherited.trim().length > 0 ? inherited.trim() : undefined) ??
  fromCredentialsDoc(path.join(home, CREDENTIALS_FILENAME), refName) ??
  fromUserDotEnv(path.join(home, ".env"), refName);

if (found === undefined) {
  // 硬失败：OCR 契约里非零退出/空输出都不回退，所以原因必须写全（含查过的目录与
  // 各层的坏消息），否则用户只能看到「llm 请求 401」这种隔了一层的症状。
  const notes = problems.length === 0 ? "" : `；${problems.join("；")}`;
  process.stderr.write(
    `[get-cred] 取不到 ${refName}：查过进程环境、${path.join(home, CREDENTIALS_FILENAME)} 与 ${path.join(home, ".env")}${notes}\n`,
  );
  process.exit(1);
} else {
  // 成功路径与失败路径同为「一条语句」形态：exit(1) 之后的分支互斥，不落到 stdout。
  process.stdout.write(`${found}\n`);
}
