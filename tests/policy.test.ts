import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { assess, canAutoApprove } from '../src/core/policy/risk.js';

const wt = '/proj/.studio/worktrees/t1';
const req = (o: object) => ({ id: 'x', description: 'd', kind: 'other' as const, ...o });

describe('风险分级', () => {
  it('worktree 内写文件为低风险、可恢复，可自动批准', () => {
    const a = assess(req({ kind: 'write_file', paths: ['src/a.ts'] }), wt);
    expect(a).toMatchObject({ level: 'low', reversible: true });
    expect(canAutoApprove(a, { autoLow: true })).toBe(true);
    expect(canAutoApprove(a, { autoLow: false })).toBe(false);
  });

  it('任何越出 worktree 的路径都是高风险、不可恢复', () => {
    for (const p of ['../../secret', '/etc/passwd', '/proj/index.html']) {
      const a = assess(req({ kind: 'read_file', paths: [p] }), wt);
      expect(a).toMatchObject({ level: 'high', reversible: false });
      expect(canAutoApprove(a, { autoLow: true })).toBe(false);
    }
  });

  it('系统临时目录等 worktree 之外的位置（含 /tmp、os.tmpdir()、~、$VAR）都是高风险、不可恢复', () => {
    const targets = ['/tmp/x', '/private/tmp/x', os.tmpdir(), path.join(os.tmpdir(), 'leak.txt'), '~/x', '$HOME/x', '$TMPDIR/x', '/var/folders/zz/T/x'];
    for (const p of targets) {
      for (const kind of ['write_file', 'delete_file', 'read_file'] as const) {
        const a = assess(req({ kind, paths: [p] }), wt);
        expect(a, `${kind} ${p}`).toMatchObject({ level: 'high', reversible: false });
        expect(canAutoApprove(a, { autoLow: true })).toBe(false);
      }
    }
  });

  it('worktree 本身位于临时目录下时，临时目录中的其他位置仍是越界', () => {
    const tmpWt = path.join(os.tmpdir(), 'repo', '.studio', 'worktrees', 't1');
    expect(assess(req({ kind: 'write_file', paths: ['src/a.ts'] }), tmpWt).level).toBe('low');
    expect(assess(req({ kind: 'write_file', paths: [path.join(os.tmpdir(), 'repo', 'index.html')] }), tmpWt)).toMatchObject({ level: 'high', reversible: false });
    expect(assess(req({ kind: 'write_file', paths: [path.join(os.tmpdir(), 'other.txt')] }), tmpWt)).toMatchObject({ level: 'high', reversible: false });
  });

  it('前缀相似的兄弟目录不算在内', () => {
    expect(assess(req({ kind: 'write_file', paths: ['/proj/.studio/worktrees/t1-evil/x'] }), wt).level).toBe('high');
  });

  it('命令分级', () => {
    expect(assess(req({ kind: 'run_command', command: ['git', 'push'] }), wt).level).toBe('high');
    expect(assess(req({ kind: 'run_command', command: ['rm', '-rf', '.'] }), wt).level).toBe('high');
    expect(assess(req({ kind: 'run_command', command: ['curl', 'x'] }), wt).level).toBe('high');
    expect(assess(req({ kind: 'run_command', command: ['npm', 'install'] }), wt)).toMatchObject({ level: 'medium', reversible: false });
    expect(assess(req({ kind: 'run_command', command: ['npm', 'run', 'build'] }), wt).level).toBe('medium');
  });

  it('中高风险永远不会自动批准', () => {
    const a = assess(req({ kind: 'run_command', command: ['npm', 'run', 'build'] }), wt);
    expect(canAutoApprove(a, { autoLow: true })).toBe(false);
  });
});
