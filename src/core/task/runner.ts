import { EventEmitter } from 'node:events';
import * as G from '../git/git.js';
import { next, type TaskEvent } from './state.js';
import { TaskStore } from './store.js';
import { resolveCapabilities, type Capabilities } from '../capabilities/model.js';
import type { Plan, Task, TimelineEntry } from './model.js';
import type { Decision, Executor, ExecutorRun, PermissionRequest } from '../executor/types.js';
import { assess, canAutoApprove, type AutoApproveRule, type RiskAssessment } from '../policy/risk.js';
import { runCheck, scriptsDigest, type CheckResult, type SandboxCommandRunner } from '../checks/scripts.js';
import { buildCard } from '../acceptance/card.js';
import { validateExtraDir } from '../executor/extra-dirs.js';

export interface PendingPermission {
  taskId: string;
  request: PermissionRequest;
  risk: RiskAssessment;
}

export interface RunnerOptions {
  repo: string;
  executor: Executor;
  autoApprove?: AutoApproveRule;
  timeoutMs?: number;
  /** 测试中可关闭检查 */
  runChecks?: boolean;
  /**
   * 运行项目脚本（build/test）的沙箱运行器。缺省使用执行体自带的（Codex：command/exec，与施工同一权限配置档）；
   * 两者都没有时，检查结果为“未检查”，绝不在宿主上直接运行。
   */
  sandboxRunner?: SandboxCommandRunner;
}

/**
 * 任务编排器：把状态机、Git 隔离、执行体、权限策略、检查、验收卡串起来。
 * 事件：'update'(task) / 'permission'(PendingPermission)
 */
export class TaskRunner extends EventEmitter {
  readonly store: TaskStore;
  private runs = new Map<string, ExecutorRun>();
  /** start() 已进入、尚未结束的任务；停止请求只要落在这个窗口内就必须生效。 */
  private starting = new Set<string>();
  /** 在执行体登记之前收到的停止请求 */
  private stopRequested = new Set<string>();

  constructor(private readonly opts: RunnerOptions) {
    super();
    this.store = new TaskStore(opts.repo);
  }

  private log(task: Task, kind: TimelineEntry['kind'], text: string, source?: 'host') {
    task.timeline.push({ at: new Date().toISOString(), kind, text, ...(source ? { source } : {}) });
  }

  private async fire(task: Task, ev: TaskEvent) {
    const from = task.state;
    task.state = next(task.state, ev);
    this.log(task, 'state', `${from} → ${task.state}`);
    await this.persist(task);
  }

  private async persist(task: Task) {
    await this.store.save(task);
    this.emit('update', structuredClone(task));
  }

  private async load(id: string): Promise<Task> {
    const t = await this.store.get(id);
    if (!t) throw new Error(`找不到任务 ${id}`);
    // 兼容旧版本保存的任务
    t.denied ??= [];
    t.deniedAcks ??= t.denied.map(() => false);
    return t;
  }

  async create(request: string): Promise<Task> {
    if (!(await G.isRepo(this.opts.repo))) throw new Error('项目还不是 Git 仓库，请先在向导中初始化。');
    const now = new Date().toISOString();
    const task: Task = {
      id: TaskStore.newId(),
      request,
      state: 'draft',
      criteria: [],
      denied: [],
      deniedAcks: [],
      previewed: false,
      timeline: [],
      createdAt: now,
      updatedAt: now,
    };
    this.log(task, 'state', '创建任务');
    await this.persist(task);
    return task;
  }

  async setPlan(id: string, input: Omit<Plan, 'capabilities'> & { capabilities?: Partial<Capabilities> }): Promise<Task> {
    const t = await this.load(id);
    const capabilities = resolveCapabilities(input.capabilities);
    // 额外可写目录的完整校验（存在、是目录、真实路径同样合规、不在 .studio 内、不含项目本身）；通过后保存真实路径
    const dirs: string[] = [];
    for (const d of capabilities.extraWritableDirs) {
      const r = await validateExtraDir(d, { repo: this.opts.repo });
      if (!r.ok) throw new Error(`不能让 AI 修改“${d}”：${r.reason}`);
      dirs.push(r.dir);
    }
    const plan: Plan = { ...input, capabilities: { ...capabilities, extraWritableDirs: [...new Set(dirs)] } };
    t.plan = plan;
    delete t.fullTrustConfirmedAt; // 确认只对“被批准的那一版计划”有效：计划一改就必须重新确认
    t.criteria = plan.criteria.map((text) => ({ text }));
    await this.fire(t, t.state === 'draft' || t.state === 'clarifying' ? 'plan' : 'edit_plan');
    return t;
  }

  async approve(id: string): Promise<Task> {
    const t = await this.load(id);
    if (!t.plan) throw new Error('没有计划，不能批准。');
    // 批准同时授权“将运行的脚本”：记录当前 package.json 中 build/test（含 pre/post）脚本的内容摘要；
    // 之后脚本内容变化（包括被 AI 改动）则授权失效，对应检查标“未检查”。
    const digest = await scriptsDigest(this.opts.repo);
    if (digest) t.checkAuth = { digest, at: new Date().toISOString() };
    else delete t.checkAuth;
    await this.fire(t, 'approve');
    return t;
  }

  /**
   * 本任务的完全信任确认（每个任务单独确认；只有计划声明了完全信任模式、且已批准的任务才能确认）。
   * 确认标记写进任务记录，是门禁函数 requireFullTrustConfirmed 读取的唯一依据。
   */
  async confirmFullTrust(id: string): Promise<Task> {
    const t = await this.load(id);
    if (t.plan?.capabilities.constructionMode !== 'full_trust') throw new Error('这个任务的计划没有选择完全信任模式。');
    if (t.state !== 'approved') throw new Error('任务必须先经你批准，才能确认完全信任。');
    t.fullTrustConfirmedAt = new Date().toISOString();
    this.log(t, 'message', '你已确认：本任务以完全信任模式运行。');
    await this.persist(t);
    return t;
  }

  /** 开工（或在验收后发起修复）。返回时执行已结束并生成验收卡。 */
  async start(id: string, prompt?: string): Promise<Task> {
    // 必须同步登记：之后任何 await 的间隙里到来的 stop() 都能被看到
    this.starting.add(id);
    this.stopRequested.delete(id);
    try {
      return await this.runTask(id, prompt);
    } finally {
      this.starting.delete(id);
      this.stopRequested.delete(id);
    }
  }

  private async runTask(id: string, prompt?: string): Promise<Task> {
    const t = await this.load(id);
    if (t.state !== 'approved') throw new Error('任务必须先经你批准才能开工。');
    // 完全信任：本任务没有确认标记就不开工（核心层门禁；执行体适配器里还有第二道 requireFullTrustConfirmed）
    if (t.plan?.capabilities.constructionMode === 'full_trust' && !t.fullTrustConfirmedAt) throw new Error('这个任务选择了完全信任模式，必须先确认风险才能开工。');
    if (!t.worktree) t.worktree = await G.createWorktree(this.opts.repo, t.id);
    // 开工前再校验一次额外目录：这时已经知道任务副本的位置
    for (const d of t.plan?.capabilities.extraWritableDirs ?? []) {
      const r = await validateExtraDir(d, { repo: this.opts.repo, worktree: t.worktree.path });
      if (!r.ok) throw new Error(`不能让 AI 修改“${d}”：${r.reason}`);
    }
    t.executorId = this.opts.executor.id;
    // 报告绑定 Git 状态：记录开始时的主线 HEAD、工作树路径与其 HEAD
    t.gitStart = {
      mainHeadAtStart: await G.headSha(this.opts.repo),
      worktreeHeadAtStart: await G.headSha(t.worktree.path),
      worktreePath: t.worktree.path,
    };
    delete t.gitBinding;
    await this.fire(t, 'start');

    // 准备阶段收到停止：不启动执行体，直接进入 stopped 并照常验收
    if (this.stopRequested.has(id)) {
      this.log(t, 'message', '准备阶段收到停止请求，未启动 AI。');
      t.exit = { kind: 'stopped' };
      await this.fire(t, 'stop');
      return this.review(t);
    }

    delete t.effectivePermissions; // 每次开工重新记录实际生效的权限，不沿用上一次
    const run = this.opts.executor.start({
      cwd: t.worktree.path,
      prompt: prompt ?? buildPrompt(t),
      timeoutMs: this.opts.timeoutMs ?? 20 * 60_000,
      capabilities: t.plan?.capabilities ?? resolveCapabilities(),
      taskId: t.id,
      fullTrustRecords: this.store,
    });
    this.runs.set(t.id, run);
    // 执行体启动期间（或启动的同一时刻）到来的停止请求：登记后立刻补发给执行体
    if (this.stopRequested.has(id)) await run.stop();
    const rule = this.opts.autoApprove ?? { autoLow: false };

    for await (const ev of run.events) {
      if (ev.type === 'message') this.log(t, 'message', ev.text, ev.source);
      else if (ev.type === 'isolation') {
        if (ev.info.permissions) t.effectivePermissions = ev.info.permissions; // 以启动后核验得到的实际生效权限为准
        this.log(t, 'isolation', `隔离已核验：审批=${ev.info.approvalPolicy}，沙箱=${ev.info.sandbox}，模型=${ev.info.model ?? '未知'}，授予的 MCP=${ev.info.grantedMcp.join('、') || '无'}，指令来源=${ev.info.instructionSources.join('、') || '无'}${ev.info.permissions ? `；权限：${ev.info.permissions.summary}` : ''}${ev.info.warnings.length ? `；警告：${ev.info.warnings.join('；')}` : ''}`);
      }
      else if (ev.type === 'tool') this.log(t, 'tool', `${ev.name}: ${ev.summary}`);
      else if (ev.type === 'permission_request') {
        const risk = assess(ev.request, t.worktree.path);
        if (canAutoApprove(risk, rule)) {
          this.log(t, 'permission', `自动允许（低风险）：${ev.request.description}`);
          await run.respond(ev.request.id, 'allow');
        } else {
          this.log(t, 'permission', `等待你决定：${ev.request.description}`);
          this.emit('permission', { taskId: t.id, request: ev.request, risk } satisfies PendingPermission);
        }
      } else if (ev.type === 'exit') {
        t.exit = ev.outcome;
        t.denied = ev.denied ?? [];
        t.deniedAcks = t.denied.map(() => false);
      }
      await this.persist(t);
    }
    this.runs.delete(t.id);

    const o = t.exit ?? { kind: 'spawn_error', message: '执行体未报告结束状态' };
    t.exit = o;
    const ev: TaskEvent =
      o.kind === 'exited' ? (o.code === 0 ? 'exec_exit_ok' : 'exec_exit_fail') : o.kind === 'stopped' ? 'stop' : o.kind === 'timed_out' ? 'timeout' : 'exec_exit_fail';
    await this.fire(t, ev);
    return this.review(t);
  }

  async respond(id: string, requestId: string, decision: Decision): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error('该任务当前没有在执行。');
    await run.respond(requestId, decision);
  }

  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (run) await run.stop();
    else if (this.starting.has(id)) this.stopRequested.add(id);
  }

  private async review(t: Task): Promise<Task> {
    const wt = t.worktree!;
    const changes = await G.diffSummary(wt);
    const start = t.gitStart ?? { mainHeadAtStart: await G.headSha(this.opts.repo), worktreeHeadAtStart: await G.headSha(wt.path), worktreePath: wt.path };
    t.gitBinding = { ...start, mainHeadAtEnd: await G.headSha(this.opts.repo), worktreeHeadAtEnd: await G.headSha(wt.path) };
    this.log(t, 'state', `Git：主线 ${t.gitBinding.mainHeadAtStart.slice(0, 8)}→${t.gitBinding.mainHeadAtEnd.slice(0, 8)}，工作树 ${t.gitBinding.worktreeHeadAtStart.slice(0, 8)}→${t.gitBinding.worktreeHeadAtEnd.slice(0, 8)}`);
    const checks: CheckResult[] = [];
    if (this.opts.runChecks !== false) {
      for (const name of ['build', 'test'] as const) {
        const c = await runCheck(wt.path, name, this.opts.sandboxRunner ?? this.opts.executor.sandboxRunner, {
          authorizedDigest: t.checkAuth?.digest,
          ...(t.plan?.capabilities ? { capabilities: t.plan.capabilities } : {}),
          taskId: t.id,
          fullTrustRecords: this.store,
        });
        this.log(t, 'check', `${name}: ${c.status}`);
        checks.push(c);
      }
    }
    t.card = buildCard({ exit: t.exit!, changes, checks, criteria: t.criteria, previewed: t.previewed, denied: t.denied, deniedAcks: t.deniedAcks, git: t.gitBinding });
    await this.fire(t, 'review');
    return t;
  }

  /** 用户对验收标准逐条确认/否决，或标记已试用。只改用户输入，不改自动检查结果。 */
  async confirm(id: string, update: { criterion?: number; decision?: 'confirmed' | 'rejected'; previewed?: boolean; deniedAck?: number }) {
    const t = await this.load(id);
    if (t.state !== 'reviewing' || !t.card) throw new Error('任务不在验收阶段。');
    if (update.criterion !== undefined) {
      const c = t.criteria[update.criterion];
      if (!c || !update.decision) throw new Error('无效的验收标准。');
      c.decision = update.decision;
    }
    if (update.previewed !== undefined) t.previewed = update.previewed;
    if (update.deniedAck !== undefined) {
      if (!t.denied[update.deniedAck]) throw new Error('无效的被拒绝操作。');
      t.deniedAcks[update.deniedAck] = true;
    }
    const prev = t.card;
    const auto = prev.items.filter((i) => ['build', 'test'].includes(i.key));
    const checks: CheckResult[] = auto.map((i) =>
      i.status === 'not_checked'
        ? { name: i.key as 'build' | 'test', status: 'not_available', reason: i.evidence }
        : { name: i.key as 'build' | 'test', status: i.status === 'verified' ? 'passed' : 'failed', outcome: { kind: 'exited', code: i.status === 'verified' ? 0 : 1 }, output: '', durationMs: 0 },
    );
    t.card = buildCard({ exit: t.exit!, changes: prev.changes, checks, criteria: t.criteria, previewed: t.previewed, denied: t.denied, deniedAcks: t.deniedAcks, ...(t.gitBinding ? { git: t.gitBinding } : {}) });
    // 保留原始检查的证据文字
    for (const item of t.card.items) {
      const old = prev.items.find((i) => i.key === item.key);
      if (old && (item.key === 'build' || item.key === 'test')) item.evidence = old.evidence;
    }
    await this.persist(t);
    return t;
  }

  async requestFix(id: string, instruction: string): Promise<Task> {
    const t = await this.load(id);
    t.criteria.forEach((c) => delete c.decision);
    t.previewed = false;
    delete t.card;
    delete t.exit;
    t.denied = [];
    t.deniedAcks = [];
    this.log(t, 'message', `你要求修改：${instruction}`);
    await this.fire(t, 'request_fix'); // fire 会持久化，必须在清空之后
    return this.start(id, `${buildPrompt(t)}\n\n上一次结果需要修改：${instruction}`);
  }

  async save(id: string): Promise<{ ok: true; task: Task } | { ok: false; reason: string; detail: string }> {
    const t = await this.load(id);
    if (t.state !== 'reviewing' || !t.card?.readyToSave) {
      return { ok: false, reason: 'not_ready', detail: '还有检查未通过或验收标准未确认。' };
    }
    const wt = t.worktree!;
    await G.commitWorktree(wt, `studio: ${t.plan?.goal ?? t.request}`);
    const r = await G.mergeTask(this.opts.repo, wt, `studio: 保存「${t.plan?.goal ?? t.request}」`);
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    await G.removeWorktree(this.opts.repo, wt);
    await this.fire(t, 'save');
    return { ok: true, task: t };
  }

  async discard(id: string): Promise<Task> {
    const t = await this.load(id);
    if (this.runs.has(id)) throw new Error('请先停止正在执行的任务。');
    if (t.worktree) await G.removeWorktree(this.opts.repo, t.worktree);
    await this.fire(t, 'discard');
    return t;
  }
}

export function buildPrompt(t: Task): string {
  const p = t.plan;
  if (!p) return t.request;
  const list = (title: string, xs: string[]) => (xs.length ? `\n${title}：\n${xs.map((x) => `- ${x}`).join('\n')}` : '');
  return [
    `用户需求：${t.request}`,
    `目标：${p.goal}`,
    list('要做', p.inScope),
    list('不要做', p.outOfScope),
    list('验收标准', p.criteria),
    '\n只在当前目录内修改文件。不要提交 Git、不要推送、不要修改当前目录以外的任何文件。不要读取或列出当前目录以外的任何文件或目录。',
  ].join('\n');
}
