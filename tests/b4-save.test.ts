import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir, testSandboxRunner } from './helpers.js';

/** M3-B4-1 验收矩阵：保存 / 放弃 / 撤销 / 清理 / 中断恢复（模拟执行体 + 真实 Git，无需 Codex） */

const plan = { goal: '改标题', inScope: ['改标题'], outOfScope: [], criteria: ['标题已更新'], risks: [], irreversible: [] };
const WRITE_TITLE: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];

async function setup(opts: { script?: FakeStep[]; files?: Record<string, string>; runChecks?: boolean; plan?: typeof plan & { capabilities?: object }; criteria?: string[] } = {}) {
  const repo = await makeRepo(opts.files ?? { 'index.html': '<h1>old</h1>\n' });
  const runner = new TaskRunner({
    repo,
    executor: new FakeExecutor(opts.script ?? WRITE_TITLE),
    runChecks: opts.runChecks ?? false,
    ...(opts.runChecks ? { sandboxRunner: testSandboxRunner() } : {}),
  });
  const t = await runner.create('改标题');
  await runner.setPlan(t.id, { ...(opts.plan ?? plan), ...(opts.criteria ? { criteria: opts.criteria } : {}) } as typeof plan);
  await runner.approve(t.id);
  return { repo, runner, id: t.id };
}

/** 做到“已验收并确认”，可以保存 */
async function confirmed(opts: Parameters<typeof setup>[0] = {}) {
  const s = await setup(opts);
  const t = await s.runner.start(s.id);
  expect(t.state).toBe('reviewing');
  if (t.criteria.length) for (let i = 0; i < t.criteria.length; i++) await s.runner.confirm(s.id, { criterion: i, decision: 'confirmed' });
  else await s.runner.confirm(s.id, { overall: true });
  return { ...s, task: (await s.runner.store.get(s.id))! };
}

const read = (repo: string, f = 'index.html') => fs.readFile(path.join(repo, f), 'utf8');
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const branchExists = async (repo: string, b: string) => (await G.git(repo, ['branch', '--list', b])).trim() !== '';

describe('B4-1 保存', () => {
  it('正常保存：提交内容 = 冻结的验收内容；--no-ff 合并；副本与分支清理；阶段日志完整', async () => {
    const { repo, runner, id, task } = await confirmed();
    expect(task.acceptedTree).toMatch(/^[0-9a-f]{40}$/);
    expect(task.binding).toMatchObject({ branch: 'main', baseHead: task.worktree!.baseSha });
    const before = await G.headSha(repo);
    const r = await runner.save(id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toBe(MESSAGES.saved);
    expect(r.task.state).toBe('saved');
    expect(await read(repo)).toBe('<h1>new</h1>\n');
    const rec = r.task.saveRecord!;
    expect(rec.preMergeHead).toBe(before);
    expect(rec.mergeCommit).toBe(await G.headSha(repo));
    const parents = (await G.git(repo, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ');
    expect(parents.slice(1)).toEqual([before, rec.taskCommit]); // --no-ff：第二个父提交就是任务提交
    expect(await G.treeOf(repo, rec.taskCommit)).toBe(task.acceptedTree); // 提交内容就是验收内容
    expect((await G.git(repo, ['rev-parse', `${rec.taskCommit}^`])).trim()).toBe(task.worktree!.baseSha); // 父 = 基线
    expect(await exists(task.worktree!.path)).toBe(false);
    expect(await branchExists(repo, task.worktree!.branch)).toBe(false);
    expect(r.task.op).toMatchObject({ kind: 'save', phase: 'finished', preHead: before, taskCommit: rec.taskCommit, mergeCommit: rec.mergeCommit });
    expect(r.task.op!.steps.map((s) => s.name)).toEqual(expect.arrayContaining(['生成任务提交', '合并到项目']));
    expect(await exists(path.join(repo, '.studio'))).toBe(true);
    expect((await fs.readdir(path.join(repo, '.studio'))).filter((f) => f.startsWith('tree-index-'))).toEqual([]); // 临时索引用后删除
  });

  it('主线在基线之后前进（不冲突）：同样用 --no-ff 合并', async () => {
    const { repo, runner, id } = await confirmed({ files: { 'index.html': '<h1>old</h1>\n', 'other.txt': 'a\n' } });
    await fs.writeFile(path.join(repo, 'other.txt'), 'b\n');
    await G.git(repo, ['commit', '-am', 'main moves on']);
    const r = await runner.save(id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    expect(await read(repo)).toBe('<h1>new</h1>\n');
    expect(await read(repo, 'other.txt')).toBe('b\n');
  });

  it('未检查必须先确认再保存（没有 build/test 脚本）', async () => {
    const { repo, runner, id, task } = await confirmed({ runChecks: true });
    expect(task.card!.items.find((i) => i.key === 'test')?.status).toBe('not_checked');
    const head = await G.headSha(repo);
    expect(await runner.save(id)).toMatchObject({ ok: false, reason: 'unchecked_needs_confirm', uncheckedKind: 'none' });
    expect(await G.headSha(repo)).toBe(head);
    const saved = await runner.save(id, { confirmUnchecked: true });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.task.saveRecord).toMatchObject({ checked: false, uncheckedKind: 'none' });
  });

  it('检查失败不可保存；放弃后主项目不变', async () => {
    const files = {
      'package.json': JSON.stringify({ scripts: { test: 'node check.js' } }),
      'check.js': 'process.exit(1);\n',
      'index.html': '<h1>old</h1>\n',
    };
    const { repo, runner, id, task } = await confirmed({ files, runChecks: true });
    expect(task.card!.items.find((i) => i.key === 'test')?.status).toBe('failed');
    const head = await G.headSha(repo);
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await G.headSha(repo)).toBe(head);
    expect(await read(repo)).toBe('<h1>old</h1>\n');
  });

  it('执行体失败（退出码 2）不可保存', async () => {
    const { runner, id } = await confirmed({ script: [{ do: 'write', path: 'index.html', content: 'x\n' }, { do: 'exit', code: 2 }] });
    expect(await runner.save(id)).toMatchObject({ ok: false, reason: 'not_ready' });
  });

  it('隔离异常不可保存', async () => {
    const { runner, id } = await confirmed();
    const t = (await runner.store.get(id))!;
    t.isolationWarnings = ['使用了非官方模型端点'];
    await runner.store.save(t);
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(!r.ok && r.detail).toContain('隔离');
  });

  it('验收标准为空：必须整体确认才能保存', async () => {
    const s = await setup({ criteria: [] });
    const t = await s.runner.start(s.id);
    expect(t.card!.items.find((i) => i.key === 'overall')?.status).toBe('pending_user');
    expect(await s.runner.save(s.id)).toMatchObject({ ok: false, reason: 'not_ready' });
    await s.runner.confirm(s.id, { overall: true });
    expect((await s.runner.save(s.id, { confirmUnchecked: true })).ok).toBe(true);
  });

  it('有验收标准时不接受整体确认', async () => {
    const s = await setup();
    await s.runner.start(s.id);
    await expect(s.runner.confirm(s.id, { overall: true })).rejects.toThrow(/逐条/);
  });

  it('保存前内容变化：拒绝保存（验收失效），重新检查后可再保存；主项目没有被动过', async () => {
    const { repo, runner, id, task } = await confirmed();
    await fs.writeFile(path.join(task.worktree!.path, 'sneaky.txt'), 'later\n'); // 确认之后又多了一个文件
    const head = await G.headSha(repo);
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'acceptance_invalid', detail: MESSAGES.acceptanceInvalid });
    expect(await G.headSha(repo)).toBe(head);
    expect(await exists(path.join(repo, 'sneaky.txt'))).toBe(false);
    // 重新检查：此前的确认全部清空，新内容重新冻结
    const t2 = await runner.recheck(id);
    expect(t2.criteria[0]?.decision).toBeUndefined();
    expect(t2.acceptedTree).not.toBe(task.acceptedTree);
    expect(t2.card!.changes.map((c) => c.path).sort()).toEqual(['index.html', 'sneaky.txt']);
    expect(await runner.save(id)).toMatchObject({ ok: false, reason: 'not_ready' }); // 需要重新确认
    await runner.confirm(id, { criterion: 0, decision: 'confirmed' });
    expect((await runner.save(id, { confirmUnchecked: true })).ok).toBe(true);
    expect(await read(repo, 'sneaky.txt')).toBe('later\n');
  });

  it('检查改动了文件：检查结果作废并如实提示，改动清单列出新增文件', async () => {
    const files = {
      'package.json': JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'generated.txt\',\'x\')"' } }),
      'index.html': '<h1>old</h1>\n',
    };
    const { runner, id, task } = await confirmed({ files, runChecks: true });
    expect(task.checksVoid).toBe(MESSAGES.checksModified);
    const test = task.card!.items.find((i) => i.key === 'test')!;
    expect(test.status).toBe('not_checked');
    expect(test.evidence).toContain(MESSAGES.checksModified);
    expect(task.card!.items.find((i) => i.key === 'checks_modified')?.evidence).toBe(MESSAGES.checksModified);
    expect(task.card!.changes.map((c) => c.path)).toContain('generated.txt');
    // 确认操作（重建验收卡）不会把“作废”标记弄丢
    const again = await runner.confirm(id, { previewed: true });
    expect(again.card!.items.find((i) => i.key === 'checks_modified')).toBeDefined();
  });

  it('主项目不干净：拒绝保存，列出文件，副本保留，没有提交或暂存任何用户文件', async () => {
    const { repo, runner, id, task } = await confirmed({ files: { 'index.html': '<h1>old</h1>\n', 'notes 中文.txt': 'n\n' } });
    await fs.writeFile(path.join(repo, 'notes 中文.txt'), 'edited by user\n');
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'u\n');
    const head = await G.headSha(repo);
    const commits = (await G.git(repo, ['rev-list', '--count', '--all'])).trim();
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'dirty_main', detail: MESSAGES.dirtyMain });
    expect(!r.ok && r.files?.sort()).toEqual(['notes 中文.txt', 'untracked.txt']);
    expect(await G.headSha(repo)).toBe(head);
    expect((await G.git(repo, ['rev-list', '--count', '--all'])).trim()).toBe(commits);
    expect((await G.git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe(''); // 没有暂存
    expect(await read(repo, 'notes 中文.txt')).toBe('edited by user\n');
    expect(await read(repo, 'untracked.txt')).toBe('u\n');
    expect(await exists(task.worktree!.path)).toBe(true);
  });

  it('分支变化：拒绝保存，不让用户选分支', async () => {
    const { repo, runner, id, task } = await confirmed();
    await G.git(repo, ['checkout', '-b', 'feature']);
    const head = await G.headSha(repo);
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'branch_changed', detail: MESSAGES.branchChanged });
    expect(await G.headSha(repo)).toBe(head);
    expect(await read(repo)).toBe('<h1>old</h1>\n');
    expect(await exists(task.worktree!.path)).toBe(true);
  });

  it('合并冲突：abort 后主项目与合并前一致，副本保留，状态 save_failed_unmerged；之后可以放弃', async () => {
    const { repo, runner, id, task } = await confirmed();
    await fs.writeFile(path.join(repo, 'index.html'), '<h1>main</h1>\n');
    await G.git(repo, ['commit', '-am', 'main change']);
    const head = await G.headSha(repo);
    const r = await runner.save(id);
    expect(r).toMatchObject({ ok: false, reason: 'conflict', detail: MESSAGES.conflict });
    expect(await G.headSha(repo)).toBe(head);
    expect(await G.isClean(repo)).toBe(true);
    expect(await G.mergeInProgress(repo)).toBe(false);
    expect(await read(repo)).toBe('<h1>main</h1>\n');
    expect(await exists(task.worktree!.path)).toBe(true);
    expect(await branchExists(repo, task.worktree!.branch)).toBe(true);
    const t = (await runner.store.get(id))!;
    expect(t.state).toBe('save_failed_unmerged');
    expect(t.op?.steps.some((s) => s.name === '合并失败后核验主项目' && s.ok)).toBe(true);
    const d = await runner.discard(id);
    expect(d.ok).toBe(true);
    expect((await runner.store.get(id))!.state).toBe('discarded');
  });

  it('重复点击：保存、保存+放弃同时发起，后者被拒绝', async () => {
    const { runner, id } = await confirmed();
    const [a, b] = await Promise.all([runner.save(id, { confirmUnchecked: true }), runner.save(id, { confirmUnchecked: true })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ reason: 'busy', detail: MESSAGES.busy });

    const s2 = await confirmed();
    const [c, d] = await Promise.all([s2.runner.save(s2.id, { confirmUnchecked: true }), s2.runner.discard(s2.id)]);
    expect(c.ok).toBe(true);
    expect(d).toMatchObject({ ok: false, reason: 'busy' });
    expect((await s2.runner.store.get(s2.id))!.state).toBe('saved');
  });
});

describe('B4-1 放弃', () => {
  it('正常放弃：主项目不变，副本与分支删除，返回规定文案', async () => {
    const { repo, runner, id, task } = await confirmed();
    const head = await G.headSha(repo);
    const r = await runner.discard(id);
    expect(r.ok && r.message).toBe(MESSAGES.discardDone);
    expect(r.ok && r.message).toBe('这次任务的代码改动不会进入项目。');
    expect(await G.headSha(repo)).toBe(head);
    expect(await read(repo)).toBe('<h1>old</h1>\n');
    expect(await exists(task.worktree!.path)).toBe(false);
    expect(await branchExists(repo, task.worktree!.branch)).toBe(false);
    expect((await runner.store.get(id))!.state).toBe('discarded');
  });

  it('扩展了额外目录的任务：追加“副本以外的修改无法撤销”', async () => {
    const extra = await tmpDir('extra-');
    const { runner, id } = await confirmed({ plan: { ...plan, capabilities: { extraWritableDirs: [extra] } } });
    const r = await runner.discard(id);
    expect(r.ok && r.message).toBe(`${MESSAGES.discardDone}${MESSAGES.discardExtra}`);
  });

  it('清理只针对本任务：路径或分支不符一律拒绝，不动手', async () => {
    const repo = await makeRepo();
    const other = await tmpDir('other-');
    await fs.writeFile(path.join(other, 'keep.txt'), 'k');
    const r1 = await G.removeWorktree(repo, { path: other, branch: 'studio/task-abc', baseSha: '' });
    expect(r1.ok).toBe(false);
    expect(await exists(path.join(other, 'keep.txt'))).toBe(true);
    const r2 = await G.removeWorktree(repo, { path: path.join(repo, '.studio', 'worktrees', 'abc'), branch: 'main', baseSha: '' });
    expect(r2.ok).toBe(false);
    expect(await branchExists(repo, 'main')).toBe(true);
  });
});

describe('B4-1 撤销', () => {
  it('撤销最近一次保存：以新提交恢复到合并前，历史不改写', async () => {
    const { repo, runner, id } = await confirmed();
    const saved = await runner.save(id, { confirmUnchecked: true });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const mergeCommit = saved.task.saveRecord!.mergeCommit;
    const r = await runner.undo(id);
    expect(r.ok && r.message).toBe(MESSAGES.undone);
    expect(await read(repo)).toBe('<h1>old</h1>\n');
    const head = await G.headSha(repo);
    expect(head).not.toBe(mergeCommit);
    expect((await G.git(repo, ['rev-parse', `${head}^`])).trim()).toBe(mergeCommit); // 新提交在合并提交之上
    expect(await G.isClean(repo)).toBe(true);
    const t = (await runner.store.get(id))!;
    expect(t.state).toBe('undone');
    expect(t.op).toMatchObject({ kind: 'undo', phase: 'finished', undoCommit: head });
    // 已撤销的任务不能再撤销
    expect(await runner.undo(id)).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('撤销被拒：保存之后项目又有了新提交', async () => {
    const { repo, runner, id } = await confirmed();
    await runner.save(id, { confirmUnchecked: true });
    await fs.writeFile(path.join(repo, 'later.txt'), 'x');
    await G.git(repo, ['add', '-A']);
    await G.git(repo, ['commit', '-m', 'later commit']);
    const head = await G.headSha(repo);
    const r = await runner.undo(id);
    expect(r).toMatchObject({ ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused });
    expect(await G.headSha(repo)).toBe(head);
    expect((await runner.store.get(id))!.state).toBe('saved');
  });

  it('撤销被拒：工作区有未提交改动；分支不一致', async () => {
    const a = await confirmed();
    await a.runner.save(a.id, { confirmUnchecked: true });
    await fs.writeFile(path.join(a.repo, 'index.html'), 'dirty\n');
    expect(await a.runner.undo(a.id)).toMatchObject({ ok: false, reason: 'undo_refused', files: ['index.html'] });
    expect(await read(a.repo)).toBe('dirty\n'); // 用户的改动原样保留

    const b = await confirmed();
    await b.runner.save(b.id, { confirmUnchecked: true });
    await G.git(b.repo, ['checkout', '-b', 'elsewhere']);
    expect(await b.runner.undo(b.id)).toMatchObject({ ok: false, reason: 'undo_refused' });
  });
});

describe('B4-1 清理失败与重试', () => {
  it('保存后清理失败：进入 saved_cleanup_pending，不吞错，可重试', async () => {
    const { repo, runner, id, task } = await confirmed();
    await G.git(repo, ['worktree', 'lock', task.worktree!.path]); // 被锁定的副本无法 remove --force
    const r = await runner.save(id, { confirmUnchecked: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toContain(MESSAGES.saveCleanupPending);
    expect(r.cleanup.ok).toBe(false);
    expect(r.cleanup.steps.find((s) => s.step === 'worktree_remove')).toMatchObject({ ok: false });
    expect(r.cleanup.steps.find((s) => s.step === 'worktree_remove')?.error).toBeTruthy();
    const t = (await runner.store.get(id))!;
    expect(t.state).toBe('saved_cleanup_pending');
    expect(t.cleanup?.steps.some((s) => !s.ok)).toBe(true);
    expect(await read(repo)).toBe('<h1>new</h1>\n'); // 保存本身已经成功

    const again = await runner.retryCleanup(id); // 仍被锁定 → 仍然失败，状态不变
    expect(again).toMatchObject({ ok: false, reason: 'cleanup_pending' });
    expect((await runner.store.get(id))!.state).toBe('saved_cleanup_pending');

    await G.git(repo, ['worktree', 'unlock', task.worktree!.path]);
    const ok = await runner.retryCleanup(id);
    expect(ok.ok).toBe(true);
    expect((await runner.store.get(id))!.state).toBe('saved');
    expect(await exists(task.worktree!.path)).toBe(false);
    expect(await branchExists(repo, task.worktree!.branch)).toBe(false);
  });

  it('放弃时清理失败：discard_cleanup_pending，可重试', async () => {
    const { repo, runner, id, task } = await confirmed();
    await G.git(repo, ['worktree', 'lock', task.worktree!.path]);
    const r = await runner.discard(id);
    expect(r.ok && r.message).toBe(MESSAGES.discardCleanupPending);
    expect((await runner.store.get(id))!.state).toBe('discard_cleanup_pending');
    await G.git(repo, ['worktree', 'unlock', task.worktree!.path]);
    expect((await runner.retryCleanup(id)).ok).toBe(true);
    expect((await runner.store.get(id))!.state).toBe('discarded');
  });
});

describe('B4-1 启动核对（reconcileTasks）', () => {
  /** 模拟“合并后、记录前中断”：任务提交与合并都已在 Git 里，但任务记录还停在验收阶段 */
  async function interruptedAfterMerge() {
    const s = await confirmed();
    const t = (await s.runner.store.get(s.id))!;
    const preHead = await G.headSha(s.repo);
    const taskCommit = await G.commitTree(t.worktree!.path, t.acceptedTree!, t.worktree!.baseSha, 'studio: x');
    await G.git(s.repo, ['merge', '--no-ff', '-m', 'studio: 保存', taskCommit]);
    t.op = { kind: 'save', startedAt: new Date().toISOString(), phase: 'task_committed', preHead, taskCommit, steps: [] };
    await s.runner.store.save(t);
    return { ...s, preHead, taskCommit };
  }

  it('合并后、记录前中断：按 Git 真实状态修正为 saved，并完成清理', async () => {
    const x = await interruptedAfterMerge();
    const fresh = new TaskRunner({ repo: x.repo, executor: new FakeExecutor([]), runChecks: false }); // 模拟应用重启
    const out = await fresh.reconcileTasks();
    expect(out.map((o) => o.taskId)).toEqual([x.id]);
    const t = (await fresh.store.get(x.id))!;
    expect(t.state).toBe('saved');
    expect(t.saveRecord).toMatchObject({ preMergeHead: x.preHead, taskCommit: x.taskCommit, mergeCommit: await G.headSha(x.repo) });
    expect(t.op).toMatchObject({ phase: 'finished' });
    expect(await exists(t.worktree!.path)).toBe(false);
    expect(await fresh.reconcileTasks()).toEqual([]); // 幂等
    expect((await fresh.undo(x.id)).ok).toBe(true); // 修正后的记录足以支持撤销
  });

  it('合并前中断（任务提交已生成、合并没发生）：项目保持原样，任务仍可保存', async () => {
    const s = await confirmed();
    const t = (await s.runner.store.get(s.id))!;
    const preHead = await G.headSha(s.repo);
    const taskCommit = await G.commitTree(t.worktree!.path, t.acceptedTree!, t.worktree!.baseSha, 'studio: x');
    t.op = { kind: 'save', startedAt: new Date().toISOString(), phase: 'task_committed', preHead, taskCommit, steps: [] };
    await s.runner.store.save(t);
    const fresh = new TaskRunner({ repo: s.repo, executor: new FakeExecutor([]), runChecks: false });
    const out = await fresh.reconcileTasks();
    expect(out[0]?.action).toContain('项目保持原样');
    expect((await fresh.store.get(s.id))!.state).toBe('reviewing');
    expect((await fresh.save(s.id, { confirmUnchecked: true })).ok).toBe(true);
  });

  it('无法判定：标“需要人工查看”，不自动动手', async () => {
    const s = await confirmed();
    const t = (await s.runner.store.get(s.id))!;
    t.op = { kind: 'save', startedAt: new Date().toISOString(), phase: 'task_committed', preHead: await G.headSha(s.repo), taskCommit: 'f'.repeat(40), steps: [] };
    await s.runner.store.save(t);
    await fs.writeFile(path.join(s.repo, 'index.html'), 'user is editing\n'); // 项目里有未提交改动，无法判断合并是否发生
    const fresh = new TaskRunner({ repo: s.repo, executor: new FakeExecutor([]), runChecks: false });
    const out = await fresh.reconcileTasks();
    expect(out[0]?.action).toContain('需要人工查看');
    const after = (await fresh.store.get(s.id))!;
    expect(after.manualReview?.reason).toBeTruthy();
    expect(after.state).toBe('reviewing');
    expect(await read(s.repo)).toBe('user is editing\n');
    expect(await exists(after.worktree!.path)).toBe(true);
  });

  it('放弃中断：继续清理并记为 discarded', async () => {
    const s = await confirmed();
    const t = (await s.runner.store.get(s.id))!;
    t.op = { kind: 'discard', startedAt: new Date().toISOString(), phase: 'started', steps: [] };
    await s.runner.store.save(t);
    const fresh = new TaskRunner({ repo: s.repo, executor: new FakeExecutor([]), runChecks: false });
    await fresh.reconcileTasks();
    expect((await fresh.store.get(s.id))!.state).toBe('discarded');
    expect(await exists(t.worktree!.path)).toBe(false);
  });

  it('撤销提交已在分支上、记录没来得及更新：修正为 undone', async () => {
    const s = await confirmed();
    const saved = await s.runner.save(s.id, { confirmUnchecked: true });
    expect(saved.ok).toBe(true);
    const t = (await s.runner.store.get(s.id))!;
    await G.restoreTo(s.repo, t.saveRecord!.preMergeHead, 'studio: 撤销');
    t.op = { kind: 'undo', startedAt: new Date().toISOString(), phase: 'started', preHead: t.saveRecord!.mergeCommit, steps: [] };
    await s.runner.store.save(t);
    const fresh = new TaskRunner({ repo: s.repo, executor: new FakeExecutor([]), runChecks: false });
    await fresh.reconcileTasks();
    expect((await fresh.store.get(s.id))!.state).toBe('undone');
  });
});
