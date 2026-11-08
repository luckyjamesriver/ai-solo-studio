import { describe, it, expect } from 'vitest';
import { next, canFire, InvalidTransition, TERMINAL, transitionTable } from '../src/core/task/state.js';

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

  it('B4：保存、放弃、撤销、清理的迁移', () => {
    expect(next('reviewing', 'save_cleanup_pending')).toBe('saved_cleanup_pending');
    expect(next('reviewing', 'save_conflict')).toBe('save_failed_unmerged');
    expect(next('save_failed_unmerged', 'discard')).toBe('discarded');
    expect(next('save_failed_unmerged', 'save')).toBe('saved');
    expect(next('reviewing', 'discard_cleanup_pending')).toBe('discard_cleanup_pending');
    expect(next('saved_cleanup_pending', 'cleanup_done')).toBe('saved');
    expect(next('discard_cleanup_pending', 'cleanup_done')).toBe('discarded');
    expect(next('saved', 'undo')).toBe('undone');
    expect(next('saved', 'undo_failed')).toBe('undo_failed');
    expect(next('undo_failed', 'undo')).toBe('undone');
  });

  it('B4：没有“仍然保存”之类的捷径——检查之外的状态都不能直接保存或撤销', () => {
    for (const s of ['draft', 'planned', 'approved', 'running', 'exec_succeeded', 'saved', 'saved_cleanup_pending', 'discarded', 'undone', 'undo_failed'] as const) {
      expect(canFire(s, 'save'), `${s} 不应能 save`).toBe(false);
    }
    for (const s of ['reviewing', 'save_failed_unmerged', 'saved_cleanup_pending', 'discard_cleanup_pending', 'undone', 'discarded', 'running'] as const) {
      expect(canFire(s, 'undo'), `${s} 不应能 undo`).toBe(false);
    }
    expect(canFire('discarded', 'cleanup_done')).toBe(false);
    expect(TERMINAL).toEqual(['discarded', 'undone']);
    expect(transitionTable().length).toBeGreaterThan(40);
  });
});
