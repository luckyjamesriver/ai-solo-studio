import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import {
  detectScripts,
  runCheck,
  scriptsDigest,
  type CheckResult,
  type EvidenceIdentityContext,
  type SandboxCommandRunner,
} from '../src/core/checks/scripts.js';
import { computeTree, git, initRepo } from '../src/core/git/git.js';
import {
  assessScopeChange,
  readConfigFingerprintsFromTree,
  readPackageLockDigestFromTree,
  scanTestInventory,
  scanTestInventoryFromTree,
} from '../src/core/evidence/inventory.js';
import { buildReportEvidence, parseStdoutSummary, prepareVitestRun, readVitestReport } from '../src/core/evidence/vitest.js';
import { configFingerprintProblems } from '../src/core/evidence/validate.js';
import { adjudicateEvidence, adjudicateTaskEvidence, adjudicateStoredProof } from '../src/core/evidence/adjudicate.js';
import { saveChecksText } from '../src/core/task/model.js';
import type { HostCheckEvidence } from '../src/core/evidence/model.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir, useRealVitest } from './helpers.js';

/**
 * AISS-A1-TRUSTED-EVIDENCE-R1-001 专项反向矩阵。
 * 覆盖 R1-01（失败优先）、R1-02（保守范围复核）、R1-03（身份与统一裁决）、R1-05（恢复与完整性）。
 * 真实 Vitest / 真实 Git 场景优先；只有“磁盘状态构造”（报告损坏/复用、符号链接）用构造方式。
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await makeRepo(files);
  dirs.push(dir);
  return dir;
}

async function withVitest(files: Record<string, string> = {}): Promise<string> {
  const dir = await fixture({ ...files });
  await useRealVitest(dir);
  return dir;
}

async function identityFor(dir: string, over: Partial<EvidenceIdentityContext> = {}): Promise<{ digest: string; identity: EvidenceIdentityContext }> {
  const digest = (await scriptsDigest(dir))!;
  const tree = await computeTree(dir, dir);
  return {
    digest,
    identity: {
      projectRoot: dir,
      taskId: 'r1-task',
      round: 1,
      acceptanceRev: 1,
      testedTree: tree,
      baselineRev: (await git(dir, ['rev-parse', 'HEAD'])).trim(),
      ...over,
    },
  };
}

async function runTest(dir: string, opts: { runner?: SandboxCommandRunner; over?: Partial<EvidenceIdentityContext> } = {}): Promise<CheckResult> {
  const f = await identityFor(dir, opts.over ?? {});
  return runCheck(dir, 'test', opts.runner ?? testSandboxRunner(), { authorizedDigest: f.digest, identity: f.identity });
}

/** 运行后篡改报告目录，模拟「报告缺失/损坏/复用」等组合。 */
function tamperRunner(state: 'delete' | 'corrupt' | 'stale'): SandboxCommandRunner {
  const base = testSandboxRunner();
  return {
    kind: 'tamper-test-runner',
    async runCommand(req) {
      const r = await base.runCommand(req);
      const outIdx = req.argv.findIndex((a) => a.startsWith('--outputFile.json='));
      if (outIdx >= 0) {
        const reportPath = req.argv[outIdx]!.slice('--outputFile.json='.length);
        try {
          if (state === 'delete') await fs.rm(path.dirname(reportPath), { recursive: true, force: true });
          else if (state === 'corrupt') await fs.writeFile(reportPath, 'not-json-tampered');
          else {
            const old = new Date(Date.now() - 120_000);
            await fs.writeFile(reportPath, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, startTime: old.getTime(), testResults: [] }));
            await fs.utimes(reportPath, old, old);
          }
        } catch {
          // 文件不存在等：保持为“缺失”状态
        }
      }
      return r;
    },
  };
}

describe('R1-01 失败优先：真实进程失败不得降级为可人工放行的 unverified', () => {
  it('真实测试失败 + 报告缺失/损坏/复用 → failed（不是 unverified）', async () => {
    const dir = await withVitest();
    await useRealVitest(dir, { failWhen: 'trigger.txt' });
    await fs.writeFile(path.join(dir, 'trigger.txt'), 'x');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'trigger real failure']);
    for (const mode of ['delete', 'corrupt', 'stale'] as const) {
      const r = await runTest(dir, { runner: tamperRunner(mode) });
      expect(r.status, mode).toBe('failed');
    }
  });

  it('零测试 / 全部 skip / 全部 todo + 非零退出 → failed（不得因结构问题降级）', async () => {
    // 零测试：真实 vitest（passWithNoTests）+ 强制非零退出
    const zero = await fixture({ 'package.json': JSON.stringify({ name: 'zero', scripts: { test: `${realVitestScript()} --passWithNoTests` } }) });
    const nonZeroRunner = (base: SandboxCommandRunner): SandboxCommandRunner => ({
      kind: 'force-nonzero',
      async runCommand(req) {
        const r = await base.runCommand(req);
        return r.status === 'ran' ? { ...r, exitCode: 7 } : r;
      },
    });
    expect((await runTest(zero, { runner: nonZeroRunner(testSandboxRunner()) })).status).toBe('failed');

    // 全部 skip：真实 vitest + 强制非零退出
    const skips = await withVitest();
    await fs.writeFile(path.join(skips, 'tests/fixture.test.ts'), "import { it } from 'vitest';\nit.skip('a', () => {});\nit.skip('b', () => {});\n");
    await git(skips, ['add', '-A']);
    await git(skips, ['commit', '-m', 'all skip']);
    expect((await runTest(skips, { runner: nonZeroRunner(testSandboxRunner()) })).status).toBe('failed');
  });

  it('真实测试失败后 saveUncheckedTask 仍然阻断（不能绕过）', async () => {
    // 该行为由保存门禁 / checks_failed 分支保证，见 tests/a1-evidence-chain 与 security 基线；
    // 这里断言裁决层：failed 证据永远得到 failed 结论，不会因为人工确认路径变成 verified。
    const dir = await withVitest();
    await useRealVitest(dir, { failWhen: 'trigger.txt' });
    await fs.writeFile(path.join(dir, 'trigger.txt'), 'x');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'trigger']);
    const r = await runTest(dir);
    expect(r.status).toBe('failed');
    const ev = r.evidence!;
    expect(adjudicateEvidence(ev, 'test', { taskId: 'r1-task', round: 1, acceptanceRev: 1, acceptedTree: ev.identity.testedTree, projectRoot: dir, worktreePath: dir }).status).toBe('failed');
  });

  it('退出 0 但零测试 / 全跳过 → unverified（非 PASS），且原因结构化', async () => {
    const zero = await fixture({ 'package.json': JSON.stringify({ name: 'zero2', scripts: { test: `${realVitestScript()} --passWithNoTests` } }) });
    const zeroR = await runTest(zero);
    expect(zeroR.status).toBe('unverified');
    expect((zeroR as { unknownReason?: string }).unknownReason).toBe('tests_not_executed');

    const skips = await withVitest();
    await fs.writeFile(path.join(skips, 'tests/fixture.test.ts'), "import { it } from 'vitest';\nit.skip('a', () => {});\nit.skip('b', () => {});\n");
    await git(skips, ['add', '-A']);
    await git(skips, ['commit', '-m', 'skip']);
    const skipR = await runTest(skips);
    expect(skipR.status).toBe('unverified');
    expect((skipR as { unknownReason?: string }).unknownReason).toBe('all_tests_skipped');
  });
});

describe('R1-02 保守范围复核：逐文件下降不可被其它文件新增抵消、内容变化必须待确认', () => {
  it('单文件断言减少 + 另一文件断言新增（总数不降）→ 仍判 weakened', async () => {
    const dir = await fixture({ 'package.json': JSON.stringify({ name: 'scope', scripts: { test: realVitestScript() } }) });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests/a.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('a', () => {\n  it('a1', () => { expect(1).toBe(1); expect(2).toBe(2); });\n  it('a2', () => { expect(3).toBe(3); });\n});\n");
    await fs.writeFile(path.join(dir, 'tests/b.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('b', () => { it('b1', () => { expect(1).toBe(1); }); });\n");
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base tests']);
    const baseRev = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const baseline = await scanTestInventoryFromTree(dir, baseRev);
    const baseConfigs = await readConfigFingerprintsFromTree(dir, baseRev);
    const baseLock = await readPackageLockDigestFromTree(dir, baseRev);

    // 当前：a 文件断言 -1，b 文件断言 +5（总数反而增加）
    await fs.writeFile(path.join(dir, 'tests/a.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('a', () => {\n  it('a1', () => { expect(1).toBe(1); });\n  it('a2', () => { expect(3).toBe(3); });\n});\n");
    await fs.writeFile(path.join(dir, 'tests/b.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('b', () => {\n  it('b1', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); expect(4).toBe(4); expect(5).toBe(5); });\n});\n");
    const current = await scanTestInventory(dir);
    const assessment = assessScopeChange({
      baseline,
      current,
      baselineConfigs: baseConfigs,
      currentConfigs: [],
      baselineLock: baseLock,
      currentLock: undefined,
      baselineScriptsDigest: (await scriptsDigest(dir))!,
      currentScriptsDigest: (await scriptsDigest(dir))!,
    });
    expect(assessment.kind).toBe('assessed_weakened');
    expect(assessment.delta?.perFileAssertionDrops).toEqual([{ path: 'tests/a.test.ts', from: 3, to: 2 }]);
  });

  it('测试名称/数量完全相同但测试内容被改写（断言逻辑变化）→ needs_review，绝不 assessed_unchanged', async () => {
    const dir = await fixture({ 'package.json': JSON.stringify({ name: 'scope2', scripts: { test: realVitestScript() } }) });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    const before = "import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('same name', () => { expect(1 + 1).toBe(2); }); });\n";
    await fs.writeFile(path.join(dir, 'tests/x.test.ts'), before);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    const baseRev = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const baseline = await scanTestInventoryFromTree(dir, baseRev);
    // 同名、同数量，但断言被改成恒真
    await fs.writeFile(path.join(dir, 'tests/x.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('same name', () => { expect(true).toBe(true); }); });\n");
    const assessment = assessScopeChange({
      baseline,
      current: await scanTestInventory(dir),
      baselineConfigs: await readConfigFingerprintsFromTree(dir, baseRev),
      currentConfigs: [],
      baselineLock: await readPackageLockDigestFromTree(dir, baseRev),
      currentLock: undefined,
      baselineScriptsDigest: (await scriptsDigest(dir))!,
      currentScriptsDigest: (await scriptsDigest(dir))!,
    });
    expect(assessment.kind).toBe('assessed_needs_review');
    expect(assessment.delta?.testFilesModified).toContain('tests/x.test.ts');
  });

  it('辅助文件（fixtures/helper）变化 → needs_review', async () => {
    const dir = await fixture({ 'package.json': JSON.stringify({ name: 'scope3', scripts: { test: realVitestScript() } }) });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests/x.test.ts'), "import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('a', () => { expect(1).toBe(1); }); });\n");
    await fs.writeFile(path.join(dir, 'tests/helpers.ts'), 'export const fixture = 1;\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    const baseRev = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const baseline = await scanTestInventoryFromTree(dir, baseRev);
    await fs.writeFile(path.join(dir, 'tests/helpers.ts'), 'export const fixture = 2;\n');
    const assessment = assessScopeChange({
      baseline,
      current: await scanTestInventory(dir),
      baselineConfigs: await readConfigFingerprintsFromTree(dir, baseRev),
      currentConfigs: [],
      baselineLock: await readPackageLockDigestFromTree(dir, baseRev),
      currentLock: undefined,
      baselineScriptsDigest: (await scriptsDigest(dir))!,
      currentScriptsDigest: (await scriptsDigest(dir))!,
    });
    expect(assessment.kind).toBe('assessed_needs_review');
    expect(assessment.delta?.supportFilesChanged.join('；')).toContain('tests/helpers.ts');
  });

  it('只执行部分测试文件（脚本带过滤）→ needs_review，不能取得可信 PASS', async () => {
    const dir = await fixture({ 'package.json': JSON.stringify({ name: 'scope4', scripts: { test: realVitestScript() } }) });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests/one.test.ts'), "import { it, expect } from 'vitest';\nit('one', () => expect(1).toBe(1));\n");
    await fs.writeFile(path.join(dir, 'tests/two.test.ts'), "import { it, expect } from 'vitest';\nit('two', () => expect(2).toBe(2));\n");
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    pkg.scripts.test = `${realVitestScript()} tests/one.test.ts`;
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const r = await runTest(dir);
    expect(r.status).toBe('unverified');
    expect(['test_scope_changed', 'test_scope_weakened']).toContain((r as { unknownReason?: string }).unknownReason);
    expect(r.evidence?.report?.executedFiles).toEqual(['tests/one.test.ts']);
  });
});

describe('R1-03 证据身份与统一裁决', () => {
  it('两个真实独立项目、相同任务 ID 与相同内容 tree → 跨项目证据被拒绝', async () => {
    const a = await withVitest();
    const b = await withVitest();
    // 让两个项目内容 tree 完全相同
    const treeB = await computeTree(b, b);
    const ra = await runTest(a);
    expect(ra.status).toBe('passed');
    const ev = ra.evidence!;
    const sameTreeCtx = { taskId: 'r1-task', round: 1, acceptanceRev: 1, acceptedTree: ev.identity.testedTree, worktreePath: a };
    // 在项目 A 上下文有效
    expect(adjudicateEvidence(ev, 'test', { ...sameTreeCtx, projectRoot: a }).status).toBe('verified');
    // 换到项目 B（即使树相同）必须拒绝
    expect(adjudicateEvidence(ev, 'test', { ...sameTreeCtx, projectRoot: b }).status).toBe('invalidated');
    // 证据类型错误必须拒绝
    expect(adjudicateEvidence(ev, 'build', { ...sameTreeCtx, projectRoot: a }).status).toBe('invalidated');
    // 工作树身份不一致必须拒绝
    expect(adjudicateEvidence(ev, 'test', { ...sameTreeCtx, projectRoot: a, worktreePath: b }).status).toBe('invalidated');
    expect(treeB).toBe(ev.identity.testedTree);
  });

  it('统一裁决入口一致：任务记录一旦证据身份不符，卡片/证据页/保存门禁/反馈包事实同口径', async () => {
    const { makeRepo: _mr } = await import('./helpers.js');
    void _mr;
    const a = await withVitest();
    const b = await withVitest();
    const ra = await runTest(a);
    const ev = ra.evidence!;
    const t = {
      id: 'r1-task',
      request: 'r1',
      state: 'reviewing',
      denied: [],
      deniedAcks: [],
      criteria: [{ text: 'x', decision: 'confirmed' as const }],
      previewed: true,
      timeline: [],
      createdAt: 'x',
      updatedAt: 'x',
      currentRound: 1,
      acceptanceRev: 1,
      acceptedTree: ev.identity.testedTree,
      currentChecks: [{ name: 'test' as const, status: 'passed' as const, env: 'sandbox' as const, evidence: ev }],
      exit: { kind: 'exited' as const, code: 0 },
      binding: { repoPath: b, branch: 'main', baseHead: 'x' }, // 证据来自 A，任务记录属于 B
      card: {
        items: [
          { key: 'exit', label: 'AI 执行过程正常结束', status: 'verified', evidence: '退出码 0' },
          { key: 'changes', label: '有实际文件改动', status: 'verified', evidence: '1 个文件' },
          { key: 'test', label: '自动测试通过', status: 'verified', evidence: '旧卡片结论' },
        ],
        changes: [{ status: 'modified', path: 'a', additions: 1, deletions: 0 }],
        readyToSave: true,
        headline: '所有检查都已通过',
      },
    };
    const adj = adjudicateTaskEvidence(t as never);
    expect(adj.test?.status).toBe('invalidated');
    expect(adj.hasInvalidated).toBe(true);
    const { toUserView } = await import('../src/core/acceptance/view.js');
    const view = toUserView(t as never);
    expect(view.items.find((i) => i.key === 'test')?.status).toBe('invalidated');
    expect(view.proof.test.status).toBe('invalidated');
    const { saveBlockerCodes } = await import('../src/core/task/save-rules.js');
    expect(saveBlockerCodes(t as never)).toContain('evidence_invalid');
    const { buildTaskView } = await import('../src/core/app/task-view.js');
    const tv = buildTaskView(t as never, { scripts: ['build', 'test'], running: false });
    const fact = tv.result?.facts.find((f) => f.label.includes('测试'));
    expect(fact?.status).toBe('unchecked');
    expect(fact?.detail).toMatch(/失效/);
  });

  it('历史/旧记录：即使旧卡写着 verified 也不能变成可信 PASS；保存记录无证据也不显示检查通过', async () => {
    expect(saveChecksText({ checked: true })).toBe('检查通过（历史记录未核实）');
    expect(saveChecksText({ checked: true, evidenceIds: { test: 'e1' } })).toBe('检查通过');
    expect(saveChecksText({ checked: false })).toBe('未检查');
    const legacy = adjudicateStoredProof({ name: 'test', status: 'passed', env: 'sandbox' }, { taskId: 't', round: 1 });
    expect(legacy.status).toBe('unverified');
    expect(legacy.reason).toBe('legacy_unverified');
  });
});

describe('R1-05 证据恢复与完整性', () => {
  function buildEvidenceFixture(): HostCheckEvidence {
    return {
      schemaVersion: 1,
      kind: 'build',
      verdict: 'passed',
      trust: 'trusted',
      identity: { schemaVersion: 1, evidenceId: 'e', projectRootHash: 'p', taskId: 't', round: 1, acceptanceRev: 1, testedTree: 'a'.repeat(40), worktreePathHash: 'w' },
      run: { runId: 'r', startedAt: 'x', finishedAt: 'x', env: 'sandbox', sandboxKind: 'seatbelt', argv: [], timedOut: false, exitKind: 'exited', exitCode: 0, durationMs: 1, stdoutSha256: 's', stdoutBytes: 1, stderrSha256: 't' },
      config: { testConfigFiles: [], reporterMode: 'none', collectorVersion: 'a1-evidence-1' },
      scope: { kind: 'not_assessed', baselineAvailable: false, reasons: [] },
      valid: true,
    };
  }

  it('build 证据不因“测试运行器身份”被误判失效（重启复核误报修复）', () => {
    const ev = buildEvidenceFixture();
    const problems = configFingerprintProblems(ev, {
      scriptsDigest: ev.config.scriptsDigest,
      configFiles: [],
      runnerPackage: { name: 'vitest', version: '5.0.5', packageJsonSha256: 'abc' },
      packageLockDigest: ev.config.packageLockDigest,
    });
    expect(problems).toEqual([]);
  });

  it('配置变化对称检测：修改、删除、新增都能发现', () => {
    const ev = buildEvidenceFixture();
    ev.kind = 'test';
    ev.config.testConfigFiles = [{ path: 'vitest.config.ts', sha256: 'old' }, { path: 'vite.config.ts', sha256: 'same' }];
    const problems = configFingerprintProblems(ev, {
      scriptsDigest: undefined,
      configFiles: [{ path: 'vitest.config.ts', sha256: 'new' }, { path: 'vite.config.ts', sha256: 'same' }, { path: 'new.config.ts', sha256: 'x' }],
      packageLockDigest: undefined,
    });
    expect(problems.join('；')).toContain('测试配置变化：vitest.config.ts');
    expect(problems.join('；')).toContain('测试配置新增：new.config.ts');
    const removed = configFingerprintProblems(ev, { scriptsDigest: undefined, configFiles: [{ path: 'vite.config.ts', sha256: 'same' }], packageLockDigest: undefined });
    expect(removed.join('；')).toContain('测试配置被删除：vitest.config.ts');
  });

  it('报告交叉核对未发生时必须如实标为未通过（不得默认成功）', () => {
    const parse = {
      status: 'ok' as const,
      sha256: 's',
      bytes: 1,
      counts: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 },
      failedNames: [],
      executedFiles: ['tests/a.test.ts'],
      startTime: Date.now(),
      problems: [],
      checks: { regularFile: true, notSymlink: true, noHardlink: true, sizeOk: true, mtimeInWindow: true, startTimeInWindow: true, countsConsistent: true, successConsistent: true, testResultsArray: true },
    };
    const plan = { reportPath: '/tmp/x', reportDir: '/tmp/d', argv: [], nonce: 'n' } as never;
    const noStdout = buildReportEvidence({ plan, parse, stdoutSummary: undefined });
    expect(noStdout.crossCheck.performed).toBe(false);
    expect(noStdout.integrity.ok).toBe(false);
    expect(noStdout.integrity.problems.join('；')).toContain('交叉核对未发生');
    const withStdout = buildReportEvidence({ plan, parse, stdoutSummary: { passed: 2, failed: 0 } });
    expect(withStdout.crossCheck.performed).toBe(true);
    expect(withStdout.integrity.ok).toBe(true);
  });

  it('报告目录逃逸/符号链接 → 报告无效（拒绝路径逃逸）', async () => {
    const dir = await tmpDir('r1-escape-');
    dirs.push(dir);
    const outside = await tmpDir('r1-outside-');
    dirs.push(outside);
    await fs.mkdir(path.join(dir, '.studio'), { recursive: true });
    await fs.symlink(outside, path.join(dir, '.studio', 'evidence'), 'dir');
    // R2-01: prepareVitestRun 在创建目录前即拦截符号链接逃逸
    await expect(prepareVitestRun(dir, 'vitest run')).rejects.toThrow(/符号链接/);
  });

  it('ANSI 颜色输出也能完成 stdout 交叉核对', () => {
    const colored = '\u001b[2m      Tests \u001b[22m\u001b[1m\u001b[32m2 passed\u001b[39m\n';
    expect(parseStdoutSummary(colored)).toEqual({ passed: 2, failed: 0, skipped: 0 });
  });
});

describe('R1 Git 完整性：报告目录清理边界不越权', () => {
  it('prepareVitestRun 只在受控的 .studio/evidence/<nonce> 下创建并清理', async () => {
    const dir = await fixture({ 'index.html': 'x' });
    const plan = await prepareVitestRun(dir, 'vitest run');
    const evidenceRoot = await fs.realpath(path.join(dir, '.studio', 'evidence'));
    const realDir = await fs.realpath(plan.reportDir);
    expect(realDir.startsWith(evidenceRoot + path.sep)).toBe(true);
    expect(path.basename(realDir)).toBe(plan.nonce);
    expect(plan.nonce).toMatch(/^[0-9a-f]{32}$/);
    void crypto;
    void detectScripts;
    void initRepo;
  });
});
