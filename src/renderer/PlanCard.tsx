import { useEffect, useRef, useState } from 'react';
import { studio, type PlanInput, type TaskView } from './api.js';
import { COPY } from './copy.js';

/** 完全信任确认面板：不勾选“我已了解风险”就不能点“确认并开工”（核心层还有第二道门禁）。 */
function TrustPanel({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="overlay">
      <div role="dialog" aria-modal="true" aria-labelledby="trust-h" className="dialog" data-testid="trust-panel">
        <h2 id="trust-h">{COPY.fullTrustTitle}：请先确认风险</h2>
        <p className="risk" data-testid="trust-risk">{COPY.fullTrustRisk}</p>
        <label className="check">
          <input type="checkbox" data-testid="trust-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {COPY.fullTrustAck}
        </label>
        <div className="row" style={{ marginTop: '12px' }}>
          <button type="button" className="secondary" data-testid="trust-confirm" disabled={!ack} onClick={onConfirm}>{COPY.fullTrustConfirm}</button>
          <button type="button" data-testid="trust-cancel" onClick={onCancel}>{COPY.fullTrustCancel}</button>
        </div>
      </div>
    </div>
  );
}

/** 施工计划确认页（#04-plan，UI v2.1 第 5 节）。每屏仅保留一个实心主按钮：「批准并开工」。 */
export function PlanCard({ projectId, task, preferredMode, onChanged }: { projectId: string; task: TaskView; preferredMode: 'standard' | 'full_trust'; onChanged: (t: TaskView) => void }) {
  const hasPlan = task.state !== 'draft';
  const [goal, setGoal] = useState(task.goal);
  const [criteriaRows, setCriteriaRows] = useState<string[]>(task.criteria);
  // 已有计划按计划来；新任务按项目偏好预选（预选不等于确认）
  const [mode, setMode] = useState<'standard' | 'full_trust'>(hasPlan ? task.mode : preferredMode);
  const [network, setNetwork] = useState(task.network);
  const [showTrust, setShowTrust] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingCriteria, setSavingCriteria] = useState(false);
  const savePromiseRef = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    setGoal(task.goal);
    setCriteriaRows(task.criteria);
    setMode(task.state !== 'draft' ? task.mode : preferredMode);
    setNetwork(task.network);
  }, [task.id, task.updatedAt, task.state, task.goal, task.criteria, task.mode, task.network, preferredMode]);

  const cleanCriteria = (rows: string[]) => rows.map((s) => s.trim()).filter(Boolean);
  const form = (m = mode, rows = criteriaRows): PlanInput => ({
    goal: goal.trim() || task.request,
    criteria: cleanCriteria(rows),
    mode: m,
    network,
  });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const criteriaDirty = (() => {
    const next = cleanCriteria(criteriaRows);
    return next.length !== task.criteria.length || next.some((c, i) => c !== task.criteria[i]);
  })();

  const persistCriteria = async (rows: string[]) => {
    const next = cleanCriteria(rows);
    const changed = next.length !== task.criteria.length || next.some((c, i) => c !== task.criteria[i]);
    if (!changed || savingCriteria) return;
    setError(null);
    setSavingCriteria(true);
    const p = studio()
      .savePlan(projectId, task.id, form(mode, rows))
      .then((updated) => onChanged(updated))
      .catch((e) => fail(e))
      .finally(() => {
        if (savePromiseRef.current === p) savePromiseRef.current = null;
        setSavingCriteria(false);
      });
    savePromiseRef.current = p;
    await p;
  };

  const addDir = async () => {
    setError(null);
    setDirError(null);
    try {
      await savePromiseRef.current?.catch(() => undefined);
      await studio().savePlan(projectId, task.id, form('standard')); // 先保存当前表单，保证计划存在
      const r = await studio().addExtraDir(projectId, task.id);
      if (r.rejected) setDirError(r.rejected);
      onChanged(r.view);
    } catch (e) { fail(e); }
  };
  const removeDir = async (key: string) => { try { onChanged(await studio().removeExtraDir(projectId, task.id, key)); } catch (e) { fail(e); } };

  const clickStart = async () => {
    setError(null);
    try {
      await savePromiseRef.current?.catch(() => undefined);
      const saved = await studio().savePlan(projectId, task.id, form());
      onChanged(saved);
      if (mode === 'full_trust') setShowTrust(true); // 完全信任：每个任务都要重新确认，偏好不能跳过
      else onChanged(await studio().startTask(projectId, task.id, false));
    } catch (e) { fail(e); }
  };
  const confirmTrust = async () => {
    setShowTrust(false);
    try { onChanged(await studio().startTask(projectId, task.id, true)); } catch (e) { fail(e); }
  };
  const cancelTrust = async () => {
    setMode('standard');
    const p = studio().savePlan(projectId, task.id, form('standard'));
    savePromiseRef.current = p;
    try {
      onChanged(await p);
    } catch (e) {
      fail(e);
    } finally {
      if (savePromiseRef.current === p) savePromiseRef.current = null;
      setShowTrust(false);
    }
  };

  return (
    <div className="plan stack" data-testid="plan-card">
      <section className="box">
        <div className="row sb">
          <h2>{COPY.planHeaderTitle}</h2>
          {task.planUnreviewed && (
            <span className="tag warn" data-testid="plan-unreviewed-badge">
              {COPY.planUnreviewedBadge}
            </span>
          )}
        </div>
        <p className="muted">{task.state === 'approved' ? COPY.planApprovedHeaderDesc : COPY.planHeaderDesc}</p>
        {task.reapproveNotice && (
          <p role="status" className="notice" data-testid="criteria-reconfirm-notice" style={{ marginTop: '8px' }}>
            {task.reapproveNotice}
          </p>
        )}
      </section>

      <div className="g2">
        <div className="stack">
          <section className="box">
            <h2>{COPY.planGoalTitle}</h2>
            <textarea
              data-testid="goal"
              aria-label={COPY.planGoalTitle}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
            />
            <h2 style={{ marginTop: '12px' }}>{COPY.planExpectedTitle}</h2>
            <p className="muted" data-testid="expected-changes">
              {task.extraDirs.length > 0 ? COPY.planExpectedExtraDesc : COPY.planExpectedDesc}
            </p>
          </section>

          <section className="box" data-testid="criteria">
            <h2>{COPY.planCriteriaTitle}</h2>
            <div className="stack" style={{ gap: '8px' }}>
              {criteriaRows.length === 0 ? (
                <p className="muted">{COPY.planCriteriaEmpty}</p>
              ) : (
                criteriaRows.map((c, idx) => (
                  <div className="criterion-row" key={idx}>
                    <input
                      type="text"
                      data-testid={`criterion-input-${idx}`}
                      aria-label={`验收标准 ${idx + 1}`}
                      value={c}
                      onChange={(e) => {
                        const copy = [...criteriaRows];
                        copy[idx] = e.target.value;
                        setCriteriaRows(copy);
                      }}
                      onBlur={() => {
                        if (task.state === 'approved') void persistCriteria(criteriaRows);
                      }}
                    />
                    <button
                      type="button"
                      className="link"
                      data-testid={`criterion-remove-${idx}`}
                      onClick={() => {
                        const next = criteriaRows.filter((_, i) => i !== idx);
                        setCriteriaRows(next);
                        if (task.state === 'approved') void persistCriteria(next);
                      }}
                    >
                      {COPY.extraDirRemove}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="row" style={{ marginTop: '10px' }}>
              <button
                type="button"
                className="secondary"
                data-testid="add-criterion"
                onClick={() => setCriteriaRows((prev) => [...prev, ''])}
              >
                {COPY.planCriteriaAdd}
              </button>
              {task.state === 'approved' && criteriaDirty && (
                <button
                  type="button"
                  className="secondary"
                  data-testid="save-criteria-button"
                  disabled={savingCriteria}
                  onClick={() => void persistCriteria(criteriaRows)}
                >
                  {COPY.planCriteriaSaveEdit}
                </button>
              )}
            </div>
            <p className="muted" style={{ marginTop: '8px' }}>{COPY.planCriteriaHint}</p>
          </section>
        </div>

        <aside className="stack">
          <section className="box hl">
            <h2>权限</h2>
            <div className="stack" style={{ gap: '10px' }}>
              <label className="choice" style={{ marginTop: 0 }}>
                <input
                  type="radio"
                  name="mode"
                  data-testid="mode-standard"
                  checked={mode === 'standard'}
                  onChange={() => setMode('standard')}
                />
                <span>
                  <strong>{COPY.standardTitle}</strong>
                  <br />
                  <span className="muted">{COPY.standardDesc}</span>
                </span>
              </label>

              {mode === 'standard' && (
                <div className="plan-extras" data-testid="extras">
                  <label className="check" style={{ marginTop: 0 }}>
                    <input
                      type="checkbox"
                      data-testid="net-toggle"
                      checked={network}
                      onChange={(e) => setNetwork(e.target.checked)}
                    />
                    <span>{COPY.netLabel}</span>
                  </label>

                  <div>
                    <div className="row sb">
                      <strong>{COPY.extraDirLabel}</strong>
                      <button type="button" className="secondary" data-testid="add-dir" onClick={addDir}>
                        {COPY.extraDirAdd}
                      </button>
                    </div>
                    <ul className="dirs" data-testid="extra-dir-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {task.extraDirs.length > 0 ? (
                        task.extraDirs.map((d) => (
                          <li key={d.key} className="extra-dir-card" data-testid={`extra-dir-item-${d.key}`}>
                            <div className="row sb">
                              <strong>{d.path} · {COPY.extraDirWritableTag}</strong>
                              <button type="button" className="link" onClick={() => removeDir(d.key)}>
                                {COPY.extraDirRemove}
                              </button>
                            </div>
                            <span>{COPY.extraDirWarn}</span>
                            <span className="muted">{COPY.extraDirReadableNote}</span>
                          </li>
                        ))
                      ) : (
                        <li className="muted">
                          {COPY.extraDirNone} {COPY.extraDirReadableNote}
                        </li>
                      )}
                    </ul>
                    {task.blockedReadLocations.length > 0 && (
                      <details className="muted" data-testid="blocked-read-locations" style={{ marginTop: '8px' }}>
                        <summary style={{ cursor: 'pointer' }}>{COPY.blockedReadLocationsSummary}</summary>
                        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '2px 10px', fontSize: '12px' }}>
                          {task.blockedReadLocations.map((loc) => (
                            <li key={loc}><code>{loc}</code></li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {dirError && <p role="alert" className="error" data-testid="extra-dir-error">{dirError}</p>}
                  </div>
                </div>
              )}

              <label className="choice" style={{ marginTop: 0 }}>
                <input
                  type="radio"
                  name="mode"
                  data-testid="mode-full-trust"
                  checked={mode === 'full_trust'}
                  onChange={() => setMode('full_trust')}
                />
                <span>
                  <strong>{COPY.fullTrustTitle}</strong>
                  <br />
                  <span className="muted">{COPY.fullTrustDesc}</span>
                </span>
              </label>

              {!task.fullTrustConfirmed && preferredMode === 'full_trust' && mode === 'full_trust' && (
                <p className="notice" data-testid="preselect-note">{COPY.fullTrustPreselected}</p>
              )}
              <p className="muted">{COPY.planNoAutoDecisionNote}</p>
            </div>
          </section>

          <section className="box">
            <div className="stack" style={{ gap: '8px' }}>
              <div className="row sb">
                <span className="muted">执行者与检查</span>
                <span className="muted" data-testid="executor-info">执行者：{task.executorText}</span>
              </div>
              <div className="checks" data-testid="checks-plan">
                <strong>{COPY.checksTitle}</strong>
                {task.checks.length > 0 ? (
                  <>
                    <ul style={{ margin: '6px 0', paddingLeft: '18px' }}>
                      {task.checks.map((c) => (
                        <li key={c.name}>{c.name === 'build' ? COPY.checkBuildLabel : COPY.checkTestLabel}</li>
                      ))}
                    </ul>
                    <p className="muted">{COPY.checksNote}</p>
                  </>
                ) : (
                  <p className="muted" style={{ marginTop: '4px' }}>{COPY.checksNone}</p>
                )}
              </div>
            </div>
          </section>

          {error && <p role="alert" className="error" data-testid="plan-error">{error}</p>}
          {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}

          <button type="button" data-testid="start-button" onClick={clickStart} style={{ width: '100%' }}>
            {COPY.startButton}
          </button>
        </aside>
      </div>

      {showTrust && <TrustPanel onConfirm={confirmTrust} onCancel={cancelTrust} />}
    </div>
  );
}
