import { useState } from 'react';
import type { DisclosureState, ProjectStatus, TaskView } from './api.js';
import { COPY } from './copy.js';

export type ProjectBoardTab = 'tasks' | 'history' | 'settings';

interface ProjectBoardProps {
  project: ProjectStatus;
  tasks: TaskView[];
  preferredMode: 'standard' | 'full_trust';
  tab: ProjectBoardTab;
  disclosure: DisclosureState | null;
  error: string | null;
  notice: string | null;
  onTabChange: (tab: ProjectBoardTab) => void;
  onCreateTask: (request: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onRevealProject: () => void;
  onCloseProject: () => void;
  onOpenDisclosure: () => void;
}

/**
 * 项目看板（02-project，UI v2.1 第 2/3 节）：
 * 显示 计划中 / 施工中 / 待验收 / 已结束 四列（阶段 5 实现讨论后将「计划中」改为「讨论中」，空列保留展示）。
 * 每张卡片按固定顺序显示：任务名 → 当前状态 → AI 与辅助信息。
 */
export function ProjectBoard({
  project,
  tasks,
  preferredMode,
  tab,
  disclosure,
  error,
  notice,
  onTabChange,
  onCreateTask,
  onOpenTask,
  onRevealProject,
  onCloseProject,
  onOpenDisclosure,
}: ProjectBoardProps) {
  const [request, setRequest] = useState('');
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    if (!request.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateTask(request);
      setRequest('');
    } finally {
      setCreating(false);
    }
  };

  const planning = tasks.filter((t) => t.layer.boardColumn === 'planning' || t.layer.boardColumn === 'discussing');
  const building = tasks.filter((t) => t.layer.boardColumn === 'building');
  const reviewing = tasks.filter((t) => t.layer.boardColumn === 'reviewing');
  const ended = tasks.filter((t) => t.layer.boardColumn === 'ended');
  const columns: {
    key: 'planning' | 'building' | 'reviewing' | 'ended';
    title: string;
    emptyText: string;
    items: TaskView[];
  }[] = [
    { key: 'planning', title: COPY.boardColPlanning, emptyText: COPY.boardEmptyPlanningCol, items: planning },
    { key: 'building', title: COPY.boardColBuilding, emptyText: COPY.boardEmptyCol, items: building },
    { key: 'reviewing', title: COPY.boardColReviewing, emptyText: COPY.boardEmptyCol, items: reviewing },
    { key: 'ended', title: COPY.boardColEnded, emptyText: COPY.boardEmptyCol, items: ended },
  ];

  const historyTasks = tasks.filter((t) => ['saved', 'saved_cleanup_pending', 'undone', 'undo_failed'].includes(t.state));

  return (
    <main className="main" data-testid="project" aria-label={project.name}>
      <div className="row sb">
        <div>
          <h1>{project.name}</h1>
          <div className="muted">{project.path}</div>
        </div>
        <div className="row">
          <button type="button" className="secondary" data-testid="reveal-project" onClick={onRevealProject}>
            {COPY.revealProject}
          </button>
          <button type="button" className="secondary" data-testid="close-project" onClick={onCloseProject}>
            {COPY.boardCloseProject}
          </button>
        </div>
      </div>

      {project.uncommitted > 0 && (
        <p className="notice" data-testid="dirty">
          这个项目有 {project.uncommitted} 个文件的改动还没有保存。后续施工会基于已保存的版本，这些未保存的改动不会被带入，应用也不会替你自动保存。
        </p>
      )}
      {error && <p role="alert" className="error" data-testid="task-error">{error}</p>}
      {notice && <p role="status" className="notice" data-testid="notice">{notice}</p>}

      <div className="tabs" role="tablist" aria-label="项目视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tasks'}
          className={tab === 'tasks' ? 'tc' : ''}
          data-testid="tab-tasks"
          onClick={() => onTabChange('tasks')}
        >
          {COPY.boardTabTasks}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? 'tc' : ''}
          data-testid="tab-history"
          onClick={() => onTabChange('history')}
        >
          {COPY.boardTabHistory}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          className={tab === 'settings' ? 'tc' : ''}
          data-testid="tab-project-settings"
          onClick={() => onTabChange('settings')}
        >
          {COPY.boardTabSettings}
        </button>
      </div>

      {tab === 'tasks' && (
        <section data-testid="tasks" aria-label={COPY.boardTabTasks}>
          <div className="box">
            <label style={{ marginTop: 0 }}>
              {COPY.boardNewTaskPlaceholder}
              <textarea
                data-testid="request"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                rows={2}
              />
            </label>
            <div className="row" style={{ marginTop: '10px' }}>
              <button type="button" data-testid="create-task" onClick={submit} disabled={!request.trim() || creating}>
                创建任务
              </button>
            </div>
          </div>

          <div
            className="grid"
            style={{ marginTop: 'var(--space-section)' }}
            {...(tasks.length > 0 ? { 'data-testid': 'task-list' } : {})}
          >
            {columns.map((col) => (
              <div className="lane" key={col.key} data-testid={`board-col-${col.key}`}>
                <strong>{col.title} · {col.items.length}</strong>
                {col.items.length === 0 ? (
                  <p className="muted" data-testid={`board-empty-${col.key}`}>{col.emptyText}</p>
                ) : (
                  <ul className="lane-list">
                    {col.items.map((t) => (
                      <li key={t.id} className="card" data-state={t.state} data-fulltrust={t.fullTrust}>
                        {/* 1. 任务名 */}
                        <button type="button" className="link card-title" onClick={() => onOpenTask(t.id)}>
                          {t.goal}
                        </button>
                        {/* 2. 当前状态 */}
                        <div className="row" style={{ gap: '6px' }}>
                          <span
                            className={`tag${t.layer.isAbnormal ? ' warn' : t.layer.outcome === 'saved' ? ' ok' : ''}`}
                          >
                            {t.layer.statusTag}
                          </span>
                          {t.fullTrust && (
                            <span className="badge-trust" data-testid="fulltrust-badge-list">
                              {COPY.fullTrustBadge}
                            </span>
                          )}
                          {t.reconciled && (
                            <span className="badge-checked" data-testid="reconciled-badge-list">
                              {COPY.reconciledBadge}
                            </span>
                          )}
                        </div>
                        {/* 3. AI 与辅助信息 */}
                        <div className="muted">
                          {t.executorText}
                          {t.saveCheckText && <span data-testid="task-save-check"> · {t.saveCheckText}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'history' && (
        <section data-testid="project-history" aria-label={COPY.boardTabHistory}>
          <div className="box">
            <h2>任务保存记录</h2>
            {historyTasks.length === 0 ? (
              <p className="muted">{COPY.historyEmpty}</p>
            ) : (
              historyTasks.map((t) => (
                <div className="item" key={t.id}>
                  <div className="grow">
                    <strong>{t.goal}</strong>
                    <div className="muted">
                      {new Date(t.updatedAt).toLocaleString()} · {t.executorText}
                      {t.saveCheckText && ` · ${t.saveCheckText}`} · {t.layer.statusTag}
                    </div>
                  </div>
                  <button type="button" className="secondary" onClick={() => onOpenTask(t.id)}>
                    {COPY.historyViewTask}
                  </button>
                </div>
              ))
            )}
          </div>

          {project.savePoints.length > 0 && (
            <div className="box" style={{ marginTop: 'var(--space-section)' }}>
              <h2>项目保存点</h2>
              <ol className="saves">
                {project.savePoints.map((s) => (
                  <li key={s.sha}>
                    {s.message} <span className="muted">{new Date(s.date).toLocaleString()}</span>
                    {s.checksText && (
                      <span className="muted" data-testid="savepoint-check">
                        {' '}· {s.checksText}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <section className="grid" data-testid="project-settings" aria-label={COPY.boardTabSettings}>
          <div className="box">
            <h2>{COPY.projectSettingsModeTitle}</h2>
            <div className="item">
              <div className="grow">
                <strong data-testid="project-preferred-mode">
                  {preferredMode === 'full_trust' ? COPY.fullTrustTitle : COPY.standardTitle}
                </strong>
                <div className="muted">{COPY.projectSettingsModeDesc}</div>
              </div>
            </div>
          </div>

          <div className="box">
            <h2>{COPY.projectSettingsRiskTitle}</h2>
            <p className="muted">{COPY.projectSettingsRiskDesc}</p>
            <div className="item" style={{ marginTop: '8px' }}>
              <div className="grow">
                <strong>资料外发状态</strong>
                <div className="muted">
                  {disclosure?.accepted ? '已确认外发说明' : '尚未确认外发说明'}
                </div>
              </div>
              <button type="button" className="secondary" onClick={onOpenDisclosure}>
                查看外发说明
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
