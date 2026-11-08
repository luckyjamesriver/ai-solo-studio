import type { TaskView } from './api.js';
import { COPY } from './copy.js';

const FACT_MARK = { ok: '✓', bad: '✗', unchecked: '？' } as const;
const FILE_STATUS: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名', other: '变化' };

/** 结果区：应用自己验证过的事实，与 AI 自己说的“未完成操作”并列，并明确标注后者只是 AI 的说法。 */
export function Result({ task }: { task: TaskView }) {
  const r = task.result;
  if (!r) return <p className="muted">{task.stateText}</p>;
  return (
    <div className="result" data-testid="result" data-fulltrust={task.fullTrust}>
      <div className="head">
        <strong>{task.goal}</strong>
        {task.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge">{COPY.fullTrustBadge}</span>}
        <span className="muted">{task.stateText}</span>
      </div>
      {task.startFailure && <p role="alert" className="error" data-testid="start-failure">{task.startFailure}</p>}
      <p className="headline">{r.headline}</p>
      {r.unexpectedRequests > 0 && <p role="alert" className="error" data-testid="unexpected">{COPY.unexpected}</p>}

      <section className="facts" data-testid="facts">
        <h3>{COPY.factsTitle}</h3>
        <ul>
          {r.facts.map((f) => (
            <li key={f.label} data-status={f.status}>
              <span className="mark">{FACT_MARK[f.status]}</span> <strong>{f.label}</strong>：{f.detail}
            </li>
          ))}
        </ul>
        {r.changes.length > 0 && (
          <ul className="changes" data-testid="changes">
            {r.changes.map((c) => <li key={c.path}>{FILE_STATUS[c.status] ?? '变化'}　{c.path}</li>)}
          </ul>
        )}
      </section>

      <section className="incomplete" data-testid="incomplete">
        <h3>{COPY.incompleteTitle}</h3>
        <p className="notice">{COPY.incompleteNotice}</p>
        {r.incomplete.kind === 'items' && <ul>{r.incomplete.items.map((i) => <li key={i}>{i}</li>)}</ul>}
        {r.incomplete.kind === 'raw' && (<><p>{COPY.incompleteRaw}</p><blockquote>{r.incomplete.text}</blockquote></>)}
        {r.incomplete.kind === 'none' && <p className="muted">{COPY.incompleteNone}</p>}
      </section>

      {task.permissions && (
        <details>
          <summary>这次任务实际生效的权限：{task.permissions.modeName}</summary>
          <ul>{task.permissions.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      )}
      <details data-testid="diagnostics">
        <summary>诊断记录（已隐藏已知的无害噪音）</summary>
        <ul className="muted">{task.diagnostics.map((d, i) => <li key={`${i}-${d}`}>{d}</li>)}</ul>
      </details>
    </div>
  );
}
