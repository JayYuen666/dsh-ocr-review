import type { OxfmtConfig } from "oxfmt";

// 本包对共享 oxfmt 基线的唯一差异面，选项名经 OxfmtConfig 固化：拼写错会被 tsc
// （tsconfig.json 的 include 含本文件）当场红，而不是被 oxfmt 静默忽略、拖到 fmt:check
// 才以「文件未格式化」的形态暴露。
//
// `**/*.md`：两份 README 是双语对照的同源文档（test/readme-parity.test.ts 钉着结构），
// 排版按语义断行，交给格式化器重排会把两侧改得各自「正确」而语义注释错位，故整类排除。
// `**/*.jsonc`：注释型 JSON 不在 oxfmt 的稳定格式化范围。
// `host.js` / `client.js`：rolldown 产物，格式由打包器决定。oxfmt 默认尊重 .gitignore，
// 而这两份在 .gitignore 里，本就扫不到；这里再显式列一遍，是为了让「产物不进格式化面」
// 不依赖 .gitignore 的状态（产物改为入库时这层仍然成立）。
export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc", "host.js", "client.js"],
} satisfies OxfmtConfig;
