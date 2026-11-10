import type { Thinker } from '../thinking/types.js';
import { CodexThinker } from '../thinking/codex.js';
import {
  BUDGET_NOTE,
  ConsentStore,
  createBoundThread,
  inspectDiscussion,
  lockThreadRoles,
  readApprovedThreadPlan,
  readDiscussionChats,
  readProjectBriefView,
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
  type ProjectBriefView,
  type ResumeDecisions,
  type ReviewRecordSnapshot,
  type StepName,
} from '../thinking/flow/index.js';
import type { Task } from '../task/model.js';
import { providerDisplayName, type AiProviderId, type AiSettingsStore } from './ai-settings.js';
import type { DiscussionClassifyHint } from './task-state-view.js';

export type DiscussionPreset = 'roles' | 'codex-single' | 'dev-personal';

export interface ResolvedThinkerSet {
  preset: DiscussionPreset;
  planner: Thinker;
  reviewer?: Thinker;
  single: boolean;
  sameAiSingle?: boolean;
  plannerLabel?: string;
  reviewerLabel?: string | null;
  reviewerRoleDisplay?: string;
  roleSourceLabel?: string | null;
  modelHint?: string;
  roleProblem?: string | null;
}

export interface DiscussionServiceOptions {
  repo: string;
  consent?: ConsentStore;
  devPersonalEnabled?: boolean;
  makeThinkers?: (preset: DiscussionPreset) => ResolvedThinkerSet;
  aiSettings?: AiSettingsStore;
  getClaudeAvailability?: () => Promise<boolean>;
  makeThinkerByProvider?: (provider: AiProviderId, model?: string) => Thinker;
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
  reviewerRoleDisplay: string;
  sameAiSingle: boolean;
  roleSourceLabel: string | null;
  roleProblem: string | null;
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
  hasRequiredContext: boolean;
  requiredContextSource: ProjectBriefView['source'];
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
  roles: '按 AI 角色设置讨论',
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

  /** 只读提取讨论摘要供任务列表/工作台分组，线程文件缺失时不阻塞视图构建。 */
  async getClassifyHint(task: Task): Promise<DiscussionClassifyHint | undefined> {
    if (!['draft', 'clarifying'].includes(task.state)) return undefined;
    if (this.inflight.has(task.id)) {
      return {
        pauseAt: 'ready',
        running: true,
        activeStepText: this.activeText(task.id),
        pauseMessage: null,
        pendingAdjudicationsCount: 0,
      };
    }
    if (!task.threadId) return undefined;
    try {
      const snap = await inspectDiscussion(this.opts.repo, task.threadId, {
        pendingConsentService: this.consentPending.get(task.id) ?? null,
        consentStore: this.consent,
      });
      return {
        pauseAt: snap.pauseAt,
        running: false,
        activeStepText: null,
        pauseMessage: snap.pauseMessage,
        pendingAdjudicationsCount: snap.pendingAdjudications.length,
      };
    } catch {
      return undefined;
    }
  }

  private resolveLegacySet(preset: DiscussionPreset): ResolvedThinkerSet {
    if (preset === 'dev-personal' && !this.opts.devPersonalEnabled) {
      throw new Error('未启用开发者预设（STUDIO_DEV_PERSONAL_CLAUDE=1），当前仅可使用按角色配置模式。');
    }
    if (this.opts.makeThinkers) {
      const legacyPreset = preset === 'roles' ? 'codex-single' : preset;
      return this.opts.makeThinkers(legacyPreset);
    }
    if (preset === 'dev-personal') {
      throw new Error('当前环境未注册 dev-personal 思考者预设。');
    }
    return { preset: 'codex-single', planner: new CodexThinker(), single: true };
  }

  private thinkerForId(thinkerId: string, modelHint?: string): Thinker {
    if (thinkerId === 'claude-api' && this.opts.makeThinkerByProvider) {
      return this.opts.makeThinkerByProvider('claude', modelHint);
    }
    if (thinkerId === 'codex' && this.opts.makeThinkerByProvider) {
      return this.opts.makeThinkerByProvider('codex');
    }
    if (this.opts.makeThinkers) {
      const dev = this.opts.devPersonalEnabled ? this.resolveLegacySet('dev-personal') : null;
      if (dev?.planner.id === thinkerId) return dev.planner;
      if (dev?.reviewer?.id === thinkerId) return dev.reviewer;
      const single = this.resolveLegacySet('codex-single');
      return single.planner;
    }
    return new CodexThinker();
  }

  private async resolveUnstartedPlan(explicitPreset?: DiscussionPreset): Promise<ResolvedThinkerSet> {
    if (explicitPreset === 'dev-personal') {
      const set = this.resolveLegacySet('dev-personal');
      return {
        ...set,
        plannerLabel: set.planner.displayName,
        reviewerLabel: set.reviewer?.displayName ?? null,
        reviewerRoleDisplay: set.reviewer?.displayName ?? '不复核',
        sameAiSingle: false,
        roleSourceLabel: '开发者预设',
        roleProblem: null,
      };
    }

    if (this.opts.aiSettings) {
      const claudeAvail = this.opts.getClaudeAvailability ? await this.opts.getClaudeAvailability() : undefined;
      const eff = await this.opts.aiSettings.resolveEffectiveRoles(
        this.opts.repo,
        claudeAvail === undefined ? undefined : { claudeAvailable: claudeAvail },
      );

      if (eff.chief === 'unset' || eff.reviewer === 'unset') {
        const placeholder = this.opts.makeThinkerByProvider
          ? this.opts.makeThinkerByProvider('codex')
          : this.resolveLegacySet('codex-single').planner;
        const pLabel = eff.chief === 'unset' ? '未设置' : providerDisplayName(eff.chief);
        const rDisplay =
          eff.reviewer === 'unset'
            ? '未设置'
            : eff.reviewer === 'none'
              ? '不复核'
              : providerDisplayName(eff.reviewer);
        return {
          preset: 'roles',
          planner: placeholder,
          // 占位未开始线程用 single: true 创建，待用户补全配置后再按实际角色启动，避免无 reviewer 时建线程失败
          single: true,
          sameAiSingle: eff.sameAi,
          plannerLabel: pLabel,
          reviewerLabel: null,
          reviewerRoleDisplay: rDisplay,
          roleSourceLabel: eff.sourceLabel,
          modelHint: eff.claudeModel,
          roleProblem: eff.problem,
        };
      }

      const planner = this.opts.makeThinkerByProvider
        ? this.opts.makeThinkerByProvider(eff.chief, eff.claudeModel)
        : this.thinkerForId(eff.chief === 'claude' ? 'claude-api' : 'codex', eff.claudeModel);
      const reviewer =
        eff.single || eff.reviewer === 'none'
          ? undefined
          : this.opts.makeThinkerByProvider
            ? this.opts.makeThinkerByProvider(eff.reviewer, eff.claudeModel)
            : this.thinkerForId(eff.reviewer === 'claude' ? 'claude-api' : 'codex', eff.claudeModel);
      const preset: DiscussionPreset = eff.chief === 'codex' && eff.reviewer === 'none' ? 'codex-single' : 'roles';
      const pLabel = planner.displayName;
      const rLabel = reviewer?.displayName ?? null;
      const rDisplay = reviewer
        ? reviewer.displayName
        : eff.sameAi
          ? `${pLabel}（与首席同一 AI，按单思考者运行）`
          : '不复核';

      return {
        preset,
        planner,
        ...(reviewer ? { reviewer } : {}),
        single: eff.single,
        sameAiSingle: eff.sameAi,
        plannerLabel: pLabel,
        reviewerLabel: rLabel,
        reviewerRoleDisplay: rDisplay,
        roleSourceLabel: eff.sourceLabel,
        modelHint: eff.claudeModel,
        roleProblem: eff.problem,
      };
    }

    const legacy = this.resolveLegacySet(explicitPreset ?? 'codex-single');
    return {
      ...legacy,
      plannerLabel: legacy.planner.displayName,
      reviewerLabel: legacy.reviewer?.displayName ?? null,
      reviewerRoleDisplay: legacy.reviewer?.displayName ?? '不复核',
      sameAiSingle: false,
      roleSourceLabel: null,
      roleProblem: null,
    };
  }

  private resolveStartedPlan(snap: DiscussionSnapshot): ResolvedThinkerSet {
    if (snap.presetHint === 'dev-personal' || snap.plannerId === 'claude-cli') {
      const set = this.resolveLegacySet('dev-personal');
      return {
        ...set,
        plannerLabel: snap.plannerLabel ?? set.planner.displayName,
        reviewerLabel: snap.reviewerLabel ?? set.reviewer?.displayName ?? null,
        reviewerRoleDisplay: snap.reviewerLabel ?? set.reviewer?.displayName ?? '不复核',
        sameAiSingle: false,
        roleSourceLabel: snap.roleSourceLabel ?? '开发者预设',
        roleProblem: null,
      };
    }

    if (!snap.presetHint && !snap.single && !this.opts.makeThinkerByProvider && this.opts.devPersonalEnabled) {
      const set = this.resolveLegacySet('dev-personal');
      return {
        ...set,
        plannerLabel: set.planner.displayName,
        reviewerLabel: set.reviewer?.displayName ?? null,
        reviewerRoleDisplay: set.reviewer?.displayName ?? '不复核',
        sameAiSingle: false,
        roleSourceLabel: '开发者预设',
        roleProblem: null,
      };
    }

    const planner = this.thinkerForId(snap.plannerId, snap.modelHint);
    const reviewer = !snap.single && snap.reviewerId ? this.thinkerForId(snap.reviewerId, snap.modelHint) : undefined;
    const pLabel = snap.plannerLabel ?? planner.displayName;
    const rLabel = snap.single ? null : (snap.reviewerLabel ?? reviewer?.displayName ?? null);
    const sameAi = !!snap.sameAiSingle;
    const rDisplay = rLabel
      ? rLabel
      : sameAi
        ? `${pLabel}（与首席同一 AI，按单思考者运行）`
        : '不复核';
    const preset: DiscussionPreset =
      snap.presetHint === 'dev-personal' || snap.presetHint === 'codex-single' || snap.presetHint === 'roles'
        ? snap.presetHint
        : snap.single && snap.plannerId !== 'claude-api'
          ? 'codex-single'
          : 'roles';

    return {
      preset,
      planner,
      ...(reviewer ? { reviewer } : {}),
      single: snap.single,
      sameAiSingle: sameAi,
      plannerLabel: pLabel,
      reviewerLabel: rLabel,
      reviewerRoleDisplay: rDisplay,
      roleSourceLabel: snap.roleSourceLabel ?? null,
      ...(snap.modelHint ? { modelHint: snap.modelHint } : {}),
      roleProblem: null,
    };
  }

  async ensureBoundThread(task: Task, preset?: DiscussionPreset): Promise<string> {
    if (task.threadId) return task.threadId;
    const set = await this.resolveUnstartedPlan(preset);
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

    const set = snap.started
      ? this.resolveStartedPlan(snap)
      : await this.resolveUnstartedPlan(snap.presetHint === 'dev-personal' ? 'dev-personal' : undefined);
    const single = snap.started ? snap.single : set.single;
    const independentReview = !single;
    const active = this.activeStep.get(task.id) ?? null;
    const err = this.errors.get(task.id) ?? null;
    const [chats, briefView] = await Promise.all([
      readDiscussionChats(this.opts.repo, threadId),
      readProjectBriefView(this.opts.repo),
    ]);

    const plannerLabel = set.plannerLabel ?? set.planner.displayName;
    const reviewerLabel = single ? null : (set.reviewerLabel ?? set.reviewer?.displayName ?? null);
    const sameAiSingle = !!set.sameAiSingle;
    const reviewerRoleDisplay =
      set.reviewerRoleDisplay ??
      (reviewerLabel ? reviewerLabel : sameAiSingle ? `${plannerLabel}（与首席同一 AI，按单思考者运行）` : '不复核');
    const presetLabel =
      set.preset === 'roles'
        ? `${plannerLabel} 首席${reviewerLabel ? ` + ${reviewerLabel} 复核` : sameAiSingle ? '（首席与复核同 AI）' : '（不复核）'}`
        : PRESET_LABEL[set.preset];

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
      preset: set.preset,
      canUseDevPersonal: !!this.opts.devPersonalEnabled,
      canSwitchPreset: !snap.started && snap.state === 'requirements_draft' && snap.budget.callsUsed === 0 && !this.inflight.has(task.id),
      presetLabel,
      plannerLabel,
      reviewerLabel,
      reviewerRoleDisplay,
      sameAiSingle,
      roleSourceLabel: set.roleSourceLabel ?? null,
      roleProblem: snap.started ? null : (set.roleProblem ?? null),
      independentReview,
      unreviewed: single,
      unreviewedBadge: single ? '未经独立评审' : null,
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
      hasRequiredContext: briefView.exists,
      requiredContextSource: briefView.source,
    };
  }

  async sendChat(task: Task, target: ChatTarget, message: string): Promise<DiscussionView> {
    if (this.inflight.has(task.id)) throw new Error('这个任务的讨论或对话正在进行中，请稍候。');
    const threadId = task.threadId ?? (await this.ensureBoundThread(task));
    const snap = await inspectDiscussion(this.opts.repo, threadId, { consentStore: this.consent });
    const set = snap.started
      ? this.resolveStartedPlan(snap)
      : await this.resolveUnstartedPlan(snap.presetHint === 'dev-personal' ? 'dev-personal' : undefined);
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

  /** 开始讨论前锁定当前角色配置到线程记录中（此后修改设置不影响该线程）。 */
  async prepareStart(task: Task, threadId: string, preset: DiscussionPreset): Promise<ResolvedThinkerSet> {
    const snap = await inspectDiscussion(this.opts.repo, threadId, { consentStore: this.consent });
    if (snap.started) {
      return this.resolveStartedPlan(snap);
    }
    const set = await this.resolveUnstartedPlan(preset);
    if (set.roleProblem) {
      throw new Error(set.roleProblem);
    }
    await lockThreadRoles(this.opts.repo, threadId, {
      single: set.single,
      plannerId: set.planner.id,
      ...(set.reviewer ? { reviewerId: set.reviewer.id } : {}),
      ...(set.plannerLabel ? { plannerLabel: set.plannerLabel } : {}),
      ...(set.reviewerLabel ? { reviewerLabel: set.reviewerLabel } : {}),
      sameAiSingle: !!set.sameAiSingle,
      presetHint: set.preset,
      ...(set.modelHint ? { modelHint: set.modelHint } : {}),
      ...(set.roleSourceLabel ? { roleSourceLabel: set.roleSourceLabel } : {}),
    });
    return set;
  }

  private async runTurn(task: Task, threadId: string, preset: DiscussionPreset, decisions: ResumeDecisions): Promise<FlowOutcome> {
    if (this.inflight.has(task.id)) throw new Error('这个任务的讨论正在进行中，请稍候。');
    const snap = await inspectDiscussion(this.opts.repo, threadId, { consentStore: this.consent });
    const set = snap.started ? this.resolveStartedPlan(snap) : await this.resolveUnstartedPlan(preset);
    if (!snap.started && set.roleProblem) {
      throw new Error(set.roleProblem);
    }
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
    const set = await this.resolveUnstartedPlan(preset);
    await updateThreadPreset(this.opts.repo, task.threadId, {
      single: set.single,
      plannerId: set.planner.id,
      ...(set.reviewer ? { reviewerId: set.reviewer.id } : {}),
      ...(set.plannerLabel ? { plannerLabel: set.plannerLabel } : {}),
      ...(set.reviewerLabel ? { reviewerLabel: set.reviewerLabel } : {}),
      sameAiSingle: !!set.sameAiSingle,
      presetHint: set.preset,
      ...(set.modelHint ? { modelHint: set.modelHint } : {}),
      ...(set.roleSourceLabel ? { roleSourceLabel: set.roleSourceLabel } : {}),
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
