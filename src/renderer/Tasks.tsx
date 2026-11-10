import { useCallback, useEffect, useRef, useState } from 'react';
import { studio, type TaskView } from './api.js';
import { COPY } from './copy.js';
import { PlanCard } from './PlanCard.js';
import { RunView } from './RunView.js';
import { Acceptance } from './Acceptance.js';

/** 施工中，以及 AI 刚结束、验收卡还在生成的状态：需要持续刷新 */
const BUSY = ['running', 'exec_succeeded', 'exec_failed', 'stopped', 'timed_out'];

/** 任务区：新建任务、任务列表、选中任务的计划卡 / 施工视图 / 结果。 */
export function Tasks({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [preferred, setPreferred] = useState<'standard' | 'full_trust'>('standard');
  const [selected, setSelected] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshSeq = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    studio()
      .listTasks(projectId)
      .then((r) => {
        if (!mountedRef.current || seq !== refreshSeq.current) return;
        setTasks(r.tasks);
        setPreferred(r.preferredMode);
      })
      .catch((e: Error) => {
        if (!mountedRef.current || seq !== refreshSeq.current) return;
        setError(e.message);
      });
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const handleRefresh = () => refresh();
    window.addEventListener('studio:refresh', handleRefresh);
    return () => {
      mountedRef.current = false;
      refreshSeq.current++;
      window.removeEventListener('studio:refresh', handleRefresh);
    };
  }, [refresh]);

  const current = tasks.find((t) => t.id === selected) ?? null;
  const busy = !!current && (current.running || BUSY.includes(current.state));
  // 施工中（或刚结束、等待验收卡生成）时轮询；其余时候只在用户操作后刷新
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refresh, 600);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const upsert = (t: TaskView) => setTasks((all) => (all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [t, ...all]));
  const create = async () => {
    setError(null);
    try {
      refreshSeq.current++;
      const t = await studio().createTask(projectId, request);
      refreshSeq.current++;
      upsert(t);
      setSelected(t.id);
      setRequest('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const stop = async () => { if (current) try { upsert(await studio().stopTask(projectId, current.id)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };

  return (
    <section aria-labelledby="task-h" data-testid="tasks">
      <h2 id="task-h">任务</h2>
      {error && <p role="alert" className="error" data-testid="task-error">{error}</p>}
      <label>你想让 AI 做什么？<textarea data-testid="request" value={request} onChange={(e) => setRequest(e.target.value)} rows={2} /></label>
      <div className="row"><button data-testid="create-task" onClick={create} disabled={!request.trim()}>创建任务</button></div>

      {tasks.length > 0 && (
        <ul className="tasklist" data-testid="task-list">
          {tasks.map((t) => (
            <li key={t.id} data-state={t.state} data-fulltrust={t.fullTrust}>
              <button className="link" onClick={() => setSelected(t.id)}>{t.goal}</button>
              {t.fullTrust && <span className="badge-trust" data-testid="fulltrust-badge-list">{COPY.fullTrustBadge}</span>}
              <span className="muted"> {t.stateText}</span>
              {t.saveCheckText && <span className="muted" data-testid="task-save-check"> · {t.saveCheckText}</span>}
              {t.reconciled && <span className="badge-checked" data-testid="reconciled-badge-list">{COPY.reconciledBadge}</span>}
            </li>
          ))}
        </ul>
      )}

      {current && (
        <div className="taskpane" data-testid="task-pane">
          {current.running || current.state === 'running'
            ? <RunView task={current} onStop={stop} />
            : ['draft', 'planned', 'approved'].includes(current.state)
              ? <PlanCard key={current.id} projectId={projectId} task={current} preferredMode={preferred} onChanged={(t) => { upsert(t); refresh(); }} />
              : <Acceptance key={current.id} projectId={projectId} task={current} onChanged={refresh} />}
        </div>
      )}
    </section>
  );
}
