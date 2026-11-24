import { pathIdentityHash, type HostCheckEvidence, type CheckUnknownReason, type ConfigFingerprint } from './model.js';
import type { StoredCheckProof, Task } from '../task/model.js';
import type { CheckResult } from '../checks/scripts.js';

/**
 * 统一可信证据裁决入口（R1-03 / R1-05）。
 *
 * 所有展示与门禁都必须经过这里，禁止各模块自行解释 `passed`：
 *  - 验收卡（card.ts）
 *  - 检查依据页（proof.ts）
 *  - 保存门禁（save-rules.ts + TaskRunner.doSave/previewSave）
 *  - 历史轮次（view.ts / history）
 *  - ChatGPT 反馈包（task-view.ts -> chatgptFeedback）
 *
 * 裁决顺序（失败优先、身份优先）：
 *  1. 没有宿主证据（旧记录）→ 历史未核实（绝不因旧卡片写着 verified 就通过）；
 *  2. 证据类型 / 任务 / 轮次 / 验收版本 / 被测内容 / 项目根 / 工作树身份不一致 → 证据失效；
 *  3. 深度复核（重启后配置漂移）→ 证据失效；
 *  4. 证据自标失效 → 失效；
 *  5. 测试范围被削弱/变化且没有匹配的用户确认 → unverified（阻断自动通过）；
 *  6. 真实失败 / 未执行 / 测试结构性证据不足 → 对应状态；
 *  7. 只有全部通过才是 verified。
 */

export type AdjudicatedStatus = 'verified' | 'failed' | 'unverified' | 'not_checked' | 'invalidated';

export interface CheckAdjudication {
  name: 'build' | 'test';
  status: AdjudicatedStatus;
  reason?: CheckUnknownReason;
  /** 面向用户的固定一句话说明（不含命令/路径/原始输出） */
  detail: string;
  counts?: { passed: number; failed: number; skipped: number; total: number } | null;
  evidenceId?: string;
  /** 是否被用户明确确认的范围覆盖（仅用于展示） */
  scopeConfirmed?: boolean;
}

export interface ScopeReviewBinding {
  scopeFingerprint: string;
  contentFingerprint: string;
  acceptanceVersion: string;
  confirmedAt?: string | undefined;
}

export interface EvidenceIdentityContextForAdjudication {
  taskId: string;
  round: number;
  acceptanceRev?: number | undefined;
  /** 当前验收版本字符串（如 "abcd1234abcd-3"），用于绑定用户确认 */
  acceptanceVersion?: string | undefined;
  acceptedTree?: string | undefined;
  /** 当前项目根真实路径（内部哈希后比较；不写入任何记录） */
  projectRoot?: string | undefined;
  /** 当前任务副本真实路径（内部哈希后比较） */
  worktreePath?: string | undefined;
  /** 期望的证据类型 */
  kind?: 'build' | 'test' | undefined;
  /** 重启深度复核发现的问题（只对当前轮次有效） */
  deepInvalidReason?: string | null | undefined;
  /** 用户确认过的范围（消费确认；历史轮次不传） */
  scopeReview?: ScopeReviewBinding | null | undefined;
  /** 历史轮次：跳过验收版本/内容/项目路径绑定，但仍要求有当时的结构化证据 */
  historical?: boolean | undefined;
}

function hashPath(p: string): string {
  return pathIdentityHash(p);
}

export function configKey(cfg: ConfigFingerprint): string {
  // 与 model.ts 的 configFingerprintKey 保持一致（此处避免循环依赖维护一份等价实现）
  const files = [...cfg.testConfigFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((c) => `${c.path}:${c.sha256}`).join(',');
  return [cfg.scriptsDigest ?? '-', cfg.packageLockDigest ?? '-', cfg.runnerPackage ? `${cfg.runnerPackage.name}@${cfg.runnerPackage.version}:${cfg.runnerPackage.packageJsonSha256}` : '-', cfg.testInventoryDigest ?? '-', String(cfg.testFileCount ?? 0), String(cfg.testBlockCount ?? 0), String(cfg.assertionCount ?? 0), String(cfg.skipMarkerCount ?? 0), String(cfg.onlyMarkerCount ?? 0), files].join('|');
}

function identityProblem(ev: HostCheckEvidence, ctx: EvidenceIdentityContextForAdjudication): string | undefined {
  if (ctx.kind && ev.kind !== ctx.kind) return '证据类型与检查项不符，已失效。';
  if (ev.identity.taskId !== ctx.taskId) return '证据属于另一个任务，已失效。';
  if (ev.identity.round !== ctx.round) return '证据属于另一轮次，已失效。';
  if (ctx.historical) return undefined;
  if ((ev.identity.acceptanceRev ?? 0) !== (ctx.acceptanceRev ?? 0)) return '验收版本已经变化，旧证据已失效。';
  if (ctx.acceptedTree && ev.identity.testedTree !== ctx.acceptedTree) return '被测内容与验收冻结内容不一致，证据已失效。';
  if (ctx.projectRoot && ev.identity.projectRootHash !== hashPath(ctx.projectRoot)) return '证据来自另一个项目，已失效。';
  if (ctx.worktreePath && ev.identity.worktreePathHash !== hashPath(ctx.worktreePath)) return '证据来自另一个任务副本，已失效。';
  return undefined;
}

function countsOf(ev: HostCheckEvidence | undefined): { passed: number; failed: number; skipped: number; total: number } | null {
  const c = ev?.report?.counts;
  return c ? { passed: c.passed, failed: c.failed, skipped: c.skipped, total: c.total } : null;
}

/** 证据级裁决：把一条宿主证据换算成唯一结论。 */
export function adjudicateEvidence(ev: HostCheckEvidence | undefined, name: 'build' | 'test', ctx: EvidenceIdentityContextForAdjudication): CheckAdjudication {
  const base = { name, counts: name === 'test' ? countsOf(ev) : undefined, ...(ev ? { evidenceId: ev.identity.evidenceId } : {}) };
  const unverified = (reason: CheckUnknownReason, detail: string): CheckAdjudication => ({ ...base, status: 'unverified', reason, detail });

  if (!ev) {
    return unverified('legacy_unverified', '历史记录未核实：没有可核验的宿主证据，不能算通过，也不能把旧结论当作可信 PASS。');
  }
  const problem = identityProblem(ev, { ...ctx, kind: name });
  if (problem) return { ...base, status: 'invalidated', reason: 'evidence_invalidated', detail: problem };
  if (ctx.deepInvalidReason) {
    return { ...base, status: 'invalidated', reason: 'evidence_invalidated', detail: `检查证据已失效：${ctx.deepInvalidReason}` };
  }
  if (ev.valid === false) {
    return { ...base, status: 'invalidated', reason: (ev.invalidReason as CheckUnknownReason | undefined) ?? 'evidence_invalidated', detail: `证据在生成时已被标记为失效${ev.invalidReason ? `（${ev.invalidReason}）` : ''}。` };
  }

  // 用户确认的范围绑定：只有三个指纹全部与当前证据一致时才接受
  const scopeNeedsReview = name === 'test' && (ev.scope.kind === 'assessed_weakened' || ev.scope.kind === 'assessed_needs_review');
  let scopeConfirmed = false;
  if (scopeNeedsReview) {
    const review = ctx.scopeReview;
    const matches = !!review
      && !!review.confirmedAt
      && review.scopeFingerprint === (ev.scope.fingerprint ?? configKey(ev.config))
      && review.contentFingerprint === ev.identity.testedTree
      && review.acceptanceVersion === (ctx.acceptanceVersion ?? '');
    if (!matches) {
      return unverified(ev.scope.kind === 'assessed_weakened' ? 'test_scope_weakened' : 'test_scope_changed', `测试范围需要你核对后明确重新确认：${ev.scope.reasons.join('；')}`);
    }
    scopeConfirmed = true;
  }

  if (ev.verdict === 'failed') {
    return { ...base, status: 'failed', detail: name === 'build' ? '构建没有通过' : '自动测试没有通过' };
  }
  if (ev.verdict === 'not_available') return { ...base, status: 'not_checked', reason: ev.reason, detail: '没有执行这项自动检查。' };
  if (ev.verdict === 'unverified') {
    return unverified(ev.reason ?? 'no_structured_evidence', '命令执行了，但没有取得可信的结构化测试证据，不能算通过。');
  }

  // verdict === 'passed'：仍需逐项核对结构性证据
  if (name === 'build') {
    const ok = ev.run.exitKind === 'exited' && ev.run.exitCode === 0;
    return ok ? { ...base, status: 'verified', detail: '构建通过（真实进程退出码 0）。' } : unverified('no_structured_evidence', '构建没有可信的进程证据，不能算通过。');
  }
  const report = ev.report;
  if (!report) return unverified('report_missing', '没有结构化测试报告，不能算通过。');
  if (!report.integrity.ok) return unverified('report_inconsistent', '结构化测试报告的完整性校验未通过，不能算通过。');
  const c = report.counts;
  if (!report.executedFiles || report.executedFiles.length === 0) return unverified('tests_not_executed', '报告没有记录任何实际执行的测试文件，不能算通过。');
  if (c.total === 0) return unverified('tests_not_executed', '报告显示没有执行任何测试用例，不能算通过。');
  if (c.failed > 0) return { ...base, status: 'failed', detail: '自动测试没有通过' };
  if (c.passed === 0) return unverified('all_tests_skipped', '没有真实执行通过的测试用例，不能算通过。');
  return { ...base, status: 'verified', detail: `自动测试通过（${c.passed} 项通过 / ${c.failed} 项失败 / ${c.skipped} 项跳过）。`, ...(scopeConfirmed ? { scopeConfirmed: true } : {}) };
}

/** 从已存储的检查凭证裁决（证据详情页 / 历史 / 保存门禁共用）。 */
export function adjudicateStoredProof(p: StoredCheckProof, ctx: Omit<EvidenceIdentityContextForAdjudication, 'kind'>): CheckAdjudication {
  if (p.status === 'not_available') {
    return { name: p.name, status: 'not_checked', reason: (p.evidence?.reason as CheckUnknownReason | undefined) ?? 'no_script', detail: p.unavailableReason ?? '未检查。' };
  }
  if (!p.evidence) {
    // 旧记录没有宿主证据：即使卡片写着 passed 也只是历史结论，不得变成可信 PASS
    if (p.status === 'failed') return { name: p.name, status: 'failed', detail: p.name === 'build' ? '构建没有通过（历史记录）' : '自动测试没有通过（历史记录）' };
    return { name: p.name, status: 'unverified', reason: 'legacy_unverified', detail: '历史记录未核实：旧记录没有结构化宿主证据，不能算通过。' };
  }
  return adjudicateEvidence(p.evidence, p.name, { ...ctx, kind: p.name });
}

/** 从刚运行完的检查结果裁决（runner → 验收卡）。 */
export function adjudicateCheckResult(c: CheckResult, ctx: EvidenceIdentityContextForAdjudication): CheckAdjudication {
  if (c.status === 'not_available') {
    return { name: c.name, status: 'not_checked', reason: c.unknownReason, detail: c.reason };
  }
  if (c.evidence) return adjudicateEvidence(c.evidence, c.name, { ...ctx, kind: c.name });
  if (c.status === 'failed') return { name: c.name, status: 'failed', detail: c.name === 'build' ? '构建没有通过' : '自动测试没有通过' };
  return { name: c.name, status: 'unverified', reason: c.status === 'unverified' ? c.unknownReason : 'no_structured_evidence', detail: '没有可核验的宿主证据，不能算通过。' };
}

/** 当前轮次全部检查的统一裁决（保存门禁 / 视图 / 反馈包共用）。 */
export function adjudicateTaskEvidence(t: Pick<Task, 'id' | 'currentRound' | 'acceptanceRev' | 'acceptedTree' | 'currentChecks' | 'evidenceInvalid' | 'scopeReview' | 'binding' | 'worktree'>): {
  items: CheckAdjudication[];
  build?: CheckAdjudication;
  test?: CheckAdjudication;
  /** 保存核心门禁：证据失效必须阻断 */
  hasInvalidated: boolean;
  /** 自动测试真实失败 */
  hasFailed: boolean;
  /** 测试范围需要用户确认（阻断保存直到确认） */
  needsScopeConfirm: boolean;
} {
  const round = t.currentRound ?? 1;
  const ctx: Omit<EvidenceIdentityContextForAdjudication, 'kind'> = {
    taskId: t.id,
    round,
    ...(t.acceptanceRev !== undefined ? { acceptanceRev: t.acceptanceRev } : {}),
    ...(t.acceptanceRev !== undefined && t.acceptedTree ? { acceptanceVersion: `${t.acceptedTree.slice(0, 12)}-${t.acceptanceRev}` } : {}),
    ...(t.acceptedTree ? { acceptedTree: t.acceptedTree } : {}),
    ...(t.binding?.repoPath ? { projectRoot: t.binding.repoPath } : {}),
    ...(t.worktree?.path ? { worktreePath: t.worktree.path } : {}),
    ...(t.evidenceInvalid?.reason ? { deepInvalidReason: t.evidenceInvalid.reason } : {}),
    ...(t.scopeReview ? { scopeReview: t.scopeReview } : {}),
  };
  const proofs = t.currentChecks ?? [];
  const items = proofs.map((p) => adjudicateStoredProof(p, ctx));
  const build = items.find((i) => i.name === 'build');
  const test = items.find((i) => i.name === 'test');
  const hasInvalidated = items.some((i) => i.status === 'invalidated');
  const hasFailed = items.some((i) => i.status === 'failed');
  const needsScopeConfirm = items.some((i) => i.name === 'test' && i.reason === 'test_scope_weakened') || (!!t.scopeReview && !t.scopeReview.confirmedAt);
  return { items, ...(build ? { build } : {}), ...(test ? { test } : {}), hasInvalidated, hasFailed, needsScopeConfirm };
}

/** 历史轮次裁决：只按「当时是否有结构化证据」判定，不把旧卡结论升级为可信 PASS。 */
export function adjudicateRoundChecks(
  checks: StoredCheckProof[] | undefined,
  opts: { taskId: string; round: number; acceptedTree?: string | undefined },
): CheckAdjudication[] {
  const ctx: Omit<EvidenceIdentityContextForAdjudication, 'kind'> = { taskId: opts.taskId, round: opts.round, historical: true, ...(opts.acceptedTree ? { acceptedTree: opts.acceptedTree } : {}) };
  return (checks ?? []).map((p) => adjudicateStoredProof(p, ctx));
}
