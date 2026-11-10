import fs from 'node:fs';
import path from 'node:path';
import { StaleRunError, StateConflictError, WriterLockedError, type OpenOptions } from '../persistence/index.js';
import * as G from '../git/git.js';
import { GitError } from '../git/git.js';
import { MESSAGES } from '../task/messages.js';
import { buildPreviews } from '../acceptance/snippets.js';
import { acceptanceVersion, isVersionFormat, mapFailure, okMessage, toUserView, VIEW_TEXT, type UserAcceptanceView, type ViewContext } from '../acceptance/view.js';
import { TaskRunner } from '../task/runner.js';
import { detectScripts } from '../checks/scripts.js';
import { resolveCapabilities } from '../capabilities/model.js';
import { validateExtraDir } from '../executor/extra-dirs.js';
import type { Executor } from '../executor/types.js';
import type { Task } from '../task/model.js';
import { buildTaskView, extraDirKey, type TaskView } from './task-view.js';
import type { ModePreference, TaskPrefs } from './prefs.js';

export interface PlanInput {
  goal: string;
  criteria: string[];
  mode: ModePreference;
  network: boolean;
}

export interface AddDirResult {
  view: TaskView;
  /** 用户在选择框里点了取消 */
  cancelled: boolean;
  /** 校验没通过的中文原因 */
  rejected: string | null;
}

export interface ControllerOptions {
  repo: string;
  /** 每个任务开工时用它取得执行体（主进程里是 Codex；测试里是 FakeExecutor） */
  makeExecutor: () => Executor;
  /** 系统文件夹选择框（只有主进程能弹；渲染进程拿不到路径参数的入口） */
  pickDirectory: () => Promise<string | null>;
  prefs: TaskPrefs;
  /** 记录库的打开选项（主进程里传入：数据目录所在卷检查、租约等待） */
  storeOptions?: OpenOptions;
  /** 外部打开预览的回调（主进程中调用 Electron shell；测试中可注入模拟） */
  openPreview?: (target: { kind: 'web' | 'finder'; targetPath: string }) => Promise<void>;
}

const EDITABLE = ['draft', 'clarifying', 'planned', 'approved'];

/**
 * 任务界面与核心之间的控制层（纯 Node，可独立测试）。
 * 渲染进程只会传：任务编号、需求文字、计划表单、布尔确认；路径一律由这里经系统选择框取得并校验。
 */
export class TaskController {
  private runner: TaskRunner | undefined;
  private readonly active = new Set<string>();
  private readonly startErrors = new Map<string, string>();

  constructor(private readonly o: ControllerOptions) {}

  get repoPath(): string {
    return this.o.repo;
  }

  /** 懒创建：第一次真正用到任务功能时才取得执行体 */
  private r(): TaskRunner {
    this.runner ??= new TaskRunner({ repo: this.o.repo, executor: this.o.makeExecutor(), ...(this.o.storeOptions ? { storeOptions: this.o.storeOptions } : {}) });
    return this.runner;
  }

  /** 打开并取得本项目的持久化存储实例（取得 APFS/目录锁并完成存储对账）。 */
  openRecordStore() {
    return this.r().store.recordStore();
  }

  isTaskActive(id: string): boolean {
    return this.active.has(id) || this.ops.has(id);
  }

  async listTasksRaw(): Promise<Task[]> {
    await this.ready();
    return this.r().store.list();
  }

  /** 是否仍有任务在施工、启停或保存/撤销/放弃等独占操作中。 */
  async hasRunningTasks(): Promise<boolean> {
    if (this.active.size > 0 || this.ops.size > 0) return true;
    await this.ready();
    const tasks = await this.r().store.list();
    return tasks.some((t) => t.state === 'running' || this.r().isBusy(t.id));
  }

  private async view(t: Task): Promise<TaskView> {
    const scripts = Object.keys(await detectScripts(this.o.repo)) as ('build' | 'test')[];
    const v = buildTaskView(t, { scripts, running: this.active.has(t.id) || t.state === 'running' });
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
    return this.view(await this.r().create(request.trim()));
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
  private async acceptanceView(t: Task): Promise<UserAcceptanceView> {
    const runner = this.r();
    const busy = this.active.has(t.id) || this.ops.has(t.id) || runner.isBusy(t.id);
    const ctx: ViewContext = { busy };
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

  private async result(id: string, r: { ok: boolean; message: string; files?: string[] | undefined }): Promise<AcceptanceActionResult> {
    const t = await this.load(id);
    return { ok: r.ok, message: r.message, ...(r.files?.length ? { files: r.files } : {}), view: await this.acceptanceView(t) };
  }

  /**
   * 执行一个会改动任务的操作：同步登记（重复点击 → busy）→ 异常写诊断并返回固定文案 → 返回刷新后的视图。
   * 异常状态（需要人工查看）的任务一律不接受写操作。
   */
  private async act(id: string, work: (t: Task) => Promise<{ ok: boolean; message: string; files?: string[] | undefined }>): Promise<AcceptanceActionResult> {
    await this.ready();
    if (this.ops.has(id) || this.r().isBusy(id)) return this.result(id, { ok: false, message: MESSAGES.busy });
    this.ops.add(id);
    let outcome: { ok: boolean; message: string; files?: string[] | undefined };
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
      if (v !== acceptanceVersion(t)) return { ok: false, message: MESSAGES.acceptanceInvalid };
      const r = await this.r().save(t.id, confirmUnchecked ? { confirmUnchecked: true } : undefined);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
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
      const r = await this.r().discard(t.id);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
    });
  }

  async undoSave(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      const r = await this.r().undo(t.id);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
    });
  }

  async retryCleanup(id: unknown): Promise<AcceptanceActionResult> {
    const tid = this.checkArg(TASK_ID, id);
    await this.load(tid);
    return this.act(tid, async (t) => {
      const r = await this.r().retryCleanup(t.id);
      return r.ok ? { ok: true, message: okMessage(r.task) } : { ok: false, ...mapFailure(r) };
    });
  }
}

const TASK_ID = /^[a-z0-9-]{1,64}$/;

/** 验收阶段各操作的返回：ok、固定文案、需要先处理的文件（相对路径）、刷新后的视图 */
export interface AcceptanceActionResult {
  ok: boolean;
  message: string;
  files?: string[];
  view: UserAcceptanceView;
}
