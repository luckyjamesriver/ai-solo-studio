import type { TaskView } from './api.js';
import { COPY } from './copy.js';

/**
 * 施工中视图：只有一个操作——停止。
 * 施工中不再有任何审批：授权都在开工前完成，碰到边界操作会失败并写进结果。所以这里没有任何“同意/批准”类按钮。
 */
export function RunView({ task, onStop }: { task: TaskView; onStop: () => void }) {
  return (
    <div className="runview" data-testid="run-view" data-fulltrust={task.fullTrust}>
      <div className="head">
        <strong>{task.goal}</strong>
        {task.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge">{COPY.fullTrustBadge}</span>}
      </div>
      <p data-testid="run-state">当前状态：{task.stateText}</p>
      {task.permissions ? (
        <div className="perm" data-testid="perm-summary">
          <strong>本次实际生效的权限：{task.permissions.modeName}</strong>
          <ul>{task.permissions.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : <p className="muted" data-testid="perm-pending">{COPY.noProgress}</p>}
      {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}
      <h3>进度</h3>
      <ul className="progress" data-testid="progress">
        {task.progress.length ? task.progress.map((p, i) => <li key={`${i}-${p}`}>{p}</li>) : <li className="muted">{COPY.noProgress}</li>}
      </ul>
      <div className="row">
        <button className="secondary" data-testid="stop-button" onClick={onStop}>{COPY.stopButton}</button>
      </div>
    </div>
  );
}
