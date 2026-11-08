import { defineConfig } from 'vitest/config';
// Electron 端到端测试：需要真实显示环境；串行运行，每个测试自己启动并关闭应用。
export default defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], testTimeout: 120_000, hookTimeout: 60_000, fileParallelism: false, pool: 'forks', maxWorkers: 1 },
});
