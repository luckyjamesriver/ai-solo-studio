import type { RecentProject, WorkbenchEntry, WorkbenchView } from './api.js';
import { COPY } from './copy.js';

interface WorkbenchProps {
  workbench: WorkbenchView;
  recent: RecentProject[];
  filterProjectId: string;
  notice: string | null;
  error: string | null;
  pendingInit: { name: string; path: string } | null;
  onFilterChange: (projectId: string) => void;
  onAction: (entry: WorkbenchEntry) => void;
  onOpenProject: () => void;
  onOpenRecent: (id: string) => void;
  onNewTask: (projectId: string) => void;
  onInitConsent: (consent: boolean) => void;
}

/**
 * 工作台 · 待我处理（01-workbench，UI v2.1 第 2 节）。
 * 全部文案（状态标签与对用户的影响）来自 workbench:get，渲染层不拼接任何技术/命令文字。
 */
export function Workbench({
  workbench,
  recent,
  filterProjectId,
  notice,
  error,
  pendingInit,
  onFilterChange,
  onAction,
  onOpenProject,
  onOpenRecent,
  onNewTask,
  onInitConsent,
}: WorkbenchProps) {
  const matchesFilter = (item: WorkbenchEntry) =>
    filterProjectId === 'all' || item.projectId === null || item.projectId === filterProjectId;

  const needsDecision = workbench.needsDecision.filter(matchesFilter);
  const running = workbench.running.filter(matchesFilter);
  const recentEnded = workbench.recentEnded.filter(matchesFilter);
  const targetProjectId = filterProjectId !== 'all' ? filterProjectId : workbench.projects[0]?.id ?? null;

  // B9 按钮层级：每屏最多一个实心主按钮。无待处理决定项时让主动作留在顶部“打开/新任务”。
  const headerIsPrimary = needsDecision.length === 0;

  return (
    <main className="main" data-testid="workbench" aria-label={COPY.workbenchTitle}>
      <div className="row sb">
        <h1 data-testid="workbench-title">{COPY.workbenchTitle}</h1>
        <div className="row">
          <label className="muted" htmlFor="wb-project-filter" style={{ marginTop: 0 }}>
            {COPY.workbenchFilterLabel}
          </label>
          <select
            id="wb-project-filter"
            className="filter-select"
            data-testid="workbench-filter"
            value={filterProjectId}
            onChange={(e) => onFilterChange(e.target.value)}
          >
            <option value="all">{COPY.workbenchFilterAll}</option>
            {workbench.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {targetProjectId ? (
            <button
              type="button"
              className={headerIsPrimary ? '' : 'secondary'}
              data-testid="workbench-new-task"
              onClick={() => onNewTask(targetProjectId)}
            >
              ＋ 新任务
            </button>
          ) : (
            <button
              type="button"
              className={headerIsPrimary ? '' : 'secondary'}
              data-testid="workbench-open-project"
              onClick={onOpenProject}
            >
              打开项目文件夹
            </button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="error" data-testid="app-error">{error}</p>}
      {notice && <p role="status" className="notice" data-testid="notice">{notice}</p>}

      {pendingInit && (
        <div className="consent" data-testid="init-consent">
          <p><strong>{pendingInit.name}</strong> <span className="muted">{pendingInit.path}</span></p>
          <p>这个文件夹还没有版本记录。将在这个文件夹里创建版本记录（.git），不会修改你的文件。有了它，AI 的每次修改都在独立副本中进行，你可以随时撤销或回到任何一个保存点。</p>
          <div className="row">
            <button onClick={() => onInitConsent(true)}>同意，创建版本记录并打开</button>
            <button className="secondary" onClick={() => onInitConsent(false)}>不同意，不打开</button>
          </div>
        </div>
      )}

      {needsDecision.length === 0 && running.length === 0 && recentEnded.length === 0 && !pendingInit && (
        <section className="box" data-testid="workbench-empty">
          <p className="muted">{COPY.workbenchEmpty}</p>
        </section>
      )}

      <section className="box" data-testid="wb-needs-decision">
        <h2>{COPY.workbenchNeedsDecision}（{needsDecision.length}）</h2>
        {needsDecision.length === 0 ? (
          <p className="muted">当前没有等待你决定的事项。</p>
        ) : (
          needsDecision.map((item, idx) => (
            <div className="item" key={item.id} data-testid={`wb-entry-${item.id}`} data-abnormal={item.isAbnormal}>
              <span className={`tag${item.isAbnormal ? ' warn' : ''}`}>{item.statusLabel}</span>
              <div className="grow">
                <strong>{item.taskName}</strong>
                <div className="muted">{item.projectName} · {item.impact}</div>
              </div>
              <button
                type="button"
                className={idx === 0 ? '' : 'secondary'}
                data-testid={`wb-act-${item.id}`}
                onClick={() => onAction(item)}
              >
                {item.nextAction.label}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="box" data-testid="wb-running">
        <h2>{COPY.workbenchRunning}（{running.length}）</h2>
        {running.length === 0 ? (
          <p className="muted">当前没有正在运行的任务。</p>
        ) : (
          running.map((item) => (
            <div className="item" key={item.id} data-testid={`wb-entry-${item.id}`}>
              <span className="tag">{item.statusLabel}</span>
              <div className="grow">
                <strong>{item.taskName}</strong>
                <div className="muted">{item.projectName} · {item.impact}</div>
              </div>
              <button
                type="button"
                className="link"
                data-testid={`wb-act-${item.id}`}
                onClick={() => onAction(item)}
              >
                {item.nextAction.label}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="box" data-testid="wb-recent-ended">
        <h2>{COPY.workbenchRecentEnded}</h2>
        {recentEnded.length === 0 ? (
          <p className="muted">最近还没有已结束的任务。</p>
        ) : (
          recentEnded.map((item) => (
            <div className="item" key={item.id} data-testid={`wb-entry-${item.id}`}>
              <div className="grow">
                <strong>{item.taskName}</strong>{' '}
                <span className="muted">· {item.projectName} · {item.statusLabel} · {item.impact}</span>
              </div>
              <button
                type="button"
                className="link"
                data-testid={`wb-act-${item.id}`}
                onClick={() => onAction(item)}
              >
                {item.nextAction.label}
              </button>
            </div>
          ))
        )}
      </section>

      {recent.length > 0 && (
        <section className="box" aria-labelledby="recent-h">
          <h2 id="recent-h">{COPY.workbenchRecentTitle}</h2>
          <ul className="recent" data-testid="recent">
            {recent.map((r) => (
              <li key={r.id}>
                <button type="button" className="link" disabled={!r.exists} onClick={() => onOpenRecent(r.id)}>
                  {r.name}
                </button>
                <span className="muted">
                  {' '}{r.path} · {new Date(r.lastOpened).toLocaleString()}
                  {!r.exists && ' · 文件夹已不存在'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
