/**
 * AISS-A1-TRUSTED-EVIDENCE-R4 / R4-04 反向探针：中断恢复不得在“没有试检查证据”时记录 checked=true。
 *
 * 真实链路：子进程真实保存 → 主进程在主项目写入瞬间 SIGKILL → 记录库落盘状态为
 * op.phase='writing' 且没有 saveRecord。随后在**真实记录文件**上模拟旧版本/损坏：
 * 删除 op.trialChecks（但仍保留 op.checked=true），再关闭/重开记录库并 reconcileTasks。
 *
 * 旧候选：恢复分支在 trialChecks 缺失时仍沿用 op.checked=true → saveRecord.checked=true（缺证据仍通过）。
 * 新候选：没有真实试检查证据时绝不能记录为 checked；只能登记为未检查/历史未核实。
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

async function runAndInterrupt(): Promise<{ repo: string; data: string; id: string; preHead: string }> {
  const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
  await useRealVitest(repo);
  const data = await temp('r4p10-data-');
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
  return { repo, data, id: String(state!.id), preHead };
}

describe('R4-04 探针 E：中断恢复时缺失试检查证据 → 不得 checked=true', () => {
  it('删除落盘的 op.trialChecks（保留 op.checked=true）后恢复 → saveRecord.checked 不得为 true', async () => {
    const cur = await runAndInterrupt();
    // 通过真实记录库提交一次“旧版本/损坏记录”的状态：只有 checked，没有结构化试检查证据
    await RecordStore.closeAll();
    const ts = new TaskStore(cur.repo, { lockWaitMs: 25_000, staleMs: 5_000 });
    const before = (await ts.get(cur.id))!;
    expect(before.op?.checked).toBe(true);
    expect(before.op?.trialChecks?.length).toBeGreaterThan(0);
    delete before.op!.trialChecks;
    await ts.save(before);
    await RecordStore.closeAll();

    const runner = new TaskRunner({
      repo: cur.repo,
      executor: new FakeExecutor([]),
      sandboxRunner: testSandboxRunner(),
      storeOptions: { lockWaitMs: 25_000, staleMs: 5_000 },
    });
    await runner.reconcileTasks();
    const t = (await runner.store.get(cur.id))!;
    expect(t.saveRecord).toBeTruthy();
    expect(t.saveRecord!.checked).not.toBe(true);
    expect(t.saveRecord!.trialChecks?.length ?? 0).toBe(0);
  }, 240_000);
});
