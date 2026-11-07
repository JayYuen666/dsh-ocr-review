/**
 * 平台的测试替身：钉住和还原 `process.platform` 的唯一一处。
 *
 * 描述符在模块求值时取一次：`process.platform` 恒有描述符，所以不存在
 * `Object.defineProperty(process, "platform", {})` 那种把 platform 定义成
 * 不可配置的 `undefined` 的坏路——一旦发生，之后的每次钉桩都会抛 TypeError，
 * 红的是后面的套件而不是本用例。
 */
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

export function pinPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

export function restorePlatform(): void {
  if (REAL_PLATFORM !== undefined) {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
  }
}
