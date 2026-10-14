// 全局声明（tsconfig.app.json 与 tsconfig.node.json 都包含本文件）
/**
 * 应用版本号：由 vite.config.ts 的 `define` 注入（取 package.json 的 version），开发服务器 / 生产构建 / Vitest 下都有定义。
 * 其他运行环境（如直接用 tsx 运行）可能没有定义，所以类型含 undefined；代码里统一通过 src/ui/changelog.ts 的 APP_VERSION 读取。
 */
declare const __APP_VERSION__: string | undefined;
