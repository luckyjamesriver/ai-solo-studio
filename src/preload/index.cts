// 预加载脚本：只暴露白名单 API。sandbox 模式下必须是 CommonJS。
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  detectEnvironment: () => ipcRenderer.invoke('env:detect'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecent: (id: string) => ipcRenderer.invoke('project:openRecent', id),
  listOpenProjects: () => ipcRenderer.invoke('projects:listOpen'),
  closeProject: (projectId: string) => ipcRenderer.invoke('projects:close', projectId),
  getWorkbench: () => ipcRenderer.invoke('workbench:get'),
  projectStatus: (projectId: string) => ipcRenderer.invoke('project:status', projectId),
  initProject: (consent: boolean) => ipcRenderer.invoke('project:init', consent),
  getDisclosure: () => ipcRenderer.invoke('disclosure:get'),
  acceptDisclosure: () => ipcRenderer.invoke('disclosure:accept'),
  // B3-2 + 阶段 2 多项目：任务。第一个参数固定为已打开的 projectId；没有任何路径参数——
  // 额外文件夹由主进程弹出系统选择框取得并校验。
  listTasks: (projectId: string) => ipcRenderer.invoke('tasks:list', projectId),
  createTask: (projectId: string, request: string) => ipcRenderer.invoke('tasks:create', projectId, request),
  getTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:get', projectId, id),
  savePlan: (projectId: string, id: string, plan: PlanInput) => ipcRenderer.invoke('tasks:savePlan', projectId, id, plan),
  addExtraDir: (projectId: string, id: string) => ipcRenderer.invoke('tasks:addExtraDir', projectId, id),
  removeExtraDir: (projectId: string, id: string, key: string) => ipcRenderer.invoke('tasks:removeExtraDir', projectId, id, key),
  startTask: (projectId: string, id: string, ack: boolean) => ipcRenderer.invoke('tasks:start', projectId, id, ack),
  stopTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:stop', projectId, id),
  continueTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:continue', projectId, id),
  // B4-2 + 阶段 2 多项目：验收、保存、放弃、撤销。参数只有已打开项目编号、任务编号、条目编号（c0 / d0）与验收版本；没有路径、分支或 Git 参数。
  getAcceptanceView: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:get', projectId, id),
  openPreview: (projectId: string, id: string, version: string) => ipcRenderer.invoke('acceptance:openPreview', projectId, id, version),
  skipPreview: (projectId: string, id: string, version: string) => ipcRenderer.invoke('acceptance:skipPreview', projectId, id, version),
  confirmCriterion: (projectId: string, id: string, itemId: string, version: string) => ipcRenderer.invoke('acceptance:confirmCriterion', projectId, id, itemId, version),
  rejectCriterion: (projectId: string, id: string, itemId: string, version: string, reason: string) => ipcRenderer.invoke('acceptance:rejectCriterion', projectId, id, itemId, version, reason),
  confirmOverall: (projectId: string, id: string, version: string) => ipcRenderer.invoke('acceptance:confirmOverall', projectId, id, version),
  ackDenied: (projectId: string, id: string, itemId: string, version: string) => ipcRenderer.invoke('acceptance:ackDenied', projectId, id, itemId, version),
  recheck: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:recheck', projectId, id),
  saveTask: (projectId: string, id: string, version: string) => ipcRenderer.invoke('acceptance:save', projectId, id, version),
  saveUncheckedTask: (projectId: string, id: string, version: string) => ipcRenderer.invoke('acceptance:saveUnchecked', projectId, id, version),
  discardTask: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:discard', projectId, id),
  undoSave: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:undo', projectId, id),
  retryCleanup: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:retryCleanup', projectId, id),
  // 项目状态异常时在访达中显示项目；无参数，位置由主进程决定
  revealProject: () => ipcRenderer.invoke('project:reveal'),
};

/** 计划表单：只有文字、模式与布尔值 */
interface PlanInput {
  goal: string;
  criteria: string[];
  mode: 'standard' | 'full_trust';
  network: boolean;
}

contextBridge.exposeInMainWorld('studio', api);
export type StudioApi = typeof api;
