import type { Thinker } from '../types.js';
import type { BasisStatus, ChecksResult, Decision, Finding, RequirementItem, ScopeDiff, Severity, StepName, ThreadRecord } from './types.js';
import type { AttemptFailureChoice, FlowOptions, FlowOutcome, FlowUI } from './engine.js';
import { FlowEngine } from './engine.js';
import { ThreadStore } from './store.js';
import { ConsentStore } from './support.js';

export interface ResumeDecisions {
  sendConsent?: { service: string; allow: boolean };
  requirements?: { id?: string; text: string }[];
  attemptFailure?: AttemptFailureChoice;
  adjudication?: { kind: 'finding' | 'scope'; key: string; decision: Decision; reason: string };
  approval?: 'approve' | 'reject' | 'stop';
}

export type PauseKind =
  | 'ready'
  | 'send_consent'
  | 'requirements_confirmation'
  | 'attempt_failed'
  | 'adjudication'
  | 'approval'
  | 'approved'
  | 'stopped'
  | 'rejected';

export interface PendingAdjudicationItem {
  kind: 'finding' | 'scope';
  key: string;
  summary: string;
  sourceLabel: string;
  severityLabel: string;
  basisText: string;
  basisStatus: BasisStatus;
  basisDetail: string;
  impactText: string;
  suggestionText: string;
  chiefResolution: string;
  chiefReason: string;
  acceptConsequence: string;
  rejectConsequence: string;
}

export interface ReviewFindingRecord {
  index: number;
  problem: string;
  severity: Severity;
  basis: string;
  impact: string;
  suggestion: string;
  basisStatus: BasisStatus;
  basisDetail: string;
  chiefResolution: string;
  chiefReason: string;
}

export interface ReviewRecordSnapshot {
  createdAt: string;
  requirementChecks: { id: string; text: string; covered: boolean; note: string }[];
  findings: ReviewFindingRecord[];
  neededMaterials: string[];
  additions: string[];
  itemMarks: { id: string; mark: string; note?: string }[];
}

export interface DiscussionStepStatus {
  key: string;
  label: string;
  status: 'done' | 'current' | 'failed' | 'pending';
}

export interface DiscussionBudgetView {
  callsUsed: number;
  callsMax: number;
  durationSec: number;
  maxDurationSec: number;
  /** 仅当实际返回了费用数据的思考者参与时才提供；只用次数/token 计量的实现绝不虚构金额 */
  knownCostUsd: number | null;
  maxCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  hasTokenUsage: boolean;
}

export interface DiscussionSnapshot {
  threadId: string;
  state: ThreadRecord['state'];
  started: boolean;
  pauseAt: PauseKind;
  pauseMessage: string | null;
  single: boolean;
  independentReview: boolean;
  unreviewed: boolean;
  sameAiSingle: boolean;
  plannerId: string;
  reviewerId?: string;
  plannerLabel?: string;
  reviewerLabel?: string;
  presetHint?: string;
  modelHint?: string;
  roleSourceLabel?: string;
  rawRequirement: string;
  requirementsVersion: number | null;
  requirementsFrozen: boolean;
  requirements: RequirementItem[];
  planVersion: number | null;
  planSummary: string;
  planFullText: string;
  planPath: string | null;
  pendingConsentService: string | null;
  lastFailure: ThreadRecord['lastFailure'] | null;
  pendingAdjudications: PendingAdjudicationItem[];
  adjudications: ThreadRecord['adjudications'];
  canApprove: boolean;
  blockedBecause: string[];
  safetyIssues: string[];
  reviewRecord: ReviewRecordSnapshot | null;
  budget: DiscussionBudgetView;
  steps: DiscussionStepStatus[];
  stoppedReason: string | null;
}

export function isThreadStarted(rec: Pick<ThreadRecord, 'started' | 'attempts' | 'state' | 'log'>): boolean {
  return (
    rec.started === true ||
    rec.attempts.length > 0 ||
    rec.state !== 'requirements_draft' ||
    rec.log.some((l) => l.text.startsWith('停在确认点'))
  );
}

export interface ApprovedThreadPlanPayload {
  threadId: string;
  rawRequirement: string;
  frozenItems: RequirementItem[];
  planMarkdown: string;
  planPath: string;
  planSha256?: string;
  planArtifactVersion?: number;
  single: boolean;
  rejectedRisks: { title: string; reason: string; at: string }[];
}

interface ReqArtifactBody {
  items: RequirementItem[];
  rawRequirement: string;
}

interface PlanArtifactBody {
  plan: string;
  item_marks?: { id: string; mark: string; note?: string }[];
  additions?: string[];
  resolutions?: { index: number; result: string; reason: string }[];
}

interface ReviewArtifactBody {
  requirement_checks: { id: string; covered: boolean; note: string }[];
  findings: Finding[];
  missing_evidence: string[];
}

export interface FlowCallbacks {
  onStep?: (step: StepName, role: 'planner' | 'reviewer') => void;
  onNotify?: (text: string) => void;
  onConsentNeeded?: (service: string) => void;
}

/**
 * 界面版 FlowUI：绝不“默认通过”。
 * 每个需要用户决定的点只消费本次显式传入的决定（一次性的）；未传入则返回 undefined，让 FlowEngine 落盘暂停。
 */
export function createPausedFlowUI(decisions: ResumeDecisions = {}, cb: FlowCallbacks = {}): FlowUI {
  let consentUsed = false;
  let reqsUsed = false;
  let failureUsed = false;
  let adjudicationUsed = false;
  let approvalUsed = false;

  return {
    ...(cb.onNotify ? { notify: cb.onNotify } : {}),
    ...(cb.onStep ? { onStep: cb.onStep } : {}),

    async confirmSend(service: string) {
      if (!consentUsed && decisions.sendConsent && decisions.sendConsent.service === service) {
        consentUsed = true;
        return decisions.sendConsent.allow;
      }
      cb.onConsentNeeded?.(service);
      return undefined;
    },

    async confirmRequirements() {
      if (!reqsUsed && decisions.requirements) {
        reqsUsed = true;
        return decisions.requirements;
      }
      return undefined;
    },

    async onAttemptFailed() {
      if (!failureUsed && decisions.attemptFailure !== undefined) {
        failureUsed = true;
        return decisions.attemptFailure;
      }
      return undefined;
    },

    async adjudicate(q) {
      if (
        !adjudicationUsed &&
        decisions.adjudication &&
        decisions.adjudication.kind === q.kind &&
        decisions.adjudication.key === q.key
      ) {
        adjudicationUsed = true;
        return { decision: decisions.adjudication.decision, reason: decisions.adjudication.reason };
      }
      return undefined;
    },

    async approve() {
      if (!approvalUsed && decisions.approval) {
        approvalUsed = true;
        return decisions.approval;
      }
      return undefined;
    },
  };
}

export function runPausedFlow(
  opts: Omit<FlowOptions, 'ui'> & { threadId?: string; rawRequirement?: string },
  decisions: ResumeDecisions = {},
  cb: FlowCallbacks = {},
): Promise<{ outcome: FlowOutcome; thread: ThreadRecord }> {
  return (async () => {
    const ui = createPausedFlowUI(decisions, cb);
    const engine = new FlowEngine({ ...opts, ui });
    if (opts.threadId) {
      await engine.load(opts.threadId);
    } else {
      await engine.create(opts.rawRequirement ?? '');
    }
    const outcome = await engine.run();
    return { outcome, thread: engine.thread };
  })();
}

/** 从方案正文提取一句话目标摘要（不超过 220 字）。 */
export function summarizePlanMarkdown(markdown: string, fallback: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const content: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('```')) continue;
    if (/^#\s+/.test(line) && content.length === 0) continue; // 跳过顶层大标题
    if (/^#{2,6}\s+/.test(line)) {
      if (content.length > 0) break;
      continue;
    }
    const clean = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
    if (clean) content.push(clean);
    if (content.join(' ').length >= 160) break;
  }
  const summary = content.join(' ').trim();
  return summary ? summary.slice(0, 220) : fallback;
}

function formatBudget(rec: ThreadRecord): DiscussionBudgetView {
  const callsUsed = rec.attempts.length;
  const durationMs = rec.attempts.reduce((s, a) => s + a.durationMs, 0);
  const costAttempts = rec.attempts.filter((a) => typeof a.usage?.costUsd === 'number');
  const knownCostUsd = costAttempts.length > 0 ? costAttempts.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0) : null;
  const tokenAttempts = rec.attempts.filter(
    (a) => typeof a.usage?.inputTokens === 'number' || typeof a.usage?.outputTokens === 'number',
  );
  const inputTokens = tokenAttempts.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0);
  const outputTokens = tokenAttempts.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0);
  return {
    callsUsed,
    callsMax: rec.budget.maxCalls,
    durationSec: Math.round(durationMs / 1000),
    maxDurationSec: Math.round(rec.budget.maxTotalCallMs / 1000),
    knownCostUsd,
    maxCostUsd: rec.budget.maxCostUsd ?? null,
    inputTokens,
    outputTokens,
    hasTokenUsage: tokenAttempts.length > 0,
  };
}

function buildStepStatuses(rec: ThreadRecord, activeStep: StepName | null, pendingAdjCount: number): DiscussionStepStatus[] {
  const has = (name: string) => rec.artifacts.some((a) => a.name === name);
  const failedStep = rec.lastFailure?.step;
  const statusOf = (stepKey: StepName, doneWhen: boolean): DiscussionStepStatus['status'] => {
    if (doneWhen) return 'done';
    if (activeStep === stepKey) return 'current';
    if (failedStep === stepKey) return 'failed';
    return 'pending';
  };
  if (rec.single) {
    return [
      { key: 'requirements', label: '拆解需求', status: statusOf('requirements', has('requirements_confirmed')) },
      { key: 'draft', label: '首席起草', status: statusOf('draft', has('draft')) },
      { key: 'checks', label: '机械检查', status: has('checks') ? 'done' : 'pending' },
      { key: 'approval', label: '批准方案', status: rec.state === 'approved' || rec.state === 'task_exported' ? 'done' : rec.state === 'awaiting_approval' ? 'current' : 'pending' },
    ];
  }
  const doneOrApproved = rec.state === 'approved' || rec.state === 'task_exported';
  const readyForApproval = rec.state === 'awaiting_approval' && pendingAdjCount === 0;
  return [
    { key: 'requirements', label: '拆解需求', status: statusOf('requirements', has('requirements_confirmed')) },
    { key: 'draft', label: '首席起草', status: statusOf('draft', has('draft')) },
    { key: 'review', label: '复核独立评审', status: statusOf('review', has('review')) },
    { key: 'revise', label: '首席修订', status: statusOf('revise', has('revise')) },
    { key: 'adjudication', label: '你裁决分歧', status: doneOrApproved || readyForApproval ? 'done' : rec.state === 'awaiting_approval' ? 'current' : 'pending' },
    { key: 'approval', label: '批准方案', status: doneOrApproved ? 'done' : readyForApproval ? 'current' : 'pending' },
  ];
}

function consentServiceFromLog(rec: ThreadRecord): string | null {
  const lastLog = rec.log.at(-1)?.text ?? '';
  const m = lastLog.match(/停在确认点（send_consent）：首次向“([^”]+)”发送资料/);
  return m?.[1] ?? null;
}

/**
 * 从线程记录与正式产物推导完整的讨论视图快照（只读，不改动任何文件或调用 AI）。
 */
export async function inspectDiscussion(
  projectRoot: string,
  threadId: string,
  opts: { activeStep?: StepName | null; pendingConsentService?: string | null; consentStore?: ConsentStore } = {},
): Promise<DiscussionSnapshot> {
  const store = new ThreadStore(projectRoot);
  const consent = opts.consentStore ?? new ConsentStore(projectRoot);
  const rec = await store.load(threadId);
  await store.verifyAll(rec);

  const reqFrozenArt = store.latest(rec, 'requirements_confirmed');
  const reqDraftArt = store.latest(rec, 'requirements');
  const reqArt = reqFrozenArt ?? reqDraftArt;
  const reqBody = reqArt ? await store.readArtifact<ReqArtifactBody>(rec, reqArt) : null;

  const reviseArt = store.latest(rec, 'revise');
  const draftArt = store.latest(rec, 'draft');
  const planArt = reviseArt ?? draftArt;
  const planBody = planArt ? await store.readArtifact<PlanArtifactBody>(rec, planArt) : null;

  const reviewArt = store.latest(rec, 'review');
  const reviewBody = reviewArt ? await store.readArtifact<ReviewArtifactBody>(rec, reviewArt) : null;

  const checksArt = store.latest(rec, 'checks');
  const checksBody = checksArt ? await store.readArtifact<ChecksResult>(rec, checksArt) : null;

  const consentService = opts.pendingConsentService ?? consentServiceFromLog(rec);
  const consentStillPending = consentService ? !(await consent.has(consentService)) : false;

  const pendingAdjudications: PendingAdjudicationItem[] = [];
  if (checksBody && rec.state === 'awaiting_approval') {
    for (const idx of checksBody.blockingFindings) {
      const f = reviewBody?.findings[idx - 1];
      if (!f) continue;
      if (rec.adjudications.some((a) => a.kind === 'finding' && a.key === String(idx))) continue;
      const fc = checksBody.findingChecks.find((c) => c.index === idx);
      const res = planBody?.resolutions?.find((x) => x.index === idx);
      pendingAdjudications.push({
        kind: 'finding',
        key: String(idx),
        summary: `阻断意见 #${idx}：${f.problem}`,
        sourceLabel: '独立评审',
        severityLabel: f.severity,
        basisText: f.basis || '（空）',
        basisStatus: fc?.basisStatus ?? '未经证实',
        basisDetail: fc?.detail ?? '依据为空或无有效引用',
        impactText: f.impact,
        suggestionText: f.suggestion,
        chiefResolution: res?.result ?? '未解决',
        chiefReason: res?.reason ?? '（未说明）',
        acceptConsequence: '认可这条阻塞意见及首席当前处理结论并写入裁决记录；如需让首席按此大幅重写，请使用「修改需求」。',
        rejectConsequence: '写一句理由驳回该意见；裁决完成后方案可进入批准，这条意见与理由会保留为「你已知晓并接受的风险」并展示在验收页。',
      });
    }
    for (const d of checksBody.scopeDiffs) {
      if (rec.adjudications.some((a) => a.kind === 'scope' && a.key === d.key)) continue;
      pendingAdjudications.push({
        kind: 'scope',
        key: d.key,
        summary: `范围差异：${d.description}`,
        sourceLabel: '机械检查 · 范围比对',
        severityLabel: '范围变化',
        basisText: '宿主对照冻结的需求条目机械比对',
        basisStatus: '提供了依据（文件存在）',
        basisDetail: '宿主仅列出范围差异，不做是否“实质”的语义判断',
        impactText: '修订稿相对已冻结需求条目存在遗漏、删除或新增内容',
        suggestionText: '请确认这项范围变化是否允许纳入当前方案',
        chiefResolution: '需用户裁决',
        chiefReason: '由机械范围比对触发',
        acceptConsequence: '允许这项范围变化保留在当前方案中，不阻塞后续批准。',
        rejectConsequence: '写一句理由驳回这项范围变化；驳回范围差异后本方案将不能批准，需要修改需求重拟或终止讨论。',
      });
    }
  }

  const blockedBecause: string[] = [];
  if (checksBody) {
    blockedBecause.push(...checksBody.safetyIssues.map((s) => `安全检查未通过：${s}`));
    for (const d of checksBody.scopeDiffs) {
      const rej = rec.adjudications.find((a) => a.kind === 'scope' && a.key === d.key && a.decision === 'reject');
      if (rej) blockedBecause.push(`范围差异被你驳回：${d.description}`);
    }
  }

  const reviewRecord: ReviewRecordSnapshot | null = reviewArt && reviewBody
    ? {
        createdAt: reviewArt.createdAt,
        requirementChecks: reviewBody.requirement_checks.map((rc) => ({
          id: rc.id,
          text: reqBody?.items.find((it) => it.id === rc.id)?.text ?? '',
          covered: rc.covered,
          note: rc.note,
        })),
        findings: reviewBody.findings.map((f, i) => {
          const fc = checksBody?.findingChecks.find((c) => c.index === i + 1);
          const res = planBody?.resolutions?.find((x) => x.index === i + 1);
          return {
            index: i + 1,
            problem: f.problem,
            severity: f.severity,
            basis: f.basis || '（空）',
            impact: f.impact,
            suggestion: f.suggestion,
            basisStatus: fc?.basisStatus ?? '未经证实',
            basisDetail: fc?.detail ?? '未经核验',
            chiefResolution: res?.result ?? '待修订',
            chiefReason: res?.reason ?? '',
          };
        }),
        neededMaterials: reviewBody.missing_evidence,
        additions: planBody?.additions ?? [],
        itemMarks: planBody?.item_marks ?? [],
      }
    : null;

  let pauseAt: PauseKind = 'ready';
  let pauseMessage: string | null = null;
  if (rec.state === 'approved' || rec.state === 'task_exported') {
    pauseAt = 'approved';
  } else if (rec.state === 'stopped') {
    pauseAt = 'stopped';
    pauseMessage = rec.stoppedReason ?? '讨论已终止。';
  } else if (rec.state === 'rejected') {
    pauseAt = 'rejected';
    pauseMessage = '方案已被否决。';
  } else if (rec.lastFailure) {
    pauseAt = 'attempt_failed';
    pauseMessage = rec.lastFailure.error ?? `步骤 ${rec.lastFailure.step} 尝试未完成（${rec.lastFailure.status}）。`;
  } else if (consentStillPending && consentService) {
    pauseAt = 'send_consent';
    pauseMessage = `首次向“${consentService}”发送资料需要你确认（资料将离开本机）。`;
  } else if (rec.state === 'requirements_draft' && reqDraftArt && !reqFrozenArt) {
    pauseAt = 'requirements_confirmation';
    pauseMessage = 'AI 已拆解出需求条目；确认并冻结后，首席将按冻结条目起草方案。';
  } else if (rec.state === 'awaiting_approval') {
    if (pendingAdjudications.length > 0) {
      pauseAt = 'adjudication';
      pauseMessage = `有 ${pendingAdjudications.length} 项意见或范围差异需要你逐条裁决后才能批准。`;
    } else {
      pauseAt = 'approval';
      pauseMessage = blockedBecause.length ? blockedBecause.join('；') : '方案已就绪，可以批准并生成施工计划。';
    }
  } else if (rec.attempts.length === 0 && rec.state === 'requirements_draft') {
    pauseAt = 'ready';
  }

  return {
    threadId: rec.id,
    state: rec.state,
    started: isThreadStarted(rec),
    pauseAt,
    pauseMessage,
    single: rec.single,
    independentReview: !rec.single,
    unreviewed: rec.single,
    sameAiSingle: !!rec.sameAiSingle,
    plannerId: rec.plannerId,
    ...(rec.reviewerId ? { reviewerId: rec.reviewerId } : {}),
    ...(rec.plannerLabel ? { plannerLabel: rec.plannerLabel } : {}),
    ...(rec.reviewerLabel ? { reviewerLabel: rec.reviewerLabel } : {}),
    ...(rec.presetHint ? { presetHint: rec.presetHint } : {}),
    ...(rec.modelHint ? { modelHint: rec.modelHint } : {}),
    ...(rec.roleSourceLabel ? { roleSourceLabel: rec.roleSourceLabel } : {}),
    rawRequirement: rec.rawRequirement,
    requirementsVersion: reqArt?.version ?? null,
    requirementsFrozen: !!reqFrozenArt,
    requirements: reqBody?.items ?? [],
    planVersion: planArt?.version ?? null,
    planSummary: planBody ? summarizePlanMarkdown(planBody.plan, rec.rawRequirement) : '',
    planFullText: planBody?.plan ?? '',
    planPath: rec.plan?.path ?? null,
    pendingConsentService: consentStillPending ? consentService : null,
    lastFailure: rec.lastFailure ?? null,
    pendingAdjudications,
    adjudications: rec.adjudications,
    canApprove: rec.state === 'awaiting_approval' && pendingAdjudications.length === 0 && blockedBecause.length === 0,
    blockedBecause,
    safetyIssues: checksBody?.safetyIssues ?? [],
    reviewRecord,
    budget: formatBudget(rec),
    steps: buildStepStatuses(rec, opts.activeStep ?? null, pendingAdjudications.length),
    stoppedReason: rec.stoppedReason ?? null,
  };
}

/** 从已批准的线程提取生成施工计划及「接受的风险」所需全部确定性字段。 */
export async function readApprovedThreadPlan(projectRoot: string, threadId: string): Promise<ApprovedThreadPlanPayload> {
  const store = new ThreadStore(projectRoot);
  const rec = await store.load(threadId);
  if (!rec.plan || (rec.state !== 'approved' && rec.state !== 'task_exported')) {
    throw new Error('讨论线程尚未批准方案。');
  }
  const reqArt = store.latest(rec, 'requirements_confirmed');
  const reqBody = reqArt ? await store.readArtifact<ReqArtifactBody>(rec, reqArt) : null;
  const planArt = store.latest(rec, rec.single ? 'draft' : 'revise');
  const planBody = planArt ? await store.readArtifact<PlanArtifactBody>(rec, planArt) : null;
  const reviewArt = rec.single ? undefined : store.latest(rec, 'review');
  const reviewBody = reviewArt ? await store.readArtifact<ReviewArtifactBody>(rec, reviewArt) : null;
  const checksArt = store.latest(rec, 'checks');
  const checksBody = checksArt ? await store.readArtifact<ChecksResult>(rec, checksArt) : null;

  const rejectedRisks = rec.adjudications
    .filter((a) => a.decision === 'reject')
    .map((a) => {
      if (a.kind === 'finding') {
        const idx = Number(a.key);
        const f = reviewBody?.findings[idx - 1];
        return { title: f?.problem ?? `阻断意见 #${a.key}`, reason: a.reason, at: a.at };
      }
      const sd = checksBody?.scopeDiffs.find((d) => d.key === a.key);
      return { title: sd?.description ?? `范围差异 ${a.key}`, reason: a.reason, at: a.at };
    });

  return {
    threadId: rec.id,
    rawRequirement: rec.rawRequirement,
    frozenItems: reqBody?.items ?? [],
    planMarkdown: planBody?.plan ?? '',
    planPath: rec.plan.path,
    planSha256: rec.plan.sha256,
    planArtifactVersion: rec.plan.artifactVersion,
    single: rec.single,
    rejectedRisks,
  };
}

export interface ThreadRoleBindingInput {
  single: boolean;
  plannerId: string;
  reviewerId?: string;
  plannerLabel?: string;
  reviewerLabel?: string;
  sameAiSingle?: boolean;
  presetHint?: string;
  modelHint?: string;
  roleSourceLabel?: string;
}

function applyBinding(rec: ThreadRecord, next: ThreadRoleBindingInput): void {
  rec.single = next.single;
  rec.plannerId = next.plannerId;
  if (next.single || !next.reviewerId) delete rec.reviewerId;
  else rec.reviewerId = next.reviewerId;
  if (next.plannerLabel !== undefined) rec.plannerLabel = next.plannerLabel;
  if (next.reviewerLabel !== undefined) rec.reviewerLabel = next.reviewerLabel;
  else if (next.single) delete rec.reviewerLabel;
  if (next.sameAiSingle !== undefined) rec.sameAiSingle = next.sameAiSingle;
  if (next.presetHint !== undefined) rec.presetHint = next.presetHint;
  if (next.modelHint !== undefined) rec.modelHint = next.modelHint;
  if (next.roleSourceLabel !== undefined) rec.roleSourceLabel = next.roleSourceLabel;
}

/** 仅更新思考线程预设或未开始线程的角色（限讨论尚未开始时）。 */
export async function updateThreadPreset(
  projectRoot: string,
  threadId: string,
  next: ThreadRoleBindingInput,
): Promise<ThreadRecord> {
  const store = new ThreadStore(projectRoot);
  const rec = await store.load(threadId);
  if (isThreadStarted(rec)) {
    throw new Error('讨论已经开始，不能直接更换思考角色；如需更换，请修改需求并重新开始讨论。');
  }
  applyBinding(rec, next);
  rec.log.push({
    at: new Date().toISOString(),
    text: `更新讨论角色（${next.single ? '单思考者模式：未经独立评审' : `首席 ${next.plannerId} / 复核 ${next.reviewerId}`}）`,
  });
  await store.save(rec);
  return rec;
}

/** 讨论正式开始时把当前角色配置锁定到线程记录中；后续修改全局或项目设置不再影响该线程。 */
export async function lockThreadRoles(
  projectRoot: string,
  threadId: string,
  next: ThreadRoleBindingInput,
): Promise<ThreadRecord> {
  const store = new ThreadStore(projectRoot);
  const rec = await store.load(threadId);
  if (isThreadStarted(rec)) return rec;
  applyBinding(rec, next);
  rec.started = true;
  rec.log.push({
    at: new Date().toISOString(),
    text: `开始讨论，已锁定角色（${next.single ? (next.sameAiSingle ? `${next.plannerLabel ?? next.plannerId} 兼首席与复核 · 单思考者` : `${next.plannerLabel ?? next.plannerId} · 不复核`) : `首席 ${next.plannerLabel ?? next.plannerId} / 复核 ${next.reviewerLabel ?? next.reviewerId}`}${next.roleSourceLabel ? ` · ${next.roleSourceLabel}` : ''}）`,
  });
  await store.save(rec);
  return rec;
}

/** 终止思考线程并保留全部历史尝试与正式产物（例如用户在冻结后点击「修改需求」或放弃）。 */
export async function stopThreadRecord(projectRoot: string, threadId: string, reason: string): Promise<ThreadRecord> {
  const store = new ThreadStore(projectRoot);
  const rec = await store.load(threadId);
  if (rec.state !== 'stopped' && rec.state !== 'rejected') {
    rec.state = 'stopped';
    rec.stoppedReason = reason;
    rec.log.push({ at: new Date().toISOString(), text: `线程停止：${reason}` });
    await store.save(rec);
  }
  return rec;
}

/** 根据 FlowEngine 配置的思考者（接口类型）创建未调用 AI 的初始讨论线程。 */
export async function createBoundThread(
  projectRoot: string,
  rawRequirement: string,
  opts: { planner: Thinker; reviewer?: Thinker; single: boolean },
): Promise<ThreadRecord> {
  const engine = new FlowEngine({
    projectRoot,
    planner: opts.planner,
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    single: opts.single,
    ui: createPausedFlowUI(),
  });
  return engine.create(rawRequirement);
}
