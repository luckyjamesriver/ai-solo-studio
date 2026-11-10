import { useState } from 'react';
import { studio, type StoppedInfo, type TaskView } from './api.js';
import { COPY } from './copy.js';

interface StoppedPageProps {
  projectId: string;
  task: TaskView;
  info: StoppedInfo;
  onGoAcceptance: () => void;
  onContinued: (t: TaskView) => void;
  onDiscarded: () => void;
}

/**
 * 停止 / 中断后页（#06-stopped）：在验收页之前先展示，给出固定三行（已经做完 / 没做完 / 你的项目）、
 * 原因说明，以及「去验收已有成果」（主按钮）、「继续执行」和「放弃这个任务」（次要按钮）。
 */
export function StoppedPage({ projectId, task, info, onGoAcceptance, onContinued, onDiscarded }: StoppedPageProps) {
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const nextTask = await studio().continueTask(projectId, task.id);
      onContinued(nextTask);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    setConfirmDiscard(false);
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
    <div className="stopped stack" data-testid="stopped-page" data-reason={info.reasonLabel}>
      <section className="box wbox" data-testid="stopped-summary">
        <div className="row sb">
          <div className="row">
            <span className={`tag${info.isAbnormal ? ' warn' : ''}`} data-testid="stopped-reason-tag">
              {info.reasonLabel}
            </span>
            <strong data-testid="stopped-reason-detail">{info.reasonDetail}</strong>
            {task.fullTrust && (
              <span className="badge-trust" data-testid="fulltrust-badge">
                {COPY.fullTrustBadge}
              </span>
            )}
          </div>
          <span className="muted" data-testid="executor-info">
            执行者：{task.executorText}
          </span>
        </div>

        <div className="kv" style={{ marginTop: '12px' }}>
          <span className="muted">{COPY.stoppedDoneLabel}</span>
          <span data-testid="stopped-done">{info.doneText}</span>
          <span className="muted">{COPY.stoppedUndoneLabel}</span>
          <span data-testid="stopped-undone">{info.undoneText}</span>
          <span className="muted">{COPY.stoppedProjectLabel}</span>
          <span data-testid="stopped-project">{info.projectText}</span>
        </div>

        {task.startFailure && (
          <p role="alert" className="error" data-testid="start-failure" style={{ marginTop: '8px' }}>
            {task.startFailure}
          </p>
        )}
        {error && (
          <p role="alert" className="error" data-testid="stopped-error" style={{ marginTop: '8px' }}>
            {error}
          </p>
        )}
      </section>

      <section className="box">
        <h2>{COPY.stoppedNextTitle}</h2>

        <div className="item">
          <div className="grow">
            <strong>{COPY.stoppedGoAccept}</strong>
            <div className="muted">{COPY.stoppedGoAcceptDesc}</div>
          </div>
          <button
            type="button"
            data-testid="go-acceptance-button"
            disabled={busy}
            onClick={onGoAcceptance}
          >
            {COPY.stoppedGoAccept}
          </button>
        </div>

        {info.canContinue && (
          <div className="item">
            <div className="grow">
              <strong>{COPY.stoppedContinue}</strong>
              <div className="muted">{COPY.stoppedContinueDesc}</div>
            </div>
            <button
              type="button"
              className="secondary"
              data-testid="continue-button"
              disabled={busy}
              onClick={handleContinue}
            >
              {COPY.stoppedContinue}
            </button>
          </div>
        )}

        <div className="item">
          <div className="grow">
            <strong>{COPY.stoppedDiscard}</strong>
            <div className="muted">{COPY.stoppedDiscardDesc}</div>
          </div>
          <button
            type="button"
            className="secondary"
            data-testid="stopped-discard-button"
            disabled={busy}
            onClick={() => setConfirmDiscard(true)}
          >
            {COPY.stoppedDiscard}
          </button>
        </div>

        {confirmDiscard && (
          <div className="confirm-panel" role="alertdialog" aria-modal="true" data-testid="confirm-panel" data-kind="discard">
            <p data-testid="confirm-text">{info.discardConfirmText}</p>
            <div className="row" style={{ marginTop: '8px' }}>
              <button
                type="button"
                className="secondary"
                data-testid="confirm-yes"
                disabled={busy}
                onClick={handleDiscard}
              >
                {COPY.discardYes}
              </button>
              <button type="button" data-testid="confirm-no" disabled={busy} onClick={() => setConfirmDiscard(false)}>
                {COPY.cancel}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
