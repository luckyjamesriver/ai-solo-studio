import { describe, it, expect } from 'vitest';
import { buildCard } from '../src/core/acceptance/card.js';

const changes = [{ status: 'modified' as const, path: 'a', additions: 1, deletions: 0 }];
const ok = { kind: 'exited' as const, code: 0 };

describe('验收卡', () => {
  it('没有测试脚本时显示“未检查”，绝不显示通过', () => {
    const c = buildCard({ exit: ok, changes, checks: [{ name: 'test', status: 'not_available', reason: '无' }], criteria: [], previewed: false });
    expect(c.items.find((i) => i.key === 'test')?.status).toBe('not_checked');
  });

  it('执行体非零退出 → 不可保存', () => {
    const c = buildCard({ exit: { kind: 'exited', code: 1 }, changes, checks: [], criteria: [], previewed: true });
    expect(c.readyToSave).toBe(false);
  });

  it('被停止、超时、被信号终止都算失败', () => {
    for (const exit of [{ kind: 'stopped' }, { kind: 'timed_out' }, { kind: 'signaled', signal: 'SIGKILL' }] as const) {
      expect(buildCard({ exit, changes, checks: [], criteria: [], previewed: true }).readyToSave).toBe(false);
    }
  });

  it('没有任何文件改动 → 不可保存', () => {
    expect(buildCard({ exit: ok, changes: [], checks: [], criteria: [], previewed: true }).readyToSave).toBe(false);
  });

  it('验收标准未全部确认 → 不可保存；全部确认 → 可保存', () => {
    const base = { exit: ok, changes, checks: [], previewed: true };
    expect(buildCard({ ...base, criteria: [{ text: 'a' }] }).readyToSave).toBe(false);
    expect(buildCard({ ...base, criteria: [{ text: 'a', decision: 'rejected' }] }).readyToSave).toBe(false);
    expect(buildCard({ ...base, criteria: [{ text: 'a', decision: 'confirmed' }] }).readyToSave).toBe(true);
  });
});
