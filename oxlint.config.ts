import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // node/no-sync 的例外按文件声明，两组各有唯一出处：
  // · lib/config-store.ts：.bak 备份按 0600 直接创建（writeFileSync）并先清旧备份
  //   （rmSync）；运行时正式写盘一律走 @deepseek-ai/dsh-atomic-write 的异步面。
  // · host.ts：mkdtempSync 造临时目录、rmSync 在 finally 里回收——review/scan 预览、
  //   后台作业输出、session export 的落盘目录，共六对调用点。这两枚是**生产**调用，
  //   不要去 test/ 里找它们（此前的注释这样写，等于让读者以为生产面是干净的）。
  // 仅测试用：mkdirSync / writeFileSync / truncateSync 只出现在 test/ 的夹具里（造目录、
  // 写 fixture、截出稀疏文件）。名单按 files 生效，越界落点由 lint 直接判红；
  // test/write-surface.test.ts 另外核两件 lint 管不到的事：名单里每个名字都还在语料里
  // 出现（改名不会留下死豁免），以及 build-*.mjs 那批脚本的落点——那批文件被
  // SCRIPTS_OVERRIDES 整条关掉 node/no-sync，lint 在那里不给这条判据。
  syncIoScopes: [
    { files: ["lib/config-store.ts"], apis: ["rmSync", "writeFileSync"] },
    { files: ["host.ts"], apis: ["mkdtempSync", "rmSync"] },
    {
      files: ["test/**"],
      apis: ["mkdirSync", "mkdtempSync", "rmSync", "truncateSync", "writeFileSync"],
    },
  ],
  // 测试标题的前缀白名单：只放真正的技术名，且必须是**裸标识符**——共享基线
  // （config/oxlint.base.ts）带一条自检，带空格/点/通配的前缀会被当成配置错误当场拒绝
  // （原文：assertionHelpers / titlePrefixes 只收裸标识符，不接受通配或带点形式），
  // 所以「窄到带词边界」这条路走不通；测试标题宁可改写成不触发这条判据。
  // 匹配语义（上游 eslint-plugin-vitest 的 prefer-lowercase-title 实现，实测）：大小写
  // 敏感的**字符串前缀**，startsWith 一命中就把整条标题免检，不按词边界——只写
  // "Provider" 时 "Providers are broken" 会被整条豁免。因此本表只收全大写常量
  // （HOME / NUL / PATH：它们不是英文句子的开头），组件名/字段名一类改为让标题以
  // 小写词或中文开头（见 client-card / host 用例）。要加新前缀先在这里说明为何它不会
  // 顺带放过一句英文。
  titlePrefixes: ["HOME", "NUL", "PATH"],
});
