import type { SentItem, ThinkStatus, ThinkUsage } from '../types.js';

/** 线程（流程）状态。注意：它与“调用尝试”分开——尝试失败不会让线程状态前进。 */
export type ThreadState =
  | 'requirements_draft'
  | 'requirements_confirmed'
  | 'drafted'
  | 'reviewed'
  | 'revised'
  | 'awaiting_approval'
  | 'approved'
  | 'task_exported'
  | 'stopped'
  | 'rejected';

export type StepName = 'requirements' | 'draft' | 'review' | 'revise';
export type ChatStepName = 'chat_planner' | 'chat_reviewer';
export type AnyStepName = StepName | ChatStepName;

export interface RequirementItem {
  id: string; // R1、R2…，冻结后稳定
  text: string; // 一句话描述
}

/** 一次调用思考者 = 一条独立的尝试记录，只追加，不覆盖。 */
export interface AttemptRecord {
  step: AnyStepName;
  /** 该步骤内的尝试序号，从 1 开始 */
  n: number;
  thinkerId: string;
  role: 'planner' | 'reviewer';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ThinkStatus;
  model?: string;
  usage?: ThinkUsage;
  sent: SentItem[];
  service: string;
  error?: string;
  isolationEvidence?: string;
  refusedToolRequests?: string[];
  /** 冻结条目后，思考者输出里试图改动条目的内容：被忽略，仅记录 */
  ignoredRequirementChanges?: unknown;
  /** 宿主对结构做的额外检查失败（例如缺少对某条目的覆盖说明）——此时 status 记为 incomplete */
  hostCheckError?: string;
  /** 只有产生了正式产物才有 */
  artifact?: { name: string; version: number };
  /** 用户在重试时补充的说明（修改输入后重试） */
  userNote?: string;
}

export interface ArtifactRecord {
  name: string; // 例如 requirements / requirements_confirmed / draft / review / revise / checks
  version: number;
  file: string; // 相对线程目录
  sha256: string;
  createdAt: string;
  /** 产生它的尝试（requirements_confirmed / checks 为宿主产物，无尝试） */
  fromAttempt?: { step: StepName; n: number };
}

export type Decision = 'accept' | 'reject';
export interface Adjudication {
  kind: 'finding' | 'scope';
  key: string; // finding: 意见序号；scope: 差异键
  decision: Decision;
  reason: string;
  at: string;
}

export interface ThreadBudget {
  maxCalls: number;
  stepTimeoutMs: number;
  /** 累计调用耗时上限（只统计已记录的调用耗时，不含用户思考时间） */
  maxTotalCallMs: number;
  /** 累计已知费用上限（仅统计报告了费用的思考者；Codex 不计金额） */
  maxCostUsd?: number;
}

export interface ThreadRecord {
  schema: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: ThreadState;
  stoppedReason?: string;
  /** 讨论是否已正式开始（锁定当时的角色配置，后续修改全局/项目设置不再影响该线程） */
  started?: boolean;
  presetHint?: string;
  modelHint?: string;
  roleSourceLabel?: string;
  sameAiSingle?: boolean;
  plannerLabel?: string;
  reviewerLabel?: string;
  rawRequirement: string;
  /** 单思考者模式：未经独立评审 */
  single: boolean;
  plannerId: string;
  reviewerId?: string;
  budget: ThreadBudget;
  optionalFiles: string[];
  attempts: AttemptRecord[];
  artifacts: ArtifactRecord[];
  adjudications: Adjudication[];
  /** 上一次尝试失败的原因（线程恢复时显示） */
  lastFailure?: { step: StepName; status: ThinkStatus; error?: string; at: string };
  /** 重试时用户补充的说明，按步骤保存，用于下一次尝试 */
  pendingNotes: Partial<Record<StepName, string>>;
  plan?: { path: string; sha256: string; artifactVersion: number };
  exported?: { taskId: string; at: string; taskFile: string; manifest: string };
  /** 日志：时间 + 一句话 */
  log: { at: string; text: string }[];
}

/** 评审意见：六字段（处理结果由规划者在修订步骤填写） */
export type Severity = '阻断' | '建议' | '信息补充';
export type Resolution = '已解决' | '未解决' | '交用户裁决';
export interface Finding {
  problem: string;
  severity: Severity;
  basis: string;
  impact: string;
  suggestion: string;
  resolution: string; // 评审者留空
}

export type BasisStatus = '提供了依据（文件存在）' | '依据无法核实' | '未经证实';
export interface FindingCheck {
  index: number;
  basisStatus: BasisStatus;
  detail: string;
}

export type ItemMark = '保留' | '修改' | '删除';
export interface ScopeDiff {
  key: string;
  kind: 'omitted' | 'deleted' | 'added';
  description: string;
}

/** 修订之后宿主做的机械检查结果（不含语义判断） */
export interface ChecksResult {
  scopeDiffs: ScopeDiff[];
  modifiedIds: string[];
  findingChecks: FindingCheck[];
  /** 需要用户逐条裁决的阻断意见序号（处理结果为 未解决 / 交用户裁决） */
  blockingFindings: number[];
  safetyIssues: string[];
  independentReview: boolean;
}

export const FLOW_STATES_ORDER: ThreadState[] = ['requirements_draft', 'requirements_confirmed', 'drafted', 'reviewed', 'revised', 'awaiting_approval', 'approved', 'task_exported'];
