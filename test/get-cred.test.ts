// scripts/get-cred.mjs 的进程级测试：它就是 OCR 那一侧的 api_key_cmd，
// 只能按「另起进程 → 看 stdout/exit code」的契约来验。
//
// 重点验的是**不写死路径**之后的数据目录优先级（参数 > $DSH_HOME > homedir()/.dsh）
// 与三层取值顺序（进程环境 > 托管 .credentials.yaml > $DSH_HOME/.env）：
// 这三条正是本包从「手解宿主文件」改成「官方通道」之后，脚本必须继续对齐的规则。
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(path.dirname(import.meta.dirname), "scripts", "get-cred.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 以当前环境为底，覆盖指定项（值为 undefined 即从结果里剔除该键）。 */
function envFor(overrides: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...overrides };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function runCred(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: envFor(env) });
  let stdout = "";
  let stderr = "";
  // 没传 `stdio` ⇒ spawn 的返回类型是 `ChildProcessWithoutNullStreams`，`stdout`/`stderr`
  // 按官方 @types/node 恒为 Readable（`?.` 在这里是恒真守卫，不是缺流兜底）。
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // events.once 在子进程发 error 事件时会 reject，等价于原先显式的 error 监听。
  const closeArgs: unknown[] = await once(child, "close");
  const [exitCode] = closeArgs;
  const code: number | null = typeof exitCode === "number" ? exitCode : null;
  return { stdout, stderr, code };
}

const ROOT = mkdtempSync(path.join(tmpdir(), "ocr-get-cred-"));

/** 造一个数据目录：写 .credentials.yaml / .env（传 undefined 即不写该文件）。 */
function homeWith(contents: { credentialsYaml?: string; dotEnv?: string }): string {
  const home = mkdtempSync(path.join(ROOT, "home-"));
  if (contents.credentialsYaml !== undefined) {
    writeFileSync(path.join(home, ".credentials.yaml"), contents.credentialsYaml);
  }
  if (contents.dotEnv !== undefined) {
    writeFileSync(path.join(home, ".env"), contents.dotEnv);
  }
  return home;
}

const DOC = 'version: 1\nrefs:\n  OCR_TEST_KEY: sk-from-managed-doc\n  OCR_BLANK_KEY: ""\n';

/** DOC 里 OCR_TEST_KEY 那一条按 stdout 应有的样子（脚本逐行打印 ⇒ 带换行）。
 *  三条「从哪一层取到 key」的用例都断这同一个值，抽出来免得改 DOC 时漏改断言。 */
const MANAGED_DOC_STDOUT = "sk-from-managed-doc\n";

describe("get-cred.mjs（OCR api_key_cmd 入口）", () => {
  // 每个用例从空的 ROOT 开始（用例里自建 home-*），整文件跑完再删掉整个临时目录。
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("托管文档 YAML 非法 ⇒ stderr 只有 reason + 行列，不带出原文里的明文 key", async () => {
    // js-yaml 的 YAMLException 有两条路会把 mark.snippet（出错点邻域的**原文**）附在
    // 文本后面：构造函数里的 this.message，以及 compact 为假时的 toString()。而
    // refs.<REF> 里放的就是明文 key——修复前一处缩进笔误就把邻近行的真实 key 写进了
    // stderr（OCR 会记录 api_key_cmd 的 stderr，也可能进宿主日志）。
    const secret = "sk-FAKE-SECRET-ABC123";
    const broken = `version: 1\nrefs:\n  OCR_TEST_KEY: ${secret}\n   OCR_OTHER: oops\n`;
    const home = homeWith({ credentialsYaml: broken });
    const res = await runCred(["OCR_TEST_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/不是合法 YAML/u);
    expect(res.stderr).not.toContain(secret);
    // 定位信息不能跟着一起丢：紧凑形态仍带 line:column
    expect(res.stderr).toMatch(/\(\d+:\d+\)/u);
  });

  it("数据目录是相对路径 ⇒ 直接非零退出，不去读被审查仓库下的 .dsh", async () => {
    // 本脚本的 cwd 是 OCR 当时所在的那个仓库。相对路径会被解析成 <被审查仓库>/.dsh/…，
    // 那正是文件头声明要避免的「拿被审查仓库里的文件当用户凭据」；猜不出用户指的是
    // 哪个目录就不猜，而不是照着 cwd 拼一个出来。
    const res = await runCred(["OCR_TEST_KEY", "relative/.dsh"], {
      HOME: ROOT,
      DSH_HOME: undefined,
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("必须是绝对路径");
  });

  it("非法 ref 名直接拒绝，不读任何文件", async () => {
    const res = await runCred(["bad;rm -rf"], { HOME: ROOT, DSH_HOME: undefined });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/非法 env key 名/u);
  });

  it("第三参数指定数据目录 ⇒ 从该目录的托管文档取 key", async () => {
    const home = homeWith({ credentialsYaml: DOC });
    const res = await runCred(["OCR_TEST_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(MANAGED_DOC_STDOUT);
  });

  it("无第三参数时按 $DSH_HOME 定位数据目录", async () => {
    const home = homeWith({ credentialsYaml: DOC });
    const res = await runCred(["OCR_TEST_KEY"], { HOME: ROOT, DSH_HOME: home });
    expect(res.stdout).toBe(MANAGED_DOC_STDOUT);
  });

  it("参数与 $DSH_HOME 都没有 ⇒ 落到 homedir()/.dsh（不再写死 ~/.dsh）", async () => {
    const parent = homeWith({});
    const dotDsh = path.join(parent, ".dsh");
    mkdirSync(dotDsh, { recursive: true });
    writeFileSync(path.join(dotDsh, ".credentials.yaml"), DOC);
    const res = await runCred(["OCR_TEST_KEY"], { HOME: parent, DSH_HOME: undefined });
    expect(res.stdout).toBe(MANAGED_DOC_STDOUT);
  });

  it("进程环境优先于托管文档（对齐官方 env 层最高的规则）", async () => {
    const home = homeWith({ credentialsYaml: DOC });
    const res = await runCred(["OCR_TEST_KEY", home], {
      HOME: ROOT,
      DSH_HOME: undefined,
      OCR_TEST_KEY: "sk-from-process-env",
    });
    expect(res.stdout).toBe("sk-from-process-env\n");
  });

  it("托管文档没有该 ref ⇒ 回退 $DSH_HOME/.env（含 export 前缀与引号）", async () => {
    const home = homeWith({ dotEnv: 'export OCR_TEST_KEY="sk-from-dot-env"\nOTHER=1\n' });
    const res = await runCred(["OCR_TEST_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(res.stdout).toBe("sk-from-dot-env\n");
  });

  it("空值按未配置处理，并给出查过哪几层的可行动错误", async () => {
    const home = homeWith({ credentialsYaml: DOC });
    const res = await runCred(["OCR_BLANK_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/取不到 OCR_BLANK_KEY/u);
    expect(res.stderr).toMatch(/\.credentials\.yaml/u);
  });

  it("托管文档坏 YAML ⇒ 继续找 .env；两边都不成时把坏消息一起报出", async () => {
    const home = homeWith({ credentialsYaml: "version: 1\nrefs: [oops\n" });
    const missing = await runCred(["OCR_TEST_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/不是合法 YAML/u);
    writeFileSync(path.join(home, ".env"), "OCR_TEST_KEY=sk-after-bad-doc\n");
    const rescued = await runCred(["OCR_TEST_KEY", home], { HOME: ROOT, DSH_HOME: undefined });
    expect(rescued.stdout).toBe("sk-after-bad-doc\n");
  });
});
