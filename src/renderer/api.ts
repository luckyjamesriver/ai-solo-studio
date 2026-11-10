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
  HandoffView,
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
export type {
  UserAcceptanceView,
  RoundSnapshotView,
  ReworkContextView,
  ViewItem,
  ViewChange,
  ActionState,
  SaveRecordView,
  SaveOutcomeView,
  SaveOutcomeKind,
  SaveOutcomeButton,
  SaveOutcomeButtonAction,
  SaveFailedCheckSummary,
  SaveConflictView,
  SaveConflictDiffView,
  SaveConflictSideView,
  UncheckedConfirmView,
  AcceptanceStatusView,
  AcceptanceStatusKind,
  AcceptedRiskView,
  ProofTab,
  SingleCheckProof,
  TaskProofView,
  TestCaseProof,
  ProofDeniedEntry,
  ProofChangeEntry,
} from '../core/acceptance/view.js';
export type { SaveProgressEvent, SaveProgressStep, SaveStepKey, SaveStepStatus } from '../core/task/model.js';
export type { ChangePreview, Hunk } from '../core/acceptance/snippets.js';
export type { AcceptanceActionResult, UndoHistoryResult } from '../core/app/task-controller.js';
export type {
  SaveHistoryEntryKind,
  SaveHistoryEntryView,
  SaveHistoryProjectLock,
  SaveHistoryView,
  UndoConfirmView,
} from '../core/acceptance/history.js';
export type { ClaudeKeySaveResult, ClaudeKeyStatus, ClaudeKeyValidationCategory } from '../core/app/claude-key.js';
export type {
  AiProviderId,
  ChiefRoleChoice,
  EffectiveRolesResult,
  GlobalAiRoles,
  GlobalAiSettingsView,
  ProjectAiRolesConfig,
  ProjectRoleMode,
  ProjectRolesView,
  ReviewerRoleChoice,
} from '../core/app/ai-settings.js';
export type { DiscussionView, DiscussionPreset } from '../core/app/discussion-service.js';
export type {
  BasisStatus,
  ChatStepName,
  ChatTarget,
  Decision,
  DiscussionBudgetView,
  DiscussionChatMessage,
  DiscussionChatsView,
  DiscussionStepStatus,
  PauseKind,
  PendingAdjudicationItem,
  ProjectBriefInput,
  ProjectBriefView,
  RequirementItem,
  ReviewFindingRecord,
  ReviewRecordSnapshot,
  StepName,
} from '../core/thinking/flow/index.js';
import type { ClaudeKeySaveResult, ClaudeKeyStatus } from '../core/app/claude-key.js';
import type { GlobalAiSettingsView, ProjectRolesView } from '../core/app/ai-settings.js';
import type { ProjectBriefInput as BriefIn, ProjectBriefView as BriefView } from '../core/thinking/flow/index.js';
import type { UserAcceptanceView } from '../core/acceptance/view.js';
import type { SaveProgressEvent } from '../core/task/model.js';
import type { DiscussionView } from '../core/app/discussion-service.js';
import type { AcceptanceActionResult, UndoHistoryResult } from '../core/app/task-controller.js';
import type { SaveHistoryView } from '../core/acceptance/history.js';
import type { CloseProjectResult, OpenProjectSummary, WorkbenchView } from '../core/app/open-projects.js';
import type { TaskView } from '../core/app/task-view.js';
/** 计划表单：只有文字、模式与布尔值，没有任何路径 */
export interface PlanInput { goal: string; criteria: string[]; mode: 'standard' | 'full_trust'; network: boolean }
export interface RequirementEditInput { id?: string; text: string }
export interface AddDirResult { view: TaskView; cancelled: boolean; rejected: string | null }

interface StudioApi {
  listTasks(projectId: string): Promise<{ tasks: TaskView[]; preferredMode: 'standard' | 'full_trust' }>;
  createTask(projectId: string, request: string): Promise<TaskView>;
  getTask(projectId: string, id: string): Promise<TaskView>;
  savePlan(projectId: string, id: string, plan: PlanInput): Promise<TaskView>;
  addExtraDir(projectId: string, id: string): Promise<AddDirResult>;
  removeExtraDir(projectId: string, id: string, key: string): Promise<TaskView>;
  startTask(projectId: string, id: string, ack: boolean): Promise<TaskView>;
  exportExternalTask(projectId: string, id: string, ack: boolean): Promise<TaskView>;
  revealHandoff(projectId: string, id: string, target: string): Promise<void>;
  stopTask(projectId: string, id: string): Promise<TaskView>;
  continueTask(projectId: string, id: string): Promise<TaskView>;
  reworkTask(projectId: string, id: string, feedback: string): Promise<TaskView>;
  editReworkPermissions(projectId: string, id: string, feedback: string): Promise<TaskView>;
  getDiscussionView(projectId: string, id: string): Promise<DiscussionView>;
  startDiscussion(projectId: string, id: string, preset: string): Promise<DiscussionView>;
  confirmDiscussionSend(projectId: string, id: string, service: string, allow: boolean): Promise<DiscussionView>;
  confirmDiscussionRequirements(projectId: string, id: string, edits: RequirementEditInput[]): Promise<DiscussionView>;
  resolveDiscussionFailure(projectId: string, id: string, choice: string, note: string): Promise<DiscussionView>;
  adjudicateDiscussion(projectId: string, id: string, kind: string, key: string, decision: string, reason: string): Promise<DiscussionView>;
  decideDiscussionApproval(projectId: string, id: string, decision: string): Promise<{ view: DiscussionView; task: TaskView }>;
  modifyDiscussionRequirements(projectId: string, id: string, newRequest: string): Promise<TaskView>;
  sendDiscussionChat(projectId: string, id: string, target: string, message: string): Promise<DiscussionView>;
  skipDiscussion(projectId: string, id: string): Promise<TaskView>;
  getAcceptanceView(projectId: string, id: string): Promise<UserAcceptanceView>;
  openPreview(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  skipPreview(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  confirmCriterion(projectId: string, id: string, itemId: string, version: string): Promise<AcceptanceActionResult>;
  rejectCriterion(projectId: string, id: string, itemId: string, version: string, reason: string): Promise<AcceptanceActionResult>;
  confirmOverall(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  ackDenied(projectId: string, id: string, itemId: string, version: string): Promise<AcceptanceActionResult>;
  recheck(projectId: string, id: string): Promise<AcceptanceActionResult>;
  saveTask(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  saveUncheckedTask(projectId: string, id: string, version: string): Promise<AcceptanceActionResult>;
  discardTask(projectId: string, id: string): Promise<AcceptanceActionResult>;
  undoSave(projectId: string, id: string): Promise<AcceptanceActionResult>;
  retryCleanup(projectId: string, id: string): Promise<AcceptanceActionResult>;
  reworkConflictTask(projectId: string, id: string): Promise<AcceptanceActionResult>;
  getSaveHistory(projectId: string): Promise<SaveHistoryView>;
  undoFromHistory(projectId: string, id: string): Promise<UndoHistoryResult>;
  revealProject(): Promise<void>;
  onSaveProgress(listener: (ev: SaveProgressEvent) => void): () => void;
  detectEnvironment(): Promise<HealthReport>;
  chooseProject(): Promise<OpenResult>;
  recentProjects(): Promise<RecentProject[]>;
  openRecent(id: string): Promise<OpenResult>;
  listOpenProjects(): Promise<OpenProjectSummary[]>;
  closeProject(projectId: string): Promise<CloseProjectResult>;
  getWorkbench(): Promise<WorkbenchView>;
  projectStatus(projectId: string): Promise<ProjectStatus>;
  getProjectBrief(projectId: string): Promise<BriefView>;
  saveProjectBrief(projectId: string, brief: BriefIn): Promise<BriefView>;
  getProjectRoles(projectId: string): Promise<ProjectRolesView>;
  saveProjectRoles(projectId: string, mode: string, chief: string, reviewer: string): Promise<ProjectRolesView>;
  initProject(consent: boolean): Promise<OpenResult>;
  getDisclosure(): Promise<DisclosureState>;
  acceptDisclosure(): Promise<DisclosureState>;
  getClaudeKeyStatus(): Promise<ClaudeKeyStatus>;
  saveClaudeKey(secret: string): Promise<ClaudeKeySaveResult>;
  deleteClaudeKey(): Promise<ClaudeKeyStatus>;
  getAiSettings(): Promise<GlobalAiSettingsView>;
  saveAiRoles(chief: string, reviewer: string, model: string): Promise<GlobalAiSettingsView>;
}

declare global {
  interface Window { studio?: StudioApi }
}

export const studio = (): StudioApi => {
  if (!window.studio) throw new Error('请在 AI Solo Studio 桌面应用中打开此界面。');
  return window.studio;
};
