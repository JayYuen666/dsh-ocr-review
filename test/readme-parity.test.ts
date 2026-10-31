// README 双语结构闸：README.md 与 README.zh-CN.md
// 是同一份事实的两语投影——工具清单、Remote 方法名、部署级键、第三方声明引用与章节结构一旦
// 单侧漂移，读另一侧的人拿到的是过时的契约。这里不比对措辞（翻译本来就不逐字），只比对结构。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_OCR_CLI_VERSION } from "../lib/cli.ts";

const pkgDir = path.join(import.meta.dirname, "..");

const README_FILES = {
  en: "README.md",
  zh: "README.zh-CN.md",
} as const;

/** 两侧都必须出现的工具名（模型面的全部入口）。 */
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
 * 两侧都必须逐条点名的读/写方法（对外契约面）。刻意数方法名而不是数总数：少写一行的症状
 * 是「读文档的人以为没有这个方法」，而总数断言在同侧既漏写又补上一句别处引用时正好相互抵消。
 * 带括号的写法是门槛的一部分：裸 `providers` 这种子串在别的句子里也会出现，数不出契约面。
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

  it("全部工具名两侧都在（模型面契约不许单语失明）", async () => {
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
    expect(
      existsSync(path.join(pkgDir, "THIRD_PARTY_NOTICES.md")),
      "THIRD_PARTY_NOTICES.md 不在盘上",
    ).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files, "THIRD_PARTY_NOTICES.md 必须随包发布").toContain(
      "THIRD_PARTY_NOTICES.md",
    );
  });
});
