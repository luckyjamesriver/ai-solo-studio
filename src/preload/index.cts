// 预加载脚本：只暴露白名单 API。sandbox 模式下必须是 CommonJS。
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  detectEnvironment: () => ipcRenderer.invoke('env:detect'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecent: (id: string) => ipcRenderer.invoke('project:openRecent', id),
  projectStatus: () => ipcRenderer.invoke('project:status'),
  initProject: (consent: boolean) => ipcRenderer.invoke('project:init', consent),
  getDisclosure: () => ipcRenderer.invoke('disclosure:get'),
  acceptDisclosure: () => ipcRenderer.invoke('disclosure:accept'),
  // B3-2：任务。参数只有任务编号、需求文字、计划表单（模式/联网/文字）与布尔确认；没有任何路径参数——
  // 额外文件夹由主进程弹出系统选择框取得并校验。
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (request: string) => ipcRenderer.invoke('tasks:create', request),
  getTask: (id: string) => ipcRenderer.invoke('tasks:get', id),
  savePlan: (id: string, plan: PlanInput) => ipcRenderer.invoke('tasks:savePlan', id, plan),
  addExtraDir: (id: string) => ipcRenderer.invoke('tasks:addExtraDir', id),
  removeExtraDir: (id: string, key: string) => ipcRenderer.invoke('tasks:removeExtraDir', id, key),
  startTask: (id: string, ack: boolean) => ipcRenderer.invoke('tasks:start', id, ack),
  stopTask: (id: string) => ipcRenderer.invoke('tasks:stop', id),
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
