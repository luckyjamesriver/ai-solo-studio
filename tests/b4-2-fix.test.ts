import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as G from '../src/core/git/git.js';
import { buildPreviews } from '../src/core/acceptance/snippets.js';
import { mapFailure } from '../src/core/acceptance/view.js';
import { MESSAGES } from '../src/core/task/messages.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import type { ProcessProbe } from '../src/core/task/process-check.js';
import type { Task } from '../src/core/task/model.js';
import { makeRepo } from './helpers.js';

/** M3-B4-2-fix：中文 / 带空格的文件名（-z 解析）与重试清理的进程核实 */

describe('Git 文件名输出按 -z 解析（纯函数）', () => {
  it('name-status：普通、改名（旧新两段）、中文、空格、含制表符与引号的名字', () => {
    const out = ['M', '说明.txt', 'A', 'my notes.txt', 'R100', '旧名字.txt', '新 名字.txt', 'D', 'tab\there"q.txt', ''].join('\0');
    expect(G.parseNameStatusZ(out)).toEqual([
      { code: 'M', path: '说明.txt' },
      { code: 'A', path: 'my notes.txt' },
      { code: 'R', oldPath: '旧名字.txt', path: '新 名字.txt' },
      { code: 'D', path: 'tab\there"q.txt' },
    ]);
    expect(G.parseNameStatusZ('')).toEqual([]);
  });

  it('numstat：普通、改名（空路径后跟旧新两段）、二进制为 null', () => {
    const out = ['1\t2\t说明.txt', '3\t0\tmy notes.txt', '1\t1\t', '旧名字.txt', '新名字.txt', '-\t-\timg.png', ''].join('\0');
    const m = G.parseNumstatZ(out);
    expect(m.get('说明.txt')).toEqual([1, 2]);
    expect(m.get('my notes.txt')).toEqual([3, 0]);
    expect(m.get('新名字.txt')).toEqual([1, 1]);
    expect(m.get('img.png')).toEqual([null, null]);
    expect(m.size).toBe(4);
  });
});

describe('中文与带空格的文件名：片段与行数正确（真实 Git）', () => {
  const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `第${i + 1}行${tag}`).join('\n') + '\n';
  async function frozen(files: Record<string, string>, edit: (dir: string) => Promise<void>) {
    const repo = await makeRepo(files);
    const wt = await G.createWorktree(repo, 'fx1');
    await edit(wt.path);
    const changes = await G.diffSummary(wt);
    const acceptedTree = await G.computeTree(repo, wt.path);
    const task = { id: 't', request: 'x', state: 'reviewing', denied: [], deniedAcks: [], criteria: [], previewed: false, timeline: [], createdAt: 'x', updatedAt: 'x', worktree: wt, acceptedTree, card: { items: [], changes, readyToSave: false, headline: 'h' } } as Task;
    return { changes, previews: await buildPreviews(repo, task) };
  }

  it('中文文件名修改：路径不被转义，行数正确，显示“原来/现在”', async () => {
    const { changes, previews } = await frozen({ '说明.txt': '甲\n乙\n丙\n' }, (d) => fs.writeFile(path.join(d, '说明.txt'), '甲\n乙改\n丙\n'));
    expect(changes).toEqual([{ status: 'modified', path: '说明.txt', additions: 1, deletions: 1 }]);
    const p = previews.get('说明.txt');
    expect(p?.kind).toBe('text');
    if (p?.kind === 'text') {
      expect(p.hunks[0]!.before).toEqual(['甲', '乙', '丙']);
      expect(p.hunks[0]!.after).toEqual(['甲', '乙改', '丙']);
    }
  });

  it('带空格的文件名新增：行数正确，显示“新文件”与内容', async () => {
    const { changes, previews } = await frozen({ 'a.txt': 'x\n' }, (d) => fs.writeFile(path.join(d, 'my notes.txt'), '第一行\n第二行\n'));
    expect(changes).toEqual([{ status: 'added', path: 'my notes.txt', additions: 2, deletions: 0 }]);
    expect(previews.get('my notes.txt')).toEqual({ kind: 'new', note: '新文件', lines: ['第一行', '第二行'], truncated: false });
  });

  it('中文文件改名（同时改一行）：同时拿到新旧路径与行数，片段按原路径比对', async () => {
    const { changes, previews } = await frozen({ '旧名字.txt': lines(10) }, async (d) => {
      await fs.rename(path.join(d, '旧名字.txt'), path.join(d, '新名字.txt'));
      await fs.writeFile(path.join(d, '新名字.txt'), lines(10).replace('第5行', '第5行已改'));
    });
    expect(changes).toEqual([{ status: 'renamed', path: '新名字.txt', oldPath: '旧名字.txt', additions: 1, deletions: 1 }]);
    const p = previews.get('新名字.txt');
    expect(p?.kind).toBe('text');
    if (p?.kind === 'text') {
      expect(p.hunks[0]!.before).toContain('第5行');
      expect(p.hunks[0]!.after).toContain('第5行已改');
    }
  });

  it('同一次改动里中文、空格、普通名字混在一起，也各自对得上', async () => {
    const { changes } = await frozen({ 'a b.txt': '1\n', '中文.md': '1\n2\n' }, async (d) => {
      await fs.writeFile(path.join(d, 'a b.txt'), '1\n2\n3\n');
      await fs.rm(path.join(d, '中文.md'));
      await fs.writeFile(path.join(d, '新 文件.md'), '甲\n');
    });
    const by = Object.fromEntries(changes.map((c) => [c.path, [c.status, c.additions, c.deletions]]));
    expect(by).toEqual({ 'a b.txt': ['modified', 2, 0], '中文.md': ['deleted', 0, 2], '新 文件.md': ['added', 1, 0] });
  });
});

describe('重试清理也要核实进程', () => {
  const WRITE: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  async function pendingDiscard(probe: ProcessProbe) {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const runner = new TaskRunner({ repo, executor: new FakeExecutor(WRITE), runChecks: false, processProbe: probe });
    const t = await runner.create('改标题');
    await runner.setPlan(t.id, { goal: '改标题', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [], capabilities: {} } as never);
    await runner.approve(t.id);
    await runner.start(t.id);
    const task = (await runner.store.get(t.id))!;
    await G.git(repo, ['worktree', 'lock', task.worktree!.path]); // 让第一次清理失败，进入 discard_cleanup_pending
    const r = await runner.discard(t.id);
    expect(r.ok && r.message).toBe(MESSAGES.discardCleanupPending);
    return { repo, runner, id: t.id, wt: task.worktree! };
  }

  it('进程存活时重试清理：不删除、保持 cleanup_pending、返回固定文案；进程结束后重试成功', async () => {
    let alive = true;
    const probe: ProcessProbe = { isAlive: () => alive, nameOf: async () => 'codex' };
    const s = await pendingDiscard(probe);
    const t = (await s.runner.store.get(s.id))!;
    t.execProc = { pid: 4242, at: 'x', name: 'codex' };
    await s.runner.store.save(t);
    await G.git(s.repo, ['worktree', 'unlock', s.wt.path]); // 排除“被锁住”这个原因：不删除只能是因为进程核实
    const blocked = await s.runner.retryCleanup(s.id);
    expect(blocked).toMatchObject({ ok: false, reason: 'cleanup_pending', detail: MESSAGES.cleanupBusy });
    expect(MESSAGES.cleanupBusy).toBe('AI 可能还在使用这个任务的临时文件，暂时不能清理，请稍后再试。');
    expect((await s.runner.store.get(s.id))!.state).toBe('discard_cleanup_pending');
    expect(await exists(s.wt.path)).toBe(true);
    expect(mapFailure(blocked as never).message).toBe(MESSAGES.cleanupBusy);

    alive = false;
    const ok = await s.runner.retryCleanup(s.id);
    expect(ok.ok).toBe(true);
    expect((await s.runner.store.get(s.id))!.state).toBe('discarded');
    expect(await exists(s.wt.path)).toBe(false);
  });

  it('进程无法确认（认不出）同样不删除；归属对不上也不删除', async () => {
    const probe: ProcessProbe = { isAlive: () => true, nameOf: async () => null };
    const s = await pendingDiscard(probe);
    await G.git(s.repo, ['worktree', 'unlock', s.wt.path]);
    const t = (await s.runner.store.get(s.id))!;
    t.execProc = { pid: 4242, at: 'x', name: 'codex' };
    await s.runner.store.save(t);
    expect(await s.runner.retryCleanup(s.id)).toMatchObject({ ok: false, detail: MESSAGES.cleanupBusy });
    expect(await exists(s.wt.path)).toBe(true);

    // 上一次 retryCleanup 已经提交过（修订号前进了）：必须重新读取再改，旧副本提交会被 CAS 拒绝
    const t2 = (await s.runner.store.get(s.id))!;
    delete t2.execProc;
    t2.worktree = { ...t2.worktree!, branch: 'studio/task-someone-else' };
    await s.runner.store.save(t2);
    expect(await s.runner.retryCleanup(s.id)).toMatchObject({ ok: false, detail: MESSAGES.cleanupBusy });
    expect(await exists(s.wt.path)).toBe(true);
  });
});
