/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-02 反向探针：真实统一裁决。
 *
 * 同一探针在旧候选 9d1533f 上必须【失败】，在新候选上必须【通过】。
 *
 * 方法：先用真实 Vitest 进程跑出真实证据并写入真实记录库（RecordStore），
 * 再对“落盘后的记录”施加代表篡改/损坏/矛盾的修改，关闭记录库、重新打开（等价于应用重启），
 * 最后只通过生产统一裁决入口 adjudicateTaskEvidence / adjudicateEvidence 取结论。
 * 不使用手工构造的内存证据对象冒充真实运行结果。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { TaskStore } from '../../src/core/task/store.js';
import { adjudicateTaskEvidence } from '../../src/core/evidence/adjudicate.js';
import { runProjectChecks, scriptsDigest } from '../../src/core/checks/scripts.js';
import { git } from '../../src/core/git/git.js';
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

async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DEFAULT_STEPS = [
  { do: 'write' as const, path: 'index.html', content: '<h1>new</h1>\n' },
  { do: 'exit' as const, code: 0 },
];

async function setup(): Promise<{ repo: string; id: string; pristine: string }> {
  const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
  await useRealVitest(repo);
  const data = await temp('r3p2-data-');
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor(DEFAULT_STEPS, { emitPermissions: true });
      (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
      return ex;
    },
    pickDirectory: async () => null,
    prefs: new TaskPrefs(data),
  });
  const created = await ctl.create('改标题');
  await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
  await ctl.start(created.id, false);
  const view = await until(async () => {
    const v = await ctl.getAcceptanceView(created.id);
    return v.state === 'reviewing' && !v.busy ? v : false;
  });
  expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
  const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  const pristine = JSON.stringify(raw);
  return { repo, id: created.id, pristine };
}

/** 从原始记录出发施加一次“被篡改/损坏”，真实落盘后关闭并重新打开记录库再读回（等价重启）。 */
async function persistAndReload(ctx: { repo: string; id: string; pristine: string }, mutate: (t: Task) => void): Promise<Task> {
  const ts = new TaskStore(ctx.repo);
  const cur = (await ts.get(ctx.id))!;
  const t = { ...(JSON.parse(ctx.pristine) as Task), revision: cur.revision } as Task;
  mutate(t);
  await ts.save(t);
  await RecordStore.closeAll();
  const ts2 = new TaskStore(ctx.repo);
  return (await ts2.get(ctx.id))!;
}

let ctx: { repo: string; id: string; pristine: string } | undefined;
async function base(): Promise<{ repo: string; id: string; pristine: string }> {
  ctx ??= await setup();
  return ctx;
}

describe('R3-02 探针 A：真实退出状态与 verdict 矛盾', () => {
  it('证据自述 passed 但真实进程退出码非 0 → 不得判为 verified', async () => {
    const ctx = await base();
    const t = await persistAndReload(ctx, (task) => {
      const test = task.currentChecks!.find((p) => p.name === 'test')!;
      expect(test.evidence!.run.exitCode).toBe(0);
      test.evidence!.run.exitCode = 1; // 篡改落盘记录：自述通过、真实退出码是失败
    });
    const adj = adjudicateTaskEvidence(t);
    expect(adj.test).toBeTruthy();
    expect(adj.test!.status).not.toBe('verified');
    expect(adj.hasFailed).toBe(true);
  });
});

describe('R3-02 探针 B：trust 不符合可信等级', () => {
  it('trust=weak 的证据即使 verdict=passed 也不得判为 verified', async () => {
    const ctx = await base();
    const t = await persistAndReload(ctx, (task) => {
      const test = task.currentChecks!.find((p) => p.name === 'test')!;
      test.evidence!.trust = 'weak'; // 只有命令级观察，不足以证明测试真实通过
    });
    const adj = adjudicateTaskEvidence(t);
    expect(adj.test!.status).not.toBe('verified');
    expect(adj.test!.status).not.toBe('failed');
  });
});

describe('R3-02 探针 C：证据完整性不成立', () => {
  it('报告完整性校验失败时，即使计数全部通过也不得判为 verified', async () => {
    const ctx = await base();
    const t = await persistAndReload(ctx, (task) => {
      const test = task.currentChecks!.find((p) => p.name === 'test')!;
      test.evidence!.report!.integrity = { ok: false, problems: ['交叉核对未发生'], checks: { crossCheckPerformed: false } };
    });
    const adj = adjudicateTaskEvidence(t);
    expect(adj.test!.status).not.toBe('verified');
  });
});

describe('R3-02 探针 D：范围变化与真实失败同时存在', () => {
  it('真实失败优先于范围待确认 → failed（不得降级成可确认放行的 unverified）', async () => {
    const ctx = await base();
    const t = await persistAndReload(ctx, (task) => {
      const test = task.currentChecks!.find((p) => p.name === 'test')!;
      test.evidence!.verdict = 'failed';
      test.evidence!.scope = { kind: 'assessed_weakened', baselineAvailable: true, reasons: ['测试块减少'], method: 'conservative-static' };
    });
    const adj = adjudicateTaskEvidence(t);
    expect(adj.test!.status).toBe('failed');
    expect(adj.needsScopeConfirm).toBe(false);
  });
});

describe('R3-02 探针 E：证据失效与失败事实同时存在', () => {
  it('重启深度复核判定失效时，已有的真实失败事实仍然优先 → failed', async () => {
    const ctx = await base();
    const t = await persistAndReload(ctx, (task) => {
      const test = task.currentChecks!.find((p) => p.name === 'test')!;
      test.evidence!.verdict = 'failed';
      test.evidence!.report!.counts.failed = 1;
      task.evidenceInvalid = { reason: '重启后复核发现测试配置被改动', at: new Date().toISOString() };
    });
    const adj = adjudicateTaskEvidence(t);
    expect(adj.test!.status).toBe('failed');
    expect(adj.hasFailed).toBe(true);
  });
});

describe('R3-02 探针 F：runProjectChecks 必须消费统一裁决（不得只认 status 字符串）', () => {
  it('没有身份上下文、因而不存在任何宿主证据的构建“成功”不得算作 checked', async () => {
    const repo = await makeRepo({ 'index.html': 'x\n' });
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'r3p2-f', scripts: { build: 'node -e "process.exit(0)"' } }));
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'fixture: build only']);
    // 没有 identity：产物不可能带宿主证据（evidenceFor 返回 undefined）
    const outcome = await runProjectChecks(repo, testSandboxRunner(), { authorizedDigest: (await scriptsDigest(repo))! });
    expect(outcome.results.map((r) => r.status)).toEqual(['passed']);
    expect(outcome.checked).toBe(false);
    expect(outcome.kind).not.toBe('ran');
  });
});

