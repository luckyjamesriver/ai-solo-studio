import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskController } from '../src/core/app/task-controller.js';
import { OpenProjectManager } from '../src/core/app/open-projects.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { ManifestStore, RecordStore } from '../src/core/persistence/index.js';
import { TaskStore } from '../src/core/task/store.js';
import { PlanCard } from '../src/renderer/PlanCard.js';
import { ExternalWaitingPage } from '../src/renderer/ExternalWaitingPage.js';
import { Acceptance } from '../src/renderer/Acceptance.js';
import { ReworkPage } from '../src/renderer/ReworkPage.js';
import { makeProject, scripted } from './flow-helpers.js';
import { git, makeRepo, testSandboxRunner, tmpDir } from './helpers.js';

const cleanDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await tmpDir(prefix);
  cleanDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 7 提交①：外部执行交接导出与等待页', () => {
  it('未确认说明时拒绝导出；确认后创建副本并写入 .studio/handoff/<taskId>/task.md，保留未评审标记与验收标准', async () => {
    const repo = await makeProject();
    const data = await makeTempDir('studio-s7-data-');
    cleanDirs.push(repo);
    const revealed: string[] = [];

    const planner = scripted(
      {
        requirements: { items: [{ text: '给页面加一个版权页脚' }] },
        draft: {
          plan: '## 方案\n在 index.html 底部添加版权页脚\n## 验收建议\n- 页面底部展示版权年份\n',
          coverage: [{ id: 'R1', how: '页脚组件' }],
        },
      },
      {},
      { id: 'codex', service: 'Codex' },
    );

    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      revealPath: async (p) => {
        revealed.push(p);
      },
      prefs: new TaskPrefs(data),
      makeThinkers: (preset) => ({ preset, planner, single: true }),
    });

    const created = await ctl.create('加版权页脚');
    await ctl.startDiscussion(created.id, 'codex-single');
    await ctl.waitDiscussion(created.id);
    await ctl.confirmDiscussionSend(created.id, 'Codex', true);
    await ctl.waitDiscussion(created.id);
    await ctl.confirmDiscussionRequirements(created.id, [{ id: 'R1', text: '页面底部展示版权年份' }]);
    await ctl.waitDiscussion(created.id);
    const { task: approved } = await ctl.decideDiscussionApproval(created.id, 'approve');
    expect(approved.state).toBe('planned');
    expect(approved.planUnreviewed).toBe(true);

    // 1) 未传 ack: true 被拒绝
    await expect(ctl.exportExternalTask(approved.id, false)).rejects.toThrow(/请先确认/);

    // 2) 确认后导出：生成副本 + .studio/handoff/<taskId>/task.md + manifest
    const waiting = await ctl.exportExternalTask(approved.id, true);
    expect(waiting.state).toBe('waiting_external');
    expect(waiting.stateText).toBe('外部执行中（等待导入报告）');
    expect(waiting.executorText).toBe('外部工具');
    expect(waiting.planUnreviewed).toBe(true);
    expect(waiting.layer).toMatchObject({
      stage: 'building',
      boardColumn: 'building',
      runStatus: '外部执行中',
      workbenchGroup: 'running',
      needsAttention: false,
      isRunning: false,
    });

    const rawTask = (await new TaskStore(repo).get(approved.id))!;
    expect(rawTask.worktree).toBeTruthy();
    const realWorktree = await fs.realpath(rawTask.worktree!.path);
    const taskFile = path.join(repo, '.studio', 'handoff', approved.id, 'task.md');
    const taskMd = await fs.readFile(taskFile, 'utf8');
    expect(taskMd.split('\n')[0]).toBe(`任务编号：${approved.id}`);
    expect(taskMd).toContain('未经独立评审');
    expect(taskMd).toContain(`工作树路径：${realWorktree}`);
    expect(taskMd).toContain(`分支：${rawTask.worktree!.branch}`);
    expect(taskMd).toContain(`起始 Git HEAD：${rawTask.worktree!.baseSha}`);
    expect(taskMd).toContain('docs/PROTOCOL.md');
    expect(taskMd).toContain('页面底部展示版权年份');

    // manifest 中的工作树路径与分支对齐任务副本
    const manifest = (await new ManifestStore(repo).get(approved.id))!;
    expect(manifest.worktreePath).toBe(realWorktree);
    expect(manifest.branch).toBe(rawTask.worktree!.branch);
    expect(manifest.startHead).toBe(rawTask.worktree!.baseSha);
    expect(manifest.singleThinker).toBe(true);

    // 3) revealHandoff 能分别在访达显示 task_file 与 worktree，且严格校验参数
    await ctl.revealHandoff(approved.id, 'task_file');
    await ctl.revealHandoff(approved.id, 'worktree');
    expect(revealed).toEqual([taskFile, realWorktree]);
    await expect(ctl.revealHandoff(approved.id, 'other')).rejects.toThrow(/无效的参数/);

    // 4) PlanCard 与 ExternalWaitingPage 渲染符合 UI v2.1 规范
    const planHtml = renderToStaticMarkup(
      createElement(PlanCard, {
        projectId: 'p1',
        task: approved,
        preferredMode: 'standard',
        onChanged: () => undefined,
      }),
    );
    expect(planHtml).toContain('批准并开工');
    expect(planHtml).toContain('交给外部工具执行');

    const waitingHtml = renderToStaticMarkup(
      createElement(ExternalWaitingPage, {
        projectId: 'p1',
        task: waiting,
        onTaskChanged: () => undefined,
        onDiscarded: () => undefined,
      }),
    );
    expect(waitingHtml).toContain('外部执行中');
    expect(waitingHtml).toContain('在访达中显示');
    expect(waitingHtml).toContain('复制任务说明');
    expect(waitingHtml).toContain('取消外部执行');
    expect(waitingHtml).toContain(realWorktree);
    expect(waitingHtml).toContain('未经独立评审');
  });

  it('工作台与侧栏对「外部执行中」不计入「需要你决定」角标；「取消外部执行」走放弃流程删除副本', async () => {
    const repo = await makeProject();
    const data = await makeTempDir('studio-s7-wb-');
    cleanDirs.push(repo);

    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });
    const mgr = new OpenProjectManager<RecordStore>();
    const rs = await ctl.openRecordStore();
    mgr.open({ id: 'proj-ext', path: repo, name: 'ext-demo', controller: ctl, recordStore: rs });

    const created = await ctl.create('外部执行演示');
    await ctl.skipDiscussion(created.id);
    const savedPlan = await ctl.savePlan(created.id, {
      goal: '修改首页标题',
      criteria: ['标题显示新版名称'],
      mode: 'standard',
      network: false,
    });
    expect(savedPlan.state).toBe('planned');

    // 导出前：planned 计入 needsDecision = 1
    const wbBefore = await mgr.getWorkbench();
    expect(wbBefore.counts.needsDecision).toBe(1);

    // 导出后：显示「外部执行中」，不计入「需要你决定」角标
    const waiting = await ctl.exportExternalTask(created.id, true);
    expect(waiting.state).toBe('waiting_external');

    const wbAfter = await mgr.getWorkbench();
    expect(wbAfter.counts.needsDecision).toBe(0);
    expect(wbAfter.counts.running).toBe(1);
    expect(wbAfter.running[0]!.statusLabel).toBe('外部执行中');
    expect(wbAfter.projects[0]!.needsAttentionCount).toBe(0);

    // 取消外部执行：沿用放弃流程清理副本并进入 discarded
    const wtPath = waiting.handoff!.worktreePath;
    const discardRes = await ctl.discardTask(created.id);
    expect(discardRes.ok).toBe(true);
    expect(discardRes.view.state).toBe('discarded');
    expect(await fs.stat(wtPath).then(() => true, () => false)).toBe(false);
  });

  it('导入报告：mismatch / unverified 只读留存记录并禁入验收；bound 跑本应用检查、以副本实际为准并进验收与保存', async () => {
    const repo = await makeRepo({
      'package.json': JSON.stringify({
        name: 'ext-check-demo',
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'app.js': 'module.exports = () => "v0";\n',
    });
    const data = await makeTempDir('studio-s7-imp-data-');
    const reportDir = await makeTempDir('studio-s7-imp-rep-');
    cleanDirs.push(repo);

    let nextPicked: string | null = null;
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      pickReportFile: async () => nextPicked,
      prefs: new TaskPrefs(data),
    });

    const created = await ctl.create('改进 app 返回值');
    await ctl.skipDiscussion(created.id);
    await ctl.savePlan(created.id, {
      goal: '让 app 返回 v2 并通过测试',
      criteria: ['app.js 返回 v2'],
      mode: 'standard',
      network: false,
    });
    const waiting = await ctl.exportExternalTask(created.id, true);
    const wtPath = waiting.handoff!.worktreePath;
    const realWt = await fs.realpath(wtPath);
    const realRepo = await fs.realpath(repo);
    const raw0 = (await new TaskStore(repo).get(created.id))!;
    const startHead = raw0.worktree!.baseSha;
    const branch = raw0.worktree!.branch;

    // 0) 取消选择不改动状态；非 .md / .txt 文件拒绝导入
    nextPicked = null;
    const cancelled = await ctl.importExternalReport(created.id);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.task.state).toBe('waiting_external');

    nextPicked = path.join(reportDir, 'bad.json');
    await fs.writeFile(nextPicked, '{}');
    await expect(ctl.importExternalReport(created.id)).rejects.toThrow(/\.md 或 \.txt/);

    // 1) 来源未核实（缺少绑定信息）→ 只读停留在 waiting_external，且落盘导入记录
    const unverifiedPath = path.join(reportDir, 'unverified.md');
    await fs.writeFile(unverifiedPath, '# 外部工具报告\n已修改完成。\n');
    nextPicked = unverifiedPath;
    const resUnv = await ctl.importExternalReport(created.id);
    expect(resUnv.cancelled).toBe(false);
    expect(resUnv.verdict).toBe('unverified');
    expect(resUnv.task.state).toBe('waiting_external');
    expect(resUnv.task.handoff?.lastImport?.unverifiedReasons.length).toBeGreaterThan(0);

    const unvHtml = renderToStaticMarkup(
      createElement(ExternalWaitingPage, {
        projectId: 'p1',
        task: resUnv.task,
        onTaskChanged: () => undefined,
        onDiscarded: () => undefined,
      }),
    );
    expect(unvHtml).toContain('来源未核实');
    expect(unvHtml).toContain('重新导入报告');

    // 2) 不符（mismatch：分支写错 + 结束 HEAD 不合法）→ 只读展示矛盾项，不能保存或进验收
    const mismatchPath = path.join(reportDir, 'mismatch.txt');
    await fs.writeFile(
      mismatchPath,
      [
        `任务编号：${created.id}`,
        `仓库：${realRepo}`,
        `分支：wrong-branch`,
        `工作树路径：${realWt}`,
        `开始 HEAD：${startHead}`,
        `结束 HEAD：deadbeef`,
        '## 完成情况\n修改已完成。',
      ].join('\n'),
    );
    nextPicked = mismatchPath;
    const resMis = await ctl.importExternalReport(created.id);
    expect(resMis.verdict).toBe('mismatch');
    expect(resMis.task.state).toBe('waiting_external');
    expect(resMis.task.handoff?.lastImport?.mismatches.length).toBeGreaterThanOrEqual(2);

    const misHtml = renderToStaticMarkup(
      createElement(ExternalWaitingPage, {
        projectId: 'p1',
        task: resMis.task,
        onTaskChanged: () => undefined,
        onDiscarded: () => undefined,
      }),
    );
    expect(misHtml).toContain('不符');
    expect(misHtml).toContain('wrong-branch');

    // 导入记录都留存在 .studio/tasks/
    const taskRecordsDir = await fs.readdir(path.join(repo, '.studio', 'tasks'));
    const importLogs = taskRecordsDir.filter((f) => f.startsWith(`${created.id}.import-`) && f.endsWith('.json'));
    expect(importLogs.length).toBeGreaterThanOrEqual(2);

    // 3) 已绑定但报告自述与工作树实际冲突（未提交脏改动 + 声称已提交且 endHead 指向 baseSha）→
    //    自动暂存提交进任务副本并标出真实状态差异，跑 Studio 自有检查后进入 Acceptance！
    await fs.writeFile(path.join(wtPath, 'app.js'), 'module.exports = () => "v2";\n');
    const boundPath = path.join(reportDir, 'bound.md');
    await fs.writeFile(
      boundPath,
      [
        `任务编号：${created.id}`,
        `仓库：${realRepo}`,
        `分支：${branch}`,
        `工作树路径：${realWt}`,
        `开始 HEAD：${startHead}`,
        `结束 HEAD：${startHead}`,
        '',
        '已完成 app.js 修改，已提交并全部通过。',
      ].join('\n'),
    );
    nextPicked = boundPath;
    const resBound = await ctl.importExternalReport(created.id);
    expect(resBound.verdict).toBe('bound');
    expect(resBound.task.state).toBe('reviewing');

    const acc = await ctl.getAcceptanceView(created.id);
    expect(acc.state).toBe('reviewing');
    expect(acc.changes.map((c) => c.path)).toEqual(['app.js']);
    // 证据由本应用运行（test passed），外部报告显示在「AI 自己的说法」位置且明确标注仅供参考与实际差异
    expect(acc.items.find((i) => i.key === 'test')?.status).toBe('verified');
    expect(acc.externalReport?.badge).toBe('外部工具的报告，仅供参考');
    expect(acc.externalReport?.text).toContain('已完成 app.js 修改');
    expect(acc.externalReport?.discrepancies.length).toBeGreaterThan(0);

    const accHtml = renderToStaticMarkup(
      createElement(Acceptance, {
        projectId: 'p1',
        task: resBound.task,
        initialView: acc,
        onChanged: () => undefined,
        onBackToProject: () => undefined,
      }),
    );
    expect(accHtml).toContain('外部工具的报告，仅供参考');
    expect(accHtml).toContain('已完成 app.js 修改');
    expect(accHtml).toContain('以工作树实际内容为准');

    // 确认验收标准并保存回主项目
    await ctl.confirmCriterion(created.id, 'c0', acc.version);
    const saved = await ctl.saveTask(created.id, acc.version);
    expect(saved.ok).toBe(true);
    expect(saved.view.state).toBe('saved');
    expect(await fs.readFile(path.join(repo, 'app.js'), 'utf8')).toBe('module.exports = () => "v2";\n');
  });

  it('外部执行任务在验收页退回修改时提供「再次交给外部工具」与「改由 Codex 继续」（均记第 N+1 轮）', async () => {
    const repo = await makeRepo({ 'note.txt': 'v0\n' });
    const data = await makeTempDir('studio-s7-rework-data-');
    const reportDir = await makeTempDir('studio-s7-rework-rep-');
    cleanDirs.push(repo);

    let nextPicked: string | null = null;
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([{ do: 'write', path: 'note.txt', content: 'v2-codex\n' }]),
      pickDirectory: async () => null,
      pickReportFile: async () => nextPicked,
      prefs: new TaskPrefs(data),
    });

    const created = await ctl.create('更新说明文件');
    await ctl.skipDiscussion(created.id);
    await ctl.savePlan(created.id, { goal: '更新 note.txt', criteria: ['包含目标内容'], mode: 'standard', network: false });
    const waiting1 = await ctl.exportExternalTask(created.id, true);
    const wtPath = waiting1.handoff!.worktreePath;
    const realWt = await fs.realpath(wtPath);
    const realRepo = await fs.realpath(repo);
    const startHead = waiting1.handoff!.branch;

    await fs.writeFile(path.join(wtPath, 'note.txt'), 'v1-ext\n');
    await git(wtPath, ['add', '-A']);
    await git(wtPath, ['commit', '-m', 'ext v1']);
    const endHead1 = (await git(wtPath, ['rev-parse', 'HEAD'])).trim();
    const baseHead = (await new TaskStore(repo).get(created.id))!.worktree!.baseSha;

    const r1Path = path.join(reportDir, 'r1.md');
    await fs.writeFile(
      r1Path,
      [
        `任务编号：${created.id}`,
        `仓库：${realRepo}`,
        `分支：${startHead}`,
        `工作树路径：${realWt}`,
        `开始 HEAD：${baseHead}`,
        `结束 HEAD：${endHead1}`,
        '第 1 轮完成',
      ].join('\n'),
    );
    nextPicked = r1Path;
    await ctl.importExternalReport(created.id);
    const acc1 = await ctl.getAcceptanceView(created.id);
    expect(acc1.rework.isExternalExecution).toBe(true);

    // ReworkPage 渲染两种选择
    const rwHtml = renderToStaticMarkup(
      createElement(ReworkPage, {
        projectId: 'p1',
        view: acc1,
        onCancel: () => undefined,
        onSubmitted: () => undefined,
      }),
    );
    expect(rwHtml).toContain('再次交给外部工具');
    expect(rwHtml).toContain('改由 Codex 继续');

    // A) 选择「再次交给外部工具」→ 进入第 2 轮 waiting_external 且更新 task.md 带上修改说明
    const r2Ext = await ctl.reworkExternalTask(created.id, '请补充第二行注释');
    expect(r2Ext.state).toBe('waiting_external');
    expect(r2Ext.round).toBe(2);
    expect(r2Ext.handoff?.taskContent).toContain('请补充第二行注释');

    // 第 2 轮也导入绑定报告（第 2 轮导出时的起点 HEAD 是 endHead1），进验收后再选「改由 Codex 继续」进入第 3 轮
    await fs.writeFile(path.join(wtPath, 'note.txt'), 'v2-ext\n');
    await git(wtPath, ['add', '-A']);
    await git(wtPath, ['commit', '-m', 'ext v2']);
    const endHead2 = (await git(wtPath, ['rev-parse', 'HEAD'])).trim();
    const r2Path = path.join(reportDir, 'r2.md');
    await fs.writeFile(
      r2Path,
      [
        `任务编号：${created.id}`,
        `仓库：${realRepo}`,
        `分支：${startHead}`,
        `工作树路径：${realWt}`,
        `开始 HEAD：${endHead1}`,
        `结束 HEAD：${endHead2}`,
        '第 2 轮完成',
      ].join('\n'),
    );
    nextPicked = r2Path;
    const imp2 = await ctl.importExternalReport(created.id);
    expect(imp2.verdict).toBe('bound');
    expect(imp2.task.state).toBe('reviewing');

    // B) 选择「改由 Codex 继续」→ 第 3 轮切换为 Codex 执行
    const r3Codex = await ctl.reworkTask(created.id, '改为最终版本');
    expect(r3Codex.round).toBe(3);

    // 等待 FakeExecutor 第 3 轮完成进验收
    for (let i = 0; i < 60; i++) {
      const cur = await ctl.get(created.id);
      if (cur.state === 'reviewing') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const acc3 = await ctl.getAcceptanceView(created.id);
    expect(acc3.currentRound).toBe(3);
    expect(acc3.state).toBe('reviewing');
    expect(acc3.rework.isExternalExecution).toBe(false);
    expect(acc3.rounds).toHaveLength(3);
    expect(acc3.rounds[0]!.externalReport?.text).toContain('第 1 轮完成');
    expect(acc3.rounds[1]!.externalReport?.text).toContain('第 2 轮完成');
  });
});

