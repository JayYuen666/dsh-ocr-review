import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
//
// coverageInclude 是 100% 阈值的**分母声明**，刻意只有 host.ts + lib/**，两块缺席各有说明：
// · src/**：client 半经 bundle 与设置卡用例覆盖（v8 看不到浏览器执行面），README 与本注释
//   双写这一口径。
// · scripts/get-cred.mjs：test/get-cred.test.ts 以**子进程 spawn** 驱动它（api_key_cmd 的
//   契约就是「另起进程看 stdout/exit code」），v8 覆盖率只统计本进程内的执行，把脚本纳入
//   include 只会得到一张 0% 的假红。它的行为门禁在进程级用例里，不在覆盖率门里。
export default definePackageConfig({
  coverageInclude: ["host.ts", "lib/**/*.ts"],
});
