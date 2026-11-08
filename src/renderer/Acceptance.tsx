import { useCallback, useEffect, useRef, useState } from 'react';
import { studio, type AcceptanceActionResult, type ChangePreview, type TaskView, type UserAcceptanceView, type ViewItem } from './api.js';
import { COPY } from './copy.js';

const MARK: Record<ViewItem['status'], string> = { verified: '✓', failed: '✗', not_checked: '？', pending_user: '…' };
const KIND_TEXT: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名', other: '变化' };

/** 写进剪贴板：优先用系统接口，失败时退回临时文本框 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function Preview({ p }: { p: ChangePreview }) {
  if (p.kind === 'deleted' || p.kind === 'unavailable') return <p className="muted" data-testid="preview-note">{p.note}</p>;
  if (p.kind === 'new') {
    return (
      <div data-testid="preview-new">
        <p className="muted">{p.note}</p>
        <pre className="snippet">{p.lines.join('\n')}{p.truncated ? '\n…' : ''}</pre>
      </div>
    );
  }
  return (
    <div data-testid="preview-text">
      {p.hunks.map((h, i) => (
        <div className="hunk" key={`${h.line}-${i}`} data-testid="hunk">
          <p className="muted">{COPY.hunkAt(h.line)}</p>
          <div className="cols">
            <div className="col" data-testid="hunk-before"><h5>{COPY.before}</h5><pre className="snippet">{h.before.join('\n') || ' '}</pre></div>
            <div className="col" data-testid="hunk-after"><h5>{COPY.after}</h5><pre className="snippet">{h.after.join('\n') || ' '}</pre></div>
          </div>
          {h.truncated && <p className="muted">{COPY.hunkTruncated}</p>}
        </div>
      ))}
      {p.note && <p className="muted" data-testid="preview-omitted">{p.note}</p>}
    </div>
  );
}

type Dialog = 'discard' | 'undo' | null;

/**
 * 验收与结果：只使用主进程给的用户验收视图（UserAcceptanceView）。
 * 所有文案（结论、各项说明、失败原因、按钮不可用的原因）都来自视图，这里不自拟任何失败文案。
 */
export function Acceptance({ task, onChanged }: { task: TaskView; onChanged: () => void }) {
  const [view, setView] = useState<UserAcceptanceView | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; files?: string[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deferred, setDeferred] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 同步的“操作中”标记：按钮点击后立刻生效，界面层先挡住重复点击（核心层还有互斥作为第二道） */
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    studio().getAcceptanceView(task.id).then((v) => { setView(v); setLoadError(null); }).catch((e: Error) => setLoadError(e.message));
  }, [task.id]);
  useEffect(load, [load, task.state]);
  // 取到视图时任务可能还在收尾（主进程标记 busy）：稍后重新取一次，避免界面停在“全部置灰”
  const viewBusy = view?.busy ?? false;
  useEffect(() => {
    if (!viewBusy || pending) return;
    const timer = setTimeout(load, 500);
    return () => clearTimeout(timer);
  }, [viewBusy, pending, load, view]);

  const run = async (call: (s: ReturnType<typeof studio>) => Promise<AcceptanceActionResult>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setDialog(null);
    try {
      const r = await call(studio());
      setView(r.view);
      setMessage(r.message || r.files?.length ? { ok: r.ok, text: r.message, ...(r.files?.length ? { files: r.files } : {}) } : null);
      onChanged();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (loadError && !view) return <p role="alert" className="error" data-testid="task-error">{loadError}</p>;
  if (!view) return <p className="muted">{COPY.noProgress}</p>;

  const v = view;
  const a = v.actions;
  const reviewing = v.state === 'reviewing';
  const conflict = v.state === 'save_failed_unmerged';
  const disabled = (enabled: boolean) => !enabled || pending;

  return (
    <div className="result acceptance" data-testid="result" data-state={v.state} data-fulltrust={task.fullTrust}>
      <div className="head">
        <strong>{v.goal}</strong>
        {task.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge">{COPY.fullTrustBadge}</span>}
        <span className="muted">{v.stateText}</span>
        {v.reconciled && <span className="badge-checked" data-testid="reconciled-badge">{COPY.reconciledBadge}</span>}
      </div>
      {v.reconciled && <p className="muted" data-testid="reconciled-note">{v.reconciled}</p>}
      {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      <p className="headline" data-testid="verdict">{v.verdict}</p>
      {message && (
        <div role="status" className={message.ok ? 'notice' : 'notice error'} data-testid="action-message">
          {message.text}
          {message.files && <ul data-testid="action-files">{message.files.map((f) => <li key={f}>{f}</li>)}</ul>}
        </div>
      )}
      {v.unexpectedRequests > 0 && <p role="alert" className="error" data-testid="unexpected">{COPY.unexpected}</p>}

      {v.readOnly ? (
        <div className="readonly" data-testid="readonly-panel">
          <p>{COPY.readOnlyHint}</p>
          <div className="row">
            <button className="secondary" data-testid="reveal-project" onClick={() => void studio().revealProject()}>{COPY.revealProject}</button>
            <button className="secondary" data-testid="copy-summary" onClick={async () => setCopied(await copyText(v.diagnosticSummary))}>{COPY.copySummary}</button>
          </div>
          {copied && <p className="muted" role="status" data-testid="copy-done">{COPY.copied}</p>}
          <pre className="snippet" data-testid="summary-text">{v.diagnosticSummary}</pre>
        </div>
      ) : (
        <>
          {v.items.length > 0 && (
            <section className="facts" data-testid="facts">
              <h3>{COPY.factsTitle}</h3>
              <ul>
                {v.items.map((i) => (
                  <li key={i.key} data-status={i.status === 'verified' ? 'ok' : i.status === 'failed' ? 'bad' : 'unchecked'} data-item={i.key}>
                    <span className="mark">{MARK[i.status]}</span> <strong>{i.label}</strong>：{i.text}
                  </li>
                ))}
              </ul>
              {v.notes.length > 0 && <ul className="notes" data-testid="notes">{v.notes.map((n) => <li key={n} className="notice">{n}</li>)}</ul>}
            </section>
          )}

          {reviewing && v.denied.length > 0 && (
            <section data-testid="denied">
              <h3>{COPY.deniedTitle}</h3>
              <ul>
                {v.denied.map((d) => (
                  <li key={d.id} data-acked={d.acked}>
                    {d.text}
                    {d.acked ? <span className="muted"> · {COPY.acked}</span> : <button className="secondary" data-testid={`ack-${d.id}`} disabled={pending} onClick={() => run((s) => s.ackDenied(v.taskId, d.id, v.version))}>{COPY.ackButton}</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {reviewing && (v.criteria.length > 0 || v.overall.needed) && (
            <section data-testid="criteria">
              <h3>{COPY.criteriaTitle}</h3>
              <ul>
                {v.criteria.map((c) => (
                  <li key={c.id} data-confirmed={c.confirmed}>
                    {c.text}
                    {c.confirmed ? <span className="muted"> · {COPY.confirmed}</span> : <button className="secondary" data-testid={`confirm-${c.id}`} disabled={pending} onClick={() => run((s) => s.confirmCriterion(v.taskId, c.id, v.version))}>{COPY.confirmButton}</button>}
                  </li>
                ))}
                {v.overall.needed && (
                  <li data-confirmed={v.overall.confirmed}>
                    {v.overall.text}
                    {v.overall.confirmed ? <span className="muted"> · {COPY.confirmed}</span> : <button className="secondary" data-testid="confirm-overall" disabled={pending} onClick={() => run((s) => s.confirmOverall(v.taskId, v.version))}>{COPY.overallButton}</button>}
                  </li>
                )}
              </ul>
            </section>
          )}

          {v.changes.length > 0 && (
            <section data-testid="changes">
              <h3>{COPY.changesTitle}</h3>
              <ul className="changes">
                {v.changes.map((c) => (
                  <li key={c.path} data-kind={c.kind}>
                    <strong>{KIND_TEXT[c.kind] ?? '变化'}</strong>　{c.path}
                    {c.additions !== null && c.deletions !== null && <span className="muted"> （+{c.additions} −{c.deletions}）</span>}
                    {c.preview && <Preview p={c.preview} />}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="incomplete" data-testid="incomplete">
            <h3>{COPY.incompleteTitle}</h3>
            <p className="notice">{COPY.incompleteNotice}</p>
            {v.aiReport.kind === 'items' && <ul>{v.aiReport.items.map((i) => <li key={i}>{i}</li>)}</ul>}
            {v.aiReport.kind === 'raw' && (<><p>{COPY.incompleteRaw}</p><blockquote>{v.aiReport.text}</blockquote></>)}
            {v.aiReport.kind === 'none' && <p className="muted">{COPY.incompleteNone}</p>}
          </section>

          {task.permissions && (
            <details>
              <summary>这次任务实际生效的权限：{task.permissions.modeName}</summary>
              <ul>{task.permissions.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </details>
          )}

          {conflict && deferred && <p className="muted" data-testid="deferred-note">{COPY.deferredNote}</p>}
          {reviewing && v.confirmTexts.save && <p className="notice" data-testid="save-note">{v.confirmTexts.save}</p>}

          <div className="row" data-testid="actions">
            {reviewing && <button data-testid="save-button" disabled={disabled(a.save.enabled)} onClick={() => run((s) => s.saveTask(v.taskId, v.version))}>{COPY.saveButton}</button>}
            {reviewing && <button className={a.recheck.highlight ? '' : 'secondary'} data-testid="recheck-button" data-highlight={!!a.recheck.highlight} disabled={disabled(a.recheck.enabled)} onClick={() => run((s) => s.recheck(v.taskId))}>{COPY.recheckButton}</button>}
            {(reviewing || conflict) && <button className="secondary" data-testid="discard-button" disabled={disabled(a.discard.enabled)} onClick={() => setDialog('discard')}>{COPY.discardButton}</button>}
            {conflict && <button className="secondary" data-testid="defer-button" onClick={() => setDeferred(true)}>{COPY.deferButton}</button>}
            {['saved', 'saved_cleanup_pending', 'undo_failed'].includes(v.state) && <button className="secondary" data-testid="undo-button" disabled={disabled(a.undo.enabled)} onClick={() => setDialog('undo')}>{COPY.undoButton}</button>}
            {(v.state === 'saved_cleanup_pending' || v.state === 'discard_cleanup_pending') && <button data-testid="retry-cleanup-button" disabled={disabled(a.retryCleanup.enabled)} onClick={() => run((s) => s.retryCleanup(v.taskId))}>{COPY.retryCleanupButton}</button>}
          </div>
          {/* 按钮不可用时一律说明原因（原因文案来自视图） */}
          {reviewing && !a.save.enabled && a.save.reason && <p className="muted" data-testid="save-reason">{a.save.reason}</p>}
          {reviewing && !a.save.enabled && a.save.files && <ul className="muted" data-testid="save-files">{a.save.files.map((f) => <li key={f}>{f}</li>)}</ul>}
          {['saved', 'saved_cleanup_pending', 'undo_failed'].includes(v.state) && !a.undo.enabled && a.undo.reason && <p className="muted" data-testid="undo-reason">{a.undo.reason}</p>}

          {dialog && (
            <div className="confirm-panel" role="alertdialog" aria-modal="true" data-testid="confirm-panel" data-kind={dialog}>
              <p data-testid="confirm-text">{dialog === 'discard' ? v.confirmTexts.discard : v.confirmTexts.undo}</p>
              <div className="row">
                <button data-testid="confirm-yes" onClick={() => run((s) => (dialog === 'discard' ? s.discardTask(v.taskId) : s.undoSave(v.taskId)))}>{dialog === 'discard' ? COPY.discardYes : COPY.undoYes}</button>
                <button className="secondary" data-testid="confirm-no" onClick={() => setDialog(null)}>{COPY.cancel}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
