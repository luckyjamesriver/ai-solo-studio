import type { TaskView } from './api.js';
import { COPY } from './copy.js';

/**
 * 施工中页（#05-build）：主区三块（正在做什么 / 目前的问题 / 需要你介入吗），右侧（执行者与范围说明 / 默认折叠的大白话执行日志 / 次要停止按钮）。
 * 施工过程中只有“停止”一个按钮。
 */
export function RunView({ task, onStop }: { task: TaskView; onStop: () => void }) {
  const b = task.building;
  return (
    <div className="runview stack" data-testid="run-view" data-fulltrust={task.fullTrust}>
      <div className="g2">
        <div className="stack">
          <section className="box" data-testid="build-doing">
            <div className="row sb">
              <h2>正在做：{b.currentStep}</h2>
              <span className="tag" data-testid="run-state">运行中 · {task.stateText}</span>
            </div>
            <ul className="step-list" data-testid="progress">
              {b.steps.length > 0 ? (
                b.steps.map((s, i) => (
                  <li key={`${i}-${s.text}`} data-step-status={s.status}>
                    <span aria-hidden="true">{s.status === 'done' ? '✓' : '●'}</span>{' '}
                    <strong style={s.status === 'current' ? undefined : { fontWeight: 400 }}>{s.text}</strong>
                  </li>
                ))
              ) : (
                <li className="muted">{COPY.noProgress}</li>
              )}
            </ul>
          </section>

          {b.problems.length > 0 && (
            <section className="box wbox" data-testid="build-problems">
              <h2>目前的问题（{b.problems.length}）</h2>
              <ul className="step-list">
                {b.problems.map((p, i) => (
                  <li key={`${i}-${p.text}`}>
                    <strong>{p.text}</strong>
                    <div className="muted">{p.impact}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="box" data-testid="build-intervention">
            <h2>需要你介入吗？</h2>
            <p className="muted">{b.needsIntervention}</p>
          </section>
        </div>

        <aside className="stack">
          <section className="box">
            <div className="kv" data-testid="run-meta">
              <span className="muted">执行者</span>
              <span>
                <span data-testid="executor-info">执行者：{task.executorText}</span>
                {task.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge">{COPY.fullTrustBadge}</span>}
              </span>
              <span className="muted">你的项目</span>
              <span data-testid="project-safety">{b.projectSafetyLine}</span>
            </div>
            {task.permissions ? (
              <div className="perm" data-testid="perm-summary" style={{ marginTop: '10px' }}>
                <strong>本次实际生效的权限：{task.permissions.modeName}</strong>
                <ul>{task.permissions.lines.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            ) : (
              <p className="muted" data-testid="perm-pending" style={{ marginTop: '10px' }}>{COPY.noProgress}</p>
            )}
            {task.startFailure && <p role="alert" className="error" data-testid="start-failure" style={{ marginTop: '8px' }}>{task.startFailure}</p>}
          </section>

          <details className="box" data-testid="exec-log">
            <summary style={{ cursor: 'pointer' }}>
              <strong>执行日志</strong> <span className="muted">· 只读</span>
            </summary>
            {b.execLog.length > 0 ? (
              <ul className="exec-log-list">
                {b.execLog.map((e, i) => (
                  <li key={`${i}-${e.text}`}>
                    {e.at && <span className="muted">{e.at} </span>}
                    <span>{e.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ marginTop: '8px' }}>{COPY.noProgress}</p>
            )}
          </details>

          <div className="stack" style={{ gap: '6px' }}>
            <button type="button" className="secondary" data-testid="stop-button" onClick={onStop} style={{ width: '100%' }}>{COPY.stopButton}</button>
            <p className="muted" data-testid="stop-hint">{COPY.stopAfterNote}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
