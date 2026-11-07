import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FakeThinkStep, Thinker, ThinkRequest, ThinkResult } from '../src/core/thinking/index.js';
import { buildThinkPrompt, parseStructured } from '../src/core/thinking/index.js';
import { applyEdits, ConsentStore, extractSections, FlowEngine, ThreadStore, verifyBasis, type StepName } from '../src/core/thinking/flow/index.js';
import { DRAFT, REQ, REVIEW, REVISE, J, engineFor, makeProject, makeUI, readJson, scripted, stepOf, threadDir } from './flow-helpers.js';

const STEPS: StepName[] = ['requirements', 'draft', 'review', 'revise'];
const NON_COMPLETE: FakeThinkStep[] = [
  { status: 'failed', error: '炸了' },
  { status: 'rate_limited' },
  { status: 'quota_exhausted' },
  { status: 'auth_error' },
  { status: 'timeout' },
  { raw: '这不是 JSON' }, // → incomplete
];

describe('正常路径与状态', () => {
  it('requirements_draft → … → approved：每个状态按序前进，产物带版本号，方案写入 docs/plans/', async () => {
    const root = await makeProject();
    const e = await engineFor(root, { planner: scripted() });
    await e.create('做一个深色模式，并记住选择');
    const out = await e.run();
    expect(out.kind).toBe('approved');
    const rec = e.thread;
    expect(rec.state).toBe('approved');
    const names = rec.artifacts.map((a) => `${a.name}.v${a.version}`);
    expect(names).toEqual(['requirements.v1', 'requirements_confirmed.v1', 'draft.v1', 'review.v1', 'revise.v1', 'checks.v1']);
    expect(rec.attempts.map((a) => `${a.step}#${a.n}:${a.status}`)).toEqual(['requirements#1:complete', 'draft#1:complete', 'review#1:complete', 'revise#1:complete']);
    // 状态历史（来自日志）
    const states = rec.log.map((l) => /→ 状态 (\w+)/.exec(l.text)?.[1]).filter(Boolean);
    expect(states).toEqual(['requirements_confirmed', 'drafted', 'reviewed', 'revised']);
    const plan = await fs.readFile((out as { planPath: string }).planPath, 'utf8');
    expect(plan).toContain('方案(修订)');
    expect(plan).toContain('独立评审：是');
    expect(out).toMatchObject({ planPath: path.join(root, 'docs', 'plans', '2026-11-08-T-test.md') });
    // 评审者与规划者各用各的尝试记录
    expect(rec.attempts.find((a) => a.step === 'review')!.thinkerId).toBe('fake-reviewer');
    expect(rec.attempts.every((a) => a.sent.length > 0 && a.service)).toBe(true);
  });

  it('必带层只含 PROJECT_CONTEXT 第 1、2、4 节', async () => {
    const root = await makeProject();
    const planner = scripted();
    const e = await engineFor(root, { planner });
    await e.create('x');
    await e.run();
    const first = planner.requests[0]!;
    const txt = JSON.stringify(first.context.required);
    expect(txt).toContain('一句话');
    expect(txt).toContain('核心信念');
    expect(txt).toContain('目标用户');
    expect(txt).not.toContain('SECRET-SECTION-3');
    expect(txt).not.toContain('SECRET-SECTION-5');
    expect(extractSections('## 1. a\nx\n## 3. b\ny\n## 4. c\nz', [1, 4])).toBe('## 1. a\nx\n## 4. c\nz');
  });

  it('线程状态与尝试分开：线程目录里 thread.json 记录尝试，正式产物各自成文件', async () => {
    const root = await makeProject();
    const e = await engineFor(root, { planner: scripted() });
    await e.create('x');
    await e.run();
    const rec = await readJson(path.join(threadDir(root), 'thread.json'));
    expect(rec.attempts).toHaveLength(4);
    for (const a of rec.artifacts) await fs.access(path.join(threadDir(root), a.file));
  });
});

describe('需求条目确认点', () => {
  it('未确认不能起草：无法询问时停在 requirements_confirmation，思考者没有收到起草请求', async () => {
    const root = await makeProject();
    const planner = scripted();
    const e = await engineFor(root, { planner }, makeUI({ confirmRequirements: async () => undefined }));
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'waiting', at: 'requirements_confirmation' });
    expect(e.thread.state).toBe('requirements_draft');
    expect(planner.requests.map(stepOf)).toEqual(['requirements']);
    expect(e.thread.artifacts.map((a) => a.name)).toEqual(['requirements']);
  });

  it('用户可增、删、改条目；冻结后 ID 稳定，被删编号不复用', async () => {
    const orig = [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }];
    expect(applyEdits(orig, [{ id: 'R1', text: 'a2' }, { text: 'c' }])).toEqual([{ id: 'R1', text: 'a2' }, { id: 'R3', text: 'c' }]);
    expect(applyEdits(orig, [{ id: 'R2', text: '  ' }, { id: 'R2', text: 'b' }])).toEqual([{ id: 'R2', text: 'b' }]);
    const root = await makeProject();
    const planner = scripted();
    const e = await engineFor(root, { planner }, makeUI({ confirmRequirements: async () => [{ id: 'R2', text: '记住选择（改）' }, { text: '新增一条' }] }));
    await e.create('x');
    // 条目 R1 被删，R2 改，新增 → R3；后续 coverage 需覆盖 R2、R3
    const planner2 = scripted({ draft: { plan: 'p', coverage: [{ id: 'R2', how: 'h' }, { id: 'R3', how: 'h' }] }, review: { ...REVIEW, requirement_checks: [{ id: 'R2', covered: true, note: '' }, { id: 'R3', covered: true, note: '' }] }, revise: { ...REVISE, item_marks: [{ id: 'R2', mark: '保留' }, { id: 'R3', mark: '保留' }] } });
    const reviewer2 = scripted({ review: { ...REVIEW, requirement_checks: [{ id: 'R2', covered: true, note: '' }, { id: 'R3', covered: true, note: '' }] } }, {}, { id: 'fake-reviewer', service: 'fake-service-b' });
    const e2 = await engineFor(root, { planner: planner2, reviewer: reviewer2, newId: () => 'T-edit' }, makeUI({ confirmRequirements: async () => [{ id: 'R2', text: '记住选择（改）' }, { text: '新增一条' }] }));
    await e2.create('x');
    const out = await e2.run();
    expect(out.kind).toBe('approved');
    const frozen = await new ThreadStore(root).readArtifact<{ items: unknown[] }>(e2.thread, new ThreadStore(root).latest(e2.thread, 'requirements_confirmed')!);
    expect(frozen.items).toEqual([{ id: 'R2', text: '记住选择（改）' }, { id: 'R3', text: '新增一条' }]);
    void e;
  });

  it('冻结后思考者输出试图改条目 → 被忽略并记录；冻结产物不变', async () => {
    const root = await makeProject();
    const planner = scripted({ draft: { ...DRAFT, requirement_changes: [{ id: 'R1', text: '偷偷改掉的条目' }] }, revise: { ...REVISE, items: [{ id: 'R9', text: '又一个' }] } });
    const e = await engineFor(root, { planner });
    await e.create('x');
    const out = await e.run();
    expect(out.kind).toBe('approved');
    const store = new ThreadStore(root);
    const frozen = await store.readArtifact<{ items: { id: string; text: string }[] }>(e.thread, store.latest(e.thread, 'requirements_confirmed')!);
    expect(frozen.items.map((i) => i.text)).toEqual(['加深色模式', '记住用户选择']);
    expect(e.thread.attempts.find((a) => a.step === 'draft')!.ignoredRequirementChanges).toEqual([{ id: 'R1', text: '偷偷改掉的条目' }]);
    expect(e.thread.attempts.find((a) => a.step === 'revise')!.ignoredRequirementChanges).toEqual([{ id: 'R9', text: '又一个' }]);
    expect(e.thread.log.some((l) => l.text.includes('已冻结') && l.text.includes('忽略'))).toBe(true);
    expect(e.thread.artifacts.filter((a) => a.name === 'requirements_confirmed')).toHaveLength(1);
  });
});

describe('非 complete 状态：每个步骤、每种状态', () => {
  for (const step of STEPS) {
    for (const [i, bad] of NON_COMPLETE.entries()) {
      const label = 'status' in bad ? bad.status : 'incomplete';
      it(`${step} 步骤遇到 ${label}：线程状态不前进、已有产物保留、可重试、重试产生新尝试`, async () => {
        const root = await makeProject();
        // 规划者与评审者共用同一失败位置；review 步骤由评审者承担
        const failing: Partial<Record<StepName, FakeThinkStep>> = { [step]: bad };
        const planner = scripted({}, step === 'review' ? {} : failing);
        const reviewer = scripted({}, step === 'review' ? failing : {}, { id: 'fake-reviewer', service: 'fake-service-b' });
        // 第一阶段：无法询问 → 停在 attempt_failed
        const ui1 = makeUI({ onAttemptFailed: async () => undefined });
        const e = await engineFor(root, { planner, reviewer }, ui1);
        await e.create('x');
        const out = await e.run();
        expect(out).toMatchObject({ kind: 'waiting', at: 'attempt_failed' });
        const stateAfter = e.thread.state;
        const arts = e.thread.artifacts.map((a) => `${a.name}.v${a.version}`);
        const last = e.thread.attempts.at(-1)!;
        expect(last.step).toBe(step);
        expect(last.status).toBe('status' in bad ? bad.status : 'incomplete');
        expect(last.artifact).toBeUndefined();
        expect(e.thread.lastFailure?.step).toBe(step);
        // 线程状态与产物没有因为失败而变化
        const idx = STEPS.indexOf(step);
        const expectedState = ['requirements_draft', 'requirements_confirmed', 'drafted', 'reviewed'][idx];
        expect(stateAfter).toBe(expectedState);
        expect(arts).toEqual(
          ['requirements.v1', 'requirements_confirmed.v1', 'draft.v1', 'review.v1'].slice(0, step === 'requirements' ? 0 : idx + 1),
        );
        // 第二阶段：恢复并选择“重试”→ 新尝试，不覆盖旧记录
        const planner2 = scripted();
        const reviewer2 = scripted({}, {}, { id: 'fake-reviewer', service: 'fake-service-b' });
        const e2 = await engineFor(root, { planner: planner2, reviewer: reviewer2 }, makeUI());
        await e2.load('T-test');
        const out2 = await e2.run();
        expect(out2.kind).toBe('approved');
        const stepAttempts = e2.thread.attempts.filter((a) => a.step === step);
        expect(stepAttempts.map((a) => a.n)).toEqual([1, 2]);
        expect(stepAttempts[0]!.status).toBe('status' in bad ? bad.status : 'incomplete');
        expect(stepAttempts[1]!.status).toBe('complete');
        expect(e2.thread.lastFailure).toBeUndefined();
        void i;
      });
    }
  }

  it('失败后选择“修改输入后重试”：补充说明进入下一次请求，并记录在尝试里', async () => {
    const root = await makeProject();
    const planner = scripted({}, { draft: { status: 'failed', error: 'x' } });
    let asked = 0;
    const e = await engineFor(root, { planner }, makeUI({ onAttemptFailed: async () => (asked++ === 0 ? { retryWith: '请注意只支持 Safari' } : 'retry') }));
    await e.create('x');
    expect((await e.run()).kind).toBe('approved');
    const drafts = planner.requests.filter((r) => stepOf(r) === 'draft');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.task).not.toContain('Safari');
    expect(drafts[1]!.task).toContain('请注意只支持 Safari');
    expect(e.thread.attempts.filter((a) => a.step === 'draft')[1]!.userNote).toBe('请注意只支持 Safari');
  });

  it('选择“终止线程”→ stopped，已有正式产物全部保留', async () => {
    const root = await makeProject();
    const e = await engineFor(root, { planner: scripted({}, { revise: { status: 'quota_exhausted' } }) }, makeUI({ onAttemptFailed: async () => 'stop' }));
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'stopped' });
    expect(e.thread.state).toBe('stopped');
    expect(e.thread.artifacts.map((a) => a.name)).toEqual(['requirements', 'requirements_confirmed', 'draft', 'review']);
  });

  it('不自动重试、不自动换模型：失败后思考者只被调用一次', async () => {
    const root = await makeProject();
    const planner = scripted({}, { draft: { status: 'failed' } });
    const e = await engineFor(root, { planner }, makeUI({ onAttemptFailed: async () => undefined }));
    await e.create('x');
    await e.run();
    expect(planner.requests.filter((r) => stepOf(r) === 'draft')).toHaveLength(1);
  });

  it('宿主结构检查：方案缺少对某冻结条目的覆盖说明 → 判为 incomplete，不产生正式产物', async () => {
    const root = await makeProject();
    const planner = scripted({ draft: { plan: 'p', coverage: [{ id: 'R1', how: 'h' }] } });
    const e = await engineFor(root, { planner }, makeUI({ onAttemptFailed: async () => undefined }));
    await e.create('x');
    await e.run();
    const a = e.thread.attempts.at(-1)!;
    expect(a).toMatchObject({ step: 'draft', status: 'incomplete' });
    expect(a.hostCheckError).toContain('R2');
    expect(e.thread.artifacts.some((x) => x.name === 'draft')).toBe(false);
  });

  it('思考者抛异常也只是一次失败尝试', async () => {
    const root = await makeProject();
    const boom: Thinker = { id: 'boom', displayName: 'b', service: 'svc', detect: async () => ({ available: true }), think: async () => { throw new Error('网络断了'); } };
    const e = await engineFor(root, { planner: boom }, makeUI({ onAttemptFailed: async () => undefined }));
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'waiting', at: 'attempt_failed' });
    expect(e.thread.attempts[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('网络断了') });
  });
});

describe('从磁盘恢复', () => {
  it('恢复后显示上次失败原因，并从未完成步骤继续（不重做已完成步骤）', async () => {
    const root = await makeProject();
    const p1 = scripted({}, { revise: { status: 'rate_limited', error: '限流了' } });
    const e1 = await engineFor(root, { planner: p1 }, makeUI({ onAttemptFailed: async () => undefined }));
    await e1.create('x');
    await e1.run();
    const p2 = scripted();
    const r2 = scripted({}, {}, { id: 'fake-reviewer', service: 'fake-service-b' });
    const ui = makeUI();
    const e2 = await engineFor(root, { planner: p2, reviewer: r2 }, ui);
    await e2.load('T-test');
    expect((await e2.run()).kind).toBe('approved');
    expect(ui.calls.notes.join('\n')).toMatch(/上次失败：步骤 revise（rate_limited）：限流了/);
    expect(p2.requests.map(stepOf)).toEqual(['revise']); // 只做了未完成的步骤
    expect(r2.requests).toHaveLength(0);
  });

  it('恢复时产物摘要不符 → 停止并报告，不使用旧产物，线程状态不变', async () => {
    const root = await makeProject();
    const e1 = await engineFor(root, { planner: scripted({}, { review: { status: 'failed' } }) }, makeUI({ onAttemptFailed: async () => undefined }));
    // review 由评审者执行；这里让规划者在 draft 之后失败不太直接，改用 revise 失败
    void e1;
    const p = scripted({}, { revise: { status: 'failed' } });
    const e2 = await engineFor(root, { planner: p, newId: () => 'T-tamper' }, makeUI({ onAttemptFailed: async () => undefined }));
    await e2.create('x');
    await e2.run();
    const stateBefore = e2.thread.state;
    const draftFile = path.join(threadDir(root, 'T-tamper'), 'artifacts', 'draft.v1.json');
    const j = JSON.parse(await fs.readFile(draftFile, 'utf8'));
    j.body.plan = '被篡改的方案';
    await fs.writeFile(draftFile, JSON.stringify(j, null, 2) + '\n');
    const p3 = scripted();
    const e3 = await engineFor(root, { planner: p3, newId: () => 'T-tamper' }, makeUI());
    await e3.load('T-tamper');
    const out = await e3.run();
    expect(out).toMatchObject({ kind: 'integrity_error', message: expect.stringContaining('摘要不一致') });
    expect(p3.requests).toHaveLength(0);
    expect(e3.thread.state).toBe(stateBefore);
  });

  it('恢复时产物文件缺失也停止；不会静默更换规划者', async () => {
    const root = await makeProject();
    const e = await engineFor(root, { planner: scripted({}, { revise: { status: 'failed' } }), newId: () => 'T-miss' }, makeUI({ onAttemptFailed: async () => undefined }));
    await e.create('x');
    await e.run();
    await fs.rm(path.join(threadDir(root, 'T-miss'), 'artifacts', 'review.v1.json'));
    const e2 = await engineFor(root, { planner: scripted(), newId: () => 'T-miss' }, makeUI());
    await e2.load('T-miss');
    expect(await e2.run()).toMatchObject({ kind: 'integrity_error', message: expect.stringContaining('缺失') });
    const other = scripted({}, {}, { id: 'someone-else', service: 's' });
    const e3 = await engineFor(root, { planner: other }, makeUI());
    await expect(e3.load('T-miss')).rejects.toThrow(/不会静默更换/);
  });
});

describe('机械检查与裁决', () => {
  it('范围比对：遗漏条目、标注删除、出现新增 → 逐项裁决后才进入批准', async () => {
    const root = await makeProject();
    const planner = scripted({
      revise: { ...REVISE, item_marks: [{ id: 'R2', mark: '删除', note: '嫌麻烦' }], additions: ['顺便做个动画'] }, // R1 遗漏
    });
    const ui = makeUI();
    const e = await engineFor(root, { planner }, ui);
    await e.create('x');
    const out = await e.run();
    expect(ui.calls.adjudicate.sort()).toEqual(['scope:added:1', 'scope:deleted:R2', 'scope:omitted:R1']);
    expect(out.kind).toBe('approved');
    expect(e.thread.adjudications.map((a) => a.key).sort()).toEqual(['added:1', 'deleted:R2', 'omitted:R1']);
  });

  it('用户驳回某个范围差异 → 不提供批准（批准被拒绝）', async () => {
    const root = await makeProject();
    const planner = scripted({ revise: { ...REVISE, additions: ['偷偷加的范围'] } });
    const ui = makeUI({ adjudicate: async () => ({ decision: 'reject', reason: '不要这个' }) });
    const e = await engineFor(root, { planner }, ui);
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'waiting', at: 'approval' });
    expect((ui.calls.approve[0] as { canApprove: boolean }).canApprove).toBe(false);
    expect(e.thread.state).toBe('awaiting_approval');
  });

  it('阻断意见未解决/交用户裁决 → 未裁决不能批准；裁决需要理由', async () => {
    const root = await makeProject();
    const review = { ...REVIEW, findings: [{ problem: '会泄露数据', severity: '阻断', basis: '', impact: '严重', suggestion: '别这么做', resolution: '' }] };
    const revise = { ...REVISE, resolutions: [{ index: 1, result: '交用户裁决', reason: '拿不准' }] };
    // 无法询问
    const e = await engineFor(root, { planner: scripted({ review, revise }), reviewer: scripted({ review, revise }, {}, { id: 'fake-reviewer', service: 'fake-service-b' }) }, makeUI({ adjudicate: async () => undefined }));
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'waiting', at: 'adjudication' });
    expect(e.thread.state).toBe('awaiting_approval');
    // 理由为空 → 不算裁决
    const e2 = await engineFor(root, { planner: scripted({ review, revise }), reviewer: scripted({ review, revise }, {}, { id: 'fake-reviewer', service: 'fake-service-b' }), newId: () => 'T-2' }, makeUI({ adjudicate: async () => ({ decision: 'accept', reason: '  ' }) }));
    await e2.create('x');
    expect(await e2.run()).toMatchObject({ kind: 'waiting', at: 'adjudication' });
    expect(e2.thread.adjudications).toHaveLength(0);
    // 已解决的阻断意见不需要裁决；未解决的需要
    const solved = { ...revise, resolutions: [{ index: 1, result: '已解决', reason: '改了' }] };
    const ui3 = makeUI();
    const e3 = await engineFor(root, { planner: scripted({ review, revise: solved }), reviewer: scripted({ review, revise: solved }, {}, { id: 'fake-reviewer', service: 'fake-service-b' }), newId: () => 'T-3' }, ui3);
    await e3.create('x');
    expect((await e3.run()).kind).toBe('approved');
    expect(ui3.calls.adjudicate).toEqual([]);
    // 逐条裁决后（接受并写理由）→ 可批准，裁决记入线程
    const ui4 = makeUI({ adjudicate: async () => ({ decision: 'reject', reason: '该意见不适用于本项目' }) });
    const e4 = await engineFor(root, { planner: scripted({ review, revise }), reviewer: scripted({ review, revise }, {}, { id: 'fake-reviewer', service: 'fake-service-b' }), newId: () => 'T-4' }, ui4);
    await e4.create('x');
    expect((await e4.run()).kind).toBe('approved');
    expect(e4.thread.adjudications).toMatchObject([{ kind: 'finding', key: '1', decision: 'reject', reason: '该意见不适用于本项目' }]);
  });

  it('安全检查未通过（思考者请求了工具）→ 不提供批准选项；UI 强行批准也被拒绝', async () => {
    const root = await makeProject();
    const planner = scripted();
    // 让规划者的 draft 带 refusedToolRequests
    const unsafe = new (await import('../src/core/thinking/index.js')).FakeThinker(
      (req) => ({ raw: J(stepOf(req) === 'requirements' ? REQ : stepOf(req) === 'draft' ? DRAFT : REVISE), ...(stepOf(req) === 'draft' ? { refusedToolRequests: ['Bash: ls'] } : {}) }),
      { available: true },
      { id: 'fake-planner', service: 'fake-service-a' },
    );
    void planner;
    const ui = makeUI();
    const e = await engineFor(root, { planner: unsafe }, ui);
    await e.create('x');
    const out = await e.run();
    const ctx = ui.calls.approve[0] as { canApprove: boolean; blockedBecause: string[] };
    expect(ctx.canApprove).toBe(false);
    expect(ctx.blockedBecause.join()).toMatch(/安全检查未通过.*请求了工具/);
    expect(out).toMatchObject({ kind: 'waiting', at: 'approval' });
    expect(e.thread.state).toBe('awaiting_approval');
    // 发送清单缺失同样触发
    const noManifest: Thinker = { id: 'nm', displayName: 'n', service: 's-n', detect: async () => ({ available: true }), think: async (req: ThinkRequest): Promise<ThinkResult> => {
      const raw = J(stepOf(req) === 'requirements' ? REQ : stepOf(req) === 'draft' ? DRAFT : REVISE);
      const parsed = parseStructured(raw, req.output);
      return { status: 'complete', content: parsed.ok ? parsed.content : {}, rawText: raw, sent: [], service: 's-n' };
    } };
    const ui2 = makeUI();
    const e2 = await engineFor(root, { planner: noManifest, newId: () => 'T-nm' }, ui2);
    await e2.create('x');
    await e2.run();
    expect((ui2.calls.approve[0] as { blockedBecause: string[] }).blockedBecause.join()).toContain('发送清单缺失');
  });

  it('依据核验：为空 / 文件不存在 / 文件存在（三种）+ 章节标题', async () => {
    const root = await makeProject();
    const f = (basis: string) => ({ problem: 'p', severity: '建议' as const, basis, impact: 'i', suggestion: 's', resolution: '' });
    const r = await verifyBasis(root, [f(''), f('无'), f('docs/nope.md'), f('docs/ref.md'), f('docs/ref.md#安全'), f('docs/ref.md#不存在的章节'), f('凭印象'), f('../../etc/passwd.txt')]);
    expect(r.map((x) => x.basisStatus)).toEqual(['未经证实', '未经证实', '依据无法核实', '提供了依据（文件存在）', '提供了依据（文件存在）', '依据无法核实', '未经证实', '依据无法核实']);
  });

  it('依据检查结果记入机械检查产物，并在裁决说明中展示', async () => {
    const root = await makeProject();
    const review = { ...REVIEW, findings: [{ problem: 'p', severity: '阻断', basis: 'docs/nope.md', impact: 'i', suggestion: 's', resolution: '' }] };
    const revise = { ...REVISE, resolutions: [{ index: 1, result: '未解决', reason: '不同意' }] };
    let detail = '';
    const e = await engineFor(root, { planner: scripted({ review, revise }), reviewer: scripted({ review, revise }, {}, { id: 'fake-reviewer', service: 'fake-service-b' }) }, makeUI({ adjudicate: async (q) => { detail = q.detail; return { decision: 'accept', reason: '好' }; } }));
    await e.create('x');
    await e.run();
    expect(detail).toContain('依据无法核实');
  });
});

describe('替换思考者 / 发送清单', () => {
  it('用另一个思考者类充当规划者，流程不变（不依赖 ClaudeCli）', async () => {
    const root = await makeProject();
    const seen: string[] = [];
    class OtherPlanner implements Thinker {
      readonly id = 'other-planner';
      readonly displayName = '别的规划者';
      readonly service = 'other-service';
      async detect() {
        return { available: true };
      }
      async think(req: ThinkRequest): Promise<ThinkResult> {
        seen.push(stepOf(req));
        const raw = J(stepOf(req) === 'requirements' ? REQ : stepOf(req) === 'draft' ? DRAFT : REVISE);
        const p = parseStructured(raw, req.output);
        return { status: 'complete', content: p.ok ? p.content : {}, rawText: raw, sent: buildThinkPrompt(req).sent, service: this.service };
      }
    }
    const e = await engineFor(root, { planner: new OtherPlanner() });
    await e.create('x');
    expect((await e.run()).kind).toBe('approved');
    expect(seen).toEqual(['requirements', 'draft', 'revise']);
    expect(e.thread.plannerId).toBe('other-planner');
  });

  it('评审者请求中不含规划者的原始输出全文与推理（只含方案正文）', async () => {
    const root = await makeProject();
    const planner = scripted({ draftRawPrefix: '我的内部推理：SECRET-REASONING-XYZ。我先想了很久……\n' });
    const reviewer = scripted({}, {}, { id: 'fake-reviewer', service: 'fake-service-b' });
    const e = await engineFor(root, { planner, reviewer });
    await e.create('x');
    await e.run();
    const req = reviewer.requests.find((r) => stepOf(r) === 'review')!;
    const { prompt, sent } = buildThinkPrompt(req);
    expect(prompt).not.toContain('SECRET-REASONING-XYZ');
    expect(prompt).not.toContain(planner.requests.length ? '我的内部推理' : '#');
    expect(prompt).toContain('主题开关'); // 方案正文在
    expect(prompt).toContain('R1：加深色模式'); // 冻结条目在
    expect(prompt).toContain('目标用户'); // 必带层在
    expect(sent.map((s) => s.name)).toEqual(expect.arrayContaining(['需求条目（已冻结）', '用户原始需求', '规划者方案正文']));
    expect(req.system).toMatch(/未按这个结构输出.*不完整/s); // 提示词要求足够硬
    // 评审者的发送清单写入尝试记录
    expect(e.thread.attempts.find((a) => a.step === 'review')!.sent.map((s) => s.name)).toContain('规划者方案正文');
  });

  it('首次向某服务发送前确认，按服务记录；已确认的服务不再询问；拒绝 → stopped', async () => {
    const root = await makeProject();
    const asked: string[] = [];
    const ui = makeUI({ confirmSend: async (s) => (asked.push(s), true) });
    const e = await engineFor(root, { planner: scripted() }, ui);
    await e.create('x');
    await e.run();
    expect(asked).toEqual(['fake-service-a', 'fake-service-b']);
    expect(await new ConsentStore(root).has('fake-service-a')).toBe(true);
    const asked2: string[] = [];
    const e2 = await engineFor(root, { planner: scripted(), newId: () => 'T-c2' }, makeUI({ confirmSend: async (s) => (asked2.push(s), true) }));
    await e2.create('x');
    await e2.run();
    expect(asked2).toEqual([]);
    const root3 = await makeProject();
    const p3 = scripted();
    const e3 = await engineFor(root3, { planner: p3 }, makeUI({ confirmSend: async () => false }));
    await e3.create('x');
    expect(await e3.run()).toMatchObject({ kind: 'stopped' });
    expect(p3.requests).toHaveLength(0);
    // 无法询问 → 停在确认点
    const root4 = await makeProject();
    const e4 = await engineFor(root4, { planner: scripted() }, makeUI({ confirmSend: async () => undefined }));
    await e4.create('x');
    expect(await e4.run()).toMatchObject({ kind: 'waiting', at: 'send_consent' });
  });
});

describe('预算 / 次数 / 超时', () => {
  it('调用次数上限：到达后不再发起新调用，stopped，已有产物保留', async () => {
    const root = await makeProject();
    const planner = scripted();
    const e = await engineFor(root, { planner, budget: { maxCalls: 2 } });
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'stopped', reason: expect.stringContaining('调用次数已达上限（2/2）') });
    expect(e.thread.attempts).toHaveLength(2);
    expect(e.thread.artifacts.map((a) => a.name)).toEqual(['requirements', 'requirements_confirmed', 'draft']);
    expect(e.thread.state).toBe('stopped');
  });

  it('累计费用（仅统计有费用的思考者）与累计耗时：发起新调用之前检查', async () => {
    const root = await makeProject();
    const costly = new (await import('../src/core/thinking/index.js')).FakeThinker(
      (req) => ({ raw: J(stepOf(req) === 'requirements' ? REQ : stepOf(req) === 'draft' ? DRAFT : REVISE), usage: { costUsd: 0.6 } }),
      { available: true },
      { id: 'fake-planner', service: 'fake-service-a' },
    );
    const e = await engineFor(root, { planner: costly, budget: { maxCostUsd: 1 } });
    await e.create('x');
    const out = await e.run();
    expect(out).toMatchObject({ kind: 'stopped', reason: expect.stringContaining('累计已知费用已达上限') });
    expect(e.thread.attempts.map((a) => a.step)).toEqual(['requirements', 'draft']); // 第三次调用（revise 之前的 review）之前已停
    // 耗时
    const slow: Thinker = { id: 'slow', displayName: 's', service: 'svc-slow', detect: async () => ({ available: true }), think: async (req) => {
      await new Promise((r) => setTimeout(r, 40));
      const raw = J(stepOf(req) === 'requirements' ? REQ : DRAFT);
      const p = parseStructured(raw, req.output);
      return { status: 'complete', content: p.ok ? p.content : {}, rawText: raw, sent: buildThinkPrompt(req).sent, service: 'svc-slow' };
    } };
    const root2 = await makeProject();
    const e2 = await engineFor(root2, { planner: slow, budget: { maxTotalCallMs: 30 }, now: () => new Date() });
    await e2.create('x');
    expect(await e2.run()).toMatchObject({ kind: 'stopped', reason: expect.stringContaining('累计调用耗时已达上限') });
  });

  it('单步超时作为 timeoutMs 传给思考者；timeout 状态是一次失败尝试', async () => {
    const root = await makeProject();
    const planner = scripted({}, { requirements: { status: 'timeout' } });
    const e = await engineFor(root, { planner, budget: { stepTimeoutMs: 12_345 } }, makeUI({ onAttemptFailed: async () => undefined }));
    await e.create('x');
    await e.run();
    expect(planner.requests[0]!.timeoutMs).toBe(12_345);
    expect(e.thread.attempts[0]!.status).toBe('timeout');
  });
});

describe('无法询问（无 TTY）时一律停在确认点', () => {
  it('所有确认方法都返回 undefined：停在第一个确认点，线程已保存，不默认通过', async () => {
    const root = await makeProject();
    const ui = { confirmSend: async () => undefined, confirmRequirements: async () => undefined, onAttemptFailed: async () => undefined, adjudicate: async () => undefined, approve: async () => undefined } as const;
    const e = await engineFor(root, { planner: scripted() }, ui as never);
    await e.create('x');
    expect(await e.run()).toMatchObject({ kind: 'waiting', at: 'send_consent' });
    const rec = await readJson(path.join(threadDir(root), 'thread.json'));
    expect(rec.state).toBe('requirements_draft');
    // 已确认服务后，在需求确认点停下
    await new ConsentStore(root).record('fake-service-a');
    await new ConsentStore(root).record('fake-service-b');
    const e2 = await engineFor(root, { planner: scripted() }, ui as never);
    await e2.load('T-test');
    expect(await e2.run()).toMatchObject({ kind: 'waiting', at: 'requirements_confirmation' });
    // 走到批准点：需求确认、裁决自动，仅批准无法询问
    const e3 = await engineFor(root, { planner: scripted(), newId: () => 'T-3' }, makeUI({ approve: async () => undefined }));
    await e3.create('x');
    expect(await e3.run()).toMatchObject({ kind: 'waiting', at: 'approval' });
    expect(e3.thread.state).toBe('awaiting_approval');
    expect(e3.thread.plan).toBeUndefined();
  });
});

describe('单思考者模式', () => {
  it('跳过评审；线程记录与方案文档明确标注“未经独立评审”', async () => {
    const root = await makeProject();
    const planner = scripted();
    const ui = makeUI();
    const e = await engineFor(root, { planner, single: true }, ui);
    await e.create('x');
    const out = await e.run();
    expect(out.kind).toBe('approved');
    expect(e.thread.single).toBe(true);
    expect(e.thread.attempts.map((a) => a.step)).toEqual(['requirements', 'draft']);
    expect(e.thread.log.some((l) => l.text.includes('未经独立评审'))).toBe(true);
    expect((ui.calls.approve[0] as { independentReview: boolean }).independentReview).toBe(false);
    expect(await fs.readFile((out as { planPath: string }).planPath, 'utf8')).toContain('未经独立评审');
  });

  it('非单思考者模式必须有评审者，且规划者≠评审者', async () => {
    const root = await makeProject();
    expect(() => new FlowEngine({ projectRoot: root, planner: scripted(), ui: makeUI() })).toThrow(/需要评审者/);
    expect(() => new FlowEngine({ projectRoot: root, planner: scripted(), reviewer: scripted(), ui: makeUI() })).toThrow(/不能是同一个/);
  });
});
