/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。
 *  与 build-client.mjs 的实际导出逐项对齐：它只转出 buildClient。 */
export function buildClient(): Promise<string>;
