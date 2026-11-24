/**
 * AISS-A1-TRUSTED-EVIDENCE-R4 / R4-04 反向探针：试检查证据与试合并提交/树严格绑定，历史展示不绕过身份。
 *
 * A. 正常保存：trialChecks 的证据身份必须带本次 trialCommit，且 testedTree === treeOf(trialCommit)；
 * B. 历史展示：已保存记录的试检查证据与绑定树不一致时，不得再显示 verified（旧实现靠 historical 跳过树校验）；
 * C. 失败证据：不得显示为“检查通过”；
 * D. 未执行检查（not_available，带占位 spawn_error）与真实启动失败必须区分。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { TaskStore } from '../../src/core/task/store.js';
import { adjudicateSaveRecord, saveChecksTextFor } from '../../src/core/evidence/adjudicate.js';
import { adjudicateEvidence } from '../../src/core/evidence/adjudicate.js';
import { runCheck, scriptsDigest, type SandboxCommandRunner } from '../../src/core/checks/scripts.js';
import { git, treeOf } from '../../src/core/git/git.js';
import type { Task } from '../../src/core/task/model.js';
import { makeRepo, testSandboxRunner, tmpDir, useRealVitest } from '../helpers.js';

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
  const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
  await useRealVitest(repo);
  const data = await temp('r4p9-data-');
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor([
        { do: 'write' as const, path: 'index.html', content: '<h1>r4p9</h1>\n' },
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
  expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
  for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
  for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;
  const res = await ctl.saveTask(created.id, view.version);
  expect(res.ok).toBe(true);
  const task = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  return { repo, id: created.id, task };
}

/** 真实写入一次被篡改/损坏的已保存记录，然后关库重开再读回（等价重启）。 */
async function persistAndReload(repo: string, id: string, mutate: (t: Task) => void): Promise<Task> {
  const ts = new TaskStore(repo);
  const cur = (await ts.get(id))!;
  const t = { ...structuredClone(cur) } as Task;
  mutate(t);
  await ts.save(t);
  await RecordStore.closeAll();
  const ts2 = new TaskStore(repo);
  return (await ts2.get(id))!;
}

describe('R4-04 探针 A：试检查证据绑定本次 trialCommit 及其 tree', () => {
  it('trialChecks 证据身份带 trialCommit，且 testedTree === treeOf(trialCommit)', async () => {
    const { repo, task } = await savedTask();
    const rec = task.saveRecord!;
    expect(rec.trialCommit).toMatch(/^[0-9a-f]{40}$/);
    const test = rec.trialChecks!.find((c) => c.name === 'test')!;
    const ev = test.evidence!;
    // 旧候选：EvidenceIdentity 没有 trialCommit 字段；证据只绑 testedTree（试合并工作区内容树）
    expect((ev.identity as unknown as { trialCommit?: string }).trialCommit).toBe(rec.trialCommit);
    expect(ev.identity.testedTree).toBe((await treeOf(repo, rec.trialCommit!)).trim());
    expect(ev.identity.taskId).toBe(task.id);
    expect(ev.identity.round).toBe(task.currentRound ?? 1);
    expect(ev.identity.acceptanceRev).toBe(task.acceptanceRev);
  }, 120_000);
});

describe('R4-04 探针 B：历史展示不得用 historical 模式绕过树/版本身份', () => {
  it('已保存证据的 testedTree 与绑定不一致 → 不得显示 verified', async () => {
    const { repo, id, task } = await savedTask();
    const mutated = await persistAndReload(repo, id, (t) => {
      const test = t.saveRecord!.trialChecks!.find((c) => c.name === 'test')!;
      // 模拟损坏/迁移：证据自称通过，但被测树与保存时绑定的 trialCommit tree 不一致
      test.evidence!.identity.testedTree = '0'.repeat(40);
    });
    const r = adjudicateSaveRecord(mutated.saveRecord!, {
      taskId: mutated.id,
      round: mutated.currentRound ?? 1,
      acceptedTree: mutated.acceptedTree,
      trialCommitTree: (mutated.saveRecord as unknown as { trialCommitTree?: string } | undefined)?.trialCommitTree,
      acceptanceRev: (mutated.saveRecord as unknown as { acceptanceRev?: number } | undefined)?.acceptanceRev,
    } as never);
    expect(r.status).not.toBe('verified');
    expect(saveChecksTextFor(mutated)).not.toBe('检查通过');
    void task;
  }, 120_000);
});

describe('R4-04 探针 C：失败证据不得显示为“检查通过”', () => {
  it('trialChecks 里是真实失败 → 保存历史文案不得包含“检查通过”', async () => {
    const { repo, id } = await savedTask();
    const mutated = await persistAndReload(repo, id, (t) => {
      const test = t.saveRecord!.trialChecks!.find((c) => c.name === 'test')!;
      test.status = 'failed';
      test.evidence!.verdict = 'failed';
    });
    const text = saveChecksTextFor(mutated);
    expect(text).not.toContain('检查通过');
  }, 120_000);
});

describe('R4-04 探针 D：未执行检查 vs 真实启动失败', () => {
  it('not_available（未启动）不得被当成真实失败；真实启动失败必须是 failed', async () => {
    const dir = await makeRepo({
      'index.html': 'x\n',
      'package.json': JSON.stringify({ name: 'r4p9d', scripts: { build: 'node -e "process.exit(0)"' } }),
    });
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--no-verify', '--allow-empty', '-m', 'build only']);
    const digest = (await scriptsDigest(dir))!;
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const tree = (await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
    const identity = { projectRoot: dir, taskId: 'r4p9d', round: 1, acceptanceRev: 1, testedTree: tree, baselineRev: head };
    const ctx = { taskId: 'r4p9d', round: 1, acceptanceRev: 1, acceptedTree: tree };

    // 沙箱不可用：检查根本没有执行（旧实现给它塞了一个 spawn_error 占位运行记录）
    const notRun = await runCheck(dir, 'build', { runCommand: async () => ({ status: 'unavailable', reason: 'no sandbox' }) }, { authorizedDigest: digest, identity });
    expect(notRun.status).toBe('not_available');
    expect(notRun.evidence).toBeTruthy();
    // 统一裁决必须识别为“未执行”，而不是“启动失败”
    expect(adjudicateEvidence(notRun.evidence, 'build', ctx).status).toBe('not_checked');

    // 真实启动失败（进程没有返回退出码）→ failed
    const spawnFailRunner: SandboxCommandRunner = {
      runCommand: async () => ({ status: 'ran', exitCode: null, stdout: '', stderr: 'spawn failed', timedOut: false, durationMs: 1 }),
    };
    const spawnFail = await runCheck(dir, 'build', spawnFailRunner, { authorizedDigest: digest, identity });
    expect(spawnFail.status).toBe('failed');
    expect(adjudicateEvidence(spawnFail.evidence, 'build', ctx).status).toBe('failed');
  }, 60_000);
});
