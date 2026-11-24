import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  collectApprovedScopeBaseline,
  detectScripts,
  runCheck,
  runProjectChecks,
  scriptsDigest,
  type CheckResult,
  type EvidenceIdentityContext,
} from '../src/core/checks/scripts.js';
import { computeTree, git, initRepo } from '../src/core/git/git.js';
import { realVitestScript, testSandboxRunner, tmpDir, useRealVitest } from './helpers.js';
import { evidenceIdentityProblem, hasTrustedTestPass } from '../src/core/evidence/validate.js';
import { prepareVitestRun, readVitestReport } from '../src/core/evidence/vitest.js';
import { parseTestCases } from '../src/core/acceptance/proof.js';
import { buildCard } from '../src/core/acceptance/card.js';

/**
 * AISS-A1-TRUSTED-EVIDENCE-001 反向测试矩阵（第一部分：真实进程 + 真实 Vitest）。
 *
 * 每个场景都对应任务书第 9 节表格里的一行。关键场景使用**真实进程与真实测试框架**，
 * 不以 Mock 替代；只有“报告文件本身被篡改/复用”这类需要构造磁盘状态的场景才直接构造文件。
 */

const created: string[] = [];
afterAll(async () => {
  for (const d of created) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir('a1-');
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await initRepo(dir);
  return dir;
}

async function head(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

interface CheckOpts {
  authorizedDigest?: string;
  taskId?: string;
  acceptanceRev?: number;
  acceptanceTree?: string;
  baselineRev?: string;
}

async function fixture(dir: string, over: CheckOpts = {}): Promise<{ digest: string; identity: EvidenceIdentityContext }> {
  const digest = (await scriptsDigest(dir))!;
  const tree = await computeTree(dir, dir);
  return {
    digest,
    identity: {
      projectRoot: dir,
      taskId: over.taskId ?? 'task-a1',
      round: 1,
      acceptanceRev: over.acceptanceRev ?? 1,
      testedTree: over.acceptanceTree ?? tree,
      baselineRev: over.baselineRev ?? (await head(dir)),
    },
  };
}

async function runFixture(
  dir: string,
  name: 'build' | 'test',
  over: CheckOpts = {},
): Promise<CheckResult> {
  const f = await fixture(dir, over);
  return runCheck(dir, name, testSandboxRunner(), { authorizedDigest: over.authorizedDigest ?? f.digest, identity: f.identity });
}

describe('A1 反向矩阵：自动测试的真实证据（真实进程）', () => {
  it('真实测试全部通过 → 可信 PASS，数量来自结构化报告', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'ok', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir);
    const r = await runFixture(dir, 'test');
    if (r.status !== 'passed') console.log('DEBUG_A1', JSON.stringify({ status: r.status, unknown: (r as { unknownReason?: string }).unknownReason, evReason: r.evidence?.reason, scope: r.evidence?.scope, integrity: r.evidence?.report?.integrity, executed: r.evidence?.report?.executedFiles, inventoryDigest: r.evidence?.config?.testInventoryDigest, files: r.evidence?.config?.testFileCount }, null, 1));
    expect(r.status).toBe('passed');
    expect(r.evidence?.trust).toBe('trusted');
    expect(r.evidence?.report?.integrity.ok).toBe(true);
    expect(r.evidence?.report?.counts).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(r.evidence ? hasTrustedTestPass(r.evidence) : false).toBe(true);
  });

  it('实际测试失败 → FAIL（真实断言失败）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'bad', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir, { failWhen: 'trigger.txt' });
    await fs.writeFile(path.join(dir, 'trigger.txt'), 'x');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'trigger']);
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('failed');
    expect(r.evidence?.report?.counts.failed).toBeGreaterThan(0);
  });

  it('退出码 0，但测试脚本只执行 echo → 非 PASS（unverified，没有真实测试证据）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'echo', scripts: { test: 'echo "Tests 5 passed (5)"' } }) });
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('unsupported_test_runner');
    expect(r.evidence?.report).toBeUndefined();
  });

  it('零测试（passWithNoTests）→ 非 PASS（tests_not_executed）', async () => {
    const dir = await makeRepo({
      'package.json': JSON.stringify({ name: 'zero', scripts: { test: `${realVitestScript()} --passWithNoTests` } }),
    });
    // 真实 vitest，但仓库里没有任何测试文件
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('tests_not_executed');
  });

  it('全部测试被跳过 → 非 PASS（all_tests_skipped）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'skip', scripts: { test: realVitestScript() } }) });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests', 'skip.test.ts'), "import { it } from 'vitest';\nit.skip('a', () => {});\nit.skip('b', () => {});\n");
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'skips']);
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('all_tests_skipped');
    expect(r.evidence?.report?.counts).toMatchObject({ total: 2, passed: 0, skipped: 2 });
  });

  it('输出伪造的测试成功摘要（无结构化报告）→ 非 PASS', async () => {
    const dir = await makeRepo({
      'package.json': JSON.stringify({
        name: 'fake-summary',
        scripts: { test: 'node -e "console.log(\'Test Files 1 passed\\n     Tests 99 passed (99)\')"' },
      }),
    });
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('unsupported_test_runner');
  });

  it('测试失败但外层脚本吞掉失败退出码（|| true）→ 非 PASS（拿不到可信报告）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'swallow', scripts: { test: `${realVitestScript()} || true` } }) });
    await useRealVitest(dir, { failWhen: 'trigger.txt' }).catch(() => undefined);
    // useRealVitest 会改写 test 脚本；这里重新写回“吞掉失败”的脚本
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    pkg.scripts.test = `${realVitestScript()} || true`;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await fs.writeFile(path.join(dir, 'trigger.txt'), 'x');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'swallow']);
    const r = await runFixture(dir, 'test');
    expect(r.status).not.toBe('passed');
    expect(['unverified', 'failed']).toContain(r.status);
  });

  it('未适配的测试框架（node --test）→ unverified（只记录命令结果，不冒充测试通过）', async () => {
    const dir = await makeRepo({
      'package.json': JSON.stringify({ name: 'nodetest', scripts: { test: 'node --test tests/*.test.mjs' } }),
      'tests/x.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('ok', () => { assert.equal(1, 1); });\n",
    });
    const r = await runFixture(dir, 'test');
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('unsupported_test_runner');
  });

  it('构建检查仍以真实进程退出码为准：exit 0 → passed，exit 1 → failed', async () => {
    const ok = await makeRepo({ 'package.json': JSON.stringify({ name: 'b1', scripts: { build: 'node -e "process.exit(0)"' } }) });
    expect((await runFixture(ok, 'build')).status).toBe('passed');
    const bad = await makeRepo({ 'package.json': JSON.stringify({ name: 'b2', scripts: { build: 'node -e "process.exit(1)"' } }) });
    expect((await runFixture(bad, 'build')).status).toBe('failed');
  });
});

describe('A1 反向矩阵：报告完整性（构造磁盘状态）', () => {
  it('缺失 / 损坏 / 复用 / 计数矛盾的报告 → 非 PASS', async () => {
    const dir = await tmpDir('a1-report-');
    created.push(dir);
    const plan = await prepareVitestRun(dir, 'vitest run');
    // 缺失
    expect((await readVitestReport(plan, { startMs: Date.now() - 1000, endMs: Date.now() }, dir)).status).toBe('missing');
    // 损坏
    await fs.writeFile(plan.reportPath, 'not-json');
    expect((await readVitestReport(plan, { startMs: Date.now() - 1000, endMs: Date.now() }, dir)).status).toBe('invalid');
    // 复用（把 mtime 设置到本次运行之前）
    const report = {
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
      startTime: Date.now() - 60_000,
      testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }] }],
    };
    await fs.writeFile(plan.reportPath, JSON.stringify(report));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(plan.reportPath, old, old);
    expect((await readVitestReport(plan, { startMs: Date.now() - 1000, endMs: Date.now() }, dir)).status).toBe('reused');
    // 计数矛盾（total 与分项不一致）
    const bad = { ...report, startTime: Date.now(), numTotalTests: 5, numPassedTests: 1 };
    await fs.writeFile(plan.reportPath, JSON.stringify(bad));
    const parsed = await readVitestReport(plan, { startMs: Date.now() - 5000, endMs: Date.now() }, dir);
    expect(parsed.status).toBe('inconsistent');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('parseTestCases 没有显式数字摘要时数量为 null（绝不按状态补造）', () => {
    expect(parseTestCases('all good').counts).toBeNull();
    expect(parseTestCases('✓ a (2ms)').counts).toBeNull();
    expect(parseTestCases('Tests 2 passed (2)').counts).toEqual({ passed: 2, failed: 0, skipped: 0, total: 2 });
  });
});

describe('A1 反向矩阵：证据身份（跨项目 / 跨任务 / 跨轮次 / 旧工作树 / 证据失效）', () => {
  it('使用其他项目的证据 → 拒绝；使用其他任务或轮次的证据 → 拒绝；旧工作树内容 → 失效', async () => {
    const dirA = await makeRepo({ 'package.json': JSON.stringify({ name: 'a', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dirA);
    const r = await runFixture(dirA, 'test');
    expect(r.status).toBe('passed');
    const ev = r.evidence!;
    expect(evidenceIdentityProblem(ev, { taskId: 'task-a1', round: 1, acceptanceRev: 1, acceptedTree: ev.identity.testedTree })).toBeUndefined();
    // 其他任务
    expect(evidenceIdentityProblem(ev, { taskId: 'task-other', round: 1, acceptanceRev: 1 })).toMatch(/另一个任务/);
    // 其他轮次
    expect(evidenceIdentityProblem(ev, { taskId: 'task-a1', round: 2, acceptanceRev: 1 })).toMatch(/另一轮次/);
    // 验收版本变化
    expect(evidenceIdentityProblem(ev, { taskId: 'task-a1', round: 1, acceptanceRev: 99 })).toMatch(/验收版本/);
    // 旧工作树内容（被测 tree 与冻结内容不一致）
    expect(evidenceIdentityProblem(ev, { taskId: 'task-a1', round: 1, acceptanceRev: 1, acceptedTree: 'f'.repeat(40) })).toMatch(/被测内容/);
  });

  it('验收卡：没有结构化报告时 test 即使 status=passed 也只能是 unverified（不得显示为通过）', () => {
    const card = buildCard({
      exit: { kind: 'exited', code: 0 },
      changes: [{ status: 'modified', path: 'a', additions: 1, deletions: 0 }],
      checks: [{ name: 'test', status: 'passed', outcome: { kind: 'exited', code: 0 }, output: '', durationMs: 1 }],
      criteria: [{ text: 'x', decision: 'confirmed' }],
      previewed: true,
      overallConfirmed: true,
    });
    expect(card.items.find((i) => i.key === 'test')?.status).toBe('unverified');
    expect(card.headline).not.toMatch(/全部通过/);
  });

  it('历史记录缺乏结构化证据 → 不虚构测试数量（测试数量未知）', () => {
    const parsed = parseTestCases('some output without numbers');
    expect(parsed.counts).toBeNull();
  });
});

describe('A1 反向矩阵：测试范围被削弱 / 验证基础设施被修改', () => {
  it('删除已有测试 → unverified（test_scope_weakened），阻断自动通过', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'weaken', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir);
    const base = await head(dir);
    // 模拟执行体删除一半测试（真实 ViTest 仍通过，但覆盖变少）
    await fs.writeFile(
      path.join(dir, 'tests', 'fixture.test.ts'),
      "import { describe, it, expect } from 'vitest';\ndescribe('fixture', () => { it('第一条真实用例', () => { expect(1).toBe(1); }); });\n",
    );
    const r = await runFixture(dir, 'test', { baselineRev: base });
    expect(r.status).toBe('unverified');
    expect(r.status === 'unverified' ? r.unknownReason : null).toBe('test_scope_weakened');
    expect(r.evidence?.scope.kind).toBe('assessed_weakened');
    expect(r.evidence?.scope.reasons.join('；')).toMatch(/测试用例被删除|测试块减少|断言减少/);
  });

  it('增加 skip 标记 → unverified（范围削弱）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'skiptwo', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir);
    const base = await head(dir);
    const file = path.join(dir, 'tests', 'fixture.test.ts');
    const src = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, src.replace("it('第二条真实用例'", "it.skip('第二条真实用例'").replace("it('第一条真实用例'", "it.skip('第一条真实用例'"));
    const r = await runFixture(dir, 'test', { baselineRev: base });
    expect(r.status).not.toBe('passed');
    expect(['unverified', 'failed']).toContain(r.status);
  });

  it('替换测试运行器配置 → unverified（验证基础设施变化）', async () => {
    const dir = await makeRepo({
      'package.json': JSON.stringify({ name: 'cfg', scripts: { test: realVitestScript() } }),
      'vitest.config.ts': "export default { test: { include: ['tests/**/*.test.ts'] } };\n",
    });
    await useRealVitest(dir);
    const base = await head(dir);
    await fs.writeFile(
      path.join(dir, 'vitest.config.ts'),
      "export default { test: { include: ['tests/**/*.test.ts'], exclude: ['tests/none/**'] } };\n",
    );
    const r = await runFixture(dir, 'test', { baselineRev: base });
    expect(r.status).toBe('unverified');
    // 配置/运行器变化属于「无法静态证明安全的变化」，走保守复核（test_scope_changed）
    expect(['test_scope_weakened', 'test_scope_changed']).toContain(r.status === 'unverified' ? r.unknownReason : null);
  });

  it('经用户明确重新确认当前范围后 → 同一范围可按当前基线通过（acceptCurrentScope 只用于用户操作）', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'reconfirm', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir);
    const base = await head(dir);
    await fs.writeFile(
      path.join(dir, 'tests', 'fixture.test.ts'),
      "import { describe, it, expect } from 'vitest';\ndescribe('fixture', () => { it('第一条真实用例', () => { expect(1).toBe(1); }); });\n",
    );
    const f = await fixture(dir, { baselineRev: base });
    const blocked = await runCheck(dir, 'test', testSandboxRunner(), { authorizedDigest: f.digest, identity: f.identity });
    expect(blocked.status).toBe('unverified');
    const accepted = await runCheck(dir, 'test', testSandboxRunner(), { authorizedDigest: f.digest, identity: f.identity, acceptCurrentScope: true });
    expect(accepted.status).toBe('passed');
    expect(accepted.evidence?.scope.kind).toBe('assessed_unchanged');
  });
});

describe('A1 反向矩阵：runProjectChecks 四态语义', () => {
  it('none / unavailable / unverified / ran 四态准确，且 checked 只在全部可信通过时为 true', async () => {
    const none = await makeRepo({ 'index.html': 'x' });
    expect((await runProjectChecks(none, testSandboxRunner(), { authorizedDigest: (await scriptsDigest(none))! })).kind).toBe('none');

    const unavail = await makeRepo({ 'package.json': JSON.stringify({ name: 'u', scripts: { test: realVitestScript() } }) });
    const noRunner = await runProjectChecks(unavail, undefined, { authorizedDigest: (await scriptsDigest(unavail))! });
    expect(noRunner.kind).toBe('unavailable');
    expect(noRunner.checked).toBe(false);

    const unverifiedDir = await makeRepo({ 'package.json': JSON.stringify({ name: 'uv', scripts: { test: 'echo ok' } }) });
    const unverified = await runProjectChecks(unverifiedDir, testSandboxRunner(), { authorizedDigest: (await scriptsDigest(unverifiedDir))! });
    expect(unverified.kind).toBe('unverified');
    expect(unverified.checked).toBe(false);
    expect(unverified.unverified).toHaveLength(1);

    const ranDir = await makeRepo({ 'package.json': JSON.stringify({ name: 'ran', scripts: { test: realVitestScript() } }) });
    await useRealVitest(ranDir);
    const f = await fixture(ranDir);
    const ran = await runProjectChecks(ranDir, testSandboxRunner(), { authorizedDigest: f.digest, identity: f.identity });
    expect(ran.kind).toBe('ran');
    expect(ran.checked).toBe(true);
    expect(ran.summary).toMatchObject({ passed: 1, failed: 0 });
  });
});

describe('A1 证据采集：批准时记录测试范围基线', () => {
  it('collectApprovedScopeBaseline 记录真实测试清单与运行器身份', async () => {
    const dir = await makeRepo({ 'package.json': JSON.stringify({ name: 'base', scripts: { test: realVitestScript() } }) });
    await useRealVitest(dir);
    const baseline = await collectApprovedScopeBaseline(dir);
    expect(baseline.testFileCount).toBeGreaterThan(0);
    expect(baseline.testBlockCount).toBeGreaterThan(0);
    expect(baseline.runnerName).toBe('vitest');
    expect(baseline.runnerVersion).toMatch(/^\d+\./);
    expect(baseline.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    const scripts = await detectScripts(dir);
    expect(scripts.test).toContain('vitest');
  });
});
