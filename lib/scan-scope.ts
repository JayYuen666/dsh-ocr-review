// lib/scan-scope.ts —— ocr_scan 的 repo 规范化后，把 path/exclude 从原始目录重基到顶层。
//
// 为什么单独一层：host.ts 贴着 max-lines 上限，而这些都是纯字符串运算；独立出来也让
// “范围不变”的规则可以逐条用单测钉住（工具级用例只覆盖得到最常用的一两条）。

import path from "node:path";

/** 仓库相对选择器统一用 `/`：OCR 的 scan provider 先 `filepath.ToSlash`，再与
 *  `git ls-files` 输出的 `/` 路径做前缀匹配（provider.go 的 NewProvider）；exclude
 *  模式也按 `/` 匹配。绝对路径保持平台原生形态，与本包其它绝对路径参数一致。 */
function repoRelative(value: string): string {
  return value.split(path.sep).join("/");
}

/** target 是否落在 root 内（含相等）。两者都应是绝对路径。 */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 单条 scan path 从 from 根重基到 to 根；逃出 to 的条目保留绝对路径，语义不丢。
 *  空串由调用方先滤掉，这里不再重复判。 */
function rebaseScanPathItem(item: string, from: string, to: string): string {
  const absolute = path.isAbsolute(item) ? item : path.resolve(from, item);
  const relative = path.relative(to, absolute);
  if (relative === "") {
    return ".";
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolute;
  }
  return repoRelative(relative);
}

/** path 入参（数组或逗号串）整体重基；全空时补上原目录，保持扫描范围不变。 */
function rebaseScanPaths(value: unknown, from: string, to: string, prefix: string): unknown {
  // 没给 path = 扫整个 repo；规范化到顶层后必须补回原目录，否则范围扩到整个 monorepo。
  if (value === undefined || value === null) {
    return [repoRelative(prefix)];
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return items.length === 0
      ? [repoRelative(prefix)]
      : items.map((item) => rebaseScanPathItem(item, from, to));
  }
  if (Array.isArray(value)) {
    const raw: unknown[] = value;
    // 非字符串元素原样交回，让 buildScanCommand 的 commaList 抛出它自己的类型错误。
    if (raw.some((item) => typeof item !== "string")) {
      return value;
    }
    const items = raw
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => rebaseScanPathItem(item, from, to));
    return items.length === 0 ? [repoRelative(prefix)] : items;
  }
  return value;
}

/** exclude 模式整体加原目录前缀；doublestar 的匹配对“模式与路径同时加同一前缀”不变。
 *  模式串一律用 `/`（OCR 的 scan provider 把候选路径 ToSlash），Windows 前缀也转过去。 */
function rebaseScanExcludes(value: unknown, prefix: string): unknown {
  const slashPrefix = prefix.split(path.sep).join("/");
  const rebase = (pattern: string): string => {
    const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    return `${slashPrefix}/${body}`;
  };
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => rebase(item))
      .join(",");
  }
  if (Array.isArray(value)) {
    const raw: unknown[] = value;
    if (raw.some((item) => typeof item !== "string")) {
      return value;
    }
    return raw
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => rebase(item));
  }
  return value;
}

/**
 * scan 的 repo 规范化：workdir 用 git 顶层（会话目录由它编码），但把
 * path/exclude 从模型给的原始目录重基过去，扫描范围与排除语义保持不变。
 *
 * 为什么 scan 也要规范化：OCR 的 scan 与 review 一样会创建会话，会话目录按 RepoDir
 * 编码；从子目录发起 scan 时若保留 CWD，`ocr_session`（总按 git 顶层查询）永远列不到
 * 这条会话。范围由 path 重基来保持，而不是靠 CWD。
 *
 * @param args - 原始工具入参（只读）
 * @param from - 模型给的原始 repo（realpath 后）
 * @param repo - 规范化后的执行根（git 顶层；调用方保证 from 在它内部）
 * @returns 重基后的新参数；from 与 repo 相同时原样返回
 */
export function rebaseScanScope(
  args: Record<string, unknown>,
  from: string,
  repo: string,
): Record<string, unknown> {
  if (from === repo) {
    return args;
  }
  const prefix = path.relative(repo, from);
  if (
    prefix === "" ||
    prefix === ".." ||
    prefix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(prefix)
  ) {
    // 原始目录不在规范化根内：保持原参数，宁可少一次归一化也不静默改范围。
    return args;
  }
  return {
    ...args,
    // rule 仍按模型当初指定的 repo 解析；命令的 workdir 已经是顶层。
    fileRoot: from,
    path: rebaseScanPaths(args["path"], from, repo, prefix),
    ...(args["exclude"] === undefined || args["exclude"] === null
      ? {}
      : { exclude: rebaseScanExcludes(args["exclude"], prefix) }),
  };
}
