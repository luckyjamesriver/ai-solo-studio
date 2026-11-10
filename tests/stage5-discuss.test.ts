import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
