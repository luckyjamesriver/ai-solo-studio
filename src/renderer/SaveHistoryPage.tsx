import { useCallback, useEffect, useState } from 'react';
import {
  studio,
  type SaveHistoryEntryView,
  type SaveHistoryView,
  type SaveOutcomeButton,
  type SaveOutcomeView,
} from './api.js';
import { COPY } from './copy.js';
import { SaveResultPanel } from './SaveResultPanel.js';

/**
 * 项目「保存记录」与撤销页面（原型 #12-history，UI v2.1 第 7 节）。
 * 所有条目分类、检查状态说明、撤销资格判断与确认说明均由核心层 SaveHistoryView 下发。
 */
export function SaveHistoryPage({
  projectId,
  refreshKey,
  onOpenTask,
  onHistoryChanged,
}: {
  projectId: string;
  refreshKey?: number | string;
  onOpenTask: (taskId: string) => void;
  onHistoryChanged?: () => void;
}) {
  const [history, setHistory] = useState<SaveHistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<SaveHistoryEntryView | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SaveOutcomeView | null>(null);
  const [lastNotice, setLastNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const h = await studio().getSaveHistory(projectId);
      setHistory(h);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const executeUndo = async (taskId: string) => {
    if (undoing) return;
    setUndoing(true);
    setLastTaskId(taskId);
    setLastOutcome(null);
    setLastNotice(null);
    try {
      const res = await studio().undoFromHistory(projectId, taskId);
      setHistory(res.history);
      setConfirmTarget(null);
      if (res.ok) {
        setLastNotice(res.message);
      } else if (res.saveOutcome) {
        setLastOutcome(res.saveOutcome);
      } else {
        setError(res.message);
      }
      onHistoryChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoing(false);
    }
  };

  const handleOutcomeAction = (btn: SaveOutcomeButton) => {
    if (btn.action === 'open_blocking_task' && btn.targetTaskId) {
      onOpenTask(btn.targetTaskId);
      return;
    }
    if (btn.action === 'reveal_project') {
      void studio().revealProject();
      return;
    }
    if (btn.action === 'copy_summary' && lastOutcome) {
      const summary = [lastOutcome.headline, ...(lastOutcome.files ?? []), lastOutcome.extraNote ?? ''].filter(Boolean).join('\n');
      void navigator.clipboard?.writeText(summary).then(() => setCopied(true), () => undefined);
      return;
    }
    if (btn.action === 'retry_save' && lastTaskId) {
      void executeUndo(lastTaskId);
    }
  };

  return (
    <section data-testid="project-history" aria-label={COPY.boardTabHistory} className="stack">
      {error && (
        <p role="alert" className="error" data-testid="history-error">
          {error}
        </p>
      )}

      {lastNotice && (
        <p className="notice" data-testid="history-notice">
          {lastNotice}
        </p>
      )}

      {history?.projectLock && (
        <section className="box wbox" data-testid="history-project-lock">
          <div className="row sb">
            <p className="error">{history.projectLock.message}</p>
            <button
              type="button"
              data-testid="history-lock-handle-button"
              onClick={() => onOpenTask(history.projectLock!.blockingTaskId)}
            >
              {history.projectLock.actionLabel}
            </button>
          </div>
        </section>
      )}

      {lastOutcome && (
        <SaveResultPanel
          liveSteps={null}
          outcome={lastOutcome}
          busy={undoing}
          copied={copied}
          onAction={handleOutcomeAction}
        />
      )}

      <div className="box" data-testid="history-list">
        <h2>保存记录</h2>
        {!history ? (
          <p className="muted">正在读取保存记录…</p>
        ) : history.entries.length === 0 ? (
          <p className="muted" data-testid="history-empty">{COPY.historyEmpty}</p>
        ) : (
          history.entries.map((entry) => (
            <div
              className="item"
              key={entry.entryId}
              data-testid={`history-entry-${entry.kind}`}
              data-entry-id={entry.entryId}
              data-undone={entry.undone ? 'true' : 'false'}
            >
              <div className="grow">
                <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
                  <strong>{entry.title}</strong>
                  {entry.undone && (
                    <span className="tag" data-testid="history-undone-badge">
                      已撤销
                    </span>
                  )}
                  {entry.kind === 'undo' && <span className="tag">撤销操作</span>}
                  {entry.kind === 'external' && <span className="tag">项目外提交</span>}
                  {entry.round !== undefined && (
                    <span className="tag" data-testid="history-round-badge">
                      {COPY.roundBadge(entry.round)}
                    </span>
                  )}
                </div>

                <div className="muted" style={{ marginTop: '3px' }}>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                  {entry.executorText && <span> · {entry.executorText}</span>}
                  {entry.checksLabel && (
                    <span data-testid="history-checks-label">
                      {' '}
                      · {entry.checksLabel}
                      {entry.uncheckedConfirmedAt
                        ? `（确认保存时间：${new Date(entry.uncheckedConfirmedAt).toLocaleString()}）`
                        : ''}
                    </span>
                  )}
                </div>

                {entry.showUndo && !entry.canUndo && entry.undoBlockedReason && (
                  <p className="muted" data-testid="history-undo-blocked" style={{ marginTop: '4px' }}>
                    {entry.undoBlockedReason}
                  </p>
                )}
              </div>

              <div className="row" style={{ gap: '8px', flexShrink: 0 }}>
                {entry.canViewTask && entry.taskId && (
                  <button
                    type="button"
                    className="secondary"
                    data-testid="history-view-task"
                    onClick={() => onOpenTask(entry.taskId!)}
                  >
                    {entry.viewTaskLabel ?? COPY.historyViewTask}
                  </button>
                )}
                {entry.showUndo && (
                  <button
                    type="button"
                    className="secondary"
                    data-testid="history-undo-button"
                    disabled={undoing || !entry.canUndo}
                    title={entry.undoBlockedReason}
                    onClick={() => {
                      if (entry.undoConfirm) setConfirmTarget(entry);
                    }}
                  >
                    {entry.undoButtonLabel ?? '撤销…'}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {confirmTarget?.undoConfirm && (
        <div className="confirm-panel" role="alertdialog" aria-modal="true" data-testid="history-undo-confirm">
          <h2>{confirmTarget.undoConfirm.title}</h2>
          <div className="stack" style={{ marginTop: '8px', gap: '6px' }}>
            <p data-testid="history-undo-target">{confirmTarget.undoConfirm.targetSaveText}</p>
            <p data-testid="history-undo-restore">{confirmTarget.undoConfirm.restoreStateText}</p>
            <p className="muted" data-testid="history-undo-commit-note">{confirmTarget.undoConfirm.commitNoteText}</p>
            <p className="muted" data-testid="history-undo-limitation">{confirmTarget.undoConfirm.limitationText}</p>
          </div>
          <div className="row" style={{ marginTop: '12px' }}>
            <button
              type="button"
              data-testid="history-confirm-undo-yes"
              disabled={undoing}
              onClick={() => executeUndo(confirmTarget.undoConfirm!.taskId)}
            >
              {confirmTarget.undoConfirm.confirmLabel}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="history-confirm-undo-no"
              disabled={undoing}
              onClick={() => setConfirmTarget(null)}
            >
              {confirmTarget.undoConfirm.cancelLabel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
