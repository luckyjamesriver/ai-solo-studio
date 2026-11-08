import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as G from '../src/core/git/git.js';
import { makeRepo } from './helpers.js';

describe('B4-1 受控 Git 层', () => {
  it('统一入口固定附加参数：命令行配置覆盖项目里的 hooksPath / fsmonitor / gpgsign', async () => {
    const repo = await makeRepo();
    execFileSync('git', ['config', 'core.hooksPath', '/nonexistent-hooks'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: repo });
    execFileSync('git', ['config', 'core.fsmonitor', '/nonexistent-monitor'], { cwd: repo });
    expect((await G.git(repo, ['config', 'core.hooksPath'])).trim()).toBe('/dev/null');
    expect((await G.git(repo, ['config', 'commit.gpgsign'])).trim()).toBe('false');
    expect((await G.git(repo, ['config', 'core.fsmonitor'])).trim()).toBe('false');
    expect((await G.git(repo, ['config', 'diff.external'])).trim()).toBe('');
  });

  it('computeTree：等于副本内容；不动副本自己的索引；临时索引用后删除；已跟踪但被忽略的文件不会丢', async () => {
    const repo = await makeRepo({ 'index.html': 'a\n', 'keep.log': 'tracked but ignored\n', '.gitignore': '*.log\n' });
    // 先跟踪再忽略：initRepo 的 add -A 会跳过 *.log，这里强制加入
    await G.git(repo, ['add', '-f', 'keep.log']);
    await G.git(repo, ['commit', '-m', 'track log']);
    const wt = await G.createWorktree(repo, 'tree1');
    await fs.writeFile(path.join(wt.path, 'index.html'), 'b\n');
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'n\n');
    await fs.writeFile(path.join(wt.path, 'ignored.log'), 'x\n'); // 被忽略的新文件不进入 tree
    const indexBefore = (await G.git(wt.path, ['status', '--porcelain'])).trim();
    const tree = await G.computeTree(repo, wt.path);
    const listed = (await G.git(repo, ['ls-tree', '-r', '--name-only', tree])).trim().split('\n').sort();
    expect(listed).toEqual(['.gitignore', 'index.html', 'keep.log', 'new.txt']);
    expect((await G.git(repo, ['show', `${tree}:index.html`])).trim()).toBe('b');
    expect((await G.git(wt.path, ['status', '--porcelain'])).trim()).toBe(indexBefore); // 副本自己的索引没被动
    expect((await fs.readdir(path.join(repo, '.studio'))).some((f) => f.startsWith('tree-index-'))).toBe(false);
    expect(await G.computeTree(repo, wt.path)).toBe(tree); // 内容不变 → tree 不变
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'changed\n');
    expect(await G.computeTree(repo, wt.path)).not.toBe(tree);
    await fs.rm(path.join(wt.path, 'keep.log'));
    const withoutLog = (await G.git(repo, ['ls-tree', '-r', '--name-only', await G.computeTree(repo, wt.path)])).trim().split('\n');
    expect(withoutLog).not.toContain('keep.log'); // 删除被如实反映
  });

  it('dirtyFiles：忽略 .studio/，文件名含空格与中文不被转义，重命名只算一个文件', async () => {
    const repo = await makeRepo({ 'a b.txt': 'a\n', 'old.txt': 'o\n' });
    await fs.mkdir(path.join(repo, '.studio', 'x'), { recursive: true });
    await fs.writeFile(path.join(repo, '.studio', 'x', 'y'), 'y');
    expect(await G.dirtyFiles(repo)).toEqual([]);
    await fs.writeFile(path.join(repo, 'a b.txt'), 'changed\n');
    await fs.writeFile(path.join(repo, '中文.txt'), 'c\n');
    await G.git(repo, ['mv', 'old.txt', 'new.txt']);
    expect((await G.dirtyFiles(repo)).sort()).toEqual(['a b.txt', 'new.txt', '中文.txt']);
  });

  it('removeWorktree：逐步返回结果；重复调用成功（幂等）；主线不受影响', async () => {
    const repo = await makeRepo();
    const wt = await G.createWorktree(repo, 'rm1');
    const head = await G.headSha(repo);
    const r1 = await G.removeWorktree(repo, wt);
    expect(r1.ok).toBe(true);
    expect(r1.steps.map((s) => s.step)).toEqual(['worktree_remove', 'worktree_prune', 'branch_delete']);
    const r2 = await G.removeWorktree(repo, wt);
    expect(r2.ok).toBe(true);
    expect(await G.worktreeGone(repo, wt)).toBe(true);
    expect(await G.headSha(repo)).toBe(head);
  });

  it('hasCustomCommitChecks：.sample 与不可执行文件不算；hooksPath 或可执行钩子才算', async () => {
    const repo = await makeRepo();
    expect(await G.hasCustomCommitChecks(repo)).toBe(false);
    await fs.writeFile(path.join(repo, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
    await fs.chmod(path.join(repo, '.git', 'hooks', 'pre-commit.sample'), 0o755);
    await fs.writeFile(path.join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
    await fs.chmod(path.join(repo, '.git', 'hooks', 'pre-push'), 0o644);
    expect(await G.hasCustomCommitChecks(repo)).toBe(false);
    await fs.chmod(path.join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    expect(await G.hasCustomCommitChecks(repo)).toBe(true);
    await fs.rm(path.join(repo, '.git', 'hooks', 'pre-push'));
    expect(await G.hasCustomCommitChecks(repo)).toBe(false);
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo });
    expect(await G.hasCustomCommitChecks(repo)).toBe(true);
  });

  it('detectExternalDrivers：内置 merge 驱动（text/binary/union）与未定义的驱动名不算', async () => {
    const repo = await makeRepo({ 'a.dat': '1\n', 'b.bin': '2\n', 'c.txt': '3\n', '.gitattributes': 'a.dat merge=union\nb.bin merge=binary\nc.txt merge=undefineddriver diff=undefineddriver filter=undefineddriver\n' });
    expect((await G.detectExternalDrivers(repo)).supported).toBe(true);
    execFileSync('git', ['config', 'merge.undefineddriver.driver', 'true'], { cwd: repo });
    const d = await G.detectExternalDrivers(repo);
    expect(d.supported).toBe(false);
    expect(d.drivers).toEqual(['merge=undefineddriver（c.txt）']);
  });

  it('detectExternalDrivers：子目录里的 .gitattributes 同样生效', async () => {
    const repo = await makeRepo({ 'sub/deep/x.txt': 'x\n', 'sub/.gitattributes': '*.txt filter=sneaky\n' });
    execFileSync('git', ['config', 'filter.sneaky.clean', 'cat'], { cwd: repo });
    const d = await G.detectExternalDrivers(repo);
    expect(d.supported).toBe(false);
    expect(d.drivers[0]).toContain('filter=sneaky');
    expect(d.drivers[0]).toContain('sub/deep/x.txt');
  });
});
