// 预加载脚本：只暴露白名单 API。sandbox 模式下必须是 CommonJS。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api = {
  detectEnvironment: () => ipcRenderer.invoke('env:detect'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecent: (id: string) => ipcRenderer.invoke('project:openRecent', id),
  listOpenProjects: () => ipcRenderer.invoke('projects:listOpen'),
  closeProject: (projectId: string) => ipcRenderer.invoke('projects:close', projectId),
  getWorkbench: () => ipcRenderer.invoke('workbench:get'),
  projectStatus: (projectId: string) => ipcRenderer.invoke('project:status', projectId),
  getProjectBrief: (projectId: string) => ipcRenderer.invoke('project:getBrief', projectId),
  saveProjectBrief: (projectId: string, brief: ProjectBriefInput) => ipcRenderer.invoke('project:saveBrief', projectId, brief),
  initProject: (consent: boolean) => ipcRenderer.invoke('project:init', consent),
  getDisclosure: () => ipcRenderer.invoke('disclosure:get'),
  acceptDisclosure: () => ipcRenderer.invoke('disclosure:accept'),
  getClaudeKeyStatus: () => ipcRenderer.invoke('settings:getClaudeKey'),
  saveClaudeKey: (secret: string) => ipcRenderer.invoke('settings:saveClaudeKey', secret),
  deleteClaudeKey: () => ipcRenderer.invoke('settings:deleteClaudeKey'),
  getAiSettings: () => ipcRenderer.invoke('settings:getAi'),
  saveAiRoles: (chief: string, reviewer: string, model: string) => ipcRenderer.invoke('settings:saveAiRoles', chief, reviewer, model),
  listProviderCatalog: () => ipcRenderer.invoke('providers:catalog'),
  listProviderProfiles: () => ipcRenderer.invoke('providers:list'),
  fetchProviderModels: (input: ProviderModelFetchInput) => ipcRenderer.invoke('providers:models', input),
  saveAndTestProvider: (input: ProviderSaveInput) => ipcRenderer.invoke('providers:saveAndTest', input),
  deleteProviderProfile: (id: string) => ipcRenderer.invoke('providers:delete', id),
  saveDefaultExecutor: (id: string) => ipcRenderer.invoke('settings:saveDefaultExecutor', id),
  listSubscriptionClis: () => ipcRenderer.invoke('subscriptions:list'),
  enableSubscriptionCli: (input: SubscriptionEnableInput) => ipcRenderer.invoke('subscriptions:testAndEnable', input),
  disableSubscriptionCli: (id: string) => ipcRenderer.invoke('subscriptions:disable', id),
  getProjectRoles: (projectId: string) => ipcRenderer.invoke('project:getRoles', projectId),
  saveProjectRoles: (projectId: string, mode: string, chief: string, reviewer: string) => ipcRenderer.invoke('project:saveRoles', projectId, mode, chief, reviewer),
  saveProjectExecutor: (projectId: string, mode: string, id: string) => ipcRenderer.invoke('project:saveExecutor', projectId, mode, id),
  // B3-2 + 阶段 2 多项目：任务。第一个参数固定为已打开的 projectId；没有任何路径参数——
  // 额外文件夹由主进程弹出系统选择框取得并校验。
  listTasks: (projectId: string) => ipcRenderer.invoke('tasks:list', projectId),
  createTask: (projectId: string, request: string) => ipcRenderer.invoke('tasks:create', projectId, request),
  getTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:get', projectId, id),
  setTaskExecutor: (projectId: string, id: string, executorId: string) => ipcRenderer.invoke('tasks:setExecutor', projectId, id, executorId),
  savePlan: (projectId: string, id: string, plan: PlanInput) => ipcRenderer.invoke('tasks:savePlan', projectId, id, plan),
  addExtraDir: (projectId: string, id: string) => ipcRenderer.invoke('tasks:addExtraDir', projectId, id),
  removeExtraDir: (projectId: string, id: string, key: string) => ipcRenderer.invoke('tasks:removeExtraDir', projectId, id, key),
  startTask: (projectId: string, id: string, ack: boolean) => ipcRenderer.invoke('tasks:start', projectId, id, ack),
  exportExternalTask: (projectId: string, id: string, ack: boolean) => ipcRenderer.invoke('tasks:exportExternal', projectId, id, ack),
  importExternalReport: (projectId: string, id: string) => ipcRenderer.invoke('tasks:importExternal', projectId, id),
  revealHandoff: (projectId: string, id: string, target: string) => ipcRenderer.invoke('tasks:revealHandoff', projectId, id, target),
  stopTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:stop', projectId, id),
  continueTask: (projectId: string, id: string) => ipcRenderer.invoke('tasks:continue', projectId, id),
  reworkTask: (projectId: string, id: string, feedback: string) => ipcRenderer.invoke('tasks:rework', projectId, id, feedback),
  reworkExternalTask: (projectId: string, id: string, feedback: string) => ipcRenderer.invoke('tasks:reworkExternal', projectId, id, feedback),
  editReworkPermissions: (projectId: string, id: string, feedback: string) => ipcRenderer.invoke('tasks:editReworkPermissions', projectId, id, feedback),
  // 阶段 5：讨论与流程引擎驱动（无路径或宽松参数；仅传项目编号、任务编号与明确裁决选项）
  getDiscussionView: (projectId: string, id: string) => ipcRenderer.invoke('discussion:get', projectId, id),
  startDiscussion: (projectId: string, id: string, preset: string) => ipcRenderer.invoke('discussion:start', projectId, id, preset),
  confirmDiscussionSend: (projectId: string, id: string, service: string, allow: boolean) => ipcRenderer.invoke('discussion:consent', projectId, id, service, allow),
  confirmDiscussionRequirements: (projectId: string, id: string, edits: RequirementEditInput[]) => ipcRenderer.invoke('discussion:confirmReqs', projectId, id, edits),
  resolveDiscussionFailure: (projectId: string, id: string, choice: string, note: string) => ipcRenderer.invoke('discussion:resolveFailure', projectId, id, choice, note),
  adjudicateDiscussion: (projectId: string, id: string, kind: string, key: string, decision: string, reason: string) => ipcRenderer.invoke('discussion:adjudicate', projectId, id, kind, key, decision, reason),
  decideDiscussionApproval: (projectId: string, id: string, decision: string) => ipcRenderer.invoke('discussion:approve', projectId, id, decision),
  modifyDiscussionRequirements: (projectId: string, id: string, newRequest: string) => ipcRenderer.invoke('discussion:modifyReqs', projectId, id, newRequest),
  sendDiscussionChat: (projectId: string, id: string, target: string, message: string) => ipcRenderer.invoke('discussion:chat', projectId, id, target, message),
  skipDiscussion: (projectId: string, id: string) => ipcRenderer.invoke('discussion:skip', projectId, id),
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
  reworkConflictTask: (projectId: string, id: string) => ipcRenderer.invoke('acceptance:reworkConflict', projectId, id),
  getSaveHistory: (projectId: string) => ipcRenderer.invoke('project:saveHistory', projectId),
  undoFromHistory: (projectId: string, id: string) => ipcRenderer.invoke('project:undoHistory', projectId, id),
  // 项目状态异常时在访达中显示项目；无参数，位置由主进程决定
  revealProject: () => ipcRenderer.invoke('project:reveal'),
  onSaveProgress: (listener: (ev: SaveProgressEvent) => void) => {
    const handler = (_e: IpcRendererEvent, ev: SaveProgressEvent) => listener(ev);
    ipcRenderer.on('acceptance:saveProgress', handler);
    return () => {
      ipcRenderer.removeListener('acceptance:saveProgress', handler);
    };
  },
};

/** 计划表单：只有文字、模式与布尔值 */
interface PlanInput {
  goal: string;
  criteria: string[];
  mode: 'standard' | 'full_trust';
  network: boolean;
}

/** 需求条目确认编辑项 */
interface RequirementEditInput {
  id?: string;
  text: string;
}

/** 项目简介（三个问题，写入 .studio/project-brief.md） */
interface ProjectBriefInput {
  whatItIs: string;
  principles: string;
  targetUsers: string;
}

interface ProviderModelFetchInput {
  presetId: string;
  endpoint: string;
  secret?: string;
  savedId?: string;
}

interface ProviderSaveInput {
  id?: string;
  presetId: string;
  label?: string;
  endpoint: string;
  model: string;
  secret?: string;
}

interface SubscriptionEnableInput {
  cliId: string;
  riskAck: boolean;
  model?: string;
}

interface SaveProgressEvent {
  projectId?: string;
  taskId: string;
  saveSteps: { key: string; label: string; status: string; detail?: string }[];
  finished: boolean;
}

contextBridge.exposeInMainWorld('studio', api);
export type StudioApi = typeof api;
