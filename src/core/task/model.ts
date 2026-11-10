import type { TaskState } from './state.js';
import type { Worktree } from '../git/git.js';
import type { ExitOutcome, DeniedOperation } from '../executor/types.js';
import type { AcceptanceCard, CriterionState, GitBinding } from '../acceptance/card.js';

import type { Capabilities } from '../capabilities/model.js';
import type { EffectivePermissions } from '../executor/modes.js';
import type { UnavailableReason, UncheckedKind } from '../checks/scripts.js';

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
  /** started → task_committed → trial_merging → trial_merged → trial_checked → writing → merged → finished（保存）；started → finished（其他） */
  phase:
    | 'started'
    | 'task_committed'
    | 'trial_merging'
    | 'trial_merged'
    | 'trial_checked'
    | 'writing'
    | 'merged'
    | 'finished'
    | 'interrupted';
  /** 操作开始时主项目 HEAD（保存：合并前；撤销：撤销前） */
  preHead?: string;
  taskCommit?: string;
  /** 保存试合并用的临时 worktree 路径（中断后启动核对据此清理残留） */
  trialWorktreePath?: string;
  /** 试合并产生的提交 */
  trialCommit?: string;
  /** 试检查是否运行并全部通过 */
  checked?: boolean;
  /** 未检查保存时的分类：none（无检查脚本）/ unavailable（有脚本但未能运行） */
  uncheckedKind?: UncheckedKind;
  /** unavailable 时的原因分类 */
  unavailableReason?: UnavailableReason;
  /** 用户确认在「未检查」状态下仍然保存的时间 */
  uncheckedConfirmedAt?: string;
  /** 试检查通过/失败数量 */
  checksSummary?: { passed: number; failed: number };
  /** 试检查时间 */
  checkedAt?: string;
  mergeCommit?: string;
  /** 撤销产生的新提交 */
  undoCommit?: string;
  steps: { at: string; name: string; ok: boolean; detail?: string }[];
  finishedAt?: string;
}

export interface ChecksSummary {
  passed: number;
  failed: number;
}

export type SaveStepKey = 'check_changes' | 'trial_merge' | 'trial_checks' | 'final_verify';
export type SaveStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SaveProgressStep {
  key: SaveStepKey;
  label: string;
  status: SaveStepStatus;
  detail?: string;
}

export interface SaveProgressEvent {
  projectId?: string;
  taskId: string;
  saveSteps: SaveProgressStep[];
  finished: boolean;
}

export interface LastSaveSnapshot {
  reason: string;
  at: string;
  saveSteps: SaveProgressStep[];
  files?: string[];
  failedChecks?: ('build' | 'test')[];
  failedCheckCounts?: { build?: number; test?: number };
  totalFailedItems?: number;
  uncheckedKind?: UncheckedKind;
  unavailableReason?: UnavailableReason;
  blockingTaskId?: string;
  blockingTaskGoal?: string;
  cleanupPending?: boolean;
}

export interface UncheckedConfirmPending {
  /** 返回 unchecked_needs_confirm 时的验收版本（acceptedTree + acceptanceRev），版本变化即失效 */
  version: string;
  /** 返回 unchecked_needs_confirm 时主项目 HEAD，用于识别两次调用之间项目变化 */
  preHead: string;
  kind: UncheckedKind;
  unavailableReason?: UnavailableReason;
  reasonText: string;
  at: string;
}

/** 验收版本：冻结内容的短哈希 + 证据序号（重新检查后序号加一，即使内容没变旧版本也作废） */
export function acceptanceVersion(t: Pick<Task, 'acceptedTree' | 'acceptanceRev'>): string {
  return t.acceptedTree ? `${t.acceptedTree.slice(0, 12)}-${t.acceptanceRev ?? 0}` : '';
}

/** 保存的结果，撤销只能依据它 */
export interface SaveRecord {
  preMergeHead: string;
  taskCommit: string;
  mergeCommit: string;
  branch: string;
  savedAt: string;
  /** 合并后是否运行了全部声明的自动检查并通过 */
  checked?: boolean;
  /** 未检查保存时记录：项目无检查脚本（none）还是有脚本但没能运行（unavailable） */
  uncheckedKind?: UncheckedKind;
  /** unavailable 时的原因分类 */
  unavailableReason?: UnavailableReason;
  /** 用户在界面或调用方明确确认在「未检查」状态下保存的时间 */
  uncheckedConfirmedAt?: string;
  /** 合并后自动检查通过/失败数量 */
  checksSummary?: ChecksSummary;
  /** 运行合并后自动检查的时间（未检查时省略） */
  checkedAt?: string;
  /** 试合并产生的提交（写入主项目 --ff-only 的源提交） */
  trialCommit?: string;
}

export interface AcceptedRiskRecord {
  title: string;
  reason: string;
  at?: string;
}

export interface StoredCheckProof {
  name: 'build' | 'test';
  status: 'passed' | 'failed' | 'not_available';
  ranAt?: string;
  durationMs?: number;
  env: 'sandbox' | 'local';
  /** 完整原始输出只保存在本机 .studio/ 任务记录中，绝不直接原样透传给渲染层 */
  rawOutput?: string;
  exitKind?: ExitOutcome['kind'];
  exitCode?: number | null;
  unavailableReason?: string;
}

export interface RoundCriterionSnapshot {
  text: string;
  decision?: 'confirmed' | 'rejected';
  note?: string;
}

export interface TaskRound {
  round: number;
  startedAt: string;
  endedAt?: string;
  /** 本轮补充说明：继续执行记为「接着上次停下的地方继续」，退回修改记为反馈+不符合的标准；第 1 轮省略 */
  feedback?: string;
  capabilities?: Capabilities;
  executorId?: string;
  executorName?: string;
  model?: string;
  effectivePermissions?: EffectivePermissions;
  exit?: ExitOutcome;
  gitBinding?: GitBinding;
  acceptedTree?: string;
  checksVoid?: string;
  denied: DeniedOperation[];
  deniedAcks: boolean[];
  criteria: RoundCriterionSnapshot[];
  overallConfirmed?: boolean;
  overallDecision?: 'confirmed' | 'rejected';
  overallNote?: string;
  checks: StoredCheckProof[];
  card?: AcceptanceCard;
  aiMessages: string[];
}

export interface ConflictInfo {
  files: string[];
  againstHead: string;
  otherTaskId?: string;
  otherGoal?: string;
  otherSavedAt?: string;
  at: string;
}

export interface Task {
  id: string;
  /** 记录的修订号：由存储层在读取和提交后填入，不随记录内容保存；提交时用来做 CAS（ADR 0005） */
  revision?: number;
  /** 记录当前的运行编号：由存储层在读取后填入；开工时换成新的，旧运行的回传一律被拒绝 */
  runId?: string;
  /** 讨论阶段绑定的唯一思考线程编号（一个任务对应一个线程） */
  threadId?: string;
  /** 由单思考者讨论批准转换而来的计划：界面任何展示该方案/计划的地方均标注「未经独立评审」 */
  planUnreviewed?: boolean;
  /** 讨论批准后写入的方案文档相对路径（如 docs/plans/...） */
  approvedPlanPath?: string;
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
  /** 方案批准后修改验收标准导致退回 planned 时的提示 */
  reapproveNotice?: string;
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
  /** 验收标准为空时，用户在验收页选择的“符合 / 不符合” */
  overallDecision?: 'confirmed' | 'rejected';
  /** 验收标准为空且选择“不符合”时的说明（选填） */
  overallNote?: string;
  /** 阶段 5 预留：用户确认并驳回评审意见后保留下来的已知风险 */
  acceptedRisks?: AcceptedRiskRecord[];
  /** 当前施工/验收轮次（从 1 开始） */
  currentRound?: number;
  roundStartedAt?: string;
  roundEndedAt?: string;
  /** 当前轮次最近一次自动检查明细（含未脱敏的本机原始输出） */
  currentChecks?: StoredCheckProof[];
  /** 待写入下一轮的反馈/指令（继续执行 / 退回修改 / 修改权限后重启） */
  pendingFeedback?: string;
  /** 每一轮的独立归档记录（第 1..N 轮），新一轮不得覆盖旧轮次 */
  rounds?: TaskRound[];
  /** 保存时项目是否有自定义提交检查（保存不会运行它们） */
  customCommitChecks?: boolean;
  /** 保存结果（撤销依据） */
  saveRecord?: SaveRecord;
  /** 最近一次保存因“未检查”停下等待确认的状态（版本变化或保存结束即清除） */
  uncheckedConfirm?: UncheckedConfirmPending;
  /** 最近一次保存/放弃/撤销/清理的阶段日志 */
  op?: OpLog;
  /** 最近一次保存尝试的四步真实进度与结果快照（供 #10-save-result 展示） */
  lastSave?: LastSaveSnapshot;
  /** 保存前试检查中失败的检查原始凭证（供从检查失败页跳转到 #08-evidence 查看） */
  trialChecks?: StoredCheckProof[];
  /** 保存冲突记录（供 #11-save-conflict 展示与在最新项目上重做） */
  conflict?: ConflictInfo;
  /** 启动核对或操作后无法判定的状态：需要人工查看（不自动动手） */
  manualReview?: { reason: string; at: string; files?: string[] };
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
