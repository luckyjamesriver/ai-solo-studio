import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir } from './helpers.js';

/**
 * AISS-A1-TRUSTED-EVIDENCE-R1-001 §2：数据完整性（真实 Git 仓库反向测试）。
 *
 * 复核发现的缺陷：候选的「目录名过滤」会把**已跟踪**的 node_modules/.studio 文件从内容 tree 与改动清单里剔除，
 * 导致“基线追踪 node_modules/fixture.js → 内容冻结后该文件被移除”这一删除被隐藏。
 *
 * 本文件用真实 Git 仓库覆盖：验收内容冻结、改动清单、试合并、正式保存与撤销。
 */

const clean: string[] = [];
afterEach(async () => {
  while (clean.length) await fs.rm(clean.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

async function tempRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeRepo(files);
  clean.push(repo);
  return repo;
}

async function worktreeOf(repo: string, id = 'r1git'): Promise<G.Worktree> {
  return G.createWorktree(repo, id);
}

describe('R1 数据完整性：已跟踪的内部目录文件绝不因目录名被剔除', () => {
  it('已跟踪 node_modules/fixture.js 的修改与删除都进入内容 tree 与改动清单；未跟踪缓存被排除', async () => {
    const repo = await tempRepo({
      'node_modules/fixture.js': 'module.exports = 1;\n',
      'tracked.js': 'export const a = 1;\n',
      'package.json': JSON.stringify({ name: 'r1-git', scripts: { build: 'node -e "process.exit(0)"' } }),
    });
    const wt = await worktreeOf(repo);

    // 冻结基线内容：已跟踪的 node_modules 文件必须在 tree 里
    const baseTree = await G.computeTree(repo, wt.path);
    const listed = (await G.git(repo, ['ls-tree', '-r', '--name-only', baseTree])).split('\n');
    expect(listed).toContain('node_modules/fixture.js');
    expect(listed).toContain('tracked.js');

    // 执行体：修改已跟踪内部文件 + 删除它 + 修改普通文件；另外写入未跟踪的内部缓存
    await fs.writeFile(path.join(wt.path, 'node_modules/fixture.js'), 'module.exports = 2;\n');
    await fs.writeFile(path.join(wt.path, 'tracked.js'), 'export const a = 2;\n');
    await fs.mkdir(path.join(wt.path, 'node_modules/.vite'), { recursive: true });
    await fs.writeFile(path.join(wt.path, 'node_modules/.vite/cache.bin'), 'cache');
    await fs.mkdir(path.join(wt.path, '.studio', 'tmp'), { recursive: true });
    await fs.writeFile(path.join(wt.path, '.studio', 'tmp', 'run.log'), 'log');

    // 修改：已跟踪内部文件的内容变化必须体现在 tree 里
    const modifiedTree = await G.computeTree(repo, wt.path);
    expect(modifiedTree).not.toBe(baseTree);
    const modifiedContent = (await G.git(repo, ['show', `${modifiedTree}:node_modules/fixture.js`])).trim();
    expect(modifiedContent).toBe('module.exports = 2;');
    // 未跟踪内部缓存不进入内容 tree
    const treeFiles = (await G.git(repo, ['ls-tree', '-r', '--name-only', modifiedTree])).split('\n');
    expect(treeFiles).not.toContain('node_modules/.vite/cache.bin');
    expect(treeFiles.some((p) => p.startsWith('.studio/'))).toBe(false);
    // 改动清单：已跟踪文件显示 modified，未跟踪缓存不出现
    const changes = await G.diffSummary(wt);
    expect(changes.find((c) => c.path === 'node_modules/fixture.js')?.status).toBe('modified');
    expect(changes.find((c) => c.path === 'tracked.js')?.status).toBe('modified');
    expect(changes.some((c) => c.path.includes('.vite') || c.path.startsWith('.studio/'))).toBe(false);

    // 删除已跟踪内部文件：必须显示为删除，并且从内容 tree 中消失
    await fs.rm(path.join(wt.path, 'node_modules/fixture.js'));
    const deletedTree = await G.computeTree(repo, wt.path);
    const delivered = await G.git(repo, ['ls-tree', '-r', '--name-only', deletedTree]);
    expect(delivered).not.toContain('node_modules/fixture.js');
    const changedAfterDelete = await G.diffSummary(wt);
    const del = changedAfterDelete.find((c) => c.path === 'node_modules/fixture.js');
    expect(del?.status).toBe('deleted');
    expect(del?.deletions).toBeGreaterThan(0);
  });

  it('不污染用户 Git 索引与工作区状态（computeTree / diffSummary 只用临时索引）', async () => {
    const repo = await tempRepo({
      'a.txt': 'a0\n',
      'b.txt': 'b0\n',
      'package.json': JSON.stringify({ name: 'r1-index', scripts: { build: 'node -e "process.exit(0)"' } }),
    });
    const wt = await worktreeOf(repo);
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a1\n');
    await fs.writeFile(path.join(wt.path, 'new.txt'), 'new\n');

    const indexSnapshot = async (dir: string) => ({
      status: (await G.git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(),
      files: (await G.git(dir, ['ls-files', '-s'])).trim(),
    });
    const before = await indexSnapshot(wt.path);
    const baseBefore = await indexSnapshot(repo);

    await G.computeTree(repo, wt.path);
    await G.diffSummary(wt);
    await G.diffTreePaths(repo, 'HEAD', await G.computeTree(repo, wt.path));

    expect(await indexSnapshot(wt.path)).toEqual(before);
    expect(await indexSnapshot(repo)).toEqual(baseBefore);
  });
});

describe('R1 数据完整性：验收 → 保存 → 撤销全链路（真实 Git）', () => {
  it('已跟踪 node_modules 文件的删除在验收清单可见、保存后真实生效、撤销后文件树与保存前严格一致', async () => {
    const repo = await tempRepo({
      'node_modules/fixture.js': 'module.exports = 1;\n',
      'index.html': '<h1>v0</h1>\n',
      'package.json': JSON.stringify({ name: 'r1-save', scripts: { build: 'node -e "process.exit(0)"' } }),
    });
    const beforeTree = await G.treeOf(repo, 'HEAD');
    const wt = await worktreeOf(repo, 'r1save');

    // 执行体的真实改动：删除已跟踪的内部目录文件，并修改普通文件
    await fs.rm(path.join(wt.path, 'node_modules/fixture.js'));
    await fs.writeFile(path.join(wt.path, 'index.html'), '<h1>v1</h1>\n');

    // 验收内容冻结 + 改动清单
    const frozen = await G.computeTree(repo, wt.path);
    const changes = await G.diffSummary(wt);
    expect(changes.find((c) => c.path === 'node_modules/fixture.js')?.status).toBe('deleted');
    expect(changes.find((c) => c.path === 'index.html')?.status).toBe('modified');
    expect((await G.git(repo, ['ls-tree', '-r', '--name-only', frozen])).split('\n')).not.toContain('node_modules/fixture.js');

    // 正式保存的写入部分：任务提交 → 合并进主项目
    const taskCommit = await G.commitTree(repo, frozen, wt.baseSha, 'studio: r1 save');
    const preMergeHead = await G.headSha(repo);
    await G.git(repo, ['merge', '--no-ff', taskCommit, '-m', 'studio: r1 save']);
    const savedList = (await G.git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    expect(savedList).not.toContain('node_modules/fixture.js');
    expect(savedList).toContain('index.html');
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>v1</h1>\n');
    expect(await G.treeOf(repo, 'HEAD')).not.toBe(beforeTree);

    // 撤销：恢复到保存前 HEAD，文件树必须与保存前严格一致（含被删除的已跟踪内部文件）
    await G.restoreTo(repo, preMergeHead, 'studio: 撤销 r1 保存');
    expect(await G.treeOf(repo, 'HEAD')).toBe(beforeTree);
    const restored = (await G.git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    expect(restored).toContain('node_modules/fixture.js');
    expect(await fs.readFile(path.join(repo, 'node_modules/fixture.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('试用合并工作树也遵循同一内容定义：已跟踪内部文件删除在试合并中可见、未跟踪缓存不干扰', async () => {
    const repo = await tempRepo({
      'node_modules/fixture.js': 'v1\n',
      'shared.txt': 's0\n',
    });
    const wt = await worktreeOf(repo, 'r1trial');
    await fs.rm(path.join(wt.path, 'node_modules/fixture.js'));
    const taskTree = await G.computeTree(repo, wt.path);
    const taskCommit = await G.commitTree(repo, taskTree, wt.baseSha, 'studio: trial');
    const trialPath = G.trialWorktreePath(repo, 'r1trial');
    await G.createTrialWorktree(repo, trialPath, await G.headSha(repo));
    try {
      await G.git(trialPath, ['merge', '--no-ff', taskCommit, '-m', 'studio: trial merge']);
      // 试合并成功，且合并后的内容定义同样不含被删除的已跟踪内部文件
      const trialTree = await G.computeTree(repo, trialPath);
      expect((await G.git(repo, ['ls-tree', '-r', '--name-only', trialTree])).split('\n')).not.toContain('node_modules/fixture.js');
      // 未跟踪缓存不影响 trial tree
      await fs.mkdir(path.join(trialPath, 'node_modules/.vite'), { recursive: true });
      await fs.writeFile(path.join(trialPath, 'node_modules/.vite/cache.bin'), 'x');
      expect(await G.computeTree(repo, trialPath)).toBe(trialTree);
    } finally {
      await G.removeTrialWorktree(repo, trialPath).catch(() => undefined);
    }
  });
});
