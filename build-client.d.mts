/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。 */
export function buildClient(): Promise<string>;

/**
 * 折掉 `//#region` 行里的 pnpm store 段；产物里仍有残留时抛错。
 *
 * 导出是判据的一部分：这个函数的兜底分支（扫整份产物而不是只扫 region 行）只有直接喂
 * 输入才测得到，走 buildClient() 的话输入永远是「已经正常折叠过」的产物。
 */
export function collapseStorePaths(code: string): string;
