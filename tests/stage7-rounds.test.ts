import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskController } from '../src/core/app/task-controller.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { TaskStore } from '../src/core/task/store.js';
import { extractConflictSnippet } from '../src/core/acceptance/snippets.js';
import * as G from '../src/core/git/git.js';
import { git, makeRepo, tmpDir } from './helpers.js';

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
  while (Date.now() - start < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 40));
  }
  throw new Error('等待超时');
}

describe('阶段 7 提交③：各轮代码保留（refs/studio/rounds）与冲突重做引用上轮内容', () => {
  it('每轮进入 review 创建 refs/studio/rounds/<taskId>/<n>，冲突重做与保存/git gc 后仍可查看历史轮次差异；只保留 <=200 行全文或 >200 行冲突片段', async () => {
    const longBase = Array.from({ length: 240 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    const longTask = longBase
      .replace('line-10\n', 'line-10-task-nonconflict\n')
      .replace('line-225\n', 'line-225-task-conflict\n');
    const longMain = longBase.replace('line-225\n', 'line-225-main-conflict\n');

    // 直接单元测试 >200 行只截冲突片段
    const extLong = extractConflictSnippet(longBase, longTask, longMain);
    expect(extLong.truncated).toBe(true);
    expect(extLong.totalLines).toBe(240);
    const joinedLong = extLong.sections.map((s) => s.text).join('\n');
    expect(joinedLong).toContain('line-225-task-conflict');
    expect(joinedLong).not.toContain('line-10-task-nonconflict'); // 非冲突远离片段不附带

    const repo = await makeRepo({
      'small.txt': 's0\n',
      'clean.txt': 'c0\n',
      'big.txt': longBase,
    });
    cleanDirs.push(repo);
    const data = await makeTempDir('s7-round-data-');

    const scripts: FakeStep[][] = [
      // 1st run: 任务 B 第 1 轮
      [
        { do: 'write', path: 'small.txt', content: 's-from-B-r1\n' },
        { do: 'write', path: 'clean.txt', content: 'c-from-B-nonconflict\n' },
        { do: 'write', path: 'big.txt', content: longTask },
        { do: 'exit', code: 0 },
      ],
      // 2nd run: 任务 A 先保存
      [
        { do: 'write', path: 'small.txt', content: 's-from-A\n' },
        { do: 'write', path: 'big.txt', content: longMain },
        { do: 'exit', code: 0 },
      ],
      // 3rd run: 任务 B 冲突重做第 2 轮
      [
        { do: 'write', path: 'small.txt', content: 's-from-A + B-r2\n' },
        { do: 'write', path: 'big.txt', content: longMain.replace('line-225-main-conflict', 'line-225-merged-r2') },
        { do: 'exit', code: 0 },
      ],
    ];
    const prompts: string[] = [];
    const exWrapper = {
      id: 'fake',
      displayName: '模拟执行体（测试用）',
      capabilities: { permissionPrompts: false, resumeAfterStop: true },
      async detect() {
        return { installed: true, loggedIn: 'yes' as const, version: 'fake-1.0' };
      },
      start(req: Parameters<FakeExecutor['start']>[0]) {
        prompts.push(req.prompt);
        const steps = scripts.shift() ?? [];
        const inner = new FakeExecutor(steps);
        return inner.start(req);
      },
    };

    const ctl = new TaskController({
      repo,
      makeExecutor: () => exWrapper,
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });

    // B 先第 1 轮完工停在 reviewing
    const tB = await ctl.create('任务 B 多轮冲突演示');
    await ctl.savePlan(tB.id, { goal: '任务 B 冲突重做', criteria: [], mode: 'standard', network: false });
    await ctl.start(tB.id, false);
    const vB1 = await until(async () => {
      const v = await ctl.getAcceptanceView(tB.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    expect(await G.listRoundRefs(repo, tB.id)).toEqual([`refs/studio/rounds/${tB.id}/1`]);

    // A 完工并保存 -> 主线推进
    const tA = await ctl.create('任务 A 先保存');
    await ctl.savePlan(tA.id, { goal: '任务 A', criteria: [], mode: 'standard', network: false });
    await ctl.start(tA.id, false);
    const vA1 = await until(async () => {
      const v = await ctl.getAcceptanceView(tA.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    await ctl.confirmOverall(tA.id, vA1.version);
    const saveA = await ctl.saveUncheckedTask(tA.id, vA1.version);
    expect(saveA.ok).toBe(true);

    // B 确认后保存 -> 触发 conflict（small.txt 与 big.txt 冲突，clean.txt 无冲突）
    await ctl.confirmOverall(tB.id, vB1.version);
    const saveB1 = await ctl.saveUncheckedTask(tB.id, vB1.version);
    expect(saveB1.ok).toBe(false);
    expect(saveB1.view.state).toBe('save_failed_unmerged');
    expect(saveB1.view.conflict?.files.sort()).toEqual(['big.txt', 'small.txt']);

    // 点「让 AI 在最新项目上重做这部分」→ prepareConflictRedo 附带冲突文件的上轮内容并启动第 2 轮
    const redoRes = await ctl.reworkConflictTask(tB.id);
    expect(redoRes.ok).toBe(true);
    const vB2 = await until(async () => {
      const v = await ctl.getAcceptanceView(tB.id);
      return v.state === 'reviewing' && !v.busy && v.currentRound === 2 ? v : false;
    });

    const redoPrompt = prompts[2] ?? '';
    expect(redoPrompt).toContain('这是你上一轮的版本，与项目里新的改动冲突了');
    expect(redoPrompt).toContain('s-from-B-r1');
    expect(redoPrompt).toContain('line-225-task-conflict');
    expect(redoPrompt).not.toContain('c-from-B-nonconflict'); // 非冲突文件不附带
    expect(redoPrompt).not.toContain('line-10-task-nonconflict'); // 超过 200 行文件只截冲突片段

    // 第 2 轮已生成 refs/studio/rounds/<id>/2，同时执行 git gc 清理松散不可达对象
    expect(await G.listRoundRefs(repo, tB.id)).toEqual([
      `refs/studio/rounds/${tB.id}/1`,
      `refs/studio/rounds/${tB.id}/2`,
    ]);
    await git(repo, ['gc', '--prune=now']);

    // 第 2 轮在验收页切换到第 1 轮，仍能从保留的 ref 中完整看到第 1 轮改动（不因 worktree 重置而丢失）
    const vB2Fresh = await ctl.getAcceptanceView(tB.id);
    expect(vB2Fresh.currentRound).toBe(2);
    expect(vB2Fresh.rounds).toHaveLength(2);
    const round1Snap = vB2Fresh.rounds.find((r) => r.round === 1)!;
    const round1Small = round1Snap.changes.find((c) => c.path === 'small.txt')!;
    expect(round1Small.preview?.kind).toBe('text');
    if (round1Small.preview?.kind === 'text') {
      expect(round1Small.preview.hunks[0]!.before).toContain('s0');
      expect(round1Small.preview.hunks[0]!.after).toContain('s-from-B-r1');
    }

    // 第 2 轮保存成功后（worktree 已被删除），saved 任务的各轮 refs 仍然长期保留，重新读取验收视图仍看得到历史轮次改动
    await ctl.confirmOverall(tB.id, vB2.version);
    const saveB2 = await ctl.saveUncheckedTask(tB.id, vB2.version);
    expect(saveB2.ok).toBe(true);
    expect(saveB2.view.state).toBe('saved');
    expect(await G.listRoundRefs(repo, tB.id)).toEqual([
      `refs/studio/rounds/${tB.id}/1`,
      `refs/studio/rounds/${tB.id}/2`,
    ]);
    expect(saveB2.view.rounds[0]!.changes.find((c) => c.path === 'small.txt')?.preview?.kind).toBe('text');
  });

  it('放弃任务的轮次引用保留 30 天：30 天内 reconcileTasks 不删除；超过 30 天自动清理，已保存任务永久保留', async () => {
    const repo = await makeRepo({ 'a.txt': 'a0\n' });
    cleanDirs.push(repo);
    const runner = new TaskRunner({
      repo,
      executor: new FakeExecutor([{ do: 'write', path: 'a.txt', content: 'a1\n' }, { do: 'exit', code: 0 }]),
      runChecks: false,
    });

    // 1) 任务 1：完工后保存
    const savedTask = await runner.create('已保存历史任务');
    await runner.setPlan(savedTask.id, { goal: 'saved', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [] });
    await runner.approve(savedTask.id);
    await runner.start(savedTask.id);
    await runner.confirm(savedTask.id, { overall: true });
    await runner.save(savedTask.id);

    // 2) 任务 2：完工后放弃
    const discTask = await runner.create('待放弃任务');
    await runner.setPlan(discTask.id, { goal: 'disc', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [] });
    await runner.approve(discTask.id);
    await runner.start(discTask.id);
    await runner.discard(discTask.id);

    expect(await G.listRoundRefs(repo, savedTask.id)).toEqual([`refs/studio/rounds/${savedTask.id}/1`]);
    expect(await G.listRoundRefs(repo, discTask.id)).toEqual([`refs/studio/rounds/${discTask.id}/1`]);

    // 放弃第 20 天运行 reconcileTasks：仍在 30 天保留期内，不得删除
    const day20 = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await runner.reconcileTasks(day20);
    expect(await G.listRoundRefs(repo, discTask.id)).toEqual([`refs/studio/rounds/${discTask.id}/1`]);
    expect(await G.listRoundRefs(repo, savedTask.id)).toEqual([`refs/studio/rounds/${savedTask.id}/1`]);

    // 放弃第 31 天运行 reconcileTasks：到期清理废弃引用，但 saved 引用不受任何影响
    const day31 = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const log31 = await runner.reconcileTasks(day31);
    expect(log31.some((e) => e.taskId === discTask.id)).toBe(true);
    expect(await G.listRoundRefs(repo, discTask.id)).toEqual([]);
    expect(await G.listRoundRefs(repo, savedTask.id)).toEqual([`refs/studio/rounds/${savedTask.id}/1`]);

    const rawDisc = (await new TaskStore(repo).get(discTask.id))!;
    expect(rawDisc.roundRefsPrunedAt).toBeTruthy();
  });
});
