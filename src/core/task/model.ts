import type { TaskState } from './state.js';
import type { Worktree } from '../git/git.js';
import type { ExitOutcome } from '../executor/types.js';
import type { AcceptanceCard, CriterionState } from '../acceptance/card.js';

export interface Plan {
  goal: string;
  inScope: string[];
  outOfScope: string[];
  criteria: string[];
  risks: string[];
  /** 本任务中可能无法通过撤销恢复的影响（执行前展示给用户） */
  irreversible: string[];
}

export interface TimelineEntry {
  at: string;
  kind: 'state' | 'message' | 'tool' | 'permission' | 'check' | 'error';
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
  criteria: CriterionState[];
  previewed: boolean;
  card?: AcceptanceCard;
  timeline: TimelineEntry[];
  createdAt: string;
  updatedAt: string;
}
