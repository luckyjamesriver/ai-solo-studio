import { useState } from 'react';
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
        <div className="row">
          <button data-testid="trust-confirm" disabled={!ack} onClick={onConfirm}>{COPY.fullTrustConfirm}</button>
          <button className="secondary" data-testid="trust-cancel" onClick={onCancel}>{COPY.fullTrustCancel}</button>
        </div>
      </div>
    </div>
  );
}

/** 计划卡：模式二选一（默认标准）、扩展权限（仅标准模式）、将运行的检查。 */
export function PlanCard({ task, preferredMode, onChanged }: { task: TaskView; preferredMode: 'standard' | 'full_trust'; onChanged: (t: TaskView) => void }) {
  const hasPlan = task.state !== 'draft';
  const [goal, setGoal] = useState(task.goal);
  const [criteria, setCriteria] = useState(task.criteria.join('\n'));
  // 已有计划按计划来；新任务按项目偏好预选（预选不等于确认）
  const [mode, setMode] = useState<'standard' | 'full_trust'>(hasPlan ? task.mode : preferredMode);
  const [network, setNetwork] = useState(task.network);
  const [showTrust, setShowTrust] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = (m = mode): PlanInput => ({ goal: goal.trim() || task.request, criteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean), mode: m, network });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const addDir = async () => {
    setError(null);
    setDirError(null);
    try {
      await studio().savePlan(task.id, form('standard')); // 先保存当前表单，保证计划存在
      const r = await studio().addExtraDir(task.id);
      if (r.rejected) setDirError(r.rejected);
      onChanged(r.view);
    } catch (e) { fail(e); }
  };
  const removeDir = async (key: string) => { try { onChanged(await studio().removeExtraDir(task.id, key)); } catch (e) { fail(e); } };

  const clickStart = async () => {
    setError(null);
    try {
      const saved = await studio().savePlan(task.id, form());
      onChanged(saved);
      if (mode === 'full_trust') setShowTrust(true); // 完全信任：每个任务都要重新确认，偏好不能跳过
      else onChanged(await studio().startTask(task.id, false));
    } catch (e) { fail(e); }
  };
  const confirmTrust = async () => {
    setShowTrust(false);
    try { onChanged(await studio().startTask(task.id, true)); } catch (e) { fail(e); }
  };
  const cancelTrust = async () => {
    setShowTrust(false);
    setMode('standard');
    try { onChanged(await studio().savePlan(task.id, form('standard'))); } catch (e) { fail(e); }
  };

  return (
    <div className="plan" data-testid="plan-card">
      <h3>计划</h3>
      <label>要做什么<textarea data-testid="goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} /></label>
      <label>验收标准（每行一条，可留空）<textarea data-testid="criteria" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={2} /></label>

      <fieldset className="modes">
        <legend>施工模式</legend>
        <label className="choice">
          <input type="radio" name="mode" data-testid="mode-standard" checked={mode === 'standard'} onChange={() => setMode('standard')} />
          <span><strong>{COPY.standardTitle}</strong><br /><span className="muted">{COPY.standardDesc}</span></span>
        </label>
        <label className="choice">
          <input type="radio" name="mode" data-testid="mode-full-trust" checked={mode === 'full_trust'} onChange={() => setMode('full_trust')} />
          <span><strong>{COPY.fullTrustTitle}</strong><br /><span className="muted">{COPY.fullTrustDesc}</span></span>
        </label>
        {!hasPlan && preferredMode === 'full_trust' && <p className="notice" data-testid="preselect-note">{COPY.fullTrustPreselected}</p>}
      </fieldset>

      {mode === 'standard' && (
        <fieldset className="extras" data-testid="extras">
          <legend>扩展权限（开工前决定，开工后不能再改）</legend>
          <label className="check"><input type="checkbox" data-testid="net-toggle" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> {COPY.netLabel}</label>
          <div>
            <strong>{COPY.extraDirLabel}</strong>
            <ul className="dirs" data-testid="extra-dir-list">
              {task.extraDirs.length ? task.extraDirs.map((d) => (
                <li key={d.key}>{d.path} <button className="link" onClick={() => removeDir(d.key)}>{COPY.extraDirRemove}</button></li>
              )) : <li className="muted">{COPY.extraDirNone}</li>}
            </ul>
            <button className="secondary" data-testid="add-dir" onClick={addDir}>{COPY.extraDirAdd}</button>
            {dirError && <p role="alert" className="error" data-testid="extra-dir-error">{dirError}</p>}
          </div>
        </fieldset>
      )}

      <div className="checks" data-testid="checks-plan">
        <strong>{COPY.checksTitle}</strong>
        {task.checks.length ? (
          <>
            <ul>{task.checks.map((c) => <li key={c.name}>{c.label}</li>)}</ul>
            <p className="muted">{COPY.checksNote}</p>
          </>
        ) : <p className="muted">{COPY.checksNone}</p>}
      </div>

      {error && <p role="alert" className="error" data-testid="plan-error">{error}</p>}
      {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}
      <div className="row"><button data-testid="start-button" onClick={clickStart}>{COPY.startButton}</button></div>
      {showTrust && <TrustPanel onConfirm={confirmTrust} onCancel={cancelTrust} />}
    </div>
  );
}
