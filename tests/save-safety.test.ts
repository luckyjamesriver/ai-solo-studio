import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import { mapFailure } from '../src/core/acceptance/view.js';
import type { SandboxCommandRunner } from '../src/core/checks/scripts.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, testSandboxRunner } from './helpers.js';

vi.mock('../src/core/git/git.js', { spy: true });
const actualG = await vi.importActual<typeof G>('../src/core/git/git.js');

afterEach(() => {
  vi.mocked(G.git).mockImplementation(actualG.git);
  vi.mocked(G.removeTrialWorktree).mockImplementation(actualG.removeTrialWorktree);
});

const basePlan = {
  goal: '保存安全测试任务',
  inScope: ['更新代码'],
  outOfScope: [],
  criteria: ['功能正确'],
  risks: [],
  irreversible: [],
};

const WRITE_INDEX: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];

async function makeConfirmedTask(opts: {
  files?: Record<string, string>;
  script?: FakeStep[];
  runChecks?: boolean;
  sandboxRunner?: SandboxCommandRunner;
  goal?: string;
} = {}) {
  const repo = await makeRepo(opts.files ?? { 'index.html': '<h1>old</h1>\n' });
  const runner = new TaskRunner({
    repo,
    executor: new FakeExecutor(opts.script ?? WRITE_INDEX),
    runChecks: opts.runChecks ?? true,
    ...(opts.sandboxRunner ? { sandboxRunner: opts.sandboxRunner } : {}),
  });
  const t = await runner.create(opts.goal ?? basePlan.goal);
  await runner.setPlan(t.id, { ...basePlan, goal: opts.goal ?? basePlan.goal });
  await runner.approve(t.id);
  const started = await runner.start(t.id);
  expect(started.state).toBe('reviewing');
  await runner.confirm(t.id, { criterion: 0, decision: 'confirmed' });
  return { repo, runner, id: t.id, task: (await runner.store.get(t.id))! };
}

async function trialsEntries(repo: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(repo, '.studio', 'trials'));
  } catch {
    return [];
  }
}

async function listWorktrees(repo: string): Promise<string> {
  return G.git(repo, ['worktree', 'list', '--porcelain']);
}

describe('阶段 1 · 保存安全：先试合并、试检查，再写入主项目', () => {
  it('试合并冲突：主项目 HEAD、文件、分支在调用前后完全一致，临时 worktree 已清理', async () => {
    const { repo, runner, id } = await makeConfirmedTask({
      runChecks: false,
    });
    await fs.writeFile(path.join(repo, 'index.html'), '<h1>main conflict</h1>\n');
    await G.git(repo, ['commit', '-am', 'main conflict']);

    const headBefore = await G.headSha(repo);
    const branchBefore = await G.currentBranch(repo);
    const countBefore = (await G.git(repo, ['rev-list', '--count', 'HEAD'])).trim();
    const contentBefore = await fs.readFile(path.join(repo, 'index.html'), 'utf8');

    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'conflict', detail: MESSAGES.conflict });
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await G.currentBranch(repo)).toBe(branchBefore);
    expect((await G.git(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe(countBefore);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe(contentBefore);
    expect(await G.isClean(repo)).toBe(true);
    expect(await G.mergeInProgress(repo)).toBe(false);
    expect(await trialsEntries(repo)).toEqual([]);
    expect(await listWorktrees(repo)).not.toContain('.studio/trials');
    expect((await runner.store.get(id))!.state).toBe('save_failed_unmerged');
  });

  it('试检查失败：合并后两份各自通过的改动在一起测试失败 → 主项目不动，返回 checks_failed 与失败项，临时 worktree 已清理', async () => {
    const checkScript = [
      "const fs = require('node:fs');",
      "const a = fs.readFileSync('a.txt', 'utf8').trim();",
      "const b = fs.readFileSync('b.txt', 'utf8').trim();",
      "if (a === 'task' && b === 'main-new') { console.error('incompatible'); process.exit(1); }",
    ].join('\n');
    const files = {
      'package.json': JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'node check.cjs' } }),
      'check.cjs': checkScript,
      'a.txt': 'init\n',
      'b.txt': 'init\n',
    };
    const { repo, runner, id } = await makeConfirmedTask({
      files,
      script: [{ do: 'write', path: 'a.txt', content: 'task\n' }, { do: 'exit', code: 0 }],
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });

    // 主项目另行修改不同文件 b.txt（Git 合并无冲突，但合并后 test 会失败）
    await fs.writeFile(path.join(repo, 'b.txt'), 'main-new\n');
    await G.git(repo, ['commit', '-am', 'update b.txt']);

    const headBefore = await G.headSha(repo);
    const aBefore = await fs.readFile(path.join(repo, 'a.txt'), 'utf8');
    const bBefore = await fs.readFile(path.join(repo, 'b.txt'), 'utf8');

    const r = await runner.save(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('checks_failed');
    expect(r.failedChecks).toEqual(['test']);
    expect(r.detail).toContain('测试');
    expect(r.detail).not.toMatch(/npm run|node check/);

    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe(aBefore);
    expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe(bBefore);
    expect(await G.isClean(repo)).toBe(true);
    expect(await trialsEntries(repo)).toEqual([]);
    expect((await runner.store.get(id))!.state).toBe('reviewing');
    expect((await runner.store.get(id))!.op?.steps.some((s) => s.name === '试检查' && !s.ok)).toBe(true);

    // 视图层映射：不透传 detail 原文，但保留失败检查项名称
    const mapped = mapFailure({ ok: false, reason: 'checks_failed', detail: 'secret /Users/x', failedChecks: ['build', 'test'] });
    expect(mapped.message).toContain('构建、测试');
    expect(mapped.message).not.toContain('/Users/x');
  });

  it('无检查项目：保存成功且 checked=false，临时 worktree 已清理', async () => {
    const { repo, runner, id } = await makeConfirmedTask({
      files: { 'index.html': '<h1>old</h1>\n', 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    const r = await runner.save(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checked).toBe(false);
    expect(r.task.state).toBe('saved');
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
    expect(await trialsEntries(repo)).toEqual([]);
  });

  it('写入前项目变了（在检查期间模拟另一次提交）：返回 project_changed，主项目只有那次外部提交，临时 worktree 已清理', async () => {
    let repoRef = '';
    let injected = false;
    const inner = testSandboxRunner();
    const mutatingRunner: SandboxCommandRunner = {
      async runCommand(req) {
        const res = await inner.runCommand(req);
        if (!injected && repoRef && req.cwd.includes(`${path.sep}.studio${path.sep}trials${path.sep}`)) {
          injected = true;
          // 模拟检查期间主项目发生了另一次外部提交
          await fs.writeFile(path.join(repoRef, 'external.txt'), 'from outside\n');
          await G.git(repoRef, ['add', 'external.txt']);
          await G.git(repoRef, ['commit', '-m', 'external commit during checks']);
        }
        return res;
      },
    };
    const { repo, runner, id } = await makeConfirmedTask({
      files: {
        'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        'index.html': '<h1>old</h1>\n',
      },
      runChecks: true,
      sandboxRunner: mutatingRunner,
    });
    repoRef = repo;

    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'project_changed', detail: MESSAGES.projectChanged });
    // 主项目只有外部提交，没有任务改动
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await fs.readFile(path.join(repo, 'external.txt'), 'utf8')).toBe('from outside\n');
    expect(await trialsEntries(repo)).toEqual([]);
    const t = (await runner.store.get(id))!;
    expect(t.state).toBe('reviewing');
    expect(t.op?.steps.some((s) => s.name === '写入前核对项目未变' && !s.ok)).toBe(true);
    expect(mapFailure(r as never).message).toBe(MESSAGES.projectChanged);

    // 之后再次保存仍然可以成功
    const r2 = await runner.save(id);
    expect(r2.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
    expect(await fs.readFile(path.join(repo, 'external.txt'), 'utf8')).toBe('from outside\n');
  });

  it('写入前项目变了（检查期间主项目工作区变脏或分支切换）：返回 project_changed，主项目不变', async () => {
    let repoRef = '';
    const inner = testSandboxRunner();
    const dirtyingRunner: SandboxCommandRunner = {
      async runCommand(req) {
        const res = await inner.runCommand(req);
        if (repoRef && req.cwd.includes(`${path.sep}.studio${path.sep}trials${path.sep}`)) {
          await fs.writeFile(path.join(repoRef, 'wip.txt'), 'uncommitted\n');
        }
        return res;
      },
    };
    const { repo, runner, id } = await makeConfirmedTask({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), 'index.html': '<h1>old</h1>\n' },
      runChecks: true,
      sandboxRunner: dirtyingRunner,
    });
    repoRef = repo;

    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'project_changed', detail: MESSAGES.projectChanged });
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await fs.readFile(path.join(repo, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
    expect(await trialsEntries(repo)).toEqual([]);
  });

  it('ff-only 失败且恢复一致：返回 failed_restored，不标 manualReview，临时 worktree 已清理', async () => {
    const { repo, runner, id } = await makeConfirmedTask({ runChecks: false });
    const headBefore = await G.headSha(repo);

    vi.mocked(G.git).mockImplementation(async (cwd, args, opts) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') {
        throw new G.GitError('git merge 失败', 'fatal: simulated ff-only failure');
      }
      return actualG.git(cwd, args, opts);
    });

    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'failed_restored', detail: MESSAGES.failedRestored });
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await G.isClean(repo)).toBe(true);
    expect(await trialsEntries(repo)).toEqual([]);
    const t = (await runner.store.get(id))!;
    expect(t.manualReview).toBeUndefined();
    expect(t.state).toBe('reviewing');
    expect(t.op?.steps.some((s) => s.name === '合并失败后核验主项目' && s.ok)).toBe(true);
    expect(mapFailure(r as never).message).toBe(MESSAGES.failedRestored);
  });

  it('ff-only 失败且恢复不一致：触发 manualReview 并返回 abnormal，临时 worktree 已清理', async () => {
    const { repo, runner, id } = await makeConfirmedTask({ runChecks: false });
    vi.mocked(G.git).mockImplementation(async (cwd, args, opts) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') {
        await fs.writeFile(path.join(repo, 'index.html'), '<h1>corrupted partial write</h1>\n');
        throw new G.GitError('git merge 失败', 'fatal: simulated crash mid-checkout');
      }
      return actualG.git(cwd, args, opts);
    });

    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'abnormal', detail: MESSAGES.abnormal });
    expect(!r.ok && r.files).toEqual(['index.html']);
    expect(await trialsEntries(repo)).toEqual([]);
    const t = (await runner.store.get(id))!;
    expect(t.manualReview?.reason).toBeTruthy();
    expect(t.op?.steps.some((s) => s.name === '合并失败后核验主项目' && !s.ok)).toBe(true);
  });

  it('临时 worktree 在检查抛异常时同样被清理；清理失败只记录不影响保存成功结果', async () => {
    const inner = testSandboxRunner();
    const throwingRunner: SandboxCommandRunner = {
      async runCommand(req) {
        if (req.cwd.includes(`${path.sep}.studio${path.sep}trials${path.sep}`)) {
          throw new Error('sandbox process crashed unexpectedly');
        }
        return inner.runCommand(req);
      },
    };
    const s1 = await makeConfirmedTask({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), 'index.html': '<h1>old</h1>\n' },
      runChecks: true,
      sandboxRunner: throwingRunner,
    });
    const head1 = await G.headSha(s1.repo);
    const r1 = await s1.runner.save(s1.id);
    expect(r1.ok).toBe(false);
    expect(await G.headSha(s1.repo)).toBe(head1);
    expect(await trialsEntries(s1.repo)).toEqual([]);
    expect(await listWorktrees(s1.repo)).not.toContain('.studio/trials');

    // 清理临时 worktree 失败只记录，不影响保存成功判断
    const s2 = await makeConfirmedTask({ runChecks: false });
    vi.mocked(G.removeTrialWorktree).mockResolvedValueOnce({ ok: false, error: 'simulated trial lock' });
    const r2 = await s2.runner.save(s2.id);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.task.state).toBe('saved');
    expect(r2.task.op?.steps.find((s) => s.name === '清理临时副本')).toMatchObject({ ok: false, detail: 'simulated trial lock' });
    // 手动清掉测试里模拟未删的临时副本，避免留下目录
    const leftover = await trialsEntries(s2.repo);
    for (const d of leftover) await actualG.removeTrialWorktree(s2.repo, path.join(s2.repo, '.studio', 'trials', d));
  });

  it('中断恢复：在 trial 阶段中断 → 识别阶段并清理残留临时副本，主项目不变且可再次保存', async () => {
    const { repo, runner, id, task } = await makeConfirmedTask({ runChecks: false });
    const preHead = await G.headSha(repo);
    const taskCommit = await G.commitTree(task.worktree!.path, task.acceptedTree!, task.worktree!.baseSha, 'studio: t');
    const trialPath = G.trialWorktreePath(repo, id);
    await G.createTrialWorktree(repo, trialPath, preHead);
    await G.git(trialPath, ['merge', '--no-ff', '-m', 'studio: 保存', taskCommit]);
    const trialCommit = await G.headSha(trialPath);

    task.op = {
      kind: 'save',
      startedAt: new Date().toISOString(),
      phase: 'trial_merged',
      preHead,
      taskCommit,
      trialWorktreePath: trialPath,
      trialCommit,
      steps: [
        { at: new Date().toISOString(), name: '生成任务提交', ok: true, detail: taskCommit },
        { at: new Date().toISOString(), name: '试合并', ok: true, detail: trialCommit },
      ],
    };
    await runner.store.save(task);

    const fresh = new TaskRunner({ repo, executor: new FakeExecutor([]), runChecks: false });
    const found = await fresh.identifyTasks();
    expect(found).toEqual([{ taskId: id, finding: { kind: 'save_not_merged', phase: 'trial_merged' } }]);

    const reconciled = await fresh.reconcileTasks();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.action).toContain('试检查阶段');
    expect(reconciled[0]?.action).toContain('项目保持原样');
    expect(await G.headSha(repo)).toBe(preHead);
    expect(await trialsEntries(repo)).toEqual([]);
    const after = (await fresh.store.get(id))!;
    expect(after.state).toBe('reviewing');
    expect(after.op?.phase).toBe('interrupted');
    expect(after.reconciled?.note).toContain('试检查阶段');

    // 重新保存仍然可以成功
    expect((await fresh.save(id)).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
  });

  it('中断恢复：在 ff 写入后中断 → 识别已合入并清理残留临时副本与任务副本，修正为 saved 且可撤销', async () => {
    const { repo, runner, id, task } = await makeConfirmedTask({ runChecks: false });
    const preHead = await G.headSha(repo);
    const taskCommit = await G.commitTree(task.worktree!.path, task.acceptedTree!, task.worktree!.baseSha, 'studio: t');
    const trialPath = G.trialWorktreePath(repo, id);
    await G.createTrialWorktree(repo, trialPath, preHead);
    await G.git(trialPath, ['merge', '--no-ff', '-m', 'studio: 保存', taskCommit]);
    const trialCommit = await G.headSha(trialPath);
    await G.git(repo, ['merge', '--ff-only', trialCommit]);

    task.op = {
      kind: 'save',
      startedAt: new Date().toISOString(),
      phase: 'writing',
      preHead,
      taskCommit,
      trialWorktreePath: trialPath,
      trialCommit,
      checked: true,
      checksSummary: { passed: 1, failed: 0 },
      checkedAt: new Date().toISOString(),
      steps: [
        { at: new Date().toISOString(), name: '生成任务提交', ok: true, detail: taskCommit },
        { at: new Date().toISOString(), name: '试合并', ok: true, detail: trialCommit },
        { at: new Date().toISOString(), name: '写入前核对项目未变', ok: true },
      ],
    };
    await runner.store.save(task);

    const fresh = new TaskRunner({ repo, executor: new FakeExecutor([]), runChecks: false });
    const found = await fresh.identifyTasks();
    expect(found).toEqual([{ taskId: id, finding: { kind: 'save_merged', merged: trialCommit, phase: 'writing' } }]);

    const reconciled = await fresh.reconcileTasks();
    expect(reconciled).toEqual([{ taskId: id, action: '已修正为 saved' }]);
    expect(await trialsEntries(repo)).toEqual([]);
    const after = (await fresh.store.get(id))!;
    expect(after.state).toBe('saved');
    expect(after.saveRecord).toMatchObject({ preMergeHead: preHead, taskCommit, mergeCommit: trialCommit });
    expect(after.op?.phase).toBe('finished');
    expect(await fresh.reconcileTasks()).toEqual([]); // 幂等
    expect((await fresh.undo(id)).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
  });
});
