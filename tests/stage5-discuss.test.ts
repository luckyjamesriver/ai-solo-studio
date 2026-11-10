import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscussionViewBody, type DiscussionBodyProps } from '../src/renderer/DiscussionPage.js';
import type { DiscussionView } from '../src/core/app/discussion-service.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { TaskStore } from '../src/core/task/store.js';
import { FakeThinker } from '../src/core/thinking/fake.js';
import { ConsentStore, createPausedFlowUI, inspectDiscussion, runPausedFlow, ThreadStore } from '../src/core/thinking/flow/index.js';
import { makeProject, scripted, REQ, DRAFT, REVIEW, REVISE } from './flow-helpers.js';

const cleanDirs: string[] = [];

async function makeTempCtl(
  opts: {
    repo?: string;
    planner?: FakeThinker;
    reviewer?: FakeThinker;
    devPersonalEnabled?: boolean;
  } = {},
) {
  const repo = opts.repo ?? (await makeProject());
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s5-data-'));
  cleanDirs.push(repo, data);
  const ctl = new TaskController({
    repo,
    makeExecutor: () => new FakeExecutor([]),
    pickDirectory: async () => null,
    prefs: new TaskPrefs(data),
    devPersonalEnabled: opts.devPersonalEnabled ?? false,
    makeThinkers: (preset) => ({
      preset,
      planner: opts.planner ?? scripted(),
      ...(preset === 'dev-personal' ? { reviewer: opts.reviewer ?? scripted({}, {}, { id: 'fake-reviewer', service: 'Claude Code CLI' }) } : {}),
      single: preset === 'codex-single',
    }),
  });
  return { repo, data, ctl };
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) {
    const dir = cleanDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 5a 提交①：暂停恢复 FlowUI + 控制器驱动 + 审批落盘', () => {
  it('createPausedFlowUI 在五个需要用户决定的节点绝不默认通过，而是落盘暂停等待恢复', async () => {
    const repo = await makeProject();
    cleanDirs.push(repo);
    const consent = new ConsentStore(repo);

    // 1) 未同意外发时，FlowEngine 在第 1 步即暂停在 send_consent
    const planner = scripted();
    const first = await runPausedFlow(
      { projectRoot: repo, planner, single: true, consent, rawRequirement: '做一个深色模式' },
      {},
      { onConsentNeeded: () => undefined },
    );
    expect(first.outcome).toMatchObject({ kind: 'waiting', at: 'send_consent' });
    const tid = first.thread.id;
    const snap1 = await inspectDiscussion(repo, tid);
    expect(snap1.pauseAt).toBe('send_consent');
    expect(snap1.pendingConsentService).toBe('fake-service-a');

    // 2) 拒绝外发会干净停止；而同意外发则会执行拆解并在需求确认节点暂停
    const deny = await runPausedFlow(
      { projectRoot: repo, planner, single: true, consent: new ConsentStore(repo), threadId: tid },
      { sendConsent: { service: 'fake-service-a', allow: false } },
    );
    expect(deny.outcome).toMatchObject({ kind: 'stopped', reason: '用户未同意向“fake-service-a”发送资料' });

    // 用新线程测试同意外发后 -> 需求确认 -> 尝试失败 -> 意见裁决 -> 方案批准 全部暂停点
    const planner2 = scripted(
      {
        review: {
          ...REVIEW,
          findings: [
            {
              problem: '可能覆盖用户主题配置',
              severity: '阻断',
              basis: 'docs/ref.md#安全',
              impact: '设置丢失',
              suggestion: '合并写入',
              resolution: '',
            },
          ],
        },
        revise: {
          ...REVISE,
          resolutions: [{ index: 1, result: '交用户裁决', reason: '单文件保持简单' }],
        },
      },
      { draft: { status: 'failed', error: '网络波动' } },
    );
    const reviewer2 = scripted(
      {
        review: {
          ...REVIEW,
          findings: [
            {
              problem: '可能覆盖用户主题配置',
              severity: '阻断',
              basis: 'docs/ref.md#安全',
              impact: '设置丢失',
              suggestion: '合并写入',
              resolution: '',
            },
          ],
        },
      },
      {},
      { id: 'fake-reviewer', service: 'fake-service-a' },
    );

    const p2 = await runPausedFlow(
      { projectRoot: repo, planner: planner2, reviewer: reviewer2, consent, rawRequirement: '做一个深色模式' },
      { sendConsent: { service: 'fake-service-a', allow: true } },
    );
    expect(p2.outcome).toMatchObject({ kind: 'waiting', at: 'requirements_confirmation' });
    const snap2 = await inspectDiscussion(repo, p2.thread.id);
    expect(snap2.pauseAt).toBe('requirements_confirmation');
    expect(snap2.requirements.map((r) => r.text)).toEqual(REQ.items.map((i) => i.text));

    // 3) 确认需求后进入起草，故意遇到 failed，暂停在 attempt_failed
    const p3 = await runPausedFlow(
      { projectRoot: repo, planner: planner2, reviewer: reviewer2, consent, threadId: p2.thread.id },
      { requirements: snap2.requirements },
    );
    expect(p3.outcome).toMatchObject({ kind: 'waiting', at: 'attempt_failed' });
    const snap3 = await inspectDiscussion(repo, p2.thread.id);
    expect(snap3.pauseAt).toBe('attempt_failed');
    expect(snap3.lastFailure?.error).toBe('网络波动');

    // 4) 选择重试并继续 -> 进入 review + revise -> 因存在不采用的阻塞项，暂停在 adjudication
    const p4 = await runPausedFlow(
      { projectRoot: repo, planner: planner2, reviewer: reviewer2, consent, threadId: p2.thread.id },
      { attemptFailure: 'retry' },
    );
    expect(p4.outcome).toMatchObject({ kind: 'waiting', at: 'adjudication' });
    const snap4 = await inspectDiscussion(repo, p2.thread.id);
    expect(snap4.pauseAt).toBe('adjudication');
    expect(snap4.pendingAdjudications).toHaveLength(1);
    expect(snap4.canApprove).toBe(false);

    // 5) 裁决后不传 approval -> 暂停在 approval（绝不自动批准）
    const p5 = await runPausedFlow(
      { projectRoot: repo, planner: planner2, reviewer: reviewer2, consent, threadId: p2.thread.id },
      { adjudication: { kind: 'finding', key: '1', decision: 'reject', reason: '首版接受简单方案风险' } },
    );
    expect(p5.outcome).toMatchObject({ kind: 'waiting', at: 'approval' });
    const snap5 = await inspectDiscussion(repo, p2.thread.id);
    expect(snap5.pauseAt).toBe('approval');
    expect(snap5.canApprove).toBe(true);

    // UI 本身无传参也不会默认通过任何节点
    const idleUi = createPausedFlowUI();
    expect(await idleUi.confirmSend('x')).toBeUndefined();
    expect(await idleUi.confirmRequirements([])).toBeUndefined();
    expect(await idleUi.onAttemptFailed({ step: 'draft', attempt: {} as never, thread: {} as never })).toBeUndefined();
    expect(await idleUi.adjudicate({} as never)).toBeUndefined();
    expect(await idleUi.approve({} as never)).toBeUndefined();
  });

  it('一个任务严格绑定一个线程；默认单思考者预设标记未经独立评审并拒绝未开启的开发者预设', async () => {
    const planner = scripted({
      draft: {
        plan: '## 目标\n完成深色主题\n## 验收建议\n- 页面含夜间配色变量\n- 刷新后仍保留选择\n',
        coverage: [{ id: 'R1', how: 'css' }, { id: 'R2', how: 'storage' }],
      },
    });
    const { repo, ctl } = await makeTempCtl({ planner, devPersonalEnabled: false });

    const created = await ctl.create('做一个深色模式');
    expect(created.state).toBe('draft');

    // 未启动思考者前即可查看唯一绑定线程
    const v0 = await ctl.getDiscussionView(created.id);
    expect(v0.threadId).toBeTruthy();
    expect(v0.pauseAt).toBe('ready');
    expect(v0.preset).toBe('codex-single');
    expect(v0.canUseDevPersonal).toBe(false);
    expect(v0.unreviewed).toBe(true);
    expect(v0.unreviewedBadge).toBe('未经独立评审');

    await expect(ctl.startDiscussion(created.id, 'dev-personal')).rejects.toThrow(/未启用开发者预设/);

    // 启动单思考者讨论 -> 停在 send_consent
    await ctl.startDiscussion(created.id, 'codex-single');
    await ctl.waitDiscussion(created.id);
    const v1 = await ctl.getDiscussionView(created.id);
    expect(v1.pauseAt).toBe('send_consent');

    // 同意外发 -> 拆解需求 -> 停在 requirements_confirmation
    await ctl.confirmDiscussionSend(created.id, v1.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);
    const v2 = await ctl.getDiscussionView(created.id);
    expect(v2.pauseAt).toBe('requirements_confirmation');
    expect(v2.requirementsFrozen).toBe(false);
    expect(v2.budget.callsUsed).toBe(1);
    expect(v2.budget.knownCostUsd).toBeNull(); // FakeThinker/Codex 未提供金额时为 null

    // 确认需求 -> 起草 -> 直接到 approval（单思考者跳过独立评审）
    await ctl.confirmDiscussionRequirements(
      created.id,
      v2.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(created.id);
    const v3 = await ctl.getDiscussionView(created.id);
    expect(v3.pauseAt).toBe('approval');
    expect(v3.independentReview).toBe(false);
    expect(v3.unreviewed).toBe(true);
    expect(v3.canApprove).toBe(true);
    expect(v3.reviewRecord).toBeNull();

    // 批准后转为 Task 施工计划，标记 planUnreviewed=true
    const approved = await ctl.decideDiscussionApproval(created.id, 'approve');
    expect(approved.view.state).toBe('approved');
    expect(approved.task.state).toBe('planned');
    expect(approved.task.criteria.length).toBeGreaterThanOrEqual(2);
    const savedRaw = (await new TaskStore(repo).get(created.id))!;
    expect(savedRaw.planUnreviewed).toBe(true);
    expect(savedRaw.acceptedRisks).toEqual([]);

    // 校验底层线程归属：同一个任务查出来的线程始终不变
    const ts = new ThreadStore(repo);
    const threads = await ts.list();
    expect(threads.filter((id) => id === v0.threadId)).toHaveLength(1);
  });

  it('双思考者控制器闭环：retryWith 重试、裁决驳回必须写理由且记录为已知风险、批准写入 docs/plans', async () => {
    const planner = scripted(
      {
        revise: {
          plan: '## 方案（修订版）\n保留简洁实现方案，不引入复杂合并。\n',
          resolutions: [{ index: 1, result: '交用户裁决', reason: '超出当前最小版本范围' }],
          item_marks: [{ id: 'R1', mark: '保留' }, { id: 'R2', mark: '保留' }],
          additions: [],
        },
      },
      { draft: { status: 'failed', error: '模型超时' } },
    );
    const reviewer = scripted(
      {
        review: {
          requirement_checks: [{ id: 'R1', covered: true, note: 'ok' }, { id: 'R2', covered: true, note: 'ok' }],
          findings: [
            {
              problem: '缺少自动回退逻辑',
              severity: '阻断',
              basis: 'docs/ref.md#安全',
              impact: '出错时需人工刷新',
              suggestion: '增加自动回退',
              resolution: '',
            },
          ],
          missing_evidence: ['补充回退场景说明'],
        },
      },
      {},
      { id: 'fake-claude', service: 'Claude Code CLI' },
    );
    const { repo, ctl } = await makeTempCtl({ planner, reviewer, devPersonalEnabled: true });

    const created = await ctl.create('支持主题切换');
    await ctl.startDiscussion(created.id, 'dev-personal');
    await ctl.waitDiscussion(created.id);
    const c1 = await ctl.getDiscussionView(created.id);
    expect(c1.preset).toBe('dev-personal');
    expect(c1.canUseDevPersonal).toBe(true);

    // 同意首席外发
    await ctl.confirmDiscussionSend(created.id, c1.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);
    const r1 = await ctl.getDiscussionView(created.id);
    expect(r1.pauseAt).toBe('requirements_confirmation');

    // 确认需求 -> 起草第 1 次失败 -> attempt_failed
    await ctl.confirmDiscussionRequirements(
      created.id,
      r1.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(created.id);
    const f1 = await ctl.getDiscussionView(created.id);
    expect(f1.pauseAt).toBe('attempt_failed');

    // 用补充说明重试 -> 需要同意复核者外发
    await ctl.resolveDiscussionFailure(created.id, 'retryWith', '请给出最简目录方案');
    await ctl.waitDiscussion(created.id);
    const c2 = await ctl.getDiscussionView(created.id);
    expect(c2.pauseAt).toBe('send_consent');
    expect(c2.pendingConsentService).toBe('Claude Code CLI');

    // 同意复核者外发 -> 完成评审与修订 -> 停在 adjudication
    await ctl.confirmDiscussionSend(created.id, 'Claude Code CLI', true);
    await ctl.waitDiscussion(created.id);
    const adj = await ctl.getDiscussionView(created.id);
    expect(adj.pauseAt).toBe('adjudication');
    expect(adj.pendingAdjudications).toHaveLength(1);
    expect(adj.pendingAdjudications[0]!.basisStatus).toBe('提供了依据（文件存在）');
    expect(adj.reviewRecord?.neededMaterials).toEqual(['补充回退场景说明']);
    expect(adj.canApprove).toBe(false);

    // 驳回不写理由报错
    await expect(ctl.adjudicateDiscussion(created.id, 'finding', '1', 'reject', '')).rejects.toThrow(/理由/);

    // 驳回写明理由 -> 进入 approval
    const afterAdj = await ctl.adjudicateDiscussion(created.id, 'finding', '1', 'reject', '首版保持简单并已知晓该风险');
    expect(afterAdj.pauseAt).toBe('approval');
    expect(afterAdj.canApprove).toBe(true);

    // 批准方案 -> docs/plans 落盘 & Task.acceptedRisks 记录驳回风险
    const done = await ctl.decideDiscussionApproval(created.id, 'approve');
    expect(done.task.state).toBe('planned');
    const doneRaw = (await new TaskStore(repo).get(created.id))!;
    expect(doneRaw.planUnreviewed).toBe(false);
    expect(doneRaw.acceptedRisks).toHaveLength(1);
    expect(doneRaw.acceptedRisks?.[0]).toMatchObject({
      title: '缺少自动回退逻辑',
      reason: '首版保持简单并已知晓该风险',
    });
    const plansDir = path.join(repo, 'docs', 'plans');
    const files = await fs.readdir(plansDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);

    void DRAFT;
    void REVISE;
  });
});

function renderDiscussBody(view: DiscussionView, over: Partial<DiscussionBodyProps> = {}): string {
  const props: DiscussionBodyProps = {
    view,
    taskState: 'clarifying',
    busy: false,
    actionError: null,
    activeTab: 'summary',
    onTabChange: () => undefined,
    selectedPreset: view.preset,
    onSelectPreset: () => undefined,
    reqEdits: [],
    onChangeReqEdits: () => undefined,
    retryNote: '',
    onChangeRetryNote: () => undefined,
    rejectDrafts: {},
    onChangeRejectDraft: () => undefined,
    showFullPlan: false,
    onToggleFullPlan: () => undefined,
    modifyOpen: false,
    modifyText: view.rawRequirement,
    onToggleModify: () => undefined,
    onChangeModifyText: () => undefined,
    onStart: () => undefined,
    onSkip: () => undefined,
    onConsent: () => undefined,
    onConfirmReqs: () => undefined,
    onResolveFailure: () => undefined,
    onAdjudicate: () => undefined,
    onApproveDecision: () => undefined,
    onModifyRequirements: () => undefined,
    ...over,
  };
  return renderToStaticMarkup(createElement(DiscussionViewBody, props));
}

describe('阶段 5a 提交②：讨论页面、依据核验逐字呈现、未经独立评审、需求修改', () => {
  it('四类依据核验结论均原样渲染（不美化），且存在安全/未裁决问题时批准方案置灰并写明原因', async () => {
    const planner = scripted({
      review: undefined,
      revise: {
        plan: '## 方案（含四类依据测试）\n测试依据展示',
        resolutions: [
          { index: 1, result: '交用户裁决', reason: 'r1' },
          { index: 2, result: '交用户裁决', reason: 'r2' },
          { index: 3, result: '交用户裁决', reason: 'r3' },
          { index: 4, result: '交用户裁决', reason: 'r4' },
        ],
        item_marks: [{ id: 'R1', mark: '保留' }, { id: 'R2', mark: '保留' }],
        additions: [],
      },
    });
    const reviewer = scripted(
      {
        review: {
          requirement_checks: [{ id: 'R1', covered: true, note: '' }, { id: 'R2', covered: true, note: '' }],
          findings: [
            { problem: '依据为空', severity: '阻断', basis: '', impact: 'i1', suggestion: 's1', resolution: '' },
            { problem: '纯文字依据', severity: '阻断', basis: '常识推断无需文件', impact: 'i2', suggestion: 's2', resolution: '' },
            { problem: '文件不存在', severity: '阻断', basis: 'docs/not-found.md#缺口', impact: 'i3', suggestion: 's3', resolution: '' },
            { problem: '引用存在文件', severity: '阻断', basis: 'docs/ref.md#安全', impact: 'i4', suggestion: 's4', resolution: '' },
          ],
          missing_evidence: ['缺少压测数据'],
        },
      },
      {},
      { id: 'fake-claude', service: 'Claude Code CLI' },
    );
    const { ctl } = await makeTempCtl({ planner, reviewer, devPersonalEnabled: true });

    const created = await ctl.create('测试四类依据展示');
    await ctl.startDiscussion(created.id, 'dev-personal');
    await ctl.waitDiscussion(created.id);
    const c1 = await ctl.getDiscussionView(created.id);
    await ctl.confirmDiscussionSend(created.id, c1.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);
    const reqV = await ctl.getDiscussionView(created.id);
    await ctl.confirmDiscussionRequirements(
      created.id,
      reqV.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(created.id);
    const c2 = await ctl.getDiscussionView(created.id);
    await ctl.confirmDiscussionSend(created.id, c2.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);

    const view = await ctl.getDiscussionView(created.id);
    expect(view.pendingAdjudications).toHaveLength(4);
    expect(view.canApprove).toBe(false);

    const summaryHtml = renderDiscussBody(view);
    expect(summaryHtml).toContain('未经证实');
    expect(summaryHtml).toContain('依据为空或“无”');
    expect(summaryHtml).toContain('给出了文字依据，但没有可核验的本地文件引用，宿主无法核验');
    expect(summaryHtml).toContain('依据无法核实');
    expect(summaryHtml).toContain('docs/not-found.md（文件不存在或不在项目目录内）');
    expect(summaryHtml).toContain('提供了依据（文件存在）');
    expect(summaryHtml).toContain('宿主核实了所引用的文件（及章节标题）存在；不代表文件内容支持该意见，仍需人工判断');
    expect(summaryHtml).toContain('disabled=""');
    expect(summaryHtml).toContain('先裁决上面 4 条意见');
    // 未返回费用时不虚构金额
    expect(summaryHtml).toContain('仅按次数与时长统计');
    expect(summaryHtml).not.toMatch(/\$\d/);

    // 评审记录 tab 只读渲染：6 字段 + 缺口资料
    const recordHtml = renderDiscussBody(view, { activeTab: 'record' });
    expect(recordHtml).toContain('缺少压测数据');
    expect(recordHtml).toContain('依据为空');
    expect(recordHtml).toContain('引用存在文件');

    // 安全检查失败且已知费用时：批准方案同样置灰，Claude 费用按已知金额展示
    const blockedSafeHtml = renderDiscussBody({
      ...view,
      pendingAdjudications: [],
      safetyIssues: ['步骤 draft（第 1 次尝试）思考者请求了工具（1 次，已被拒绝）：隔离预期被打破'],
      blockedBecause: ['安全检查未通过：步骤 draft（第 1 次尝试）思考者请求了工具（1 次，已被拒绝）：隔离预期被打破'],
      canApprove: false,
      budget: { ...view.budget, knownCostUsd: 0.0425 },
    });
    expect(blockedSafeHtml).toContain('安全检查未通过');
    expect(blockedSafeHtml).toContain('$0.0425');
    expect(blockedSafeHtml).toContain('disabled=""');
  });

  it('单思考者界面隐藏「与复核对话」且标「未经独立评审」；冻结后点击修改需求终止旧线程并创建新讨论任务', async () => {
    const planner = scripted();
    const { repo, ctl } = await makeTempCtl({ planner });

    const oldTask = await ctl.create('最初的需求');
    await ctl.startDiscussion(oldTask.id, 'codex-single');
    await ctl.waitDiscussion(oldTask.id);
    const c1 = await ctl.getDiscussionView(oldTask.id);
    await ctl.confirmDiscussionSend(oldTask.id, c1.pendingConsentService!, true);
    await ctl.waitDiscussion(oldTask.id);
    const r1 = await ctl.getDiscussionView(oldTask.id);
    await ctl.confirmDiscussionRequirements(
      oldTask.id,
      r1.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(oldTask.id);

    const singleView = await ctl.getDiscussionView(oldTask.id);
    const html = renderDiscussBody(singleView);
    expect(html).toContain('未经独立评审');
    expect(html).toContain('与首席对话');
    expect(html).not.toContain('与复核对话');

    // 冻结后修改需求 -> 旧线程停机、旧任务放弃、返回绑定新线程的新任务
    const nextTask = await ctl.modifyDiscussionRequirements(oldTask.id, '修改后的新需求：增加导出');
    expect(nextTask.id).not.toBe(oldTask.id);
    expect(nextTask.request).toBe('修改后的新需求：增加导出');
    expect(nextTask.state).toBe('draft');

    const oldThread = await new ThreadStore(repo).load(singleView.threadId);
    expect(oldThread.state).toBe('stopped');
    expect(oldThread.stoppedReason).toContain('修改需求');

    const nextView = await ctl.getDiscussionView(nextTask.id);
    expect(nextView.threadId).not.toBe(singleView.threadId);
    expect(nextView.pauseAt).toBe('ready');
    expect(nextView.rawRequirement).toBe('修改后的新需求：增加导出');
  });
});

describe('阶段 5a 提交③：每个思考者的独立对话与隔离边界', () => {
  it('复核对话严格隔离（绝不传首席原始输出/决议/首席对话）；首席对话不传复核对话；未授权外发与预算超限均拦截；评审产物不变', async () => {
    const CHIEF_RAW_SECRET = 'CHIEF_RAW_PREFIX_SECRET_XYZ';
    const CHIEF_RESOLUTION_SECRET = 'CHIEF_RESOLUTION_INTERNAL_SECRET_777';
    const CHIEF_CHAT_USER_SECRET = 'USER_TO_CHIEF_ONLY_SECRET_111';
    const CHIEF_CHAT_REPLY_SECRET = 'CHIEF_ONLY_REPLY_SECRET_222';
    const REVIEWER_CHAT_USER_SECRET = 'USER_TO_REVIEWER_ONLY_SECRET_333';
    const REVIEWER_CHAT_REPLY_SECRET = 'REVIEWER_ONLY_REPLY_SECRET_444';

    const planner = new FakeThinker(
      (req) => {
        if (req.output.required.includes('reply')) {
          return { raw: JSON.stringify({ reply: CHIEF_CHAT_REPLY_SECRET }), model: 'm-planner' };
        }
        if (req.output.required.includes('items')) {
          return { raw: JSON.stringify(REQ), model: 'm-planner' };
        }
        if (req.output.required.includes('coverage')) {
          return { raw: `${CHIEF_RAW_SECRET}\n${JSON.stringify(DRAFT)}`, model: 'm-planner' };
        }
        return {
          raw: JSON.stringify({
            plan: '## 方案（修订版）\n保留核心配色逻辑。',
            resolutions: [{ index: 1, result: '交用户裁决', reason: CHIEF_RESOLUTION_SECRET }],
            item_marks: [{ id: 'R1', mark: '保留' }, { id: 'R2', mark: '保留' }],
            additions: [],
          }),
          model: 'm-planner',
        };
      },
      { available: true },
      { id: 'fake-planner', service: 'Codex CLI' },
    );

    const reviewer = new FakeThinker(
      (req) => {
        if (req.output.required.includes('reply')) {
          return { raw: JSON.stringify({ reply: REVIEWER_CHAT_REPLY_SECRET }), model: 'm-reviewer' };
        }
        return {
          raw: JSON.stringify({
            ...REVIEW,
            findings: [
              {
                problem: '深色图片未处理',
                severity: '阻断',
                basis: 'docs/ref.md#安全',
                impact: '对比度不足',
                suggestion: '降低亮度',
                resolution: '',
              },
            ],
          }),
          model: 'm-reviewer',
        };
      },
      { available: true },
      { id: 'fake-reviewer', service: 'Claude Code CLI' },
    );

    const { repo, ctl } = await makeTempCtl({ planner, reviewer, devPersonalEnabled: true });
    const created = await ctl.create('深色模式讨论隔离验证');
    await ctl.startDiscussion(created.id, 'dev-personal');
    await ctl.waitDiscussion(created.id);

    // 1) 未同意外发给复核之前尝试发起复核对话 -> 被拦截，复核零调用
    const c1 = await ctl.getDiscussionView(created.id);
    await expect(ctl.sendDiscussionChat(created.id, 'reviewer', '提前问复核')).rejects.toThrow(/尚未同意向/);
    expect(reviewer.requests).toHaveLength(0);

    // 2) 走完首席拆解、冻结需求、起草
    await ctl.confirmDiscussionSend(created.id, c1.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);
    const reqV = await ctl.getDiscussionView(created.id);
    await ctl.confirmDiscussionRequirements(
      created.id,
      reqV.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(created.id);

    // 3) 同意复核外发并完成评审与修订 -> 停在 adjudication
    const c2 = await ctl.getDiscussionView(created.id);
    await ctl.confirmDiscussionSend(created.id, c2.pendingConsentService!, true);
    await ctl.waitDiscussion(created.id);

    const ts = new ThreadStore(repo);
    const threadBefore = await ts.load(c2.threadId);
    const reviewArtBefore = ts.latest(threadBefore, 'review')!;
    const reviewFileBefore = await fs.readFile(path.join(repo, '.studio', 'threads', c2.threadId, reviewArtBefore.file), 'utf8');

    // 4) 先与首席对话
    const afterPlannerChat = await ctl.sendDiscussionChat(created.id, 'planner', CHIEF_CHAT_USER_SECRET);
    expect(afterPlannerChat.chats.planner.map((m) => m.text)).toEqual([
      CHIEF_CHAT_USER_SECRET,
      CHIEF_CHAT_REPLY_SECRET,
    ]);
    expect(afterPlannerChat.chats.reviewer).toEqual([]);

    // 5) 再与复核对话
    const afterReviewerChat = await ctl.sendDiscussionChat(created.id, 'reviewer', REVIEWER_CHAT_USER_SECRET);
    expect(afterReviewerChat.chats.reviewer).toHaveLength(2);
    expect(afterReviewerChat.chats.reviewer[1]!.postReview).toBe(true);

    // 核对发给复核的请求（包含第 1 次评审和这次复核对话）：绝不含首席原始前缀、首席 resolution 理由或首席对话！
    expect(reviewer.requests).toHaveLength(2);
    for (const req of reviewer.requests) {
      const payload = JSON.stringify(req);
      expect(payload).not.toContain(CHIEF_RAW_SECRET);
      expect(payload).not.toContain(CHIEF_RESOLUTION_SECRET);
      expect(payload).not.toContain(CHIEF_CHAT_USER_SECRET);
      expect(payload).not.toContain(CHIEF_CHAT_REPLY_SECRET);
    }
    const reviewerChatPayload = JSON.stringify(reviewer.requests[1]!);
    expect(reviewerChatPayload).toContain('保留核心配色逻辑');
    expect(reviewerChatPayload).toContain('深色图片未处理');

    // 6) 再跟首席发第二句：首席请求绝不含复核对话内容！
    await ctl.sendDiscussionChat(created.id, 'planner', '继续追问首席');
    for (const req of planner.requests) {
      const payload = JSON.stringify(req);
      expect(payload).not.toContain(REVIEWER_CHAT_USER_SECRET);
      expect(payload).not.toContain(REVIEWER_CHAT_REPLY_SECRET);
    }

    // 7) 正式 review 产物原封不动；预算 callsUsed 正确计入对话次数；界面标出“评审后的讨论 · 非独立评审”和修改需求提示
    const reviewFileAfter = await fs.readFile(path.join(repo, '.studio', 'threads', c2.threadId, reviewArtBefore.file), 'utf8');
    expect(reviewFileAfter).toBe(reviewFileBefore);

    const finalView = await ctl.getDiscussionView(created.id);
    // 4 次主流程（requirements/draft/review/revise）+ 3 次对话 = 7 次调用
    expect(finalView.budget.callsUsed).toBe(7);

    const reviewerTabHtml = renderDiscussBody(finalView, { activeTab: 'reviewer-chat' });
    expect(reviewerTabHtml).toContain('评审后的讨论 · 非独立评审');
    expect(reviewerTabHtml).toContain('想改需求，请用「修改需求」');
    expect(reviewerTabHtml).toContain(REVIEWER_CHAT_REPLY_SECRET);
    expect(reviewerTabHtml).not.toContain(CHIEF_CHAT_USER_SECRET);

    const plannerTabHtml = renderDiscussBody(finalView, { activeTab: 'planner-chat' });
    expect(plannerTabHtml).toContain('想改需求，请用「修改需求」');
    expect(plannerTabHtml).toContain(CHIEF_CHAT_REPLY_SECRET);
    expect(plannerTabHtml).not.toContain(REVIEWER_CHAT_USER_SECRET);

    // 8) 对话消耗预算达到上限后立即拦截并不再调用思考者
    const threadRec = await ts.load(c2.threadId);
    threadRec.budget.maxCalls = threadRec.attempts.length;
    await ts.save(threadRec);
    const reqCountBeforeBudgetStop = planner.requests.length;
    await expect(ctl.sendDiscussionChat(created.id, 'planner', '超预算提问')).rejects.toThrow(/调用次数已达上限/);
    expect(planner.requests).toHaveLength(reqCountBeforeBudgetStop);
  });

  it('单思考者模式下禁止发起复核对话', async () => {
    const planner = scripted();
    const { ctl } = await makeTempCtl({ planner });
    const created = await ctl.create('单思考者聊天限制');
    await expect(ctl.sendDiscussionChat(created.id, 'reviewer', '问复核')).rejects.toThrow(/单思考者模式下没有复核思考者/);
  });
});
