import { describe, it, expect } from 'vitest';
import { CodexThinker, ClaudeCliThinker, type OutputSchema, type ThinkRequest } from '../../src/core/thinking/index.js';
import { realEnabled } from './gate.js';

/**
 * 真实思考者集成（默认跳过）：
 *   Codex 部分的开关见 gate.ts（套件名 thinker）
 *   STUDIO_DEV_PERSONAL_CLAUDE=1 STUDIO_REAL_CLAUDE=1 npx vitest run tests/integration/thinker.real.test.ts
 * 各发起一次极小的真实调用：固定小问题，要求返回合法结构。
 */
const schema: OutputSchema = { type: 'object', required: ['answer', 'reason'], properties: { answer: { type: 'number' }, reason: { type: 'string' } } };
const request: ThinkRequest = {
  role: 'planner',
  system: '你是一个严谨的助手。',
  context: { required: [{ name: 'note.md', text: '这是一道算术题，不需要任何外部资料。' }] },
  task: '2 加 3 等于几？answer 填数字，reason 用一句话说明。',
  output: schema,
  timeoutMs: 120_000,
};

describe.skipIf(!realEnabled('thinker'))('真实 CodexThinker', () => {
  it('回答固定小问题并返回合法结构；没有请求任何工具', async () => {
    const t = new CodexThinker();
    const d = await t.detect();
    expect(d.available).toBe(true);
    const r = await t.think(request);
    console.info(`[real-thinker] codex status=${r.status} model=${r.model} refused=${JSON.stringify(r.refusedToolRequests ?? [])} sent=${JSON.stringify(r.sent.map((s) => `${s.name}:${s.bytes}`))}`);
    expect(r.status).toBe('complete');
    expect(r.content?.answer).toBe(5);
    expect(r.refusedToolRequests ?? []).toEqual([]);
  }, 180_000);
});

describe.skipIf(process.env.STUDIO_DEV_PERSONAL_CLAUDE !== '1' || process.env.STUDIO_REAL_CLAUDE !== '1')('真实 ClaudeCliThinker（开发者自用）', () => {
  it('回答固定小问题并返回合法结构；核验可用工具/MCP/技能/斜杠命令均为空', async () => {
    const t = new ClaudeCliThinker();
    const d = await t.detect();
    console.info(`[real-thinker] claude detect=${JSON.stringify(d)}`);
    expect(d.available).toBe(true);
    const r = await t.think(request);
    console.info(`[real-thinker] claude status=${r.status} model=${r.model} evidence=${r.isolationEvidence} usage=${JSON.stringify(r.usage)}`);
    expect(r.status).toBe('complete');
    expect(r.content?.answer).toBe(5);
    expect(r.isolationEvidence).toBe('tools=0, mcp_servers=0, skills=0, slash_commands=0');
  }, 180_000);
});
