import { defineConfig } from 'vitest/config';

// R3 反向探针专用配置：默认测试套件（vitest.config.ts）不会运行它们。
// 运行方式：npx vitest run -c vitest.probes.config.ts
// 其中持久化/中断探针需要先构建：npm run build:core（子进程使用 dist-electron）。
export default defineConfig({ test: { include: ['tests/r3-probes/**/*.probe.ts'], testTimeout: 240_000, hookTimeout: 60_000 } });
