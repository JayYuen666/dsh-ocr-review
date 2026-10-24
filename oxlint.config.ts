import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // node/no-sync 的包内例外，按「谁用谁声明」拆成两组（共享基线不支持按目录 override，
  // 包级声明是唯一口子，所以每组各自的用途必须写在这里，免得被读成运行时全面放行）：
  // · 生产代码（lib/config-store.ts）只用 copyFileSync（.bak 备份）与 chmodSync（备份收 0600）；
  //   运行时写盘一律走 @deepseek-ai/dsh-atomic-write 的异步面。
  // · 仅测试用：mkdirSync / mkdtempSync / rmSync / writeFileSync / truncateSync 只出现在
  //   test/*.test.ts 的夹具里（造临时目录、写 fixture、截出稀疏文件）。生产代码里出现
  //   这几个名字（尤其 rmSync / truncateSync 这类破坏性调用）仍应视为待审的引入。
  syncWrites: [
    "chmodSync",
    "copyFileSync",
    "mkdirSync",
    "mkdtempSync",
    "rmSync",
    "truncateSync",
    "writeFileSync",
  ],
  // 测试标题的前缀白名单：只放真正的技术名（协议/字段名/组件名），非技术名不得借这条
  // 豁免留在标题里。中文开头的标题天然满足大小写判据，不在本表。
  titlePrefixes: ["Config", "HOME", "NUL", "PATH", "Provider", "SaveBar"],
});
