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

  /** 懒创建：第一次真正用到任务功能时才取得执行体 */
  private r(): TaskRunner {
    this.runner ??= new TaskRunner({ repo: this.o.repo, executor: this.o.makeExecutor() });
    return this.runner;
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
    const t = await this.r().store.get(id);
    if (!t) throw new Error('找不到这个任务。');
    return t;
  }

  async preferredMode(): Promise<ModePreference> {
    return this.o.prefs.getMode(this.o.repo);
  }

  async list(): Promise<{ tasks: TaskView[]; preferredMode: ModePreference }> {
    const tasks = await this.r().store.list();
    return { tasks: await Promise.all(tasks.map((t) => this.view(t))), preferredMode: await this.preferredMode() };
  }

  async create(request: unknown): Promise<TaskView> {
    if (typeof request !== 'string' || !request.trim()) throw new Error('请先写下你想让 AI 做什么。');
    if (request.length > 4000) throw new Error('需求太长了，请精简到 4000 字以内。');
    return this.view(await this.r().create(request.trim()));
  }

  async get(id: unknown): Promise<TaskView> {
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
      .catch((e: Error) => this.startErrors.set(t.id, e.message))
      .finally(() => this.active.delete(t.id));
    return this.view(t);
  }

  async stop(id: unknown): Promise<TaskView> {
    const t = await this.load(id);
    await this.r().stop(t.id);
    return this.view((await this.r().store.get(t.id)) ?? t);
  }
}
