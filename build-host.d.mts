/** build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
 *  与实现的实际导出逐项对齐：它只转出 buildHost。 */

/** 生成 host.js 的完整文本。
 *  @throws 打包失败，或产物清单里没有 host.js 时 reject（调用方需 try/catch）。 */
export function buildHost(): Promise<string>;
