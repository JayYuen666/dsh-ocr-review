// README 双语结构闸：README.md 与 README.zh-CN.md
// 是同一份事实的两语投影——工具清单、端点路径、部署级键、第三方声明引用与章节结构一旦
// 单侧漂移，读另一侧的人拿到的是过时的契约。这里不比对措辞（翻译本来就不逐字），只比对结构。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

const README_FILES = {
  en: "README.md",
  zh: "README.zh-CN.md",
} as const;

/** 两侧都必须出现的工具名（模型面契约的五个入口）。 */
const TOOL_NAMES = [
  "ocr_review",
  "ocr_scan",
  "ocr_delegate_preview",
  "ocr_delegate_rule",
  "ocr_session",
] as const;

/** 两侧都必须点名的部署级键：导出 `Config` 上那些**不进设置卡**的非 volatile 字段
 *  （前三枚是调优值，第四枚是「一条运行能不能改动这台机器」的部署决策）。 */
const DEPLOYMENT_KEYS = [
  "llmTestTimeoutMs",
  "ocrBackgroundMaxMs",
  "stdoutMaxBytes",
  "ocrNoAutoUpdate",
] as const;

/**
 * 两侧都必须逐条点名的端点路径（对外契约面）。刻意数路径而不是数总数：少写一行的症状
 * 是「读文档的人以为没这条路」，而总数断言在同侧既漏写又补上一句别处引用时正好相互抵消。
 */
const ENDPOINT_PATHS = [
  "/_dsh/ocr-review/providers",
  "/_dsh/ocr-review/select",
  "/_dsh/ocr-review/migrate",
  "/_dsh/ocr-review/test",
  "/_dsh/ocr-review/probe",
] as const;

/**
 * 读某一侧的 README 全文。
 *
 * @param which - 语言侧（键即 README_FILES 的键）
 * @returns 文件全文
 */
async function readReadme(which: keyof typeof README_FILES): Promise<string> {
  return readFile(path.join(pkgDir, README_FILES[which]), "utf8");
}

describe("readme 双语结构", () => {
  it("两侧互链（英链中、中链英），且两个文件都在盘上", async () => {
    const en = await readReadme("en");
    const zh = await readReadme("zh");
    expect(en).toContain("README.zh-CN.md");
    expect(zh).toContain("README.md");
  });

  it("两侧 `##` 章节数一致（单侧加章节必须在另一侧补齐）", async () => {
    const counts = await Promise.all(
      (Object.keys(README_FILES) as (keyof typeof README_FILES)[]).map(async (which) => {
        const text = await readReadme(which);
        return text.split("\n").filter((line) => line.startsWith("## ")).length;
      }),
    );
    expect(counts[0], `两侧章节数不一致：${counts.join(" vs ")}`).toBe(counts[1]);
  });

  it("五个工具名两侧都在（模型面契约不许单语失明）", async () => {
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

  it("五条端点路径两侧都在（对外契约面不许单语失明）", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    for (const route of ENDPOINT_PATHS) {
      expect(texts.en, `README.md 缺端点 ${route}`).toContain(route);
      expect(texts.zh, `README.zh-CN.md 缺端点 ${route}`).toContain(route);
    }
  });

  it("第三方声明两侧都引用、文件在盘上且在 files 里", async () => {
    const texts = {
      en: await readReadme("en"),
      zh: await readReadme("zh"),
    } as const;
    expect(texts.en, "README.md 没有指向第三方声明").toContain("THIRD_PARTY_NOTICES");
    expect(texts.zh, "README.zh-CN.md 没有指向第三方声明").toContain("THIRD_PARTY_NOTICES");
    const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files, "THIRD_PARTY_NOTICES.md 必须随包发布").toContain(
      "THIRD_PARTY_NOTICES.md",
    );
  });
});
