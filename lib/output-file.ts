/** `--output` 落盘结果的读取与失败详情拼接。
 *
 *  从 host.ts 拆出来的理由只有一个：`host.ts` 顶着本仓 lint 的 2000 行上限，而这几位
 *  都不碰宿主服务（只读文件、拼文案），搬走不影响任何接线。语义与报错文案一字未改。
 */
import { readFileSync, statSync } from "node:fs";

import type { ShellRunResult } from "@deepseek-ai/dsh-shell";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { truncateEnd, truncateStart } from "@jayyuen66/dsh-plugin-shared/lib/text";

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

/** 静默读取 `--output`（前台非零退出的 partial 收尾专用）：读不到或超过 {@link OUT_FILE_MAX_BYTES}
 *  都返回 null，把「怎么收尾」的决定留给调用方——它兜不住时仍要落到 {@link withCoverageDetail}。
 *  刻意与 {@link readOutFile} 分开：那条路给「文件缺失/过大」抛错，而 partial 收尾对读不到
 *  的正确反应是维持原错误，不是再抛一条新的把真因盖住。 */
export function readOutFileSilent(outPath: string): string | null {
  try {
    if (statSync(outPath).size > OUT_FILE_MAX_BYTES) {
      return null;
    }
    return readFileSync(outPath, "utf8");
  } catch {
    return null;
  }
}

/** 非零退出时把已发布 manifest 的 coverage.failed 明细附到失败详情上。
 *
 *  OCR 1.13.12 起（review_cmd.go 的 reviewManifestRequiresNonZeroExit）部分失败也退非零，
 *  但结果照常发布：有可用覆盖的 partial 由 foreground-summary.ts 的收尾交回摘要，只有
 *  拿不出可用覆盖（解析失败、全场失败、coverage 缺席）时才落到这条路径。
 *
 *  这里刻意不复用 `readOutFile`：那条路会给「文件缺失/过大」抛错，而失败详情里再加一层
 *  「读不到写到磁盘结果」的错误只会盖住 OCR 自己的报错。缺失/超限/读不动都原样交回
 *  原错误——size 闸与 {@link readOutFile} 是同一枚上限，失败详情路径同样不许整份读进
 *  内存（OUT_FILE_MAX_BYTES 的护栏意图不分成败两条路）。 */
export function withCoverageDetail(
  error: unknown,
  outPath: string,
  messages: OcrReviewMessages,
): unknown {
  let text: string;
  try {
    if (statSync(outPath).size > OUT_FILE_MAX_BYTES) {
      return error;
    }
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

// 每个工具失败回执里的人读详情都从这里出（host.ts 的 runForeground 是唯一调用点）。

/** OCR 的 resume 拒绝文案都以此开头（`internal/session/resume_identity.go` 的
 *  十几条 `resume rejected: …` 与 `resume session %q …`）。只认这一族前缀，
 *  其余英文错误原样带回——把不认识的失败也翻译掉，等于让模型读不到真正的原因。 */
const RESUME_REJECTED = /^resume (?:rejected:|session )/mu;

/** 失败详情：stderr 优先、空则退 stdout；先脱敏再截断（明文 key 绝不进工具错误
 *  ——错误文本会被持久化进会话日志）。省略标记是文案，故脱敏与截断的位置不变，
 *  只把中间的连接标记换成当前语言的那一份。两半各用一个函数，因为它们是两种缺陷：
 *  前切点会留下孤立**高**代理（`truncateEnd` 丢掉它），后切点会留下孤立**低**代理
 *  （`truncateStart` 丢掉它）。把两个函数对调同样不留孤立代理，只是头尾内容掉头
 *  ——所以 test/host.test.ts 里另有一组哨兵断言钉住这个顺序。 */
export function failureDetail(result: ShellRunResult, messages: OcrReviewMessages): string {
  const raw = result.stderr.text === "" ? result.stdout.text : result.stderr.text;
  const detail = redactKeyMaterial(raw);
  // 恢复被拒是**唯一**需要本地化的一条：workspace 恢复自 1.13.10 起由 OCR 自己按
  // identity 判（HEAD 或未提交改动变了就拒），它回的是英文长句且带 `start a new
  // review instead of resuming` 尾巴。翻译只做这一族，原文一并附在后面供排障。
  if (RESUME_REJECTED.test(detail.trim())) {
    return `${messages.resumeRejected}${messages.detailSeparator}${detail.trim()}`;
  }
  return detail.length <= 800
    ? detail
    : `${truncateEnd(detail, 400)}${messages.middleEllipsis}${truncateStart(detail, 400)}`;
}
