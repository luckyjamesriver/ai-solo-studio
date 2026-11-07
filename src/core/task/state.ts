/**
 * 任务状态机。
 * 注意：`exec_succeeded` 只表示执行体进程以退出码 0 结束，不代表任务完成。
 * 任务是否完成由用户在验收后决定（saved）。
 */
export type TaskState =
  | 'draft'
  | 'clarifying'
  | 'planned'
  | 'approved'
  | 'running'
  | 'exec_succeeded'
  | 'exec_failed'
  | 'stopped'
  | 'timed_out'
  | 'reviewing'
  | 'saved'
  | 'discarded';

export type TaskEvent =
  | 'ask_clarification'
  | 'answer'
  | 'plan'
  | 'approve'
  | 'start'
  | 'exec_exit_ok'
  | 'exec_exit_fail'
  | 'stop'
  | 'timeout'
  | 'review'
  | 'request_fix'
  | 'save'
  | 'discard'
  | 'edit_plan';

const T: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  draft: { ask_clarification: 'clarifying', plan: 'planned', discard: 'discarded' },
  clarifying: { answer: 'draft', plan: 'planned', discard: 'discarded' },
  planned: { approve: 'approved', edit_plan: 'planned', ask_clarification: 'clarifying', discard: 'discarded' },
  approved: { start: 'running', edit_plan: 'planned', discard: 'discarded' },
  running: { exec_exit_ok: 'exec_succeeded', exec_exit_fail: 'exec_failed', stop: 'stopped', timeout: 'timed_out' },
  exec_succeeded: { review: 'reviewing' },
  exec_failed: { review: 'reviewing' },
  stopped: { review: 'reviewing' },
  timed_out: { review: 'reviewing' },
  reviewing: { request_fix: 'approved', save: 'saved', discard: 'discarded' },
  saved: {},
  discarded: {},
};

export class InvalidTransition extends Error {
  constructor(public readonly from: TaskState, public readonly event: TaskEvent) {
    super(`非法状态迁移：${from} --${event}-->`);
  }
}

export function next(state: TaskState, event: TaskEvent): TaskState {
  const to = T[state][event];
  if (!to) throw new InvalidTransition(state, event);
  return to;
}

export function canFire(state: TaskState, event: TaskEvent): boolean {
  return T[state][event] !== undefined;
}

export const TERMINAL: readonly TaskState[] = ['saved', 'discarded'];
