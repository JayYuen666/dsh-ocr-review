// lib/argv-guard.ts —— 交给 `ocr` CLI 的 argv 的**唯一闸门层**：转义、绝对路径校验、
// 逗号列表规范化、枚举与数值钳制。
//
// 为什么从 lib/cli.ts 拆出来：这几族东西共同回答一个问题——「这串用户可控输入能不能进最终
// 命令」。判据本身与「命令长什么样」无关（cli.ts 的五条命令构造与回收守护只是逐槽位来问一
// 次），故与 cli.ts 分家。
//
// 报错文案双语：与 lib/cli.ts 同一口径——消息表（lib/messages.ts 的一份）由调用点作入参
// 注入，纯函数不读设置；本模块的校验文本原样回显给模型（工具失败信息）。

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
 * 绝对路径校验（macOS/Linux）：非空、trim 后以 / 开头、无 NUL 字节。
 *
 * 先 trim 再判：调用点会先 trim 再传进来，而直接调用 `args.repo` 的路径若带首尾空白，
 * 会被「必须是绝对路径」这条误导性文案拦下——读起来像是路径写错了格式，实际只是多了
 * 几个空格。顺带也挡住全空白（trim 后为空 ⇒ 触发 repoRequired）。
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
  return trimmed;
}

/** limit 非法（NaN / ≤0 / 非整数）时的保守兜底上限：宁可比调用方的意图更严。 */
const DEFAULT_LIST_LIMIT = 200;

const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** effort 参数：非法值回默认（配置/medium 由调用方决定回退），此处只钳到合法集。 */
export function clampEffort(value: unknown, fallback: Effort): Effort {
  const matched = EFFORTS.find((level) => level === value);
  return matched ?? fallback;
}

// clampPositiveInt（concurrency/timeout/maxTokens 的数值钳制）已删除：生产侧从无
// 调用方——lib/cli.ts 的对应槽位全部走 ocr 自身的默认值或 clampEffort。一个无人调用的
// 导出留着，它的"契约"只会误导后来人以为已有人在用。

/** 入参 → 原始项序列（commaList 的第一段：只判「值从哪来」，不判内容）。
 *  数组分支保留逐元素 for-of 而不是 `value.map`：map 会跳过稀疏数组的空洞，
 *  空洞本是「非字符串元素」这一条该拦的形态，跳过就等于静默少一项过滤条件。 */
function listSourceItems(value: unknown, name: string, messages: OcrReviewMessages): string[] {
  if (typeof value === "string") {
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
  for (const item of items) {
    if (item.includes("\u0000")) {
      throw new Error(format(messages.noNulBytes, { name }));
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

/** 字符串数组 → 逗号拼接（--exclude/--path 契约）。
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
