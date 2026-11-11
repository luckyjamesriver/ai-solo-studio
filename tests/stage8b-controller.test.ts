import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiSettingsStore,
  buildVerifiedExecutorOptions,
} from '../src/core/app/ai-settings.js';
import { buildDisclosure } from '../src/core/app/disclosure.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { SubscriptionCliStore } from '../src/core/app/subscription-clis.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { findSubscriptionCliSpec } from '../src/core/executor/cli/subscriptions.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { PlanCard } from '../src/renderer/PlanCard.js';
import { SettingsPage } from '../src/renderer/SettingsPage.js';

const cleanDirs: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@local',
};

async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8b-ctl-'));
  cleanDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitEnv });
  return fs.realpath(dir);
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8B 提交③ · 订阅 CLI 状态存储、执行者解析、诚实隔离提示与设置界面渲染', () => {
  it('SubscriptionCliStore 默认不自动启用、拦截未确认风险与未登录状态，停用后全局与项目回退 unset', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8b-data-'));
    cleanDirs.push(dataDir);
    const subStore = new SubscriptionCliStore(dataDir);
    const aiSettings = new AiSettingsStore(dataDir);

    const probeInstalled = async (id: string) => {
      if (id === 'claude_cli') {
        return { installed: true, loggedIn: 'yes' as const, version: '2.1.319', note: '已安装且登录' };
      }
      if (id === 'agy') {
        return { installed: true, loggedIn: 'unknown' as const, version: '1.5.3', note: '已检测到 ACP 接口' };
      }
      return { installed: false, loggedIn: 'no' as const, note: '未安装 agent' };
    };

    const initial = await subStore.listViews((id) => probeInstalled(id));
    expect(initial.every((x) => !x.enabled && !x.executorReady)).toBe(true);
    expect(buildVerifiedExecutorOptions(true, [], initial).map((v) => v.id)).toEqual(['codex']);

    const rejectedAck = await subStore.testAndEnable(
      { cliId: 'agy', riskAck: false, model: 'gemini-2.5-pro' },
      (id) => probeInstalled(id),
    );
    expect(rejectedAck.ok).toBe(false);
    if (!rejectedAck.ok) expect(rejectedAck.message).toContain('请先阅读并勾选同意');

    const rejectedMissing = await subStore.testAndEnable(
      { cliId: 'cursor', riskAck: true },
      (id) => probeInstalled(id),
    );
    expect(rejectedMissing.ok).toBe(false);
    if (!rejectedMissing.ok) expect(rejectedMissing.message).toContain('未安装');

    const enabledAgy = await subStore.testAndEnable(
      { cliId: 'agy', riskAck: true, model: 'gemini-2.5-pro' },
      (id) => probeInstalled(id),
    );
    expect(enabledAgy.ok).toBe(true);
    if (!enabledAgy.ok) throw new Error('expected ok');
    expect(enabledAgy.item.enabled).toBe(true);
    expect(enabledAgy.item.executorReady).toBe(true);
    expect(enabledAgy.item.model).toBe('gemini-2.5-pro');

    const afterEnable = await subStore.listViews((id) => probeInstalled(id));
    const verified = buildVerifiedExecutorOptions(true, [], afterEnable);
    expect(verified.map((v) => v.id)).toEqual(['codex', 'sub:agy']);
    const agyOpt = verified.find((v) => v.id === 'sub:agy')!;
    expect(agyOpt.kind).toBe('subscription');
    expect(agyOpt.label).toBe('Antigravity CLI · gemini-2.5-pro（本机订阅）');

    await expect(aiSettings.saveDefaultExecutor('sub:cursor', verified)).rejects.toThrow('尚未确认风险说明并启用');
    await aiSettings.saveDefaultExecutor('sub:agy', verified);
    await aiSettings.saveProjectExecutor('/tmp/repo-sub-1', 'custom', 'sub:agy', verified);
    await aiSettings.saveProjectExecutor('/tmp/repo-sub-2', 'custom', 'codex', verified);

    await subStore.disable('agy', (cliId) => aiSettings.onSubscriptionDisabled(cliId));
    const afterDisable = await subStore.listViews((id) => probeInstalled(id));
    const verifiedAfterDisable = buildVerifiedExecutorOptions(true, [], afterDisable);
    expect(await aiSettings.getDefaultExecutor()).toBe('unset');
    expect((await aiSettings.resolveEffectiveExecutor('/tmp/repo-sub-1', verifiedAfterDisable)).id).toBe('unset');
    expect((await aiSettings.resolveEffectiveExecutor('/tmp/repo-sub-2', verifiedAfterDisable)).id).toBe('codex');
  });

  it('TaskController 支持切换 sub:* 执行者、构建 executorNotice 与禁止未设置启动', async () => {
    const repo = await makeGitRepo({ 'index.js': 'export const ok = true;\n' });
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8b-ctl-data-'));
    cleanDirs.push(dataDir);
    const subStore = new SubscriptionCliStore(dataDir);
    const aiSettings = new AiSettingsStore(dataDir);

    const probe = async () => ({ installed: true, loggedIn: 'yes' as const, version: '2.1.319' });
    await subStore.testAndEnable({ cliId: 'agy', riskAck: true, model: 'gemini-2.5-pro' }, probe);
    await subStore.testAndEnable({ cliId: 'claude_cli', riskAck: true, model: 'sonnet' }, probe);

    const getSubs = () => subStore.listViews(probe);
    await aiSettings.saveDefaultExecutor('sub:agy', buildVerifiedExecutorOptions(true, [], await getSubs()));

    const resolved: string[] = [];
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(dataDir),
      aiSettings,
      getAiAvailability: async () => ({ codexAvailable: true, claudeAvailable: false }),
      getVerifiedExecutors: async () => buildVerifiedExecutorOptions(true, [], await getSubs()),
      resolveExecutor: async (executorId) => {
        resolved.push(executorId ?? 'codex');
        return { executor: new FakeExecutor([]) };
      },
    });

    const created = await ctl.create('测试本机订阅 CLI 任务视图');
    expect(created.executorId).toBe('sub:agy');
    expect(created.executorText).toBe('Antigravity CLI · gemini-2.5-pro（本机订阅）');
    expect(created.executorNotice).toBe(findSubscriptionCliSpec('agy')!.isolationHonesty);
    expect(created.availableExecutors?.map((x) => x.id)).toEqual(['codex', 'sub:claude_cli', 'sub:agy']);

    const switched = await ctl.setTaskExecutor(created.id, 'sub:claude_cli');
    expect(switched.executorId).toBe('sub:claude_cli');
    expect(switched.executorNotice).toBe(findSubscriptionCliSpec('claude_cli')!.isolationHonesty);
    await expect(ctl.setTaskExecutor(created.id, 'sub:cursor')).rejects.toThrow('尚未通过连接测试');

    await ctl.savePlan(created.id, {
      goal: '验证切换执行者启动',
      criteria: ['c1'],
      mode: 'standard',
      network: false,
    });
    await ctl.start(created.id, false);
    await waitUntil(async () => (await ctl.get(created.id)).state === 'reviewing', 5000);
    expect(resolved).toContain('sub:claude_cli');

    await subStore.disable('agy', (cliId) => aiSettings.onSubscriptionDisabled(cliId));
    const unsetTask = await ctl.create('已停用继承 unset 的任务');
    expect(unsetTask.executorId).toBe('unset');
    await ctl.savePlan(unsetTask.id, { goal: '拦截开跑', criteria: ['c1'], mode: 'standard', network: false });
    await expect(ctl.start(unsetTask.id, false)).rejects.toThrow('当前执行者未设置');
  });

  it('SettingsPage、PlanCard 与 buildDisclosure 渲染本机订阅卡片、诚实隔离提示与动态服务清单', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8b-ssr-'));
    cleanDirs.push(dataDir);
    const subStore = new SubscriptionCliStore(dataDir);
    const probe = async (id: string) =>
      id === 'agy'
        ? { installed: true, loggedIn: 'unknown' as const, version: '1.5.3' }
        : { installed: true, loggedIn: 'yes' as const, version: '2.1.319' };

    await subStore.testAndEnable({ cliId: 'agy', riskAck: true, model: 'gemini-2.5-pro' }, probe);
    const subViews = await subStore.listViews(probe);
    const verified = buildVerifiedExecutorOptions(true, [], subViews);

    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        tab: 'ai',
        disc: null,
        env: null,
        aiSettings: {
          codex: { available: true, statusLabel: '可用', detail: 'ok' },
          claudeKey: { configured: false, available: false, last4: null, verifiedAt: null, unavailableReason: null },
          roles: { chief: 'codex', reviewer: 'none', claudeModel: 'claude-opus-5-5' },
          sameAiNotice: null,
          availableClaudeModels: ['claude-opus-5-5'],
          defaultExecutor: 'sub:agy',
          verifiedExecutors: verified,
          providerProfiles: [],
          subscriptionClis: subViews,
        },
        error: null,
        onTabChange: () => undefined,
        onShowDisclosure: () => undefined,
        onRefreshEnv: () => undefined,
        onSaveDefaultExecutor: async () => {
          throw new Error('unused');
        },
        onEnableSubscriptionCli: async () => {
          throw new Error('unused');
        },
        onDisableSubscriptionCli: async () => {
          throw new Error('unused');
        },
      }),
    );

    expect(html).toContain('data-testid="settings-subscription-clis"');
    expect(html).toContain('data-testid="sub-cli-card-claude_cli"');
    expect(html).toContain('data-testid="sub-cli-open-claude_cli"');
    expect(html).toContain('data-testid="sub-cli-card-agy"');
    expect(html).toContain('data-testid="sub-cli-disable-agy"');
    expect(html).toContain('v1.5.3');
    expect(html).not.toContain('vv1.5.3');
    expect(html).toContain('value="sub:agy"');

    const planHtml = renderToStaticMarkup(
      createElement(PlanCard, {
        projectId: 'p1',
        task: {
          id: 't1',
          title: '订阅任务',
          request: '订阅任务',
          state: 'draft',
          goal: '订阅任务目标',
          criteria: ['c1'],
          mode: 'standard',
          network: false,
          extraDirs: [],
          blockedReadLocations: [],
          executorId: 'sub:agy',
          executorText: 'Antigravity CLI · gemini-2.5-pro（本机订阅）',
          executorNotice: findSubscriptionCliSpec('agy')!.isolationHonesty,
          availableExecutors: verified,
          checks: [],
          fullTrustConfirmed: false,
          updatedAt: '2026-11-11T10:00:00.000Z',
          layer: {
            boardColumn: 'planning',
            statusLabel: '计划已定',
            needsUser: false,
            canDelete: true,
            primaryAction: null,
          },
          summary: '',
        } as never,
        preferredMode: 'standard',
        onChanged: () => undefined,
      }),
    );
    expect(planHtml).toContain('data-testid="plan-executor-honesty"');
    expect(planHtml).toContain(findSubscriptionCliSpec('agy')!.isolationHonesty);

    const disc = buildDisclosure({
      codexInstalled: false,
      claudeApiConfigured: false,
      devPersonalClaude: false,
      apiServices: [
        {
          name: 'Antigravity（本机订阅）',
          role: '本机订阅 CLI（风险自担，模型 gemini-2.5-pro）：担任后台执行者',
        },
      ],
    });
    expect(disc.services).toEqual([
      {
        name: 'Antigravity（本机订阅）',
        role: '本机订阅 CLI（风险自担，模型 gemini-2.5-pro）：担任后台执行者',
      },
    ]);
  });
});
