import type { TaskState } from './state.js';
import type { Worktree } from '../git/git.js';
import type { ExitOutcome, DeniedOperation } from '../executor/types.js';
import type { AcceptanceCard, CriterionState, GitBinding } from '../acceptance/card.js';

import type { Capabilities } from '../capabilities/model.js';
import type { EffectivePermissions } from '../executor/modes.js';

export interface Plan {
  goal: string;
  inScope: string[];
  outOfScope: string[];
  criteria: string[];
  risks: string[];
  /** 本任务中可能无法通过撤销恢复的影响（执行前展示给用户） */
  irreversible: string[];
  /** 授予执行体的能力；缺省为最小权限（需求 v1.5 第 5.1 节） */
  capabilities: Capabilities;
}

export interface TimelineEntry {
  at: string;
  kind: 'state' | 'message' | 'tool' | 'permission' | 'check' | 'error' | 'isolation';
  text: string;
  /** message 的来源：host = 应用自己加的说明；缺省 = AI 自己说的话 */
  source?: 'host';
}

/** 开工时绑定的项目位置：保存、撤销都以它为准（B4-plan 第 3 节） */
export interface TaskBinding {
  repoPath: string;
  branch: string;
  baseHead: string;
}

/** 一次保存 / 放弃 / 撤销 / 清理的阶段日志；每个阶段完成后立即落盘，中断后据此核对 Git 真实状态 */
export interface OpLog {
  kind: 'save' | 'discard' | 'undo' | 'cleanup';
  startedAt: string;
  /** started → task_committed → merged → finished（保存）；started → finished（其他） */
  phase: 'started' | 'task_committed' | 'merged' | 'finished' | 'interrupted';
  /** 操作开始时主项目 HEAD（保存：合并前；撤销：撤销前） */
  preHead?: string;
  taskCommit?: string;
  mergeCommit?: string;
  /** 撤销产生的新提交 */
  undoCommit?: string;
  steps: { at: string; name: string; ok: boolean; detail?: string }[];
  finishedAt?: string;
}

/** 保存的结果，撤销只能依据它 */
export interface SaveRecord {
  preMergeHead: string;
  taskCommit: string;
  mergeCommit: string;
  branch: string;
  savedAt: string;
}

export interface Task {
  id: string;
  /** 记录的修订号：由存储层在读取和提交后填入，不随记录内容保存；提交时用来做 CAS（ADR 0005） */
  revision?: number;
  /** 记录当前的运行编号：由存储层在读取后填入；开工时换成新的，旧运行的回传一律被拒绝 */
  runId?: string;
  request: string;
  state: TaskState;
  plan?: Plan;
  executorId?: string;
  executorName?: string;
  model?: string;
  worktree?: Worktree;
  exit?: ExitOutcome;
  /** AI 请求过、但被拒绝而没有执行的操作 */
  denied: DeniedOperation[];
  /** 与 denied 一一对应：用户是否已确认知晓 */
  deniedAcks: boolean[];
  criteria: CriterionState[];
  previewed: boolean;
  previewSkipped?: boolean;
  card?: AcceptanceCard;
  /** 批准时授权的检查脚本内容摘要（package.json 的 build/test 及 pre/post 脚本）；摘要变化则授权失效 */
  checkAuth?: { digest: string; at: string };
  /** 本任务的完全信任确认标记（门禁 requireFullTrustConfirmed 读取；每个任务单独确认） */
  fullTrustConfirmedAt?: string;
  /** 最近一次开工时实际生效的权限（取自 thread/start 响应，核验通过后才记录） */
  effectivePermissions?: EffectivePermissions;
  /** 最近一次执行的 Git 绑定：开始时记录“开始”部分，验收时补全“结束”部分 */
  gitStart?: Pick<GitBinding, 'mainHeadAtStart' | 'worktreeHeadAtStart' | 'worktreePath'>;
  gitBinding?: GitBinding;
  /** 第一次开工时记录的仓库路径、分支名、基线 HEAD（之后不再改动） */
  binding?: TaskBinding;
  /** 验收内容冻结：验收卡与检查结果绑定的 tree；保存时重新计算，不相等则拒绝保存 */
  acceptedTree?: string;
  /** 检查脚本运行期间改动了文件：检查结果已作废（原因文字） */
  checksVoid?: string;
  /** 开工后核验出的隔离异常（警告）；非空则不可保存 */
  isolationWarnings?: string[];
  /** 验收标准为空时，用户对“我已看过改动，结果符合我的要求”的整体确认 */
  overallConfirmed?: boolean;
  /** 保存时项目是否有自定义提交检查（保存不会运行它们） */
  customCommitChecks?: boolean;
  /** 保存结果（撤销依据） */
  saveRecord?: SaveRecord;
  /** 最近一次保存/放弃/撤销/清理的阶段日志 */
  op?: OpLog;
  /** 启动核对或操作后无法判定的状态：需要人工查看（不自动动手） */
  manualReview?: { reason: string; at: string };
  /** 最近一次执行的执行体进程记录（启动核对时据此判断它是否仍在运行） */
  execProc?: { pid: number; at: string; name?: string };
  /** 验收证据的版本序号：每次生成验收证据（含重新检查）加一；确认类请求必须带上当时的版本，旧版本一律拒绝 */
  acceptanceRev?: number;
  /** 启动核对修正过这个任务（界面标“已核对”并说明修正了什么） */
  reconciled?: { at: string; note: string };
  /** 最近一次清理各步结果（清理失败时展示与重试用） */
  cleanup?: { at: string; steps: { step: string; ok: boolean; error?: string }[] };
  timeline: TimelineEntry[];
  createdAt: string;
  updatedAt: string;
}
