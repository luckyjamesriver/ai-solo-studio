import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import * as G from '../git/git.js';
import { next, canFire, type TaskEvent } from './state.js';
import { MESSAGES } from './messages.js';
import { saveBlockers } from './save-rules.js';
import { TaskStore, type SaveOptions } from './store.js';
import { RecordStore, StaleRunError, type OpenOptions } from '../persistence/index.js';
import { resolveCapabilities, type Capabilities } from '../capabilities/model.js';
import type { OpLog, Plan, Task, TimelineEntry } from './model.js';
import type { Decision, Executor, ExecutorRun, PermissionRequest } from '../executor/types.js';
import { assess, canAutoApprove, type AutoApproveRule, type RiskAssessment } from '../policy/risk.js';
import { runCheck, runProjectChecks, scriptsDigest, type CheckName, type CheckResult, type ProjectChecksOutcome, type SandboxCommandRunner } from '../checks/scripts.js';
import { buildCard, blockedCard } from '../acceptance/card.js';
import { validateExtraDir } from '../executor/extra-dirs.js';
import { recordProcess, verifyNoLiveExecutor, type ProcessProbe } from './process-check.js';

export type OpFailReason =
  | 'busy'
  | 'not_ready'
  | 'not_allowed'
  | 'repo_changed'
  | 'branch_changed'
  | 'dirty_main'
  | 'external_driver'
  | 'acceptance_invalid'
  | 'conflict'
  | 'checks_failed'
  | 'project_changed'
  | 'failed_restored'
  | 'abnormal'
  | 'undo_refused'
  | 'cleanup_pending'
  | 'failed';

/** 保存 / 撤销 / 重试清理的失败返回：detail 是给用户看的中文原因（核心层文案常量），files 是相关文件清单 */
export interface OpFail {
  ok: false;
  reason: OpFailReason;
  detail: string;
  files?: string[];
  /** checks_failed 时未通过的检查项 */
  failedChecks?: CheckName[];
}
export type SaveResult = { ok: true; task: Task; message: string; cleanup: G.CleanupResult; checked: boolean } | OpFail;
export type DiscardResult = { ok: true; task: Task; message: string; cleanup: G.CleanupResult } | OpFail;
export type UndoResult = { ok: true; task: Task; message: string } | OpFail;
export type RetryCleanupResult = { ok: true; task: Task; message: string; cleanup: G.CleanupResult } | OpFail;

export interface ReconcileEntry {
  taskId: string;
  action: string;
}

/** 启动核对第一步（只读识别）的结果 */
export type ReconcileFinding =
  | { kind: 'idle' }
  | { kind: 'cleanup_gone' }
  | { kind: 'save_merged'; merged: string; phase?: OpLog['phase'] }
  | { kind: 'save_not_merged'; phase?: OpLog['phase'] }
  | { kind: 'discard_resume' }
  | { kind: 'undo_not_happened' }
  | { kind: 'undo_done'; head: string }
  | { kind: 'manual'; reason: string }
  /** 任务记录还停在“施工中”，但本进程没有这次运行（应用退出或崩溃过）：需要换掉运行编号、按失败收尾 */
  | { kind: 'run_interrupted' };

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
  /** 启动核对用的进程探测（测试里可替换；缺省探测真实进程） */
  processProbe?: ProcessProbe;
  /** 记录库的打开选项（数据目录所在卷检查、租约等待时间；主进程里传入，测试里缺省） */
  storeOptions?: OpenOptions;
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
    this.store = new TaskStore(opts.repo, opts.storeOptions);
  }

  private log(task: Task, kind: TimelineEntry['kind'], text: string, source?: 'host') {
    task.timeline.push({ at: new Date().toISOString(), kind, text, ...(source ? { source } : {}) });
  }

  private async fire(task: Task, ev: TaskEvent, opts?: SaveOptions) {
    const from = task.state;
    task.state = next(task.state, ev);
    this.log(task, 'state', `${from} → ${task.state}`);
    await this.persist(task, opts);
  }

  /** 提交任务记录（带修订号 CAS 与运行编号校验）：冲突或运行过期会抛出 StateConflictError / StaleRunError，绝不静默覆盖 */
  private async persist(task: Task, opts?: SaveOptions) {
    await this.store.save(task, opts);
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
      executorId: this.opts.executor.id,
      executorName: this.opts.executor.displayName,
      criteria: [],
      denied: [],
      deniedAcks: [],
      previewed: false,
      previewSkipped: false,
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
    } catch (e) {
      if (e instanceof StaleRunError) return this.load(id); // 本次运行已被取代，不改任何东西
      throw e;
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
    if (!t.worktree) {
      // 创建副本（checkout）本身会触发 smudge 驱动：必须先确认项目没有使用外部驱动
      const drivers = await G.detectExternalDrivers(this.opts.repo);
      if (!drivers.supported) throw new Error(`${MESSAGES.externalDriver}（${drivers.drivers.join('；')}）`);
      t.worktree = await G.createWorktree(this.opts.repo, t.id);
    }
    // 绑定开工时的仓库路径、分支名、基线 HEAD（只记录一次，之后的修复轮次不改）
    t.binding ??= { repoPath: await fs.realpath(this.opts.repo), branch: await G.currentBranch(this.opts.repo), baseHead: t.worktree.baseSha };
    // 开工前再校验一次额外目录：这时已经知道任务副本的位置
    for (const d of t.plan?.capabilities.extraWritableDirs ?? []) {
      const r = await validateExtraDir(d, { repo: this.opts.repo, worktree: t.worktree.path });
      if (!r.ok) throw new Error(`不能让 AI 修改“${d}”：${r.reason}`);
    }
    t.executorId = this.opts.executor.id;
    t.executorName = this.opts.executor.displayName;
    // 报告绑定 Git 状态：记录开始时的主线 HEAD、工作树路径与其 HEAD
    t.gitStart = {
      mainHeadAtStart: await G.headSha(this.opts.repo),
      worktreeHeadAtStart: await G.headSha(t.worktree.path),
      worktreePath: t.worktree.path,
    };
    delete t.gitBinding;
    t.runId = RecordStore.newRunId(); // 每次开工是新的一次运行：之后旧运行的任何回传都会被拒绝
    await this.fire(t, 'start', { startRun: true });

    // 准备阶段收到停止：不启动执行体，直接进入 stopped 并照常验收
    if (this.stopRequested.has(id)) {
      this.log(t, 'message', '准备阶段收到停止请求，未启动 AI。');
      t.exit = { kind: 'stopped' };
      await this.fire(t, 'stop');
      return this.review(t);
    }

    delete t.effectivePermissions; // 每次开工重新记录实际生效的权限，不沿用上一次
    delete t.execProc;
    t.isolationWarnings = [];
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
      // 执行体进程一旦启动就记下它的进程号与可执行文件名，供启动核对判断它是否仍在运行
      if (!t.execProc && run.pid) t.execProc = await recordProcess(run.pid, this.opts.processProbe);
      if (ev.type === 'message') this.log(t, 'message', ev.text, ev.source);
      else if (ev.type === 'isolation') {
        if (ev.info.permissions) t.effectivePermissions = ev.info.permissions; // 以启动后核验得到的实际生效权限为准
        t.isolationWarnings = [...(t.isolationWarnings ?? []), ...ev.info.warnings];
        if (ev.info.model) t.model = ev.info.model;
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
      try {
        await this.persist(t);
      } catch (e) {
        if (!(e instanceof StaleRunError)) throw e;
        // 这次运行已被取代（任务已经重新开工）：不能再写入，停掉它
        await run.stop().catch(() => undefined);
        this.runs.delete(t.id);
        return t;
      }
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

  private cardNotes(t: Task): string[] {
    return t.customCommitChecks ? [MESSAGES.skippedCommitChecks] : [];
  }

  /**
   * 生成验收证据（验收卡、冻结的验收内容）。顺序很重要：
   * 先检测外部驱动（命中则不读取任何内容、不运行检查）→ 算 tree（冻结）→ 跑检查 → 再算 tree；
   * 检查改动了文件则检查结果作废，并把检查之后的内容作为新的验收内容（改动清单如实列出，用户看到的就是将要保存的）。
   */
  private async buildEvidence(t: Task): Promise<void> {
    const wt = t.worktree!;
    const repo = this.opts.repo;
    const start = t.gitStart ?? { mainHeadAtStart: await G.headSha(repo), worktreeHeadAtStart: await G.headSha(wt.path), worktreePath: wt.path };
    t.gitBinding = { ...start, mainHeadAtEnd: await G.headSha(repo), worktreeHeadAtEnd: await G.headSha(wt.path) };
    this.log(t, 'state', `Git：主线 ${t.gitBinding.mainHeadAtStart.slice(0, 8)}→${t.gitBinding.mainHeadAtEnd.slice(0, 8)}，工作树 ${t.gitBinding.worktreeHeadAtStart.slice(0, 8)}→${t.gitBinding.worktreeHeadAtEnd.slice(0, 8)}`);
    delete t.acceptedTree;
    delete t.checksVoid;
    t.acceptanceRev = (t.acceptanceRev ?? 0) + 1; // 每次生成验收证据（含重新检查）版本加一：旧版本的确认请求一律作废

    let drivers = await G.detectExternalDrivers(wt.path);
    if (drivers.supported) drivers = await G.detectExternalDrivers(repo);
    if (!drivers.supported) {
      this.log(t, 'error', `${drivers.reason}：${drivers.drivers.join('；')}`, 'host');
      t.card = blockedCard(drivers.reason, drivers.drivers, t.gitBinding);
      return;
    }
    t.customCommitChecks = await G.hasCustomCommitChecks(repo);

    let changes = await G.diffSummary(wt);
    const tree1 = await G.computeTree(repo, wt.path);
    let checks: CheckResult[] = [];
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
    let tree = tree1;
    if (checks.length) {
      const tree2 = await G.computeTree(repo, wt.path);
      if (tree2 !== tree1) {
        t.checksVoid = MESSAGES.checksModified;
        this.log(t, 'check', MESSAGES.checksModified, 'host');
        checks = checks.map((c): CheckResult => ({ name: c.name, status: 'not_available', reason: `${MESSAGES.checksModified}因此未检查。` }));
        changes = await G.diffSummary(wt);
        tree = tree2;
      }
    }
    t.acceptedTree = tree;
    t.card = buildCard({
      exit: t.exit!,
      changes,
      checks,
      criteria: t.criteria,
      previewed: t.previewed,
      denied: t.denied,
      deniedAcks: t.deniedAcks,
      git: t.gitBinding,
      acceptedTree: tree,
      overallConfirmed: t.overallConfirmed === true,
      notes: this.cardNotes(t),
      ...(t.checksVoid ? { checksVoid: t.checksVoid } : {}),
    });
  }

  private async review(t: Task): Promise<Task> {
    await this.buildEvidence(t);
    await this.fire(t, 'review');
    return t;
  }

  /**
   * 重新检查：副本内容在确认之后变了（验收失效），或用户想重新核对。
   * 清空此前的全部确认，按当前内容重新生成验收证据；之后必须重新确认。
   */
  async recheck(id: string): Promise<Task> {
    if (!this.enter(id)) throw new Error(MESSAGES.busy);
    try {
      const t = await this.load(id);
      if (!['reviewing', 'save_failed_unmerged'].includes(t.state) || !t.worktree) throw new Error('任务不在验收阶段。');
      t.criteria.forEach((c) => delete c.decision);
      t.previewed = false;
      t.previewSkipped = false;
      t.overallConfirmed = false;
      t.deniedAcks = t.denied.map(() => false);
      await this.buildEvidence(t);
      await this.persist(t);
      return t;
    } finally {
      this.leave(id);
    }
  }

  /** 用户对验收标准逐条确认/否决，或标记已试用。只改用户输入，不改自动检查结果。 */
  async confirm(id: string, update: { criterion?: number; decision?: 'confirmed' | 'rejected'; previewed?: boolean; previewSkipped?: boolean; deniedAck?: number; overall?: boolean }) {
    if (!this.enter(id)) throw new Error(MESSAGES.busy); // 与保存/放弃/撤销/重新检查互斥，避免同时改同一份记录
    try {
      return await this.confirmInner(id, update);
    } finally {
      this.leave(id);
    }
  }

  private async confirmInner(id: string, update: { criterion?: number; decision?: 'confirmed' | 'rejected'; previewed?: boolean; previewSkipped?: boolean; deniedAck?: number; overall?: boolean }) {
    const t = await this.load(id);
    if (t.state !== 'reviewing' || !t.card) throw new Error('任务不在验收阶段。');
    if (t.card.items.some((i) => i.key === 'drivers')) throw new Error(MESSAGES.externalDriver);
    if (update.overall !== undefined) {
      if (t.criteria.length > 0) throw new Error('这个任务有验收标准，请逐条确认。');
      t.overallConfirmed = update.overall;
    }
    if (update.criterion !== undefined) {
      const c = t.criteria[update.criterion];
      if (!c || !update.decision) throw new Error('无效的验收标准。');
      c.decision = update.decision;
    }
    if (update.previewed !== undefined) {
      t.previewed = update.previewed;
      if (update.previewed) t.previewSkipped = false;
    }
    if (update.previewSkipped !== undefined) {
      t.previewSkipped = update.previewSkipped;
      if (update.previewSkipped) t.previewed = false;
    }
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
    t.card = buildCard({
      exit: t.exit!,
      changes: prev.changes,
      checks,
      criteria: t.criteria,
      previewed: t.previewed,
      denied: t.denied,
      deniedAcks: t.deniedAcks,
      overallConfirmed: t.overallConfirmed === true,
      notes: this.cardNotes(t),
      ...(t.acceptedTree ? { acceptedTree: t.acceptedTree } : {}),
      ...(t.checksVoid ? { checksVoid: t.checksVoid } : {}),
      ...(t.gitBinding ? { git: t.gitBinding } : {}),
    });
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
    t.previewSkipped = false;
    t.overallConfirmed = false;
    delete t.acceptedTree;
    delete t.checksVoid;
    delete t.card;
    delete t.exit;
    t.denied = [];
    t.deniedAcks = [];
    this.log(t, 'message', `你要求修改：${instruction}`);
    await this.fire(t, 'request_fix'); // fire 会持久化，必须在清空之后
    return this.start(id, `${buildPrompt(t)}\n\n上一次结果需要修改：${instruction}`);
  }

  // ───────────────────────── 保存 / 放弃 / 撤销 / 清理（B4） ─────────────────────────

  /** 同一任务的保存/放弃/撤销/清理互斥：进行中再次调用被拒绝（必须在第一个 await 之前同步登记） */
  private busy = new Set<string>();
  private enter(id: string): boolean {
    if (this.busy.has(id)) return false;
    this.busy.add(id);
    return true;
  }
  private leave(id: string): void {
    this.busy.delete(id);
  }
  private busyFail(): OpFail {
    return { ok: false, reason: 'busy', detail: MESSAGES.busy };
  }

  private beginOp(t: Task, kind: OpLog['kind'], extra: Partial<OpLog> = {}): void {
    t.op = { kind, startedAt: new Date().toISOString(), phase: 'started', steps: [], ...extra };
  }
  private opStep(t: Task, name: string, ok: boolean, detail?: string): void {
    t.op?.steps.push({ at: new Date().toISOString(), name, ok, ...(detail ? { detail } : {}) });
  }
  /** 进入下一阶段并立即落盘 */
  private async opPhase(t: Task, phase: OpLog['phase'], patch: Partial<OpLog> = {}): Promise<void> {
    if (!t.op) return;
    Object.assign(t.op, patch, { phase });
    await this.persist(t);
  }
  private endOp(t: Task, phase: 'finished' | 'interrupted'): void {
    if (!t.op) return;
    t.op.phase = phase;
    t.op.finishedAt = new Date().toISOString();
  }
  private recordCleanup(t: Task, c: G.CleanupResult): void {
    t.cleanup = { at: new Date().toISOString(), steps: c.steps };
    for (const s of c.steps) this.opStep(t, `清理：${s.step}`, s.ok, s.error);
  }

  private async runTrialChecks(t: Task, trialPath: string): Promise<ProjectChecksOutcome> {
    if (this.opts.runChecks === false) {
      return { results: [], checked: false, summary: { passed: 0, failed: 0 }, failed: [] };
    }
    return runProjectChecks(trialPath, this.opts.sandboxRunner ?? this.opts.executor.sandboxRunner, {
      authorizedDigest: t.checkAuth?.digest,
      ...(t.plan?.capabilities ? { capabilities: t.plan.capabilities } : {}),
      taskId: t.id,
      fullTrustRecords: this.store,
    });
  }

  /** 保存（B4-plan 第 3 节 + 阶段 1 安全保存）：先在临时 worktree 试合并与试检查，再写入主项目。 */
  async save(id: string): Promise<SaveResult> {
    if (!this.enter(id)) return this.busyFail();
    try {
      return await this.doSave(id);
    } finally {
      this.leave(id);
    }
  }

  private async doSave(id: string): Promise<SaveResult> {
    const t = await this.load(id);
    const repo = this.opts.repo;
    if (t.manualReview) return { ok: false, reason: 'abnormal', detail: MESSAGES.abnormal };
    if (this.runs.has(id) || this.starting.has(id)) return { ok: false, reason: 'not_ready', detail: '任务还在执行，请先停止。' };
    if (!['reviewing', 'save_failed_unmerged'].includes(t.state)) return { ok: false, reason: 'not_ready', detail: MESSAGES.notReady };
    const blockers = saveBlockers(t);
    const wt = t.worktree;
    const binding = t.binding;
    if (blockers.length || !wt || !binding || !t.acceptedTree) {
      return { ok: false, reason: 'not_ready', detail: blockers.length ? blockers.join('') : MESSAGES.notReady };
    }

    // 外部驱动检测：任务副本与主项目都要过；命中即停，副本保留，不关闭驱动后继续
    for (const dir of [wt.path, repo]) {
      const d = await G.detectExternalDrivers(dir);
      if (!d.supported) return { ok: false, reason: 'external_driver', detail: MESSAGES.externalDriver, files: d.drivers };
    }
    if ((await fs.realpath(repo)) !== binding.repoPath) return { ok: false, reason: 'repo_changed', detail: MESSAGES.repoChanged };
    if ((await G.currentBranch(repo)) !== binding.branch) return { ok: false, reason: 'branch_changed', detail: MESSAGES.branchChanged };
    const dirty = await G.dirtyFiles(repo);
    if (dirty.length) return { ok: false, reason: 'dirty_main', detail: MESSAGES.dirtyMain, files: dirty };

    // 验收内容冻结：重新计算副本内容，必须与验收时的 acceptedTree 完全一致
    const tree = await G.computeTree(repo, wt.path);
    if (tree !== t.acceptedTree) {
      this.log(t, 'error', MESSAGES.acceptanceInvalid, 'host');
      await this.persist(t);
      return { ok: false, reason: 'acceptance_invalid', detail: MESSAGES.acceptanceInvalid };
    }

    const goal = t.plan?.goal ?? t.request;
    const preHead = await G.headSha(repo);
    this.beginOp(t, 'save', { preHead });
    await this.persist(t);

    // 任务提交 = 冻结的 tree（父 = 任务基线），不再 add -A；提交内容就是验收内容
    const taskCommit = await G.commitTree(wt.path, t.acceptedTree, wt.baseSha, `studio: ${goal}`);
    this.opStep(t, '生成任务提交', true, taskCommit);
    await this.opPhase(t, 'task_committed', { taskCommit });

    await G.ensureIdentity(repo);

    const trialPath = G.trialWorktreePath(repo, t.id);
    let trialActive = true;
    const cleanupTrial = async (): Promise<void> => {
      if (!trialActive) return;
      trialActive = false;
      const r = await G.removeTrialWorktree(repo, trialPath).catch((err) => ({ ok: false as const, error: String(err) }));
      this.opStep(t, '清理临时副本', r.ok, r.ok ? undefined : r.error);
    };

    await this.opPhase(t, 'trial_merging', { trialWorktreePath: trialPath });
    let checked = false;
    try {
      await G.createTrialWorktree(repo, trialPath, preHead);
      this.opStep(t, '创建临时副本', true, trialPath);

      // a. 在临时 worktree 里用 --no-ff 合并 taskCommit，得到 trialCommit（主项目完全不被触碰）
      let trialCommit = '';
      try {
        await G.git(trialPath, ['merge', '--no-ff', '-m', `studio: 保存「${goal}」`, taskCommit]);
        trialCommit = await G.headSha(trialPath);
        this.opStep(t, '试合并', true, trialCommit);
        await this.opPhase(t, 'trial_merged', { trialCommit });
      } catch (e) {
        const stderr = e instanceof G.GitError ? e.stderr : String(e);
        const inConflict = await G.mergeInProgress(trialPath).catch(() => false);
        await G.git(trialPath, ['merge', '--abort']).catch(() => undefined);
        this.opStep(t, '试合并', false, inConflict ? 'conflict' : stderr.trim().slice(0, 500));
        const intact = (await G.headSha(repo).catch(() => '')) === preHead
          && (await G.dirtyFiles(repo).catch(() => ['?'])).length === 0
          && !(await G.mergeInProgress(repo).catch(() => true));
        this.opStep(t, '合并失败后核验主项目', intact);
        await cleanupTrial();
        if (!intact) {
          t.manualReview = { reason: '试合并失败核验时发现主项目与保存前不一致。', at: new Date().toISOString() };
          this.endOp(t, 'interrupted');
          await this.persist(t);
          return { ok: false, reason: 'abnormal', detail: MESSAGES.abnormal };
        }
        this.endOp(t, 'interrupted');
        if (inConflict) {
          await this.fire(t, 'save_conflict');
          return { ok: false, reason: 'conflict', detail: MESSAGES.conflict };
        }
        await this.persist(t);
        return { ok: false, reason: 'failed', detail: stderr.trim() || '试合并失败，本次没有保存。' };
      }

      // b. 在临时 worktree 里运行项目的自动检查（复用 checks/scripts.ts 的识别结果）
      let checksSummary = { passed: 0, failed: 0 };
      let checkedAt: string | undefined;
      try {
        const checkOutcome = await this.runTrialChecks(t, trialPath);
        checked = checkOutcome.checked;
        checksSummary = checkOutcome.summary;
        checkedAt = checkOutcome.checkedAt;
        if (checkOutcome.failed.length > 0) {
          const failedNames = checkOutcome.failed.map((c) => c.name);
          this.opStep(t, '试检查', false, failedNames.join(','));
          await cleanupTrial();
          this.endOp(t, 'interrupted');
          await this.persist(t);
          const labels = failedNames.map((n) => (n === 'build' ? '构建' : '测试'));
          return {
            ok: false,
            reason: 'checks_failed',
            detail: `合并后自动检查未通过（${labels.join('、')}），本次没有保存，你的项目保持原样。`,
            failedChecks: failedNames,
          };
        }
        this.opStep(t, '试检查', true, checked ? `passed=${checksSummary.passed}` : '未检查');
        await this.opPhase(t, 'trial_checked', {
          checked,
          checksSummary,
          ...(checkedAt ? { checkedAt } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.opStep(t, '试检查', false, msg.slice(0, 500));
        await cleanupTrial();
        this.endOp(t, 'interrupted');
        await this.persist(t);
        return { ok: false, reason: 'failed', detail: msg || '合并后检查出错，本次没有保存。' };
      }

      // c. 写入前再核对：主项目 HEAD 仍等于 preHead、工作区干净、分支未变
      const currentHead = await G.headSha(repo).catch(() => '');
      const currentDirty = await G.dirtyFiles(repo).catch(() => ['?']);
      const currentBr = await G.currentBranch(repo).catch(() => '');
      const currentInMerge = await G.mergeInProgress(repo).catch(() => true);
      if (currentHead !== preHead || currentDirty.length > 0 || currentBr !== binding.branch || currentInMerge) {
        const diffs: string[] = [];
        if (currentHead !== preHead) diffs.push('head_changed');
        if (currentDirty.length > 0) diffs.push('dirty');
        if (currentBr !== binding.branch) diffs.push('branch_changed');
        if (currentInMerge) diffs.push('merge_in_progress');
        this.opStep(t, '写入前核对项目未变', false, diffs.join(','));
        await cleanupTrial();
        this.endOp(t, 'interrupted');
        await this.persist(t);
        return { ok: false, reason: 'project_changed', detail: MESSAGES.projectChanged };
      }
      this.opStep(t, '写入前核对项目未变', true);
      await this.opPhase(t, 'writing');

      // d. 写入：主项目执行 git merge --ff-only trialCommit
      try {
        await G.git(repo, ['merge', '--ff-only', trialCommit]);
      } catch (e) {
        const stderr = e instanceof G.GitError ? e.stderr : String(e);
        await G.git(repo, ['merge', '--abort']).catch(() => undefined);
        const postDirty = await G.dirtyFiles(repo).catch(() => ['?']);
        const intact = (await G.headSha(repo).catch(() => '')) === preHead
          && postDirty.length === 0
          && (await G.currentBranch(repo).catch(() => '')) === binding.branch
          && !(await G.mergeInProgress(repo).catch(() => true));
        this.opStep(t, '合并失败后核验主项目', intact, stderr.trim().slice(0, 500));
        await cleanupTrial();
        if (!intact) {
          t.manualReview = { reason: '合并失败后，主项目的版本或文件与合并前不一致。', at: new Date().toISOString() };
          this.endOp(t, 'interrupted');
          await this.persist(t);
          return {
            ok: false,
            reason: 'abnormal',
            detail: MESSAGES.abnormal,
            ...(postDirty.length && postDirty[0] !== '?' ? { files: postDirty } : {}),
          };
        }
        this.endOp(t, 'interrupted');
        await this.persist(t);
        return { ok: false, reason: 'failed_restored', detail: MESSAGES.failedRestored };
      }

      const mergeCommit = await G.headSha(repo);
      t.saveRecord = { preMergeHead: preHead, taskCommit, mergeCommit, branch: binding.branch, savedAt: new Date().toISOString() };
      this.opStep(t, '合并到项目', true, mergeCommit);
      await this.opPhase(t, 'merged', { mergeCommit }); // 合并完成立刻落盘，之后即使中断也能据此核对

      // e. 无论结果如何都清理临时 worktree；清理失败只记录，不影响保存成功判断
      await cleanupTrial();
    } finally {
      if (trialActive) {
        await cleanupTrial();
        await this.persist(t).catch(() => undefined);
      }
    }

    return this.finishSave(t, false, checked);
  }

  /** 保存的收尾：清理副本与分支，再迁移到 saved / saved_cleanup_pending。保存与启动核对共用。 */
  private async finishSave(t: Task, fromReconcile = false, checked = false): Promise<SaveResult> {
    let cleanup: G.CleanupResult;
    if (fromReconcile) {
      // 启动核对中的收尾：先核实任务归属与执行体进程，核实不过就不删除
      const r = await this.reconcileCleanup(t);
      cleanup = 'blocked' in r ? { ok: false, steps: [{ step: 'check', ok: false, error: r.blocked }] } : r.cleanup;
    } else {
      cleanup = await G.removeWorktree(this.opts.repo, t.worktree!);
    }
    this.recordCleanup(t, cleanup);
    this.endOp(t, 'finished');
    await this.fire(t, cleanup.ok ? 'save' : 'save_cleanup_pending');
    return { ok: true, task: t, message: cleanup.ok ? MESSAGES.saved : `${MESSAGES.saved}${MESSAGES.saveCleanupPending}`, cleanup, checked };
  }

  /** 放弃：删除副本与任务分支，主项目不受影响。清理失败不吞错，进入 discard_cleanup_pending。 */
  async discard(id: string): Promise<DiscardResult> {
    if (!this.enter(id)) return this.busyFail();
    try {
      const t = await this.load(id);
      if (this.runs.has(id)) throw new Error('请先停止正在执行的任务。');
      if (!canFire(t.state, 'discard')) return { ok: false, reason: 'not_allowed', detail: '这个任务现在不能放弃。' };
      this.beginOp(t, 'discard');
      await this.persist(t);
      const cleanup: G.CleanupResult = t.worktree ? await G.removeWorktree(this.opts.repo, t.worktree) : { ok: true, steps: [] };
      this.recordCleanup(t, cleanup);
      this.endOp(t, 'finished');
      await this.fire(t, cleanup.ok ? 'discard' : 'discard_cleanup_pending');
      const caps = t.plan?.capabilities;
      const extra = !!caps && (caps.extraWritableDirs.length > 0 || caps.constructionMode === 'full_trust');
      const message = cleanup.ok ? (extra ? `${MESSAGES.discardDone}${MESSAGES.discardExtra}` : MESSAGES.discardDone) : MESSAGES.discardCleanupPending;
      return { ok: true, task: t, message, cleanup };
    } finally {
      this.leave(id);
    }
  }

  /** 撤销这次保存（B4-plan 第 5 节）：只在“合并提交仍是当前分支 HEAD、分支一致、工作区干净”时，用新提交恢复到合并前。 */
  async undo(id: string): Promise<UndoResult> {
    if (!this.enter(id)) return this.busyFail();
    try {
      const t = await this.load(id);
      const repo = this.opts.repo;
      const rec = t.saveRecord;
      if (!['saved', 'undo_failed'].includes(t.state) || !rec) return { ok: false, reason: 'not_allowed', detail: '这个任务没有可以撤销的保存。' };
      const d = await G.detectExternalDrivers(repo);
      if (!d.supported) return { ok: false, reason: 'external_driver', detail: MESSAGES.externalDriver, files: d.drivers };
      const branch = await G.currentBranch(repo);
      if (branch !== rec.branch) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused };
      if ((await G.headSha(repo)) !== rec.mergeCommit) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused };
      const dirty = await G.dirtyFiles(repo);
      if (dirty.length) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused, files: dirty };

      this.beginOp(t, 'undo', { preHead: rec.mergeCommit });
      await this.persist(t);
      try {
        const undoCommit = await G.restoreTo(repo, rec.preMergeHead, `studio: 撤销「${t.plan?.goal ?? t.request}」`);
        this.opStep(t, '恢复到保存之前', true, undoCommit);
        this.endOp(t, 'finished');
        t.op!.undoCommit = undoCommit;
        await this.fire(t, 'undo');
        return { ok: true, task: t, message: MESSAGES.undone };
      } catch (e) {
        const intact = (await G.headSha(repo).catch(() => '')) === rec.mergeCommit && (await G.dirtyFiles(repo).catch(() => ['?'])).length === 0;
        this.opStep(t, '撤销失败', false, e instanceof G.GitError ? e.stderr.trim().slice(0, 500) : String(e));
        this.endOp(t, 'interrupted');
        if (!intact) t.manualReview = { reason: '撤销失败后，主项目的版本或文件与撤销前不一致。', at: new Date().toISOString() };
        await this.fire(t, 'undo_failed');
        return intact ? { ok: false, reason: 'failed', detail: '撤销没有成功，项目保持原样。你可以稍后重试。' } : { ok: false, reason: 'abnormal', detail: MESSAGES.abnormal };
      }
    } finally {
      this.leave(id);
    }
  }

  /** 重试清理（saved_cleanup_pending / discard_cleanup_pending）。只清理本任务的副本目录与任务分支。 */
  async retryCleanup(id: string): Promise<RetryCleanupResult> {
    if (!this.enter(id)) return this.busyFail();
    try {
      const t = await this.load(id);
      if (!['saved_cleanup_pending', 'discard_cleanup_pending'].includes(t.state) || !t.worktree) return { ok: false, reason: 'not_allowed', detail: '这个任务没有需要清理的临时文件。' };
      const saving = t.state === 'saved_cleanup_pending';
      this.beginOp(t, 'cleanup');
      // 与启动核对同一条安全路径：归属 → 执行体进程核实 → removeWorktree（内含路径校验）；核实不了就不删除
      const guarded = await this.reconcileCleanup(t);
      if ('blocked' in guarded) {
        this.opStep(t, '清理前核实未通过，没有删除', false, guarded.blocked);
        this.endOp(t, 'interrupted');
        await this.persist(t);
        return { ok: false, reason: 'cleanup_pending', detail: MESSAGES.cleanupBusy };
      }
      const cleanup = guarded.cleanup;
      this.recordCleanup(t, cleanup);
      if (!cleanup.ok) {
        this.endOp(t, 'interrupted');
        await this.persist(t);
        return { ok: false, reason: 'cleanup_pending', detail: saving ? MESSAGES.saveCleanupPending : MESSAGES.discardCleanupPending };
      }
      this.endOp(t, 'finished');
      await this.fire(t, 'cleanup_done');
      return { ok: true, task: t, message: saving ? MESSAGES.saved : MESSAGES.discardDone, cleanup };
    } finally {
      this.leave(id);
    }
  }

  // ───────────────────────── 启动核对（B4-plan 第 6 节；B4-2 拆成“识别”与“安全收尾”两步） ─────────────────────────

  /** 第一步（只读）：按 Git 真实状态识别一个任务的中断情况。不写任务记录、不动任何目录。 */
  async inspectTask(t: Task): Promise<ReconcileFinding> {
    const repo = this.opts.repo;
    const op = t.op;
    if (t.state === 'running' && !this.runs.has(t.id) && !this.starting.has(t.id)) return { kind: 'run_interrupted' };
    if (!op || op.phase === 'finished' || op.phase === 'interrupted') {
      // 清理待办但副本与分支其实已经没有了（例如被人工清理）：只需把记录改为清理完成
      if (['saved_cleanup_pending', 'discard_cleanup_pending'].includes(t.state) && t.worktree && (await G.worktreeGone(repo, t.worktree))) return { kind: 'cleanup_gone' };
      return { kind: 'idle' };
    }
    if (op.kind === 'save') {
      const pre = op.preHead;
      if (!pre) return { kind: 'manual', reason: '保存中断，且没有记录合并前的版本。' };
      if (t.state !== 'reviewing' && t.state !== 'save_failed_unmerged') return { kind: 'manual', reason: '保存中断，但任务状态已经不是验收阶段。' };
      const head = await G.headSha(repo);
      const inMerge = await G.mergeInProgress(repo);
      const merged = op.taskCommit ? await G.findMergeCommit(repo, pre, op.taskCommit) : null;
      if (merged && !inMerge) return { kind: 'save_merged', merged, phase: op.phase };
      if (!inMerge && head === pre && (await G.dirtyFiles(repo)).length === 0) return { kind: 'save_not_merged', phase: op.phase };
      return { kind: 'manual', reason: '保存中断后，项目的版本或文件状态无法判定。' };
    }
    if (op.kind === 'discard') {
      if (!t.worktree) return { kind: 'manual', reason: '放弃中断，但没有记录任务副本。' };
      return { kind: 'discard_resume' };
    }
    if (op.kind === 'undo') {
      const rec = t.saveRecord;
      if (!rec) return { kind: 'manual', reason: '撤销中断，但没有保存记录。' };
      const head = await G.headSha(repo);
      const dirty = await G.dirtyFiles(repo);
      if (head === rec.mergeCommit && dirty.length === 0) return { kind: 'undo_not_happened' };
      if (head !== rec.mergeCommit && dirty.length === 0 && (await G.isAncestor(repo, rec.mergeCommit, head)) && (await G.treeOf(repo, head)) === (await G.treeOf(repo, rec.preMergeHead))) return { kind: 'undo_done', head };
      return { kind: 'manual', reason: '撤销中断后，项目的版本或文件状态无法判定。' };
    }
    return { kind: 'manual', reason: '清理中断。' };
  }

  /** 第一步（只读）：识别全部任务，返回需要处理的。 */
  async identifyTasks(): Promise<{ taskId: string; finding: ReconcileFinding }[]> {
    const out: { taskId: string; finding: ReconcileFinding }[] = [];
    for (const listed of await this.store.list()) {
      const t = await this.load(listed.id);
      const finding = await this.inspectTask(t);
      if (finding.kind !== 'idle') out.push({ taskId: listed.id, finding });
    }
    return out;
  }

  /**
   * 安全清理（只用于启动核对）：删除前依次核实 任务归属 → 没有本应用记录的执行体进程仍在运行 → 路径校验（removeWorktree 内部再做一次）。
   * 任一项确认不了就不删除，返回 blocked（调用方把任务标为“清理待处理”，由用户点“重试清理”）。
   */
  private async reconcileCleanup(t: Task): Promise<{ blocked: string } | { cleanup: G.CleanupResult }> {
    const wt = t.worktree!;
    const owner = G.worktreeOwnershipProblem(this.opts.repo, wt, t.id);
    if (owner) return { blocked: owner };
    const proc = await verifyNoLiveExecutor(t, this.opts.processProbe);
    if (!proc.ok) return { blocked: proc.reason };
    return { cleanup: await G.removeWorktree(this.opts.repo, wt) };
  }

  private markReconciled(t: Task, note: string): void {
    t.reconciled = { at: new Date().toISOString(), note };
  }

  /** 第二步（有写入）：按识别结果安全收尾。 */
  async reconcileTasks(): Promise<ReconcileEntry[]> {
    const out: ReconcileEntry[] = [];
    for (const { taskId: id, finding: first } of await this.identifyTasks()) {
      if (!this.enter(id)) continue;
      try {
        const t = await this.load(id);
        // 加锁后重新识别：识别到应用之间任务可能已变化
        const f = await this.inspectTask(t);
        if (f.kind !== first.kind) continue;
        const repo = this.opts.repo;
        if (f.kind === 'cleanup_gone') {
          this.markReconciled(t, '副本与分支已经不存在，清理已记为完成。');
          await this.fire(t, 'cleanup_done');
          out.push({ taskId: id, action: '副本与分支已不存在，清理待办已记为完成' });
        } else if (f.kind === 'run_interrupted') {
          // 先换掉运行编号（fence）：旧运行之后的任何回传都会被拒绝；再核实执行体进程，最后按失败收尾
          const proc = await verifyNoLiveExecutor(t, this.opts.processProbe);
          t.runId = RecordStore.newRunId();
          if (!proc.ok) {
            t.manualReview = { reason: '上次执行被中断，无法确认执行体已经停止。', at: new Date().toISOString() };
            this.markReconciled(t, '上次执行因应用退出而中断，无法确认 AI 已经停止，为安全起见已停止，请不要继续操作。');
            await this.persist(t, { startRun: true, note: 'fence' });
            out.push({ taskId: id, action: `需要人工查看：${proc.reason}` });
          } else {
            t.exit = { kind: 'signaled', signal: 'APP_RESTART' };
            t.denied ??= [];
            t.deniedAcks ??= [];
            this.markReconciled(t, '上次执行因应用退出而中断，已按失败处理；AI 的成果仍在任务副本里，可以查看后保存或放弃。');
            await this.fire(t, 'exec_exit_fail', { startRun: true, note: 'fence' });
            try {
              await this.review(t);
            } catch {
              t.manualReview = { reason: '执行中断后无法生成验收内容。', at: new Date().toISOString() };
              await this.persist(t);
            }
            out.push({ taskId: id, action: '执行被中断，已换掉运行编号并按失败收尾' });
          }
        } else if (f.kind === 'manual') {
          t.manualReview = { reason: f.reason, at: new Date().toISOString() };
          this.markReconciled(t, '上次操作中断，无法确定项目的状态，为安全起见已停止，请不要继续操作。');
          await this.persist(t);
          out.push({ taskId: id, action: `需要人工查看：${f.reason}` });
        } else if (f.kind === 'save_merged') {
          // 合并已经落在分支上：清理残留临时副本，补记合并结果，并完成收尾
          const op = t.op!;
          if (op.trialWorktreePath) {
            const tc = await G.removeTrialWorktree(repo, op.trialWorktreePath).catch((err) => ({ ok: false as const, error: String(err) }));
            this.opStep(t, '清理临时副本', tc.ok, tc.error);
          }
          t.saveRecord ??= {
            preMergeHead: op.preHead!,
            taskCommit: op.taskCommit!,
            mergeCommit: f.merged,
            branch: t.binding?.branch ?? (await G.currentBranch(repo)),
            savedAt: new Date().toISOString(),
          };
          this.opStep(t, '启动核对：合并已在分支上', true, f.merged);
          op.mergeCommit = f.merged;
          this.markReconciled(t, '上次保存在写入项目后中断，核对后确认内容已经保存到项目。');
          await this.opPhase(t, 'merged');
          const r = await this.finishSave(t, true, op.checked ?? false);
          out.push({ taskId: id, action: r.ok && r.task.state === 'saved' ? '已修正为 saved' : '已修正为 saved_cleanup_pending' });
        } else if (f.kind === 'save_not_merged') {
          const op = t.op!;
          if (op.trialWorktreePath) {
            const tc = await G.removeTrialWorktree(repo, op.trialWorktreePath).catch((err) => ({ ok: false as const, error: String(err) }));
            this.opStep(t, '清理临时副本', tc.ok, tc.error);
          }
          const stageMap: Partial<Record<OpLog['phase'], string>> = {
            started: '准备保存阶段',
            task_committed: '生成任务提交后',
            trial_merging: '试合并阶段',
            trial_merged: '试检查阶段',
            trial_checked: '写入前核对阶段',
            writing: '写入主项目前',
          };
          const stage = (f.phase && stageMap[f.phase]) || '合并前';
          this.opStep(t, `启动核对：在${stage}中断，合并没有发生，项目保持原样`, true);
          this.endOp(t, 'interrupted');
          this.markReconciled(t, `上次保存在${stage}中断，项目保持原样，可以重新保存。`);
          await this.persist(t);
          out.push({ taskId: id, action: `保存在${stage}中断，项目保持原样；可以重新保存` });
        } else if (f.kind === 'discard_resume') {
          // 放弃的意图已明确：继续清理（只针对本任务的副本与分支，且必须先核实）
          const r = await this.reconcileCleanup(t);
          if ('blocked' in r) {
            this.opStep(t, '启动核对：清理前核实未通过，没有删除', false, r.blocked);
            this.endOp(t, 'interrupted');
            this.markReconciled(t, '上次放弃在清理时中断；无法确认可以安全删除任务副本，需要你点“重试清理”。');
            if (canFire(t.state, 'discard_cleanup_pending')) await this.fire(t, 'discard_cleanup_pending');
            else await this.persist(t);
            out.push({ taskId: id, action: '放弃的清理未执行（核实未通过），记为 discard_cleanup_pending' });
          } else {
            this.recordCleanup(t, r.cleanup);
            this.endOp(t, 'finished');
            this.markReconciled(t, '上次放弃在清理时中断，核对后已完成清理。');
            const ev = r.cleanup.ok ? 'discard' : 'discard_cleanup_pending';
            if (canFire(t.state, ev)) await this.fire(t, ev);
            else await this.persist(t);
            out.push({ taskId: id, action: r.cleanup.ok ? '放弃已完成清理' : '放弃的清理未完成，记为 discard_cleanup_pending' });
          }
        } else if (f.kind === 'undo_not_happened') {
          this.opStep(t, '启动核对：撤销没有发生，项目保持原样', true);
          this.endOp(t, 'interrupted');
          this.markReconciled(t, '上次撤销在开始前中断，项目保持原样，可以重新撤销。');
          await this.persist(t);
          out.push({ taskId: id, action: '撤销在开始前中断，项目保持原样；可以重新撤销' });
        } else if (f.kind === 'undo_done') {
          t.op!.undoCommit = f.head;
          this.endOp(t, 'finished');
          this.markReconciled(t, '上次撤销已经生效，核对后记录已更新为“已撤销”。');
          await this.fire(t, 'undo');
          out.push({ taskId: id, action: '撤销已在分支上，已修正为 undone' });
        }
      } finally {
        this.leave(id);
      }
    }
    return out;
  }

  // ───────────────────────── 只读预判（界面显示按钮是否可用；真正操作时核心层会再判一次） ─────────────────────────

  /** 同一任务是否有保存/放弃/撤销/清理/重新检查/确认正在进行 */
  isBusy(id: string): boolean {
    return this.busy.has(id) || this.runs.has(id) || this.starting.has(id);
  }

  /**
   * 保存的只读预判：与 save 的检查顺序一致（外部驱动 → 仓库与分支 → 主项目干净 → 验收内容未变），但不写任何记录。
   * 返回第一个不满足的原因，null 表示目前可以保存。
   */
  async previewSave(t: Task): Promise<OpFail | null> {
    const repo = this.opts.repo;
    const wt = t.worktree;
    const binding = t.binding;
    if (!wt || !binding || !t.acceptedTree) return { ok: false, reason: 'not_ready', detail: MESSAGES.notReady };
    for (const dir of [wt.path, repo]) {
      const d = await G.detectExternalDrivers(dir);
      if (!d.supported) return { ok: false, reason: 'external_driver', detail: MESSAGES.externalDriver };
    }
    if ((await fs.realpath(repo)) !== binding.repoPath) return { ok: false, reason: 'repo_changed', detail: MESSAGES.repoChanged };
    if ((await G.currentBranch(repo)) !== binding.branch) return { ok: false, reason: 'branch_changed', detail: MESSAGES.branchChanged };
    const dirty = await G.dirtyFiles(repo);
    if (dirty.length) return { ok: false, reason: 'dirty_main', detail: MESSAGES.dirtyMain, files: dirty };
    if ((await G.computeTree(repo, wt.path)) !== t.acceptedTree) return { ok: false, reason: 'acceptance_invalid', detail: MESSAGES.acceptanceInvalid };
    return null;
  }

  /** 撤销的只读预判：与 undo 的前置检查一致。null 表示目前可以撤销。 */
  async previewUndo(t: Task): Promise<OpFail | null> {
    const repo = this.opts.repo;
    const rec = t.saveRecord;
    if (!['saved', 'undo_failed'].includes(t.state) || !rec) return { ok: false, reason: 'not_allowed', detail: '这个任务没有可以撤销的保存。' };
    const d = await G.detectExternalDrivers(repo);
    if (!d.supported) return { ok: false, reason: 'external_driver', detail: MESSAGES.externalDriver };
    if ((await G.currentBranch(repo)) !== rec.branch) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused };
    if ((await G.headSha(repo)) !== rec.mergeCommit) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused };
    const dirty = await G.dirtyFiles(repo);
    if (dirty.length) return { ok: false, reason: 'undo_refused', detail: MESSAGES.undoRefused, files: dirty };
    return null;
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
