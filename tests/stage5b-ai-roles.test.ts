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
  buildSameAiNotice,
  DEFAULT_GLOBAL_AI_ROLES,
  providerDisplayName,
} from '../src/core/app/ai-settings.js';
import { ClaudeKeyStore, type SecretVault } from '../src/core/app/claude-key.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { ClaudeApiThinker, DEFAULT_CLAUDE_API_MODEL } from '../src/core/thinking/index.js';
import { ThreadStore } from '../src/core/thinking/flow/index.js';
import { DiscussionViewBody } from '../src/renderer/DiscussionPage.js';
import { SettingsPage } from '../src/renderer/SettingsPage.js';
import { DRAFT, makeProject, REQ, REVIEW, REVISE, scripted } from './flow-helpers.js';

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

function makeCryptoVault(): SecretVault {
  const aesKey = crypto.randomBytes(32);
  return {
    async isAvailable() {
      return { ok: true };
    },
    async encrypt(plaintext: string) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    async decrypt(cipherB64: string) {
      const raw = Buffer.from(cipherB64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

async function startFakeAnthropicFlowServer() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        max_tokens?: number;
        messages?: { content?: string }[];
      };
      const userPrompt = body.messages?.[0]?.content ?? '';
      let payload: unknown = { ok: true };
      if ((body.max_tokens ?? 0) > 50) {
        if (userPrompt.includes('"resolutions"')) payload = REVISE;
        else if (userPrompt.includes('"requirement_checks"')) payload = REVIEW;
        else if (userPrompt.includes('"coverage"')) payload = DRAFT;
        else payload = REQ;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          model: DEFAULT_CLAUDE_API_MODEL,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          usage: { input_tokens: 180, output_tokens: 60 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanServers.push(server);
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/v1/messages`;
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
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

describe('阶段 5b 提交④：AI 接入与角色设置、优先级覆盖、同 AI 单思考者与线程隔离', () => {
  it('默认角色为 首席=Codex / 复核=不复核；选未接入 AI 不允许保存；项目设置覆盖全局设置', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-roles-data-'));
    const repoA = await makeProject();
    const repoB = await makeProject();
    cleanDirs.push(dataDir, repoA, repoB);

    const store = new AiSettingsStore(dataDir);
    expect(await store.getGlobalRoles()).toEqual(DEFAULT_GLOBAL_AI_ROLES);

    // 未接入 Claude 时禁止保存选择 Claude（全局与项目）
    await expect(
      store.saveGlobalRoles({ chief: 'claude', reviewer: 'codex' }, { codexAvailable: true, claudeAvailable: false }),
    ).rejects.toThrow(/Claude 尚未接入/);
    await expect(
      store.saveGlobalRoles({ chief: 'codex', reviewer: 'claude' }, { codexAvailable: false, claudeAvailable: false }),
    ).rejects.toThrow(/Codex 尚未接入/);
    await expect(
      store.saveProjectRoles(repoA, { mode: 'custom', chief: 'claude', reviewer: 'none' }, { codexAvailable: true, claudeAvailable: false }),
    ).rejects.toThrow(/Claude 尚未接入/);

    // 接入 Claude 与 Codex 后：全局设置 首席=Claude, 复核=Codex
    await store.saveGlobalRoles(
      { chief: 'claude', reviewer: 'codex', claudeModel: DEFAULT_CLAUDE_API_MODEL },
      { codexAvailable: true, claudeAvailable: true },
    );

    // repoB 跟随全局设置；repoA 单独设为 首席=Codex, 复核=不复核
    await store.saveProjectRoles(
      repoA,
      { mode: 'custom', chief: 'codex', reviewer: 'none' },
      { codexAvailable: true, claudeAvailable: true },
    );

    const effA = await store.resolveEffectiveRoles(repoA, { codexAvailable: true, claudeAvailable: true });
    expect(effA).toMatchObject({ source: 'project', chief: 'codex', reviewer: 'none', single: true, sameAi: false });

    const effB = await store.resolveEffectiveRoles(repoB, { codexAvailable: true, claudeAvailable: true });
    expect(effB).toMatchObject({ source: 'global', chief: 'claude', reviewer: 'codex', single: false, sameAi: false });

    // repoA 改回「跟随全局设置」后生效为 Claude + Codex
    await store.saveProjectRoles(repoA, { mode: 'global' }, { codexAvailable: true, claudeAvailable: true });
    const effA2 = await store.resolveEffectiveRoles(repoA, { codexAvailable: true, claudeAvailable: true });
    expect(effA2).toMatchObject({ source: 'global', chief: 'claude', reviewer: 'codex', single: false });
  });

  it('首席与复核选同一 AI 时：设置页给出「未经独立评审」说明，引擎按单思考者运行且隐藏与复核对话', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-sameai-data-'));
    const repo = await makeProject();
    cleanDirs.push(dataDir, repo);

    const aiSettings = new AiSettingsStore(dataDir);
    await aiSettings.saveGlobalRoles(
      { chief: 'claude', reviewer: 'claude', claudeModel: DEFAULT_CLAUDE_API_MODEL },
      { codexAvailable: true, claudeAvailable: true },
    );
    expect(buildSameAiNotice('claude', 'claude')).toContain('未经独立评审');

    const htmlSettings = renderToStaticMarkup(
      createElement(SettingsPage, {
        tab: 'ai',
        disc: null,
        env: null,
        aiSettings: {
          codex: { available: true, statusLabel: '可用', detail: 'ok' },
          claudeKey: { configured: true, available: true, last4: '1234', verifiedAt: null, unavailableReason: null },
          roles: { chief: 'claude', reviewer: 'claude', claudeModel: DEFAULT_CLAUDE_API_MODEL },
          sameAiNotice: buildSameAiNotice('claude', 'claude'),
          availableClaudeModels: [DEFAULT_CLAUDE_API_MODEL],
        },
        error: null,
        onTabChange: () => undefined,
        onShowDisclosure: () => undefined,
        onRefreshEnv: () => undefined,
      }),
    );
    expect(htmlSettings).toContain('未经独立评审');
    expect(htmlSettings).toContain('data-testid="global-role-executor"');
    // Stage 8A / ADR 0010：执行者下拉只列出经连接测试通过的执行者，未验证的 Claude 思考者不得出现在执行者选项里
    const execSelectHtml = /<select[^>]*data-testid="global-role-executor"[\s\S]*?<\/select>/.exec(htmlSettings)?.[0] ?? '';
    expect(execSelectHtml).toContain('Codex（本机）');
    expect(execSelectHtml).not.toMatch(/value="claude"/);

    const claudeFake = scripted({}, {}, { id: 'claude-api', service: 'Anthropic' });
    const codexFake = scripted({}, {}, { id: 'codex', service: 'OpenAI（ChatGPT / Codex）' });
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(dataDir),
      aiSettings,
      getAiAvailability: async () => ({ codexAvailable: true, claudeAvailable: true }),
      makeThinkerByProvider: (p) => (p === 'claude' ? claudeFake : codexFake),
    });

    const t = await ctl.create('同一 AI 单思考者任务');
    const v0 = await ctl.getDiscussionView(t.id);
    expect(v0.unreviewed).toBe(true);
    expect(v0.independentReview).toBe(false);
    expect(v0.sameAiSingle).toBe(true);
    expect(v0.reviewerLabel).toBeNull();
    expect(v0.reviewerRoleDisplay).toContain('同一 AI');

    await ctl.startDiscussion(t.id, v0.preset);
    await ctl.waitDiscussion(t.id);
    const consentV = await ctl.getDiscussionView(t.id);
    await ctl.confirmDiscussionSend(t.id, consentV.pendingConsentService!, true);
    await ctl.waitDiscussion(t.id);
    const reqV = await ctl.getDiscussionView(t.id);
    await ctl.confirmDiscussionRequirements(
      t.id,
      reqV.requirements.map((r) => ({ id: r.id, text: r.text })),
    );
    await ctl.waitDiscussion(t.id);

    const approvalV = await ctl.getDiscussionView(t.id);
    expect(approvalV.pauseAt).toBe('approval');
    expect(approvalV.independentReview).toBe(false);
    expect(approvalV.unreviewedBadge).toBe('未经独立评审');
    // 全程未调用任何复核步
    expect(codexFake.requests).toHaveLength(0);
    expect(claudeFake.requests.every((r) => r.role === 'planner')).toBe(true);

    const discussHtml = renderToStaticMarkup(
      createElement(DiscussionViewBody, {
        view: approvalV,
        taskState: 'clarifying',
        busy: false,
        actionError: null,
        activeTab: 'summary',
        onTabChange: () => undefined,
        selectedPreset: approvalV.preset,
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
        modifyText: approvalV.rawRequirement,
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
      }),
    );
    expect(discussHtml).toContain('首席：模拟思考者（测试用）');
    expect(discussHtml).toContain('未经独立评审');
    expect(discussHtml).not.toContain('discussion-tab-reviewer-chat');
    expect(providerDisplayName('claude')).toBe('Claude（API）');
  });

  it('讨论中途修改设置不影响已开始的线程；删除 Key 后角色回退「未设置」，未开始的讨论先提示且禁止启动', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-midrun-data-'));
    const repo = await makeProject();
    cleanDirs.push(dataDir, repo);

    const fakeEndpoint = await startFakeAnthropicFlowServer();
    const CANARY = 'sk-ant-CANARY-FULL-FLOW-2468';
    const vault = makeCryptoVault();
    const keyStore = new ClaudeKeyStore(dataDir, vault);
    await keyStore.save(CANARY, { endpoint: fakeEndpoint });

    const aiSettings = new AiSettingsStore(dataDir);
    await aiSettings.saveGlobalRoles(
      { chief: 'claude', reviewer: 'codex', claudeModel: DEFAULT_CLAUDE_API_MODEL },
      { codexAvailable: true, claudeAvailable: true },
    );

    const claudeThinker = new ClaudeApiThinker({
      endpoint: fakeEndpoint,
      getSecret: () => keyStore.getSecret(),
    });
    const codexThinker = scripted({}, {}, { id: 'codex', service: 'OpenAI（ChatGPT / Codex）' });

    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(dataDir),
      aiSettings,
      getAiAvailability: async () => {
        const ks = await keyStore.status();
        return { codexAvailable: true, claudeAvailable: ks.configured && ks.available };
      },
      makeThinkerByProvider: (provider, model) =>
        provider === 'claude'
          ? model && model !== DEFAULT_CLAUDE_API_MODEL
            ? new ClaudeApiThinker({ endpoint: fakeEndpoint, model, getSecret: () => keyStore.getSecret() })
            : claudeThinker
          : codexThinker,
    });

    const tStarted = await ctl.create('先开始的 Claude 首席讨论');
    const tUnstarted = await ctl.create('尚未开始的讨论');

    const vStarted0 = await ctl.getDiscussionView(tStarted.id);
    expect(vStarted0.plannerLabel).toBe('Claude（API）');
    expect(vStarted0.reviewerLabel).toBe('模拟思考者（测试用）');
    expect(vStarted0.independentReview).toBe(true);

    // 启动 tStarted（停在 send_consent）
    await ctl.startDiscussion(tStarted.id, vStarted0.preset);
    await ctl.waitDiscussion(tStarted.id);
    const vStartedPaused = await ctl.getDiscussionView(tStarted.id);
    expect(vStartedPaused.pauseAt).toBe('send_consent');

    // 中途改设置：项目单独设置为 首席=Codex, 复核=不复核
    await ctl.saveProjectRoles('custom', 'codex', 'none');

    // tStarted 已经开始 → 角色仍然保持 Claude 首席 + Codex 复核
    const vStartedAfterEdit = await ctl.getDiscussionView(tStarted.id);
    expect(vStartedAfterEdit.plannerLabel).toBe('Claude（API）');
    expect(vStartedAfterEdit.reviewerLabel).toBe('模拟思考者（测试用）');
    expect(vStartedAfterEdit.independentReview).toBe(true);

    // 让 tStarted 跑完一次 Claude API 拆解需求，核验真实记录到 token 用量
    await ctl.confirmDiscussionSend(tStarted.id, 'Anthropic', true);
    await ctl.waitDiscussion(tStarted.id);
    const vStartedReq = await ctl.getDiscussionView(tStarted.id);
    expect(vStartedReq.pauseAt).toBe('requirements_confirmation');
    expect(vStartedReq.budget.hasTokenUsage).toBe(true);
    expect(vStartedReq.budget.inputTokens).toBe(180);
    expect(vStartedReq.budget.outputTokens).toBe(60);

    // 尚未开始的 tUnstarted → 立即跟随新的项目设置（Codex + 不复核）
    const vUnstartedCustom = await ctl.getDiscussionView(tUnstarted.id);
    expect(vUnstartedCustom.plannerLabel).toBe('模拟思考者（测试用）');
    expect(vUnstartedCustom.reviewerRoleDisplay).toBe('不复核');
    expect(vUnstartedCustom.unreviewed).toBe(true);

    // 改项目设置用 Claude 并删除 Key → 角色自动回退「未设置」，未开始的讨论下一次前先提示且不允许启动
    await ctl.saveProjectRoles('custom', 'claude', 'codex');
    await keyStore.delete(() => aiSettings.onClaudeKeyDeleted());

    const rolesAfterDel = await ctl.getProjectRoles();
    expect(rolesAfterDel.chief).toBe('unset');
    expect(rolesAfterDel.globalRoles.chief).toBe('unset');

    const vUnstartedAfterDel = await ctl.getDiscussionView(tUnstarted.id);
    expect(vUnstartedAfterDel.plannerLabel).toBe('未设置');
    expect(vUnstartedAfterDel.roleProblem).toContain('未设置');
    await expect(ctl.startDiscussion(tUnstarted.id, 'roles')).rejects.toThrow(/未设置/);

    // 删 Key 后（chief='unset' 且 reviewer='codex'）新建任务也应正常建线程并在讨论前提示，不得因缺少 reviewer 报错
    const tNewAfterDel = await ctl.create('删 Key 后新建的任务');
    const vNewAfterDel = await ctl.getDiscussionView(tNewAfterDel.id);
    expect(vNewAfterDel.plannerLabel).toBe('未设置');
    expect(vNewAfterDel.roleProblem).toContain('未设置');
    await expect(ctl.startDiscussion(tNewAfterDel.id, 'roles')).rejects.toThrow(/未设置/);

    // 全量扫描 userData、repo/.studio（任务、线程、事件日志）、IPC 返回对象：绝不含 CANARY 特征字符串
    const allFiles = [...(await walkFiles(dataDir)), ...(await walkFiles(path.join(repo, '.studio')))];
    expect(allFiles.length).toBeGreaterThan(2);
    for (const f of allFiles) {
      const content = await fs.readFile(f, 'utf8');
      expect(content, f).not.toContain(CANARY);
      expect(content, f).not.toContain('CANARY-FULL-FLOW');
    }
    const threadRaw = await new ThreadStore(repo).load(vStarted0.threadId);
    expect(JSON.stringify({ vStartedReq, vUnstartedAfterDel, rolesAfterDel, threadRaw })).not.toContain('CANARY-FULL-FLOW');
  });
});
