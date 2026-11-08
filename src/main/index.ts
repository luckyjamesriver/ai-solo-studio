import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** 当前打开的项目（已规范化的真实路径）。渲染进程不能传任意路径，只能操作用户通过系统对话框选中的项目，或按编号打开最近项目。 */
let project: string | null = null;
/** 等待用户确认“创建版本记录”的非 Git 文件夹。确认前不会打开，也不会改动任何东西。 */
let pendingInit: string | null = null;

const dataDir = () => app.getPath('userData');
const recent = () => new RecentProjects(dataDir());
const disclosureStore = () => new DisclosureStore(dataDir());
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
  return {
    path: dir,
    name: path.basename(dir),
    isRepo: repo,
    uncommitted: repo ? await G.uncommittedCount(dir) : 0,
    savePoints: repo ? await G.savePoints(dir, 20) : [],
    tasks: repo ? await new TaskStore(dir).list() : [],
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
  await recent().record(v.path);
  return { kind: 'opened', status: await projectStatus() };
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
let tasksFor: { dir: string; ctl: TaskController } | null = null;
async function tasks(): Promise<TaskController> {
  const dir = requireProject();
  if (tasksFor?.dir === dir) return tasksFor.ctl;
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
    prefs: new TaskPrefs(dataDir()),
  });
  tasksFor = { dir, ctl };
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
