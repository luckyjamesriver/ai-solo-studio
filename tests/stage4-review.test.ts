import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCard } from '../src/core/acceptance/card.js';
import { computeAcceptanceStatus, toUserView } from '../src/core/acceptance/view.js';
import { saveBlockerCodes } from '../src/core/task/save-rules.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import type { Task } from '../src/core/task/model.js';

const tmpDirs: string[] = [];

function mk(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-s4-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

function initRepo(files: Record<string, string> = { 'index.html': '<h1>init</h1>\n' }): string {
  const repo = path.join(mk('repo'), 'proj');
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

function mkReviewingTask(over: Partial<Task> = {}): Task {
  const criteria = over.criteria ?? [{ text: '首页显示欢迎标语' }, { text: '手机布局不换行' }];
  const exit = over.exit ?? { kind: 'exited', code: 0 };
  const changes = [{ status: 'modified' as const, path: 'index.html', additions: 1, deletions: 1 }];
  return {
    id: 'task-s4-1',
    request: '更新首页',
    state: 'reviewing',
    criteria,
    denied: [],
    deniedAcks: [],
    previewed: false,
    acceptedTree: 'a'.repeat(40),
    acceptanceRev: 1,
    worktree: { path: '/tmp/wt-s4', branch: 'studio/task-s4-1', baseSha: 'b'.repeat(40) },
    exit,
    card: buildCard({ exit, changes, checks: [], criteria, previewed: false, denied: [], deniedAcks: [] }),
    timeline: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:01.000Z',
    ...over,
  };
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('阶段 4 · 第一节：三种验收状态计算与「不做部分通过」规则', () => {
  it('核心层准确计算 验收通过 / 验收未完成 / 验收未通过，没有「部分通过」路径', () => {
    // 1. 有标准还没确认 -> 验收未完成；显示保存按钮（不可点，附原因）
    const tIncomplete = mkReviewingTask({
      criteria: [{ text: '条件一', decision: 'confirmed' }, { text: '条件二' }],
    });
    const vIncomplete = toUserView(tIncomplete, { busy: false, saveCheck: null });
    expect(vIncomplete.acceptanceStatus).toMatchObject({
      kind: 'incomplete',
      label: '验收未完成',
      showSaveButton: true,
    });
    expect(vIncomplete.acceptanceStatus.reason).toContain('还有 1 条验收标准没确认');
    expect(vIncomplete.actions.save.enabled).toBe(false);
    expect(saveBlockerCodes(tIncomplete)).toContain('criteria_unconfirmed');

    // 2. 任意一条为「不符合」-> 验收未通过；保存按钮不出现（showSaveButton=false），拒绝部分通过
    const tFailed = mkReviewingTask({
      criteria: [
        { text: '条件一', decision: 'confirmed' },
        { text: '条件二', decision: 'rejected', note: '手机上一行只排了 1 张' },
      ],
    });
    const vFailed = toUserView(tFailed, { busy: false, saveCheck: null });
    expect(vFailed.acceptanceStatus).toMatchObject({
      kind: 'failed',
      label: '验收未通过',
      showSaveButton: false,
    });
    expect(vFailed.actions.save.enabled).toBe(false);
    expect(vFailed.reworkAction.enabled).toBe(true);
    expect(vFailed.criteria[1]).toMatchObject({ rejected: true, note: '手机上一行只排了 1 张' });
    expect(vFailed.saveRecord).toBeNull();
    expect(vFailed.acceptanceStatus.label).not.toBe('部分通过');

    // 3. 每条都「符合」且无阻断 -> 验收通过；「验收通过并保存」可用
    const tPassed = mkReviewingTask({
      criteria: [
        { text: '条件一', decision: 'confirmed' },
        { text: '条件二', decision: 'confirmed' },
      ],
    });
    const vPassed = toUserView(tPassed, { busy: false, saveCheck: null });
    expect(vPassed.acceptanceStatus).toMatchObject({
      kind: 'passed',
      label: '验收通过',
      showSaveButton: true,
    });
    expect(vPassed.actions.save.enabled).toBe(true);

    // 直接调用 computeAcceptanceStatus 验证无“部分通过”枚举
    const statusValues = [vIncomplete.acceptanceStatus.kind, vFailed.acceptanceStatus.kind, vPassed.acceptanceStatus.kind];
    expect(statusValues).toEqual(['incomplete', 'failed', 'passed']);
    expect(computeAcceptanceStatus(tFailed, { save: vFailed.actions.save, deniedAllAcked: true, anyUnchecked: false, verdict: vFailed.verdict }).showSaveButton).toBe(false);
  });

  it('rejectCriterion 保存「不符合」及可选说明、禁止保存；再选「符合」后清空说明并解锁', async () => {
    const repo = initRepo({ 'index.html': '<h1>old</h1>\n' });
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs')),
    });
    const t = await ctl.create('更新首页');
    await ctl.savePlan(t.id, { goal: '更新首页', criteria: ['标语清晰', '手机适配'], mode: 'standard', network: false });
    await ctl.start(t.id, false);
    let view = await ctl.getAcceptanceView(t.id);
    while (view.state !== 'reviewing' || view.busy) {
      await new Promise((r) => setTimeout(r, 20));
      view = await ctl.getAcceptanceView(t.id);
    }

    // 第 1 条符合，第 2 条不符合并带说明 -> 验收未通过、保存禁用且主界面隐藏保存按钮
    view = (await ctl.confirmCriterion(t.id, 'c0', view.version)).view;
    view = (await ctl.rejectCriterion(t.id, 'c1', view.version, '间距还是太大')).view;
    expect(view.acceptanceStatus.kind).toBe('failed');
    expect(view.acceptanceStatus.showSaveButton).toBe(false);
    expect(view.criteria[1]).toMatchObject({ rejected: true, note: '间距还是太大' });
    expect((await ctl.saveTask(t.id, view.version)).ok).toBe(false);

    // 伪造参数被拒绝
    await expect(ctl.rejectCriterion(t.id, 'overall', view.version, 'x')).rejects.toThrow();
    await expect(ctl.rejectCriterion(t.id, 'c9', view.version, 'x')).rejects.toThrow();
    await expect(ctl.rejectCriterion(t.id, 'c1', 'bad-ver', 'x')).rejects.toThrow();

    // 改回「符合」后说明被清空、变为验收通过
    view = (await ctl.confirmCriterion(t.id, 'c1', view.version)).view;
    expect(view.acceptanceStatus.kind).toBe('passed');
    expect(view.criteria[1]).toMatchObject({ confirmed: true, rejected: false });
    expect(view.criteria[1]?.note).toBeUndefined();
  });

  it('预留「你已知晓并接受的风险」字段：无风险时不返回，有风险时清洗并下发给验收页', () => {
    const empty = toUserView(mkReviewingTask(), { busy: false });
    expect(empty.acceptedRisks).toEqual([]);

    const withRisk = toUserView(
      mkReviewingTask({
        acceptedRisks: [{ title: '保留旧版样式兼容', reason: '在 /Users/alice/app 中用户确认已知晓风险', at: '2026-11-10T01:00:00.000Z' }],
      }),
      { busy: false },
    );
    expect(withRisk.acceptedRisks).toHaveLength(1);
    expect(withRisk.acceptedRisks[0]?.title).toBe('保留旧版样式兼容');
    expect(withRisk.acceptedRisks[0]?.reason).not.toContain('/Users/alice');
  });
});
