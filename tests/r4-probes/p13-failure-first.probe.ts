/**
 * AISS-A1-R4-LAST-DELTA-001 / §2 反向探针：统一裁决失败优先。
 *
 * 旧候选：adjudicateStoredProof / adjudicateCheckResult 先看外围 status；
 * 当证据本身显示“已尝试运行且失败”（spawn_error / 非零退出）但外围状态是 not_available 时，
 * 被错误降级为 not_checked。新候选必须以有效归属的真实宿主证据为准：失败优先。
 */
import { describe, it, expect } from 'vitest';
import { runCheck, scriptsDigest } from '../../src/core/checks/scripts.js';
import { adjudicateCheckResult, adjudicateStoredProof } from '../../src/core/evidence/adjudicate.js';
import { git } from '../../src/core/git/git.js';
import type { StoredCheckProof } from '../../src/core/task/model.js';
import type { CheckResult } from '../../src/core/checks/scripts.js';
import { makeRepo } from '../helpers.js';

async function fixture(): Promise<{ dir: string; digest: string; identity: { projectRoot: string; taskId: string; round: number; acceptanceRev: number; testedTree: string; baselineRev: string }; ctx: { taskId: string; round: number; acceptanceRev: number; acceptedTree: string } }> {
  const dir = await makeRepo({
    'index.html': 'x\n',
    'package.json': JSON.stringify({ name: 'lastdelta-p13', scripts: { build: 'node -e "process.exit(0)"' } }),
  });
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--no-verify', '--allow-empty', '-m', 'build only']);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const tree = (await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
  const digest = (await scriptsDigest(dir))!;
  return {
    dir,
    digest,
    identity: { projectRoot: dir, taskId: 'p13', round: 1, acceptanceRev: 1, testedTree: tree, baselineRev: head },
    ctx: { taskId: 'p13', round: 1, acceptanceRev: 1, acceptedTree: tree },
  };
}

describe('LAST-DELTA 探针 P13：not_available 外围状态不得掩盖真实失败', () => {
  it('真实未执行 → not_checked；真实启动失败/非零退出 + 外围 not_available → failed', async () => {
    const f = await fixture();

    // 1) 真实未执行：沙箱不可用，进程根本没有尝试启动
    const notRun = await runCheck(f.dir, 'build', { runCommand: async () => ({ status: 'unavailable', reason: 'no sandbox' }) }, { authorizedDigest: f.digest, identity: f.identity });
    expect(notRun.status).toBe('not_available');
    const notRunProof: StoredCheckProof = { name: 'build', status: 'not_available', env: 'sandbox', evidence: notRun.evidence };
    expect(adjudicateStoredProof(notRunProof, f.ctx).status).toBe('not_checked');
    expect(adjudicateCheckResult(notRun, f.ctx).status).toBe('not_checked');

    // 2) 真实启动失败（进程没有拿到退出码）
    const spawnFail = await runCheck(f.dir, 'build', { runCommand: async () => ({ status: 'ran', exitCode: null, stdout: '', stderr: 'spawn failed', timedOut: false, durationMs: 1 }) }, { authorizedDigest: f.digest, identity: f.identity });
    expect(spawnFail.status).toBe('failed');

    // 3) 真实非零退出
    const exit1 = await runCheck(f.dir, 'build', { runCommand: async () => ({ status: 'ran', exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }) }, { authorizedDigest: f.digest, identity: f.identity });
    expect(exit1.status).toBe('failed');

    // 外围 status 被写成 not_available（迁移/损坏/旧版本），但证据显示已经尝试且失败 → 必须 failed
    const contradictorySpawn: StoredCheckProof = { name: 'build', status: 'not_available', env: 'sandbox', evidence: spawnFail.evidence };
    expect(adjudicateStoredProof(contradictorySpawn, f.ctx).status).toBe('failed');
    const contradictoryExit: StoredCheckProof = { name: 'build', status: 'not_available', env: 'sandbox', evidence: exit1.evidence };
    expect(adjudicateStoredProof(contradictoryExit, f.ctx).status).toBe('failed');

    const contradictoryResult: CheckResult = {
      name: 'build',
      status: 'not_available',
      unknownReason: 'sandbox_unavailable',
      reason: '外围状态说没跑',
      evidence: exit1.evidence,
    };
    expect(adjudicateCheckResult(contradictoryResult, f.ctx).status).toBe('failed');
  }, 60_000);
});
