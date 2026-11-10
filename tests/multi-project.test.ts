import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenProjectManager } from '../src/core/app/open-projects.js';
import { classifyTaskState } from '../src/core/app/task-state-view.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import type { Task } from '../src/core/task/model.js';
import type { TaskState } from '../src/core/task/state.js';

const tmpDirs: string[] = [];
const stores: RecordStore[] = [];

function mk(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-multi-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function initGitRepo(name: string, files: Record<string, string> = { 'index.html': '<h1>init</h1>\n' }): string {
  const repo = path.join(mk('repo'), name);
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

async function openProjectIn(
  mgr: OpenProjectManager<RecordStore>,
  dataDir: string,
  id: string,
  repo: string,
  makeExecutor: () => FakeExecutor,
): Promise<TaskController> {
  const ctl = new TaskController({
    repo,
    makeExecutor,
    pickDirectory: async () => null,
    prefs: new TaskPrefs(dataDir),
    openPreview: async () => undefined,
  });
  const rs = await ctl.openRecordStore();
  stores.push(rs);
  mgr.open({ id, path: repo, name: path.basename(repo), controller: ctl, recordStore: rs });
  return ctl;
}

async function waitForState(ctl: TaskController, taskId: string, states: TaskState[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const view = await ctl.get(taskId);
    if (states.includes(view.state)) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`任务 ${taskId} 未进入目标状态 ${states.join(',')}`);
}

async function startStandardTask(ctl: TaskController, request: string, criteria: string[] = []): Promise<string> {
  const t = await ctl.create(request);
  await ctl.savePlan(t.id, { goal: request, criteria, mode: 'standard', network: false });
  await ctl.start(t.id, false);
  return t.id;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await RecordStore.closeAll().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('多项目后台与工作台汇总（阶段 2 第一部分）', () => {
  it('同时打开两个项目分别施工互不干扰，项目级 manualReview 锁只锁定所在项目', async () => {
    const dataDir = mk('appdata');
    const repoA = initGitRepo('project-a', { 'a.txt': 'a0\n' });
    const repoB = initGitRepo('project-b', { 'b.txt': 'b0\n' });
    const mgr = new OpenProjectManager<RecordStore>();

    const ctlA = await openProjectIn(
      mgr,
      dataDir,
      'proj-a',
      repoA,
      () => new FakeExecutor((prompt) => (prompt.includes('待保存') ? [{ do: 'write', path: 'a.txt', content: 'a1\n' }] : [{ do: 'hang' }])),
    );
    const ctlB = await openProjectIn(mgr, dataDir, 'proj-b', repoB, () => new FakeExecutor([{ do: 'write', path: 'b.txt', content: 'b1\n' }]));
    expect(mgr.size).toBe(2);

    // 项目 A 启动持续运行任务
    const taskAId = await startStandardTask(ctlA, '项目 A 长任务');
    await waitForState(ctlA, taskAId, ['running']);

    // 在项目 A 中再写入一个处于 manualReview 的异常任务（项目级锁）
    const blockerA = await ctlA.create('项目 A 恢复未确认');
    const rsA = await ctlA.openRecordStore();
    stores.push(rsA);
    const { TaskStore } = await import('../src/core/task/store.js');
    const tsA = new TaskStore(repoA);
    const rawBlocker = (await tsA.get(blockerA.id))!;
    rawBlocker.manualReview = { reason: '恢复结果未确认', at: new Date().toISOString() };
    await tsA.save(rawBlocker);

    // 项目 B 同时创建、执行、预览并保存，完全不受项目 A 的 running 和 manualReview 影响
    const taskBId = await startStandardTask(ctlB, '更新 b.txt');
    await waitForState(ctlB, taskBId, ['reviewing']);
    expect((await ctlA.get(taskAId)).state).toBe('running');
    expect(ctlA.isTaskActive(taskAId)).toBe(true);

    let accB = await ctlB.getAcceptanceView(taskBId);
    accB = (accB.preview?.kind ? await ctlB.openPreview(taskBId, accB.version) : await ctlB.skipPreview(taskBId, accB.version)).view;
    accB = (await ctlB.confirmOverall(taskBId, accB.version)).view;
    const uncheckedB = await ctlB.saveTask(taskBId, accB.version);
    expect(uncheckedB.ok).toBe(false);
    expect(uncheckedB.view.uncheckedConfirm).not.toBeNull();
    const savedB = await ctlB.saveUncheckedTask(taskBId, uncheckedB.view.version);
    expect(savedB.ok).toBe(true);
    expect(savedB.view.state).toBe('saved');
    expect(fs.readFileSync(path.join(repoB, 'b.txt'), 'utf8')).toBe('b1\n');
    expect(fs.readFileSync(path.join(repoA, 'a.txt'), 'utf8')).toBe('a0\n');

    // 验证项目 B 撤销也正常（不受项目 A manualReview 锁阻拦）
    const undoneB = await ctlB.undoSave(taskBId);
    expect(undoneB.ok).toBe(true);
    expect(fs.readFileSync(path.join(repoB, 'b.txt'), 'utf8')).toBe('b0\n');

    // 停掉项目 A 第一个任务后，检查项目 A 的另一个待保存任务仍会被项目 A 自己的 manualReview 锁住
    await ctlA.stop(taskAId);
    const taskA2Id = await startStandardTask(ctlA, '项目 A 待保存任务');
    await waitForState(ctlA, taskA2Id, ['reviewing']);
    let accA2 = await ctlA.getAcceptanceView(taskA2Id);
    accA2 = (accA2.preview?.kind ? await ctlA.openPreview(taskA2Id, accA2.version) : await ctlA.skipPreview(taskA2Id, accA2.version)).view;
    accA2 = (await ctlA.confirmOverall(taskA2Id, accA2.version)).view;
    const lockedRes = await ctlA.saveTask(taskA2Id, accA2.version);
    expect(lockedRes.ok).toBe(false);
    expect(lockedRes.message).toContain('项目 A 恢复未确认');
    expect(fs.readFileSync(path.join(repoA, 'a.txt'), 'utf8')).toBe('a0\n');
  });

  it('有任务施工中时拒绝关闭项目；停止后允许关闭并释放存储锁；伪造 projectId 立即拒绝', async () => {
    const dataDir = mk('appdata');
    const repoA = initGitRepo('close-a');
    const repoB = initGitRepo('close-b');
    const mgr = new OpenProjectManager<RecordStore>();

    const ctlA = await openProjectIn(mgr, dataDir, 'proj-a', repoA, () => new FakeExecutor([{ do: 'hang' }]));
    await openProjectIn(mgr, dataDir, 'proj-b', repoB, () => new FakeExecutor([]));

    const taskAId = await startStandardTask(ctlA, '运行中的任务');
    await waitForState(ctlA, taskAId, ['running']);

    // 有任务正在施工时拒绝关闭
    const refused = await mgr.close('proj-a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('正在施工或处理中');
    expect(mgr.has('proj-a')).toBe(true);
    expect(mgr.size).toBe(2);

    // 伪造或未打开的 projectId 立即抛错且不动现有项目
    for (const forged of ['../evil', 'unknown-id', '', null, 42]) {
      expect(() => mgr.require(forged)).toThrow();
      await expect(mgr.close(forged)).rejects.toThrow();
    }
    expect(mgr.size).toBe(2);

    // 停止后可正常关闭，且关闭后原 projectId 也被拒绝、存储锁已释放可再次打开
    await ctlA.stop(taskAId);
    await waitForState(ctlA, taskAId, ['reviewing']);
    const ok = await mgr.close('proj-a');
    expect(ok).toEqual({ ok: true });
    expect(mgr.has('proj-a')).toBe(false);
    expect(() => mgr.require('proj-a')).toThrow(/找不到这个已打开的项目/);
    expect(mgr.activeId).toBe('proj-b');

    const reopened = await openProjectIn(mgr, dataDir, 'proj-a', repoA, () => new FakeExecutor([]));
    expect((await reopened.list()).tasks).toHaveLength(1);
  });

  it('workbench:get 正确汇总所有已打开项目的三组任务、计数、异常优先排序与影响文案', async () => {
    const dataDir = mk('appdata');
    const repoA = initGitRepo('wb-a', { 'a.txt': 'a0\n' });
    const repoB = initGitRepo('wb-b', { 'b.txt': 'b0\n' });
    const mgr = new OpenProjectManager<RecordStore>();

    const ctlA = await openProjectIn(mgr, dataDir, 'wb-a', repoA, () => new FakeExecutor([{ do: 'hang' }]));
    const ctlB = await openProjectIn(mgr, dataDir, 'wb-b', repoB, () => new FakeExecutor([{ do: 'write', path: 'b.txt', content: 'b1\n' }]));

    // A: 1 个运行中 + 1 个草稿（待决定）
    const tRunId = await startStandardTask(ctlA, 'A 运行任务');
    await waitForState(ctlA, tRunId, ['running']);
    await ctlA.create('A 草稿任务');

    // B: 1 个已保存（最近结束） + 1 个恢复未确认异常（待决定且排最前）
    const tSaveId = await startStandardTask(ctlB, 'B 保存任务');
    await waitForState(ctlB, tSaveId, ['reviewing']);
    let vB = await ctlB.getAcceptanceView(tSaveId);
    vB = (vB.preview?.kind ? await ctlB.openPreview(tSaveId, vB.version) : await ctlB.skipPreview(tSaveId, vB.version)).view;
    vB = (await ctlB.confirmOverall(tSaveId, vB.version)).view;
    vB = (await ctlB.saveTask(tSaveId, vB.version)).view;
    await ctlB.saveUncheckedTask(tSaveId, vB.version);

    const tLock = await ctlB.create('B 异常锁定');
    const { TaskStore } = await import('../src/core/task/store.js');
    const tsB = new TaskStore(repoB);
    const rawLock = (await tsB.get(tLock.id))!;
    rawLock.manualReview = { reason: '恢复结果未确认', at: new Date().toISOString() };
    await tsB.save(rawLock);

    const wb = await mgr.getWorkbench();
    expect(wb.counts).toEqual({ needsDecision: 2, running: 1, recentEnded: 1 });
    expect(wb.needsDecision).toHaveLength(2);
    expect(wb.running).toHaveLength(1);
    expect(wb.recentEnded).toHaveLength(1);

    // 异常任务排在 needsDecision 第一位
    expect(wb.needsDecision[0]!.taskName).toBe('B 异常锁定');
    expect(wb.needsDecision[0]!.isAbnormal).toBe(true);
    expect(wb.needsDecision[0]!.projectId).toBe('wb-b');
    expect(wb.needsDecision[1]!.taskName).toBe('A 草稿任务');
    expect(wb.needsDecision[1]!.projectId).toBe('wb-a');
    expect(wb.running[0]!.taskName).toBe('A 运行任务');
    expect(wb.recentEnded[0]!.taskName).toBe('B 保存任务');
    expect(wb.recentEnded[0]!.nextAction.kind).toBe('open_history');

    // 汇总项目列表上的数字准确
    const sumA = wb.projects.find((p) => p.id === 'wb-a')!;
    const sumB = wb.projects.find((p) => p.id === 'wb-b')!;
    expect(sumA).toMatchObject({ needsAttentionCount: 1, runningCount: 1, manualReviewLocked: false });
    expect(sumB).toMatchObject({ needsAttentionCount: 1, runningCount: 0, manualReviewLocked: true, hasAbnormal: true });

    // 影响文案不含原始命令
    for (const item of [...wb.needsDecision, ...wb.running, ...wb.recentEnded]) {
      expect(item.impact.length).toBeGreaterThan(0);
      expect(item.impact).not.toMatch(/`|\bgit\s|npm\s/);
    }

    await ctlA.stop(tRunId);
  });

  it('classifyTaskState 静态穷举覆盖 TaskState 全部 17 种状态与三层标签映射（B5 单元测试）', () => {
    const baseTask = (state: TaskState, extra: Partial<Task> = {}): Task => ({
      id: `t-${state}`,
      request: '示例任务',
      state,
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
      denied: [],
      deniedAcks: [],
      previewed: false,
      criteria: [],
      timeline: [],
      ...extra,
    });

    const allStates: TaskState[] = [
      'draft',
      'clarifying',
      'planned',
      'approved',
      'running',
      'exec_succeeded',
      'exec_failed',
      'stopped',
      'timed_out',
      'reviewing',
      'saved',
      'saved_cleanup_pending',
      'save_failed_unmerged',
      'discarded',
      'discard_cleanup_pending',
      'undone',
      'undo_failed',
    ];

    expect(allStates).toHaveLength(17);

    for (const s of allStates) {
      const cls = classifyTaskState(baseTask(s));
      expect(cls.impact.length, s).toBeGreaterThan(0);
      expect(cls.statusTag.length, s).toBeGreaterThan(0);
      expect(['building', 'reviewing', 'ended']).toContain(cls.stage);
      if (cls.stage !== 'ended') expect(cls.outcome).toBeNull();
      else expect(['saved', 'discarded', 'terminated']).toContain(cls.outcome);
    }

    expect(classifyTaskState(baseTask('draft'))).toMatchObject({ stage: 'building', runStatus: '待配置计划', outcome: null, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('approved'), { isLiveRunning: false })).toMatchObject({ stage: 'building', runStatus: '待开工确认', isRunning: false, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('approved'), { isLiveRunning: true })).toMatchObject({ stage: 'building', runStatus: '运行中', isRunning: true, workbenchGroup: 'running' });
    expect(classifyTaskState(baseTask('running'))).toMatchObject({ stage: 'building', runStatus: '运行中', isRunning: true, workbenchGroup: 'running' });
    expect(classifyTaskState(baseTask('exec_succeeded'), { isLiveRunning: true })).toMatchObject({ stage: 'building', runStatus: '运行中', workbenchGroup: 'running' });
    expect(classifyTaskState(baseTask('exec_succeeded'), { isLiveRunning: false })).toMatchObject({ stage: 'building', runStatus: '运行中', workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('reviewing', { exit: { kind: 'stopped' } }))).toMatchObject({ stage: 'reviewing', runStatus: '已停止', outcome: null, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('reviewing', { manualReview: { reason: '未确认', at: '2026-11-10T00:00:00.000Z' } }))).toMatchObject({ stage: 'reviewing', runStatus: '已锁定', isAbnormal: true, needsAttention: true, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('save_failed_unmerged'))).toMatchObject({ stage: 'reviewing', runStatus: '被阻断', isAbnormal: true, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('saved', { saveRecord: { savedAt: '2026-11-10T00:00:00.000Z', mergeCommit: 'abc', preMergeHead: 'def', taskCommit: 'ghi', branch: 'main', checked: true } }))).toMatchObject({ stage: 'ended', runStatus: null, outcome: 'saved', outcomeLabel: '已保存', statusTag: '已保存', workbenchGroup: 'recent_ended' });
    expect(classifyTaskState(baseTask('saved_cleanup_pending'))).toMatchObject({ stage: 'ended', runStatus: '被阻断', outcome: 'saved', isAbnormal: true, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('discarded'))).toMatchObject({ stage: 'ended', runStatus: null, outcome: 'discarded', outcomeLabel: '已放弃', workbenchGroup: 'recent_ended' });
    expect(classifyTaskState(baseTask('discard_cleanup_pending'))).toMatchObject({ stage: 'ended', runStatus: '被阻断', outcome: 'terminated', isAbnormal: true, workbenchGroup: 'needs_decision' });
    expect(classifyTaskState(baseTask('undone'))).toMatchObject({ stage: 'ended', runStatus: '已撤销保存', outcome: 'terminated', outcomeLabel: '未完成而终止', workbenchGroup: 'recent_ended' });
    expect(classifyTaskState(baseTask('undo_failed'))).toMatchObject({ stage: 'ended', runStatus: '失败', outcome: 'saved', isAbnormal: true, workbenchGroup: 'needs_decision' });
  });
});
