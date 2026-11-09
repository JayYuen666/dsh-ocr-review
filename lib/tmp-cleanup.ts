// lib/tmp-cleanup.ts —— session export 临时目录的 TTL 清理。
//
// 为什么单独一层：host.ts 已经贴着 max-lines 上限，而这段逻辑与工具注册无关；
// 放在这里也让“只删本包前缀、只删真实目录、失败不挡导出”这三条约束有一个独立落点。

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** session export 的临时目录前缀：清理只认本包建的目录，绝不碰 tmpdir 里的别人。 */
export const SESSION_EXPORT_PREFIX = "ocr-session-export-";
/** 导出目录的保留时长：HTML 是用户要打开/归档的产物，但临时目录不能无限增长。 */
export const SESSION_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 删除一棵目录树。做成可注入的参数：单测要用「删除必失败」的实现覆盖 catch 分支，
 *  而权限/temp 目录的删除行为在 POSIX 与 Windows 上并不一致（Windows 无 POSIX 权限位）。 */
type RemoveDirectory = (target: string) => Promise<void>;

const removeDirectory: RemoveDirectory = async (target) => {
  await rm(target, { recursive: true, force: true });
};

/**
 * 清掉 baseDir 下超过 TTL 的旧导出目录（在每次新建导出目录之前跑一次）。
 *
 * 为什么不成功即删：`sessionOutput` 交回的就是 `review.html` 的路径，删掉它等于把
 * “已导出”的回执变成一条死链。折中做法是保留 TTL：用户有足够时间打开/复制，旧目录
 * 则在后续导出时按 mtime 收走。只匹配本包前缀、只删真实目录（Dirent.isDirectory()
 * 对符号链接为 false），清理失败绝不挡住本次导出。
 *
 * @param baseDir - 临时目录根（生产为本进程的 `tmpdir()`；用例注入沙箱）
 * @param now - 当前时刻（毫秒；用例注入固定值）
 * @param ttlMs - 保留时长（毫秒）
 * @param remove - 删除实现（缺省真删；用例注入失败实现以覆盖静默跳过分支）
 * @returns 实际删除的目录数
 */
export async function sweepStaleSessionExports(
  baseDir: string,
  now: number = Date.now(),
  ttlMs: number = SESSION_EXPORT_TTL_MS,
  remove: RemoveDirectory = removeDirectory,
): Promise<number> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    // tmpdir 不存在/不可读：本次导出照常进行，清理只是顺手的事。
    return 0;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SESSION_EXPORT_PREFIX))
    .map((entry) => path.join(baseDir, entry.name));
  const removed = await Promise.all(
    candidates.map(async (dir): Promise<number> => {
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs <= ttlMs) {
          return 0;
        }
        await remove(dir);
        return 1;
      } catch {
        // 目录被另一个进程先删掉、或权限不足：下一趟再试，本次导出不受影响。
        return 0;
      }
    }),
  );
  return removed.reduce((sum, count) => sum + count, 0);
}
