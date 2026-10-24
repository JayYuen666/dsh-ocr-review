// lib/argv-guard.ts —— 交给 `ocr` CLI 的 argv 的**唯一闸门层**：转义、绝对路径校验、
// 逗号列表规范化、枚举与数值钳制。
//
// 为什么从 lib/cli.ts 拆出来：这几族东西共同回答一个问题——「这串用户可控输入能不能进最终
// 命令」。判据本身与「命令长什么样」无关（cli.ts 的五条命令构造与回收守护只是逐槽位来问一
// 次），故与 cli.ts 分家。
//
// 报错文案双语：与 lib/cli.ts 同一口径——消息表（lib/messages.ts 的一份）由调用点作入参
// 注入，纯函数不读设置；本模块的校验文本原样回显给模型（工具失败信息）。

import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";

/**
 * POSIX sh 单引号转义：' → '\''。把任意字符串安全放进单引号内，防注入。
 *
 * NUL 一律拒绝：POSIX 命令串根本无法表示 NUL 字节，含 NUL 的值经 `bash -c '<inner>'`
 * 会被截断或报错，产出「看起来成功但 argv 被截断」的不确定行为。当前各调用点恰好都先
 * 做了 NUL 拒绝，但那是靠调用顺序维持的隐式不变量；这里把闸下沉到实现自身，让
 * 「转义后的串一定能被 shell 完整读回」由本函数保证，而不是指望每个新调用点记得先查一遍。
 */
export function shq(value: string): string {
  if (value.includes("\u0000")) {
    // 刻意不走消息表：这不该由用户输入触发——各入口（assertAbsoluteRoot /
    // takeTrimmedItems）都已先拒过 NUL，能走到这里说明是**内部不变量**破了，
    // 文案要的是给维护者看「哪条路径漏了检查」，而不是给用户看的可翻译拒绝理由。
    throw new Error(
      "shq：值里含 NUL 字节，转义后的命令串无法被 shell 完整读回（漏了上游 NUL 检查）",
    );
  }
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * 绝对路径校验（macOS/Linux）：非空、trim 后以 / 开头、无 NUL 字节；交出前归一成唯一形态。
 *
 * 先 trim 再判：调用点会先 trim 再传进来，而直接调用 `args.repo` 的路径若带首尾空白，
 * 会被「必须是绝对路径」这条误导性文案拦下——读起来像是路径写错了格式，实际只是多了
 * 几个空格。顺带也挡住全空白（trim 后为空 ⇒ 触发 repoRequired）。
 *
 * 归一（posix.normalize + 去尾随斜杠）的目的：同一个仓库只允许一种字符串形态到达下游。
 * `/repo//sub`、`/repo/./a`、`/repo/` 与 `/repo/sub` 是同一目录的几种写法，而会话目录
 * 等按路径派生的键会把这些写法各存一份；`..` 段按词法折叠成实际目标（`/repo/../..`
 * 落到 `/`）——折叠是 normalize 对绝对路径的既有行为，不存在「解析后仍含 `..`」的
 * 形态，所以这里没有可写的拒绝分支。
 */
export function assertAbsoluteRoot(root: unknown, messages: OcrReviewMessages): string {
  const trimmed = typeof root === "string" ? root.trim() : "";
  if (trimmed.length === 0) {
    throw new Error(messages.repoRequired);
  }
  if (trimmed.includes("\u0000")) {
    throw new Error(format(messages.noNulBytes, { name: "repo" }));
  }
  if (!trimmed.startsWith("/")) {
    throw new Error(format(messages.repoMustBeAbsolute, { root: trimmed }));
  }
  const normalized = path.posix.normalize(trimmed);
  // 根 "/" 无尾随斜杠可去；其余形态收成无尾随斜杠的目录。
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

/**
 * `--rule` / `--background-file` 的路径闸：只允许 repo 根内的普通文件。
 *
 * 这两个 flag 会把文件内容读进 OCR 并可能送给 LLM；OCR 子进程以
 * `danger-full-access` 运行，若放任 `../../.ssh/id_rsa` 之类的路径，一次工具调用就能
 * 把仓库外的文件送进模型。realpath 先解开符号链接再比较，`path.resolve` 的文本前缀
 * 判据挡不住指向仓库外的软链。
 *
 * @param root - 已校验为绝对路径的 repo 根
 * @param value - 模型给的路径（相对 repo 或绝对）
 * @param name - 参数名（报错点名）
 * @param maxBytes - 允许的字节上限
 * @param messages - 双语文案
 * @returns 归一后的绝对路径
 */
export function resolveRepoFile(
  root: string,
  value: unknown,
  name: string,
  maxBytes: number,
  messages: OcrReviewMessages,
): string {
  if (typeof value !== "string") {
    throw new TypeError(format(messages.mustBeString, { name, received: typeof value }));
  }
  const text = value.trim();
  if (text === "") {
    throw new Error(format(messages.repoFileMissing, { name, path: "" }));
  }
  if (text.includes("\u0000")) {
    throw new Error(format(messages.noNulBytes, { name }));
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    throw new Error(format(messages.repoRootUnreadable, { path: root }), { cause: error });
  }
  let real: string;
  try {
    real = realpathSync(path.resolve(rootReal, text));
  } catch (error) {
    throw new Error(format(messages.repoFileMissing, { name, path: text }), { cause: error });
  }
  const rel = path.relative(rootReal, real);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error(format(messages.repoFileOutside, { name, path: text }));
  }
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new Error(format(messages.repoFileNotFile, { name, path: text }));
  }
  const { size } = stat;
  if (size > maxBytes) {
    throw new Error(
      format(messages.repoFileTooLarge, {
        name,
        path: text,
        limit: String(maxBytes),
      }),
    );
  }
  return real;
}

/** limit 非法（NaN / ≤0 / 非整数）时的保守兜底上限：宁可比调用方的意图更严。 */
const DEFAULT_LIST_LIMIT = 200;

/** `auto` = 不传 `--effort`，让 OCR 自己的配置决定；工具 schema 仍只暴露三档。 */
const EFFORTS = ["auto", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** effort 参数：非法值回默认（配置/medium 由调用方决定回退），此处只钳到合法集。 */
export function clampEffort(value: unknown, fallback: Effort): Effort {
  const matched = EFFORTS.find((level) => level === value);
  return matched ?? fallback;
}

// clampPositiveInt（concurrency/timeout/maxTokens 的数值钳制）已删除：生产侧从无
// 调用方——lib/cli.ts 的对应槽位全部走 ocr 自身的默认值或 clampEffort。一个无人调用的
// 导出留着，它的"契约"只会误导后来人以为已有人在用。

/** 字符串里第一个落在 glob 花括号内的逗号位置（没有则 -1）。 */
function firstCommaInsideBraces(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
    } else if (ch === "," && depth > 0) {
      return index;
    }
  }
  return -1;
}

/** 入参 → 原始项序列（commaList 的第一段：只判「值从哪来」，不判内容）。
 *  数组分支保留逐元素 for-of 而不是 `value.map`：map 会跳过稀疏数组的空洞，
 *  空洞本是「非字符串元素」这一条该拦的形态，跳过就等于静默少一项过滤条件。 */
function listSourceItems(value: unknown, name: string, messages: OcrReviewMessages): string[] {
  if (typeof value === "string") {
    // 与数组分支同一条口径：花括号内的逗号是 glob 语义的一部分，split(",") 会把它拆成
    // 多个无效模式（"src/**/*.{ts,tsx}" → "src/**/*.{ts" 与 "tsx}"），过滤条件失效、
    // 审查范围被无声扩大。逗号字符串形式同样表达不了这类模式，两条路径都明确拒绝。
    if (firstCommaInsideBraces(value) >= 0) {
      throw new TypeError(format(messages.commaInStringBraces, { name, item: value }));
    }
    return value.split(",");
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new TypeError(format(messages.listItemsMustBeString, { name }));
      }
      // 数组元素自身含逗号 ⇒ 拒绝，而不是等 join(",") 之后再拆。两条路径对同一语义输入
      // 会产出无法区分的命令行 token：["a,b"] 与 ["a","b"] join 后都是 "a,b"。而 glob
      // 花括号（{ts,tsx}）恰好含逗号，模型用数组传一个模式会被当成两个独立模式——
      // 审查或过滤范围被静默改变且不报错。这里宁可拒绝：静默改范围比报错危险得多。
      if (item.includes(",")) {
        throw new TypeError(format(messages.commaInListItem, { name, item }));
      }
      items.push(item);
    }
    return items;
  }
  throw new TypeError(format(messages.mustBeStringOrList, { name }));
}

/** 原始项 → 取值（commaList 的第二段：只判内容，NUL 抛错、trim、丢空串，满 limit 即止）。 */
function takeTrimmedItems(
  items: string[],
  name: string,
  limit: number,
  messages: OcrReviewMessages,
): string[] {
  // limit 是本模块的内部常量，但这一层是**专门防绕过**的闸，参数被传成 NaN 时静默放开
  // 上限是最危险的形态（out.length >= NaN 恒为 false ⇒ 完全不设限）。非法值回落到
  // 一个保守默认，而不是让它悄悄失效。
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIST_LIMIT;
  const out: string[] = [];
  let dropped = 0;
  for (const item of items) {
    if (item.includes("\u0000")) {
      throw new Error(format(messages.noNulBytes, { name }));
    }
    const trimmed = item.trim();
    // 超出上限不静默丢：审查范围会因此小于模型给的清单，而"少审了几份"在回执上
    // 看不出任何线索。空串与非空串分别处理，条件写在一起以避免 continue（本包 lint 禁它）。
    const skipForCap = trimmed.length > 0 && out.length >= cap;
    if (skipForCap) {
      dropped += 1;
    } else if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  if (dropped > 0) {
    throw new Error(
      format(messages.listOverLimit, { name, dropped: String(dropped), limit: String(cap) }),
    );
  }
  return out;
}

/** 入参 → 规范化条目数组（--exclude/--path 契约）。返回值是**条目数组**；把数组按逗号
 *  拼接成 flag 值由调用点负责（lib/cli.ts 的 `shq(excludes.join(","))`）。
 *  元素类型严格：`value.map(String)` 会把对象变成 `[object Object]` 静默混入
 *  模式串（过滤条件失效 = 审查范围被扩大），故非字符串元素一律抛错。
 *  防注入由调用点 shq() 兜底。 */
export function commaList(
  value: unknown,
  name: string,
  limit: number,
  messages: OcrReviewMessages,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return takeTrimmedItems(listSourceItems(value, name, messages), name, limit, messages);
}

const REVIEW_OUTPUT_FORMATS = ["json", "text", "sarif"] as const;
export type ReviewOutputFormat = (typeof REVIEW_OUTPUT_FORMATS)[number];

/**
 * `--format` 白名单钳制（命令注入防线）。
 *
 * 为什么必须白名单：format 不在任何工具的 parameters schema 里（模型传不进、
 * 但 PTC/直连调用方能传），而宿主对工具入参零校验；构造出的命令串最终会被
 * `wrapWithHostReaper` 塞进 `bash -c '<inner>'`。历史上这里是裸拼接
 * （`parts.push("--format", args.format ?? "json")`），实测
 * `format: "json; touch /tmp/PWNED; echo"` 可在宿主进程内任意执行命令。
 * 转义不是修复——一个「本该只有三个取值的枚举」出现任意字符串就是攻击意图，
 * 一律回落到默认值，绝不进入命令串。
 */
export function resolveOutputFormat(value: unknown): ReviewOutputFormat {
  // 形参名不叫 format：那会与消息表的 format() 插值函数同名（no-shadow）。
  const matched = REVIEW_OUTPUT_FORMATS.find((candidate) => candidate === value);
  return matched ?? "json";
}
