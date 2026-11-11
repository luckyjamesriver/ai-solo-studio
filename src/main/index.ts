import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setSupplementalPath } from '../core/env/host-env.js';
import { resolveHostTools, resolveTool } from '../core/env/path.js';
import { validateProjectPath } from '../core/env/project-path.js';
import { runHealthCheck, type HealthReport } from '../core/env/health.js';
import * as G from '../core/git/git.js';
import type { SandboxCommandRunner } from '../core/checks/scripts.js';
import type { DetectResult } from '../core/executor/types.js';
import { createStandaloneSandboxRunner, type StandaloneSandboxResult } from '../core/executor/sandbox/index.js';
import { CodexExecutor, VERIFIED_CODEX_VERSION } from '../core/executor/adapters/codex.js';
import { ApiAgentExecutor } from '../core/executor/adapters/api-agent.js';
import { ClaudeCodeExecutor } from '../core/executor/adapters/claude-code.js';
import { AcpExecutor } from '../core/executor/adapters/acp.js';
import {
  findSubscriptionCliSpec,
  isSubscriptionCliId,
  type SubscriptionCliId,
} from '../core/executor/cli/subscriptions.js';
import { API_PROVIDER_CATALOG, findProviderPreset, normalizeApiEndpoint } from '../core/executor/api/catalog.js';
import { fetchProviderModels } from '../core/executor/api/client.js';
import { ClaudeApiThinker } from '../core/thinking/claude-api.js';
import { ClaudeCliThinker, DEV_PERSONAL_ENV } from '../core/thinking/claude-cli.js';
import { CodexThinker } from '../core/thinking/codex.js';
import { RecentProjects } from '../core/app/recent.js';
import { DisclosureStore, buildDisclosure } from '../core/app/disclosure.js';
import { AppStore } from '../core/app/app-store.js';
import { ClaudeKeyStore, type SecretVault } from '../core/app/claude-key.js';
import {
  ProviderProfileStore,
  PROVIDER_PROFILE_ID_RE,
  type SaveProviderProfileInput,
} from '../core/app/provider-profiles.js';
import { SubscriptionCliStore } from '../core/app/subscription-clis.js';
import {
  AiSettingsStore,
  buildSameAiNotice,
  buildVerifiedExecutorOptions,
  SUGGESTED_CLAUDE_MODELS,
  type GlobalAiSettingsView,
} from '../core/app/ai-settings.js';
import { TaskStore } from '../core/task/store.js';
import { TaskController } from '../core/app/task-controller.js';
import { TaskPrefs } from '../core/app/prefs.js';
import { OpenProjectManager, type WorkbenchEntry } from '../core/app/open-projects.js';
import { localApfsProbe, RecordStore, VolumeNotSupportedError, WriterLockedError, type OpenOptions } from '../core/persistence/index.js';

/**
 * 持久化服务的打开选项（ADR 0005）：数据目录必须在本地 APFS；取不到数据目录租约时最多等 12 秒
 * （上一次异常退出留下的租约要过一阵才会被判定为过期）。主进程里的持久化服务是项目数据与应用数据的唯一写入者。
 */
const STORE_OPTS: OpenOptions = { volumeProbe: localApfsProbe, lockWaitMs: 12_000 };

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** 已打开项目表：键为项目 id（沿用 recent.ts 的 id），值为该项目的 TaskController 与 RecordStore。 */
const openProjects = new OpenProjectManager<RecordStore>();
let latestHealth: (HealthReport & { firstRun?: boolean }) | null = null;
let healthUpdatedAt = new Date().toISOString();
let onboardingInSession: boolean | null = null;
/** 等待用户确认“创建版本记录”的非 Git 文件夹。确认前不会打开，也不会改动任何东西。 */
let pendingInit: string | null = null;

const dataDir = () => app.getPath('userData');
const recent = () => new RecentProjects(dataDir(), {}, STORE_OPTS);
const disclosureStore = () => new DisclosureStore(dataDir(), STORE_OPTS);
const safeStorageVault: SecretVault = {
  async isAvailable() {
    const ok = await safeStorage.isAsyncEncryptionAvailable();
    if (!ok) {
      return {
        ok: false,
        reason: '当前系统的安全加密存储（safeStorage）不可用，拒绝以明文存储或解密 Anthropic API Key。',
      };
    }
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return {
        ok: false,
        reason: '当前 Linux 桌面环境未配置系统密钥环（当前后端为明文 basic_text），拒绝以明文保存 Anthropic API Key。',
      };
    }
    return { ok: true };
  },
  async encrypt(plaintext) {
    const buf = await safeStorage.encryptStringAsync(plaintext);
    return buf.toString('base64');
  },
  async decrypt(cipherB64) {
    const res = await safeStorage.decryptStringAsync(Buffer.from(cipherB64, 'base64'));
    return res.result;
  },
};
const claudeKeyStore = () => new ClaudeKeyStore(dataDir(), safeStorageVault, STORE_OPTS);
const providerProfileStore = () => new ProviderProfileStore(dataDir(), safeStorageVault, STORE_OPTS);
const subscriptionCliStore = () => new SubscriptionCliStore(dataDir(), STORE_OPTS);
const aiSettingsStore = () => new AiSettingsStore(dataDir(), STORE_OPTS);
const TOOLS = ['git', 'node', 'npm', 'codex'] as const;

const SUB_PROBE_TTL_MS = 30_000;
const subProbeCache = new Map<SubscriptionCliId, { resolvedPath: string; at: number; detect: DetectResult }>();
let standaloneSandboxCache: Promise<StandaloneSandboxResult> | null = null;

function getStandaloneSandbox(): Promise<StandaloneSandboxResult> {
  if (!standaloneSandboxCache) standaloneSandboxCache = createStandaloneSandboxRunner();
  return standaloneSandboxCache;
}

async function resolveNonCodexSandboxRunner(
  codexPath: string,
  hasCodexTool: boolean,
): Promise<SandboxCommandRunner | undefined> {
  const standalone = await getStandaloneSandbox();
  if (standalone.runner) return standalone.runner;
  if (hasCodexTool) {
    const codexAvail = await detectCodexAvailability(codexPath);
    if (codexAvail.available) return new CodexExecutor({ command: codexPath }).sandboxRunner;
  }
  return undefined;
}

async function probeSubscriptionCli(
  cliId: SubscriptionCliId,
  opts: { model?: string; refresh?: boolean; onlyIfEnabled?: boolean } = {},
): Promise<DetectResult> {
  const spec = findSubscriptionCliSpec(cliId);
  if (!spec) return { installed: false, loggedIn: 'unknown', note: '未知工具' };
  const store = subscriptionCliStore();
  if (opts.onlyIfEnabled) {
    const rec = await store.getRiskRecord(cliId);
    if (!rec?.enabled || rec.acknowledgedRiskVersion !== spec.riskVersion || !rec.riskAcknowledgedAt) {
      return { installed: false, loggedIn: 'unknown', note: '尚未启用' };
    }
  }
  const foundTool = await resolveTool(spec.binaryName, {});
  if (!foundTool) {
    subProbeCache.delete(cliId);
    return {
      installed: false,
      loggedIn: 'no',
      note: `未在本机找到 ${spec.binaryName} 命令，请先安装并登录官方 CLI`,
    };
  }
  const cached = !opts.refresh ? subProbeCache.get(cliId) : undefined;
  if (cached && cached.resolvedPath === foundTool.path && Date.now() - cached.at < SUB_PROBE_TTL_MS) {
    return cached.detect;
  }
  const exec =
    cliId === 'claude_cli'
      ? new ClaudeCodeExecutor({ command: foundTool.path, model: opts.model, riskGate: store })
      : new AcpExecutor({ cliId, command: foundTool.path, model: opts.model, riskGate: store });
  const detect = await exec.detect();
  subProbeCache.set(cliId, { resolvedPath: foundTool.path, at: Date.now(), detect });
  return detect;
}

async function detectCodexAvailability(explicitCommand?: string): Promise<{ available: boolean; note?: string }> {
  try {
    const command = explicitCommand ?? (await resolveTool('codex', {}))?.path ?? 'codex';
    return await new CodexThinker({ command }).detect();
  } catch (e) {
    return { available: false, note: e instanceof Error ? e.message : String(e) };
  }
}

async function getVerifiedExecutorsForMain(explicitCodexCmd?: string, onlyIfEnabled = false) {
  const [codex, profiles, subscriptions] = await Promise.all([
    detectCodexAvailability(explicitCodexCmd),
    providerProfileStore().listProfiles(),
    subscriptionCliStore().listViews((cliId) => probeSubscriptionCli(cliId, { onlyIfEnabled })),
  ]);
  return {
    codex,
    profiles,
    subscriptions,
    verified: buildVerifiedExecutorOptions(codex.available, profiles, subscriptions),
  };
}

async function getGlobalAiView(): Promise<GlobalAiSettingsView> {
  const [{ codex, profiles, subscriptions, verified }, claudeKey, roles, defaultExecutor, standalone] = await Promise.all([
    getVerifiedExecutorsForMain(),
    claudeKeyStore().status(),
    aiSettingsStore().getGlobalRoles(),
    aiSettingsStore().getDefaultExecutor(),
    getStandaloneSandbox(),
  ]);
  let executorProblem: string | null = null;
  if (defaultExecutor === 'unset') {
    executorProblem = '默认执行者已回退为「未设置」（原配置已删除或已停用），请重新选择已测通的执行者。';
  } else if (defaultExecutor !== 'codex' && !verified.some((v) => v.id === defaultExecutor)) {
    executorProblem = '当前默认执行者不可用或尚未通过连接测试，请重新测试连接或更换默认执行者。';
  }
  return {
    codex: {
      available: codex.available,
      statusLabel: codex.available ? '可用' : '不可用',
      detail: codex.note ?? (codex.available ? '本机 ChatGPT 登录 / Codex CLI 就绪' : '尚未安装或尚未登录 Codex'),
    },
    claudeKey,
    roles,
    sameAiNotice: buildSameAiNotice(roles.chief, roles.reviewer),
    availableClaudeModels: SUGGESTED_CLAUDE_MODELS,
    executorPresets: API_PROVIDER_CATALOG,
    providerProfiles: profiles,
    subscriptionClis: subscriptions,
    verifiedExecutors: verified,
    defaultExecutor,
    executorProblem,
    standaloneSandbox: standalone.status,
  };
}

openProjects.setHealthProbe(async (): Promise<WorkbenchEntry[]> => {
  if (!latestHealth) return [];
  const failed = latestHealth.items.filter((i) => i.overall === 'fail');
  if (failed.length === 0) return [];
  return [
    {
      id: 'env:health',
      kind: 'health',
      projectId: null,
      projectName: latestHealth.project?.name ?? '本机环境',
      taskName: `环境检查发现问题（${failed.map((f) => f.label).join('、')}）`,
      state: 'health_issue',
      statusLabel: '需要处理',
      isAbnormal: true,
      impact: '检测到本机运行环境未就绪，可能影响工具运行或项目兼容性，建议前往环境体检查看原因',
      nextAction: { kind: 'open_settings_health', label: '查看环境体检' },
      updatedAt: healthUpdatedAt,
    },
  ];
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const devUrl = process.env.STUDIO_DEV_URL;
  if (devUrl && !app.isPackaged) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, '../../dist-renderer/index.html'));
}

function requireProject(): string {
  const activeId = openProjects.activeId;
  if (!activeId) throw new Error('还没有打开项目。');
  return openProjects.require(activeId).path;
}

function controllerFor(projectId: unknown): TaskController {
  return openProjects.require(projectId).controller;
}

async function createController(dir: string): Promise<TaskController> {
  const found = await resolveHostTools(TOOLS);
  setSupplementalPath(found.supplementalDirs);
  const codexPath = found.tools.codex?.path ?? 'codex';
  const devPersonalEnabled = !app.isPackaged && process.env[DEV_PERSONAL_ENV] === '1';
  const standalone = await getStandaloneSandbox();
  return new TaskController({
    repo: dir,
    makeExecutor: () => new CodexExecutor({ command: codexPath }),
    getVerifiedExecutors: async () => (await getVerifiedExecutorsForMain(codexPath, true)).verified,
    ...(standalone.runner ? { fallbackSandboxRunner: standalone.runner } : {}),
    resolveExecutor: async (executorId?: string) => {
      const target = executorId ?? (await aiSettingsStore().getDefaultExecutor());
      if (target === 'unset') {
        throw new Error('当前执行者未设置（原配置已删除或已停用），请先在「设置 → AI 与角色」重新选择执行者。');
      }
      if (!target || target === 'codex') {
        return { executor: new CodexExecutor({ command: codexPath }) };
      }
      if (target.startsWith('sub:')) {
        const cliIdRaw = target.slice(4);
        if (!isSubscriptionCliId(cliIdRaw)) {
          throw new Error(`未知的本机订阅 CLI 标识：${target}`);
        }
        const store = subscriptionCliStore();
        const rec = await store.getRiskRecord(cliIdRaw);
        const spec = findSubscriptionCliSpec(cliIdRaw)!;
        if (!rec?.enabled || !rec.riskAcknowledgedAt || rec.acknowledgedRiskVersion !== spec.riskVersion) {
          throw new Error(`「${spec.name}」尚未确认风险说明并启用，请前往「设置 → AI 与角色」先完成风险确认。`);
        }
        const foundTool = await resolveTool(spec.binaryName, {});
        const command = foundTool?.path ?? spec.binaryName;
        const model = typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : undefined;
        const sandboxRunner = await resolveNonCodexSandboxRunner(codexPath, !!found.tools.codex);
        const executor =
          cliIdRaw === 'claude_cli'
            ? new ClaudeCodeExecutor({
                command,
                model,
                riskGate: store,
                ...(sandboxRunner ? { sandboxRunner } : {}),
              })
            : new AcpExecutor({
                cliId: cliIdRaw,
                command,
                model,
                riskGate: store,
                ...(sandboxRunner ? { sandboxRunner } : {}),
              });
        return {
          executor,
          ...(sandboxRunner ? { sandboxRunner } : {}),
        };
      }
      if (!target.startsWith('api:')) {
        throw new Error(`未知的执行者标识：${target}`);
      }
      const profileId = target.slice(4);
      const profile = await providerProfileStore().getProfile(profileId);
      if (!profile || !profile.executorReady) {
        throw new Error('所选 API 执行者不可用或尚未通过连接测试，请前往「设置 → AI 与角色」重新验证连接。');
      }
      const sandboxRunner = await resolveNonCodexSandboxRunner(codexPath, !!found.tools.codex);
      return {
        executor: new ApiAgentExecutor({
          id: target,
          displayName: `${profile.label}（API）`,
          presetId: profile.presetId,
          protocol: profile.protocol,
          endpoint: profile.endpoint,
          model: profile.model,
          requiresKey: profile.requiresKey,
          getSecret: () => providerProfileStore().getSecret(profileId),
          ...(sandboxRunner ? { sandboxRunner } : {}),
        }),
        ...(sandboxRunner ? { sandboxRunner } : {}),
      };
    },
    makeThinkers: (preset) => {
      if (preset === 'dev-personal') {
        if (!devPersonalEnabled) throw new Error('未启用开发者预设（STUDIO_DEV_PERSONAL_CLAUDE=1）。');
        return {
          preset,
          planner: new ClaudeCliThinker({ isPackaged: app.isPackaged }),
          reviewer: new CodexThinker({ command: codexPath }),
          single: false,
        };
      }
      return {
        preset: 'codex-single',
        planner: new CodexThinker({ command: codexPath }),
        single: true,
      };
    },
    devPersonalEnabled,
    aiSettings: aiSettingsStore(),
    getAiAvailability: async () => {
      const [codex, keyStatus] = await Promise.all([
        detectCodexAvailability(codexPath),
        claudeKeyStore().status(),
      ]);
      return {
        codexAvailable: codex.available,
        claudeAvailable: keyStatus.configured && keyStatus.available,
      };
    },
    makeThinkerByProvider: (provider, model) =>
      provider === 'claude'
        ? new ClaudeApiThinker({
            ...(model ? { model } : {}),
            getSecret: () => claudeKeyStore().getSecret(),
          })
        : new CodexThinker({ command: codexPath }),
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择允许 AI 修改的另一个文件夹' });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    pickReportFile: async () => {
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        title: '选择外部工具生成的任务报告',
        filters: [{ name: '任务报告（.md / .txt）', extensions: ['md', 'txt'] }],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    prefs: new TaskPrefs(dataDir(), STORE_OPTS),
    storeOptions: STORE_OPTS,
    openPreview: async ({ kind, targetPath }) => {
      if (kind === 'web') {
        await shell.openExternal(pathToFileURL(targetPath).href);
      } else {
        const err = await shell.openPath(targetPath);
        if (err) throw new Error(err);
      }
    },
    revealPath: async (targetPath: string) => {
      shell.showItemInFolder(targetPath);
    },
    onSaveProgress: (ev) => {
      const entry = openProjects.findByPath(dir);
      if (win && !win.isDestroyed()) {
        win.webContents.send('acceptance:saveProgress', {
          ...ev,
          ...(entry ? { projectId: entry.id } : {}),
        });
      }
    },
  });
}

async function projectStatus(projectId: unknown) {
  const entry = openProjects.setActive(projectId);
  const dir = entry.path;
  const repo = await G.isRepo(dir);
  const taskList = repo ? await entry.controller.listTasksRaw() : [];
  const byMerge = new Map(taskList.filter((t) => t.saveRecord?.mergeCommit).map((t) => [t.saveRecord!.mergeCommit, t.saveRecord!]));
  const savePoints = repo
    ? (await G.savePoints(dir, 20)).map((sp) => {
        const rec = byMerge.get(sp.sha);
        if (!rec) return sp;
        const checked = rec.checked === true;
        return { ...sp, checked, checksText: (checked ? '检查通过' : '未检查') as '检查通过' | '未检查' };
      })
    : [];
  return {
    id: entry.id,
    path: dir,
    name: entry.name,
    isRepo: repo,
    uncommitted: repo ? await G.uncommittedCount(dir) : 0,
    savePoints,
    tasks: taskList,
  };
}

type OpenResult =
  | { kind: 'opened'; status: Awaited<ReturnType<typeof projectStatus>> }
  | { kind: 'needs_init'; name: string; path: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'declined' };

async function registerOpenedRepo(dir: string): Promise<OpenResult> {
  const existing = openProjects.findByPath(dir);
  if (existing) {
    await recent().record(dir);
    return { kind: 'opened', status: await projectStatus(existing.id) };
  }
  const ctrl = await createController(dir);
  let recordStore: RecordStore;
  try {
    recordStore = await ctrl.openRecordStore();
  } catch (e) {
    // 数据目录不在本地 APFS，或被另一个写入者占用：不打开这个项目，如实说明（不写任何数据）
    if (e instanceof VolumeNotSupportedError || e instanceof WriterLockedError) {
      return { kind: 'rejected', reason: e.message };
    }
    throw e;
  }
  const rec = await recent().record(dir);
  openProjects.open({
    id: rec.id,
    path: dir,
    name: path.basename(dir),
    controller: ctrl,
    recordStore,
  });
  return { kind: 'opened', status: await projectStatus(rec.id) };
}

/** 校验 → 判断是否 Git 项目 → 打开或进入“等待确认创建版本记录”。所有入口（对话框、最近项目）都经过这里。 */
async function openValidated(input: string): Promise<OpenResult> {
  pendingInit = null;
  const v = await validateProjectPath(input);
  if (!v.ok) return { kind: 'rejected', reason: v.reason };
  if (!(await resolveTool('git', {}))) return { kind: 'rejected', reason: '没有找到 Git，请先在“你的电脑准备好了吗”里按提示安装 Git。' };
  const root = await G.repoRoot(v.path);
  if (root && root !== v.path) {
    return { kind: 'rejected', reason: `这个文件夹在另一个版本记录（${path.basename(root)}）的内部。请选择项目的最外层文件夹。` };
  }
  if (!root) {
    pendingInit = v.path;
    return { kind: 'needs_init', name: path.basename(v.path), path: v.path };
  }
  return registerOpenedRepo(v.path);
}

async function health(): Promise<HealthReport & { firstRun?: boolean }> {
  subProbeCache.clear();
  standaloneSandboxCache = null;
  const appStore = new AppStore(dataDir(), STORE_OPTS);
  if (onboardingInSession === null) {
    onboardingInSession = !(await appStore.isEnvOnboardingDone());
    if (onboardingInSession) await appStore.markEnvOnboardingDone();
  }
  const activeEntry = openProjects.find(openProjects.activeId);
  const activeDir = activeEntry?.path ?? null;
  const tools = await resolveHostTools(TOOLS);
  setSupplementalPath(tools.supplementalDirs);
  const codexTool = tools.tools.codex;
  const exec = codexTool ? new CodexExecutor({ command: codexTool.path }) : null;
  const probe = exec ? { detect: () => exec.detect(), preflight: () => exec.preflight(activeDir ?? dataDir()) } : null;
  const report = await runHealthCheck({
    tools,
    processPath: process.env.PATH ?? '',
    projectDir: activeDir,
    executor: 'codex',
    codex: probe,
    verifiedCodexVersion: VERIFIED_CODEX_VERSION,
  });
  const res = { ...report, project: activeDir ? { name: path.basename(activeDir) } : null, firstRun: onboardingInSession };
  latestHealth = res;
  healthUpdatedAt = new Date().toISOString();
  return res;
}

async function disclosure() {
  const [codex, keyStatus, profiles, subscriptions] = await Promise.all([
    resolveTool('codex', {}),
    claudeKeyStore().status().catch(() => ({ configured: false, available: false })),
    providerProfileStore().listProfiles().catch(() => []),
    subscriptionCliStore()
      .listViews((cliId) => probeSubscriptionCli(cliId, { onlyIfEnabled: true }))
      .catch(() => []),
  ]);
  const apiServices = [
    ...profiles
      .filter((p) => p.available)
      .map((p) => ({
        name: `${p.presetName}（${p.endpointOrigin}）`,
        role: p.executorReady ? '担任后台执行者，读取并修改你指定任务副本中的文件' : '已配置 API 连接（支持对话/思考）',
      })),
    ...subscriptions
      .filter((s) => s.enabled)
      .map((s) => ({
        name: s.displayName,
        role: `本机订阅 CLI（风险自担${s.model ? `，模型 ${s.model}` : ''}）：担任后台执行者，读取并修改你指定任务副本中的文件；按本机登录账号额度计费`,
      })),
  ];
  const content = buildDisclosure({
    codexInstalled: !!codex,
    claudeApiConfigured: keyStatus.configured && keyStatus.available,
    devPersonalClaude: process.env[DEV_PERSONAL_ENV] === '1' && !app.isPackaged,
    apiServices,
  });
  return { content, accepted: await disclosureStore().get() };
}

ipcMain.handle('env:detect', () => health());
ipcMain.handle('projects:listOpen', () => openProjects.listSummaries());
ipcMain.handle('projects:close', (_e, projectId: unknown) => openProjects.close(projectId));
ipcMain.handle('workbench:get', () => openProjects.getWorkbench());
ipcMain.handle('tasks:list', (_e, projectId: unknown) => controllerFor(projectId).list());
ipcMain.handle('tasks:create', (_e, projectId: unknown, request: unknown) => controllerFor(projectId).create(request));
ipcMain.handle('tasks:get', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).get(id));
ipcMain.handle('tasks:savePlan', (_e, projectId: unknown, id: unknown, plan: unknown) => controllerFor(projectId).savePlan(id, plan));
ipcMain.handle('tasks:addExtraDir', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).addExtraDir(id));
ipcMain.handle('tasks:removeExtraDir', (_e, projectId: unknown, id: unknown, key: unknown) => controllerFor(projectId).removeExtraDir(id, key));
ipcMain.handle('tasks:start', (_e, projectId: unknown, id: unknown, ack: unknown) => controllerFor(projectId).start(id, ack));
ipcMain.handle('tasks:exportExternal', (_e, projectId: unknown, id: unknown, ack: unknown) => controllerFor(projectId).exportExternalTask(id, ack));
ipcMain.handle('tasks:importExternal', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).importExternalReport(id));
ipcMain.handle('tasks:revealHandoff', (_e, projectId: unknown, id: unknown, target: unknown) => controllerFor(projectId).revealHandoff(id, target));
ipcMain.handle('tasks:stop', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).stop(id));
ipcMain.handle('tasks:continue', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).continueTask(id));
ipcMain.handle('tasks:rework', (_e, projectId: unknown, id: unknown, feedback: unknown) => controllerFor(projectId).reworkTask(id, feedback));
ipcMain.handle('tasks:reworkExternal', (_e, projectId: unknown, id: unknown, feedback: unknown) => controllerFor(projectId).reworkExternalTask(id, feedback));
ipcMain.handle('tasks:editReworkPermissions', (_e, projectId: unknown, id: unknown, feedback: unknown) => controllerFor(projectId).editReworkPermissions(id, feedback));
// 阶段 5：讨论与流程引擎驱动（先校验 projectId 属于已打开项目表，再交对应项目的控制器处理）。
ipcMain.handle('discussion:get', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).getDiscussionView(id));
ipcMain.handle('discussion:start', (_e, projectId: unknown, id: unknown, preset: unknown) => controllerFor(projectId).startDiscussion(id, preset));
ipcMain.handle('discussion:consent', (_e, projectId: unknown, id: unknown, service: unknown, allow: unknown) => controllerFor(projectId).confirmDiscussionSend(id, service, allow));
ipcMain.handle('discussion:confirmReqs', (_e, projectId: unknown, id: unknown, edits: unknown) => controllerFor(projectId).confirmDiscussionRequirements(id, edits));
ipcMain.handle('discussion:resolveFailure', (_e, projectId: unknown, id: unknown, choice: unknown, note: unknown) => controllerFor(projectId).resolveDiscussionFailure(id, choice, note));
ipcMain.handle('discussion:adjudicate', (_e, projectId: unknown, id: unknown, kind: unknown, key: unknown, decision: unknown, reason: unknown) => controllerFor(projectId).adjudicateDiscussion(id, kind, key, decision, reason));
ipcMain.handle('discussion:approve', (_e, projectId: unknown, id: unknown, decision: unknown) => controllerFor(projectId).decideDiscussionApproval(id, decision));
ipcMain.handle('discussion:modifyReqs', (_e, projectId: unknown, id: unknown, newRequest: unknown) => controllerFor(projectId).modifyDiscussionRequirements(id, newRequest));
ipcMain.handle('discussion:chat', (_e, projectId: unknown, id: unknown, target: unknown, message: unknown) => controllerFor(projectId).sendDiscussionChat(id, target, message));
ipcMain.handle('discussion:skip', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).skipDiscussion(id));
// B4-2 + 阶段 2 多项目：验收、保存、放弃、撤销。先校验 projectId 属于已打开项目表，再交对应项目的控制器处理。
ipcMain.handle('acceptance:get', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).getAcceptanceView(id));
ipcMain.handle('acceptance:openPreview', (_e, projectId: unknown, id: unknown, version: unknown) => controllerFor(projectId).openPreview(id, version));
ipcMain.handle('acceptance:skipPreview', (_e, projectId: unknown, id: unknown, version: unknown) => controllerFor(projectId).skipPreview(id, version));
ipcMain.handle('acceptance:confirmCriterion', (_e, projectId: unknown, id: unknown, itemId: unknown, version: unknown) => controllerFor(projectId).confirmCriterion(id, itemId, version));
ipcMain.handle('acceptance:rejectCriterion', (_e, projectId: unknown, id: unknown, itemId: unknown, version: unknown, reason: unknown) => controllerFor(projectId).rejectCriterion(id, itemId, version, reason));
ipcMain.handle('acceptance:confirmOverall', (_e, projectId: unknown, id: unknown, version: unknown) => controllerFor(projectId).confirmOverall(id, version));
ipcMain.handle('acceptance:ackDenied', (_e, projectId: unknown, id: unknown, itemId: unknown, version: unknown) => controllerFor(projectId).ackDenied(id, itemId, version));
ipcMain.handle('acceptance:recheck', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).recheck(id));
ipcMain.handle('acceptance:save', (_e, projectId: unknown, id: unknown, version: unknown) => controllerFor(projectId).saveTask(id, version));
ipcMain.handle('acceptance:saveUnchecked', (_e, projectId: unknown, id: unknown, version: unknown) => controllerFor(projectId).saveUncheckedTask(id, version));
ipcMain.handle('acceptance:discard', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).discardTask(id));
ipcMain.handle('acceptance:undo', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).undoSave(id));
ipcMain.handle('acceptance:retryCleanup', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).retryCleanup(id));
ipcMain.handle('acceptance:reworkConflict', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).reworkConflictTask(id));
// 项目状态异常时的只读出口：在访达中显示当前项目。没有参数——位置永远是用户选定的项目，渲染进程不能指定。
ipcMain.handle('project:reveal', () => {
  shell.showItemInFolder(requireProject());
});
ipcMain.handle('project:choose', async (): Promise<OpenResult> => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择你的项目文件夹' });
  if (r.canceled || !r.filePaths[0]) return { kind: 'cancelled' };
  return openValidated(r.filePaths[0]);
});
ipcMain.handle('project:recent', () => recent().list());
ipcMain.handle('project:openRecent', async (_e, id: unknown): Promise<OpenResult> => {
  const r = await recent().resolve(id);
  if (!r.ok) return { kind: 'rejected', reason: r.reason };
  return openValidated(r.path);
});
ipcMain.handle('project:status', (_e, projectId: unknown) => projectStatus(projectId));
ipcMain.handle('project:saveHistory', (_e, projectId: unknown) => controllerFor(projectId).getSaveHistory());
ipcMain.handle('project:undoHistory', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).undoFromHistory(id));
ipcMain.handle('project:getBrief', (_e, projectId: unknown) => controllerFor(projectId).getProjectBrief());
ipcMain.handle('project:saveBrief', (_e, projectId: unknown, brief: unknown) => controllerFor(projectId).saveProjectBrief(brief));
ipcMain.handle('project:getRoles', (_e, projectId: unknown) => controllerFor(projectId).getProjectRoles());
ipcMain.handle('project:saveRoles', (_e, projectId: unknown, mode: unknown, chief: unknown, reviewer: unknown) => controllerFor(projectId).saveProjectRoles(mode, chief, reviewer));
ipcMain.handle('project:saveExecutor', (_e, projectId: unknown, mode: unknown, id: unknown) => controllerFor(projectId).saveProjectExecutor(mode, id));
ipcMain.handle('tasks:setExecutor', (_e, projectId: unknown, id: unknown, executorId: unknown) => controllerFor(projectId).setTaskExecutor(id, executorId));
ipcMain.handle('project:init', async (_e, consent: unknown): Promise<OpenResult> => {
  const target = pendingInit;
  pendingInit = null;
  if (!target) throw new Error('没有等待确认的文件夹。');
  if (consent !== true) return { kind: 'declined' };
  await G.initRepo(target);
  return registerOpenedRepo(target);
});
ipcMain.handle('disclosure:get', () => disclosure());
ipcMain.handle('disclosure:accept', async () => {
  await disclosureStore().accept((await disclosure()).content);
  return disclosure();
});
ipcMain.handle('settings:getClaudeKey', () => claudeKeyStore().status());
ipcMain.handle('settings:saveClaudeKey', async (_e, secret: unknown) => {
  if (typeof secret !== 'string' || secret.length > 512) {
    throw new Error('无效的 API Key 输入参数。');
  }
  const roles = await aiSettingsStore().getGlobalRoles();
  return claudeKeyStore().save(secret, { model: roles.claudeModel });
});
ipcMain.handle('settings:deleteClaudeKey', () =>
  claudeKeyStore().delete(() => aiSettingsStore().onClaudeKeyDeleted()),
);
ipcMain.handle('settings:getAi', () => getGlobalAiView());
ipcMain.handle('settings:saveAiRoles', async (_e, chief: unknown, reviewer: unknown, model: unknown) => {
  const [codex, claudeKey] = await Promise.all([
    detectCodexAvailability(),
    claudeKeyStore().status(),
  ]);
  await aiSettingsStore().saveGlobalRoles(
    { chief, reviewer, claudeModel: model },
    {
      codexAvailable: codex.available,
      claudeAvailable: claudeKey.configured && claudeKey.available,
    },
  );
  return getGlobalAiView();
});

async function handleFetchModels(raw: unknown) {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const presetId = typeof obj.presetId === 'string' ? obj.presetId : '';
  const preset = findProviderPreset(presetId);
  if (!preset) return { ok: false, message: '未识别的服务商。' };
  const endpointRaw = typeof obj.endpoint === 'string' && obj.endpoint.trim() ? obj.endpoint : preset.defaultEndpoint;
  const norm = normalizeApiEndpoint(endpointRaw);
  if (!norm.ok) return { ok: false, message: norm.reason };
  let secret: string | null = typeof obj.secret === 'string' && obj.secret.trim() ? obj.secret.trim() : null;
  if (!secret && typeof obj.savedId === 'string' && PROVIDER_PROFILE_ID_RE.test(obj.savedId)) {
    secret = await providerProfileStore().getSecret(obj.savedId).catch(() => null);
  }
  return fetchProviderModels({ protocol: preset.protocol, endpoint: norm.endpoint, secret });
}

async function handleSaveProvider(raw: unknown) {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (typeof obj.presetId !== 'string' || typeof obj.model !== 'string') {
    throw new Error('无效的服务商配置参数。');
  }
  const secret = typeof obj.secret === 'string' ? obj.secret : undefined;
  if (secret && secret.length > 512) throw new Error('API Key 长度超出限制。');
  const input: SaveProviderProfileInput = {
    presetId: obj.presetId as SaveProviderProfileInput['presetId'],
    model: obj.model,
    ...(typeof obj.id === 'string' && obj.id ? { id: obj.id } : {}),
    ...(typeof obj.label === 'string' && obj.label ? { label: obj.label } : {}),
    ...(typeof obj.endpoint === 'string' ? { endpoint: obj.endpoint } : {}),
    ...(secret !== undefined ? { secret } : {}),
  };
  return providerProfileStore().saveAndTest(input);
}

ipcMain.handle('providers:catalog', () => API_PROVIDER_CATALOG);
ipcMain.handle('providers:list', () => providerProfileStore().listProfiles());
ipcMain.handle('providers:models', (_e, input: unknown) => handleFetchModels(input));
ipcMain.handle('providers:saveAndTest', (_e, input: unknown) => handleSaveProvider(input));
ipcMain.handle('providers:delete', async (_e, id: unknown) => {
  await providerProfileStore().deleteProfile(typeof id === 'string' ? id : '', (pid) =>
    aiSettingsStore().onProviderProfileDeleted(pid),
  );
  return getGlobalAiView();
});
ipcMain.handle('settings:saveDefaultExecutor', async (_e, id: unknown) => {
  const { verified } = await getVerifiedExecutorsForMain();
  await aiSettingsStore().saveDefaultExecutor(id, verified);
  return getGlobalAiView();
});
ipcMain.handle('subscriptions:list', () =>
  subscriptionCliStore().listViews((cliId) => probeSubscriptionCli(cliId)),
);
ipcMain.handle('subscriptions:testAndEnable', async (_e, input: unknown) => {
  const obj = (input ?? {}) as Record<string, unknown>;
  const cliId = typeof obj.cliId === 'string' ? obj.cliId : '';
  const riskAck = obj.riskAck === true;
  const model = typeof obj.model === 'string' ? obj.model : undefined;
  subProbeCache.delete(cliId as SubscriptionCliId);
  return subscriptionCliStore().testAndEnable(
    { cliId, riskAck, ...(model ? { model } : {}) },
    (id) => probeSubscriptionCli(id, { refresh: true }),
  );
});
ipcMain.handle('subscriptions:disable', async (_e, id: unknown) => {
  const cliId = typeof id === 'string' ? id : '';
  if (isSubscriptionCliId(cliId)) subProbeCache.delete(cliId);
  await subscriptionCliStore().disable(cliId, (disabledId) =>
    aiSettingsStore().onSubscriptionDisabled(disabledId),
  );
  return getGlobalAiView();
});

// 单实例（ADR 0005）：第二个实例只唤起已有窗口，不启动，更不会写数据——所有写入都来自同一个主进程。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
}
// 退出时释放数据目录租约（异常退出时租约会在一段时间后过期）
app.on('will-quit', () => {
  void RecordStore.closeAll();
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
