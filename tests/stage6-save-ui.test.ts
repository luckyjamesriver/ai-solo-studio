import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskController, type AcceptanceActionResult } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import {
  buildSaveOutcomeFromFail,
  buildSaveOutcomeView,
  type SaveOutcomeButton,
  type SaveOutcomeView,
  type UserAcceptanceView,
} from '../src/core/acceptance/view.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import type { Executor } from '../src/core/executor/types.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { TaskRunner } from '../src/core/task/runner.js';
import type { SaveProgressEvent } from '../src/core/task/model.js';
import { SaveResultPanel } from '../src/renderer/SaveResultPanel.js';
import { SaveConflictPage } from '../src/renderer/SaveConflictPage.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir, testSandboxRunner } from './helpers.js';

const cleanDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await tmpDir(prefix);
  cleanDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function setupTaskToReviewing(opts: {
  files?: Record<string, string>;
  script?: FakeStep[];
  sandbox?: boolean;
  sandboxRunner?: ReturnType<typeof testSandboxRunner>;
  onSaveProgress?: (ev: SaveProgressEvent) => void;
} = {}) {
  const repo = await makeRepo(opts.files ?? { 'index.html': '<h1>old</h1>\n' });
  cleanDirs.push(repo);
  const data = await makeTempDir('data-s6-');
  const script = opts.script ?? [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor(script, { emitPermissions: true });
      if (opts.sandboxRunner) (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = opts.sandboxRunner;
      else if (opts.sandbox) (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
      return ex;
    },
    pickDirectory: async () => null,
    prefs: new TaskPrefs(data),
    ...(opts.onSaveProgress ? { onSaveProgress: opts.onSaveProgress } : {}),
  });
  const created = await ctl.create('改标题');
  await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
  await ctl.start(created.id, false);
  const view = await until(async () => {
    const v = await ctl.getAcceptanceView(created.id);
    return v.state === 'reviewing' && !v.busy ? v : false;
  });
  return { repo, data, ctl, id: created.id, view };
}

async function confirmAll(ctl: TaskController, id: string): Promise<UserAcceptanceView> {
  let v = await ctl.getAcceptanceView(id);
  for (const c of v.criteria) v = (await ctl.confirmCriterion(id, c.id, v.version)).view;
  if (v.overall.needed) v = (await ctl.confirmOverall(id, v.version)).view;
  for (const d of v.denied) v = (await ctl.ackDenied(id, d.id, v.version)).view;
  return v;
}

describe('阶段 6 提交①：保存过程实时进度与 8 类结果视图', () => {
  it('保存进度事件严格按真实执行顺序发出（检查变化 → 合并 → 合并后检查 → 写入前核对），不跳过不伪造', async () => {
    const events: SaveProgressEvent[] = [];
    const { repo, ctl, id } = await setupTaskToReviewing({
      sandbox: true,
      files: {
        'package.json': JSON.stringify({
          name: 's6-progress',
          scripts: {
            build: 'node -e "process.exit(0)"',
            test: 'node -e "console.log(\'Tests  3 passed\'); process.exit(0)"',
          },
        }),
        'index.html': '<h1>v0</h1>\n',
        'other.txt': 'v0\n',
      },
      onSaveProgress: (ev) => events.push(structuredClone(ev)),
    });

    // 在另一个任务（或先行保存）刚推进了一步不冲突的改动，检验第一步提示「有：<任务名> 刚保存过」与第二步提示「改的是不同文件，已自动合并」
    const otherTask = await ctl.create('页脚微调');
    expect(otherTask.id).toBeTruthy();
    await fs.writeFile(path.join(repo, 'other.txt'), 'v1\n');
    await G_commit(repo, 'studio: 保存「页脚微调」', 'other.txt');

    const ready = await confirmAll(ctl, id);
    const res = await ctl.saveTask(id, ready.version);
    expect(res.ok).toBe(true);

    // 事件顺序必须真实对应 4 步状态迁移
    expect(events.length).toBeGreaterThanOrEqual(5);
    const runningOrder = events
      .filter((e) => !e.finished)
      .map((e) => e.saveSteps.find((s) => s.status === 'running')?.key);
    expect(runningOrder).toEqual(['check_changes', 'trial_merge', 'trial_checks', 'final_verify']);
    const lastEv = events.at(-1)!;
    expect(lastEv.finished).toBe(true);
    expect(lastEv.saveSteps.every((s) => s.status === 'done')).toBe(true);
    expect(lastEv.saveSteps[0]!.detail).toContain('页脚微调');
    expect(lastEv.saveSteps[0]!.detail).toContain('刚保存过');
    expect(lastEv.saveSteps[1]!.detail).toBe('改的是不同文件，已自动合并');
    expect(lastEv.saveSteps[2]!.detail).toBe('构建与 3 项测试通过');
    expect(lastEv.saveSteps[3]!.detail).toContain('已写入主项目');

    expect(res.saveOutcome).toMatchObject({
      kind: 'saved',
      tag: '已保存',
      warn: false,
      headline: '已保存。可以在保存记录里撤销',
    });
    expect(res.saveOutcome!.buttons.map((b) => [b.action, b.label, !!b.primary])).toEqual([
      ['done', '完成', true],
      ['view_history', '查看保存记录', false],
    ]);
  });

  it('精确生成所有 8 种保存结果的文案、标签与按钮（含 checks_failed 试检查依据、project_changed、failed_restored、manualReview、project_locked）', async () => {
    // 1) checks_failed：试检查不通过 → 不保存、保留主项目、展示失败项和退回修改主按钮并附试检查依据
    const { repo, ctl, id } = await setupTaskToReviewing({
      files: {
        'package.json': JSON.stringify({
          name: 's6-fail-checks',
          scripts: {
            build: 'node -e "process.exit(0)"',
            test: 'node -e "if (require(\'fs\').existsSync(\'trigger.txt\')) { console.log(\'× case A\\n× case B\\nTests  2 failed | 1 passed\'); process.exit(1); } process.exit(0)"',
          },
        }),
        'index.html': '<h1>v0</h1>\n',
      },
      sandbox: true,
    });
    const ready = await confirmAll(ctl, id);
    await fs.writeFile(path.join(repo, 'trigger.txt'), 'break merged test\n');
    await G_commit(repo, 'trigger merged failure');

    const failRes: AcceptanceActionResult = await ctl.saveTask(id, ready.version);
    expect(failRes.ok).toBe(false);
    expect(failRes.view.state).toBe('reviewing');
    expect(failRes.view.saveOutcome).toMatchObject({
      kind: 'checks_failed',
      tag: '检查失败',
      warn: true,
      headline: '合并后有 2 项检查没通过，没有保存，你的项目没有变化',
    });
    expect(failRes.view.saveOutcome!.failedChecks).toEqual([
      { key: 'test', label: '自动测试', summary: '2 项测试未通过' },
    ]);
    expect(failRes.view.saveOutcome!.buttons[0]).toMatchObject({ action: 'rework', label: '退回修改', primary: true });
    expect(failRes.view.trialProof?.test.status).toBe('failed');
    expect(failRes.view.trialProof?.test.failedCount).toBe(2);

    const htmlFail = renderToStaticMarkup(
      createElement(SaveResultPanel, {
        liveSteps: null,
        outcome: failRes.view.saveOutcome!,
        busy: false,
        onAction: (_b: SaveOutcomeButton) => {},
      }),
    );
    expect(htmlFail).toContain('合并后有 2 项检查没通过，没有保存，你的项目没有变化');
    expect(htmlFail).toContain('退回修改');

    // 2) unchecked_needs_confirm：打开预览为主按钮，仍然保存为次要按钮
    const unchecked = buildSaveOutcomeFromFail({
      ok: false,
      reason: 'unchecked_needs_confirm',
      detail: 'x',
      uncheckedKind: 'none',
    });
    expect(unchecked.kind).toBe('unchecked_needs_confirm');
    expect(unchecked.buttons).toEqual([
      { action: 'open_preview', label: '打开预览', primary: true },
      { action: 'save_unchecked', label: '仍然保存' },
    ]);

    // 3) conflict
    const conflictOut = buildSaveOutcomeFromFail({ ok: false, reason: 'conflict', detail: 'x' });
    expect(conflictOut).toMatchObject({ kind: 'conflict', tag: '冲突' });
    expect(conflictOut.buttons[0]).toMatchObject({ action: 'open_conflict', primary: true });

    // 4) project_changed
    const changedOut = buildSaveOutcomeFromFail({ ok: false, reason: 'project_changed', detail: 'x' });
    expect(changedOut).toMatchObject({
      kind: 'project_changed',
      headline: '检查期间项目又有新的改动，没有保存',
    });
    expect(changedOut.buttons).toEqual([{ action: 'retry_save', label: '重新保存', primary: true }]);

    // 5) failed_restored
    const restoredOut = buildSaveOutcomeFromFail({ ok: false, reason: 'failed_restored', detail: 'x' });
    expect(restoredOut).toMatchObject({
      kind: 'failed_restored',
      headline: '写入时出错，已把项目恢复并核对过与保存前一致；成果仍在任务副本里',
    });
    expect(restoredOut.buttons).toEqual([{ action: 'retry_save', label: '重试', primary: true }]);

    // 6) manual_review（列出受影响文件 + 锁定全项目说明）
    const manualOut = buildSaveOutcomeFromFail({
      ok: false,
      reason: 'abnormal',
      detail: 'x',
      files: ['src/app.ts', 'package.json'],
    });
    expect(manualOut).toMatchObject({
      kind: 'manual_review',
      headline: '写入中途出错，无法确认项目是否完好。已停止一切写入。',
      extraNote: '处理完之前，这个项目的所有任务都不能保存或撤销',
      files: ['src/app.ts', 'package.json'],
    });
    expect(manualOut.buttons.map((b) => b.action)).toEqual(['reveal_project', 'copy_summary']);

    // 7) project_locked（含去处理按钮及阻塞任务 id）
    const lockedOut = buildSaveOutcomeFromFail({
      ok: false,
      reason: 'project_locked',
      detail: 'x',
      blockingTaskId: 'task-a-1',
      blockingTask: '异常任务甲',
    });
    expect(lockedOut).toMatchObject({
      kind: 'project_locked',
      headline: '异常任务甲 的保存出了问题还没处理，这个项目暂时不能保存',
      blockingTaskId: 'task-a-1',
      blockingTaskGoal: '异常任务甲',
    });
    expect(lockedOut.buttons).toEqual([
      { action: 'open_blocking_task', label: '去处理', primary: true, targetTaskId: 'task-a-1' },
    ]);

    // 验证 buildSaveOutcomeView 对 undo_refused 带出「没有改动任何文件」
    const undoRefused: SaveOutcomeView = buildSaveOutcomeView(
      { reason: 'undo_refused', at: '2026-11-11T00:00:00Z', saveSteps: [] },
      { isUndo: true },
    );
    expect(undoRefused.headline).toContain('没有改动任何文件');
  });

  it('项目锁定真实控制器路径：任务 A 进入 manualReview，任务 B 验收视图与保存结果均带去处理跳转目标', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    cleanDirs.push(repo);
    const data = await makeTempDir('data-lock-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([{ do: 'write', path: 'index.html', content: '<h1>b</h1>\n' }, { do: 'exit', code: 0 }]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });

    const a = await ctl.create('异常任务 A');
    const runner = new TaskRunner({ repo, executor: new FakeExecutor([]) });
    const rawA = (await runner.store.get(a.id))!;
    rawA.manualReview = { reason: '写入中途出错', at: '2026-11-11T00:00:00Z', files: ['index.html'] };
    await runner.store.save(rawA);

    const b = await ctl.create('任务 B');
    await ctl.savePlan(b.id, { goal: '任务 B', criteria: [], mode: 'standard', network: false });
    await ctl.start(b.id, false);
    const vb0 = await until(async () => {
      const v = await ctl.getAcceptanceView(b.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    const vb1 = await confirmAll(ctl, b.id);
    expect(vb1.saveOutcome).toMatchObject({
      kind: 'project_locked',
      blockingTaskId: a.id,
      blockingTaskGoal: '异常任务 A',
    });
    expect(vb1.saveOutcome!.buttons[0]).toMatchObject({
      action: 'open_blocking_task',
      label: '去处理',
      targetTaskId: a.id,
    });
    // 任务 B 直接调用 saveTask 也会返回相同结果与去处理目标
    const res = await ctl.saveTask(b.id, vb0.version);
    expect(res.ok).toBe(false);
  });
});

describe('阶段 6 提交②：保存冲突专页与基于最新项目重做（#11-save-conflict）', () => {
  it('两个任务修改同一文件导致冲突：定位关联已保存任务、展示双边片段对照、重做更新副本后第 2 轮保存成功', async () => {
    const repo = await makeRepo({
      'package.json': JSON.stringify({ name: 's6-c', scripts: { build: 'node -e "process.exit(0)"' } }),
      'shared.txt': 'line1\nline2\n',
      'extra.txt': 'init\n',
    });
    cleanDirs.push(repo);
    const data = await makeTempDir('data-s6-conflict-');

    let turn = 0;
    const baseEx = new FakeExecutor([]);
    const exWrapper: Executor = {
      id: baseEx.id,
      displayName: baseEx.displayName,
      capabilities: baseEx.capabilities,
      sandboxRunner: testSandboxRunner(),
      detect: () => baseEx.detect(),
      start: (opts) => {
        turn++;
        const steps: FakeStep[] =
          turn === 1
            ? [
                { do: 'write', path: 'shared.txt', content: 'from-task-A\nline2\n' },
                { do: 'exit', code: 0 },
              ]
            : turn === 2
              ? [
                  { do: 'write', path: 'shared.txt', content: 'from-task-B\nline2\n' },
                  { do: 'write', path: 'extra.txt', content: 'from-task-B-extra\n' },
                  { do: 'exit', code: 0 },
                ]
              : [
                  { do: 'write', path: 'shared.txt', content: 'from-task-A + from-task-B\nline2\n' },
                  { do: 'exit', code: 0 },
                ];
        const inner = new FakeExecutor(steps);
        (inner as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return inner.start(opts);
      },
    };
    const ctl = new TaskController({
      repo,
      makeExecutor: () => exWrapper,
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });

    // 任务 A、B 均在相同初始基线上开工
    const a = await ctl.create('改进顶部标题');
    await ctl.savePlan(a.id, { goal: '改进顶部标题', criteria: [], mode: 'standard', network: false });
    const b = await ctl.create('重构页眉样式');
    await ctl.savePlan(b.id, { goal: '重构页眉样式', criteria: [], mode: 'standard', network: false });

    await ctl.start(a.id, false);
    await until(async () => {
      const v = await ctl.getAcceptanceView(a.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    await ctl.start(b.id, false);
    await until(async () => {
      const v = await ctl.getAcceptanceView(b.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });

    // 任务 A 先保存成功
    const vaReady = await confirmAll(ctl, a.id);
    const saveA = await ctl.saveTask(a.id, vaReady.version);
    expect(saveA.ok).toBe(true);

    // 任务 B 再保存：触发 shared.txt 冲突
    const vbReady = await confirmAll(ctl, b.id);
    const saveB = await ctl.saveTask(b.id, vbReady.version);
    expect(saveB.ok).toBe(false);
    expect(saveB.view.state).toBe('save_failed_unmerged');
    expect(saveB.view.conflict).toBeTruthy();

    const cv = saveB.view.conflict!;
    expect(cv.headline).toBe('没有保存');
    expect(cv.files).toEqual(['shared.txt']);
    expect(cv.otherLabel).toBe('改进顶部标题');
    expect(cv.otherTaskId).toBe(a.id);
    expect(cv.redoLabel).toBe('让 AI 在最新项目上重做这部分');
    expect(cv.deferLabel).toBe('先不处理');
    expect(cv.canRedo).toBe(true);
    expect(cv.diffs).toHaveLength(1);
    expect(cv.diffs[0]!.path).toBe('shared.txt');
    expect(cv.diffs[0]!.left.title).toContain('改进顶部标题');
    expect(cv.diffs[0]!.right.title).toContain('当前任务');
    expect(JSON.stringify(cv.diffs[0]!.left.preview)).toContain('from-task-A');
    expect(JSON.stringify(cv.diffs[0]!.right.preview)).toContain('from-task-B');
    expect(JSON.stringify(cv)).not.toMatch(/以这个任务为准|覆盖保存|git merge/);

    // B4-2 原有 actions 键集合保持完全不变
    expect(Object.keys(saveB.view.actions).sort()).toEqual(['discard', 'recheck', 'retryCleanup', 'save', 'undo']);

    // SaveConflictPage 渲染结果仅包含两个操作按钮，不含覆盖保存
    const html = renderToStaticMarkup(
      createElement(SaveConflictPage, {
        projectId: 'proj-1',
        taskId: b.id,
        conflict: cv,
        onStartedRedo: () => undefined,
        onDefer: () => undefined,
      }),
    );
    expect(html).toContain('让 AI 在最新项目上重做这部分');
    expect(html).toContain('先不处理');
    expect(html).not.toMatch(/以这个任务为准|覆盖保存|仍然保存/);

    // 点击「让 AI 在最新项目上重做这部分」→ 干净更新副本到最新主项目并跑完第 2 轮
    const redoRes = await ctl.reworkConflictTask(b.id);
    expect(redoRes.ok).toBe(true);
    const vB2 = await until(async () => {
      const v = await ctl.getAcceptanceView(b.id);
      return v.state === 'reviewing' && !v.busy && v.currentRound === 2 ? v : false;
    });
    const bTask = (await new TaskRunner({ repo, executor: new FakeExecutor([]) }).store.get(b.id))!;
    expect(bTask.currentRound).toBe(2);
    expect(bTask.rounds?.some((r) => r.round === 2 && r.feedback?.includes('改进顶部标题'))).toBe(true);
    expect(vB2.currentRound).toBe(2);

    // 确认第 2 轮并保存：非冲突改动 extra.txt 与最新合入结果一并保存成功，无冲突标记
    const vB2Ready = await confirmAll(ctl, b.id);
    const saveB2 = await ctl.saveTask(b.id, vB2Ready.version);
    expect(saveB2.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8')).toBe('from-task-A + from-task-B\nline2\n');
    expect(await fs.readFile(path.join(repo, 'extra.txt'), 'utf8')).toBe('from-task-B-extra\n');
  });

  it('找不到已保存任务记录时冲突来源显示「项目里后来的改动」；更新副本本身遇新冲突时立即中止、副本保持原样且不留冲突标记', async () => {
    const repo = await makeRepo({ 'shared.txt': 'init-s\n', 'other.txt': 'init-o\n' });
    cleanDirs.push(repo);
    const data = await makeTempDir('data-s6-abort-');

    const ctl = new TaskController({
      repo,
      makeExecutor: () =>
        new FakeExecutor([
          { do: 'write', path: 'shared.txt', content: 'task-shared\n' },
          { do: 'write', path: 'other.txt', content: 'task-other\n' },
          { do: 'exit', code: 0 },
        ]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });

    const t = await ctl.create('改两个文件');
    await ctl.savePlan(t.id, { goal: '改两个文件', criteria: [], mode: 'standard', network: false });
    await ctl.start(t.id, false);
    await until(async () => {
      const v = await ctl.getAcceptanceView(t.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });

    // 主项目外部提交改 shared.txt → 保存遇到冲突，且查不到 studio 任务保存记录
    await fs.writeFile(path.join(repo, 'shared.txt'), 'manual-shared\n');
    await G_commit(repo, 'manual commit outside studio', 'shared.txt');

    const ready = await confirmAll(ctl, t.id);
    const failedSave = await ctl.saveTask(t.id, ready.version);
    expect(failedSave.ok).toBe(false);
    expect(failedSave.view.conflict?.otherLabel).toBe('项目里后来的改动');

    const wtPath = (await new TaskRunner({ repo, executor: new FakeExecutor([]) }).store.get(t.id))!.worktree!.path;
    const baseBefore = (await new TaskRunner({ repo, executor: new FakeExecutor([]) }).store.get(t.id))!.worktree!.baseSha;
    const sharedBefore = await fs.readFile(path.join(wtPath, 'shared.txt'), 'utf8');
    const otherBefore = await fs.readFile(path.join(wtPath, 'other.txt'), 'utf8');

    // 在点击重做前，主项目再次推进并对任务改动过的文件做了不兼容更改
    await fs.writeFile(path.join(repo, 'other.txt'), 'manual-other-conflict\n');
    await G_commit(repo, 'manual follow-up change', 'other.txt');

    const redoAbort = await ctl.reworkConflictTask(t.id);
    expect(redoAbort.ok).toBe(false);
    expect(redoAbort.view.state).toBe('save_failed_unmerged');
    expect(redoAbort.view.conflict).toBeTruthy();

    // 副本必须完全保持原样，无任何冲突标记、无状态跃迁
    const afterTask = (await new TaskRunner({ repo, executor: new FakeExecutor([]) }).store.get(t.id))!;
    expect(afterTask.worktree!.baseSha).toBe(baseBefore);
    expect(await fs.readFile(path.join(wtPath, 'shared.txt'), 'utf8')).toBe(sharedBefore);
    expect(await fs.readFile(path.join(wtPath, 'other.txt'), 'utf8')).toBe(otherBefore);
    expect(sharedBefore).not.toContain('<<<<<<<');
    expect(otherBefore).not.toContain('<<<<<<<');
    expect(await G.mergeInProgress(wtPath)).toBe(false);
    expect(await G.dirtyFiles(repo)).toEqual([]);
  });
});

async function G_commit(repo: string, message: string, filePath?: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['add', filePath ?? '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env });
}
