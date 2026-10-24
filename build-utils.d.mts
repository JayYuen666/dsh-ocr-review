/** build-utils.mjs 的声明（供 build-client.mjs / build-host.mjs 与 TS 侧测试类型化导入）。 */

/** rolldown 输出项的最小投影。 */
export interface OutputItem {
  readonly type: string;
  readonly fileName: string;
  readonly code?: string;
  readonly isEntry?: boolean;
}

/** 单文件产物只接受一个带正文的 entry chunk；否则抛错。 */
export function singleEntryChunk(
  output: readonly OutputItem[],
  source: string,
): OutputItem & { code: string };

/** 同目录临时文件 + rename 的原子落盘；失败时清临时文件并把 target 带进错因。 */
export function writeArtifact(target: string, text: string): Promise<void>;

/** argv[1] 与本文件按 realpath 逐字比；本文件自身解析失败时抛错。 */
export function invokedDirectly(moduleFile: string): boolean;
