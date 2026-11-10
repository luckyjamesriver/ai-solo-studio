import type { CommitPoint } from '../git/git.js';
import type { OpFail } from '../task/runner.js';
import { MESSAGES } from '../task/messages.js';
import type { Task } from '../task/model.js';
import { scrubAiText } from './texts.js';
import { mapFailure } from './view.js';

export type SaveHistoryEntryKind = 'save' | 'undo' | 'external';

export interface UndoConfirmView {
  taskId: string;
  goal: string;
  savedAt: string;
  title: string;
  targetSaveText: string;
  restoreStateText: string;
  commitNoteText: string;
  limitationText: string;
  confirmLabel: string;
  cancelLabel: string;
}

export interface SaveHistoryEntryView {
  entryId: string;
  kind: SaveHistoryEntryKind;
  taskId?: string;
  title: string;
  timestamp: string;
  executorText?: string;
  round?: number;
  checksLabel?: string;
  uncheckedConfirmedAt?: string;
  undone?: boolean;
  canViewTask: boolean;
  viewTaskLabel?: string;
  showUndo: boolean;
  canUndo: boolean;
  undoBlockedReason?: string;
  undoButtonLabel?: string;
  undoConfirm?: UndoConfirmView;
}

export interface SaveHistoryProjectLock {
  blockingTaskId: string;
  blockingTaskGoal: string;
  message: string;
  actionLabel: string;
}

export interface SaveHistoryView {
  entries: SaveHistoryEntryView[];
  projectLock: SaveHistoryProjectLock | null;
}

function formatExecutor(t: Task): string {
  if (t.saveRecord?.executorText) return t.saveRecord.executorText;
  const name = t.executorName ?? (t.executorId === 'fake' ? '模拟执行体（测试用）' : 'Codex');
  return t.model ? `${name} · ${t.model}` : name;
}

function checksStatusText(t: Task): string {
  const rec = t.saveRecord;
  if (!rec) return '未检查（检查没能运行）';
  if (rec.checked === true) return '检查通过';
  if (rec.uncheckedKind === 'none') return '未检查（没有检查脚本）';
  return '未检查（检查没能运行）';
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeRestoreTarget(
  preHead: string,
  byMerge: Map<string, Task>,
  byUndo: Map<string, Task>,
  commits: CommitPoint[],
): string {
  const prevSave = byMerge.get(preHead);
  if (prevSave) {
    return `「${scrubAiText(prevSave.plan?.goal ?? prevSave.request)}」保存之后的状态`;
  }
  const prevUndo = byUndo.get(preHead);
  if (prevUndo) {
    return `撤销「${scrubAiText(prevUndo.plan?.goal ?? prevUndo.request)}」之后的状态`;
  }
  const commit = commits.find((c) => c.sha === preHead);
  if (commit && (commit.parents.length === 0 || commit.message === 'studio: 初始保存点')) {
    return '上一次保存之前（项目加入工作台时的初始状态）';
  }
  return '上一次保存之前最近一次提交之后的状态';
}

function buildUndoConfirm(
  t: Task,
  byMerge: Map<string, Task>,
  byUndo: Map<string, Task>,
  commits: CommitPoint[],
): UndoConfirmView {
  const goal = scrubAiText(t.plan?.goal ?? t.request);
  const rec = t.saveRecord!;
  const prevState = describeRestoreTarget(rec.preMergeHead, byMerge, byUndo, commits);
  const caps = t.plan?.capabilities;
  const extra = !!caps && (caps.extraWritableDirs.length > 0 || caps.constructionMode === 'full_trust');
  const timeText = formatShort(rec.savedAt);
  return {
    taskId: t.id,
    goal,
    savedAt: rec.savedAt,
    title: `撤销「${goal}」的这次保存`,
    targetSaveText: timeText ? `准备撤销：「${goal}」（保存于 ${timeText}）` : `准备撤销：「${goal}」`,
    restoreStateText: `撤销后项目会回到：${prevState}`,
    commitNoteText: '撤销本身会在项目里新增一次提交来恢复文件内容，原有历史记录会保留。',
    limitationText:
      '已知局限：Git 提交无法覆盖或清除其他工具、外部同步盘或他人电脑上另行留下的记录；' +
      (extra ? MESSAGES.undoExtra : '只恢复工作区与分支跟踪的文本及文件快照。'),
    confirmLabel: '确认撤销',
    cancelLabel: '取消',
  };
}

/**
 * 按项目提交主线（倒序）与任务存储记录构造「保存记录」视图（原型 #12-history）。
 * 只允许当前有效最新保存显示可交互的撤销入口，不虚构任何超越阶段 1 的批量撤销入口。
 */
export async function buildSaveHistoryView(opts: {
  commits: CommitPoint[];
  tasks: Task[];
  previewUndo: (t: Task) => Promise<OpFail | null>;
  projectLock: Task | null;
}): Promise<SaveHistoryView> {
  const { commits, tasks, previewUndo, projectLock } = opts;

  const byId = new Map<string, Task>();
  const byMerge = new Map<string, Task>();
  const byUndo = new Map<string, Task>();
  for (const t of tasks) {
    byId.set(t.id, t);
    if (t.saveRecord?.mergeCommit) byMerge.set(t.saveRecord.mergeCommit, t);
    const undoSha = t.undoRecord?.commit ?? t.op?.undoCommit;
    if (undoSha) byUndo.set(undoSha, t);
  }

  const entries: SaveHistoryEntryView[] = [];
  for (const c of commits) {
    const undoTask = byUndo.get(c.sha);
    const undoMatch = !undoTask ? c.message.match(/^studio: 撤销「(.+)」$/) : null;
    if (undoTask || undoMatch) {
      const goal = undoTask
        ? scrubAiText(undoTask.plan?.goal ?? undoTask.request)
        : scrubAiText(undoMatch![1]!);
      entries.push({
        entryId: `undo-${c.sha.slice(0, 12)}`,
        kind: 'undo',
        ...(undoTask ? { taskId: undoTask.id } : {}),
        title: `撤销了 ${goal}`,
        timestamp: undoTask?.undoRecord?.undoneAt ?? c.date,
        canViewTask: !!undoTask,
        ...(undoTask ? { viewTaskLabel: '查看任务' } : {}),
        showUndo: false,
        canUndo: false,
      });
      continue;
    }

    const savedTask = byMerge.get(c.sha);
    if (savedTask && savedTask.saveRecord) {
      const rec = savedTask.saveRecord;
      const goal = scrubAiText(savedTask.plan?.goal ?? savedTask.request);
      entries.push({
        entryId: `save-${savedTask.id}`,
        kind: 'save',
        taskId: savedTask.id,
        title: goal,
        timestamp: rec.savedAt,
        executorText: formatExecutor(savedTask),
        round: rec.savedRound ?? savedTask.currentRound ?? 1,
        checksLabel: checksStatusText(savedTask),
        ...(rec.checked !== true && rec.uncheckedConfirmedAt ? { uncheckedConfirmedAt: rec.uncheckedConfirmedAt } : {}),
        undone: savedTask.state === 'undone',
        canViewTask: true,
        viewTaskLabel: '查看任务',
        showUndo: false,
        canUndo: false,
      });
      continue;
    }

    // 仓库最底层初始提交（没有父提交）以及工作台初始化点不算「项目外的改动」
    if (c.parents.length === 0 || c.message === 'studio: 初始保存点') {
      continue;
    }

    entries.push({
      entryId: `ext-${c.sha.slice(0, 12)}`,
      kind: 'external',
      title: '项目外的改动',
      timestamp: c.date,
      canViewTask: false,
      showUndo: false,
      canUndo: false,
    });
  }

  // 阶段 1 规则：最多只有最近一条仍有效的保存进入撤销判断（由核心层 previewUndo 给出真实结论）
  const latestValid = entries.find((e) => e.kind === 'save' && !e.undone);
  if (latestValid?.taskId) {
    const task = byId.get(latestValid.taskId);
    if (task && task.saveRecord) {
      latestValid.showUndo = true;
      latestValid.undoButtonLabel = '撤销…';
      const fail = await previewUndo(task);
      if (!fail) {
        latestValid.canUndo = true;
        latestValid.undoConfirm = buildUndoConfirm(task, byMerge, byUndo, commits);
      } else {
        latestValid.canUndo = false;
        latestValid.undoBlockedReason = mapFailure(fail).message;
      }
    }
  }

  return {
    entries,
    projectLock: projectLock
      ? {
          blockingTaskId: projectLock.id,
          blockingTaskGoal: scrubAiText(projectLock.plan?.goal ?? projectLock.request),
          message: `${scrubAiText(projectLock.plan?.goal ?? projectLock.request)} 的保存出了问题还没处理，这个项目暂时不能保存或撤销`,
          actionLabel: '去处理',
        }
      : null,
  };
}
