import { describe, it, expect } from 'vitest';
import { ClaudeApiThinker, type OutputSchema, type ThinkRequest } from '../../src/core/thinking/index.js';

/**
 * 真实 Anthropic Messages API 集成测试（默认跳过，避免无条件发起外部付费调用）：
 *   STUDIO_REAL_CLAUDE_API=1 ANTHROPIC_API_KEY=sk-ant-... npx vitest run tests/integration/claude-api.real.test.ts
 */
const enabled = process.env.STUDIO_REAL_CLAUDE_API === '1' && !!process.env.ANTHROPIC_API_KEY?.trim();

const schema: OutputSchema = {
  type: 'object',
  required: ['answer', 'reason'],
  properties: { answer: { type: 'number' }, reason: { type: 'string' } },
};

const request: ThinkRequest = {
  role: 'planner',
  system: '你是一个严谨的助手。',
  context: { required: [{ name: 'note.md', text: '这是一道极小的算术题，不需要任何工具或外部资料。' }] },
  task: '2 加 3 等于几？answer 填数字，reason 用一句话说明。',
  output: schema,
  timeoutMs: 120_000,
};

describe.skipIf(!enabled)('真实 ClaudeApiThinker（Anthropic Messages API）', () => {
  it('返回合法结构并真实记录输入/输出 token 数，不携带任何工具', async () => {
    const thinker = new ClaudeApiThinker({
      model: process.env.STUDIO_CLAUDE_MODEL?.trim() || undefined,
      getSecret: async () => process.env.ANTHROPIC_API_KEY?.trim() || null,
    });
    const d = await thinker.detect();
    expect(d.available).toBe(true);

    const r = await thinker.think(request);
    expect(r.status).toBe('complete');
    expect(r.content?.answer).toBe(5);
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
    expect(r.refusedToolRequests ?? []).toEqual([]);
  }, 180_000);
});
