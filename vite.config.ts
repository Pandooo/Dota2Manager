import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 生产构建分包（不改变加载行为：这些块都是入口的静态依赖，与原先一样在首屏一并加载，只是拆成多个文件便于缓存与并行下载）：
 * - vendor：第三方库（React / zustand …）与打包器运行时辅助模块；
 * - data：静态数据（tis / patches / heroes / playerIndex / tournaments），版本更新时与代码分别缓存；
 * - engine：游戏引擎（src/engine）与前后端共享协议（src/shared，引擎的 multi.ts 引用 RPC 白名单）；
 * - 主包只留界面与 store。
 * 阵容数据 src/data/rosters/ti*.json 由 import.meta.glob 按 TI 懒加载（各自独立的块），不能并入静态块。
 * 依赖方向保持单向（主包 → engine → data；任何块 → vendor），避免块之间循环引用。
 */
function manualChunks(id: string): string | undefined {
  const p = id.replace(/\\/g, '/');
  // 打包器注入的虚拟模块（\0 前缀）：commonjs 辅助函数、动态导入的预加载辅助 —— 放进 vendor，避免 data 块反向引用主包
  if (p.startsWith('\0')) return /commonjsHelpers|preload-helper/.test(p) ? 'vendor' : undefined;
  if (p.includes('/node_modules/')) return 'vendor';
  if (p.includes('/src/data/rosters/')) return undefined;
  if (p.includes('/src/data/')) return 'data';
  if (p.includes('/src/engine/') || p.includes('/src/shared/')) return 'engine';
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    // 分包后主包约 0.6 MB（界面为主，中文文案多）；超过 800 kB 时再提示
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: { manualChunks },
    },
  },
  // 多人对战开发：npm run dev + npm run server，前端的 /ws 转发到本机服务器（端口见 src/shared/protocol.ts DEFAULT_SERVER_PORT）
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8686', ws: true, changeOrigin: true },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
