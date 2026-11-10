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
import { makeProject, scripted } from './flow-helpers.js';
import { tmpDir } from './helpers.js';

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
});
