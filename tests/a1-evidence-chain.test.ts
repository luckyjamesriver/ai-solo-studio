import fs from 'node:fs/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { buildTaskView } from '../src/core/app/task-view.js';
import { buildChatGPTFeedbackPacket } from '../src/renderer/chatgptFeedback.js';
import type { Task } from '../src/core/task/model.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir, useRealVitest } from './helpers.js';

/**
 * AISS-A1 全链路接入测试：任务结束生成证据、重新检查、保存前试检查、验收卡/证据页面、
 * 历史轮次、ChatGPT 反馈包宿主事实、异常重启后的证据恢复。
 * 关键链路使用真实 Vitest 进程，不使用 Mock 产生「通过」。
 */

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

async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DEFAULT_STEPS: FakeStep[] = [
  { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
  { do: 'exit', code: 0 },
];

async function setup(opts: {
  script?: FakeStep[];
  vitest?: { failWhen?: string } | false;
  testScript?: string;
  beforeStart?: (repo: string) => Promise<void>;
}): Promise<{ repo: string; data: string; ctl: TaskController; id: string; view: Awaited<ReturnType<TaskController['getAcceptanceView']>> }> {
  const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
  if (opts.vitest !== false) await useRealVitest(repo, opts.vitest ?? {});
  else if (opts.testScript) {
    await fs.writeFile(
      `${repo}/package.json`,
      JSON.stringify({ name: 'no-vitest', scripts: { test: opts.testScript } }),
    );
    await (await import('../src/core/git/git.js')).git(repo, ['add', '-A']);
    await (await import('../src/core/git/git.js')).git(repo, ['commit', '-m', 'fixture: non-vitest test script']);
  }
  if (opts.beforeStart) await opts.beforeStart(repo);
  const data = await temp('a1-data-');
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor(opts.script ?? DEFAULT_STEPS, { emitPermissions: true });
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
  return { repo, data, ctl, id: created.id, view };
}

async function confirmAll(ctl: TaskController, id: string): Promise<string> {
  let v = await ctl.getAcceptanceView(id);
  for (const c of v.criteria) v = (await ctl.confirmCriterion(id, c.id, v.version)).view;
  for (const d of v.denied) v = (await ctl.ackDenied(id, d.id, v.version)).view;
  return v.version;
}

describe('A1 全链路：任务结束后的 buildEvidence（真实 Vitest）', () => {
  it('验收卡与检查依据页来自真实结构化证据，逐项数量真实、无虚构', async () => {
    const { id, ctl, view } = await setup({ vitest: {} });
    const testItem = view.items.find((i) => i.key === 'test')!;
    expect(testItem.status).toBe('verified');
    expect(view.proof.test.status).toBe('passed');
    expect(view.proof.test.counts).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(view.proof.test.countsSource).toBe('structured_report');
    expect(view.proof.test.proofFacts?.join('\n')).toMatch(/测试报告：vitest-json/);
    expect(view.proof.test.proofFacts?.join('\n')).toMatch(/报告完整性校验：通过/);

    // 存储的证据必须绑定任务、轮次、验收版本与被测内容
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    const stored = raw.currentChecks?.find((c) => c.name === 'test')!;
    expect(stored.evidence?.identity.taskId).toBe(id);
    expect(stored.evidence?.identity.round).toBe(raw.currentRound ?? 1);
    expect(stored.evidence?.identity.acceptanceRev).toBe(raw.acceptanceRev);
    expect(stored.evidence?.identity.testedTree).toBe(raw.acceptedTree);
    expect(stored.evidence?.report?.counts.total).toBe(2);
  });

  it('没有真实测试框架证据（echo 脚本）时：卡上为「缺乏有效证据」，绝不显示为通过或「1 项通过」', async () => {
    const { view } = await setup({ vitest: false, testScript: 'echo "Tests 1 passed"' });
    const testItem = view.items.find((i) => i.key === 'test')!;
    expect(testItem.status).toBe('unverified');
    expect(testItem.status).not.toBe('verified');
    expect(view.acceptanceStatus.kind).not.toBe('passed');
    expect(view.proof.test.status).toBe('unverified');
    expect(view.proof.test.counts).toBeNull();
    expect(view.proof.test.summaryText).not.toMatch(/\d+ 项通过/);
    // 历史兼容路径也不再显示「1 项通过」
    expect(view.verdict).not.toMatch(/所有检查都.*通过/);
  });
});

describe('A1 全链路：用户重新检查时的证据更新', () => {
  it('重新检查 → 验收版本 +1，新证据替换旧证据（旧版本的确认一律失效）', async () => {
    const { id, ctl, view } = await setup({ vitest: {} });
    const beforeRev = (await ctl.listTasksRaw()).find((t) => t.id === id)!.acceptanceRev;
    const oldEvidence = (await ctl.listTasksRaw()).find((t) => t.id === id)!.currentChecks!.find((c) => c.name === 'test')!.evidence!;
    const r = await ctl.recheck(id);
    expect(r.ok).toBe(true);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(after.acceptanceRev).toBe((beforeRev ?? 0) + 1);
    expect(after.currentChecks?.find((c) => c.name === 'test')?.evidence?.identity.acceptanceRev).toBe(after.acceptanceRev);
    expect(after.currentChecks?.find((c) => c.name === 'test')?.evidence?.identity.evidenceId).not.toBe(oldEvidence.identity.evidenceId);
    const v2 = await ctl.getAcceptanceView(id);
    expect(v2.version).not.toBe(view.version);
    expect(v2.proof.test.status).toBe('passed');
  });
});

describe('A1 全链路：保存前试合并工作树的 runProjectChecks', () => {
  it('验收与试合并都真实通过 → 保存 checked=true', async () => {
    const { id, ctl } = await setup({ vitest: {} });
    const version = await confirmAll(ctl, id);
    const r = await ctl.saveTask(id, version);
    expect(r.ok).toBe(true);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(after.saveRecord?.checked).toBe(true);
    expect(after.state).toBe('saved');
  });

  it('试合并后真实测试失败 → checks_failed，且不能被「未检查确认」绕过', async () => {
    const { id, ctl, repo } = await setup({ vitest: { failWhen: 'trigger.txt' } });
    const version = await confirmAll(ctl, id);
    // 在试合并期间让测试真实失败：主项目新增 trigger.txt（会合并进试合并工作树）
    await fs.writeFile(`${repo}/trigger.txt`, 'x');
    const { git } = await import('../src/core/git/git.js');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'trigger merged failure']);
    const fail = await ctl.saveTask(id, version);
    expect(fail.ok).toBe(false);
    expect(fail.view.saveOutcome?.kind).toBe('checks_failed');
    // 再次调用（相当于用户点“仍然保存”）也不能绕过真实失败
    const again = await ctl.saveUncheckedTask(id, (await ctl.getAcceptanceView(id)).version);
    expect(again.ok).toBe(false);
    expect(again.view.saveOutcome?.kind).not.toBe('saved' as never);
    expect((await ctl.listTasksRaw()).find((t) => t.id === id)!.saveRecord).toBeUndefined();
  });

  it('保存前试合并结果与原验收证据不一致 → 阻断保存（不得静默按旧结论保存）', async () => {
    // 验收时测试通过；试合并时人为把测试改成失败（模拟合并结果与原验收不一致）
    const { id, ctl, repo } = await setup({ vitest: {} });
    const version = await confirmAll(ctl, id);
    const { git } = await import('../src/core/git/git.js');
    // 让主项目也修改同一个测试文件（内容使测试失败），从而试合并后测试真实失败
    await fs.writeFile(
      `${repo}/tests/fixture.test.ts`,
      "import { it, expect } from 'vitest';\nit('合并后失败', () => { expect(1).toBe(2); });\n",
    );
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'main changed tests']);
    const r = await ctl.saveTask(id, version);
    expect(r.ok).toBe(false);
    expect(['checks_failed', 'acceptance_inconsistent']).toContain(r.view.saveOutcome?.kind as string);
    expect((await ctl.listTasksRaw()).find((t) => t.id === id)!.saveRecord).toBeUndefined();
  });
});

describe('A1 全链路：未检查风险的人工确认（仅记录人工确认）', () => {
  it('缺乏可信测试证据时：保存需要用户明确确认，记录为 unchecked/unverified，而不是 PASS', async () => {
    const { id, ctl } = await setup({ vitest: false, testScript: 'echo ok' });
    const version = await confirmAll(ctl, id);
    const first = await ctl.saveTask(id, version);
    expect(first.ok).toBe(false);
    expect(first.view.saveOutcome?.kind).toBe('unchecked_needs_confirm');
    const confirmed = await ctl.saveUncheckedTask(id, (await ctl.getAcceptanceView(id)).version);
    expect(confirmed.ok).toBe(true);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(after.saveRecord?.checked).toBe(false);
    expect(after.saveRecord?.uncheckedKind).toBe('unverified');
    expect(after.saveRecord?.uncheckedConfirmedAt).toBeTruthy();
    // 卡上仍然是「缺乏有效证据」，不能因为用户确认就变成 PASS
    expect(after.card?.items.find((i) => i.key === 'test')?.status).toBe('unverified');
  });

  it('验收版本变化后旧的「未检查确认」失效', async () => {
    const { id, ctl } = await setup({ vitest: false, testScript: 'echo ok' });
    const version = await confirmAll(ctl, id);
    const first = await ctl.saveTask(id, version);
    expect(first.view.saveOutcome?.kind).toBe('unchecked_needs_confirm');
    await ctl.recheck(id); // 版本 +1，旧确认作废
    const v2 = await ctl.getAcceptanceView(id);
    expect(v2.uncheckedConfirm).toBeNull();
    const afterRecheck = await confirmAll(ctl, id);
    const again = await ctl.saveTask(id, afterRecheck);
    expect(again.ok).toBe(false);
    expect(again.view.saveOutcome?.kind).toBe('unchecked_needs_confirm');
  });
});

describe('A1 全链路：测试范围削弱与明确的重新确认流程（R1-04 闭环）', () => {
  it('执行体删除已有测试 → 自动通过被阻断；用户确认内容+范围+版本 → 重新检查 → 重新验收 → 试合并 → 正式保存', async () => {
    const { id, ctl } = await setup({
      vitest: {},
      script: [
        {
          do: 'write',
          path: 'tests/fixture.test.ts',
          content: "import { describe, it, expect } from 'vitest';\ndescribe('fixture', () => { it('只剩一条', () => { expect(1).toBe(1); }); });\n",
        },
        { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
        { do: 'exit', code: 0 },
      ],
    });
    const first = await ctl.getAcceptanceView(id);
    expect(first.items.find((i) => i.key === 'test')?.status).toBe('unverified');
    expect(first.scopeChange?.needed).toBe(true);
    expect(first.scopeChange?.reasons.join('；')).toMatch(/测试用例被删除|测试块减少|断言减少|内容发生变化/);
    // 范围未确认前：保存核心门禁必须主动阻断（不依赖 UI）
    const blocked = await ctl.saveTask(id, first.version);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/重新确认|失效/);

    // 用户明确确认：绑定内容指纹 + 范围指纹 + 验收版本
    const r = await ctl.confirmScopeChange(id, first.version);
    expect(r.ok).toBe(true);
    const after = await ctl.getAcceptanceView(id);
    expect(after.scopeChange).toBeNull();
    expect(after.items.find((i) => i.key === 'test')?.status).toBe('verified');
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(raw.scopeReview?.confirmedAt).toBeTruthy();
    expect(raw.scopeReview?.contentFingerprint).toBe(raw.acceptedTree);
    expect(raw.scopeReview?.acceptanceVersion).toBe(after.version);
    // 重新确认后旧的验收决定必须被清空
    expect(raw.criteria.every((c) => !c.decision)).toBe(true);
    expect(raw.previewed).toBe(false);

    // 重新完成用户验收，然后保存（试合并在已确认范围上运行并通过）
    const version = await confirmAll(ctl, id);
    const saved = await ctl.saveTask(id, version);
    expect(saved.ok).toBe(true);
    const done = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(done.state).toBe('saved');
    expect(done.saveRecord?.checked).toBe(true);
    expect(done.scopeReview).toBeUndefined();
  });

  it('确认前内容发生变化 → 拒绝旧确认，必须重新检查', async () => {
    const { id, ctl } = await setup({
      vitest: {},
      script: [
        {
          do: 'write',
          path: 'tests/fixture.test.ts',
          content: "import { describe, it, expect } from 'vitest';\ndescribe('fixture', () => { it('只剩一条', () => { expect(1).toBe(1); }); });\n",
        },
        { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
        { do: 'exit', code: 0 },
      ],
    });
    const view = await ctl.getAcceptanceView(id);
    expect(view.scopeChange?.needed).toBe(true);
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    // 模拟用户查看之后、点确认之前内容又变了
    await fs.writeFile(`${raw.worktree!.path}/index.html`, '<h1>changed-after-view</h1>\n');
    const r = await ctl.confirmScopeChange(id, view.version);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/内容又发生了变化|已失效/);
  });
});

describe('R1-04 保存前试合并：已确认范围仍然有效才允许保存', () => {
  it('确认范围后主项目的测试内容变化 → 试合并范围指纹不一致 → 硬阻断保存（不能人工确认绕过）', async () => {
    const { id, ctl, repo } = await setup({
      vitest: {},
      script: [
        {
          do: 'write',
          path: 'tests/fixture.test.ts',
          content: "import { describe, it, expect } from 'vitest';\ndescribe('fixture', () => { it('只剩一条', () => { expect(1).toBe(1); }); });\n",
        },
        { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
        { do: 'exit', code: 0 },
      ],
    });
    const detected = await ctl.getAcceptanceView(id);
    expect(detected.scopeChange?.needed).toBe(true);
    expect((await ctl.confirmScopeChange(id, detected.version)).ok).toBe(true);
    const version = await confirmAll(ctl, id);
    // 在保存前，主项目新增了一个测试文件（不与该任务改动冲突）：合并后的测试范围将不再等于用户确认时的范围指纹
    const { git } = await import('../src/core/git/git.js');
    await fs.mkdir(`${repo}/tests`, { recursive: true });
    await fs.writeFile(`${repo}/tests/extra.test.ts`, "import { it, expect } from 'vitest';\nit('主项目新增用例', () => { expect(2).toBe(2); });\n");
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'main added test file after confirmation']);
    const r = await ctl.saveTask(id, version);
    expect(r.ok).toBe(false);
    expect(['blocked', 'checks_failed']).toContain(r.view.saveOutcome?.kind);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    expect(after.saveRecord).toBeUndefined();
    // “仍然保存”也不能绕过范围不一致
    const again = await ctl.saveUncheckedTask(id, (await ctl.getAcceptanceView(id)).version);
    expect(again.ok).toBe(false);
  });
});

describe('A1 全链路：ChatGPT 反馈包中的宿主事实', () => {
  it('反馈包把宿主证据与 AI 自述分开，未取得可信证据时明确标注不可视为通过', async () => {
    const { id, ctl } = await setup({ vitest: false, testScript: 'echo ok' });
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    const view = buildTaskView(raw, { scripts: ['build', 'test'], running: false });
    const packet = buildChatGPTFeedbackPacket(view, '测试项目');
    expect(packet).toMatch(/宿主真实检查事实/);
    expect(packet).toMatch(/没有取得可信证据|不可视为已通过|未检查/);
    expect(packet).not.toMatch(/✅ \*\*检查「测试」\*\*: 通过/);
  });

  it('真实通过时宿主事实显示通过，并带报告事实（不是 AI 自述）', async () => {
    const { id, ctl } = await setup({ vitest: {} });
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === id)!;
    const packet = buildChatGPTFeedbackPacket(buildTaskView(raw, { scripts: ['build', 'test'], running: false }), '测试项目');
    expect(packet).toMatch(/宿主真实检查事实/);
    expect(packet).toMatch(/✅ \*\*检查「测试」\*\*: 通过/);
  });
});

describe('A1 全链路：应用异常重启后的证据恢复', () => {
  it('重启后有效证据仍然有效（不被误判失效），并且证据详情页可核对', async () => {
    const { id, repo, data, ctl } = await setup({ vitest: {} });
    await confirmAll(ctl, id);
    await RecordStore.closeAll().catch(() => undefined);
    const ctl2 = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor(DEFAULT_STEPS, { emitPermissions: true });
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });
    const v = await ctl2.getAcceptanceView(id); // ready() 会先做启动核对与证据复核
    expect(v.items.find((i) => i.key === 'test')?.status).toBe('verified');
    expect(v.proof.test.status).toBe('passed');
    const raw = (await ctl2.listTasksRaw()).find((t) => t.id === id)!;
    expect(raw.evidenceInvalid).toBeUndefined();
  });

  it('验收版本变化（记录被旧版本证据引用）→ 证据详情页显示「证据失效」，不得显示通过', () => {
    // 用真实任务记录构造：把 evidence 的 acceptanceRev 改旧，模拟复用旧版本证据
    const t = {
      id: 'task-x',
      request: 'r',
      state: 'reviewing',
      denied: [],
      deniedAcks: [],
      criteria: [],
      previewed: true,
      timeline: [],
      createdAt: 'x',
      updatedAt: 'x',
      currentRound: 1,
      acceptanceRev: 3,
      acceptedTree: 'a'.repeat(40),
      currentChecks: [
        {
          name: 'test',
          status: 'passed',
          env: 'sandbox',
          evidence: {
            schemaVersion: 1,
            kind: 'test',
            verdict: 'passed',
            trust: 'trusted',
            identity: { schemaVersion: 1, evidenceId: 'e', projectRootHash: 'p', taskId: 'task-x', round: 1, acceptanceRev: 2, testedTree: 'a'.repeat(40), worktreePathHash: 'w' },
            run: { runId: 'r', startedAt: 'x', finishedAt: 'x', env: 'sandbox', sandboxKind: 'seatbelt', argv: [], timedOut: false, exitKind: 'exited', exitCode: 0, durationMs: 1, stdoutSha256: 's', stdoutBytes: 1, stderrSha256: 't' },
            config: { testConfigFiles: [], reporterMode: 'vitest-json-cli', collectorVersion: 'a1-evidence-1' },
            report: { format: 'vitest-json', pathHash: 'p', sha256: 's', bytes: 1, producedDuringRun: true, startTimeWithinRun: true, counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, failedNames: [], integrity: { ok: true, problems: [] }, crossCheck: { agrees: true } },
            scope: { kind: 'assessed_unchanged', baselineAvailable: true, reasons: [] },
            valid: true,
          },
        },
      ],
    } as unknown as Task;
    return import('../src/core/acceptance/view.js').then(({ toUserView }) => {
      const v = toUserView(t);
      expect(v.proof.test.status).toBe('invalidated');
      expect(v.proof.test.summaryText).toMatch(/证据失效/);
      expect(v.items.find((i) => i.key === 'test')?.status).toBe('invalidated');
    });
  });
});

describe('A1 全链路：历史任务与历史轮次（旧记录安全读取）', () => {
  it('旧任务没有新证据模型字段 → 按历史未核实读取，不补造数量、不修改记录', async () => {
    const { toUserView } = await import('../src/core/acceptance/view.js');
    const t = {
      id: 'legacy-1',
      request: '旧任务',
      state: 'reviewing',
      denied: [],
      deniedAcks: [],
      criteria: [],
      previewed: true,
      timeline: [],
      createdAt: 'x',
      updatedAt: 'x',
      currentRound: 1,
      card: {
        items: [
          { key: 'exit', label: 'AI 执行过程正常结束', status: 'verified', evidence: '执行体进程退出码 0' },
          { key: 'changes', label: '有实际文件改动', status: 'verified', evidence: '1 个文件发生变化' },
          { key: 'test', label: '自动测试通过', status: 'verified', evidence: 'npm run test 成功（1 秒）' },
        ],
        changes: [{ status: 'modified', path: 'a', additions: 1, deletions: 0 }],
        readyToSave: true,
        headline: '所有检查都已通过，可以保存。',
      },
    } as unknown as Task;
    const v = toUserView(t);
    // 旧卡说 verified，但没有任何证据 → 显示为历史未核实，绝不显示「1 项通过」
    expect(v.proof.test.status).toBe('unverified');
    expect(v.proof.test.counts).toBeNull();
    expect(v.proof.test.summaryText).toMatch(/测试数量未知|历史记录未核实/);
    expect(v.proof.test.summaryText).not.toMatch(/^\d+ 项通过/);
    // 记录本身没有被修改（在这里就是没有被任何写入路径触碰）
    expect(t.card?.items.find((i) => i.key === 'test')?.status).toBe('verified');
  });
});
