import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir } from './helpers.js';

describe('Git 隔离与恢复', () => {
  it('识别与初始化仓库', async () => {
    const d = await tmpDir();
    expect(await G.isRepo(d)).toBe(false);
    await fs.writeFile(path.join(d, 'a.txt'), 'a');
    await G.initRepo(d);
    expect(await G.isRepo(d)).toBe(true);
    expect((await G.savePoints(d)).length).toBe(1);
  });

  it('worktree 内的改动不影响主线；diff 包含新增、修改、删除', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n', 'old.txt': 'x\n' });
    const wt = await G.createWorktree(repo, 't1');
    await fs.writeFile(path.join(wt.path, 'index.html'), 'v2\n');
    await fs.writeFile(path.join(wt.path, 'new.css'), 'body{}\n');
    await fs.rm(path.join(wt.path, 'old.txt'));

    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('v1\n');
    const changes = await G.diffSummary(wt);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    expect(byPath).toEqual({ 'index.html': 'modified', 'new.css': 'added', 'old.txt': 'deleted' });
    expect(await G.isClean(repo)).toBe(true); // .studio/ 被忽略
  });

  it('保存：合并回主线并形成保存点', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n' });
    const wt = await G.createWorktree(repo, 't2');
    await fs.writeFile(path.join(wt.path, 'index.html'), 'v2\n');
    expect(await G.commitWorktree(wt, 'task t2')).not.toBeNull();
    const r = await G.mergeTask(repo, wt, 'studio: 保存 t2');
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('v2\n');
    await G.removeWorktree(repo, wt);
    expect((await G.savePoints(repo))[0]?.message).toBe('studio: 保存 t2');
  });

  it('无改动时 commitWorktree 返回 null', async () => {
    const repo = await makeRepo();
    const wt = await G.createWorktree(repo, 't3');
    expect(await G.commitWorktree(wt, 'noop')).toBeNull();
  });

  it('撤销：删除 worktree 与分支，主线不变', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n' });
    const before = await G.headSha(repo);
    const wt = await G.createWorktree(repo, 't4');
    await fs.writeFile(path.join(wt.path, 'index.html'), 'broken\n');
    await G.removeWorktree(repo, wt);
    expect(await G.headSha(repo)).toBe(before);
    await expect(fs.access(wt.path)).rejects.toThrow();
    const branches = await G.git(repo, ['branch', '--list', wt.branch]);
    expect(branches.trim()).toBe('');
  });

  it('冲突时中止合并、主线保持原状、任务分支保留', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n' });
    const wt = await G.createWorktree(repo, 't5');
    await fs.writeFile(path.join(wt.path, 'index.html'), 'task\n');
    await G.commitWorktree(wt, 'task');
    await fs.writeFile(path.join(repo, 'index.html'), 'main\n');
    await G.git(repo, ['commit', '-am', 'main change']);
    const head = await G.headSha(repo);
    const r = await G.mergeTask(repo, wt, 'save');
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await G.headSha(repo)).toBe(head);
    expect(await G.isClean(repo)).toBe(true);
    expect((await G.git(repo, ['branch', '--list', wt.branch])).trim()).not.toBe('');
  });

  it('主线有未保存改动时拒绝合并', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n' });
    const wt = await G.createWorktree(repo, 't6');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a');
    await G.commitWorktree(wt, 'task');
    await fs.writeFile(path.join(repo, 'index.html'), 'dirty\n');
    expect(await G.mergeTask(repo, wt, 'save')).toMatchObject({ ok: false, reason: 'dirty_main' });
  });

  it('回到保存点：以新提交恢复内容，不改写历史', async () => {
    const repo = await makeRepo({ 'index.html': 'v1\n' });
    const first = await G.headSha(repo);
    await fs.writeFile(path.join(repo, 'index.html'), 'v2\n');
    await fs.writeFile(path.join(repo, 'extra.txt'), 'x');
    await G.git(repo, ['add', '-A']);
    await G.git(repo, ['commit', '-m', 'v2']);
    const count = (await G.savePoints(repo)).length;
    await G.restoreTo(repo, first);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('v1\n');
    await expect(fs.access(path.join(repo, 'extra.txt'))).rejects.toThrow();
    expect((await G.savePoints(repo)).length).toBe(count + 1);
  });

  it('拒绝非法任务 ID（防路径穿越）', () => {
    expect(() => G.taskBranch('../evil')).toThrow();
    expect(() => G.taskBranch('A B')).toThrow();
  });
});
