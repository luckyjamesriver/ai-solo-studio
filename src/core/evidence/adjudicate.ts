import { pathIdentityHash, type HostCheckEvidence, type CheckUnknownReason, type ConfigFingerprint } from './model.js';
import type { SaveRecord, StoredCheckProof, Task } from '../task/model.js';
import type { CheckResult } from '../checks/scripts.js';

/**
 * 统一可信证据裁决入口（R1-03 / R1-05 / R3-02）。
 *
 * 所有展示与门禁都必须经过这里，禁止各模块自行解释 `passed` 或 `status` 字符串：
 *  - 验收卡（card.ts）
 *  - 检查依据页（proof.ts）
 *  - 保存门禁（save-rules.ts + TaskRunner.doSave/previewSave）
 *  - 试合并一致性（runner.trialEvidenceInconsistency）
 *  - 历史轮次与已保存记录（view.ts / history.ts / task-view.ts）
 *  - ChatGPT 反馈包（task-view.ts -> chatgptFeedback）
 *
 * 裁决顺序（失败优先、归属优先、证据完整优先）：
 *  1. 没有宿主证据（旧记录）→ 历史未核实（绝不因旧卡片写着 verified 就通过）；
 *  2. 证据不属于本任务 / 本轮次 / 本检查项 → 失效（失败事实不能跨任务借用）；
 *  3. **真实失败事实优先**：verdict=failed、真实退出码非 0 / 未正常结束、报告内用例失败。
 *     即使同时存在范围变化、证据失效、深度复核问题，也必须判 failed，不得降级为待确认；
 *  4. 其余身份不一致 / 深度复核失效 / 自标失效 → 证据失效；
 *  5. 测试范围被削弱/变化且没有匹配的用户确认 → unverified（阻断自动通过）；
 *  6. 未执行 / 无结构化证据 → 对应状态；
 *  7. verdict=passed 仍须逐项核对：trust 必须是 trusted、报告完整性、实际执行、计数与通过数；
 *  8. 只有以上全部成立才是 verified。
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
  /** R3-03：用户确认时绑定的实际执行清单指纹（文件 + 用例身份 + 执行状态） */
  executionFingerprint?: string;
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
  /** 已有哈希时直接比较（用于历史/已保存记录，不需要文件系统） */
  projectRootHash?: string | undefined;
  worktreePathHash?: string | undefined;
  /** R4-04：试检查证据必须属于本次试合并提交 */
  trialCommit?: string | undefined;
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

/** 配置指纹的稳定键（覆盖有效配置、脚本、锁文件、运行器入口与可验证依赖）。 */
export function configKey(cfg: ConfigFingerprint): string {
  const files = [...cfg.testConfigFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((c) => `${c.path}:${c.sha256}`).join(',');
  const deps = [...(cfg.deps ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((d) => `${d.name}@${d.version}:${d.packageJsonSha256}`).join(',');
  return [
    cfg.scriptsDigest ?? '-',
    cfg.packageLockDigest ?? '-',
    cfg.runnerPackage ? `${cfg.runnerPackage.name}@${cfg.runnerPackage.version}:${cfg.runnerPackage.packageJsonSha256}` : '-',
    cfg.runnerEntry ? `${cfg.runnerEntry.pathHash}:${cfg.runnerEntry.sha256}` : '-',
    deps || '-',
    cfg.testInventoryDigest ?? '-',
    String(cfg.testFileCount ?? 0),
    String(cfg.testBlockCount ?? 0),
    String(cfg.assertionCount ?? 0),
    String(cfg.skipMarkerCount ?? 0),
    String(cfg.onlyMarkerCount ?? 0),
    files,
  ].join('|');
}

/** 归属问题（任务 / 轮次 / 检查项）：这些不成立时，证据里的“失败”也不能算到本任务头上。 */
function attributionProblem(ev: HostCheckEvidence, ctx: EvidenceIdentityContextForAdjudication, name: 'build' | 'test'): string | undefined {
  if (ev.kind !== name) return '证据类型与检查项不符，已失效。';
  if (ev.identity.taskId !== ctx.taskId) return '证据属于另一个任务，已失效。';
  if (ev.identity.round !== ctx.round) return '证据属于另一轮次，已失效。';
  return undefined;
}

/** 其余身份问题（验收版本 / 被测内容 / 项目 / 副本）。 */
function identityProblem(ev: HostCheckEvidence, ctx: EvidenceIdentityContextForAdjudication): string | undefined {
  // R4-04：历史模式只允许跳过“当时的验收版本序号”，被测 tree / 项目 / 副本 / 试合并提交仍然必须核对。
  if (!ctx.historical && (ev.identity.acceptanceRev ?? 0) !== (ctx.acceptanceRev ?? 0)) return '验收版本已经变化，旧证据已失效。';
  if (ctx.acceptedTree && ev.identity.testedTree !== ctx.acceptedTree) return '被测内容与验收冻结内容不一致，证据已失效。';
  if (ctx.trialCommit && ev.identity.trialCommit !== ctx.trialCommit) return '试检查证据不属于本次试合并提交，证据已失效。';
  if (ctx.projectRootHash && ev.identity.projectRootHash !== ctx.projectRootHash) return '证据来自另一个项目，已失效。';
  if (ctx.projectRoot && ev.identity.projectRootHash !== hashPath(ctx.projectRoot)) return '证据来自另一个项目，已失效。';
  if (ctx.worktreePathHash && ev.identity.worktreePathHash !== ctx.worktreePathHash) return '证据来自另一个任务副本，已失效。';
  if (ctx.worktreePath && ev.identity.worktreePathHash !== hashPath(ctx.worktreePath)) return '证据来自另一个任务副本，已失效。';
  return undefined;
}

/**
 * 真实失败事实：只看宿主记录的事实本身，不看 verdict 自述。
 * 真实退出状态与 verdict 矛盾时，以真实退出状态为准（失败优先）。
 */
export function failureFactDetail(ev: HostCheckEvidence, name: 'build' | 'test'): string | undefined {
  const failedText = name === 'build' ? '构建没有通过' : '自动测试没有通过';
  if (ev.verdict === 'failed') return failedText;
  // R4-04：not_available 的占位运行记录（attempted=false）表示“未执行检查”，不是启动失败。
  const attempted = ev.run.attempted ?? ev.verdict !== 'not_available';
  if (!attempted) return undefined;
  if (ev.run.exitKind !== 'exited') {
    return name === 'build' ? '构建进程没有正常结束' : '自动测试进程没有正常结束';
  }
  if (ev.run.exitCode === null) return `${name === 'build' ? '构建' : '自动测试'}进程没有返回真实退出码，不能算通过`;
  if (ev.run.exitCode !== 0) {
    return `${name === 'build' ? '构建' : '自动测试'}真实进程退出码 ${ev.run.exitCode}（与“通过”的结论矛盾）`;
  }
  const counts = ev.report?.counts;
  if (counts && counts.failed > 0) return `自动测试报告里有 ${counts.failed} 项真实失败`;
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
  const invalidated = (detail: string): CheckAdjudication => ({ ...base, status: 'invalidated', reason: 'evidence_invalidated', detail });
  const failed = (detail: string): CheckAdjudication => ({ ...base, status: 'failed', detail });

  if (!ev) {
    return unverified('legacy_unverified', '历史记录未核实：没有可核验的宿主证据，不能算通过，也不能把旧结论当作可信 PASS。');
  }
  // 1) 归属：不属于本任务/轮次/检查项的证据，其“失败”也不能借用
  const attr = attributionProblem(ev, ctx, name);
  if (attr) return invalidated(attr);

  // 2) 未执行检查（attempted=false）不是失败；真实启动失败/非零退出才是失败
  const attempted = ev.run.attempted ?? ev.verdict !== 'not_available';
  if (!attempted) {
    return { ...base, status: 'not_checked', reason: ev.reason ?? 'no_script', detail: '没有执行这项自动检查。' };
  }
  const failure = failureFactDetail(ev, name);
  if (failure) return failed(failure);

  // 3) 其余身份 / 深度复核 / 自标失效
  const problem = identityProblem(ev, ctx);
  if (problem) return invalidated(problem);
  if (ctx.deepInvalidReason) return invalidated(`检查证据已失效：${ctx.deepInvalidReason}`);
  if (ev.valid === false) {
    return invalidated(`证据在生成时已被标记为失效${ev.invalidReason ? `（${ev.invalidReason}）` : ''}。`);
  }

  // 4) 测试范围被削弱 / 变化：没有匹配的用户确认就阻断
  const scopeNeedsReview = name === 'test' && (ev.scope.kind === 'assessed_weakened' || ev.scope.kind === 'assessed_needs_review');
  let scopeConfirmed = false;
  if (scopeNeedsReview) {
    const review = ctx.scopeReview;
    const matches = !!review
      && !!review.confirmedAt
      && review.scopeFingerprint === (ev.scope.fingerprint ?? configKey(ev.config))
      && (review.executionFingerprint ?? '') === (ev.scope.executionFingerprint ?? '')
      && review.contentFingerprint === ev.identity.testedTree
      && review.acceptanceVersion === (ctx.acceptanceVersion ?? '');
    if (!matches) {
      return unverified(ev.scope.kind === 'assessed_weakened' ? 'test_scope_weakened' : 'test_scope_changed', `测试范围需要你核对后明确重新确认：${ev.scope.reasons.join('；')}`);
    }
    scopeConfirmed = true;
  }

  if (ev.verdict === 'not_available') return { ...base, status: 'not_checked', reason: ev.reason, detail: '没有执行这项自动检查。' };
  if (ev.verdict === 'unverified') {
    return unverified(ev.reason ?? 'no_structured_evidence', '命令执行了，但没有取得可信的结构化测试证据，不能算通过。');
  }

  // 5) verdict === 'passed'：仍须逐项核对结构性证据，尤其是 trust 等级
  if (ev.trust !== 'trusted') {
    return unverified('no_structured_evidence', '证据可信等级不足（只有命令级观察，没有可信的结构化证据），不能算通过。');
  }
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
  if (c.failed > 0) return failed('自动测试没有通过');
  if (c.passed === 0) return unverified('all_tests_skipped', '没有真实执行通过的测试用例，不能算通过。');
  return { ...base, status: 'verified', detail: `自动测试通过（${c.passed} 项通过 / ${c.failed} 项失败 / ${c.skipped} 项跳过）。`, ...(scopeConfirmed ? { scopeConfirmed: true } : {}) };
}

/**
 * 从已存储的检查凭证裁决（证据详情页 / 历史 / 保存门禁共用）。
 * 记录里的 `status` 本身也是事实：失败就是失败；记录为未核实时，即使证据自称通过也不能升级为 verified。
 */
export function adjudicateStoredProof(p: StoredCheckProof, ctx: Omit<EvidenceIdentityContextForAdjudication, 'kind'>): CheckAdjudication {
  if (p.status === 'not_available') {
    return { name: p.name, status: 'not_checked', reason: (p.evidence?.reason as CheckUnknownReason | undefined) ?? 'no_script', detail: p.unavailableReason ?? '未检查。' };
  }
  if (p.status === 'failed') {
    // 记录下来的真实失败事实：即使证据字段矛盾，也不得改写成通过
    return { name: p.name, status: 'failed', detail: p.name === 'build' ? '构建没有通过（历史记录）' : '自动测试没有通过（历史记录）' };
  }
  if (!p.evidence) {
    // 旧记录没有宿主证据：即使卡片写着 passed 也只是历史结论，不得变成可信 PASS
    return { name: p.name, status: 'unverified', reason: 'legacy_unverified', detail: '历史记录未核实：旧记录没有结构化宿主证据，不能算通过。' };
  }
  const adj = adjudicateEvidence(p.evidence, p.name, { ...ctx, kind: p.name });
  if (p.status === 'unverified' && adj.status === 'verified') {
    return { name: p.name, status: 'unverified', reason: 'no_structured_evidence', detail: '记录状态与证据内容矛盾（记录为未核实），不能升级为可信通过。' };
  }
  return adj;
}

/** 从刚运行完的检查结果裁决（runner → 验收卡）。 */
export function adjudicateCheckResult(c: CheckResult, ctx: EvidenceIdentityContextForAdjudication): CheckAdjudication {
  if (c.status === 'not_available') {
    return { name: c.name, status: 'not_checked', reason: c.unknownReason, detail: c.reason };
  }
  if (c.status === 'failed') {
    return { name: c.name, status: 'failed', detail: c.name === 'build' ? '构建没有通过' : '自动测试没有通过' };
  }
  if (c.evidence) return adjudicateEvidence(c.evidence, c.name, { ...ctx, kind: c.name });
  // 没有宿主证据的“成功”不得算通过：生产路径不得只凭 status 字符串
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
  const needsScopeConfirm = items.some((i) => i.name === 'test' && (i.reason === 'test_scope_weakened' || i.reason === 'test_scope_changed')) || (!!t.scopeReview && !t.scopeReview.confirmedAt);
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

export type SavedChecksStatus = 'verified' | 'failed' | 'unverified' | 'not_checked' | 'historical_unverified';

export interface SaveRecordContext {
  taskId: string;
  round: number;
  /** 当前项目根哈希（可选；提供时用于核对历史证据确实属于这个项目） */
  projectRootHash?: string | undefined;
}

/**
 * 已保存记录的检查结论（历史展示 / 任务列表 / 验收页共用）。
 *
 * R4-04：不再用 historical 模式绕过身份校验。已保存的试检查证据必须用它自己的绑定来核对：
 * 任务、轮次（savedRound）、验收版本、试合并提交、试合并提交的 tree、项目；
 * 旧记录缺少这些绑定字段时只能显示“历史记录未核实”，绝不虚构检查通过。
 */
export function adjudicateSaveRecord(
  rec: Pick<SaveRecord, 'checked' | 'evidenceIds' | 'trialChecks' | 'acceptanceRev' | 'trialCommit' | 'trialCommitTree' | 'savedRound' | 'projectRootHash'> | undefined,
  ctx: SaveRecordContext,
): { status: SavedChecksStatus; checks: CheckAdjudication[] } {
  if (!rec || rec.checked !== true) return { status: 'not_checked', checks: [] };
  const proofs = rec.trialChecks ?? [];
  if (proofs.length === 0) return { status: 'historical_unverified', checks: [] };
  // 严格绑定：缺少任何一项都无法证明“这份证据就是这次写入的试检查结果”
  if (rec.acceptanceRev === undefined || !rec.trialCommit || !rec.trialCommitTree) {
    return { status: 'historical_unverified', checks: [] };
  }
  const checkCtx = {
    taskId: ctx.taskId,
    round: rec.savedRound ?? ctx.round,
    acceptanceRev: rec.acceptanceRev,
    acceptedTree: rec.trialCommitTree,
    trialCommit: rec.trialCommit,
    // 优先用“当前项目”的哈希核对（项目被移动/换目录时历史证据不再可信）；没有当前绑定时退回记录值。
    ...(ctx.projectRootHash ? { projectRootHash: ctx.projectRootHash } : rec.projectRootHash ? { projectRootHash: rec.projectRootHash } : {}),
  };
  const checks = proofs.map((p) => adjudicateStoredProof(p, checkCtx));
  if (checks.some((c) => c.status === 'failed')) return { status: 'failed', checks };
  if (checks.every((c) => c.status === 'verified')) return { status: 'verified', checks };
  return { status: 'unverified', checks };
}

/**
 * 保存记录的检查结论文案（统一裁决）。任何“检查通过”都必须来自统一的证据裁决，
 * 生产展示路径不得只凭 `checked` 或 `status` 字符串；失败/不可信必须有独立文案。
 */
export function saveChecksTextFor(
  t: Pick<Task, 'id' | 'currentRound' | 'acceptedTree' | 'saveRecord' | 'binding'>,
): '检查通过' | '未检查' | '检查通过（历史记录未核实）' | '检查未通过（历史记录）' | '证据不可信（历史记录）' {
  const r = adjudicateSaveRecord(t.saveRecord, {
    taskId: t.id,
    round: t.currentRound ?? 1,
    ...(t.binding?.repoPath ? { projectRootHash: pathIdentityHash(t.binding.repoPath) } : {}),
  });
  switch (r.status) {
    case 'not_checked': return '未检查';
    case 'verified': return '检查通过';
    case 'failed': return '检查未通过（历史记录）';
    case 'unverified': return '证据不可信（历史记录）';
    default: return '检查通过（历史记录未核实）';
  }
}
