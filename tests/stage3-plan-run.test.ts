import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codexLaunchConfig, standardDenyList } from '../src/core/executor/adapters/codex.js';
import { sensitiveFallbackList } from '../src/core/executor/modes.js';
import { resolveCapabilities } from '../src/core/capabilities/model.js';
import { describePermissions } from '../src/core/app/permission-text.js';
import { buildTaskView } from '../src/core/app/task-view.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { PlanCard } from '../src/renderer/PlanCard.js';
import type { Task } from '../src/core/task/model.js';

const tmpDirs: string[] = [];

function mk(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-s3-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

function initRepo(files: Record<string, string> = { 'index.html': '<h1>init</h1>\n' }): string {
  const repo = path.join(mk('repo'), 'proj');
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('阶段 3 · 第一节 3a/4：施工计划确认页与权限现状', () => {
  it('标准模式真实沙箱配置：仅拒绝固定敏感清单，副本外普通文件夹默认可读，只对额外目录授予可写', () => {
    const worktree = '/proj/.studio/worktrees/t1';
    const outsideNonSensitive = '/proj/shared-notes';
    const capsBase = resolveCapabilities();
    const capsWithExtra = resolveCapabilities({ extraWritableDirs: [outsideNonSensitive] });

    const cfgBase = codexLaunchConfig(worktree, { capabilities: capsBase });
    const cfgExtra = codexLaunchConfig(worktree, { capabilities: capsWithExtra });
    const profileBase = cfgBase.args.find((a) => a.startsWith('permissions.'))!;
    const profileExtra = cfgExtra.args.find((a) => a.startsWith('permissions.'))!;

    // 1. 读取拒绝清单仅为 sensitiveFallbackList，不会拒绝 user home 或普通外部目录
    expect(standardDenyList(worktree, [])).toEqual(sensitiveFallbackList());
    expect(profileBase).toContain('extends=":workspace"');
    for (const s of sensitiveFallbackList()) expect(profileBase).toContain(`"${s}"="deny"`);
    expect(profileBase).not.toContain(`"${os.homedir()}"="deny"`);
    expect(profileBase).not.toContain(`"${outsideNonSensitive}"="deny"`);

    // 2. 不加额外目录时只有任务副本可写（/tmp 与 $TMPDIR 也显式收回为只读）；加了额外目录只多一条 write
    expect(profileBase).toContain(`"${worktree}"="write"`);
    expect(profileBase).toContain('":slash_tmp"="read"');
    expect(profileBase).toContain('":tmpdir"="read"');
    expect(profileBase).not.toContain(`"${outsideNonSensitive}"="write"`);
    expect(profileExtra).toContain(`"${outsideNonSensitive}"="write"`);

    // 3. 权限摘要同样如实声明其他位置仍可读
    const desc = describePermissions({
      mode: 'standard',
      approvalPolicy: 'never',
      networkEnabled: false,
      allowedDomains: [],
      writableRoots: [worktree, outsideNonSensitive],
      summary: 'std',
    })!;
    expect(desc.lines.join('\n')).toContain('已阻止读取密钥、账号凭证等敏感位置，其他位置 AI 仍可读取');
  });

  it('approved 状态修改验收标准：通过 edit_plan 回到 planned（待开工确认），清除授权并给出提示；重新批准后清除', async () => {
    const repo = initRepo({ 'index.html': '<h1>v0</h1>\n' });
    const runner = new TaskRunner({
      repo,
      executor: new FakeExecutor([{ do: 'write', path: 'index.html', content: '<h1>v1</h1>\n' }]),
      runChecks: false,
    });
    const t0 = await runner.create('改标题');
    await runner.setPlan(t0.id, {
      goal: '改标题',
      inScope: [],
      outOfScope: [],
      criteria: ['标题已更新'],
      risks: [],
      irreversible: [],
      capabilities: { constructionMode: 'full_trust' },
    });
    const approved = await runner.approve(t0.id);
    await runner.confirmFullTrust(t0.id);
    expect(approved.state).toBe('approved');

    // 通过 TaskController.savePlan 修改验收标准
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs')),
    });
    const afterEdit = await ctl.savePlan(t0.id, {
      goal: '改标题',
      criteria: ['标题已更新', '字体清晰'],
      mode: 'full_trust',
      network: false,
    });

    expect(afterEdit.state).toBe('planned');
    expect(afterEdit.layer.runStatus).toBe('待开工确认');
    expect(afterEdit.reapproveNotice).toBe('改了验收标准，需要重新确认后才能开工');
    expect(afterEdit.fullTrustConfirmed).toBe(false);

    const rawAfterEdit = (await runner.store.get(t0.id))!;
    expect(rawAfterEdit.checkAuth).toBeUndefined();
    expect(rawAfterEdit.timeline.some((e) => e.kind === 'state' && e.text === 'approved → planned')).toBe(true);

    // 重新批准后，提示清除
    const reapproved = await runner.approve(t0.id);
    expect(reapproved.state).toBe('approved');
    expect(reapproved.reapproveNotice).toBeUndefined();
  });

  it('PlanCard 渲染 #04-plan 两栏版式：不提供改为只读/更换/导出，授权额外目录显示路径与固定警示，且仅「批准并开工」为主按钮', () => {
    const t: Task = {
      id: 'task-plan-1',
      request: '增加深色模式',
      state: 'planned',
      executorId: 'codex',
      executorName: 'Codex',
      reapproveNotice: '改了验收标准，需要重新确认后才能开工',
      plan: {
        goal: '增加深色模式',
        inScope: [],
        outOfScope: [],
        criteria: ['支持深浅切换'],
        risks: [],
        irreversible: [],
        capabilities: resolveCapabilities({ extraWritableDirs: ['/data/shared-assets'] }),
      },
      criteria: [{ text: '支持深浅切换' }],
      denied: [],
      deniedAcks: [],
      previewed: false,
      timeline: [],
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
    };
    const view = buildTaskView(t, { scripts: ['build', 'test'], running: false });
    const html = renderToStaticMarkup(
      React.createElement(PlanCard, {
        projectId: 'proj-1',
        task: view,
        preferredMode: 'standard',
        onChanged: () => {},
      }),
    );

    expect(html).toContain('施工计划 · 开工前最后确认');
    expect(html).toContain('改了验收标准，需要重新确认后才能开工');
    expect(html).toContain('/data/shared-assets · 可读写');
    expect(html).toContain('这个文件夹不在副本里，AI 会直接修改它，施工中就会变化；停止、放弃、撤销都无法还原这里的改动。');
    expect(html).toContain('AI 可以读取你电脑上的其他文件（凭证类文件除外）。');
    expect(html).not.toContain('改为只读');
    expect(html).not.toContain('更换');
    expect(html).not.toContain('导出');
    expect(html).toContain('执行者：Codex');
    expect(html).toContain('构建检查');
    expect(html).toContain('自动测试');

    // 验证仅有「批准并开工」一个主按钮（不带 secondary / link）
    const primaryButtons = [...html.matchAll(/<button[^>]*>/g)].filter((m) => !/class="[^"]*(?:secondary|link)/.test(m[0]));
    expect(primaryButtons).toHaveLength(1);
    expect(primaryButtons[0]![0]).toContain('data-testid="start-button"');
  });
});
