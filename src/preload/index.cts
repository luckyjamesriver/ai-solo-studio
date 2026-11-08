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
};

contextBridge.exposeInMainWorld('studio', api);
export type StudioApi = typeof api;
