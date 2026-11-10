import type { Thinker } from '../thinking/types.js';
import { CodexThinker } from '../thinking/codex.js';
import {
  BUDGET_NOTE,
  ConsentStore,
  createBoundThread,
  inspectDiscussion,
  readApprovedThreadPlan,
  readDiscussionChats,
  runPausedFlow,
  sendThreadChat,
  stopThreadRecord,
  summarizePlanMarkdown,
  updateThreadPreset,
  type ApprovedThreadPlanPayload,
  type ChatStepName,
  type ChatTarget,
  type Decision,
  type DiscussionBudgetView,
  type DiscussionChatMessage,
  type DiscussionChatsView,
  type DiscussionSnapshot,
  type DiscussionStepStatus,
  type FlowOutcome,
  type PauseKind,
  type PendingAdjudicationItem,
  type ResumeDecisions,
  type ReviewRecordSnapshot,
  type StepName,
} from '../thinking/flow/index.js';
import type { Task } from '../task/model.js';

export type DiscussionPreset = 'codex-single' | 'dev-personal';

export interface ResolvedThinkerSet {
  preset: DiscussionPreset;
  planner: Thinker;
  reviewer?: Thinker;
  single: boolean;
}

export interface DiscussionServiceOptions {
  repo: string;
  consent?: ConsentStore;
  devPersonalEnabled?: boolean;
  makeThinkers?: (preset: DiscussionPreset) => ResolvedThinkerSet;
}

export interface DiscussionView {
  taskId: string;
  threadId: string;
  state: DiscussionSnapshot['state'];
  pauseAt: PauseKind;
  pauseMessage: string | null;
  running: boolean;
  activeStep: StepName | ChatStepName | null;
  activeStepText: string | null;
  error: string | null;
  preset: DiscussionPreset;
  canUseDevPersonal: boolean;
  canSwitchPreset: boolean;
  presetLabel: string;
  plannerLabel: string;
  reviewerLabel: string | null;
  independentReview: boolean;
  unreviewed: boolean;
  unreviewedBadge: string | null;
  rawRequirement: string;
  requirementsVersion: number | null;
  requirementsFrozen: boolean;
  requirements: { id: string; text: string }[];
  planVersion: number | null;
  planSummary: string;
  planFullText: string;
  planPath: string | null;
  pendingConsentService: string | null;
  lastFailure: DiscussionSnapshot['lastFailure'];
  pendingAdjudications: PendingAdjudicationItem[];
  adjudications: DiscussionSnapshot['adjudications'];
  canApprove: boolean;
  blockedBecause: string[];
  safetyIssues: string[];
  reviewRecord: ReviewRecordSnapshot | null;
  budget: DiscussionBudgetView;
  steps: DiscussionStepStatus[];
  chats: DiscussionChatsView;
  stoppedReason: string | null;
  budgetNote: string;
}

export interface ConvertedApprovedPlan {
  goal: string;
  criteria: string[];
  planPath: string;
  single: boolean;
  rejectedRisks: { title: string; reason: string; at: string }[];
}

const STEP_TEXT: Record<StepName | ChatStepName, string> = {
  requirements: '首席正在拆解需求',
  draft: '首席正在起草方案',
  review: '复核正在独立评审',
  revise: '首席正在修订方案',
  chat_planner: '正在与首席对话',
  chat_reviewer: '正在与复核对话',
};

const PRESET_LABEL: Record<DiscussionPreset, string> = {
  'codex-single': 'Codex（单思考者模式 · 未经独立评审）',
  'dev-personal': '开发者预设（Claude 规划 + Codex 复核）',
};

const ACCEPT_SECTION_HEADING = /(?:验收|检查要点|测试要点|完成标准)/;

/**
 * 把已批准的讨论方案确定性地转换成施工计划（不额外调用 AI）：
 * - 目标 = 方案正文第一段可读摘要
 * - 验收标准 = 冻结的需求条目 + 方案正文“验收/检查/测试”小节中的项目符号条（去重、最多 20 条）
 * - 被驳回的意见 → Task.acceptedRisks
 */
export function convertApprovedPlanToTaskPlan(payload: ApprovedThreadPlanPayload): ConvertedApprovedPlan {
  const goal = summarizePlanMarkdown(payload.planMarkdown, payload.rawRequirement);
  const criteria: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = raw.trim().slice(0, 300);
    if (!clean) return;
    const key = clean.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (criteria.length < 20) criteria.push(clean);
  };

  for (const item of payload.frozenItems) push(item.text);

  let inAcceptSection = false;
  for (const rawLine of payload.planMarkdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    const h = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      inAcceptSection = ACCEPT_SECTION_HEADING.test(h[1]!);
      continue;
    }
    if (!inAcceptSection) continue;
    const bullet = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) push(bullet[1]!);
  }

  return {
    goal,
    criteria,
    planPath: payload.planPath,
    single: payload.single,
    rejectedRisks: payload.rejectedRisks,
  };
}

export class DiscussionService {
  private readonly consent: ConsentStore;
  private readonly activeStep = new Map<string, StepName | ChatStepName>();
  private readonly inflight = new Map<string, Promise<FlowOutcome | void>>();
  private readonly consentPending = new Map<string, string>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly opts: DiscussionServiceOptions) {
    this.consent = opts.consent ?? new ConsentStore(opts.repo);
  }

  isRunning(taskId: string): boolean {
    return this.inflight.has(taskId);
  }

  activeText(taskId: string): string | null {
    const st = this.activeStep.get(taskId);
    return st ? STEP_TEXT[st] : null;
  }

  lastError(taskId: string): string | null {
    return this.errors.get(taskId) ?? null;
  }

  private resolveSet(preset: DiscussionPreset): ResolvedThinkerSet {
    if (preset === 'dev-personal' && !this.opts.devPersonalEnabled) {
      throw new Error('未启用开发者预设（STUDIO_DEV_PERSONAL_CLAUDE=1），当前仅可使用 Codex 单思考者模式。');
    }
    if (this.opts.makeThinkers) return this.opts.makeThinkers(preset);
    if (preset === 'dev-personal') {
      throw new Error('当前环境未注册 dev-personal 思考者预设。');
    }
    return { preset: 'codex-single', planner: new CodexThinker(), single: true };
  }

  async ensureBoundThread(task: Task, preset: DiscussionPreset = 'codex-single'): Promise<string> {
    if (task.threadId) return task.threadId;
    const set = this.resolveSet(preset);
    const rec = await createBoundThread(this.opts.repo, task.request, {
      planner: set.planner,
      ...(set.reviewer ? { reviewer: set.reviewer } : {}),
      single: set.single,
    });
    return rec.id;
  }

  async getView(task: Task): Promise<DiscussionView> {
    const threadId = task.threadId ?? (await this.ensureBoundThread(task));
    const snap = await inspectDiscussion(this.opts.repo, threadId, {
      activeStep: (() => {
        const s = this.activeStep.get(task.id);
        return s && s !== 'chat_planner' && s !== 'chat_reviewer' ? s : null;
      })(),
      pendingConsentService: this.consentPending.get(task.id) ?? null,
      consentStore: this.consent,
    });
    if (snap.pauseAt !== 'send_consent') this.consentPending.delete(task.id);

    const preset: DiscussionPreset = snap.single ? 'codex-single' : 'dev-personal';
    const set = this.resolveSet(preset);
    const active = this.activeStep.get(task.id) ?? null;
    const err = this.errors.get(task.id) ?? null;
    const chats = await readDiscussionChats(this.opts.repo, threadId);

    return {
      taskId: task.id,
      threadId: snap.threadId,
      state: snap.state,
      pauseAt: snap.pauseAt,
      pauseMessage: snap.pauseMessage,
      running: this.inflight.has(task.id),
      activeStep: active,
      activeStepText: active ? STEP_TEXT[active] : null,
      error: err,
      preset,
      canUseDevPersonal: !!this.opts.devPersonalEnabled,
      canSwitchPreset: snap.state === 'requirements_draft' && snap.budget.callsUsed === 0 && !this.inflight.has(task.id),
      presetLabel: PRESET_LABEL[preset],
      plannerLabel: set.planner.displayName,
      reviewerLabel: set.reviewer?.displayName ?? null,
      independentReview: snap.independentReview,
      unreviewed: snap.unreviewed,
      unreviewedBadge: snap.unreviewed ? '未经独立评审' : null,
      rawRequirement: snap.rawRequirement,
      requirementsVersion: snap.requirementsVersion,
      requirementsFrozen: snap.requirementsFrozen,
      requirements: snap.requirements,
      planVersion: snap.planVersion,
      planSummary: snap.planSummary,
      planFullText: snap.planFullText,
      planPath: snap.planPath,
      pendingConsentService: snap.pendingConsentService,
      lastFailure: snap.lastFailure,
      pendingAdjudications: snap.pendingAdjudications,
      adjudications: snap.adjudications,
      canApprove: snap.canApprove,
      blockedBecause: snap.blockedBecause,
      safetyIssues: snap.safetyIssues,
      reviewRecord: snap.reviewRecord,
      budget: snap.budget,
      steps: snap.steps,
      chats,
      stoppedReason: snap.stoppedReason,
      budgetNote: BUDGET_NOTE,
    };
  }

  async sendChat(task: Task, target: ChatTarget, message: string): Promise<DiscussionView> {
    if (this.inflight.has(task.id)) throw new Error('这个任务的讨论或对话正在进行中，请稍候。');
    const threadId = task.threadId ?? (await this.ensureBoundThread(task));
    const snap = await inspectDiscussion(this.opts.repo, threadId, { consentStore: this.consent });
    const preset: DiscussionPreset = snap.single ? 'codex-single' : 'dev-personal';
    const set = this.resolveSet(preset);
    const thinker = target === 'planner' ? set.planner : set.reviewer;
    if (!thinker) throw new Error('单思考者模式下没有复核思考者，无法发起复核对话。');

    const step: ChatStepName = target === 'planner' ? 'chat_planner' : 'chat_reviewer';
    this.errors.delete(task.id);
    this.activeStep.set(task.id, step);
    const p = (async () => {
      try {
        await sendThreadChat({
          projectRoot: this.opts.repo,
          threadId,
          target,
          thinker,
          message,
          consent: this.consent,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.errors.set(task.id, msg);
        throw e;
      } finally {
        this.activeStep.delete(task.id);
        this.inflight.delete(task.id);
      }
    })();
    this.inflight.set(task.id, p);
    await p;
    return this.getView(task);
  }

  async waitIdle(taskId: string): Promise<void> {
    const p = this.inflight.get(taskId);
    if (p) await p;
  }

  private async runTurn(task: Task, threadId: string, preset: DiscussionPreset, decisions: ResumeDecisions): Promise<FlowOutcome> {
    if (this.inflight.has(task.id)) throw new Error('这个任务的讨论正在进行中，请稍候。');
    const set = this.resolveSet(preset);
    this.errors.delete(task.id);
    this.consentPending.delete(task.id);

    const p = (async (): Promise<FlowOutcome> => {
      try {
        const { outcome } = await runPausedFlow(
          {
            projectRoot: this.opts.repo,
            threadId,
            planner: set.planner,
            ...(set.reviewer ? { reviewer: set.reviewer } : {}),
            single: set.single,
            consent: this.consent,
          },
          decisions,
          {
            onStep: (step) => this.activeStep.set(task.id, step),
            onConsentNeeded: (svc) => this.consentPending.set(task.id, svc),
          },
        );
        return outcome;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.errors.set(task.id, msg);
        throw e;
      } finally {
        this.activeStep.delete(task.id);
        this.inflight.delete(task.id);
      }
    })();

    this.inflight.set(task.id, p);
    return p;
  }

  launchTurn(task: Task, threadId: string, preset: DiscussionPreset, decisions: ResumeDecisions = {}): void {
    void this.runTurn(task, threadId, preset, decisions).catch(() => undefined);
  }

  async runTurnSync(task: Task, threadId: string, preset: DiscussionPreset, decisions: ResumeDecisions): Promise<FlowOutcome> {
    return this.runTurn(task, threadId, preset, decisions);
  }

  async setPresetBeforeStart(task: Task, preset: DiscussionPreset): Promise<void> {
    if (!task.threadId) return;
    if (this.inflight.has(task.id)) throw new Error('正在执行中，不能切换思考者预设。');
    const set = this.resolveSet(preset);
    await updateThreadPreset(this.opts.repo, task.threadId, {
      single: set.single,
      plannerId: set.planner.id,
      ...(set.reviewer ? { reviewerId: set.reviewer.id } : {}),
    });
  }

  async stopThread(taskId: string, threadId: string, reason: string): Promise<void> {
    await this.waitIdle(taskId);
    await stopThreadRecord(this.opts.repo, threadId, reason);
  }

  async readApprovedPayload(threadId: string): Promise<ApprovedThreadPlanPayload> {
    return readApprovedThreadPlan(this.opts.repo, threadId);
  }
}
