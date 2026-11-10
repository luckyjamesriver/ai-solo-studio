import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setSupplementalPath } from '../core/env/host-env.js';
import { resolveHostTools, resolveTool } from '../core/env/path.js';
import { validateProjectPath } from '../core/env/project-path.js';
import { runHealthCheck, type HealthReport } from '../core/env/health.js';
import * as G from '../core/git/git.js';
import { CodexExecutor, VERIFIED_CODEX_VERSION } from '../core/executor/adapters/codex.js';
import { ClaudeCliThinker, DEV_PERSONAL_ENV } from '../core/thinking/claude-cli.js';
import { CodexThinker } from '../core/thinking/codex.js';
import { RecentProjects } from '../core/app/recent.js';
import { DisclosureStore, buildDisclosure } from '../core/app/disclosure.js';
import { AppStore } from '../core/app/app-store.js';
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
const TOOLS = ['git', 'node', 'npm', 'codex'] as const;

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
  return new TaskController({
    repo: dir,
    makeExecutor: () => new CodexExecutor({ command: codexPath }),
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
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择允许 AI 修改的另一个文件夹' });
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
  const codex = await resolveTool('codex', {});
  const content = buildDisclosure({ codexInstalled: !!codex, devPersonalClaude: process.env[DEV_PERSONAL_ENV] === '1' && !app.isPackaged });
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
ipcMain.handle('tasks:stop', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).stop(id));
ipcMain.handle('tasks:continue', (_e, projectId: unknown, id: unknown) => controllerFor(projectId).continueTask(id));
ipcMain.handle('tasks:rework', (_e, projectId: unknown, id: unknown, feedback: unknown) => controllerFor(projectId).reworkTask(id, feedback));
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
