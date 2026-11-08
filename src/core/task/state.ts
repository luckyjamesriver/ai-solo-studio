/**
 * 任务状态机。
 * 注意：`exec_succeeded` 只表示执行体进程以退出码 0 结束，不代表任务完成。
 * 任务是否完成由用户在验收后决定（saved）。
 *
 * B4 新增状态（保存 / 放弃 / 撤销的结果，清理失败不吞错）：
 * - saved_cleanup_pending：已保存，但临时文件（副本、分支）还没清理干净，可重试清理
 * - save_failed_unmerged：合并冲突，本次没有保存，AI 的成果保留
 * - discard_cleanup_pending：放弃时清理失败，可重试清理
 * - undone：已撤销这次保存
 * - undo_failed：撤销失败（可重试）
 * 进行中的操作不占用状态，而是写在任务记录的操作日志里（Task.op），以便中断后由 reconcileTasks 按 Git 真实状态核对。
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
  | 'saved_cleanup_pending'
  | 'save_failed_unmerged'
  | 'discarded'
  | 'discard_cleanup_pending'
  | 'undone'
  | 'undo_failed';

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
  | 'save_cleanup_pending'
  | 'save_conflict'
  | 'discard'
  | 'discard_cleanup_pending'
  | 'cleanup_done'
  | 'undo'
  | 'undo_failed'
  | 'edit_plan';

const T: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  draft: { ask_clarification: 'clarifying', plan: 'planned', discard: 'discarded', discard_cleanup_pending: 'discard_cleanup_pending' },
  clarifying: { answer: 'draft', plan: 'planned', discard: 'discarded', discard_cleanup_pending: 'discard_cleanup_pending' },
  planned: { approve: 'approved', edit_plan: 'planned', ask_clarification: 'clarifying', discard: 'discarded', discard_cleanup_pending: 'discard_cleanup_pending' },
  approved: { start: 'running', edit_plan: 'planned', discard: 'discarded', discard_cleanup_pending: 'discard_cleanup_pending' },
  running: { exec_exit_ok: 'exec_succeeded', exec_exit_fail: 'exec_failed', stop: 'stopped', timeout: 'timed_out' },
  exec_succeeded: { review: 'reviewing' },
  exec_failed: { review: 'reviewing' },
  stopped: { review: 'reviewing' },
  timed_out: { review: 'reviewing' },
  reviewing: {
    request_fix: 'approved',
    save: 'saved',
    save_cleanup_pending: 'saved_cleanup_pending',
    save_conflict: 'save_failed_unmerged',
    discard: 'discarded',
    discard_cleanup_pending: 'discard_cleanup_pending',
  },
  // 冲突后：可以放弃，也可以在主项目有变化后重新尝试保存；不提供“仍然保存”
  save_failed_unmerged: {
    request_fix: 'approved',
    save: 'saved',
    save_cleanup_pending: 'saved_cleanup_pending',
    save_conflict: 'save_failed_unmerged',
    discard: 'discarded',
    discard_cleanup_pending: 'discard_cleanup_pending',
  },
  saved: { undo: 'undone', undo_failed: 'undo_failed' },
  saved_cleanup_pending: { cleanup_done: 'saved' },
  discarded: {},
  discard_cleanup_pending: { cleanup_done: 'discarded' },
  undone: {},
  undo_failed: { undo: 'undone', undo_failed: 'undo_failed' },
};

/** 全部任务状态（持久化时校验记录里的状态值） */
export const TASK_STATES = Object.keys(T) as TaskState[];

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

/** 不会再有任何迁移的状态（saved 仍可撤销，所以不在其中） */
export const TERMINAL: readonly TaskState[] = ['discarded', 'undone'];

/** 状态迁移表（供文档与测试使用） */
export function transitionTable(): { from: TaskState; event: TaskEvent; to: TaskState }[] {
  return (Object.keys(T) as TaskState[]).flatMap((from) => (Object.entries(T[from]) as [TaskEvent, TaskState][]).map(([event, to]) => ({ from, event, to })));
}
