import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createOwnedDir, verifyOwnedDir, removeOwnedDir } from '../src/core/persistence/owned-dir.js';
import { assertSafeControlledDir } from '../src/core/evidence/vitest.js';
import { saveChecksTextFor } from '../src/core/evidence/adjudicate.js';
import { prepareVitestRun, cleanupVitestRun, readVitestReport } from '../src/core/evidence/vitest.js';
import { adjudicateEvidence, adjudicateSaveRecord, adjudicateStoredProof } from '../src/core/evidence/adjudicate.js';
import { runProjectChecks, scriptsDigest } from '../src/core/checks/scripts.js';
import { diffTreePaths, git, treeOf } from '../src/core/git/git.js';
import type { ConfigFingerprint, HostCheckEvidence, TestCounts } from '../src/core/evidence/model.js';
import type { StoredCheckProof } from '../src/core/task/model.js';
import { makeRepo, testSandboxRunner, tmpDir } from './helpers.js';

/**
 * AISS-A1-R3 回归测试（快速；真实运行/中断的完整对照见 tests/r3-probes/*.probe.ts）。
 *
 * 覆盖：
 *  - R3-01 创建时所有权 + 身份/真实路径复核 + 保守清理；
 *  - R3-02 真实失败优先、trust/完整性/矛盾、记录状态与证据矛盾、runProjectChecks 消费统一裁决；
 *  - R3-03 静态范围与实际执行清单分开、用例减少/动态跳过进入复核；
 *  - R3-04 Git 字面路径语义；
 *  - R3-05 已保存记录的历史结论必须经统一裁决（不得虚构历史通过）。
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
    },
    run: {
      runId: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      env: 'sandbox',
      sandboxKind: 'seatbelt',
      argv: ['vitest', 'run'],
      timedOut: false,
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
    scope: { kind: 'assessed_unchanged', baselineAvailable: true, reasons: [], fingerprint: 'fp' },
    valid: true,
  };
  return { ...base, ...over, ...(over.report ? { report: { ...base.report!, ...over.report } } : {}), ...(over.run ? { run: { ...base.run, ...over.run } } : {}) };
}

const CTX = { taskId: 'task-1', round: 1, acceptanceRev: 1, acceptedTree: 'tree-1' };

describe('R3-01 宿主目录所有权：创建时固定授权根与目录身份', () => {
  it('正常创建/复核/清理', async () => {
    const root = await temp('r3-own-');
    const owned = await createOwnedDir(root, path.join('.studio', 'evidence', 'nonce1'));
    expect(await verifyOwnedDir(owned)).toBeUndefined();
    await fs.writeFile(path.join(root, '.studio', 'evidence', 'nonce1', 'f.txt'), 'x');
    expect(await removeOwnedDir(owned)).toBe('removed');
    await expect(fs.stat(path.join(root, '.studio', 'evidence', 'nonce1'))).rejects.toBeTruthy();
  });

  it('父目录被替换成符号链接：拒绝清理且外部文件原样保留', async () => {
    const root = await temp('r3-own-root-');
    const outside = await temp('r3-own-outside-');
    await fs.writeFile(path.join(outside, 'SENTINEL.txt'), 'KEEP');
    const owned = await createOwnedDir(root, path.join('.studio', 'evidence', 'nonce2'));
    await fs.rm(path.join(root, '.studio'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(root, '.studio'), 'dir');
    const problem = await verifyOwnedDir(owned);
    expect(problem?.kind).toBe('not_owned');
    await expect(removeOwnedDir(owned)).rejects.toThrow(/拒绝清理|符号链接|身份/);
    await expect(fs.readFile(path.join(outside, 'SENTINEL.txt'), 'utf8')).resolves.toBe('KEEP');
  });

  it('目录被移出授权根后再链接回来（dev/ino 相同）：拒绝清理', async () => {
    const root = await temp('r3-own-move-');
    const outside = await temp('r3-own-move-out-');
    await fs.writeFile(path.join(outside, 'SENTINEL.txt'), 'KEEP');
    const owned = await createOwnedDir(root, path.join('.studio', 'evidence', 'nonce3'));
    const inner = path.join(root, '.studio', 'evidence', 'nonce3', 'INTERNAL.txt');
    await fs.writeFile(inner, 'INTERNAL');
    await fs.rename(path.join(root, '.studio'), path.join(outside, 'moved'));
    await fs.symlink(path.join(outside, 'moved'), path.join(root, '.studio'), 'dir');
    await expect(removeOwnedDir(owned)).rejects.toThrow(/拒绝清理|符号链接|真实路径/);
    await expect(fs.readFile(path.join(outside, 'moved', 'evidence', 'nonce3', 'INTERNAL.txt'), 'utf8')).resolves.toBe('INTERNAL');
  });

  it('报告文件被换成指向外部文件的符号链接：读取必须拒绝', async () => {
    const root = await temp('r3-own-file-');
    const outside = await temp('r3-own-file-out-');
    const plan = await prepareVitestRun(root, 'vitest run');
    await fs.writeFile(path.join(outside, 'report.json'), '{}');
    await fs.rm(plan.reportPath, { force: true });
    await fs.symlink(path.join(outside, 'report.json'), plan.reportPath);
    const now = Date.now();
    const parsed = await readVitestReport(plan, { startMs: now - 10_000, endMs: now }, root);
    expect(parsed.status).not.toBe('ok');
    await cleanupVitestRun(plan);
    await expect(fs.readFile(path.join(outside, 'report.json'), 'utf8')).resolves.toBe('{}');
  });
});

describe('R3-02 统一裁决：失败优先 + trust/完整性/矛盾', () => {
  it('verdict=passed 但真实退出码非 0 → failed', () => {
    const adj = adjudicateEvidence(mkEvidence({ run: { exitCode: 1 } as never }), 'test', CTX);
    expect(adj.status).toBe('failed');
  });

  it('trust=weak → 不得 verified', () => {
    const adj = adjudicateEvidence(mkEvidence({ trust: 'weak' }), 'test', CTX);
    expect(adj.status).toBe('unverified');
  });

  it('完整性不成立 → 不得 verified', () => {
    const ev = mkEvidence();
    ev.report!.integrity = { ok: false, problems: ['x'], checks: {} };
    expect(adjudicateEvidence(ev, 'test', CTX).status).toBe('unverified');
  });

  it('证据失效 + 真实失败同时存在 → failed（失败优先）', () => {
    const adj = adjudicateEvidence(mkEvidence({ verdict: 'failed' }), 'test', { ...CTX, deepInvalidReason: '配置变化' });
    expect(adj.status).toBe('failed');
  });

  it('记录状态为 unverified 时，即使证据自称通过也不得升级', () => {
    const proof: StoredCheckProof = { name: 'test', status: 'unverified', env: 'sandbox', evidence: mkEvidence() };
    expect(adjudicateStoredProof(proof, CTX).status).toBe('unverified');
  });

  it('runProjectChecks 对没有宿主证据的“成功”不得算 checked', async () => {
    const repo = await makeRepo({ 'index.html': 'x\n' });
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'r3', scripts: { build: 'node -e "process.exit(0)"' } }));
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '--allow-empty', '-m', 'build only']);
    const outcome = await runProjectChecks(repo, testSandboxRunner(), { authorizedDigest: (await scriptsDigest(repo))! });
    expect(outcome.checked).toBe(false);
    expect(outcome.kind).not.toBe('ran');
  });
});

describe('R3-03 静态范围 vs 实际执行清单', () => {
  it('同一文件内部用例减少时，范围评估必须进入复核', async () => {
    const { assessScopeChange } = await import('../src/core/evidence/inventory.js');
    const { scanTestInventory } = await import('../src/core/evidence/inventory.js');
    const repo = await makeRepo({
      'tests/a.test.ts': "import { it } from 'vitest';\nit('a', () => {});\nit('b', () => {});\n",
    });
    const inv = await scanTestInventory(repo);
    const assessment = assessScopeChange({
      baseline: inv,
      current: inv,
      baselineConfigs: [],
      currentConfigs: [],
      executedFiles: ['tests/a.test.ts'],
      execution: {
        schemaVersion: 1,
        files: ['tests/a.test.ts'],
        perFile: [{ file: 'tests/a.test.ts', total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }],
        casesDigest: 'cases',
        cases: [{ file: 'tests/a.test.ts', name: 'a', status: 'passed' }],
        casesTruncated: false,
        counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        fingerprint: 'exec-1',
      },
    });
    expect(assessment.kind).toBe('assessed_needs_review');
    expect(assessment.reasons.join('\n')).toMatch(/用例执行减少/);
    expect(assessment.delta?.executedScope?.executedCases).toBe(1);
    expect(assessment.delta?.executedScope?.expectedCases).toBe(2);
  });

  it('不同执行清单得到不同的组合范围指纹', async () => {
    const { combinedScopeFingerprint } = await import('../src/core/evidence/inventory.js');
    expect(combinedScopeFingerprint('static', 'exec-a')).not.toBe(combinedScopeFingerprint('static', 'exec-b'));
    expect(combinedScopeFingerprint('static-a', 'exec')).not.toBe(combinedScopeFingerprint('static-b', 'exec'));
  });
});

describe('R3-04 Git 字面路径语义', () => {
  async function commitAll(dir: string, msg: string): Promise<string> {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--no-verify', '--allow-empty', '-m', msg]);
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  }

  it('通配文件名不会被当成通配符', async () => {
    const repo = await makeRepo({ 'star*.txt': '1\n', 'starX.txt': 'x\n' });
    const c1 = await commitAll(repo, 'c1');
    await fs.writeFile(path.join(repo, 'star*.txt'), '2\n');
    await fs.writeFile(path.join(repo, 'starX.txt'), 'y\n');
    const c2 = await commitAll(repo, 'c2');
    expect(await diffTreePaths(repo, c1, c2, ['star*.txt'])).toEqual(['star*.txt']);
  });

  it('根目录以冒号开头的文件名不会被当成 pathspec magic', async () => {
    const repo = await makeRepo({ ':magic.txt': '1\n' });
    const c1 = await commitAll(repo, 'c1');
    await fs.writeFile(path.join(repo, ':magic.txt'), '2\n');
    const c2 = await commitAll(repo, 'c2');
    expect(await diffTreePaths(repo, c1, c2, [':magic.txt'])).toEqual([':magic.txt']);
  });

  it('超过 500 个路径时全量分批比较仍能发现长尾漂移', async () => {
    const repo = await makeRepo({ 'index.html': 'x\n' });
    await fs.mkdir(path.join(repo, 'bulk'), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 560; i += 1) {
      const p = `bulk/f${String(i).padStart(3, '0')}.txt`;
      paths.push(p);
      await fs.writeFile(path.join(repo, p), 'v1\n');
    }
    const c1 = await commitAll(repo, 'bulk1');
    await fs.writeFile(path.join(repo, 'bulk/f540.txt'), 'v2\n');
    const c2 = await commitAll(repo, 'bulk2');
    const changed: string[] = [];
    for (let i = 0; i < paths.length; i += 200) changed.push(...(await diffTreePaths(repo, c1, c2, paths.slice(i, i + 200))));
    expect(changed).toEqual(['bulk/f540.txt']);
    expect(await treeOf(repo, c1)).not.toBe(await treeOf(repo, c2));
  }, 60_000);
});

describe('R3-05 已保存记录与历史证据展示', () => {
  it('旧记录没有结构化试检查证据：只能显示“历史记录未核实”', () => {
    const r = adjudicateSaveRecord({ checked: true, evidenceIds: { test: 'old' } }, { taskId: 't', round: 1 });
    expect(r.status).toBe('historical_unverified');
  });

  const bound = (over: Partial<HostCheckEvidence> = {}) => {
    const ev = mkEvidence(over);
    ev.identity.trialCommit = 'a'.repeat(40);
    ev.identity.testedTree = 'tree-1';
    return ev;
  };
  const rec = (ev: HostCheckEvidence) => ({
    checked: true,
    acceptanceRev: 1,
    trialCommit: 'a'.repeat(40),
    trialCommitTree: 'tree-1',
    trialChecks: [{ name: 'test' as const, status: 'passed' as const, env: 'sandbox' as const, evidence: ev }],
  });

  it('试检查证据未取得可信通过：不得显示检查通过', () => {
    const r = adjudicateSaveRecord(rec(bound({ trust: 'weak' })), { taskId: 'task-1', round: 1 });
    expect(r.status).toBe('unverified');
  });

  it('真实可信的试检查证据：历史结论为 verified', () => {
    const r = adjudicateSaveRecord(rec(bound()), { taskId: 'task-1', round: 1 });
    expect(r.status).toBe('verified');
  });

  it('未检查保存：不是检查通过', () => {
    expect(adjudicateSaveRecord({ checked: false }, { taskId: 't', round: 1 }).status).toBe('not_checked');
  });
});

describe('R3-01 补充：根目录被替换 / 硬链接 / .studio/tmp', () => {
  it('授权根被同名新目录替换：身份不一致，拒绝清理', async () => {
    const root = await temp('r3-root-replace-');
    const old = `${root}-old`;
    dirs.push(old);
    const owned = await createOwnedDir(root, '.studio');
    await fs.rename(root, old);
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, '.studio'));
    const problem = await verifyOwnedDir(owned);
    expect(problem?.kind).toBe('not_owned');
    await expect(removeOwnedDir(owned)).rejects.toThrow(/拒绝清理|身份/);
  });

  it('报告文件是外部文件的硬链接：读取必须拒绝（且外部内容不受影响）', async () => {
    const root = await temp('r3-hard-root-');
    const outside = await temp('r3-hard-out-');
    const plan = await prepareVitestRun(root, 'vitest run');
    await fs.writeFile(path.join(outside, 'shared.json'), '{"ok":true}');
    await fs.link(path.join(outside, 'shared.json'), plan.reportPath);
    const now = Date.now();
    const parsed = await readVitestReport(plan, { startMs: now - 10_000, endMs: now }, root);
    expect(parsed.status).toBe('invalid');
    await cleanupVitestRun(plan);
    await expect(fs.readFile(path.join(outside, 'shared.json'), 'utf8')).resolves.toBe('{"ok":true}');
  });

  it('.studio/tmp 是外部符号链接：受控目录断言必须拒绝', async () => {
    const root = await temp('r3-tmp-root-');
    const outside = await temp('r3-tmp-out-');
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.symlink(outside, path.join(root, '.studio', 'tmp'), 'dir');
    await expect(assertSafeControlledDir(root, path.join('.studio', 'tmp'))).rejects.toThrow(/符号链接/);
  });
});

describe('R3-05 补充：保存结论文案必须来自统一裁决', () => {
  it('旧记录（无结构化试检查证据）→ 历史记录未核实', () => {
    expect(saveChecksTextFor({ id: 'task-1', currentRound: 1, saveRecord: { checked: true, evidenceIds: { test: 'x' } } } as never)).toBe('检查通过（历史记录未核实）');
  });

  it('可信试检查证据 → 检查通过；未取得可信证据 → 不得显示通过', () => {
    const mk = (ev: HostCheckEvidence) => {
      ev.identity.trialCommit = 'a'.repeat(40);
      ev.identity.testedTree = 'tree-1';
      return {
        checked: true,
        acceptanceRev: 1,
        trialCommit: 'a'.repeat(40),
        trialCommitTree: 'tree-1',
        trialChecks: [{ name: 'test' as const, status: 'passed' as const, env: 'sandbox' as const, evidence: ev }],
      };
    };
    expect(saveChecksTextFor({ id: 'task-1', currentRound: 1, saveRecord: mk(mkEvidence()) } as never)).toBe('检查通过');
    expect(saveChecksTextFor({ id: 'task-1', currentRound: 1, saveRecord: mk(mkEvidence({ trust: 'weak' })) } as never)).not.toBe('检查通过');
  });
});
