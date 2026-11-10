import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
// 流程引擎只依赖 Thinker 接口（仅类型引用），不引用任何具体实现类（tests/security.test.ts 断言）。
import type { ContextItem, Thinker, ThinkRequest, ThinkResult } from '../types.js';
import { computeChecks, type ReviseBody } from './checks.js';
import { formatFindings, formatItems, planBody, SCHEMAS, SYSTEMS } from './steps.js';
import { ArtifactMismatchError, atomicWriteExclusive, sha256, ThreadStore } from './store.js';
import { budgetStopReason, ConsentStore, DEFAULT_BUDGET, loadOptionalContext, loadRequiredContext } from './support.js';
import type { AttemptRecord, ChecksResult, Decision, Finding, RequirementItem, StepName, ThreadBudget, ThreadRecord } from './types.js';

export type AttemptFailureChoice = 'retry' | 'stop' | { retryWith: string };

/**
 * 用户交互接口。每个方法返回 undefined 表示“现在无法询问”（例如没有 TTY）：
 * 引擎在该确认点停止并保存线程，绝不默认通过。
 */
export interface FlowUI {
  notify?(text: string): void;
  onStep?(step: StepName, role: 'planner' | 'reviewer'): void;
  confirmSend(service: string): Promise<boolean | undefined>;
  confirmRequirements(items: RequirementItem[]): Promise<{ id?: string; text: string }[] | undefined>;
  onAttemptFailed(info: { step: StepName; attempt: AttemptRecord; thread: ThreadRecord }): Promise<AttemptFailureChoice | undefined>;
  adjudicate(q: { kind: 'finding' | 'scope'; key: string; summary: string; detail: string }): Promise<{ decision: Decision; reason: string } | undefined>;
  approve(ctx: { canApprove: boolean; blockedBecause: string[]; checks: ChecksResult; planPreview: string; independentReview: boolean }): Promise<'approve' | 'reject' | 'stop' | undefined>;
}

export type FlowOutcome =
  | { kind: 'waiting'; at: 'send_consent' | 'requirements_confirmation' | 'attempt_failed' | 'adjudication' | 'approval'; threadId: string; message: string }
  | { kind: 'stopped'; threadId: string; reason: string }
  | { kind: 'rejected'; threadId: string }
  | { kind: 'approved'; threadId: string; planPath: string }
  | { kind: 'exported'; threadId: string }
  | { kind: 'integrity_error'; threadId: string; message: string };

export interface FlowOptions {
  projectRoot: string;
  planner: Thinker;
  reviewer?: Thinker;
  /** 单思考者模式：跳过评审，线程记录与导出任务中标注“未经独立评审” */
  single?: boolean;
  ui: FlowUI;
  budget?: Partial<ThreadBudget>;
  optionalFiles?: string[];
  consent?: ConsentStore;
  now?: () => Date;
  newId?: () => string;
}

const defaultId = (now: Date) => `T${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;

interface ReqBody {
  items: RequirementItem[];
  rawRequirement: string;
}
interface DraftBody {
  plan: string;
  coverage: { id: string; how: string }[];
}
interface ReviewBody {
  requirement_checks: { id: string; covered: boolean; note: string }[];
  findings: Finding[];
  missing_evidence: string[];
}

type CallResult = { ok: true; content: Record<string, unknown>; attempt: AttemptRecord } | { ok: false; outcome: FlowOutcome };

export class FlowEngine {
  readonly store: ThreadStore;
  private readonly consent: ConsentStore;
  private rec!: ThreadRecord;
  private readonly now: () => Date;

  constructor(private readonly o: FlowOptions) {
    this.store = new ThreadStore(o.projectRoot);
    this.consent = o.consent ?? new ConsentStore(o.projectRoot);
    this.now = o.now ?? (() => new Date());
    if (!o.single && !o.reviewer) throw new Error('需要评审者；或使用单思考者模式（single）');
    if (!o.single && o.reviewer && o.reviewer.id === o.planner.id) throw new Error('规划者与评审者不能是同一个思考者（自审不等于互审）');
  }

  get thread(): ThreadRecord {
    return this.rec;
  }

  /** 新建线程（落盘），尚未调用任何思考者。 */
  async create(rawRequirement: string): Promise<ThreadRecord> {
    const text = rawRequirement.trim();
    if (!text) throw new Error('需求不能为空');
    const t = this.now();
    this.rec = {
      schema: 1,
      id: this.o.newId?.() ?? defaultId(t),
      createdAt: t.toISOString(),
      updatedAt: t.toISOString(),
      state: 'requirements_draft',
      rawRequirement: text,
      single: !!this.o.single,
      plannerId: this.o.planner.id,
      ...(this.o.single ? {} : { reviewerId: this.o.reviewer!.id }),
      budget: { ...DEFAULT_BUDGET, ...this.o.budget },
      optionalFiles: this.o.optionalFiles ?? [],
      attempts: [],
      artifacts: [],
      adjudications: [],
      pendingNotes: {},
      log: [],
    };
    this.log(`线程创建（${this.o.single ? '单思考者模式：未经独立评审' : `规划者 ${this.o.planner.id} / 评审者 ${this.o.reviewer!.id}`}）`);
    await this.store.save(this.rec);
    return this.rec;
  }

  /** 从磁盘恢复线程；校验所有正式产物的摘要与版本。 */
  async load(threadId: string): Promise<ThreadRecord> {
    this.rec = await this.store.load(threadId);
    if (this.rec.plannerId !== this.o.planner.id) throw new Error(`线程 ${threadId} 的规划者是 ${this.rec.plannerId}，与当前指定的 ${this.o.planner.id} 不同；不会静默更换`);
    if (!this.rec.single && this.rec.reviewerId !== this.o.reviewer?.id) throw new Error(`线程 ${threadId} 的评审者是 ${this.rec.reviewerId ?? '无'}，与当前指定的 ${this.o.reviewer?.id ?? '无'} 不同；不会静默更换`);
    return this.rec;
  }

  private log(text: string) {
    this.rec.log.push({ at: this.now().toISOString(), text });
  }
  private async save() {
    await this.store.save(this.rec);
  }

  private async stop(reason: string): Promise<FlowOutcome> {
    this.rec.state = 'stopped';
    this.rec.stoppedReason = reason;
    this.log(`线程停止：${reason}`);
    await this.save();
    return { kind: 'stopped', threadId: this.rec.id, reason };
  }
  private async wait(at: Extract<FlowOutcome, { kind: 'waiting' }>['at'], message: string): Promise<FlowOutcome> {
    this.log(`停在确认点（${at}）：${message}`);
    await this.save();
    return { kind: 'waiting', at, threadId: this.rec.id, message };
  }

  /** 调用一次思考者 = 一条独立尝试。非 complete → 线程状态不前进、已有产物保留、不自动重试。 */
  private async call(step: StepName, thinker: Thinker, role: 'planner' | 'reviewer', base: Omit<ThinkRequest, 'timeoutMs' | 'role' | 'output' | 'system'>, validate?: (c: Record<string, unknown>) => string | undefined): Promise<CallResult> {
    for (;;) {
      const why = budgetStopReason(this.rec);
      if (why) return { ok: false, outcome: await this.stop(why) };

      if (!(await this.consent.has(thinker.service))) {
        const ans = await this.o.ui.confirmSend(thinker.service);
        if (ans === undefined) return { ok: false, outcome: await this.wait('send_consent', `首次向“${thinker.service}”发送资料需要你确认（资料将离开本机）。当前无法询问，已保存线程。`) };
        if (!ans) return { ok: false, outcome: await this.stop(`用户未同意向“${thinker.service}”发送资料`) };
        const cur = await this.consent.get();
        await this.consent.record(thinker.service, { expectedRevision: cur?.revision ?? 0 });
      }

      const note = this.rec.pendingNotes[step];
      const req: ThinkRequest = {
        ...base,
        role,
        system: SYSTEMS[step],
        output: SCHEMAS[step],
        task: note ? `${base.task}\n\n## 用户补充说明（重试时追加）\n${note}` : base.task,
        timeoutMs: this.rec.budget.stepTimeoutMs,
      };
      const startedAt = this.now();
      let result: ThinkResult;
      try {
        this.o.ui.onStep?.(step, role);
        result = await thinker.think(req);
      } catch (e) {
        result = { status: 'failed', rawText: '', sent: [], service: thinker.service, error: `思考者抛出异常：${(e as Error).message}` };
      }
      const endedAt = this.now();
      const n = this.rec.attempts.filter((a) => a.step === step).length + 1;
      const attempt: AttemptRecord = {
        step,
        n,
        thinkerId: thinker.id,
        role,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        status: result.status,
        ...(result.model ? { model: result.model } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        sent: result.sent,
        service: result.service,
        ...(result.error ? { error: result.error } : {}),
        ...(result.isolationEvidence ? { isolationEvidence: result.isolationEvidence } : {}),
        ...(result.refusedToolRequests?.length ? { refusedToolRequests: result.refusedToolRequests } : {}),
        ...(note ? { userNote: note } : {}),
      };
      this.rec.attempts.push(attempt);

      let content: Record<string, unknown> | undefined = result.status === 'complete' ? result.content : undefined;
      if (result.status === 'complete' && !content) {
        attempt.status = 'incomplete';
        attempt.error = '思考者报告 complete 但没有结构化内容';
      }
      if (content) {
        const ignored = step === 'requirements' ? undefined : ignoredChanges(content);
        if (ignored !== undefined) {
          attempt.ignoredRequirementChanges = ignored;
          this.log(`步骤 ${step}：思考者试图修改已冻结的需求条目，已忽略并记录`);
        }
        const err = validate?.(content);
        if (err) {
          attempt.status = 'incomplete';
          attempt.hostCheckError = err;
          attempt.error = err;
          content = undefined;
        }
      }
      if (content && attempt.status === 'complete') return { ok: true, content, attempt };

      // 失败：不前进、不丢产物、不自动重试、不自动换模型
      this.rec.lastFailure = { step, status: attempt.status, ...(attempt.error ? { error: attempt.error } : {}), at: endedAt.toISOString() };
      this.log(`步骤 ${step} 第 ${n} 次尝试未完成（${attempt.status}）${attempt.error ? '：' + attempt.error : ''}`);
      await this.save();
      const choice = await this.o.ui.onAttemptFailed({ step, attempt, thread: this.rec });
      if (choice === undefined) return { ok: false, outcome: await this.wait('attempt_failed', `步骤 ${step} 第 ${n} 次尝试失败（${attempt.status}）；等待你选择：重试 / 修改输入后重试 / 终止。已保存线程，可用 --resume ${this.rec.id} 继续。`) };
      if (choice === 'stop') return { ok: false, outcome: await this.stop(`用户在步骤 ${step} 失败后终止线程`) };
      if (typeof choice === 'object') this.rec.pendingNotes[step] = choice.retryWith;
      await this.save();
    }
  }

  private async commit(step: StepName, name: string, attempt: AttemptRecord | undefined, body: unknown, next: ThreadRecord['state']) {
    const art = await this.store.writeArtifact(this.rec, name, body, attempt ? { step, n: attempt.n } : undefined);
    if (attempt) attempt.artifact = { name, version: art.version };
    delete this.rec.pendingNotes[step];
    delete this.rec.lastFailure;
    this.rec.state = next;
    this.log(`正式产物 ${name} v${art.version} → 状态 ${next}`);
    await this.save();
  }

  private async body<T>(name: string): Promise<T> {
    const a = this.store.latest(this.rec, name);
    if (!a) throw new Error(`缺少正式产物 ${name}`);
    const b = await this.store.readArtifact<T>(this.rec, a);
    return b;
  }

  /** 推进流程，直到终止、需要用户输入（而当前无法询问）或完成批准。可重复调用（即“恢复”）。 */
  async run(): Promise<FlowOutcome> {
    if (!this.rec) throw new Error('先调用 create() 或 load()');
    try {
      await this.store.verifyAll(this.rec);
    } catch (e) {
      if (e instanceof ArtifactMismatchError) return { kind: 'integrity_error', threadId: this.rec.id, message: e.message };
      throw e;
    }
    if (this.rec.lastFailure) this.o.ui.notify?.(`上次失败：步骤 ${this.rec.lastFailure.step}（${this.rec.lastFailure.status}）${this.rec.lastFailure.error ? '：' + this.rec.lastFailure.error : ''}`);
    const required = await loadRequiredContext(this.o.projectRoot);
    const optional = await loadOptionalContext(this.o.projectRoot, this.rec.optionalFiles);
    const requiredItems: ContextItem[] = [required];

    for (;;) {
      switch (this.rec.state) {
        case 'requirements_draft': {
          if (!this.store.latest(this.rec, 'requirements')) {
            const r = await this.call(
              'requirements',
              this.o.planner,
              'planner',
              { context: { required: requiredItems }, task: `用户的原始需求如下，请拆成条目：\n\n${this.rec.rawRequirement}` },
              (c) => {
                const items = (c.items as { text: string }[]).filter((i) => i.text.trim());
                return items.length ? undefined : '没有拆出任何有效条目';
              },
            );
            if (!r.ok) return r.outcome;
            const items = (r.content.items as { text: string }[]).map((i) => i.text.trim()).filter(Boolean).map((text, k) => ({ id: `R${k + 1}`, text }));
            const art = await this.store.writeArtifact(this.rec, 'requirements', { items, rawRequirement: this.rec.rawRequirement } satisfies ReqBody, { step: 'requirements', n: r.attempt.n });
            r.attempt.artifact = { name: 'requirements', version: art.version };
            delete this.rec.pendingNotes.requirements;
            delete this.rec.lastFailure;
            this.log('正式产物 requirements v1（待用户确认，尚未冻结）');
            await this.save();
          }
          const proposed = await this.body<ReqBody>('requirements');
          const edited = await this.o.ui.confirmRequirements(proposed.items);
          if (edited === undefined) return this.wait('requirements_confirmation', '需求条目需要你确认（可增、删、改；回车=原样接受）。当前无法询问，已保存线程。');
          const frozen = applyEdits(proposed.items, edited);
          if (!frozen.length) return this.wait('requirements_confirmation', '确认后的需求条目为空，不能冻结；请至少保留一条。');
          await this.commit('requirements', 'requirements_confirmed', undefined, { items: frozen, rawRequirement: this.rec.rawRequirement } satisfies ReqBody, 'requirements_confirmed');
          break;
        }

        case 'requirements_confirmed': {
          const req = await this.body<ReqBody>('requirements_confirmed');
          const ids = req.items.map((i) => i.id);
          const r = await this.call(
            'draft',
            this.o.planner,
            'planner',
            {
              context: { required: [...requiredItems, { name: '需求条目（已冻结）', text: formatItems(req.items) }, { name: '用户原始需求', text: req.rawRequirement }], optional },
              task: '请起草开发方案，并对每个冻结条目（按 ID）给出覆盖说明。',
            },
            (c) => coverageError(c as unknown as DraftBody, ids),
          );
          if (!r.ok) return r.outcome;
          const d = r.content as unknown as DraftBody;
          await this.commit('draft', 'draft', r.attempt, { plan: d.plan, coverage: d.coverage } satisfies DraftBody, 'drafted');
          break;
        }

        case 'drafted': {
          if (this.rec.single) {
            await this.makeChecks(undefined, undefined);
            this.rec.state = 'awaiting_approval';
            this.log('单思考者模式：跳过评审，未经独立评审 → awaiting_approval');
            await this.save();
            break;
          }
          const req = await this.body<ReqBody>('requirements_confirmed');
          const draft = await this.body<DraftBody>('draft');
          const ids = req.items.map((i) => i.id);
          // 评审者只收到：冻结条目、原始需求、必带层、按需资料、规划者“方案正文”——不收到规划者原始输出全文与推理。
          const r = await this.call(
            'review',
            this.o.reviewer!,
            'reviewer',
            {
              context: {
                required: [...requiredItems, { name: '需求条目（已冻结）', text: formatItems(req.items) }, { name: '用户原始需求', text: req.rawRequirement }],
                optional: [...optional, { name: '规划者方案正文', text: planBody(draft) }],
              },
              task: '请逐条检查冻结条目是否被方案覆盖，并找出方案的需求遗漏、风险与证据缺口。严格按要求的结构输出。',
            },
            (c) => reviewError(c as unknown as ReviewBody, ids),
          );
          if (!r.ok) return r.outcome;
          const rv = r.content as unknown as ReviewBody;
          await this.commit('review', 'review', r.attempt, { requirement_checks: rv.requirement_checks, findings: rv.findings.map((f) => ({ ...f, resolution: '' })), missing_evidence: rv.missing_evidence } satisfies ReviewBody, 'reviewed');
          break;
        }

        case 'reviewed': {
          const req = await this.body<ReqBody>('requirements_confirmed');
          const draft = await this.body<DraftBody>('draft');
          const review = await this.body<ReviewBody>('review');
          const ids = req.items.map((i) => i.id);
          const r = await this.call(
            'revise',
            this.o.planner,
            'planner',
            {
              context: {
                required: [...requiredItems, { name: '需求条目（已冻结）', text: formatItems(req.items) }, { name: '用户原始需求', text: req.rawRequirement }],
                optional: [...optional, { name: '当前方案正文', text: planBody(draft) }, { name: '评审意见', text: `${formatFindings(review.findings)}\n\n评审者需要的证据：${review.missing_evidence.join('；') || '无'}` }],
              },
              task: '请修订方案；对每条评审意见填写处理结果与理由，对每个冻结条目标注保留/修改/删除，并单独列出新增内容。',
            },
            (c) => reviseError(c as unknown as ReviseBody, ids, review.findings.length),
          );
          if (!r.ok) return r.outcome;
          const rv = r.content as unknown as ReviseBody;
          await this.commit('revise', 'revise', r.attempt, { plan: rv.plan, resolutions: rv.resolutions, item_marks: rv.item_marks, additions: rv.additions } satisfies ReviseBody, 'revised');
          break;
        }

        case 'revised': {
          const review = await this.body<ReviewBody>('review');
          const revise = await this.body<ReviseBody>('revise');
          await this.makeChecks(review.findings, revise);
          this.rec.state = 'awaiting_approval';
          await this.save();
          break;
        }

        case 'awaiting_approval':
          return this.awaitApproval();

        case 'approved': {
          const planPath = await this.writePlan();
          return { kind: 'approved', threadId: this.rec.id, planPath };
        }
        case 'task_exported':
          return { kind: 'exported', threadId: this.rec.id };
        case 'stopped':
          return { kind: 'stopped', threadId: this.rec.id, reason: this.rec.stoppedReason ?? '' };
        case 'rejected':
          return { kind: 'rejected', threadId: this.rec.id };
      }
    }
  }

  private formalSteps() {
    return this.rec.artifacts.filter((a) => a.fromAttempt && ['draft', 'review', 'revise'].includes(a.name)).map((a) => a.fromAttempt!);
  }

  private async makeChecks(findings: Finding[] | undefined, revise: ReviseBody | undefined) {
    const req = await this.body<ReqBody>('requirements_confirmed');
    const checks = await computeChecks({
      projectRoot: this.o.projectRoot,
      frozen: req.items,
      independentReview: !this.rec.single,
      findings: findings ?? [],
      ...(revise ? { revise } : {}),
      attempts: this.rec.attempts,
      formalSteps: this.formalSteps(),
    });
    const art = await this.store.writeArtifact(this.rec, 'checks', checks);
    this.log(`机械检查 v${art.version}：范围差异 ${checks.scopeDiffs.length}、待裁决阻断意见 ${checks.blockingFindings.length}、安全问题 ${checks.safetyIssues.length}`);
    await this.save();
  }

  private async finalPlan(): Promise<{ plan: string; artifact: { name: string; version: number; sha256: string } }> {
    const name = this.rec.single ? 'draft' : 'revise';
    const a = this.store.latest(this.rec, name)!;
    const b = await this.store.readArtifact<{ plan: string }>(this.rec, a);
    return { plan: b.plan, artifact: { name, version: a.version, sha256: a.sha256 } };
  }

  private async awaitApproval(): Promise<FlowOutcome> {
    const checksArt = this.store.latest(this.rec, 'checks')!;
    const checks = await this.store.readArtifact<ChecksResult>(this.rec, checksArt);
    const review = this.rec.single ? undefined : await this.body<ReviewBody>('review');

    const pending: { kind: 'finding' | 'scope'; key: string; summary: string; detail: string }[] = [];
    for (const idx of checks.blockingFindings) {
      const f = review!.findings[idx - 1]!;
      const fc = checks.findingChecks.find((c) => c.index === idx);
      pending.push({ kind: 'finding', key: String(idx), summary: `阻断意见 #${idx}：${f.problem}`, detail: `依据：${f.basis || '（空）'}（${fc?.basisStatus ?? '未经证实'}：${fc?.detail ?? ''}）\n影响：${f.impact}\n建议：${f.suggestion}\n规划者的处理结果：未解决 / 交用户裁决` });
    }
    for (const d of checks.scopeDiffs) pending.push({ kind: 'scope', key: d.key, summary: `范围差异：${d.description}`, detail: '宿主只做机械比对，不判断这个变化是否“实质”；请你逐项裁决。' });

    for (const q of pending) {
      if (this.rec.adjudications.some((a) => a.kind === q.kind && a.key === q.key)) continue;
      const ans = await this.o.ui.adjudicate(q);
      if (ans === undefined) return this.wait('adjudication', `有 ${pending.filter((p) => !this.rec.adjudications.some((a) => a.kind === p.kind && a.key === p.key)).length} 项需要你逐条裁决（${q.summary}）。当前无法询问，已保存线程。`);
      if (!ans.reason.trim()) return this.wait('adjudication', `裁决必须写一句理由（${q.summary}）。`);
      this.rec.adjudications.push({ kind: q.kind, key: q.key, decision: ans.decision, reason: ans.reason.trim(), at: this.now().toISOString() });
      this.log(`用户裁决 ${q.kind}:${q.key} → ${ans.decision}：${ans.reason.trim()}`);
      await this.save();
    }

    const blockedBecause: string[] = [...checks.safetyIssues.map((s) => `安全检查未通过：${s}`)];
    for (const d of checks.scopeDiffs) {
      const a = this.rec.adjudications.find((x) => x.kind === 'scope' && x.key === d.key);
      if (a?.decision === 'reject') blockedBecause.push(`范围差异被你驳回：${d.description}`);
    }
    const { plan } = await this.finalPlan();
    const choice = await this.o.ui.approve({ canApprove: blockedBecause.length === 0, blockedBecause, checks, planPreview: plan, independentReview: !this.rec.single });
    if (choice === undefined) return this.wait('approval', '方案等待你批准。当前无法询问，已保存线程。');
    if (choice === 'approve') {
      if (blockedBecause.length) {
        this.log(`拒绝批准：${blockedBecause.join('；')}`);
        await this.save();
        return this.wait('approval', `不能批准：${blockedBecause.join('；')}`);
      }
      this.rec.state = 'approved';
      this.log('用户批准方案');
      await this.save();
      return this.run();
    }
    if (choice === 'reject') {
      this.rec.state = 'rejected';
      this.log('用户否决方案');
      await this.save();
      return { kind: 'rejected', threadId: this.rec.id };
    }
    return this.stop('用户在批准点终止线程');
  }

  /** 批准后写 docs/plans/<日期>-<线程编号>.md（宿主写入，不自动提交，不覆盖已有文件）。 */
  private async writePlan(): Promise<string> {
    if (this.rec.plan) return path.join(this.o.projectRoot, this.rec.plan.path);
    const date = this.now().toISOString().slice(0, 10);
    const rel = path.join('docs', 'plans', `${date}-${this.rec.id}.md`);
    const req = await this.body<ReqBody>('requirements_confirmed');
    const { plan, artifact } = await this.finalPlan();
    const checks = await this.store.readArtifact<ChecksResult>(this.rec, this.store.latest(this.rec, 'checks')!);
    const lines = [
      `# 开发方案：${this.rec.id}`,
      '',
      `- 批准日期：${date}`,
      `- 线程：${this.rec.id}（过程记录在 .studio/threads/，不入库）`,
      `- 方案来源：正式产物 ${artifact.name} v${artifact.version}（sha256 ${artifact.sha256.slice(0, 16)}…）`,
      this.rec.single ? '- ⚠ **未经独立评审**（单思考者模式）' : `- 独立评审：是（规划者 ${this.rec.plannerId}，评审者 ${this.rec.reviewerId}）`,
      '',
      '## 需求条目（用户确认并冻结）',
      formatItems(req.items),
      '',
      '## 用户原始需求',
      req.rawRequirement,
      '',
      '## 方案正文',
      plan,
      '',
      '## 用户裁决记录',
      this.rec.adjudications.length ? this.rec.adjudications.map((a) => `- ${a.kind}:${a.key} → ${a.decision}：${a.reason}`).join('\n') : '（无）',
      '',
      '## 机械检查摘要',
      `- 范围差异 ${checks.scopeDiffs.length} 项，已逐项裁决；阻断意见待裁决 ${checks.blockingFindings.length} 项，已逐条裁决。`,
      `- 宿主只做机械比对与文件存在性核验，不判断语义。`,
      '',
    ];
    const text = lines.join('\n');
    await atomicWriteExclusive(path.join(this.o.projectRoot, rel), text);
    this.rec.plan = { path: rel, sha256: sha256(text), artifactVersion: artifact.version };
    this.log(`方案写入 ${rel}`);
    await this.save();
    return path.join(this.o.projectRoot, rel);
  }

  /** 由导出步骤调用：记录已导出并把状态推进到 task_exported。 */
  async markExported(info: { taskId: string; taskFile: string; manifest: string }): Promise<void> {
    if (this.rec.state !== 'approved') throw new Error(`只有 approved 状态的线程才能导出（当前 ${this.rec.state}）`);
    this.rec.exported = { ...info, at: this.now().toISOString() };
    this.rec.state = 'task_exported';
    this.log(`任务 ${info.taskId} 已导出`);
    await this.save();
  }

  async planInfo(): Promise<{ planPath: string; plan: string; req: ReqBody; sha256: string; artifactVersion: number }> {
    if (!this.rec.plan) throw new Error('方案尚未写入');
    const req = await this.body<ReqBody>('requirements_confirmed');
    const { plan, artifact } = await this.finalPlan();
    return { planPath: this.rec.plan.path, plan, req, sha256: this.rec.plan.sha256, artifactVersion: artifact.version };
  }
}

/** 用户对条目的增删改：保留原条目的 ID；新增的条目取未用过的最小编号；被删除的编号不复用。 */
export function applyEdits(original: RequirementItem[], edited: { id?: string; text: string }[]): RequirementItem[] {
  const known = new Set(original.map((i) => i.id));
  let max = original.reduce((m, i) => Math.max(m, Number(i.id.slice(1))), 0);
  const used = new Set<string>();
  const out: RequirementItem[] = [];
  for (const e of edited) {
    const text = e.text.trim();
    if (!text) continue;
    if (e.id && known.has(e.id) && !used.has(e.id)) {
      used.add(e.id);
      out.push({ id: e.id, text });
    } else {
      max += 1;
      out.push({ id: `R${max}`, text });
    }
  }
  return out;
}

function ignoredChanges(c: Record<string, unknown>): unknown {
  const rc = c.requirement_changes;
  if (Array.isArray(rc) && rc.length) return rc;
  for (const k of ['requirements', 'items', 'frozen_requirements']) if (k in c) return c[k];
  return undefined;
}

function idSetError(label: string, got: string[], ids: string[]): string | undefined {
  const missing = ids.filter((i) => !got.includes(i));
  const unknown = got.filter((i) => !ids.includes(i));
  if (missing.length) return `${label}缺少条目 ${missing.join('、')}`;
  if (unknown.length) return `${label}出现不存在的条目 ${unknown.join('、')}`;
  return undefined;
}
function coverageError(d: DraftBody, ids: string[]): string | undefined {
  if (!d.plan.trim()) return '方案正文为空';
  return idSetError('覆盖说明', d.coverage.map((c) => c.id), ids);
}
function reviewError(r: ReviewBody, ids: string[]): string | undefined {
  return idSetError('逐条检查', r.requirement_checks.map((c) => c.id), ids);
}
function reviseError(r: ReviseBody, ids: string[], findingCount: number): string | undefined {
  if (!r.plan.trim()) return '修订后的方案正文为空';
  // 遗漏标注不在此处拒绝：遗漏由宿主的范围比对列为差异，交用户裁决（见 checks.scopeCompare）
  const unknown = r.item_marks.map((m) => m.id).filter((i) => !ids.includes(i));
  if (unknown.length) return `条目标注出现不存在的条目 ${unknown.join('、')}`;
  const idx = r.resolutions.map((x) => x.index);
  for (let i = 1; i <= findingCount; i++) if (!idx.includes(i)) return `没有对评审意见 #${i} 填写处理结果`;
  if (idx.some((i) => i < 1 || i > findingCount)) return '处理结果引用了不存在的评审意见序号';
  return undefined;
}

export async function gitignoreHasStudio(projectRoot: string): Promise<boolean> {
  try {
    const t = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    return t.split('\n').some((l) => /^\/?\.studio\/?\s*$/.test(l.trim()));
  } catch {
    return false;
  }
}
