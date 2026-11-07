import type { TaskState } from './state.js';
import type { Worktree } from '../git/git.js';
import type { ExitOutcome, DeniedOperation } from '../executor/types.js';
import type { AcceptanceCard, CriterionState, GitBinding } from '../acceptance/card.js';

import type { Capabilities } from '../capabilities/model.js';

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
}

export interface Task {
  id: string;
  request: string;
  state: TaskState;
  plan?: Plan;
  executorId?: string;
  worktree?: Worktree;
  exit?: ExitOutcome;
  /** AI 请求过、但被拒绝而没有执行的操作 */
  denied: DeniedOperation[];
  /** 与 denied 一一对应：用户是否已确认知晓 */
  deniedAcks: boolean[];
  criteria: CriterionState[];
  previewed: boolean;
  card?: AcceptanceCard;
  /** 最近一次执行的 Git 绑定：开始时记录“开始”部分，验收时补全“结束”部分 */
  gitStart?: Pick<GitBinding, 'mainHeadAtStart' | 'worktreeHeadAtStart' | 'worktreePath'>;
  gitBinding?: GitBinding;
  timeline: TimelineEntry[];
  createdAt: string;
  updatedAt: string;
}
