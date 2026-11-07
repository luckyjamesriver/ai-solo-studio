import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment } from '../core/env/detect.js';
import * as G from '../core/git/git.js';
import { TaskStore } from '../core/task/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** 当前打开的项目。渲染进程不能传任意路径，只能操作用户通过系统对话框选中的项目。 */
let project: string | null = null;

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
    savePoints: repo ? await G.savePoints(dir, 20) : [],
    tasks: repo ? await new TaskStore(dir).list() : [],
  };
}

ipcMain.handle('env:detect', () => detectEnvironment());
ipcMain.handle('project:choose', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择你的项目文件夹' });
  if (r.canceled || !r.filePaths[0]) return null;
  project = r.filePaths[0];
  return projectStatus();
});
ipcMain.handle('project:status', () => projectStatus());
ipcMain.handle('project:init', async (_e, consent: unknown) => {
  if (consent !== true) throw new Error('需要你明确同意后才能初始化。');
  await G.initRepo(requireProject());
  return projectStatus();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
