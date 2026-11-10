import { useState } from 'react';
import { studio, type TaskView } from './api.js';
import { COPY } from './copy.js';

interface ExternalWaitingPageProps {
  projectId: string;
  task: TaskView;
  onTaskChanged: (t: TaskView) => void;
  onDiscarded: () => void;
}

/**
 * 外部执行等待页（UI v2.1 第 5 节）：
 * - 展示独立任务副本文件夹完整路径、.studio/handoff/<taskId>/task.md 位置、导出时间；
 * - 提供「导入报告」（主按钮，系统框仅接受 .md/.txt）、「在访达中显示」「复制任务说明」「取消外部执行」；
 * - 若最近一次导入核对为 mismatch / unverified，以只读卡片如实列出矛盾或缺失项，禁止进入验收或保存，允许重新导入。
 */
export function ExternalWaitingPage({ projectId, task, onTaskChanged, onDiscarded }: ExternalWaitingPageProps) {
  const [busy, setBusy] = useState(false);
  const [copiedTask, setCopiedTask] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handoff = task.handoff;
  const lastImport = handoff?.lastImport;
  const hasBlockedImport = !!lastImport && lastImport.verdict !== 'bound';

  const copyInstructions = async () => {
    if (!handoff?.taskContent) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(handoff.taskContent);
      setCopiedTask(true);
      setTimeout(() => setCopiedTask(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reveal = async (target: 'task_file' | 'worktree') => {
    setError(null);
    try {
      await studio().revealHandoff(projectId, task.id, target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleImport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await studio().importExternalReport(projectId, task.id);
      if (!res.cancelled) {
        onTaskChanged(res.task);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelExternal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirmCancel(false);
    try {
      const res = await studio().discardTask(projectId, task.id);
      if (!res.ok) setError(res.message);
      else onDiscarded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" data-testid="external-waiting-page">
      <section className="box">
        <div className="row sb">
          <div className="row" style={{ gap: '8px' }}>
            <span className="tag" data-testid="external-waiting-tag">{COPY.externalWaitingTag}</span>
            <strong>{task.stateText}</strong>
            {task.planUnreviewed && (
              <span className="tag warn" data-testid="plan-unreviewed-badge">
                {COPY.planUnreviewedBadge}
              </span>
            )}
          </div>
          <span className="muted" data-testid="executor-info">
            执行者：{task.executorText}
          </span>
        </div>
        <p className="muted" style={{ marginTop: '8px' }}>{COPY.externalWaitingSubtitle}</p>
        {error && (
          <p role="alert" className="error" data-testid="external-error" style={{ marginTop: '8px' }}>
            {error}
          </p>
        )}
      </section>

      {hasBlockedImport && lastImport && (
        <section
          className="box wbox stack"
          data-testid={lastImport.verdict === 'mismatch' ? 'handoff-import-mismatch' : 'handoff-import-unverified'}
          data-verdict={lastImport.verdict}
        >
          <div className="row sb">
            <div className="row" style={{ gap: '8px' }}>
              <span className="tag warn" data-testid="handoff-import-verdict-tag">
                {lastImport.verdict === 'mismatch' ? COPY.externalMismatchTag : COPY.externalUnverifiedTag}
              </span>
              <strong>报告：{lastImport.reportName}</strong>
            </div>
            <span className="muted">核对于 {lastImport.atText}</span>
          </div>
          <p className="muted" data-testid="handoff-readonly-notice">
            {lastImport.readOnlyNotice ?? COPY.externalReadOnlyNote}
          </p>
          {lastImport.mismatches.length > 0 && (
            <div data-testid="handoff-mismatch-list">
              <strong>矛盾项（逐条列出）：</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {lastImport.mismatches.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {lastImport.unverifiedReasons.length > 0 && (
            <div data-testid="handoff-unverified-list">
              <strong>缺少绑定信息或无法核实：</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {lastImport.unverifiedReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {handoff && (
        <section className="box stack">
          <div className="kv">
            <span className="muted">{COPY.externalWorktreeLabel}</span>
            <div className="row sb" style={{ gap: '8px', flexWrap: 'wrap' }}>
              <code data-testid="handoff-worktree-path">{handoff.worktreePath}</code>
              <button
                type="button"
                className="link"
                data-testid="handoff-reveal-worktree-button"
                onClick={() => void reveal('worktree')}
              >
                {COPY.externalRevealWorktreeButton}
              </button>
            </div>
            <span className="muted">{COPY.externalTaskFileLabel}</span>
            <code data-testid="handoff-taskfile-path">{handoff.taskFileRelPath}</code>
            <span className="muted">{COPY.externalExportedAtLabel}</span>
            <span data-testid="handoff-exported-at">{handoff.exportedAtText}</span>
          </div>

          <div className="row" style={{ gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
            <button
              type="button"
              data-testid="handoff-import-button"
              disabled={busy}
              onClick={() => void handleImport()}
            >
              {hasBlockedImport ? COPY.externalReimportButton : COPY.externalImportButton}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="handoff-reveal-button"
              disabled={busy}
              onClick={() => void reveal('task_file')}
            >
              {COPY.externalRevealButton}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="handoff-copy-button"
              disabled={!handoff.taskContent || busy}
              onClick={() => void copyInstructions()}
            >
              {copiedTask ? COPY.copied : COPY.externalCopyButton}
            </button>
            {!confirmCancel ? (
              <button
                type="button"
                className="secondary"
                data-testid="handoff-cancel-button"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                {COPY.externalCancelButton}
              </button>
            ) : (
              <span className="row" data-testid="handoff-cancel-confirm" style={{ gap: '8px' }}>
                <span className="muted">{COPY.externalCancelConfirm}</span>
                <button type="button" className="secondary" data-testid="handoff-cancel-yes" disabled={busy} onClick={() => void cancelExternal()}>
                  {COPY.discardYes}
                </button>
                <button type="button" className="link" disabled={busy} onClick={() => setConfirmCancel(false)}>
                  {COPY.cancel}
                </button>
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
