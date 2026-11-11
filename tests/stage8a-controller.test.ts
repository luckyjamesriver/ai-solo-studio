import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiSettingsStore,
  buildVerifiedExecutorOptions,
} from '../src/core/app/ai-settings.js';
import type { SecretVault } from '../src/core/app/claude-key.js';
import { buildDisclosure } from '../src/core/app/disclosure.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { ProviderProfileStore } from '../src/core/app/provider-profiles.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { PlanCard } from '../src/renderer/PlanCard.js';
import { SettingsPage } from '../src/renderer/SettingsPage.js';

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@local',
};

function makeVault(): SecretVault {
  const aesKey = crypto.randomBytes(32);
  return {
    async isAvailable() {
      return { ok: true };
    },
    async encrypt(plaintext: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    },
    async decrypt(cipherB64: string) {
      const raw = Buffer.from(cipherB64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-ctl-'));
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

async function startDualTestServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        model?: string;
        tools?: unknown[];
      };
      if (body.model === 'chat-only-model' && Array.isArray(body.tools)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'This model does not support tools or function calling' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (Array.isArray(body.tools)) {
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc_ping', type: 'function', function: { name: 'PING_TOOL', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanServers.push(server);
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/v1`;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanServers.length > 0) {
    const s = cleanServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8A 提交③ · 执行者设置持久化、控制器解析、告知清单与界面渲染', () => {
  it('AiSettingsStore 保存全局/项目执行者并拦截未测通工具调用的配置，删除配置后安全回退为 unset', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-data-'));
    cleanDirs.push(dataDir);
    const endpoint = await startDualTestServer();
    const providers = new ProviderProfileStore(dataDir, makeVault());
    const aiSettings = new AiSettingsStore(dataDir);

    const dsSave = await providers.saveAndTest({
      presetId: 'deepseek',
      endpoint,
      model: 'deepseek-chat',
      secret: 'sk-deepseek-valid-1234',
    });
    expect(dsSave.ok).toBe(true);
    if (!dsSave.ok) throw new Error('expected ok');
    expect(dsSave.profile.executorReady).toBe(true);

    const chatSave = await providers.saveAndTest({
      presetId: 'qwen',
      endpoint,
      model: 'chat-only-model',
      secret: 'sk-qwen-chatonly-9999',
    });
    expect(chatSave.ok).toBe(true);
    if (!chatSave.ok) throw new Error('expected ok');
    expect(chatSave.profile.toolCallingSupported).toBe(false);
    expect(chatSave.profile.executorReady).toBe(false);

    const profiles = await providers.listProfiles();
    const verified = buildVerifiedExecutorOptions(true, profiles);
    expect(verified.map((v) => v.id)).toEqual(['codex', `api:${dsSave.profile.id}`]);

    // 仅支持对话（不支持工具调用）的配置不能被设为执行者
    await expect(
      aiSettings.saveDefaultExecutor(`api:${chatSave.profile.id}`, verified),
    ).rejects.toThrow('不支持工具调用');

    await aiSettings.saveDefaultExecutor(`api:${dsSave.profile.id}`, verified);
    expect(await aiSettings.getDefaultExecutor()).toBe(`api:${dsSave.profile.id}`);

    const effA = await aiSettings.resolveEffectiveExecutor('/tmp/repo-a', verified);
    expect(effA.source).toBe('global');
    expect(effA.id).toBe(`api:${dsSave.profile.id}`);
    expect(effA.problem).toBeNull();

    // 项目单独覆盖为 Codex（本机）
    await aiSettings.saveProjectExecutor('/tmp/repo-b', 'custom', 'codex', verified);
    const effB = await aiSettings.resolveEffectiveExecutor('/tmp/repo-b', verified);
    expect(effB.source).toBe('project');
    expect(effB.id).toBe('codex');
    expect(effB.problem).toBeNull();

    // 删除被全局引用的 DeepSeek 配置 → 回退为 unset，且解析出明确提示
    const remaining = await providers.deleteProfile(dsSave.profile.id, (id) => aiSettings.onProviderProfileDeleted(id));
    const verifiedAfter = buildVerifiedExecutorOptions(true, remaining);
    expect(await aiSettings.getDefaultExecutor()).toBe('unset');
    const effAAfter = await aiSettings.resolveEffectiveExecutor('/tmp/repo-a', verifiedAfter);
    expect(effAAfter.id).toBe('unset');
    expect(effAAfter.label).toBe('未设置');
    expect(effAAfter.problem).toContain('未设置');
    // 独立设置 Codex 的项目 B 不受影响
    const effBAfter = await aiSettings.resolveEffectiveExecutor('/tmp/repo-b', verifiedAfter);
    expect(effBAfter.id).toBe('codex');
    expect(effBAfter.problem).toBeNull();
  });

  it('TaskController 动态绑定与切换任务执行者、禁止启动 unset 与非编辑态切换，Disclosure 同步接入服务', async () => {
    const repo = await makeGitRepo({ 'index.js': 'export const ok = 1;\n' });
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-ctl-data-'));
    cleanDirs.push(dataDir);
    const endpoint = await startDualTestServer();
    const providers = new ProviderProfileStore(dataDir, makeVault());
    const aiSettings = new AiSettingsStore(dataDir);

    const dsSave = await providers.saveAndTest({
      presetId: 'deepseek',
      endpoint,
      model: 'deepseek-chat',
      secret: 'sk-deepseek-ctl-4321',
    });
    if (!dsSave.ok) throw new Error('expected ok');
    const dsId = `api:${dsSave.profile.id}`;
    await aiSettings.saveDefaultExecutor(
      dsId,
      buildVerifiedExecutorOptions(true, await providers.listProfiles()),
    );

    const resolvedIds: string[] = [];
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(dataDir),
      aiSettings,
      getAiAvailability: async () => ({ codexAvailable: true, claudeAvailable: false }),
      getVerifiedExecutors: async () =>
        buildVerifiedExecutorOptions(true, await providers.listProfiles()),
      resolveExecutor: async (executorId) => {
        const eid = executorId ?? 'codex';
        resolvedIds.push(eid);
        return { executor: new FakeExecutor([]) };
      },
    });

    const created = await ctl.create('验证控制器执行者解析');
    expect(created.executorId).toBe(dsId);
    // DeepSeek · deepseek-chat 已含模型名时 executorText 不重复拼两次模型
    expect(created.executorText).toBe('DeepSeek · deepseek-chat（API）');
    expect(created.availableExecutors?.map((x) => x.id)).toEqual(['codex', dsId]);

    // 切换任务执行者：拒绝未通过验证的编号，允许切换到 codex 再切回 DeepSeek
    await expect(ctl.setTaskExecutor(created.id, 'api:unverified')).rejects.toThrow('尚未通过连接测试');
    const switchedToCodex = await ctl.setTaskExecutor(created.id, 'codex');
    expect(switchedToCodex.executorId).toBe('codex');
    expect(switchedToCodex.executorText).toBe('Codex（本机）');

    const switchedBack = await ctl.setTaskExecutor(created.id, dsId);
    expect(switchedBack.executorId).toBe(dsId);

    // 运行态下禁止切换任务执行者
    const planned = await ctl.savePlan(created.id, {
      goal: '测试运行态保护',
      criteria: ['完成'],
      mode: 'standard',
      network: false,
    });
    expect(planned.executorId).toBe(dsId);
    const started = await ctl.start(created.id, false);
    await expect(ctl.setTaskExecutor(started.id, 'codex')).rejects.toThrow('只有未开工的任务才能切换执行者');
    await waitUntil(async () => {
      const cur = await ctl.get(created.id);
      return cur.state === 'reviewing';
    }, 5000);
    expect(resolvedIds).toContain(dsId);
    await expect(ctl.setTaskExecutor(started.id, 'codex')).rejects.toThrow('当前阶段不能切换执行者');

    // 若新任务继承了已回退为 unset 的默认执行者，禁止启动
    await providers.deleteProfile(dsSave.profile.id, (id) => aiSettings.onProviderProfileDeleted(id));
    const unsetTask = await ctl.create('执行者已删除的任务');
    expect(unsetTask.executorId).toBe('unset');
    expect(unsetTask.executorText).toBe('未设置');
    await ctl.savePlan(unsetTask.id, {
      goal: '不应允许开跑',
      criteria: ['c1'],
      mode: 'standard',
      network: false,
    });
    await expect(ctl.start(unsetTask.id, false)).rejects.toThrow('当前执行者未设置');

    // buildDisclosure 动态列出接入并测通的 API 服务
    const disc = buildDisclosure({
      codexInstalled: false,
      claudeApiConfigured: false,
      devPersonalClaude: false,
      apiServices: [
        { name: 'DeepSeek（deepseek-chat）', role: '在施工阶段作为执行者修改任务副本中的代码' },
        { name: 'DeepSeek（deepseek-chat）', role: '在施工阶段作为执行者修改任务副本中的代码' },
      ],
    });
    expect(disc.services).toEqual([
      { name: 'DeepSeek（deepseek-chat）', role: '在施工阶段作为执行者修改任务副本中的代码' },
    ]);
  });

  it('SettingsPage 与 PlanCard 只把 executorReady=true 的配置渲染到可选执行者下拉框', () => {
    const readyProfile = {
      id: 'deepseek_11111111',
      presetId: 'deepseek' as const,
      presetName: 'DeepSeek',
      label: 'DeepSeek · deepseek-chat',
      protocol: 'openai_compat' as const,
      endpoint: 'https://api.deepseek.com/v1',
      endpointOrigin: 'https://api.deepseek.com',
      officialEndpoint: true,
      model: 'deepseek-chat',
      requiresKey: true,
      configured: true,
      available: true,
      last4: '4321',
      verifiedAt: '2026-11-11T10:00:00.000Z',
      toolCallingSupported: true,
      executorReady: true,
      toolWarning: null,
      unavailableReason: null,
    };
    const chatOnlyProfile = {
      ...readyProfile,
      id: 'qwen_22222222',
      presetId: 'qwen' as const,
      presetName: '通义千问 Qwen',
      label: '通义千问 Qwen · chat-only',
      model: 'chat-only',
      toolCallingSupported: false,
      executorReady: false,
      toolWarning: '该模型不支持 Tool Calling，不能担任执行者。',
    };

    const settingsHtml = renderToStaticMarkup(
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
          defaultExecutor: 'api:deepseek_11111111',
          verifiedExecutors: [
            { id: 'codex', label: 'Codex（本机）', kind: 'codex', officialEndpoint: true },
            { id: 'api:deepseek_11111111', label: 'DeepSeek · deepseek-chat（API）', kind: 'api', officialEndpoint: true },
          ],
          providerProfiles: [readyProfile, chatOnlyProfile],
        },
        error: null,
        onTabChange: () => undefined,
        onShowDisclosure: () => undefined,
        onRefreshEnv: () => undefined,
      }),
    );

    const globalSelect = /<select[^>]*data-testid="global-role-executor"[\s\S]*?<\/select>/.exec(settingsHtml)?.[0] ?? '';
    expect(globalSelect).toContain('value="codex"');
    expect(globalSelect).toContain('value="api:deepseek_11111111"');
    expect(globalSelect).not.toContain('qwen_22222222');
    expect(settingsHtml).toContain('仅支持对话');
    expect(settingsHtml).toContain('可执行者');
    expect(settingsHtml).toContain('尾号 4321');

    const baseTaskView = {
      id: 'task-1',
      title: '演示任务',
      request: '演示请求',
      state: 'draft' as const,
      goal: '演示目标',
      criteria: ['c1'],
      mode: 'standard' as const,
      network: false,
      extraDirs: [],
      blockedReadLocations: [],
      executorId: 'unset',
      executorText: '未设置',
      availableExecutors: [
        { id: 'codex', label: 'Codex（本机）', kind: 'codex' as const, officialEndpoint: true },
        { id: 'api:deepseek_11111111', label: 'DeepSeek · deepseek-chat（API）', kind: 'api' as const, officialEndpoint: true },
      ],
      checks: [],
      fullTrustConfirmed: false,
      updatedAt: '2026-11-11T10:00:00.000Z',
      layer: {
        boardColumn: 'planning' as const,
        statusLabel: '讨论中',
        needsUser: false,
        canDelete: true,
        primaryAction: null,
      },
      summary: '',
    };

    const planDraftHtml = renderToStaticMarkup(
      createElement(PlanCard, {
        projectId: 'p1',
        task: baseTaskView as never,
        preferredMode: 'standard',
        onChanged: () => undefined,
      }),
    );
    expect(planDraftHtml).toContain('data-testid="plan-executor-select"');
    expect(planDraftHtml).toContain('未设置（原配置已删）');
    expect(planDraftHtml).toContain('DeepSeek · deepseek-chat（API）');

    const planRunningHtml = renderToStaticMarkup(
      createElement(PlanCard, {
        projectId: 'p1',
        task: { ...baseTaskView, state: 'running' } as never,
        preferredMode: 'standard',
        onChanged: () => undefined,
      }),
    );
    expect(planRunningHtml).not.toContain('data-testid="plan-executor-select"');
  });
});
