// README 双语结构闸：README.md 与 README.zh-CN.md
// 是同一份事实的两语投影——工具清单、Remote 方法名、部署级键、第三方声明引用与章节结构一旦
// 单侧漂移，读另一侧的人拿到的是过时的契约。这里不比对措辞（翻译本来就不逐字），只比对结构。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_OCR_CLI_VERSION } from "../lib/cli.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 这条门禁要读的 manifest 部分：宿主窗口和开发基线都从这两张表取值。 */
interface ManifestShape {
  readonly engines?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const README_FILES = {
  en: "README.md",
  zh: "README.zh-CN.md",
} as const;

const DETAIL_FILES = {
  en: "docs/DETAIL.md",
  zh: "docs/DETAIL.zh.md",
} as const;

const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
const MANIFEST_FILE = "package.json";
const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** 两侧都必须出现的工具名（模型可见的全部入口）。 */
const TOOL_NAMES = [
  "ocr_review",
  "ocr_scan",
  "ocr_delegate_preview",
  "ocr_delegate_rule",
  "ocr_session",
  "ocr_rules_check",
  "ocr_llm",
] as const;

/** 两侧都必须点名的部署级键：导出 `Config` 上那些**不进设置卡**的非 volatile 字段
 *  （调优值，以及「一条运行能不能改动这台机器」的部署决策）。 */
const DEPLOYMENT_KEYS = [
  "llmTestTimeoutMs",
  "startupVerify",
  "ocrBackgroundMaxMs",
  "stdoutMaxBytes",
  "ocrNoAutoUpdate",
  "ocrInstallHint",
] as const;

/**
 * 两侧都必须逐条点名的读/写方法（对外声明的那组方法）。刻意数方法名而不是数总数：少写一行的症状
 * 是「读文档的人以为没有这个方法」，而总数断言在同一份文档里既漏写又补上一句别处引用时正好相互抵消。
 * 带括号的写法是这条门槛的要求：不带括号的 `providers` 这种子串在别的句子里也会出现，就数不出这条契约。
 */
const REMOTE_METHODS = [
  "providers()",
  "select(request)",
  "migrate()",
  "test()",
  "probe()",
  "mcp()",
  "saveMcp(request)",
  "auth()",
  "chatGpt(request)",
] as const;

/** 两侧都必须写明的 Remote 命名空间（卡片按 `remote.<它>` 取服务，写错一侧就没人能连上）。 */
const REMOTE_NAMESPACE = "ocrReview";

/**
 * 读某一侧的 README 全文。
 *
 * @param which - 语言侧（键即 README_FILES 的键）
 * @returns 文件全文
 */
async function readReadme(which: keyof typeof README_FILES): Promise<string> {
  return readFile(path.join(pkgDir, README_FILES[which]), "utf8");
}

/**
 * `##` 章节的语言无关标识：标题里那枚 lucide 图标名。两语标题文字不同，图标是同一份结构
 * 标记——顺序、增删都在它上面看得到；只数条数时「删一章又加一章」正好相互抵消。
 *
 * @param text - README 全文
 * @returns 每个 `##` 章节的图标名（无图标时为空串）
 */
function sectionIcons(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => /lucide\/(?<icon>[\w-]+)\.svg/u.exec(line)?.groups?.["icon"] ?? "");
}

describe("readme 双语结构", () => {
  it("两侧互链（英链中、中链英），且两个文件都在盘上", async () => {
    const en = await readReadme("en");
    const zh = await readReadme("zh");
    expect(en).toContain("README.zh-CN.md");
    expect(zh).toContain("README.md");
  });

  it("两侧 `##` 章节的图标序列一致（单侧增删或换序都会红）", async () => {
    const [en, zh] = await Promise.all([readReadme("en"), readReadme("zh")]);
    expect(sectionIcons(en), "两侧章节图标序列不一致").toStrictEqual(sectionIcons(zh));
  });

  it("全部工具名两侧都在（模型可见契约不许单语失明）", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    for (const tool of TOOL_NAMES) {
      expect(texts.en, `README.md 缺工具名 ${tool}`).toContain(tool);
      expect(texts.zh, `README.zh-CN.md 缺工具名 ${tool}`).toContain(tool);
    }
  });

  it("部署级键两侧都在（只走 config: 行的那几张契约面）", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    for (const key of DEPLOYMENT_KEYS) {
      expect(texts.en, `README.md 缺部署键 ${key}`).toContain(key);
      expect(texts.zh, `README.zh-CN.md 缺部署键 ${key}`).toContain(key);
    }
  });

  it("全部 Remote 方法与命名空间两侧都在（对外契约面不许单语失明）", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    for (const method of REMOTE_METHODS) {
      expect(texts.en, `README.md 缺方法 ${method}`).toContain(method);
      expect(texts.zh, `README.zh-CN.md 缺方法 ${method}`).toContain(method);
    }
    for (const [which, text] of Object.entries(texts)) {
      expect(text, `${which} 侧没写命名空间 ${REMOTE_NAMESPACE}`).toContain(REMOTE_NAMESPACE);
    }
  });

  it("两侧都写明核对所依据的外部 CLI 版本（装法建议与代码常量同源）", async () => {
    // README 是用户挑安装命令时读的那一份。它写的版本与代码里核对用的那一版不是一版时，
    // 用户照着装完就永远收到「实测与核对版本不一致」，而两边文档都自洽——只有并排断言才看得见。
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    for (const [which, text] of Object.entries(texts)) {
      expect(text, `${which} 侧 README 没写核对版本 ${EXPECTED_OCR_CLI_VERSION}`).toContain(
        EXPECTED_OCR_CLI_VERSION,
      );
    }
  });

  it("第三方声明两侧都引用、文件在盘上且在 files 里", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    expect(texts.en, "README.md 没有指向第三方声明").toContain("THIRD_PARTY_NOTICES");
    expect(texts.zh, "README.zh-CN.md 没有指向第三方声明").toContain("THIRD_PARTY_NOTICES");
    expect(existsSync(path.join(pkgDir, NOTICES_FILE)), `${NOTICES_FILE} 不在盘上`).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(pkgDir, MANIFEST_FILE), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files, `${NOTICES_FILE} 必须随包发布`).toContain(NOTICES_FILE);
  });
});

describe("随包文档的版本声明同源", () => {
  /** 用户会照着挑安装命令的文件：README 两侧与两份 DETAIL。 */
  const INSTALL_DOCS = [
    README_FILES.en,
    README_FILES.zh,
    DETAIL_FILES.en,
    DETAIL_FILES.zh,
  ] as const;

  it("四份安装文档的 npm 装法都钉在 EXPECTED_OCR_CLI_VERSION", async () => {
    // 只断言「文件里出现过版本号」不够：期望版本已改、安装命令仍停在旧版时，
    // 用户照着装完就会永远收到「实测与核对版本不一致」。这里钉的是**装法那一行**。
    const docs = await Promise.all(
      INSTALL_DOCS.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const { file, text } of docs) {
      expect(text, `${file} 的安装命令没钉在核对版本 ${EXPECTED_OCR_CLI_VERSION}`).toContain(
        `@alibaba-group/open-code-review@${EXPECTED_OCR_CLI_VERSION}`,
      );
    }
  });

  it("第三方声明的两处 ocr 版本声明同源", async () => {
    const text = await readFile(path.join(pkgDir, NOTICES_FILE), "utf8");
    expect(text, "第三方声明的验证版本没跟上代码常量").toContain(
      `验证版本：${EXPECTED_OCR_CLI_VERSION}`,
    );
    expect(text, "第三方声明的运行期依赖行没跟上代码常量").toContain(
      `| \`@alibaba-group/open-code-review\` | ${EXPECTED_OCR_CLI_VERSION}（核对版本，非依赖） |`,
    );
  });

  it("第三方声明的宿主基线与 manifest / catalog 同源", async () => {
    // 这三枚是「本包按哪一版宿主核对过」的当前状态断言，不是历史读数：
    // 代码基线抬了而声明没抬时，文档会继续指向一个本包从未核对过的版本。
    const manifest = JSON.parse(
      await readFile(path.join(pkgDir, MANIFEST_FILE), "utf8"),
    ) as ManifestShape;
    const dev = manifest.devDependencies ?? {};
    const dshVersion = dev["@deepseek-ai/dsh-tools"];
    const cordisVersion = dev["@deepseek-ai/cordis"];
    const schemasteryVersion = dev["@deepseek-ai/schemastery"];
    if (
      dshVersion === undefined ||
      cordisVersion === undefined ||
      schemasteryVersion === undefined
    ) {
      throw new Error(`${MANIFEST_FILE} 的 devDependencies 缺宿主基线三枚`);
    }
    const workspace = await readFile(path.join(pkgDir, WORKSPACE_FILE), "utf8");
    const sharedVersion = /"@jayyuen66\/dsh-plugin-shared":\s*(?<version>\S+)/u.exec(workspace)
      ?.groups?.["version"];
    if (sharedVersion === undefined) {
      throw new Error(`${WORKSPACE_FILE} 的 catalog 里没有 @jayyuen66/dsh-plugin-shared`);
    }
    const text = await readFile(path.join(pkgDir, NOTICES_FILE), "utf8");
    expect(text, "第三方声明的 dsh / cordis / schemastery 基线没跟上 devDependencies").toContain(
      `本包按 dsh \`${dshVersion}\` 逐条核对过（同版的 cordis \`${cordisVersion}\` 与 schemastery \`${schemasteryVersion}\` fork 一并核对）`,
    );
    expect(text, `第三方声明的 shared catalog 版本没跟上 ${WORKSPACE_FILE}`).toContain(
      `catalog（伞根 ${sharedVersion}）`,
    );
  });

  it("两侧 README 的宿主支持窗口都来自 manifest 的 engines.dsh", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(pkgDir, MANIFEST_FILE), "utf8"),
    ) as ManifestShape;
    const window = manifest.engines?.["dsh"];
    if (window === undefined) {
      throw new Error(`${MANIFEST_FILE} 的 engines.dsh 缺失：支持窗口没有真源`);
    }
    const sides = await Promise.all(
      (Object.keys(README_FILES) as (keyof typeof README_FILES)[]).map(async (which) => ({
        which,
        text: await readReadme(which),
      })),
    );
    for (const { which, text } of sides) {
      expect(text, `${which} 侧 README 没写 engines.dsh 的窗口 ${window}`).toContain(window);
    }
  });
});
