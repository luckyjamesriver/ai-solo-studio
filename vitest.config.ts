import { defineConfig } from 'vitest/config';

// AISS-A1：多个集成测试现在会真实跑 build / Vitest 检查（有的还要跑两轮：验收 + 保存试合并），
// 默认 20s 在 CI 或并行全量时会偏紧；这里统一放宽到 60s（只放宽等待上限，不改变任何断言）。
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 } });
