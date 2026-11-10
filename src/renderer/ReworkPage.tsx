import { useState } from 'react';
import { studio, type UserAcceptanceView } from './api.js';
import { COPY } from './copy.js';

interface ReworkPageProps {
  projectId: string;
  view: UserAcceptanceView;
  onCancel: () => void;
  onSubmitted: () => void;
}

/**
 * 退回修改页（#09-rework）：
 * 填写修改意见并自动附上本轮标为「不符合」的标准与说明；权限默认沿用上一轮，点「修改」可回到计划页调整；
 * 提交后沿用同一任务副本发起第 N+1 轮执行，历史轮次成果与记录保持独立。
 */
export function ReworkPage({ projectId, view, onCancel, onSubmitted }: ReworkPageProps) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rejectedCriteria = view.criteria
    .filter((c) => c.rejected)
    .map((c) => ({ id: c.id, text: c.text, ...(c.note ? { note: c.note } : {}) }));
  const overallRejected = view.criteria.length === 0 && view.overall.needed && view.overall.rejected;
  const hasAnyRejected = rejectedCriteria.length > 0 || overallRejected;

  const submitRework = async (mode: 'codex' | 'external' = 'codex') => {
    if (submitting) return;
    if (!feedback.trim() && !hasAnyRejected) {
      setError(COPY.reworkValidationMissing);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'external') {
        await studio().reworkExternalTask(projectId, view.taskId, feedback);
      } else {
        await studio().reworkTask(projectId, view.taskId, feedback);
      }
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  const editPermissions = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await studio().editReworkPermissions(projectId, view.taskId, feedback);
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="stack" data-testid="rework-page" style={{ maxWidth: '740px' }}>
      <div className="row sb">
        <h2>{COPY.reworkTitle} — {view.goal}</h2>
        <span className="tag">{view.stateText}</span>
      </div>

      {error && <p role="alert" className="error" data-testid="rework-error">{error}</p>}

      <section className="box hl">
        <p className="muted">{COPY.reworkLead}</p>

        <label style={{ display: 'block', marginTop: '12px' }}>
          <span>{COPY.reworkFeedbackLabel}</span>
          <textarea
            data-testid="rework-feedback"
            rows={4}
            value={feedback}
            placeholder={COPY.reworkFeedbackPlaceholder}
            disabled={submitting}
            onChange={(e) => setFeedback(e.target.value)}
            style={{ width: '100%', marginTop: '6px' }}
          />
        </label>

        {hasAnyRejected && (
          <div className="wbox" data-testid="rework-rejected-list" style={{ marginTop: '12px', padding: '10px 12px' }}>
            <strong>{COPY.reworkRejectedHeading}</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
              {rejectedCriteria.map((c) => (
                <li key={c.id}>
                  <span>{c.text}</span>
                  {c.note && <span className="muted">（说明：{c.note}）</span>}
                </li>
              ))}
              {overallRejected && (
                <li>
                  <span>{view.overall.text}</span>
                  {view.overall.note && <span className="muted">（说明：{view.overall.note}）</span>}
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="stack" style={{ marginTop: '12px', gap: '4px' }}>
          <p className="muted" data-testid="rework-executor">
            {COPY.reworkExecutorLabel}{view.rework.executorText}
          </p>
          <p className="muted" data-testid="rework-permissions">
            {COPY.reworkPermLabel}{view.rework.permissionSummary}
            {' '}
            <button
              type="button"
              className="link"
              data-testid="rework-edit-permissions"
              disabled={submitting}
              onClick={editPermissions}
            >
              {COPY.reworkEditPerm}
            </button>
          </p>
        </div>

        <div className="row" style={{ marginTop: '14px', flexWrap: 'wrap', gap: '10px' }}>
          {view.rework.isExternalExecution ? (
            <>
              <button
                type="button"
                data-testid="rework-external-button"
                disabled={submitting}
                onClick={() => void submitRework('external')}
              >
                {COPY.externalReworkAgainButton}
              </button>
              <button
                type="button"
                className="secondary"
                data-testid="rework-codex-button"
                disabled={submitting}
                onClick={() => void submitRework('codex')}
              >
                {COPY.externalReworkCodexButton}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="rework-start-button"
              disabled={submitting}
              onClick={() => void submitRework('codex')}
            >
              {COPY.reworkStartButton(view.rework.nextRound)}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            data-testid="rework-cancel-button"
            disabled={submitting}
            onClick={onCancel}
          >
            {COPY.cancel}
          </button>
        </div>
      </section>

      <section className="box">
        <h2>{COPY.reworkAfterTitle}</h2>
        <p className="muted">{COPY.reworkAfterDesc(view.rework.nextRound)}</p>
      </section>
    </div>
  );
}
