export type LayerState = 'pass' | 'fail' | 'unknown' | 'na';
export interface Layer { state: LayerState; note?: string }
export type LayerKey = 'installed' | 'starts' | 'compatible' | 'loggedIn' | 'secured';
export interface HealthItem {
  id: 'git' | 'node' | 'npm' | 'codex';
  label: string;
  layers: Record<LayerKey, Layer>;
  overall: 'pass' | 'fail' | 'unknown';
  foundVia: 'path' | 'fallback' | null;
  location?: string;
  version?: string;
  advice?: string;
  help?: string;
}
export interface HealthReport {
  items: HealthItem[];
  limitations: string[];
  pathInfo: { processPath: string; supplementalDirs: string[] };
  project: { name: string } | null;
  firstRun?: boolean;
}
export interface SavePoint { sha: string; message: string; date: string; checked?: boolean; checksText?: '检查通过' | '未检查' }
export interface ProjectStatus { id: string; path: string; name: string; isRepo: boolean; uncommitted: number; savePoints: SavePoint[]; tasks: { id: string; request: string; state: string }[] }
export type OpenResult =
  | { kind: 'opened'; status: ProjectStatus }
  | { kind: 'needs_init'; name: string; path: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'declined' };
export interface RecentProject { id: string; name: string; path: string; lastOpened: string; exists: boolean }
export interface DisclosureState {
  content: { version: number; services: { name: string; role: string }[]; when: string[]; never: string[] };
  accepted: { acceptedAt: string; services: string[] } | null;
}

export type {
  TaskView,
  ResultView,
  FactView,
  ExtraDirView,
  BuildingView,
  BuildingStep,
  BuildingProblem,
  ExecLogEntry,
  StoppedInfo,
} from '../core/app/task-view.js';
export type { TaskClassification, TaskStage, TaskOutcome, WorkbenchGroup } from '../core/app/task-state-view.js';
export type { OpenProjectSummary, CloseProjectResult, WorkbenchEntry, WorkbenchNextAction, WorkbenchView } from '../core/app/open-projects.js';
export type { UserAcceptanceView, ViewItem, ViewChange, ActionState, SaveRecordView, UncheckedConfirmView } from '../core/acceptance/view.js';
export type { ChangePreview, Hunk } from '../core/acceptance/snippets.js';
export type { AcceptanceActionResult } from '../core/app/task-controller.js';
import type { UserAcceptanceView } from '../core/acceptance/view.js';
import type { AcceptanceActionResult } from '../core/app/task-controller.js';
import type { CloseProjectResult, OpenProjectSummary, WorkbenchView } from '../core/app/open-projects.js';
import type { TaskView } from '../core/app/task-view.js';
/** 计划表单：只有文字、模式与布尔值，没有任何路径 */
export interface PlanInput { goal: string; criteria: string[]; mode: 'standard' | 'full_trust'; network: boolean }
export interface AddDirResult { view: TaskView; cancelled: boolean; rejected: string | null }

interface StudioApi {
  listTasks(projectId: string): Promise<{ tasks: TaskView[]; preferredMode: 'standard' | 'full_trust' }>;
  createTask(projectId: string, request: string): Promise<TaskView>;
  getTask(projectId: string, id: string): Promise<TaskView>;
  savePlan(projectId: string, id: string, plan: PlanInput): Promise<TaskView>;
  addExtraDir(projectId: string, id: string): Promise<AddDirResult>;
  removeExtraDir(projectId: string, id: string, key: string): Promise<TaskView>;
  startTask(projectId: string, id: string, ack: boolean): Promise<TaskView>;
  stopTask(projectId: string, id: string): Promise<TaskView>;
  continueTask(projectId: string, id: string): Promise<TaskView>;
  getAcceptanceView(projectId: string, id: string): Promise<UserAcceptanceView>;
  openPreview(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  skipPreview(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  confirmCriterion(projectId: string, id: string, itemId: string, version: string): Promise<AcceptanceActionResult>;
  confirmOverall(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  ackDenied(projectId: string, id: string, itemId: string, version: string): Promise<AcceptanceActionResult>;
  recheck(projectId: string, id: string): Promise<AcceptanceActionResult>;
  saveTask(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  saveUncheckedTask(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  discardTask(projectId: string, id: string): Promise<AcceptanceActionResult>;
  undoSave(projectId: string, id: string): Promise<AcceptanceActionResult>;
  retryCleanup(projectId: string, id: string): Promise<AcceptanceActionResult>;
  revealProject(): Promise<void>;
  detectEnvironment(): Promise<HealthReport>;
  chooseProject(): Promise<OpenResult>;
  recentProjects(): Promise<RecentProject[]>;
  openRecent(id: string): Promise<OpenResult>;
  listOpenProjects(): Promise<OpenProjectSummary[]>;
  closeProject(projectId: string): Promise<CloseProjectResult>;
  getWorkbench(): Promise<WorkbenchView>;
  projectStatus(projectId: string): Promise<ProjectStatus>;
  initProject(consent: boolean): Promise<OpenResult>;
  getDisclosure(): Promise<DisclosureState>;
  acceptDisclosure(): Promise<DisclosureState>;
}

declare global {
  interface Window { studio?: StudioApi }
}

export const studio = (): StudioApi => {
  if (!window.studio) throw new Error('请在 AI Solo Studio 桌面应用中打开此界面。');
  return window.studio;
};
