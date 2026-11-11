import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StaleRunError, StateConflictError, WriterLockedError, type OpenOptions } from '../persistence/index.js';
import * as G from '../git/git.js';
import { GitError } from '../git/git.js';
import { MESSAGES } from '../task/messages.js';
import { buildPreviews, buildSingleFilePreview, PREVIEW_LIMITS, type ChangePreview } from '../acceptance/snippets.js';
import { buildSaveHistoryView, type SaveHistoryView } from '../acceptance/history.js';
import {
  acceptanceVersion,
  buildSaveOutcomeFromFail,
  isVersionFormat,
  mapFailure,
  okMessage,
  toUserView,
  VIEW_TEXT,
  type SaveConflictDiffView,
  type SaveOutcomeView,
  type UserAcceptanceView,
  type ViewContext,
} from '../acceptance/view.js';
import { TaskRunner, type ResolvedExecutor } from '../task/runner.js';
import { detectScripts, type SandboxCommandRunner } from '../checks/scripts.js';
import { resolveCapabilities } from '../capabilities/model.js';
import { validateExtraDir } from '../executor/extra-dirs.js';
import type { Executor } from '../executor/types.js';
import type { SaveProgressEvent, Task } from '../task/model.js';
import type { Thinker } from '../thinking/types.js';
import {
  buildSameAiNotice,
  type AiProviderId,
  type AiSettingsStore,
  type ProjectRolesView,
  type VerifiedExecutorOption,
} from './ai-settings.js';
import { buildTaskView, extraDirKey, type TaskView } from './task-view.js';
import { classifyTaskState, type TaskClassification } from './task-state-view.js';
import type { ModePreference, TaskPrefs } from './prefs.js';
import {
  convertApprovedPlanToTaskPlan,
  DiscussionService,
  type DiscussionPreset,
  type DiscussionView,
  type ResolvedThinkerSet,
} from './discussion-service.js';
import {
  hasRequiredContext,
  readProjectBriefView,
  saveProjectBrief as writeProjectBrief,
  type ProjectBriefView,
} from '../thinking/flow/index.js';

export interface PlanInput {
  goal: string;
  criteria: string[];
  mode: ModePreference;
  network: boolean;
}

export interface UndoHistoryResult {
  ok: boolean;
  message: string;
  files?: string[];
  saveOutcome?: SaveOutcomeView;
  history: SaveHistoryView;
}

export interface AddDirResult {
  view: TaskView;
  /** 用户在选择框里点了取消 */
  cancelled: boolean;
  /** 校验没通过的中文原因 */
  rejected: string | null;
}

export interface ImportExternalResult {
  cancelled: boolean;
  verdict: 'bound' | 'mismatch' | 'unverified' | null;
  task: TaskView;
}

export interface ControllerOptions {
  repo: string;
  /** 每个任务开工时用它取得执行体（主进程里是 Codex；测试里是 FakeExecutor） */
  makeExecutor: () => Executor;
  /** 系统文件夹选择框（只有主进程能弹；渲染进程拿不到路径参数的入口） */
  pickDirectory: () => Promise<string | null>;
  /** 系统文件选择框（导入外部报告，只允许 .md / .txt；只有主进程能弹） */
  pickReportFile?: () => Promise<string | null>;
  prefs: TaskPrefs;
  /** 记录库的打开选项（主进程里传入：数据目录所在卷检查、租约等待） */
  storeOptions?: OpenOptions;
  /** 外部打开预览的回调（主进程中调用 Electron shell；测试中可注入模拟） */
  openPreview?: (target: { kind: 'web' | 'finder'; targetPath: string }) => Promise<void>;
  /** 在访达中显示外部交接文件或副本文件夹（仅接受控制器校验后的路径） */
  revealPath?: (targetPath: string) => Promise<void>;
  /** 讨论阶段思考者构造工厂（默认 Codex 单思考者；主进程按环境注入 dev-personal） */
  makeThinkers?: (preset: DiscussionPreset) => ResolvedThinkerSet;
  /** 是否开启开发者预设（STUDIO_DEV_PERSONAL_CLAUDE=1 且未打包） */
  devPersonalEnabled?: boolean;
  /** 全局/项目 AI 角色配置（阶段 5b） */
  aiSettings?: AiSettingsStore;
  /** 当前接入 AI 的可用状态 */
  getAiAvailability?: () => Promise<{ codexAvailable: boolean; claudeAvailable: boolean }>;
  /** 按思考者标识（codex / claude）构建 Thinker */
  makeThinkerByProvider?: (provider: AiProviderId, model?: string) => Thinker;
  /** 动态按执行者编号构造真实 Executor（含 API Agent 与独立沙箱运行器） */
  resolveExecutor?: (executorId?: string) => Promise<ResolvedExecutor>;
  /** 当选定非 Codex 执行体或外部交接时使用的独立受限检查沙箱兜底（阶段 8C） */
  fallbackSandboxRunner?: SandboxCommandRunner;
  /** 获取当前已通过连接测试的全部可用执行者列表 */
  getVerifiedExecutors?: () => Promise<VerifiedExecutorOption[]>;
  /** 保存前检查进度推送事件回调（主进程向渲染层推送实时步骤状态） */
  onSaveProgress?: (ev: SaveProgressEvent) => void;
}

const EDITABLE = ['draft', 'clarifying', 'planned', 'approved'];

/**
 * 任务界面与核心之间的控制层（纯 Node，可独立测试）。
 * 渲染进程只会传：任务编号、需求文字、计划表单、布尔确认；路径一律由这里经系统选择框取得并校验。
 */
export class TaskController {
  private runner: TaskRunner | undefined;
  private discussion: DiscussionService | undefined;
  private readonly active = new Set<string>();
  private readonly startErrors = new Map<string, string>();

  constructor(private readonly o: ControllerOptions) {}

  get repoPath(): string {
    return this.o.repo;
  }

  /** 懒创建：第一次真正用到任务功能时才取得执行体 */
  private r(): TaskRunner {
    if (!this.runner) {
      this.runner = new TaskRunner({
        repo: this.o.repo,
        executor: this.o.makeExecutor(),
        ...(this.o.resolveExecutor ? { resolveExecutor: this.o.resolveExecutor } : {}),
        ...(this.o.fallbackSandboxRunner ? { fallbackSandboxRunner: this.o.fallbackSandboxRunner } : {}),
        ...(this.o.storeOptions ? { storeOptions: this.o.storeOptions } : {}),
      });
      this.runner.on('save_progress', (ev: SaveProgressEvent) => {
        this.o.onSaveProgress?.(ev);
      });
    }
    return this.runner;
  }

  private d(): DiscussionService {
    this.discussion ??= new DiscussionService({
      repo: this.o.repo,
      ...(this.o.devPersonalEnabled ? { devPersonalEnabled: true } : {}),
      ...(this.o.makeThinkers ? { makeThinkers: this.o.makeThinkers } : {}),
      ...(this.o.aiSettings ? { aiSettings: this.o.aiSettings } : {}),
      ...(this.o.getAiAvailability
        ? { getClaudeAvailability: async () => (await this.o.getAiAvailability!()).claudeAvailable }
        : {}),
      ...(this.o.makeThinkerByProvider ? { makeThinkerByProvider: this.o.makeThinkerByProvider } : {}),
    });
    return this.discussion;
  }

  /** 打开并取得本项目的持久化存储实例（取得 APFS/目录锁并完成存储对账）。 */
  openRecordStore() {
    return this.r().store.recordStore();
  }

  isTaskActive(id: string): boolean {
    return this.active.has(id) || this.ops.has(id) || this.d().isRunning(id);
  }

  /** 按当前实时运行与讨论状态归类任务（供工作台与项目侧栏角标使用）。 */
  async classifyTask(t: Task): Promise<TaskClassification> {
    const discussion = await this.d().getClassifyHint(t);
    return classifyTaskState(t, {
      isLiveRunning: this.isTaskActive(t.id),
      ...(discussion ? { discussion } : {}),
    });
  }

  async listTasksRaw(): Promise<Task[]> {
    await this.ready();
    return this.r().store.list();
  }

  /** 是否仍有任务在施工、讨论或保存/撤销/放弃等独占操作中。 */
  async hasRunningTasks(): Promise<boolean> {
    if (this.active.size > 0 || this.ops.size > 0) return true;
    await this.ready();
    const tasks = await this.r().store.list();
    return tasks.some((t) => t.state === 'running' || this.r().isBusy(t.id) || this.d().isRunning(t.id));
  }

  private async view(t: Task): Promise<TaskView> {
    const scripts = Object.keys(await detectScripts(this.o.repo)) as ('build' | 'test')[];
    const running = this.active.has(t.id) || t.state === 'running';
    const stoppedOrFailed =
      ['stopped', 'timed_out', 'exec_failed'].includes(t.state) ||
      (t.state === 'reviewing' && !!t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0));
    const worktreeChanges =
      t.worktree && (running || stoppedOrFailed) ? await G.diffSummary(t.worktree).catch(() => undefined) : undefined;
    const discussion = await this.d().getClassifyHint(t);
    const handoffContent = t.handoff?.taskFilePath
      ? await fsp.readFile(t.handoff.taskFilePath, 'utf8').catch(() => '')
      : undefined;
    const availableExecutors =
      EDITABLE.includes(t.state) && this.o.getVerifiedExecutors
        ? await this.o.getVerifiedExecutors().catch(() => undefined)
        : undefined;
    const v = buildTaskView(t, {
      scripts,
      running,
      ...(worktreeChanges ? { worktreeChanges } : {}),
      ...(discussion ? { discussion } : {}),
      ...(handoffContent !== undefined ? { handoffContent } : {}),
      ...(availableExecutors ? { availableExecutors } : {}),
    });
    const err = this.startErrors.get(t.id);
    if (err && !v.startFailure) v.startFailure = err;
    return v;
  }

  private async load(id: unknown): Promise<Task> {
    if (typeof id !== 'string') throw new Error('无效的任务编号。');
    await this.ready(); // 启动核对先于任何读写（否则可能把刚开工的任务当作“中断的运行”）
    const t = await this.r().store.get(id);
    if (!t) throw new Error('找不到这个任务。');
    return t;
  }

  async preferredMode(): Promise<ModePreference> {
    return this.o.prefs.getMode(this.o.repo);
  }

  async list(): Promise<{ tasks: TaskView[]; preferredMode: ModePreference }> {
    await this.ready(); // 启动核对在第一次使用前完成，列表里才会看到“已核对”
    const tasks = await this.r().store.list();
    return { tasks: await Promise.all(tasks.map((t) => this.view(t))), preferredMode: await this.preferredMode() };
  }

  async create(request: unknown): Promise<TaskView> {
    if (typeof request !== 'string' || !request.trim()) throw new Error('请先写下你想让 AI 做什么。');
    if (request.length > 4000) throw new Error('需求太长了，请精简到 4000 字以内。');
    await this.ready();
    let initialExecutor: { id: string; displayName: string } | undefined;
    if (this.o.aiSettings && this.o.getVerifiedExecutors) {
      const verified = await this.o.getVerifiedExecutors().catch(() => []);
      const eff = await this.o.aiSettings.resolveEffectiveExecutor(this.o.repo, verified);
      initialExecutor = { id: eff.id, displayName: eff.id === 'codex' ? 'Codex' : eff.label };
    }
    const t = await this.r().create(request.trim(), initialExecutor);
    const threadId = await this.d().ensureBoundThread(t);
    const bound = await this.r().bindThread(t.id, threadId);
    return this.view(bound);
  }

  async setTaskExecutor(id: unknown, executorId: unknown): Promise<TaskView> {
    const tid = this.checkArg(TASK_ID, id);
    if (this.active.has(tid)) throw new Error('只有未开工的任务才能切换执行者。');
    if (
      typeof executorId !== 'string' ||
      (executorId !== 'codex' &&
        !/^api:[a-z0-9_-]{1,48}$/.test(executorId) &&
        !/^sub:(?:claude_cli|agy|cursor)$/.test(executorId))
    ) {
      throw new Error('无效的执行者编号。');
    }
    const verified = this.o.getVerifiedExecutors ? await this.o.getVerifiedExecutors() : [];
    const hit = verified.find((v) => v.id === executorId);
    if (!hit) {
      throw new Error('所选执行者尚未通过连接测试或已不可用，请先在「设置 → AI 与角色」完成连接测试。');
    }
    return this.view(await this.r().setTaskExecutor(tid, hit.id, hit.id === 'codex' ? 'Codex' : hit.label));
  }

  async get(id: unknown): Promise<TaskView> {
    await this.ready();
    return this.view(await this.load(id));
  }

  /** 校验表单（来自渲染进程的任何输入都不可信） */
  private parsePlan(input: unknown, request: string): PlanInput {
    const p = (input ?? {}) as Partial<PlanInput>;
    if (p.mode !== 'standard' && p.mode !== 'full_trust') throw new Error('无效的模式。');
    if (typeof p.network !== 'boolean') throw new Error('无效的联网选项。');
    const goal = typeof p.goal === 'string' && p.goal.trim() ? p.goal.trim().slice(0, 2000) : request;
    const criteria = Array.isArray(p.criteria) ? p.criteria.filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim().slice(0, 300)).slice(0, 20) : [];
    return { goal, criteria, mode: p.mode, network: p.network };
  }

  private async applyPlan(t: Task, plan: PlanInput, extraDirs: string[]): Promise<Task> {
    if (!EDITABLE.includes(t.state)) throw new Error('任务已经开工，不能再修改计划。');
    // 完全信任下联网与额外目录没有意义（本来就不受限），不带入，避免界面上看起来像“限制”
    const caps = resolveCapabilities({
      constructionMode: plan.mode,
      externalNetwork: plan.mode === 'standard' && plan.network ? 'on' : 'off',
      extraWritableDirs: plan.mode === 'standard' ? extraDirs : [],
    });
    const planned = await this.r().setPlan(t.id, { goal: plan.goal, inScope: [], outOfScope: [], criteria: plan.criteria, risks: [], irreversible: [], capabilities: caps });
    await this.o.prefs.setMode(this.o.repo, plan.mode);
    return planned;
  }

  async savePlan(id: unknown, input: unknown): Promise<TaskView> {
    const t = await this.load(id);
    const plan = this.parsePlan(input, t.request);
    return this.view(await this.applyPlan(t, plan, t.plan?.capabilities.extraWritableDirs ?? []));
  }

  async addExtraDir(id: unknown): Promise<AddDirResult> {
    const t = await this.load(id);
    if (!EDITABLE.includes(t.state)) throw new Error('任务已经开工，不能再修改计划。');
    const picked = await this.o.pickDirectory();
    if (!picked) return { view: await this.view(t), cancelled: true, rejected: null };
    const v = await validateExtraDir(picked, { repo: this.o.repo });
    if (!v.ok) return { view: await this.view(t), cancelled: false, rejected: v.reason };
    const caps = t.plan?.capabilities;
    const plan: PlanInput = { goal: t.plan?.goal ?? t.request, criteria: t.plan?.criteria ?? [], mode: 'standard', network: caps?.externalNetwork === 'on' };
    const dirs = [...new Set([...(caps?.extraWritableDirs ?? []), v.dir])];
    return { view: await this.view(await this.applyPlan(t, plan, dirs)), cancelled: false, rejected: null };
  }

  async removeExtraDir(id: unknown, key: unknown): Promise<TaskView> {
    const t = await this.load(id);
    if (typeof key !== 'string') throw new Error('无效的选项。');
    const caps = t.plan?.capabilities;
    const dirs = (caps?.extraWritableDirs ?? []).filter((d) => extraDirKey(d) !== key);
    const plan: PlanInput = { goal: t.plan?.goal ?? t.request, criteria: t.plan?.criteria ?? [], mode: caps?.constructionMode ?? 'standard', network: caps?.externalNetwork === 'on' };
    return this.view(await this.applyPlan(t, plan, dirs));
  }

  /**
   * 批准并开工（不等待施工结束；界面轮询 get）。
   * 完全信任：必须 ack === true（界面勾选“我已了解风险”），随后经 TaskRunner.confirmFullTrust 写入本任务的确认标记；
   * 没有确认时核心层（runner 与执行体适配器）也会拒绝开工，这里只是第一道。
   */
  async start(id: unknown, ack: unknown): Promise<TaskView> {
    let t = await this.load(id);
    if (!t.plan) throw new Error('请先保存计划。');
    if (t.executorId === 'unset') throw new Error('当前执行者未设置（原 API 配置可能已删除），请先重新选择已测通的执行者。');
    const fullTrust = t.plan.capabilities.constructionMode === 'full_trust';
    if (fullTrust && ack !== true) throw new Error('完全信任模式需要你勾选“我已了解风险”后才能开工。');
    if (this.active.has(t.id)) throw new Error('这个任务已经在施工中。');
    this.startErrors.delete(t.id);
    if (t.state === 'planned') t = await this.r().approve(t.id);
    if (fullTrust) t = await this.r().confirmFullTrust(t.id);
    await this.o.prefs.setMode(this.o.repo, fullTrust ? 'full_trust' : 'standard');
    this.active.add(t.id);
    void this.r()
      .start(t.id)
      .catch((e: Error) => this.startErrors.set(t.id, this.persistenceMessage(e) ?? e.message))
      .finally(() => this.active.delete(t.id));
    return this.view(t);
  }

  async stop(id: unknown): Promise<TaskView> {
    const t = await this.load(id);
    await this.r().stop(t.id);
    return this.view((await this.r().store.get(t.id)) ?? t);
  }

  private async resolveExternalExportInput(t: Task): Promise<{
    plan: { path: string; text: string; sha256: string; artifactVersion: number };
    requirements: { id: string; text: string }[];
    criteria: string[];
    single: boolean;
    threadId: string;
  }> {
    if (!t.plan) throw new Error('没有施工计划，不能交给外部工具执行。');
    const criteria = t.plan.criteria.length > 0 ? t.plan.criteria : t.criteria.map((c) => c.text);
    if (t.approvedPlanPath && t.threadId) {
      try {
        const payload = await this.d().readApprovedPayload(t.threadId);
        const requirements =
          payload.frozenItems.length > 0
            ? payload.frozenItems.map((it) => ({ id: it.id, text: it.text }))
            : [{ id: 'R1', text: t.plan.goal }];
        const baseText = payload.planMarkdown || t.plan.goal;
        const planText =
          t.plan.goal && !baseText.includes(t.plan.goal) ? `${baseText}\n\n当前确认目标：${t.plan.goal}` : baseText;
        return {
          threadId: payload.threadId,
          single: payload.single,
          requirements,
          criteria,
          plan: {
            path: payload.planPath,
            text: planText,
            sha256: payload.planSha256 ?? crypto.createHash('sha256').update(planText).digest('hex'),
            artifactVersion: payload.planArtifactVersion ?? 1,
          },
        };
      } catch {
        // 若讨论记录不可读，退回手工计划结构
      }
    }
    const text = [
      `目标：${t.plan.goal}`,
      ...(t.plan.inScope.length ? ['', '要做：', ...t.plan.inScope.map((x) => `- ${x}`)] : []),
      ...(t.plan.outOfScope.length ? ['', '不要做：', ...t.plan.outOfScope.map((x) => `- ${x}`)] : []),
    ].join('\n');
    return {
      threadId: t.threadId ?? `manual-${t.id}`,
      single: !!t.planUnreviewed,
      requirements: [{ id: 'R1', text: t.plan.goal || t.request }],
      criteria,
      plan: {
        path: '施工计划（界面手工编辑）',
        text,
        sha256: crypto.createHash('sha256').update(text).digest('hex'),
        artifactVersion: t.currentRound ?? 1,
      },
    };
  }

  /** 交给外部工具执行：确认说明后创建独立副本并导出 .studio/handoff/<taskId>/task.md，任务进入 waiting_external。 */
  async exportExternalTask(id: unknown, ack: unknown): Promise<TaskView> {
    if (ack !== true) throw new Error('请先确认外部执行说明后再导出。');
    const tid = this.checkArg(TASK_ID, id);
    await this.ready();
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (this.active.has(t.id) || this.ops.has(t.id) || this.r().isBusy(t.id)) throw new Error(MESSAGES.busy);
    if (!t.plan) throw new Error('请先保存计划。');
    if (t.state !== 'planned' && t.state !== 'approved') throw new Error('当前状态不能交给外部工具执行。');
    const input = await this.resolveExternalExportInput(t);
    const updated = await this.r().exportExternal(t.id, input);
    return this.view(updated);
  }

  /** 在访达中显示已导出的 task.md 或对应的任务副本文件夹（由主进程控制路径）。 */
  async revealHandoff(id: unknown, target: unknown): Promise<void> {
    if (target !== 'task_file' && target !== 'worktree') throw new Error(VIEW_TEXT.invalidArgument);
    const tid = this.checkArg(TASK_ID, id);
    await this.ready();
    const t = await this.load(tid);
    if (!t.handoff) throw new Error('这个任务还没有导出给外部工具。');
    const dest = target === 'worktree' ? t.handoff.worktreePath : t.handoff.taskFilePath;
    if (!this.o.revealPath) throw new Error('当前环境不支持打开访达。');
    await this.o.revealPath(dest);
  }

  /**
   * 导入外部工具报告（Stage 7 提交②）：
   * 经主进程系统文件框选择 .md / .txt，调用 importReport + 副本实际状态核对，并保存导入记录。
   * - bound：按工作树实际状态自动暂存未提交改动并进入本应用验收流程（不调用 reviewImportedReport）；
   * - mismatch / unverified：停在 waiting_external 只读展示核对结果与矛盾项，允许重新导入。
   */
  async importExternalReport(id: unknown): Promise<ImportExternalResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.ready();
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (this.active.has(t.id) || this.ops.has(t.id) || this.r().isBusy(t.id)) throw new Error(MESSAGES.busy);
    if (t.state !== 'waiting_external' || !t.worktree || !t.handoff) {
      throw new Error('只有「外部执行中」的任务才能导入报告。');
    }
    if (!this.o.pickReportFile) throw new Error('当前环境未配置文件选择框，无法选择报告。');
    const picked = await this.o.pickReportFile();
    if (!picked) {
      return { cancelled: true, verdict: null, task: await this.view(t) };
    }
    if (!/\.(md|txt)$/i.test(picked)) {
      throw new Error('只支持导入 .md 或 .txt 格式的任务报告。');
    }
    const res = await this.r().importExternalReport(t.id, { reportPath: picked });
    return { cancelled: false, verdict: res.verdict, task: await this.view(res.task) };
  }

  /**
   * 停止/中断/出错后在同一任务副本上继续执行（不等待执行结束，立刻返回 running 态视图）：
   * 仅在 reviewing/stopped/timed_out/exec_failed 且非 manualReview 时放行；保留原有 worktree 与已做修改。
   */
  async continueTask(id: unknown): Promise<TaskView> {
    const tid = this.checkArg(TASK_ID, id);
    await this.ready();
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (this.active.has(t.id) || this.ops.has(t.id) || this.r().isBusy(t.id)) throw new Error(MESSAGES.busy);
    const isStoppedOrFailed =
      ['stopped', 'timed_out', 'exec_failed'].includes(t.state) ||
      (t.state === 'reviewing' && !!t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0));
    if (!isStoppedOrFailed) throw new Error('只有已停止、中断或出错的任务才能继续执行。');
    if (!t.worktree) throw new Error('任务副本不存在，请去验收页查看或放弃。');
    if (t.card?.items.some((i) => i.key === 'drivers')) throw new Error(MESSAGES.externalDriver);
    this.startErrors.delete(t.id);
    const { task: prepared, prompt } = await this.r().prepareContinue(t.id, '接着上次停下的地方继续');
    this.active.add(t.id);
    void this.r()
      .start(t.id, prompt)
      .catch((e: Error) => this.startErrors.set(t.id, this.persistenceMessage(e) ?? e.message))
      .finally(() => this.active.delete(t.id));
    return this.view(prepared);
  }

  private buildReworkInstruction(t: Task, feedback: string, opts: { requireNonEmpty: boolean }): string {
    const trimmed = feedback.trim();
    const rejected = t.criteria
      .filter((c) => c.decision === 'rejected')
      .map((c) => (c.note ? `${c.text}（说明：${c.note}）` : c.text));
    const parts: string[] = [];
    if (trimmed) parts.push(trimmed);
    if (rejected.length > 0) {
      parts.push(`本次不符合的验收标准：\n${rejected.map((line) => `- ${line}`).join('\n')}`);
    } else if (t.criteria.length === 0 && t.overallDecision === 'rejected') {
      parts.push(t.overallNote ? `整体结果不符合要求（说明：${t.overallNote}）` : '整体结果不符合要求');
    }
    const combined = parts.join('\n\n');
    if (opts.requireNonEmpty && !combined) {
      throw new Error('请填写退回修改的反馈，或先标出不符合的验收标准。');
    }
    return combined || '调整权限后开始新一轮修改';
  }

  private async prepareReworkTarget(id: unknown): Promise<Task> {
    const tid = this.checkArg(TASK_ID, id);
    await this.ready();
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (this.active.has(t.id) || this.ops.has(t.id) || this.r().isBusy(t.id)) throw new Error(MESSAGES.busy);
    if (t.state !== 'reviewing') throw new Error('当前状态不能退回修改。');
    if (!t.worktree) throw new Error('任务副本不存在，不能退回修改。');
    if (t.card?.items.some((i) => i.key === 'drivers')) throw new Error(MESSAGES.externalDriver);
    return t;
  }

  /**
   * 退回修改（#09-rework）：沿用现有任务副本与历史轮次记录，带上反馈与不符合标准发起新一轮执行。
   */
  async reworkTask(id: unknown, feedback: unknown): Promise<TaskView> {
    if (typeof feedback !== 'string' || feedback.length > 2000) throw new Error(VIEW_TEXT.invalidArgument);
    const t = await this.prepareReworkTarget(id);
    const instruction = this.buildReworkInstruction(t, feedback, { requireNonEmpty: true });
    this.startErrors.delete(t.id);
    const { task: prepared, prompt } = await this.r().prepareContinue(t.id, instruction);
    this.active.add(t.id);
    void this.r()
      .start(t.id, prompt)
      .catch((e: Error) => this.startErrors.set(t.id, this.persistenceMessage(e) ?? e.message))
      .finally(() => this.active.delete(t.id));
    return this.view(prepared);
  }

  /**
   * 外部执行任务在验收页点「退回修改」（#09-rework）后选择「再次交给外部工具」：
   * 沿用同一副本发起第 N+1 轮外部执行并重新生成 .studio/handoff/<taskId>/task.md。
   */
  async reworkExternalTask(id: unknown, feedback: unknown): Promise<TaskView> {
    if (typeof feedback !== 'string' || feedback.length > 2000) throw new Error(VIEW_TEXT.invalidArgument);
    const t = await this.prepareReworkTarget(id);
    const instruction = this.buildReworkInstruction(t, feedback, { requireNonEmpty: true });
    this.startErrors.delete(t.id);
    const { task: prepared } = await this.r().prepareContinue(t.id, instruction);
    const input = await this.resolveExternalExportInput(prepared);
    const exported = await this.r().exportExternal(prepared.id, input);
    return this.view(exported);
  }

  /**
   * 退回修改时调整权限：保存待用反馈并将状态退回 planned（保留任务副本与历史轮次记录），需重新点击「批准并开工」。
   */
  async editReworkPermissions(id: unknown, feedback: unknown): Promise<TaskView> {
    if (typeof feedback !== 'string' || feedback.length > 2000) throw new Error(VIEW_TEXT.invalidArgument);
    const t = await this.prepareReworkTarget(id);
    const instruction = this.buildReworkInstruction(t, feedback, { requireNonEmpty: false });
    this.startErrors.delete(t.id);
    const { task: planned } = await this.r().prepareContinue(t.id, instruction, { transitionToPlanned: true });
    return this.view(planned);
  }

  // ───────────────────────── 验收、保存、放弃、撤销（B4-2） ─────────────────────────
  // 渲染进程只传：任务编号、条目编号（c0 / d0）、验收版本、（无参数的操作）。返回给它的只有 UserAcceptanceView 与固定文案。

  private reconcileDone: Promise<void> | undefined;
  /** 同一任务正在执行的操作（同步登记，重复点击只生效一次；核心层另有互斥作为第二道） */
  private readonly ops = new Set<string>();

  /**
   * 启动核对：每个控制器只做一次。第一步识别、第二步安全收尾都在核心层；这里只负责在第一次使用前完成它，
   * 出错时原始内容写进受保护的诊断记录，界面不读。
   */
  private ready(): Promise<void> {
    this.reconcileDone ??= this.r()
      .reconcileTasks()
      .then(() => undefined)
      .catch((e: unknown) => this.diagnose(undefined, '启动核对失败', e));
    return this.reconcileDone;
  }

  /** 原始错误只写进 <项目>/.studio/events.jsonl（受保护的诊断记录，经持久化服务追加），界面不读取 */
  private async diagnose(taskId: string | undefined, what: string, e: unknown): Promise<void> {
    try {
      const raw = e instanceof Error ? `${e.message}${e instanceof GitError ? `\n${e.stderr}` : ''}` : String(e);
      await (await this.r().store.recordStore()).appendEvent('diagnostic', { taskId: taskId ?? null, what, raw });
    } catch {
      // 诊断记录写不进去也不能影响界面
    }
  }

  /** 把持久化层的显式错误映射成固定文案；其余未知错误返回 null */
  private persistenceMessage(e: unknown): string | null {
    if (e instanceof StateConflictError || e instanceof StaleRunError) return MESSAGES.stateConflict;
    if (e instanceof WriterLockedError) return MESSAGES.writerLocked;
    if (e instanceof Error && e.message === MESSAGES.busy) return MESSAGES.busy;
    return null;
  }

  private checkArg(re: RegExp, v: unknown): string {
    if (typeof v !== 'string' || !re.test(v)) throw new Error(VIEW_TEXT.invalidArgument);
    return v;
  }
  private checkVersion(v: unknown): string {
    if (!isVersionFormat(v)) throw new Error(VIEW_TEXT.invalidArgument);
    return v;
  }

  /** 用户验收视图：计算实时判定（保存前提、撤销条件、改动片段），再交给 view.ts 生成 */
  private async buildConflictDiffs(t: Task): Promise<SaveConflictDiffView[]> {
    const conflict = t.conflict;
    const baseSha = t.worktree?.baseSha;
    const taskTree = t.acceptedTree;
    if (!conflict || !baseSha || !taskTree || !conflict.files.length) return [];
    const mainTitle = conflict.otherGoal ? `主项目这边的改动（来自「${conflict.otherGoal}」）` : '主项目这边的改动（项目里后来的改动）';
    const taskTitle = '当前任务这边的改动';
    const out: SaveConflictDiffView[] = [];
    for (const filePath of conflict.files.slice(0, PREVIEW_LIMITS.maxFiles)) {
      const [leftPreview, rightPreview] = await Promise.all([
        buildSingleFilePreview(this.o.repo, baseSha, conflict.againstHead, filePath),
        buildSingleFilePreview(this.o.repo, baseSha, taskTree, filePath),
      ]);
      out.push({
        path: filePath,
        left: { title: mainTitle, preview: leftPreview },
        right: { title: taskTitle, preview: rightPreview },
      });
    }
    return out;
  }

  private async acceptanceView(t: Task): Promise<UserAcceptanceView> {
    const runner = this.r();
    const busy = this.active.has(t.id) || this.ops.has(t.id) || runner.isBusy(t.id);
    const ctx: ViewContext = { busy, repoPath: this.o.repo };
    if (t.worktree?.path) {
      try {
        const indexPath = path.join(t.worktree.path, 'index.html');
        const s = await fs.promises.stat(indexPath);
        if (s.isFile()) {
          ctx.previewKind = 'web';
          ctx.previewButtonText = '在浏览器中打开预览';
        } else {
          ctx.previewKind = 'finder';
          ctx.previewButtonText = '在访达中显示';
        }
      } catch {
        ctx.previewKind = 'finder';
        ctx.previewButtonText = '在访达中显示';
      }
    }
    if (!busy && !t.manualReview) {
      try {
        if (t.state === 'reviewing' && t.card) ctx.saveCheck = await runner.previewSave(t);
        if (t.state === 'saved' || t.state === 'undo_failed') {
          ctx.undoCheck = await runner.previewUndo(t);
          ctx.otherUndoableSave = false;
        }
        if ((t.state === 'reviewing' || t.state === 'save_failed_unmerged') && t.card) {
          ctx.previews = await buildPreviews(this.o.repo, t);
          const head = await G.headSha(this.o.repo);
          ctx.otherUndoableSave = (await runner.store.list()).some((x) => x.id !== t.id && x.state === 'saved' && x.saveRecord?.mergeCommit === head);
        }
        if ((t.rounds?.length ?? 0) > 0) {
          const roundPreviews = new Map<number, Map<string, ChangePreview>>();
          for (const r of t.rounds ?? []) {
            if (!r.card) continue;
            const rev =
              (r.roundRef ? await G.resolveCommit(this.o.repo, r.roundRef) : null) ??
              r.roundCommit ??
              r.acceptedTree ??
              null;
            const baseSha = r.roundBaseSha ?? t.worktree?.baseSha ?? t.binding?.baseHead;
            if (rev && baseSha) {
              roundPreviews.set(
                r.round,
                await buildPreviews(this.o.repo, {
                  acceptedTree: rev,
                  worktree: { path: t.worktree?.path ?? '', branch: t.worktree?.branch ?? '', baseSha },
                  card: r.card,
                }),
              );
            }
          }
          if (roundPreviews.size > 0) {
            ctx.roundPreviews = roundPreviews;
            if (!ctx.previews && t.card) {
              const curRound = t.currentRound ?? Math.max(...(t.rounds ?? []).map((r) => r.round));
              ctx.previews = roundPreviews.get(curRound);
            }
          }
        }
        if (t.state === 'save_failed_unmerged' && t.conflict && t.worktree?.baseSha && t.acceptedTree) {
          ctx.conflictDiffs = await this.buildConflictDiffs(t);
        }
      } catch (e) {
        await this.diagnose(t.id, '计算验收视图', e);
        if (t.state === 'reviewing') ctx.saveCheck = { ok: false, reason: 'failed', detail: '' };
      }
    }
    return toUserView(t, ctx);
  }

  async getAcceptanceView(id: unknown): Promise<UserAcceptanceView> {
    await this.ready();
    return this.acceptanceView(await this.load(id));
  }

  private async result(
    id: string,
    r: { ok: boolean; message: string; files?: string[] | undefined; saveOutcome?: SaveOutcomeView | undefined },
  ): Promise<AcceptanceActionResult> {
    const t = await this.load(id);
    const view = await this.acceptanceView(t);
    const saveOutcome = r.saveOutcome ?? view.saveOutcome ?? undefined;
    return {
      ok: r.ok,
      message: r.message,
      ...(r.files?.length ? { files: r.files } : {}),
      ...(saveOutcome ? { saveOutcome } : {}),
      view,
    };
  }

  /**
   * 执行一个会改动任务的操作：同步登记（重复点击 → busy）→ 异常写诊断并返回固定文案 → 返回刷新后的视图。
   * 异常状态（需要人工查看）的任务一律不接受写操作。
   */
  private async act(
    id: string,
    work: (t: Task) => Promise<{ ok: boolean; message: string; files?: string[] | undefined; saveOutcome?: SaveOutcomeView | undefined }>,
  ): Promise<AcceptanceActionResult> {
    await this.ready();
    if (this.ops.has(id) || this.r().isBusy(id)) return this.result(id, { ok: false, message: MESSAGES.busy });
    this.ops.add(id);
    let outcome: { ok: boolean; message: string; files?: string[] | undefined; saveOutcome?: SaveOutcomeView | undefined };
    try {
      const t = await this.load(id);
      if (t.manualReview) outcome = { ok: false, message: MESSAGES.abnormal };
      else {
        try {
          outcome = await work(t);
        } catch (e) {
          await this.diagnose(id, '操作失败', e);
          outcome = { ok: false, message: this.persistenceMessage(e) ?? MESSAGES.unknownError };
        }
      }
    } finally {
      this.ops.delete(id); // 先释放，再生成返回给界面的视图（否则视图会把自己当成“操作进行中”）
    }
    return this.result(id, outcome);
  }

  /** 确认类请求：版本必须与当前验收版本一致，且任务在验收阶段（recheck 之后旧版本全部失效） */
  private confirmWork(version: string, apply: (t: Task) => Promise<string | void>) {
    return async (t: Task) => {
      if (version !== acceptanceVersion(t)) return { ok: false, message: MESSAGES.acceptanceInvalid };
      if (t.state !== 'reviewing') return { ok: false, message: MESSAGES.notReady };
      const msg = await apply(t);
      return { ok: true, message: typeof msg === 'string' ? msg : '' };
    };
  }

  async openPreview(id: unknown, version: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const v = this.checkVersion(version);
    return this.act(tid, async (t: Task) => {
      if (v !== acceptanceVersion(t)) return { ok: false, message: MESSAGES.acceptanceInvalid };
      if (t.state !== 'reviewing') return { ok: false, message: MESSAGES.notReady };
      if (!t.worktree?.path) return { ok: false, message: '无法打开成果，请重试，或选择不查看直接验收' };
      const indexPath = path.join(t.worktree.path, 'index.html');
      let isWeb = false;
      try {
        const s = await fs.promises.stat(indexPath);
        isWeb = s.isFile();
      } catch {
        isWeb = false;
      }
      const targetPath = isWeb ? indexPath : t.worktree.path;
      const kind: 'web' | 'finder' = isWeb ? 'web' : 'finder';
      if (!this.o.openPreview) {
        return { ok: false, message: '无法打开成果，请重试，或选择不查看直接验收' };
      }
      try {
        await this.o.openPreview({ kind, targetPath });
      } catch {
        return { ok: false, message: '无法打开成果，请重试，或选择不查看直接验收' };
      }
      await this.r().confirm(t.id, { previewed: true });
      return { ok: true, message: isWeb ? '已在浏览器中打开预览' : '已在访达中显示' };
    });
  }

  async skipPreview(id: unknown, version: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const v = this.checkVersion(version);
    return this.act(tid, this.confirmWork(v, async (t) => {
      await this.r().confirm(t.id, { previewSkipped: true });
      return '已跳过查看成果';
    }));
  }

  async confirmCriterion(id: unknown, criterionId: unknown, version: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const cid = this.checkArg(/^c\d{1,2}$/, criterionId);
    const v = this.checkVersion(version);
    if (Number(cid.slice(1)) >= (await this.load(tid)).criteria.length) throw new Error(VIEW_TEXT.invalidArgument); // 不存在的条目：伪造参数，直接拒绝
    return this.act(tid, this.confirmWork(v, async (t) => {
      const index = Number(cid.slice(1));
      if (index >= t.criteria.length) throw new Error(VIEW_TEXT.invalidArgument);
      await this.r().confirm(t.id, { criterion: index, decision: 'confirmed' });
    }));
  }

  async rejectCriterion(id: unknown, criterionId: unknown, version: unknown, reason: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const cid = this.checkArg(/^(?:c\d{1,2}|overall)$/, criterionId);
    const v = this.checkVersion(version);
    if (typeof reason !== 'string' || reason.length > 500) throw new Error(VIEW_TEXT.invalidArgument);
    const t0 = await this.load(tid);
    if (cid === 'overall') {
      if (t0.criteria.length > 0) throw new Error(VIEW_TEXT.invalidArgument);
    } else if (Number(cid.slice(1)) >= t0.criteria.length) {
      throw new Error(VIEW_TEXT.invalidArgument);
    }
    const trimmed = reason.trim();
    return this.act(tid, this.confirmWork(v, async (t) => {
      if (cid === 'overall') {
        if (t.criteria.length > 0) throw new Error(VIEW_TEXT.invalidArgument);
        await this.r().confirm(t.id, { overallDecision: 'rejected', ...(trimmed ? { note: trimmed } : {}) });
        return;
      }
      const index = Number(cid.slice(1));
      if (index >= t.criteria.length) throw new Error(VIEW_TEXT.invalidArgument);
      await this.r().confirm(t.id, { criterion: index, decision: 'rejected', ...(trimmed ? { note: trimmed } : {}) });
    }));
  }

  async confirmOverall(id: unknown, version: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const v = this.checkVersion(version);
    await this.load(tid);
    return this.act(tid, this.confirmWork(v, async (t) => {
      await this.r().confirm(t.id, { overall: true });
    }));
  }

  async ackDenied(id: unknown, deniedId: unknown, version: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const did = this.checkArg(/^d\d{1,3}$/, deniedId);
    const v = this.checkVersion(version);
    if (Number(did.slice(1)) >= (await this.load(tid)).denied.length) throw new Error(VIEW_TEXT.invalidArgument);
    return this.act(tid, this.confirmWork(v, async (t) => {
      const index = Number(did.slice(1));
      if (index >= t.denied.length) throw new Error(VIEW_TEXT.invalidArgument);
      await this.r().confirm(t.id, { deniedAck: index });
    }));
  }

  async recheck(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      if (t.state !== 'reviewing') return { ok: false, message: MESSAGES.notReady };
      await this.r().recheck(t.id);
      return { ok: true, message: VIEW_TEXT.rechecked };
    });
  }

  private async runSave(id: unknown, version: unknown, confirmUnchecked: boolean): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    const v = this.checkVersion(version);
    await this.load(tid);
    return this.act(tid, async (t) => {
      // 用户看到并确认的就是这一版：版本不一致（例如另一处已重新检查）一律不保存
      if (v !== acceptanceVersion(t)) {
        const fail = { ok: false as const, reason: 'acceptance_invalid' as const, detail: MESSAGES.acceptanceInvalid };
        return { ok: false, message: MESSAGES.acceptanceInvalid, saveOutcome: buildSaveOutcomeFromFail(fail) };
      }
      const r = await this.r().save(t.id, confirmUnchecked ? { confirmUnchecked: true } : undefined);
      if (r.ok) return { ok: true, message: okMessage(r.task) };
      return { ok: false, ...mapFailure(r), saveOutcome: buildSaveOutcomeFromFail(r) };
    });
  }

  async saveTask(id: unknown, version: unknown): Promise<AcceptanceActionResult> {
    return this.runSave(id, version, false);
  }

  async saveUncheckedTask(id: unknown, version: unknown): Promise<AcceptanceActionResult> {
    return this.runSave(id, version, true);
  }

  async discardTask(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      if (['stopped', 'timed_out', 'exec_failed'].includes(t.state)) await this.r().ensureReviewed(t.id);
      const r = await this.r().discard(t.id);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
    });
  }

  async undoSave(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      const r = await this.r().undo(t.id);
      return r.ok
        ? { ok: true, message: okMessage(r.task) }
        : { ok: false, ...mapFailure(r), saveOutcome: buildSaveOutcomeFromFail(r, { isUndo: true }) };
    });
  }

  /** 读取项目级保存记录（#12-history）：按主线提交时间倒序，关联任务记录与最近一次有效保存的撤销可用性。 */
  async getSaveHistory(): Promise<SaveHistoryView> {
    await this.ready();
    const runner = this.r();
    const [commits, tasks] = await Promise.all([
      G.savePointsWithParents(this.o.repo, 100),
      runner.store.list(),
    ]);
    const projectLock = tasks.find((t) => !!t.manualReview) ?? null;
    return buildSaveHistoryView({
      commits,
      tasks,
      previewUndo: (t) => runner.previewUndo(t),
      projectLock,
    });
  }

  /** 在项目「保存记录」页面触发撤销：复用阶段 1 撤销路径，并在失败/被挡时回传对应的单结果状态与刷新后的记录表。 */
  async undoFromHistory(id: unknown): Promise<UndoHistoryResult> {
    const res = await this.undoSave(id);
    const history = await this.getSaveHistory();
    return {
      ok: res.ok,
      message: res.message,
      ...(res.files ? { files: res.files } : {}),
      ...(res.saveOutcome ? { saveOutcome: res.saveOutcome } : {}),
      history,
    };
  }

  async retryCleanup(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      const r = await this.r().retryCleanup(t.id);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
    });
  }

  /**
   * 阶段 6（#11-save-conflict）：「让 AI 在最新项目上重做这部分」。
   * 先在临时 worktree 中验证将非冲突改动合并到主项目最新 HEAD；若发生冲突则中止更新并返回如实提示，不破坏任务副本；
   * 若成功更新，则写入冲突反馈并按阶段 4 路径进入新一轮施工。
   */
  async reworkConflictTask(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      if (t.state !== 'save_failed_unmerged') {
        return { ok: false, message: '这个任务当前没有可重做的保存冲突。' };
      }
      const r = await this.r().prepareConflictRedo(t.id);
      if (!r.ok) {
        return { ok: false, message: r.message, ...(r.files?.length ? { files: r.files } : {}) };
      }
      this.startErrors.delete(t.id);
      this.active.add(t.id);
      void this.r()
        .start(t.id, r.prompt)
        .catch((e: Error) => this.startErrors.set(t.id, this.persistenceMessage(e) ?? e.message))
        .finally(() => this.active.delete(t.id));
      return { ok: true, message: '已基于最新项目重新开始修改。' };
    });
  }

  // ───────────────────────── 阶段 5：讨论与流程引擎驱动 ─────────────────────────

  private async ensureTaskThread(t: Task): Promise<string> {
    if (t.threadId) return t.threadId;
    const threadId = await this.d().ensureBoundThread(t);
    await this.r().bindThread(t.id, threadId);
    t.threadId = threadId;
    return threadId;
  }

  async getProjectBrief(): Promise<ProjectBriefView> {
    return readProjectBriefView(this.o.repo);
  }

  async saveProjectBrief(raw: unknown): Promise<ProjectBriefView> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(VIEW_TEXT.invalidArgument);
    const b = raw as { whatItIs?: unknown; principles?: unknown; targetUsers?: unknown };
    if (typeof b.whatItIs !== 'string' || typeof b.principles !== 'string' || typeof b.targetUsers !== 'string') {
      throw new Error(VIEW_TEXT.invalidArgument);
    }
    if (b.whatItIs.length > 2000 || b.principles.length > 2000 || b.targetUsers.length > 2000) {
      throw new Error(VIEW_TEXT.invalidArgument);
    }
    await writeProjectBrief(this.o.repo, {
      whatItIs: b.whatItIs,
      principles: b.principles,
      targetUsers: b.targetUsers,
    });
    await G.ensureStudioIgnored(this.o.repo).catch(() => undefined);
    return readProjectBriefView(this.o.repo);
  }

  private async verifiedExecutorList(codexAvailable = true): Promise<VerifiedExecutorOption[]> {
    if (this.o.getVerifiedExecutors) return this.o.getVerifiedExecutors();
    return codexAvailable ? [{ id: 'codex', label: 'Codex（本机）', kind: 'codex', officialEndpoint: true }] : [];
  }

  async getProjectRoles(): Promise<ProjectRolesView> {
    if (!this.o.aiSettings) throw new Error('当前环境未启用 AI 角色设置。');
    const avail = this.o.getAiAvailability
      ? await this.o.getAiAvailability()
      : { codexAvailable: true, claudeAvailable: true };
    const verifiedExecutors = await this.verifiedExecutorList(avail.codexAvailable);
    const [cfg, globalRoles, effective, projExec, effectiveExecutor] = await Promise.all([
      this.o.aiSettings.getProjectRoles(this.o.repo),
      this.o.aiSettings.getGlobalRoles(),
      this.o.aiSettings.resolveEffectiveRoles(this.o.repo, avail),
      this.o.aiSettings.getProjectExecutor(this.o.repo),
      this.o.aiSettings.resolveEffectiveExecutor(this.o.repo, verifiedExecutors),
    ]);
    return {
      ...cfg,
      globalRoles,
      effective,
      codexAvailable: avail.codexAvailable,
      claudeAvailable: avail.claudeAvailable,
      sameAiNotice: buildSameAiNotice(cfg.chief, cfg.reviewer),
      executorMode: projExec.mode,
      projectExecutor: projExec.executor,
      effectiveExecutor,
      verifiedExecutors,
    };
  }

  async saveProjectRoles(mode: unknown, chief: unknown, reviewer: unknown): Promise<ProjectRolesView> {
    if (!this.o.aiSettings) throw new Error('当前环境未启用 AI 角色设置。');
    const avail = this.o.getAiAvailability
      ? await this.o.getAiAvailability()
      : { codexAvailable: true, claudeAvailable: true };
    await this.o.aiSettings.saveProjectRoles(this.o.repo, { mode, chief, reviewer }, avail);
    return this.getProjectRoles();
  }

  async saveProjectExecutor(mode: unknown, executorId: unknown): Promise<ProjectRolesView> {
    if (!this.o.aiSettings) throw new Error('当前环境未启用 AI 角色设置。');
    const avail = this.o.getAiAvailability
      ? await this.o.getAiAvailability()
      : { codexAvailable: true, claudeAvailable: true };
    const verifiedExecutors = await this.verifiedExecutorList(avail.codexAvailable);
    await this.o.aiSettings.saveProjectExecutor(this.o.repo, mode, executorId, verifiedExecutors);
    return this.getProjectRoles();
  }

  async waitDiscussion(id: unknown): Promise<void> {
    const tid = this.checkArg(TASK_ID, id);
    await this.d().waitIdle(tid);
  }

  async getDiscussionView(id: unknown): Promise<DiscussionView> {
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    await this.ensureTaskThread(t);
    return this.d().getView(t);
  }

  async startDiscussion(id: unknown, preset: unknown): Promise<DiscussionView> {
    if (preset !== 'roles' && preset !== 'codex-single' && preset !== 'dev-personal') throw new Error(VIEW_TEXT.invalidArgument);
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (!['draft', 'clarifying'].includes(t.state)) throw new Error('只有讨论中的任务才能开始或继续讨论。');
    if (this.d().isRunning(t.id)) throw new Error('讨论正在进行中，请稍候。');
    const threadId = await this.ensureTaskThread(t);
    const current = await this.d().getView(t);
    if (current.preset !== preset) {
      await this.d().setPresetBeforeStart(t, preset);
    }
    if (!(await hasRequiredContext(this.o.repo))) {
      throw new Error('找不到项目简介（或 docs/PROJECT_CONTEXT.md），请先填写项目简介后再开始讨论。');
    }
    await this.d().prepareStart(t, threadId, preset);
    this.d().launchTurn(t, threadId, preset);
    return this.d().getView(t);
  }

  async confirmDiscussionSend(id: unknown, service: unknown, allow: unknown): Promise<DiscussionView> {
    if (typeof service !== 'string' || !service.trim() || service.length > 200) throw new Error(VIEW_TEXT.invalidArgument);
    if (typeof allow !== 'boolean') throw new Error(VIEW_TEXT.invalidArgument);
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    if (!allow) {
      await this.d().runTurnSync(t, threadId, cur.preset, { sendConsent: { service, allow: false } });
    } else {
      this.d().launchTurn(t, threadId, cur.preset, { sendConsent: { service, allow: true } });
    }
    return this.d().getView(t);
  }

  async confirmDiscussionRequirements(id: unknown, edits: unknown): Promise<DiscussionView> {
    if (!Array.isArray(edits) || edits.length === 0 || edits.length > 50) throw new Error('请至少保留一条需求条目。');
    const parsed: { id?: string; text: string }[] = [];
    for (const raw of edits) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(VIEW_TEXT.invalidArgument);
      const item = raw as { id?: unknown; text?: unknown };
      if (item.id !== undefined && (typeof item.id !== 'string' || !/^R\d{1,3}$/.test(item.id))) {
        throw new Error(VIEW_TEXT.invalidArgument);
      }
      if (typeof item.text !== 'string') throw new Error(VIEW_TEXT.invalidArgument);
      const text = item.text.trim().slice(0, 500);
      if (text) parsed.push({ ...(item.id ? { id: item.id } : {}), text });
    }
    if (parsed.length === 0) throw new Error('确认后的需求条目不能为空，请至少保留一条。');
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    if (cur.pauseAt !== 'requirements_confirmation') throw new Error('当前不处于需求条目确认阶段。');
    this.d().launchTurn(t, threadId, cur.preset, { requirements: parsed });
    return this.d().getView(t);
  }

  async resolveDiscussionFailure(id: unknown, choice: unknown, note: unknown): Promise<DiscussionView> {
    if (choice !== 'retry' && choice !== 'retryWith' && choice !== 'stop') throw new Error(VIEW_TEXT.invalidArgument);
    if (typeof note !== 'string' || note.length > 2000) throw new Error(VIEW_TEXT.invalidArgument);
    if (choice === 'retryWith' && !note.trim()) throw new Error('请先填写补充说明再重试。');
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    if (cur.pauseAt !== 'attempt_failed') throw new Error('当前没有待处理的失败尝试。');
    if (choice === 'stop') {
      await this.d().runTurnSync(t, threadId, cur.preset, { attemptFailure: 'stop' });
    } else {
      this.d().launchTurn(t, threadId, cur.preset, {
        attemptFailure: choice === 'retryWith' ? { retryWith: note.trim() } : 'retry',
      });
    }
    return this.d().getView(t);
  }

  async adjudicateDiscussion(
    id: unknown,
    kind: unknown,
    key: unknown,
    decision: unknown,
    reason: unknown,
  ): Promise<DiscussionView> {
    if (kind !== 'finding' && kind !== 'scope') throw new Error(VIEW_TEXT.invalidArgument);
    if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(key)) throw new Error(VIEW_TEXT.invalidArgument);
    if (decision !== 'accept' && decision !== 'reject') throw new Error(VIEW_TEXT.invalidArgument);
    if (typeof reason !== 'string' || reason.length > 1000) throw new Error(VIEW_TEXT.invalidArgument);
    const trimmed = reason.trim();
    if (decision === 'reject' && !trimmed) throw new Error('驳回意见必须写一句理由。');
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    if (cur.state !== 'awaiting_approval') throw new Error('当前不处于意见裁决阶段。');
    await this.d().runTurnSync(t, threadId, cur.preset, {
      adjudication: { kind, key, decision, reason: trimmed || '确认接受' },
    });
    return this.d().getView(t);
  }

  async decideDiscussionApproval(id: unknown, decision: unknown): Promise<{ view: DiscussionView; task: TaskView }> {
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'stop') throw new Error(VIEW_TEXT.invalidArgument);
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (!['draft', 'clarifying'].includes(t.state)) throw new Error('只有讨论中的任务才能执行方案批准操作。');
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    if (cur.state !== 'awaiting_approval') throw new Error('当前尚未到达方案批准节点。');
    const outcome = await this.d().runTurnSync(t, threadId, cur.preset, { approval: decision });
    if (outcome.kind === 'approved') {
      const payload = await this.d().readApprovedPayload(threadId);
      const converted = convertApprovedPlanToTaskPlan(payload);
      const mode = await this.preferredMode();
      await this.r().applyApprovedDiscussion(t.id, {
        goal: converted.goal,
        criteria: converted.criteria,
        rejectedRisks: converted.rejectedRisks,
        planUnreviewed: converted.single,
        approvedPlanPath: converted.planPath,
        capabilities: resolveCapabilities({ constructionMode: mode, externalNetwork: 'off', extraWritableDirs: [] }),
      });
    }
    const updatedTask = await this.load(t.id);
    return { view: await this.d().getView(updatedTask), task: await this.view(updatedTask) };
  }

  async modifyDiscussionRequirements(id: unknown, newRequest: unknown): Promise<TaskView> {
    if (typeof newRequest !== 'string' || !newRequest.trim()) throw new Error('修改后的需求不能为空。');
    if (newRequest.length > 4000) throw new Error('需求太长了，请精简到 4000 字以内。');
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (!['draft', 'clarifying'].includes(t.state)) throw new Error('只有讨论中的任务才能修改需求并重开讨论。');
    const threadId = await this.ensureTaskThread(t);
    const cur = await this.d().getView(t);
    await this.d().stopThread(t.id, threadId, '用户修改需求，终止当前线程并以修改后的需求重新开始');
    await this.r().discard(t.id);

    const nextTask = await this.r().create(newRequest.trim());
    const nextThreadId = await this.d().ensureBoundThread(nextTask, cur.preset);
    const bound = await this.r().bindThread(nextTask.id, nextThreadId);
    return this.view(bound);
  }

  async sendDiscussionChat(id: unknown, target: unknown, message: unknown): Promise<DiscussionView> {
    if (target !== 'planner' && target !== 'reviewer') throw new Error(VIEW_TEXT.invalidArgument);
    if (typeof message !== 'string' || !message.trim()) throw new Error('请输入要发送的对话内容。');
    if (message.length > 2000) throw new Error('单次对话内容请控制到 2000 字以内。');
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (!['draft', 'clarifying'].includes(t.state)) throw new Error('只有讨论中的任务才能向思考者提问。');
    await this.ensureTaskThread(t);
    return this.d().sendChat(t, target, message);
  }

  async skipDiscussion(id: unknown): Promise<TaskView> {
    const tid = this.checkArg(TASK_ID, id);
    const t = await this.load(tid);
    if (t.manualReview) throw new Error(MESSAGES.abnormal);
    if (t.state !== 'draft' && t.state !== 'clarifying') throw new Error('只有尚未进入施工计划的任务才能跳过讨论。');
    if (this.d().isRunning(t.id)) throw new Error('思考者正在运行，请稍候再跳过。');
    if (t.threadId) {
      await this.d().stopThread(t.id, t.threadId, '用户跳过讨论，直接填写施工计划');
    }
    const mode = await this.preferredMode();
    const caps = resolveCapabilities({ constructionMode: mode, externalNetwork: 'off', extraWritableDirs: [] });
    const planned = await this.r().setPlan(t.id, {
      goal: t.request,
      inScope: [],
      outOfScope: [],
      criteria: [],
      risks: [],
      irreversible: [],
      capabilities: caps,
    });
    return this.view(planned);
  }
}

const TASK_ID = /^[a-z0-9-]{1,64}$/;

/** 验收阶段各操作的返回：ok、固定文案、需要先处理的文件（相对路径）、保存结果视图、刷新后的视图 */
export interface AcceptanceActionResult {
  ok: boolean;
  message: string;
  files?: string[];
  saveOutcome?: SaveOutcomeView;
  view: UserAcceptanceView;
}
