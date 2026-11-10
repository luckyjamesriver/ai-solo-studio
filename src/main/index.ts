import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setSupplementalPath } from '../core/env/host-env.js';
import { resolveHostTools, resolveTool } from '../core/env/path.js';
import { validateProjectPath } from '../core/env/project-path.js';
import { runHealthCheck, type HealthReport } from '../core/env/health.js';
import * as G from '../core/git/git.js';
import { CodexExecutor, VERIFIED_CODEX_VERSION } from '../core/executor/adapters/codex.js';
import { DEV_PERSONAL_ENV } from '../core/thinking/claude-cli.js';
import { RecentProjects } from '../core/app/recent.js';
import { DisclosureStore, buildDisclosure } from '../core/app/disclosure.js';
import { TaskStore } from '../core/task/store.js';
import { TaskController } from '../core/app/task-controller.js';
import { TaskPrefs } from '../core/app/prefs.js';
import { localApfsProbe, RecordStore, VolumeNotSupportedError, WriterLockedError, type OpenOptions } from '../core/persistence/index.js';

/**
 * 持久化服务的打开选项（ADR 0005）：数据目录必须在本地 APFS；取不到数据目录租约时最多等 12 秒
 * （上一次异常退出留下的租约要过一阵才会被判定为过期）。主进程里的持久化服务是项目数据与应用数据的唯一写入者。
 */
const STORE_OPTS: OpenOptions = { volumeProbe: localApfsProbe, lockWaitMs: 12_000 };

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** 当前打开的项目（已规范化的真实路径）。渲染进程不能传任意路径，只能操作用户通过系统对话框选中的项目，或按编号打开最近项目。 */
let project: string | null = null;
/** 等待用户确认“创建版本记录”的非 Git 文件夹。确认前不会打开，也不会改动任何东西。 */
let pendingInit: string | null = null;

const dataDir = () => app.getPath('userData');
const recent = () => new RecentProjects(dataDir(), {}, STORE_OPTS);
const disclosureStore = () => new DisclosureStore(dataDir(), STORE_OPTS);
const TOOLS = ['git', 'node', 'npm', 'codex'] as const;

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
  if (!project) throw new Error('还没有打开项目。');
  return project;
}

async function projectStatus() {
  const dir = requireProject();
  const repo = await G.isRepo(dir);
  const taskList = repo ? await new TaskStore(dir, STORE_OPTS).list() : [];
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
    path: dir,
    name: path.basename(dir),
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
  project = v.path;
  try {
    await recent().record(v.path);
    return { kind: 'opened', status: await projectStatus() };
  } catch (e) {
    // 数据目录不在本地 APFS，或被另一个写入者占用：不打开这个项目，如实说明（不写任何数据）
    if (e instanceof VolumeNotSupportedError || e instanceof WriterLockedError) {
      project = null;
      return { kind: 'rejected', reason: e.message };
    }
    throw e;
  }
}

async function health(): Promise<HealthReport> {
  const tools = await resolveHostTools(TOOLS);
  setSupplementalPath(tools.supplementalDirs);
  const codexTool = tools.tools.codex;
  const exec = codexTool ? new CodexExecutor({ command: codexTool.path }) : null;
  const probe = exec ? { detect: () => exec.detect(), preflight: () => exec.preflight(project ?? dataDir()) } : null;
  const report = await runHealthCheck({
    tools,
    processPath: process.env.PATH ?? '',
    projectDir: project,
    executor: 'codex',
    codex: probe,
    verifiedCodexVersion: VERIFIED_CODEX_VERSION,
  });
  return { ...report, project: project ? { name: path.basename(project) } : null };
}

async function disclosure() {
  const codex = await resolveTool('codex', {});
  const content = buildDisclosure({ codexInstalled: !!codex, devPersonalClaude: process.env[DEV_PERSONAL_ENV] === '1' && !app.isPackaged });
  return { content, accepted: await disclosureStore().get() };
}

/**
 * 任务控制器：每个打开的项目一个。执行体用 Codex（路径来自环境体检的发现结果）。
 * 额外可写目录只能通过这里弹出的系统选择框取得，渲染进程不传任何路径。
 */
// 每个项目保留自己的控制器（切换项目再切回来时沿用同一个：它记着哪些任务正在操作，启动核对也只做一次）
const controllers = new Map<string, TaskController>();
async function tasks(): Promise<TaskController> {
  const dir = requireProject();
  const existing = controllers.get(dir);
  if (existing) return existing;
  const found = await resolveHostTools(TOOLS);
  setSupplementalPath(found.supplementalDirs);
  const codexPath = found.tools.codex?.path ?? 'codex';
  const ctl = new TaskController({
    repo: dir,
    makeExecutor: () => new CodexExecutor({ command: codexPath }),
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
  controllers.set(dir, ctl);
  return ctl;
}

ipcMain.handle('env:detect', () => health());
ipcMain.handle('tasks:list', async () => (await tasks()).list());
ipcMain.handle('tasks:create', async (_e, request: unknown) => (await tasks()).create(request));
ipcMain.handle('tasks:get', async (_e, id: unknown) => (await tasks()).get(id));
ipcMain.handle('tasks:savePlan', async (_e, id: unknown, plan: unknown) => (await tasks()).savePlan(id, plan));
ipcMain.handle('tasks:addExtraDir', async (_e, id: unknown) => (await tasks()).addExtraDir(id));
ipcMain.handle('tasks:removeExtraDir', async (_e, id: unknown, key: unknown) => (await tasks()).removeExtraDir(id, key));
ipcMain.handle('tasks:start', async (_e, id: unknown, ack: unknown) => (await tasks()).start(id, ack));
ipcMain.handle('tasks:stop', async (_e, id: unknown) => (await tasks()).stop(id));
// B4-2：验收、保存、放弃、撤销。参数只有任务编号、条目编号（c0 / d0）与验收版本；格式由控制器校验，伪造参数一律拒绝。
ipcMain.handle('acceptance:get', async (_e, id: unknown) => (await tasks()).getAcceptanceView(id));
ipcMain.handle('acceptance:openPreview', async (_e, id: unknown, version: unknown) => (await tasks()).openPreview(id, version));
ipcMain.handle('acceptance:skipPreview', async (_e, id: unknown, version: unknown) => (await tasks()).skipPreview(id, version));
ipcMain.handle('acceptance:confirmCriterion', async (_e, id: unknown, itemId: unknown, version: unknown) => (await tasks()).confirmCriterion(id, itemId, version));
ipcMain.handle('acceptance:confirmOverall', async (_e, id: unknown, version: unknown) => (await tasks()).confirmOverall(id, version));
ipcMain.handle('acceptance:ackDenied', async (_e, id: unknown, itemId: unknown, version: unknown) => (await tasks()).ackDenied(id, itemId, version));
ipcMain.handle('acceptance:recheck', async (_e, id: unknown) => (await tasks()).recheck(id));
ipcMain.handle('acceptance:save', async (_e, id: unknown, version: unknown) => (await tasks()).saveTask(id, version));
ipcMain.handle('acceptance:discard', async (_e, id: unknown) => (await tasks()).discardTask(id));
ipcMain.handle('acceptance:undo', async (_e, id: unknown) => (await tasks()).undoSave(id));
ipcMain.handle('acceptance:retryCleanup', async (_e, id: unknown) => (await tasks()).retryCleanup(id));
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
ipcMain.handle('project:status', () => projectStatus());
ipcMain.handle('project:init', async (_e, consent: unknown): Promise<OpenResult> => {
  const target = pendingInit;
  pendingInit = null;
  if (!target) throw new Error('没有等待确认的文件夹。');
  if (consent !== true) return { kind: 'declined' };
  await G.initRepo(target);
  project = target;
  await recent().record(target);
  return { kind: 'opened', status: await projectStatus() };
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
