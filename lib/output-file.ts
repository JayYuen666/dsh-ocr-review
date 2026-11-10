/** `--output` 落盘结果的读取与失败详情拼接。
 *
 *  从 host.ts 拆出来的理由只有一个：`host.ts` 顶着本仓 lint 的 2000 行上限，而这几位
 *  都不碰宿主服务（只读文件、拼文案），搬走不影响任何接线。语义与报错文案一字未改。
 */
import { readFileSync, statSync } from "node:fs";

import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { truncateEnd } from "@jayyuen66/dsh-plugin-shared/lib/text";

import { format } from "./messages.ts";
import { redactKeyMaterial } from "./output.ts";
import { parseReviewOutput } from "./parse.ts";
import type { OcrReviewMessages } from "./messages.ts";

/** `--output` 写到磁盘结果的读取上限（字节）。**刻意不取 STDOUT_MAX_BYTES**：`--output`
 *  存在的理由正是「结果比 stdout 缓冲大」，用 400 KB 卡它等于把正常的大仓评审判死。
 *  这一枚只是护栏，把「整份读进内存」的失败形态从 OOM 换成一条点名文件的错误。 */
const OUT_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** 回显给模型的原始内容：先脱敏再截断（顺序不能反，反了会把密钥残尾留在回执里）。 */
export function echoRaw(text: string, limit: number): string {
  return redactKeyMaterial(truncateEnd(text, limit));
}

/** 读 --output 写到磁盘结果。OCR exit 0 却没写出文件（版本漂移/被中途 kill）时给
 *  可行动的错误，而不是把一条没有路径信息的 ENOENT 栈丢给模型。 */
export function readOutFile(outPath: string, messages: OcrReviewMessages): string {
  let size = 0;
  try {
    ({ size } = statSync(outPath));
  } catch {
    // 读不到大小：读文件那一步会给出同一条可行动错误，这里不重复造文案。
  }
  if (size > OUT_FILE_MAX_BYTES) {
    throw new Error(
      format(messages.outputFileTooLarge, {
        path: outPath,
        size: String(size),
        limit: String(OUT_FILE_MAX_BYTES),
      }),
    );
  }
  try {
    return readFileSync(outPath, "utf8");
  } catch (error) {
    throw new Error(
      format(messages.outputFileMissing, { path: outPath, cause: errorText(error) }),
      { cause: error },
    );
  }
}

/** 非零退出时把已发布 manifest 的 coverage.failed 明细附到失败详情上。
 *
 *  这里刻意不复用 `readOutFile`：那条路会给「文件缺失/过大」抛错，而失败详情里再加一层
 *  「读不到写到磁盘结果」的错误只会盖住 OCR 自己的报错。 */
export function withCoverageDetail(
  error: unknown,
  outPath: string,
  messages: OcrReviewMessages,
): unknown {
  let text: string;
  try {
    text = readFileSync(outPath, "utf8");
  } catch {
    return error;
  }
  const items = parseReviewOutput(text, messages).coverage?.failedItems ?? [];
  if (items.length === 0) {
    return error;
  }
  const note = format(messages.failureCoverage, {
    items: redactKeyMaterial(items.join("; ")),
  });
  return new Error(`${errorText(error)}${note}`, { cause: error });
}
