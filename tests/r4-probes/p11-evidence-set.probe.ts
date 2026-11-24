/**
 * AISS-A1-R4-LAST-DELTA-001 / §1 反向探针：保存证据集合完整性（历史展示）。
 *
 * 真实保存（build + 真实 Vitest test 均通过）后，在**真实记录库**里分别模拟：
 *  A. 部分证据丢失（删掉 test 证据）；
 *  B. evidenceIds 与实际 evidenceId 错配；
 *  C. 副本身份错配（worktreePathHash 与保存记录不一致）；
 *  D. 证据集合缺项/重复（用重复 build 顶替 test）。
 * 旧候选只用“非空 + every(verified)”判定，仍显示“检查通过”。
 * 新候选必须由统一的证据集合校验入口拒绝。
 */
import fs from 'node:fs/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { TaskStore } from '../../src/core/task/store.js';
import { adjudicateSaveRecord, saveChecksTextFor } from '../../src/core/evidence/adjudicate.js';
import type { Task } from '../../src/core/task/model.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir, useRealVitest } from '../helpers.js';

const cleanDirs: string[] = [];
afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});
async function temp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  cleanDirs.push(d);
  return d;
}
async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 40_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function savedTask(): Promise<{ repo: string; id: string; task: Task }> {
  const repo = await makeRepo({
    'index.html': '<h1>old</h1>\n',
    'package.json': JSON.stringify({ name: 'p11', scripts: { build: 'node -e "process.exit(0)"', test: realVitestScript() } }),
  });
  await useRealVitest(repo);
  const data = await temp('p11-data-');
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor([
        { do: 'write' as const, path: 'index.html', content: '<h1>p11</h1>\n' },
        { do: 'exit' as const, code: 0 },
      ]);
      (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
      return ex;
    },
    pickDirectory: async () => null,
    prefs: new TaskPrefs(data),
  });
  const created = await ctl.create('改标题');
  await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
  await ctl.start(created.id, false);
  let view = await until(async () => {
    const v = await ctl.getAcceptanceView(created.id);
    return v.state === 'reviewing' && !v.busy ? v : false;
  });
  expect(view.items.find((i) => i.key === 'build')!.status).toBe('verified');
  expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
  for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
  for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;
  const res = await ctl.saveTask(created.id, view.version);
  expect(res.ok).toBe(true);
  const task = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  return { repo, id: created.id, task };
}

async function persistAndReload(repo: string, id: string, pristine: Task, mutate: (t: Task) => void): Promise<Task> {
  await RecordStore.closeAll();
  const ts = new TaskStore(repo, { lockWaitMs: 25_000, staleMs: 5_000 });
  const cur = (await ts.get(id))!;
  // 每次都从“正常保存后的原始记录”出发施加一种破坏，避免上一种破坏污染下一种
  const t = { ...structuredClone(pristine), revision: cur.revision } as Task;
  mutate(t);
  await ts.save(t);
  await RecordStore.closeAll();
  const ts2 = new TaskStore(repo);
  return (await ts2.get(id))!;
}

function verdict(t: Task): { status: string; text: string } {
  const r = adjudicateSaveRecord(t.saveRecord!, { taskId: t.id, round: t.currentRound ?? 1 });
  return { status: r.status, text: saveChecksTextFor(t) };
}

describe('LAST-DELTA 探针 P11：保存证据集合缺项/重复/错配/身份错配都不得可信通过', () => {
  it('正常保存记录带完整绑定与应执行集合；四类破坏均降级', async () => {
    const { repo, id, task } = await savedTask();
    const rec = task.saveRecord!;
    const pristine = structuredClone(task);
    // 基线：正常记录必须 verified
    expect(verdict(task).status).toBe('verified');

    // A. 部分证据丢失
    const a = await persistAndReload(repo, id, pristine, (t) => {
      t.saveRecord!.trialChecks = t.saveRecord!.trialChecks!.filter((p) => p.name !== 'test');
    });
    expect(verdict(a).status).not.toBe('verified');
    expect(verdict(a).text).not.toBe('检查通过');

    // B. evidenceIds 与实际 evidenceId 错配
    const b = await persistAndReload(repo, id, pristine, (t) => {
      t.saveRecord!.evidenceIds = { ...(t.saveRecord!.evidenceIds ?? {}), test: 'deadbeefdeadbeef' };
    });
    expect(verdict(b).status).not.toBe('verified');
    expect(verdict(b).text).not.toBe('检查通过');

    // C. 副本身份错配
    const c = await persistAndReload(repo, id, pristine, (t) => {
      const test = t.saveRecord!.trialChecks!.find((p) => p.name === 'test')!;
      test.evidence!.identity.worktreePathHash = 'another-worktree-hash';
    });
    expect(verdict(c).status).not.toBe('verified');

    // D. 缺项 + 重复：用重复 build 顶替 test
    const d = await persistAndReload(repo, id, pristine, (t) => {
      const build = t.saveRecord!.trialChecks!.find((p) => p.name === 'build')!;
      t.saveRecord!.trialChecks = [structuredClone(build), structuredClone(build)];
    });
    expect(verdict(d).status).not.toBe('verified');
    expect(verdict(d).text).not.toBe('检查通过');

    // 新候选还应持久化“应执行检查项集合”与完整绑定（旧候选没有这些字段）
    expect((rec as unknown as { expectedChecks?: string[] }).expectedChecks).toEqual(['build', 'test']);
    expect(rec.trialCommit).toBe(rec.mergeCommit);
    expect(rec.trialCommitTree).toBeTruthy();
  }, 120_000);
});
