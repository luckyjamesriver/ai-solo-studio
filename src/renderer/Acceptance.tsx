import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckProofPage } from './CheckProofPage.js';
import { DiffPreview } from './DiffPreview.js';
import { ReworkPage } from './ReworkPage.js';
import { studio, type AcceptanceActionResult, type ProofTab, type RoundSnapshotView, type TaskView, type UserAcceptanceView } from './api.js';
import { COPY } from './copy.js';

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

function factTag(status: 'verified' | 'not_checked' | 'failed' | 'pending_user'): { cls: string; text: string } {
  switch (status) {
    case 'verified':
      return { cls: 'tag ok', text: '通过' };
    case 'failed':
      return { cls: 'tag warn', text: '未通过' };
    case 'pending_user':
      return { cls: 'tag warn', text: '待确认' };
    default:
      return { cls: 'tag', text: '未检查' };
  }
}

type Dialog = 'discard' | 'undo' | null;

function FactRows({
  items,
  deniedCount,
  includePreview,
  showNoChecksRow,
  onOpenProof,
}: {
  items: UserAcceptanceView['items'];
  deniedCount: number;
  includePreview: boolean;
  showNoChecksRow: boolean;
  onOpenProof: (tab: ProofTab) => void;
}) {
  const visible = includePreview ? items : items.filter((i) => i.key !== 'preview');
  const hasAutoCheck = visible.some((i) => i.key === 'build' || i.key === 'test');
  return (
    <div>
      {visible.map((i) => {
        const t = i.key === 'changes'
          ? { cls: 'tag', text: '改动' }
          : i.key === 'denied' && deniedCount > 0
            ? { cls: 'tag warn', text: `被拦下 ${deniedCount} 次` }
            : factTag(i.status);
        const targetTab: ProofTab | null =
          i.key === 'build' ? 'build'
            : i.key === 'test' || i.key === 'checks_modified' ? 'test'
              : i.key === 'denied' ? 'denied'
                : i.key === 'changes' ? 'changes'
                  : null;
        const linkLabel =
          targetTab === 'denied' ? COPY.acceptViewImpact
            : targetTab === 'changes' ? COPY.acceptViewChanges
              : COPY.acceptViewBasis;
        return (
          <div
            className="item"
            key={i.key}
            data-status={i.status === 'verified' ? 'ok' : i.status === 'failed' ? 'bad' : 'unchecked'}
            data-item={i.key}
          >
            <span className={t.cls}>{t.text}</span>
            <span className="grow">
              <strong>{i.label}</strong>：{i.text}
            </span>
            {targetTab && (
              <button
                type="button"
                className="link"
                data-testid={`proof-link-${i.key}`}
                onClick={() => onOpenProof(targetTab)}
              >
                {linkLabel}
              </button>
            )}
          </div>
        );
      })}
      {showNoChecksRow && !hasAutoCheck && (
        <div className="item" data-item="no-checks" data-status="unchecked">
          <span className="tag">未检查</span>
          <span className="grow">{COPY.acceptNoChecksRow}</span>
          <button
            type="button"
            className="link"
            data-testid="proof-link-no-checks"
            onClick={() => onOpenProof('test')}
          >
            {COPY.acceptViewBasis}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 验收页（#07-accept）：左主区按「成果预览 → 检查与证据（及接受的风险） → AI 自己的说法」，
 * 右侧按「验收状态 → 验收标准（符合 / 不符合 + 说明） → 被拦下的操作 → 操作按钮」展示。
 * 多轮任务支持切换查看第 1..N 轮独立成果与检查记录，历史轮次为只读对照。
 */
export function Acceptance({
  projectId,
  task,
  onChanged,
  onBackToProject,
}: {
  projectId: string;
  task: TaskView;
  onChanged: () => void;
  onBackToProject?: () => void;
}) {
  const [view, setView] = useState<UserAcceptanceView | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; files?: string[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deferred, setDeferred] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [proofTab, setProofTab] = useState<ProofTab | null>(null);
  const [showRework, setShowRework] = useState(false);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const prevCurrentRound = useRef<number | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    studio()
      .getAcceptanceView(projectId, task.id)
      .then((v) => {
        setView(v);
        setLoadError(null);
        const notes: Record<string, string> = {};
        for (const c of v.criteria) if (c.note !== undefined) notes[c.id] = c.note;
        if (v.overall.note !== undefined) notes.overall = v.overall.note;
        setDraftNotes(notes);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [projectId, task.id]);
  useEffect(load, [load, task.state, task.round]);

  useEffect(() => {
    if (!view) return;
    if (prevCurrentRound.current !== view.currentRound || !view.rounds.some((r) => r.round === selectedRound)) {
      prevCurrentRound.current = view.currentRound;
      setSelectedRound(view.currentRound);
    }
  }, [view, selectedRound]);

  const viewBusy = view?.busy ?? false;
  useEffect(() => {
    if (!viewBusy || pending) return;
    const timer = setTimeout(load, 500);
    return () => clearTimeout(timer);
  }, [viewBusy, pending, load, view]);

  const run = async (call: (s: ReturnType<typeof studio>) => Promise<AcceptanceActionResult>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setPending(true);
    setDialog(null);
    try {
      const r = await call(studio());
      setView(r.view);
      const notes: Record<string, string> = {};
      for (const c of r.view.criteria) if (c.note !== undefined) notes[c.id] = c.note;
      if (r.view.overall.note !== undefined) notes.overall = r.view.overall.note;
      setDraftNotes(notes);
      setMessage(
        (r.message && r.message !== r.view.uncheckedConfirm?.reason) || r.files?.length
          ? { ok: r.ok, text: r.message, ...(r.files?.length ? { files: r.files } : {}) }
          : null,
      );
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
  const activeRound: RoundSnapshotView | undefined =
    v.rounds.find((r) => r.round === (selectedRound ?? v.currentRound)) ?? v.rounds[v.rounds.length - 1];
  const viewingHistorical = !!activeRound && !activeRound.isCurrent;
  const displayItems = activeRound?.items ?? v.items;
  const displayChanges = activeRound?.changes ?? v.changes;
  const displayCriteria = activeRound?.criteria ?? v.criteria;
  const displayOverall = activeRound?.overall ?? v.overall;
  const displayDenied = activeRound?.denied ?? v.denied;
  const displayStatus = activeRound?.acceptanceStatus ?? v.acceptanceStatus;
  const displayAiReport = activeRound?.aiReport ?? v.aiReport;
  const displayProof = activeRound?.proof ?? v.proof;

  if (proofTab) {
    return <CheckProofPage proof={displayProof} initialTab={proofTab} onBack={() => setProofTab(null)} />;
  }

  const a = v.actions;
  const reviewing = v.state === 'reviewing';
  if (showRework && reviewing && !v.readOnly) {
    return (
      <ReworkPage
        projectId={projectId}
        view={v}
        onCancel={() => setShowRework(false)}
        onSubmitted={() => {
          setShowRework(false);
          onChanged();
        }}
      />
    );
  }

  const conflict = v.state === 'save_failed_unmerged';
  const disabled = (enabled: boolean) => !enabled || pending;
  const statusKind = displayStatus.kind;

  return (
    <div className="result acceptance stack" data-testid="result" data-state={v.state} data-fulltrust={task.fullTrust}>
      <div className="row sb">
        <div className="row" style={{ gap: '8px' }}>
          {task.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge">{COPY.fullTrustBadge}</span>}
          <span className="tag" data-testid="round-badge">{COPY.roundBadge(activeRound?.round ?? v.currentRound)}</span>
          <span className="muted" data-testid="executor-info">执行者：{task.executorText}</span>
          <span className="muted">{v.stateText}</span>
          {v.saveRecord && <span className="badge-checked" data-testid="save-record-check">{v.saveRecord.checksText}</span>}
          {v.reconciled && <span className="badge-checked" data-testid="reconciled-badge">{COPY.reconciledBadge}</span>}
        </div>
        {v.rounds.length > 1 && (
          <div className="round-pills" data-testid="round-switcher" role="tablist" aria-label="轮次切换">
            {v.rounds.map((r) => {
              const isSelected = (activeRound?.round ?? v.currentRound) === r.round;
              return (
                <button
                  key={r.round}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className="secondary choice-btn round-pill"
                  data-testid={`round-tab-${r.round}`}
                  data-active={isSelected}
                  onClick={() => setSelectedRound(r.round)}
                >
                  {COPY.roundBadge(r.round)}{r.isCurrent ? COPY.roundCurrentSuffix : ''}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {activeRound?.feedback && (
        <p className="muted" data-testid="round-feedback">
          {COPY.roundFeedbackPrefix}{activeRound.feedback}
        </p>
      )}
      {viewingHistorical && activeRound && (
        <div className="notice" data-testid="historical-round-notice">
          {COPY.roundReadonlyNotice(activeRound.round)}
        </div>
      )}

      {v.reconciled && <p className="muted" data-testid="reconciled-note">{v.reconciled}</p>}
      {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {pending && (
        <div role="status" className="notice" data-testid="pending-feedback">
          正在处理中，请稍候...
        </div>
      )}
      {message && (
        <div role="status" className={message.ok ? 'notice' : 'notice error'} data-testid="action-message">
          {message.text}
          {message.files && <ul data-testid="action-files">{message.files.map((f) => <li key={f}>{f}</li>)}</ul>}
        </div>
      )}
      {v.unexpectedRequests > 0 && <p role="alert" className="error" data-testid="unexpected">{COPY.unexpected}</p>}

      {v.readOnly ? (
        <div className="readonly" data-testid="readonly-panel">
          <p data-testid="verdict">{v.verdict}</p>
          <p>{COPY.readOnlyHint}</p>
          <div className="row">
            <button className="secondary" data-testid="reveal-project" onClick={() => void studio().revealProject()}>{COPY.revealProject}</button>
            <button className="secondary" data-testid="copy-summary" onClick={async () => setCopied(await copyText(v.diagnosticSummary))}>{COPY.copySummary}</button>
          </div>
          {copied && <p className="muted" role="status" data-testid="copy-done">{COPY.copied}</p>}
          <pre className="snippet" data-testid="summary-text">{v.diagnosticSummary}</pre>
        </div>
      ) : reviewing ? (
        <div className="g2">
          {/* 左侧主区：成果预览 → 检查与证据 → AI 自己的说法 */}
          <div className="stack">
            <section className="box" data-testid="preview-section">
              <div className="row sb">
                <h2>{COPY.acceptPreviewTitle}</h2>
                <div className="row">
                  {!viewingHistorical && v.preview.completed && (
                    <span className="badge-checked" data-testid="preview-done">
                      {v.preview.skipped ? '已跳过查看' : COPY.acceptPreviewOpened}
                    </span>
                  )}
                  {!viewingHistorical && v.preview.kind && (
                    <button
                      type="button"
                      className="secondary"
                      data-testid="preview-button"
                      disabled={pending}
                      onClick={() => run((s) => s.openPreview(projectId, v.taskId, v.version))}
                    >
                      {v.preview.buttonText}
                    </button>
                  )}
                </div>
              </div>
              {displayChanges.length > 0 ? (
                <div data-testid="changes" style={{ marginTop: '8px' }}>
                  <ul className="changes">
                    {displayChanges.map((c) => (
                      <li key={c.path} data-kind={c.kind}>
                        <strong>{KIND_TEXT[c.kind] ?? '变化'}</strong>　{c.path}
                        {c.additions !== null && c.deletions !== null && <span className="muted"> （+{c.additions} −{c.deletions}）</span>}
                        {c.preview && <DiffPreview p={c.preview} />}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="muted" style={{ marginTop: '8px' }}>没有任何文件被修改。</p>
              )}
            </section>

            <section className="box facts" data-testid="facts">
              <h2>{COPY.factsTitle}</h2>
              <FactRows
                items={displayItems}
                deniedCount={displayDenied.length}
                includePreview={false}
                showNoChecksRow={true}
                onOpenProof={(tab) => setProofTab(tab)}
              />
              {!viewingHistorical && v.notes.length > 0 && (
                <ul className="notes" data-testid="notes" style={{ marginTop: '8px' }}>
                  {v.notes.map((n) => <li key={n} className="notice">{n}</li>)}
                </ul>
              )}
              {!viewingHistorical && v.acceptedRisks.length > 0 && (
                <div className="wbox" data-testid="accepted-risks" style={{ marginTop: '10px', padding: '10px 12px' }}>
                  <strong>{COPY.acceptRisksTitle}</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                    {v.acceptedRisks.map((r, idx) => (
                      <li key={`${idx}-${r.title}`}>
                        <strong>{r.title}</strong>
                        {r.reason && <span className="muted"> — {r.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="muted" style={{ marginTop: '8px' }}>{COPY.acceptFactVerifyNote}</p>
            </section>

            <section className="incomplete" data-testid="incomplete">
              <div className="row sb">
                <h2>{COPY.incompleteTitle}</h2>
                <span className="muted">{COPY.incompleteNotice}</span>
              </div>
              {displayAiReport.kind === 'items' && <ul>{displayAiReport.items.map((i) => <li key={i}>{i}</li>)}</ul>}
              {displayAiReport.kind === 'raw' && (<><p>{COPY.incompleteRaw}</p><blockquote>{displayAiReport.text}</blockquote></>)}
              {displayAiReport.kind === 'none' && <p className="muted" style={{ marginTop: '6px' }}>{COPY.incompleteNone}</p>}
            </section>

            {task.permissions && (
              <details className="box">
                <summary style={{ cursor: 'pointer' }}>这次任务实际生效的权限：{task.permissions.modeName}</summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>{task.permissions.lines.map((l) => <li key={l}>{l}</li>)}</ul>
              </details>
            )}
          </div>

          {/* 右侧：验收状态 → 验收标准逐条确认 → 被拦下的操作 → 操作按钮 */}
          <aside className="stack">
            <section
              className={`box${statusKind === 'failed' ? ' wbox' : ''}`}
              data-testid="acceptance-status"
              data-status={statusKind}
              style={{ padding: '10px 12px' }}
            >
              <div className="row">
                <span className={`tag${statusKind === 'passed' ? ' ok' : statusKind === 'failed' ? ' warn' : ''}`} data-testid="acceptance-status-label">
                  {displayStatus.label}
                </span>
                <span className="muted" data-testid="acceptance-status-reason">{displayStatus.reason}</span>
              </div>
              {!viewingHistorical && <p className="muted" data-testid="verdict" style={{ marginTop: '6px' }}>{v.verdict}</p>}
            </section>

            <section className="box hl" data-testid="criteria">
              <h2>{COPY.criteriaTitle}</h2>
              <div>
                {displayCriteria.map((c) => (
                  <div className="crit-card" key={c.id} data-confirmed={c.confirmed} data-rejected={c.rejected}>
                    <div className="row sb">
                      <span className="grow">{c.text}</span>
                      {viewingHistorical ? (
                        <span className={`tag${c.confirmed ? ' ok' : c.rejected ? ' warn' : ''}`}>
                          {c.confirmed ? COPY.criterionMatch : c.rejected ? COPY.criterionMismatch : '未确认'}
                        </span>
                      ) : (
                        <div className="choice-pair">
                          <button
                            type="button"
                            className={`secondary choice-btn${c.confirmed ? ' active-ok' : ''}`}
                            data-testid={`confirm-${c.id}`}
                            aria-pressed={c.confirmed}
                            disabled={pending}
                            onClick={() => run((s) => s.confirmCriterion(projectId, v.taskId, c.id, v.version))}
                          >
                            {COPY.criterionMatch}
                          </button>
                          <button
                            type="button"
                            className={`secondary choice-btn${c.rejected ? ' active-bad' : ''}`}
                            data-testid={`reject-${c.id}`}
                            aria-pressed={c.rejected}
                            disabled={pending}
                            onClick={() => run((s) => s.rejectCriterion(projectId, v.taskId, c.id, v.version, draftNotes[c.id] ?? c.note ?? ''))}
                          >
                            {COPY.criterionMismatch}
                          </button>
                        </div>
                      )}
                    </div>
                    {viewingHistorical ? (
                      c.note && <p className="muted">{c.note}</p>
                    ) : (
                      c.rejected && (
                        <div className="row" style={{ gap: '6px' }}>
                          <input
                            type="text"
                            data-testid={`reject-note-${c.id}`}
                            value={draftNotes[c.id] ?? c.note ?? ''}
                            placeholder={COPY.rejectNotePlaceholder}
                            onChange={(e) => setDraftNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            onBlur={() => {
                              const nextVal = (draftNotes[c.id] ?? '').trim();
                              if (nextVal !== (c.note ?? '')) {
                                void run((s) => s.rejectCriterion(projectId, v.taskId, c.id, v.version, nextVal));
                              }
                            }}
                            style={{ marginTop: 0, flex: 1 }}
                          />
                          {(draftNotes[c.id] ?? '').trim() !== (c.note ?? '') && (
                            <button
                              type="button"
                              className="secondary choice-btn"
                              data-testid={`save-note-${c.id}`}
                              disabled={pending}
                              onClick={() => run((s) => s.rejectCriterion(projectId, v.taskId, c.id, v.version, draftNotes[c.id] ?? ''))}
                            >
                              {COPY.rejectNoteSave}
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                ))}

                {displayOverall.needed && (
                  <div className="crit-card" data-confirmed={displayOverall.confirmed} data-rejected={displayOverall.rejected}>
                    <div className="row sb">
                      <span className="grow">{displayOverall.text}</span>
                      {viewingHistorical ? (
                        <span className={`tag${displayOverall.confirmed ? ' ok' : displayOverall.rejected ? ' warn' : ''}`}>
                          {displayOverall.confirmed ? COPY.criterionMatch : displayOverall.rejected ? COPY.criterionMismatch : '未确认'}
                        </span>
                      ) : (
                        <div className="choice-pair">
                          <button
                            type="button"
                            className={`secondary choice-btn${displayOverall.confirmed ? ' active-ok' : ''}`}
                            data-testid="confirm-overall"
                            aria-pressed={displayOverall.confirmed}
                            disabled={pending}
                            onClick={() => run((s) => s.confirmOverall(projectId, v.taskId, v.version))}
                          >
                            {COPY.criterionMatch}
                          </button>
                          <button
                            type="button"
                            className={`secondary choice-btn${displayOverall.rejected ? ' active-bad' : ''}`}
                            data-testid="reject-overall"
                            aria-pressed={displayOverall.rejected}
                            disabled={pending}
                            onClick={() => run((s) => s.rejectCriterion(projectId, v.taskId, 'overall', v.version, draftNotes.overall ?? displayOverall.note ?? ''))}
                          >
                            {COPY.criterionMismatch}
                          </button>
                        </div>
                      )}
                    </div>
                    {viewingHistorical ? (
                      displayOverall.note && <p className="muted">{displayOverall.note}</p>
                    ) : (
                      displayOverall.rejected && (
                        <div className="row" style={{ gap: '6px' }}>
                          <input
                            type="text"
                            data-testid="reject-note-overall"
                            value={draftNotes.overall ?? displayOverall.note ?? ''}
                            placeholder={COPY.rejectNotePlaceholder}
                            onChange={(e) => setDraftNotes((prev) => ({ ...prev, overall: e.target.value }))}
                            onBlur={() => {
                              const nextVal = (draftNotes.overall ?? '').trim();
                              if (nextVal !== (displayOverall.note ?? '')) {
                                void run((s) => s.rejectCriterion(projectId, v.taskId, 'overall', v.version, nextVal));
                              }
                            }}
                            style={{ marginTop: 0, flex: 1 }}
                          />
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </section>

            {displayDenied.length > 0 && (
              <section className="box wbox" data-testid="denied">
                <h2>{COPY.deniedTitle}</h2>
                <div>
                  {displayDenied.map((d) => (
                    <div className="item" key={d.id} data-acked={d.acked}>
                      <div className="grow">
                        <div>{d.text}</div>
                        <div className="muted">{d.impact}</div>
                      </div>
                      {d.acked ? (
                        <span className="tag ok">{COPY.acked}</span>
                      ) : viewingHistorical ? (
                        <span className="tag">未确认</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          data-testid={`ack-${d.id}`}
                          disabled={pending}
                          onClick={() => run((s) => s.ackDenied(projectId, v.taskId, d.id, v.version))}
                        >
                          {COPY.ackButton}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="stack" data-testid="actions" style={{ gap: '8px' }}>
              {viewingHistorical ? (
                <button
                  type="button"
                  data-testid="back-to-current-round"
                  onClick={() => setSelectedRound(v.currentRound)}
                  style={{ width: '100%' }}
                >
                  {COPY.roundBackToCurrent(v.currentRound)}
                </button>
              ) : (
                <>
                  {v.confirmTexts.save && <p className="notice" data-testid="save-note">{v.confirmTexts.save}</p>}

                  {displayStatus.showSaveButton && (
                    <>
                      <button
                        type="button"
                        className={v.uncheckedConfirm || a.recheck.highlight ? 'secondary' : ''}
                        data-testid="save-button"
                        disabled={disabled(a.save.enabled)}
                        onClick={() => run((s) => s.saveTask(projectId, v.taskId, v.version))}
                        style={{ width: '100%' }}
                      >
                        {COPY.acceptAndSaveButton}
                      </button>
                      {!a.save.enabled && a.save.reason && (
                        <p className="muted" data-testid="save-reason">{a.save.reason}</p>
                      )}
                      {!a.save.enabled && a.save.files && (
                        <ul className="muted" data-testid="save-files">{a.save.files.map((f) => <li key={f}>{f}</li>)}</ul>
                      )}
                    </>
                  )}

                  {v.uncheckedConfirm && (
                    <div className="confirm-panel" role="alertdialog" aria-modal="false" data-testid="unchecked-confirm-panel">
                      <p data-testid="unchecked-confirm-reason">{v.uncheckedConfirm.reason}</p>
                      <div className="row" style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          data-testid="unchecked-preview-button"
                          disabled={pending}
                          onClick={() => run((s) => s.openPreview(projectId, v.taskId, v.version))}
                        >
                          {v.uncheckedConfirm.previewButtonText}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          data-testid="unchecked-confirm-save-button"
                          disabled={pending || !a.save.enabled}
                          onClick={() => run((s) => s.saveUncheckedTask(projectId, v.taskId, v.version))}
                        >
                          {v.uncheckedConfirm.confirmButtonText}
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    className={statusKind === 'failed' ? '' : 'secondary'}
                    data-testid="rework-button"
                    disabled={disabled(v.reworkAction.enabled)}
                    onClick={() => setShowRework(true)}
                    style={{ width: '100%' }}
                  >
                    {COPY.reworkButton}
                  </button>

                  {a.recheck.highlight && (
                    <button
                      type="button"
                      data-testid="recheck-button"
                      data-highlight="true"
                      disabled={disabled(a.recheck.enabled)}
                      onClick={() => run((s) => s.recheck(projectId, v.taskId))}
                      style={{ width: '100%' }}
                    >
                      {COPY.recheckButton}
                    </button>
                  )}

                  <div className="row">
                    {onBackToProject && (
                      <button
                        type="button"
                        className="secondary grow"
                        data-testid="defer-button"
                        disabled={pending}
                        onClick={onBackToProject}
                      >
                        {COPY.deferButton}
                      </button>
                    )}
                    {!a.recheck.highlight && (
                      <button
                        type="button"
                        className="secondary grow"
                        data-testid="recheck-button"
                        data-highlight="false"
                        disabled={disabled(a.recheck.enabled)}
                        onClick={() => run((s) => s.recheck(projectId, v.taskId))}
                      >
                        {COPY.recheckButton}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary grow"
                      data-testid="discard-button"
                      disabled={disabled(a.discard.enabled)}
                      onClick={() => setDialog('discard')}
                    >
                      {COPY.discardButton}
                    </button>
                  </div>
                  <p className="muted">{COPY.acceptNoPartialNote}</p>
                </>
              )}
            </section>
          </aside>
        </div>
      ) : (
        <div className="stack">
          <p className="headline" data-testid="verdict">{v.verdict}</p>

          {displayItems.length > 0 && (
            <section className="box facts" data-testid="facts">
              <h2>{COPY.factsTitle}</h2>
              <FactRows
                items={displayItems}
                deniedCount={displayDenied.length}
                includePreview={true}
                showNoChecksRow={false}
                onOpenProof={(tab) => setProofTab(tab)}
              />
            </section>
          )}

          {displayChanges.length > 0 && (
            <section className="box" data-testid="changes">
              <h2>{COPY.changesTitle}</h2>
              <ul className="changes">
                {displayChanges.map((c) => (
                  <li key={c.path} data-kind={c.kind}>
                    <strong>{KIND_TEXT[c.kind] ?? '变化'}</strong>　{c.path}
                    {c.additions !== null && c.deletions !== null && <span className="muted"> （+{c.additions} −{c.deletions}）</span>}
                    {c.preview && <DiffPreview p={c.preview} />}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {conflict && deferred && <p className="muted" data-testid="deferred-note">{COPY.deferredNote}</p>}

          <div className="row" data-testid="actions">
            {viewingHistorical ? (
              <button
                type="button"
                data-testid="back-to-current-round"
                onClick={() => setSelectedRound(v.currentRound)}
              >
                {COPY.roundBackToCurrent(v.currentRound)}
              </button>
            ) : (
              <>
                {conflict && <button className="secondary" data-testid="discard-button" disabled={disabled(a.discard.enabled)} onClick={() => setDialog('discard')}>{COPY.discardButton}</button>}
                {conflict && <button className="secondary" data-testid="defer-button" onClick={() => setDeferred(true)}>{COPY.deferButton}</button>}
                {['saved', 'saved_cleanup_pending', 'undo_failed'].includes(v.state) && <button className="secondary" data-testid="undo-button" disabled={disabled(a.undo.enabled)} onClick={() => setDialog('undo')}>{COPY.undoButton}</button>}
                {(v.state === 'saved_cleanup_pending' || v.state === 'discard_cleanup_pending') && <button data-testid="retry-cleanup-button" disabled={disabled(a.retryCleanup.enabled)} onClick={() => run((s) => s.retryCleanup(projectId, v.taskId))}>{COPY.retryCleanupButton}</button>}
              </>
            )}
          </div>
          {!viewingHistorical && ['saved', 'saved_cleanup_pending', 'undo_failed'].includes(v.state) && !a.undo.enabled && a.undo.reason && <p className="muted" data-testid="undo-reason">{a.undo.reason}</p>}

          <section className="incomplete" data-testid="incomplete">
            <h2>{COPY.incompleteTitle}</h2>
            <p className="notice">{COPY.incompleteNotice}</p>
            {displayAiReport.kind === 'items' && <ul>{displayAiReport.items.map((i) => <li key={i}>{i}</li>)}</ul>}
            {displayAiReport.kind === 'raw' && (<><p>{COPY.incompleteRaw}</p><blockquote>{displayAiReport.text}</blockquote></>)}
            {displayAiReport.kind === 'none' && <p className="muted">{COPY.incompleteNone}</p>}
          </section>
        </div>
      )}

      {dialog && (
        <div className="confirm-panel" role="alertdialog" aria-modal="true" data-testid="confirm-panel" data-kind={dialog}>
          <p data-testid="confirm-text">
            {dialog === 'discard' ? v.confirmTexts.discard : v.confirmTexts.undo}
          </p>
          <div className="row" style={{ marginTop: '8px' }}>
            <button
              className="secondary"
              data-testid="confirm-yes"
              onClick={() => run((s) => (dialog === 'discard' ? s.discardTask(projectId, v.taskId) : s.undoSave(projectId, v.taskId)))}
            >
              {dialog === 'discard' ? COPY.discardYes : COPY.undoYes}
            </button>
            <button data-testid="confirm-no" onClick={() => setDialog(null)}>{COPY.cancel}</button>
          </div>
        </div>
      )}
    </div>
  );
}
