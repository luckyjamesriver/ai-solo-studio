import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRunner } from '../src/core/task/runner.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import { mapFailure, toUserView } from '../src/core/acceptance/view.js';
import { buildTaskView } from '../src/core/app/task-view.js';
import { runProjectChecks, scriptsDigest, type SandboxCommandRunner } from '../src/core/checks/scripts.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir, testSandboxRunner } from './helpers.js';

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

  it('无检查项目：首次保存返回 unchecked_needs_confirm（主项目不变），带确认后保存成功且 checked=false，临时 worktree 已清理', async () => {
    const { repo, runner, id } = await makeConfirmedTask({
      files: { 'index.html': '<h1>old</h1>\n', 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    const headBefore = await G.headSha(repo);
    const r1 = await runner.save(id);
    expect(r1).toMatchObject({ ok: false, reason: 'unchecked_needs_confirm', uncheckedKind: 'none' });
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await trialsEntries(repo)).toEqual([]);

    const r = await runner.save(id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checked).toBe(false);
    expect(r.task.state).toBe('saved');
    expect(r.task.saveRecord).toMatchObject({ checked: false, uncheckedKind: 'none' });
    expect(r.task.saveRecord?.uncheckedConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    const r = await runner.save(id, { confirmUnchecked: true });
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

    const r = await runner.save(id, { confirmUnchecked: true });
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
    const r2 = await s2.runner.save(s2.id, { confirmUnchecked: true });
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
    expect((await fresh.save(id, { confirmUnchecked: true })).ok).toBe(true);
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
    expect(after.saveRecord).toMatchObject({
      preMergeHead: preHead,
      taskCommit,
      mergeCommit: trialCommit,
      trialCommit,
      checked: true,
      checksSummary: { passed: 1, failed: 0 },
    });
    expect(after.saveRecord?.checkedAt).toBeTruthy();
    expect(after.op?.phase).toBe('finished');
    expect(await fresh.reconcileTasks()).toEqual([]); // 幂等
    expect((await fresh.undo(id)).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
  });
});

describe('阶段 1 · 保存记录检查信息与界面文案', () => {
  it('有检查且通过：saveRecord 记录 checked=true、checksSummary、checkedAt、trialCommit，界面显示「检查通过」且不含命令', async () => {
    const files = {
      'package.json': JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }),
      'index.html': '<h1>old</h1>\n',
    };
    const { runner, id } = await makeConfirmedTask({
      files,
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    const r = await runner.save(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rec = r.task.saveRecord!;
    expect(rec.checked).toBe(true);
    expect(rec.checksSummary).toEqual({ passed: 2, failed: 0 });
    expect(rec.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.trialCommit).toBe(rec.mergeCommit);

    const uv = toUserView(r.task, { busy: false });
    expect(uv.saveRecord).toMatchObject({ checked: true, checksText: '检查通过', passedCount: 2, failedCount: 0 });
    expect(uv.verdict).toContain('检查通过');
    expect(JSON.stringify(uv)).not.toMatch(/npm run|node -e|process\.exit/);

    const tv = buildTaskView(r.task, { scripts: ['build', 'test'], running: false });
    expect(tv.saveCheckText).toBe('检查通过');
    expect(JSON.stringify(tv)).not.toMatch(/npm run|node -e|process\.exit/);
  });

  it('无可用检查：确认后 saveRecord 记录 checked=false、uncheckedKind、确认时间，界面显示「未检查」且绝不显示「通过」或「安全」', async () => {
    const { runner, id } = await makeConfirmedTask({
      files: { 'index.html': '<h1>old</h1>\n' },
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    const r = await runner.save(id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rec = r.task.saveRecord!;
    expect(rec.checked).toBe(false);
    expect(rec.uncheckedKind).toBe('none');
    expect(rec.uncheckedConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.checksSummary).toEqual({ passed: 0, failed: 0 });
    expect(rec.checkedAt).toBeUndefined();
    expect(rec.trialCommit).toBe(rec.mergeCommit);

    const uv = toUserView(r.task, { busy: false });
    expect(uv.saveRecord).toMatchObject({ checked: false, checksText: '未检查', uncheckedKind: 'none', passedCount: 0, failedCount: 0 });
    expect(uv.uncheckedConfirm).toBeNull();
    expect(uv.verdict).toContain('未检查');
    expect(uv.verdict).not.toMatch(/通过|安全/);

    const tv = buildTaskView(r.task, { scripts: [], running: false });
    expect(tv.saveCheckText).toBe('未检查');
  });
});

describe('阶段 1 · 项目级锁（manualReview 锁定同项目其他任务的保存与撤销）', () => {
  async function createAnotherConfirmed(repo: string, runner: TaskRunner, goal: string, pathRel: string, content: string) {
    const r2 = new TaskRunner({
      repo,
      executor: new FakeExecutor([{ do: 'write', path: pathRel, content }, { do: 'exit', code: 0 }]),
      runChecks: false,
    });
    const t = await r2.create(goal);
    await r2.setPlan(t.id, { ...basePlan, goal });
    await r2.approve(t.id);
    await r2.start(t.id);
    await r2.confirm(t.id, { criterion: 0, decision: 'confirmed' });
    return { runner: r2, id: t.id, task: (await runner.store.get(t.id))! };
  }

  it('A 任务处于 manualReview 时，同项目 B 任务保存、C 任务撤销均返回 project_locked；人工处理解除后恢复正常', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const runner = new TaskRunner({ repo, executor: new FakeExecutor([]), runChecks: false });

    // C 任务先正常保存（后续测试它不能被撤销）
    const c = await createAnotherConfirmed(repo, runner, '任务 C', 'c.txt', 'c-new\n');
    expect((await c.runner.save(c.id, { confirmUnchecked: true })).ok).toBe(true);

    // A 任务进入验收后发生 manualReview
    const a = await createAnotherConfirmed(repo, runner, '异常任务 A', 'a.txt', 'a-new\n');
    const aRec = (await runner.store.get(a.id))!;
    aRec.manualReview = { reason: '恢复未确认', at: new Date().toISOString() };
    await runner.store.save(aRec);

    // B 任务在同项目准备保存
    const b = await createAnotherConfirmed(repo, runner, '任务 B', 'b.txt', 'b-new\n');

    // B 的保存与预判均被项目锁拒绝
    const bPreview = await runner.previewSave((await runner.store.get(b.id))!);
    expect(bPreview).toMatchObject({ ok: false, reason: 'project_locked', blockingTask: '异常任务 A' });
    const bSave = await b.runner.save(b.id);
    expect(bSave).toMatchObject({ ok: false, reason: 'project_locked', blockingTask: '异常任务 A' });
    expect(!bSave.ok && bSave.detail).toContain('异常任务 A');
    expect(!bSave.ok && bSave.detail).toContain('先处理那个任务');
    expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('b\n');

    // B 的用户视图也把保存按钮置灰并提示先处理异常任务 A
    const bView = toUserView((await runner.store.get(b.id))!, { busy: false, saveCheck: bPreview });
    expect(bView.actions.save.enabled).toBe(false);
    expect(bView.actions.save.reason).toContain('异常任务 A');

    // C 的撤销与预判同样被项目锁拒绝
    const cPreview = await runner.previewUndo((await runner.store.get(c.id))!);
    expect(cPreview).toMatchObject({ ok: false, reason: 'project_locked', blockingTask: '异常任务 A' });
    const cUndo = await c.runner.undo(c.id);
    expect(cUndo).toMatchObject({ ok: false, reason: 'project_locked', blockingTask: '异常任务 A' });
    expect(await fs.readFile(path.join(repo, 'c.txt'), 'utf8')).toBe('c-new\n');

    // mapFailure 不泄露底层 detail
    const mapped = mapFailure({ ok: false, reason: 'project_locked', detail: 'secret /Users/x', blockingTask: '异常任务 A' });
    expect(mapped.message).toContain('异常任务 A');
    expect(mapped.message).not.toContain('/Users/x');

    // 模拟人工处理完成并清除 A 的 manualReview 后，解锁恢复
    const aLatest = (await runner.store.get(a.id))!;
    delete aLatest.manualReview;
    await runner.store.save(aLatest);

    expect((await b.runner.save(b.id, { confirmUnchecked: true })).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('b-new\n');
    // 现在撤销 B（HEAD=B 的 mergeCommit）也能正常执行
    expect((await b.runner.undo(b.id)).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('b\n');
  });
});

describe('阶段 1 · 撤销：说清楚为什么不能撤销', () => {
  async function saveTask(repo: string, goal: string, file: string, content: string) {
    const runner = new TaskRunner({
      repo,
      executor: new FakeExecutor([{ do: 'write', path: file, content }, { do: 'exit', code: 0 }]),
      runChecks: false,
    });
    const t = await runner.create(goal);
    await runner.setPlan(t.id, { ...basePlan, goal });
    await runner.approve(t.id);
    await runner.start(t.id);
    await runner.confirm(t.id, { criterion: 0, decision: 'confirmed' });
    const r = await runner.save(t.id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected save ok');
    return { runner, id: t.id, task: r.task };
  }

  it('撤销被后续 studio 保存挡住：返回原因包含挡住它的任务名与时间，替代笼统 undoRefused；且不跨保存撤销', async () => {
    const repo = await makeRepo({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    const a = await saveTask(repo, '改首页标题', 'a.txt', 'a1\n');
    const b = await saveTask(repo, '新增页脚导航', 'b.txt', 'b1\n');
    const c = await saveTask(repo, '调整页边距', 'c.txt', 'c1\n');

    const headBefore = await G.headSha(repo);
    const preview = await a.runner.previewUndo((await a.runner.store.get(a.id))!);
    expect(preview).toMatchObject({ ok: false, reason: 'undo_refused' });
    expect(preview?.blockingSaves?.map((x) => x.goal)).toEqual(['新增页脚导航', '调整页边距']);
    expect(preview?.detail).toContain('新增页脚导航');
    expect(preview?.detail).toContain('调整页边距');
    expect(preview?.detail).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(preview?.detail).not.toBe(MESSAGES.undoRefused);

    const undoRes = await a.runner.undo(a.id);
    expect(undoRes.ok).toBe(false);
    if (undoRes.ok) return;
    expect(undoRes.reason).toBe('undo_refused');
    expect(undoRes.blockingSaves).toHaveLength(2);
    expect(undoRes.blockingSaves?.map((x) => x.goal)).toEqual(['新增页脚导航', '调整页边距']);
    expect(undoRes.detail).toContain('新增页脚导航');
    expect(undoRes.detail).toContain('调整页边距');
    expect(undoRes.detail).not.toBe(MESSAGES.undoRefused);

    // 不实现跨保存撤销：主项目与 A 任务保持原样
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a1\n');
    expect((await a.runner.store.get(a.id))!.state).toBe('saved');

    // 用户视图也展示具体的阻塞任务名与时间
    const view = toUserView((await a.runner.store.get(a.id))!, { busy: false, undoCheck: preview });
    expect(view.actions.undo.enabled).toBe(false);
    expect(view.actions.undo.reason).toContain('新增页脚导航');
    expect(view.actions.undo.reason).toContain('调整页边距');

    // 最新保存（HEAD === C.mergeCommit）仍可正常撤销
    expect((await c.runner.undo(c.id)).ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'c.txt'), 'utf8')).toBe('c0\n');
    // 撤销 C 产生的新提交同样在 HEAD 上，B 仍在 A 之后挡住 A
    const aAfter = await a.runner.undo(a.id);
    expect(aAfter.ok).toBe(false);
    if (!aAfter.ok) expect(aAfter.detail).toContain('新增页脚导航');
  });

  it('mapFailure 对所有新增 reason 不透传核心层 detail 原文', () => {
    for (const r of ['checks_failed', 'unchecked_needs_confirm', 'project_changed', 'failed_restored', 'project_locked'] as const) {
      const res = mapFailure({
        ok: false,
        reason: r,
        detail: 'fatal: /Users/victim git 原文',
        failedChecks: ['test'],
        uncheckedKind: 'unavailable',
        unavailableReason: 'sandbox_unavailable',
        blockingTask: '任务 X',
      });
      expect(JSON.stringify(res), r).not.toMatch(/fatal|\/Users\/victim|git 原文/);
    }
  });
});

describe('阶段 1 补丁 · 未检查时必须由用户确认', () => {
  it('runProjectChecks 准确区分三种结果：none（无脚本）/ unavailable（沙箱不可用、检查脚本变化需重新授权）/ ran（全部运行）', async () => {
    const emptyRepo = await makeRepo({ 'index.html': '<h1>hi</h1>\n' });
    const noneRes = await runProjectChecks(emptyRepo, testSandboxRunner());
    expect(noneRes).toMatchObject({ kind: 'none', checked: false });
    expect(noneRes.reasonText).toContain('没有配置');

    const withScripts = await makeRepo({
      'package.json': JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }),
    });
    const digest = await scriptsDigest(withScripts);

    // 沙箱不可用：无 runner 与 runner 返回 unavailable
    const noRunner = await runProjectChecks(withScripts, undefined, { authorizedDigest: digest });
    expect(noRunner).toMatchObject({ kind: 'unavailable', unavailableReason: 'sandbox_unavailable', checked: false });
    const unavailRunner: SandboxCommandRunner = { runCommand: async () => ({ status: 'unavailable', reason: 'seatbelt disabled' }) };
    const unavailRes = await runProjectChecks(withScripts, unavailRunner, { authorizedDigest: digest });
    expect(unavailRes).toMatchObject({ kind: 'unavailable', unavailableReason: 'sandbox_unavailable', checked: false });

    // 检查脚本变化需重新授权：摘要不一致或未授权
    const reauthRes = await runProjectChecks(withScripts, testSandboxRunner(), { authorizedDigest: '0'.repeat(64) });
    expect(reauthRes).toMatchObject({ kind: 'unavailable', unavailableReason: 'scripts_changed_reauth', checked: false });
    expect(reauthRes.reasonText).toContain('这次合并改动了项目的检查方式，所以没法自动检查。');

    // 全部运行（通过 / 失败）均返回 kind: 'ran'
    const ranOk = await runProjectChecks(withScripts, testSandboxRunner(), { authorizedDigest: digest });
    expect(ranOk).toMatchObject({ kind: 'ran', checked: true, summary: { passed: 2, failed: 0 } });
    expect(ranOk.checkedAt).toBeTruthy();

    const failRepo = await makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) });
    const failDigest = await scriptsDigest(failRepo);
    const ranFail = await runProjectChecks(failRepo, testSandboxRunner(), { authorizedDigest: failDigest });
    expect(ranFail).toMatchObject({ kind: 'ran', checked: false, summary: { passed: 0, failed: 1 } });
  });

  it('有检查但沙箱不可用：首次保存返回 unchecked_needs_confirm（type=unavailable，主项目不变），确认后写入并记录 uncheckedKind 与确认时间', async () => {
    const files = {
      'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      'index.html': '<h1>old</h1>\n',
    };
    const { repo, runner, id } = await makeConfirmedTask({
      files,
      runChecks: true,
      sandboxRunner: { runCommand: async () => ({ status: 'unavailable', reason: 'sandbox offline' }) },
    });
    const headBefore = await G.headSha(repo);

    const r1 = await runner.save(id);
    expect(r1).toMatchObject({
      ok: false,
      reason: 'unchecked_needs_confirm',
      uncheckedKind: 'unavailable',
      unavailableReason: 'sandbox_unavailable',
    });
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await trialsEntries(repo)).toEqual([]);
    expect((await runner.store.get(id))!.state).toBe('reviewing');

    const r2 = await runner.save(id, { confirmUnchecked: true });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.checked).toBe(false);
    expect(r2.task.saveRecord).toMatchObject({
      checked: false,
      uncheckedKind: 'unavailable',
      unavailableReason: 'sandbox_unavailable',
    });
    expect(r2.task.saveRecord?.uncheckedConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
    expect(await trialsEntries(repo)).toEqual([]);
  });

  it('合并改动了检查脚本：无论任务内改动还是主线改动导致合并后脚本变化，均返回 unavailable 且明确说明检查方式变化', async () => {
    // 场景 1：任务内修改了 package.json 的 test 脚本（授权摘要不再匹配）
    const s1 = await makeConfirmedTask({
      files: {
        'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        'index.html': '<h1>old</h1>\n',
      },
      script: [
        { do: 'write', path: 'package.json', content: JSON.stringify({ scripts: { test: 'node -e "console.log(\'changed\')"' } }) },
        { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
        { do: 'exit', code: 0 },
      ],
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    const head1 = await G.headSha(s1.repo);
    const r1 = await s1.runner.save(s1.id);
    expect(r1).toMatchObject({
      ok: false,
      reason: 'unchecked_needs_confirm',
      uncheckedKind: 'unavailable',
      unavailableReason: 'scripts_changed_reauth',
    });
    expect(!r1.ok && r1.detail).toContain('这次合并改动了项目的检查方式，所以没法自动检查。');
    expect(await G.headSha(s1.repo)).toBe(head1);
    expect(await trialsEntries(s1.repo)).toEqual([]);

    // 场景 2：主线提交改动了 package.json（与任务修改不同文件，试合并无冲突但合并结果脚本与批准时不一致）
    const s2 = await makeConfirmedTask({
      files: {
        'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        'index.html': '<h1>old</h1>\n',
      },
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });
    await fs.writeFile(
      path.join(s2.repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "console.log(\'from main\')"' } }),
    );
    await G.git(s2.repo, ['commit', '-am', 'main updates test script']);
    const head2 = await G.headSha(s2.repo);
    const r2 = await s2.runner.save(s2.id);
    expect(r2).toMatchObject({
      ok: false,
      reason: 'unchecked_needs_confirm',
      uncheckedKind: 'unavailable',
      unavailableReason: 'scripts_changed_reauth',
    });
    expect(!r2.ok && r2.detail).toContain('这次合并改动了项目的检查方式，所以没法自动检查。');
    expect(await G.headSha(s2.repo)).toBe(head2);
    expect(await fs.readFile(path.join(s2.repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await trialsEntries(s2.repo)).toEqual([]);
  });

  it('两次调用之间项目被改：第二次带 confirmUnchecked 重新走试合并并返回 project_changed，绝不用旧的试合并结果写入', async () => {
    const { repo, runner, id } = await makeConfirmedTask({
      files: { 'index.html': '<h1>old</h1>\n', 'other.txt': 'v0\n' },
      runChecks: true,
      sandboxRunner: testSandboxRunner(),
    });

    // 第一次保存：返回 unchecked_needs_confirm
    const r1 = await runner.save(id);
    expect(r1).toMatchObject({ ok: false, reason: 'unchecked_needs_confirm', uncheckedKind: 'none' });
    const headAfterFirst = await G.headSha(repo);
    const trialCallsAfterFirst = vi.mocked(G.createTrialWorktree).mock.calls.length;

    // 两次调用之间，主项目出现了不冲突的另一次提交
    await fs.writeFile(path.join(repo, 'other.txt'), 'external-commit\n');
    await G.git(repo, ['commit', '-am', 'commit between two save calls']);
    const headExternal = await G.headSha(repo);
    expect(headExternal).not.toBe(headAfterFirst);

    // 第二次带 confirmUnchecked 保存：会重新走试合并并核对出项目已变 → 返回 project_changed，不写旧试合并结果
    const r2 = await runner.save(id, { confirmUnchecked: true });
    expect(vi.mocked(G.createTrialWorktree).mock.calls.length).toBeGreaterThan(trialCallsAfterFirst);
    expect(r2).toMatchObject({ ok: false, reason: 'project_changed', detail: MESSAGES.projectChanged });
    expect(await G.headSha(repo)).toBe(headExternal);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(await fs.readFile(path.join(repo, 'other.txt'), 'utf8')).toBe('external-commit\n');
    expect(await trialsEntries(repo)).toEqual([]);

    // 确认状态已清除，之后重新发起保存可按最新项目状态走两步并成功保存
    const uv = toUserView((await runner.store.get(id))!, { busy: false, saveCheck: null });
    expect(uv.uncheckedConfirm).toBeNull();
    expect(await runner.save(id)).toMatchObject({ ok: false, reason: 'unchecked_needs_confirm' });
    const r3 = await runner.save(id, { confirmUnchecked: true });
    expect(r3.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
    expect(await fs.readFile(path.join(repo, 'other.txt'), 'utf8')).toBe('external-commit\n');
  });

  it('控制器与视图闭环：saveTask 返回待确认 → 打开预览保留确认 → recheck 清空「仍然保存」→ 再次触发后 saveUncheckedTask 成功写入', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const data = await tmpDir('patch-ctl-');
    let previewCalls = 0;
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor(WRITE_INDEX, { emitPermissions: true }),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
      openPreview: async () => { previewCalls++; },
    });

    const t = await ctl.create('更新首页');
    await ctl.savePlan(t.id, { goal: '更新首页', criteria: ['首页已更新'], mode: 'standard', network: false });
    await ctl.start(t.id, false);
    let view = await ctl.getAcceptanceView(t.id);
    for (let i = 0; i < 500 && (view.busy || view.state !== 'reviewing'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      view = await ctl.getAcceptanceView(t.id);
    }
    expect(view.uncheckedConfirm).toBeNull();
    view = (await ctl.confirmCriterion(t.id, 'c0', view.version)).view;

    // 1) 点击保存：返回 unchecked_needs_confirm，视图下发「打开预览」「仍然保存」及原因
    const res1 = await ctl.saveTask(t.id, view.version);
    expect(res1.ok).toBe(false);
    expect(res1.view.uncheckedConfirm).toMatchObject({
      kind: 'none',
      previewButtonText: '打开预览',
      confirmButtonText: '仍然保存',
    });
    expect(res1.view.uncheckedConfirm?.reason).toContain('没有配置可用的自动检查脚本');
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');

    // 2) 点击「打开预览」：同版本保留 uncheckedConfirm，便于用户预览后点「仍然保存」
    const prev = await ctl.openPreview(t.id, res1.view.version);
    expect(prev.ok).toBe(true);
    expect(previewCalls).toBe(1);
    expect(prev.view.uncheckedConfirm?.confirmButtonText).toBe('仍然保存');

    // 3) 点击「重新检查」：版本变化，视图不再下发「仍然保存」
    const rec = await ctl.recheck(t.id);
    expect(rec.view.version).not.toBe(res1.view.version);
    expect(rec.view.uncheckedConfirm).toBeNull();
    expect(JSON.stringify(rec.view)).not.toContain('仍然保存');

    // 4) 重新确认并走保存 → 再次进入 unchecked_needs_confirm → 调用 saveUncheckedTask 成功写入
    const confirmedAgain = (await ctl.confirmCriterion(t.id, 'c0', rec.view.version)).view;
    const res2 = await ctl.saveTask(t.id, confirmedAgain.version);
    expect(res2.view.uncheckedConfirm?.confirmButtonText).toBe('仍然保存');
    const saved = await ctl.saveUncheckedTask(t.id, res2.view.version);
    expect(saved.ok).toBe(true);
    expect(saved.view.state).toBe('saved');
    expect(saved.view.uncheckedConfirm).toBeNull();
    expect(saved.view.saveRecord).toMatchObject({ checked: false, checksText: '未检查', uncheckedKind: 'none' });
    expect(saved.view.saveRecord?.uncheckedConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>new</h1>\n');
  });
});
