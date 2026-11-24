/**
 * AISS-A1-R4-LAST-DELTA-001 / §1 反向探针：SIGKILL 恢复也不得把不完整的证据集合标为可信通过。
 *
 * 真实链路：子进程真实保存（build + 真实 Vitest 均通过）→ 主进程在写入主项目瞬间 SIGKILL
 * → 在真实记录库上分别模拟：证据缺失 / evidenceId 错配 / 副本身份错配 → 重新加载并 reconcileTasks。
 * 旧候选只看“剩余证据 every(verified)”，仍会 checked=true；新候选必须由证据集合校验拒绝。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskRunner } from '../../src/core/task/runner.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { TaskStore } from '../../src/core/task/store.js';
import { headSha } from '../../src/core/git/git.js';
import type { Task } from '../../src/core/task/model.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir, useRealVitest } from '../helpers.js';

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

async function runAndInterrupt(): Promise<{ repo: string; id: string }> {
  const repo = await makeRepo({
    'index.html': '<h1>old</h1>\n',
    'package.json': JSON.stringify({ name: 'p12', scripts: { build: 'node -e "process.exit(0)"', test: realVitestScript() } }),
  });
  await useRealVitest(repo);
  const data = await temp('p12-data-');
  const preHead = await headSha(repo);
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, R3_DIST: DIST, R3_REPO: repo, R3_DATA: data, R3_BULK: '40' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const refFile = path.join(repo, '.git', 'refs', 'heads', 'main');
  const deadline = Date.now() + 150_000;
  let killed = false;
  let state: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    try {
      state = JSON.parse(await fs.readFile(path.join(data, 'child-state.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      state = null;
    }
    if (state?.phase === 'ready') {
      const ref = await fs.readFile(refFile, 'utf8').catch(() => '');
      if (ref.trim() && ref.trim() !== preHead) {
        child.kill('SIGKILL');
        killed = true;
        break;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  const exited = await new Promise<{ signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ signal: child.signalCode });
    child.on('exit', (_c, s) => resolve({ signal: s }));
  });
  if (!killed || exited.signal !== 'SIGKILL') throw new Error(`未成功中断：${exited.signal}\n${stderr}`);
  return { repo, id: String(state!.id) };
}

async function recoverWithMutation(mutate: (op: NonNullable<Task['op']>) => void): Promise<Task> {
  const cur = await runAndInterrupt();
  await RecordStore.closeAll();
  const ts = new TaskStore(cur.repo, { lockWaitMs: 25_000, staleMs: 5_000 });
  const t = (await ts.get(cur.id))!;
  expect(t.op?.trialChecks?.length).toBe(2);
  mutate(t.op!);
  await ts.save(t);
  await RecordStore.closeAll();

  const runner = new TaskRunner({
    repo: cur.repo,
    executor: new FakeExecutor([]),
    sandboxRunner: testSandboxRunner(),
    storeOptions: { lockWaitMs: 25_000, staleMs: 5_000 },
  });
  await runner.reconcileTasks();
  return (await runner.store.get(cur.id))!;
}

describe('LAST-DELTA 探针 P12：SIGKILL 恢复的证据集合完整性', () => {
  it('部分证据丢失 → 不得 checked=true', async () => {
    const t = await recoverWithMutation((op) => {
      op.trialChecks = op.trialChecks!.filter((p) => p.name !== 'test');
    });
    expect(t.saveRecord).toBeTruthy();
    expect(t.saveRecord!.checked).not.toBe(true);
  }, 240_000);

  it('evidenceIds 与证据实际 ID 错配 → 不得 checked=true', async () => {
    const t = await recoverWithMutation((op) => {
      op.trialEvidenceIds = { ...(op.trialEvidenceIds ?? {}), test: 'deadbeefdeadbeef' };
    });
    expect(t.saveRecord).toBeTruthy();
    expect(t.saveRecord!.checked).not.toBe(true);
  }, 240_000);

  it('副本身份错配 → 不得 checked=true', async () => {
    const t = await recoverWithMutation((op) => {
      const test = op.trialChecks!.find((p) => p.name === 'test')!;
      test.evidence!.identity.worktreePathHash = 'another-worktree-hash';
    });
    expect(t.saveRecord).toBeTruthy();
    expect(t.saveRecord!.checked).not.toBe(true);
  }, 240_000);
});
