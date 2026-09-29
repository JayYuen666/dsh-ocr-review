// lib/argv-guard.ts —— 交给 `ocr` CLI 的 argv 的**唯一闸门层**：转义、绝对路径校验、
// 逗号列表规范化、枚举与数值钳制。
//
// 为什么从 lib/cli.ts 拆出来：这几族东西共同回答一个问题——「这串用户可控输入能不能进最终
// 命令」。判据本身与「命令长什么样」无关（cli.ts 的五条命令构造与回收守护只是逐槽位来问一
// 次），故与 cli.ts 分家；此前它们 export 只因单测也按这层边界取用，生产侧的 consumers 全在
// 同一个文件里，`fallow --production` 因此把这些导出判成「只被测试养着的导出」。
//
// 报错文案双语：与 lib/cli.ts 同一口径——消息表（lib/messages.ts 的一份）由调用点作入参
// 注入，纯函数不读设置；本模块的校验文本原样回显给模型（工具失败信息）。

import { format } from "./messages.ts";
import type { OcrReviewMessages } from "./messages.ts";

/** POSIX sh 单引号转义：' → '\''。把任意字符串安全放进单引号内，防注入。 */
export function shq(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** 绝对路径校验（macOS/Linux）：非空、以 / 开头、无 NUL 字节。 */
export function assertAbsoluteRoot(root: unknown, messages: OcrReviewMessages): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error(messages.repoRequired);
  }
  if (root.includes("\u0000")) {
    throw new Error(format(messages.noNulBytes, { name: "repo" }));
  }
  if (!root.startsWith("/")) {
    throw new Error(format(messages.repoMustBeAbsolute, { root }));
  }
  return root;
}

const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** effort 参数：非法值回默认（配置/medium 由调用方决定回退），此处只钳到合法集。 */
export function clampEffort(value: unknown, fallback: Effort): Effort {
  const matched = EFFORTS.find((level) => level === value);
  return matched ?? fallback;
}

/** 正整数钳制（concurrency/timeout/maxTokens 用，非正整数回 fallback）。 */
export function clampPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

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
  const out: string[] = [];
  for (const item of items) {
    if (item.includes("\u0000")) {
      throw new Error(format(messages.noNulBytes, { name }));
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
    if (out.length >= limit) {
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
