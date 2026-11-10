import type { SaveOutcomeButton, SaveOutcomeView, SaveProgressStep, SaveStepStatus } from './api.js';

function stepBadge(status: SaveStepStatus): { cls: string; text: string } {
  switch (status) {
    case 'done':
      return { cls: 'tag ok', text: '完成' };
    case 'running':
      return { cls: 'tag', text: '进行中' };
    case 'failed':
      return { cls: 'tag warn', text: '未通过' };
    case 'skipped':
      return { cls: 'tag', text: '未执行' };
    default:
      return { cls: 'tag', text: '等待' };
  }
}

function StepRows({ saveSteps }: { saveSteps: SaveProgressStep[] }) {
  return (
    <div style={{ marginTop: '8px' }}>
      {saveSteps.map((s) => {
        const badge = stepBadge(s.status);
        return (
          <div className="item" key={s.key} data-testid={`save-step-${s.key}`} data-status={s.status}>
            <span className={badge.cls}>{badge.text}</span>
            <span className="grow">
              <strong>{s.label}</strong>
              {s.detail ? ` → ${s.detail}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 保存前检查四步进度与单结果视图（原型 #10-save-result，UI v2.1 第 7 节）。
 * 所有步骤文案、结果说明、按钮文字与出现条件全部由核心层 SaveOutcomeView / SaveProgressStep 下发。
 */
export function SaveResultPanel({
  liveSteps,
  outcome,
  busy,
  copied,
  hideButtons,
  onAction,
}: {
  liveSteps: SaveProgressStep[] | null;
  outcome: SaveOutcomeView | null;
  busy: boolean;
  copied?: boolean;
  hideButtons?: boolean;
  onAction: (button: SaveOutcomeButton) => void;
}) {
  if (liveSteps && !outcome) {
    return (
      <section className="box hl" data-testid="save-result-panel" data-phase="running">
        <h2>正在保存…</h2>
        <StepRows saveSteps={liveSteps} />
      </section>
    );
  }

  if (!outcome) return null;

  const boxClass = outcome.kind === 'saved' ? 'box hl' : outcome.warn ? 'box wbox' : 'box hl';
  const tagClass = outcome.kind === 'saved' ? 'tag ok' : outcome.warn ? 'tag warn' : 'tag';

  return (
    <section
      className={boxClass}
      data-testid="save-result-panel"
      data-outcome={outcome.kind}
      data-reason={outcome.reason}
    >
      <div className="row sb">
        <h2>
          {outcome.kind === 'saved'
            ? '保存结果'
            : outcome.kind === 'manual_review'
              ? '保存未确认 · 已暂停操作'
              : outcome.saveSteps.length === 0
                ? '撤销状态'
                : '保存前检查'}
        </h2>
        <span className={tagClass} data-testid="save-outcome-tag">
          {outcome.tag}
        </span>
      </div>

      {outcome.saveSteps.length > 0 && <StepRows saveSteps={outcome.saveSteps} />}

      {outcome.kind === 'unchecked_needs_confirm' ? (
        <div
          className="confirm-panel"
          role="alertdialog"
          aria-modal="false"
          data-testid="unchecked-confirm-panel"
          style={{ marginTop: '10px' }}
        >
          <p data-testid="unchecked-confirm-reason">{outcome.headline}</p>
          {!hideButtons && outcome.buttons.length > 0 && (
            <div className="row" style={{ marginTop: '8px', flexWrap: 'wrap', gap: '8px' }}>
              {outcome.buttons.map((b, idx) => (
                <button
                  key={`${b.action}-${idx}`}
                  type="button"
                  className={b.primary ? '' : 'secondary'}
                  data-testid={
                    b.action === 'open_preview'
                      ? 'unchecked-preview-button'
                      : b.action === 'save_unchecked'
                        ? 'unchecked-confirm-save-button'
                        : `save-outcome-btn-${b.action}`
                  }
                  disabled={busy}
                  onClick={() => onAction(b)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          data-testid="save-outcome-body"
          style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--color-border)' }}
        >
          <p data-testid="save-outcome-headline" style={{ fontWeight: 600 }}>
            {outcome.headline}
          </p>
          {outcome.extraNote && (
            <p className="muted" data-testid="save-outcome-extra" style={{ marginTop: '4px' }}>
              {outcome.extraNote}
            </p>
          )}
          {outcome.files && outcome.files.length > 0 && (
            <ul data-testid="save-outcome-files" style={{ marginTop: '6px' }}>
              {outcome.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {outcome.failedChecks && outcome.failedChecks.length > 0 && (
            <ul data-testid="save-outcome-failed-checks" style={{ marginTop: '6px' }}>
              {outcome.failedChecks.map((fc) => (
                <li key={fc.key}>
                  <strong>{fc.label}</strong>：{fc.summary}
                </li>
              ))}
            </ul>
          )}
          {!hideButtons && outcome.buttons.length > 0 && (
            <div className="row" data-testid="save-outcome-buttons" style={{ marginTop: '10px', flexWrap: 'wrap', gap: '8px' }}>
              {outcome.buttons.map((b, idx) => (
                <button
                  key={`${b.action}-${idx}`}
                  type="button"
                  className={b.primary ? '' : 'secondary'}
                  data-testid={`save-outcome-btn-${b.action}${b.proofTab ? `-${b.proofTab}` : ''}`}
                  disabled={busy}
                  onClick={() => onAction(b)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
          {copied && outcome.kind === 'manual_review' && (
            <p className="muted" role="status" data-testid="copy-done" style={{ marginTop: '6px' }}>
              已复制。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
