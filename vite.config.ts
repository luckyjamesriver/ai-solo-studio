import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 只负责构建渲染进程界面。后端能力全部位于 Electron 主进程，不在 Vite 开发服务器中实现。
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist-renderer', emptyOutDir: true },
});
