/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-05 反向探针（父进程）：真实持久化 + 真实保存中断 + 重启恢复。
 *
 * 链路：真实 Vitest 试检查 → RecordStore 落盘 → 写入主项目 → SIGKILL 关闭子进程
 *      → 重新打开记录库 → reconcileTasks → 读取恢复出的真实试检查证据。
 *
 * 旧候选必须失败的地方：
 *  A. 恢复分支没有做与正常保存一致的内容完整性验证：主项目上出现“第二个父提交是 taskCommit、
 *     但 tree 被改过”的合并提交时，旧实现照样把任务标成 saved 并记录该提交。
 *  B. 保存结果没有绑定本次 trialCommit：恢复记录的 mergeCommit 取的是 rev-list 找到的任意合并提交。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskRunner } from '../../src/core/task/runner.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { git, headSha } from '../../src/core/git/git.js';
import { makeRepo, testSandboxRunner, tmpDir, useRealVitest } from '../helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.resolve(HERE, '../../docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001/probes/r3-p5-child.mjs');
const DIST = path.resolve(HERE, '../../dist-electron');

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

interface Interrupted {
  repo: string;
  data: string;
  id: string;
  preHead: string;
  opPhase: string;
  opTrialCommit: string | undefined;
  taskCommit: string | undefined;
  saveRecordOnDisk: boolean;
}

async function readState(data: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(data, 'child-state.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 跑一次真实保存，并在主项目 ref 一改变（ff 合并刚发生）就 SIGKILL 子进程。 */
async function runAndInterrupt(): Promise<Interrupted> {
  const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
  await useRealVitest(repo);
  const data = await temp('r3p5-data-');
  const preHead = await headSha(repo);

  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, R3_DIST: DIST, R3_REPO: repo, R3_DATA: data, R3_BULK: '620' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  const refFile = path.join(repo, '.git', 'refs', 'heads', 'main');
  const deadline = Date.now() + 150_000;
  let killed = false;
  let state: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    state = await readState(data);
    if (state && state.phase === 'ready') {
      let ref = '';
      try {
        ref = (await fs.readFile(refFile, 'utf8')).trim();
      } catch {
        // 引用可能还没写入或已被 pack：继续
      }
      if (ref && ref !== preHead) {
        child.kill('SIGKILL');
        killed = true;
        break;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  if (!killed) {
    throw new Error(`没有在写入主项目后成功中断子进程（code=${exited.code}, signal=${exited.signal}）\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  expect(exited.signal).toBe('SIGKILL');

  const id = String(state!.id);
  // 任务记录库在项目内：<repo>/.studio/records/tasks/<id>.json
  const recFile = path.join(repo, '.studio', 'records', 'tasks', `${id}.json`);
  const env = JSON.parse(await fs.readFile(recFile, 'utf8')) as { data: Record<string, any> };
  return {
    repo,
    data,
    id,
    preHead,
    opPhase: env.data.op?.phase,
    opTrialCommit: env.data.op?.trialCommit,
    taskCommit: env.data.op?.taskCommit,
    saveRecordOnDisk: !!env.data.saveRecord,
  };
}

async function runnerFor(repo: string): Promise<TaskRunner> {
  await RecordStore.closeAll();
  return new TaskRunner({
    repo,
    executor: new FakeExecutor([]),
    sandboxRunner: testSandboxRunner(),
    storeOptions: { lockWaitMs: 25_000, staleMs: 5_000 },
  });
}

describe('R3-05 探针 A：正常中断后的真实恢复（试检查证据必须来自真实链路）', () => {
  it('重启恢复后 SaveRecord.trialChecks 携带真实试检查身份/被测 tree/执行结果/保存提交', async () => {
    const cur = await runAndInterrupt();
    // 中断点：合并已经写入主项目，但 saveRecord 还没落盘
    expect(cur.opPhase).toBe('writing');
    expect(cur.saveRecordOnDisk).toBe(false);
    expect(cur.opTrialCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await headSha(cur.repo)).toBe(cur.opTrialCommit);

    const runner = await runnerFor(cur.repo);
    const out = await runner.reconcileTasks();
    const t = (await runner.store.get(cur.id))!;

    expect(out.some((o) => o.taskId === cur.id)).toBe(true);
    expect(t.state).toBe('saved');
    expect(t.saveRecord).toBeTruthy();
    expect(t.saveRecord!.trialChecks?.length).toBe(1); // 只有 test 脚本，没有 build
    expect(t.saveRecord!.checked).toBe(true);
    expect(t.saveRecord!.trialCommit).toBe(cur.opTrialCommit);
    // 保存结果必须绑定本次试合并提交，而不是任意读到的 HEAD
    expect(t.saveRecord!.mergeCommit).toBe(cur.opTrialCommit);
    const test = t.saveRecord!.trialChecks!.find((c) => c.name === 'test')!;
    expect(test.evidence).toBeTruthy();
    expect(test.evidence!.verdict).toBe('passed');
    expect(test.evidence!.trust).toBe('trusted');
    expect(test.evidence!.identity.testedTree).toBe(t.acceptedTree);
    expect(test.evidence!.identity.acceptanceRev).toBe(t.acceptanceRev);
    expect(test.evidence!.report!.counts.total).toBe(2);
    expect(test.evidence!.report!.integrity.ok).toBe(true);
  }, 180_000);
});

describe('R3-05 探针 B：恢复分支的内容完整性（第二个父提交正确但 tree 被改过）', () => {
  it('恢复不得把内容漂移的合并提交当成保存结果', async () => {
    const cur = await runAndInterrupt();
    expect(cur.taskCommit).toBeTruthy();

    // 应用关闭期间：主项目回到保存前，再做一个“第二个父提交是 taskCommit、但内容被改过”的合并提交
    await git(cur.repo, ['reset', '--hard', cur.preHead]);
    await git(cur.repo, ['merge', '--no-ff', '--no-commit', cur.taskCommit!]);
    await fs.writeFile(path.join(cur.repo, 'index.html'), '<h1>evil-merge</h1>\n');
    await git(cur.repo, ['add', '-A']);
    await git(cur.repo, ['commit', '--no-verify', '-m', 'studio: 保存「改标题」']);
    const evil = await headSha(cur.repo);
    expect(evil).not.toBe(cur.opTrialCommit);

    const runner = await runnerFor(cur.repo);
    await runner.reconcileTasks();
    const t = (await runner.store.get(cur.id))!;

    // 旧候选：state === 'saved'，saveRecord.mergeCommit === evil —— 把内容漂移的提交当成保存结果
    expect(t.state).not.toBe('saved');
    expect(t.saveRecord?.mergeCommit).not.toBe(evil);
    expect(t.manualReview ?? t.state === 'save_failed_unmerged').toBeTruthy();
  }, 180_000);
});

