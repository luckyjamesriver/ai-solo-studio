import { describe, it, expect } from 'vitest';
import { next, canFire, InvalidTransition } from '../src/core/task/state.js';

describe('任务状态机', () => {
  it('完整的快乐路径', () => {
    let s = next('draft', 'plan');
    s = next(s, 'approve');
    s = next(s, 'start');
    s = next(s, 'exec_exit_ok');
    expect(s).toBe('exec_succeeded');
    s = next(s, 'review');
    expect(next(s, 'save')).toBe('saved');
  });

  it('未批准不能开工', () => {
    expect(() => next('planned', 'start')).toThrow(InvalidTransition);
    expect(() => next('draft', 'start')).toThrow(InvalidTransition);
  });

  it('执行体成功退出 ≠ 任务完成，不能跳过验收直接保存', () => {
    expect(canFire('exec_succeeded', 'save')).toBe(false);
    expect(canFire('running', 'save')).toBe(false);
  });

  it('失败、停止、超时都进入验收，可以修复或撤销', () => {
    for (const s of ['exec_failed', 'stopped', 'timed_out'] as const) {
      const r = next(s, 'review');
      expect(canFire(r, 'request_fix')).toBe(true);
      expect(canFire(r, 'discard')).toBe(true);
    }
  });

  it('终态不可再迁移', () => {
    expect(() => next('saved', 'discard')).toThrow();
    expect(() => next('discarded', 'start')).toThrow();
  });
});
