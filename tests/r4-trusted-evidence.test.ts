import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { prepareVitestRun, cleanupVitestRun, readVitestReport } from '../src/core/evidence/vitest.js';
import { createWorktree, removeWorktree } from '../src/core/git/git.js';
import { adjudicateEvidence, adjudicateSaveRecord, adjudicateStoredProof, saveChecksTextFor } from '../src/core/evidence/adjudicate.js';
import { currentScopeFingerprint, runCheck, scriptsDigest } from '../src/core/checks/scripts.js';
import type { ConfigFingerprint, ExecutionManifest, HostCheckEvidence, TestCounts } from '../src/core/evidence/model.js';
import type { StoredCheckProof } from '../src/core/task/model.js';
import { makeRepo, testSandboxRunner, tmpDir } from './helpers.js';

/**
 * AISS-A1-R4 回归测试（快速；真实保存/中断对照见 tests/r4-probes/*.probe.ts）。
 *
 * 覆盖 R4-01 保守保留、R4-02 执行清单指纹、R4-04 试检查证据严格绑定/历史展示/未执行与启动失败区分。
 */

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});
async function temp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  dirs.push(d);
  return d;
}

const COUNTS: TestCounts = { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 };
const CONFIG: ConfigFingerprint = {
  scriptsDigest: 'scripts-1',
  packageLockDigest: 'lock-1',
  runnerPackage: { name: 'vitest', version: '5.0.5', packageJsonSha256: 'vpkg' },
  runnerEntry: { pathHash: 'entry-hash', sha256: 'entry-sha' },
  deps: [{ name: 'vite', version: '6.4.5', packageJsonSha256: 'vite-pkg' }],
  testConfigFiles: [{ path: 'vitest.config.ts', sha256: 'cfg' }],
  testInventoryDigest: 'inv',
  testFileCount: 1,
  testBlockCount: 2,
  assertionCount: 2,
  skipMarkerCount: 0,
  onlyMarkerCount: 0,
  reporterMode: 'vitest-json-cli',
  collectorVersion: 'a1-evidence-1',
};

function mkEvidence(over: Partial<HostCheckEvidence> = {}): HostCheckEvidence {
  const base: HostCheckEvidence = {
    schemaVersion: 1,
    kind: 'test',
    verdict: 'passed',
    trust: 'trusted',
    identity: {
      schemaVersion: 1,
      evidenceId: 'ev-1',
      projectRootHash: 'proj',
      taskId: 'task-1',
      round: 1,
      acceptanceRev: 1,
      testedTree: 'tree-1',
      worktreePathHash: 'wt',
      trialCommit: 'a'.repeat(40),
    },
    run: {
      runId: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      env: 'sandbox',
      sandboxKind: 'seatbelt',
      argv: ['vitest', 'run'],
      timedOut: false,
      attempted: true,
      exitKind: 'exited',
      exitCode: 0,
      durationMs: 10,
      stdoutSha256: 'o',
      stdoutBytes: 1,
      stderrSha256: 'e',
    },
    config: CONFIG,
    report: {
      format: 'vitest-json',
      executedFiles: ['tests/a.test.ts'],
      pathHash: 'p',
      sha256: 'r',
      bytes: 10,
      producedDuringRun: true,
      startTimeWithinRun: true,
      counts: { ...COUNTS },
      failedNames: [],
      integrity: { ok: true, problems: [], checks: { countsConsistent: true } },
      crossCheck: { performed: true, agrees: true, stdoutSummary: { passed: 2, failed: 0 } },
    },
    scope: { kind: 'assessed_unchanged', baselineAvailable: true, reasons: [], fingerprint: 'fp', executionFingerprint: 'exec-1' },
    valid: true,
  };
  return { ...base, ...over, ...(over.report ? { report: { ...base.report!, ...over.report } } : {}), ...(over.run ? { run: { ...base.run, ...over.run } } : {}) };
}

const CTX = { taskId: 'task-1', round: 1, acceptanceRev: 1, acceptedTree: 'tree-1', trialCommit: 'a'.repeat(40) };

describe('R4-01 宿主删除：报告目录保守保留，读取仍校验所有权与身份', () => {
  it('cleanup 不删除报告目录（随任务副本由 git worktree remove 回收）', async () => {
    const root = await temp('r4-own-');
    const plan = await prepareVitestRun(root, 'vitest run');
    await fs.writeFile(plan.reportPath, '{"testResults":[]}');
    await cleanupVitestRun(plan);
    await expect(fs.stat(plan.reportDir)).resolves.toBeTruthy();
    const src = await fs.readFile(path.resolve('src/core/evidence/vitest.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function cleanupVitestRun'), src.indexOf('export function sha256Text'));
    expect(body).not.toMatch(/fs\.rm|removeOwnedDir|rmdir|unlink/);
  });

  it('报告被替换成指向外部文件的符号链接 → invalid，且外部文件不被删除', async () => {
    const root = await temp('r4-sym-');
    const outside = await temp('r4-sym-out-');
    const plan = await prepareVitestRun(root, 'vitest run');
    const outsideFile = path.join(outside, 'r.json');
    await fs.writeFile(outsideFile, '{}');
    const now = Date.now();
    // 用一个合法的报告文件占位，再替换为符号链接
    await fs.writeFile(plan.reportPath, '{"testResults":[]}');
    await fs.rm(plan.reportPath, { force: true });
    await fs.symlink(outsideFile, plan.reportPath);
    const parsed = await readVitestReport(plan, { startMs: now - 10_000, endMs: now }, root);
    expect(parsed.status).not.toBe('ok');
    await cleanupVitestRun(plan);
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('{}');
  });

  it('最终清理：任务副本被替换成指向外部仓库的符号链接 → git 归属校验拒绝，外部文件保留', async () => {
    const base = await temp('r4-wt-');
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo);
    for (const args of [['init', '-q', '-b', 'main', repo], ['-C', repo, 'config', 'user.name', 't'], ['-C', repo, 'config', 'user.email', 't@t']]) execFileSync('git', args);
    await fs.writeFile(path.join(repo, 'index.html'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    const wt = await createWorktree(repo, '20240101000000-r4own');
    const victim = path.join(base, 'victim');
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, 'USER.txt'), 'PRECIOUS');
    await fs.rm(wt.path, { recursive: true, force: true });
    await fs.symlink(victim, wt.path, 'dir');
    const r = await removeWorktree(repo, wt);
    expect(r.ok).toBe(false);
    await expect(fs.readFile(path.join(victim, 'USER.txt'), 'utf8')).resolves.toBe('PRECIOUS');
  }, 30_000);
});

describe('R4-02 执行清单指纹：数量相同也必须区分用例身份与状态', () => {
  const manifest = (fingerprint: string): ExecutionManifest => ({
    schemaVersion: 1,
    files: ['tests/a.test.ts'],
    perFile: [{ file: 'tests/a.test.ts', total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }],
    casesDigest: fingerprint,
    cases: [],
    casesTruncated: false,
    counts: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 },
    fingerprint,
  });

  it('文件与计数完全一致、用例身份不同 → 组合范围指纹必须不同', async () => {
    const repo = await makeRepo({ 'tests/a.test.ts': "import { it } from 'vitest';\nit('a',()=>{});\n" });
    const a = await currentScopeFingerprint(repo, ['tests/a.test.ts'], COUNTS, manifest('cases-A'));
    const b = await currentScopeFingerprint(repo, ['tests/a.test.ts'], COUNTS, manifest('cases-B'));
    expect(a).not.toBe(b);
  });
});

describe('R4-04 已保存记录：严格绑定与历史展示', () => {
  const boundRec = (ev: HostCheckEvidence) => ({
    checked: true,
    acceptanceRev: 1,
    trialCommit: 'a'.repeat(40),
    trialCommitTree: 'tree-1',
    trialChecks: [{ name: 'test' as const, status: 'passed' as const, env: 'sandbox' as const, evidence: ev }],
  });

  it('缺少 trialCommit/tree 绑定的旧记录 → 只能历史未核实', () => {
    const legacy = { checked: true, trialChecks: [{ name: 'test' as const, status: 'passed' as const, env: 'sandbox' as const, evidence: mkEvidence() }] };
    expect(adjudicateSaveRecord(legacy, { taskId: 'task-1', round: 1 }).status).toBe('historical_unverified');
  });

  it('绑定完整且证据可信 → verified；树不一致 → 不得 verified', () => {
    expect(adjudicateSaveRecord(boundRec(mkEvidence()), { taskId: 'task-1', round: 1 }).status).toBe('verified');
    const wrongTree = mkEvidence();
    wrongTree.identity.testedTree = 'other-tree';
    expect(adjudicateSaveRecord(boundRec(wrongTree), { taskId: 'task-1', round: 1 }).status).not.toBe('verified');
  });

  it('历史轮次也不得用 historical 绕过被测 tree 校验', () => {
    const ev = mkEvidence();
    ev.identity.testedTree = 'other-tree';
    const proof: StoredCheckProof = { name: 'test', status: 'passed', env: 'sandbox', evidence: ev };
    const adj = adjudicateStoredProof(proof, { taskId: 'task-1', round: 1, historical: true, acceptedTree: 'tree-1' });
    expect(adj.status).toBe('invalidated');
  });

  it('失败证据 → 文案不得包含“检查通过”', () => {
    const ev = mkEvidence({ verdict: 'failed' });
    const rec = boundRec(ev);
    const text = saveChecksTextFor({ id: 'task-1', currentRound: 1, saveRecord: rec } as never);
    expect(text).not.toContain('检查通过');
    expect(adjudicateSaveRecord(rec, { taskId: 'task-1', round: 1 }).status).toBe('failed');
  });

  it('缺证据但 checked=true → 不是检查通过', () => {
    expect(adjudicateSaveRecord({ checked: true }, { taskId: 'task-1', round: 1 }).status).toBe('historical_unverified');
  });
});

describe('R4-04 未执行检查 vs 真实启动失败', () => {
  it('not_available（占位 spawn_error、attempted=false）→ not_checked；真实 spawn_error → failed', async () => {
    const dir = await makeRepo({
      'index.html': 'x\n',
      'package.json': JSON.stringify({ name: 'r4d', scripts: { build: 'node -e "process.exit(0)"' } }),
    });
    await scriptsDigest(dir);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    const tree = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}']).toString().trim();
    const identity = { projectRoot: dir, taskId: 'r4d', round: 1, acceptanceRev: 1, testedTree: tree, baselineRev: head };
    const ctx = { taskId: 'r4d', round: 1, acceptanceRev: 1, acceptedTree: tree };
    const digest = (await scriptsDigest(dir))!;

    const notRun = await runCheck(dir, 'build', { runCommand: async () => ({ status: 'unavailable', reason: 'no sandbox' }) }, { authorizedDigest: digest, identity });
    expect(notRun.status).toBe('not_available');
    expect(adjudicateEvidence(notRun.evidence, 'build', ctx).status).toBe('not_checked');

    const spawnFail = await runCheck(
      dir,
      'build',
      { runCommand: async () => ({ status: 'ran', exitCode: null, stdout: '', stderr: 'spawn failed', timedOut: false, durationMs: 1 }) },
      { authorizedDigest: digest, identity },
    );
    expect(spawnFail.status).toBe('failed');
    expect(adjudicateEvidence(spawnFail.evidence, 'build', ctx).status).toBe('failed');
  }, 30_000);
});
