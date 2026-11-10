import { useEffect, useState, type FormEvent } from 'react';
import {
  studio,
  type ChiefRoleChoice,
  type DisclosureState,
  type ProjectBriefView,
  type ProjectRoleMode,
  type ProjectRolesView,
  type ProjectStatus,
  type ReviewerRoleChoice,
  type TaskView,
} from './api.js';
import { ProjectBriefForm } from './ProjectBriefForm.js';
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
  const [briefView, setBriefView] = useState<ProjectBriefView | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefSavedNotice, setBriefSavedNotice] = useState<string | null>(null);

  const [rolesView, setRolesView] = useState<ProjectRolesView | null>(null);
  const [roleMode, setRoleMode] = useState<ProjectRoleMode>('global');
  const [roleChief, setRoleChief] = useState<ChiefRoleChoice>('codex');
  const [roleReviewer, setRoleReviewer] = useState<ReviewerRoleChoice>('none');
  const [rolesBusy, setRolesBusy] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesSavedNotice, setRolesSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'settings') return;
    let cancelled = false;
    setBriefError(null);
    setBriefSavedNotice(null);
    setRolesError(null);
    setRolesSavedNotice(null);
    studio()
      .getProjectBrief(project.id)
      .then((v) => {
        if (!cancelled) setBriefView(v);
      })
      .catch((e: Error) => {
        if (!cancelled) setBriefError(e.message);
      });
    studio()
      .getProjectRoles(project.id)
      .then((rv) => {
        if (cancelled) return;
        setRolesView(rv);
        setRoleMode(rv.mode);
        setRoleChief(rv.chief);
        setRoleReviewer(rv.reviewer);
      })
      .catch((e: Error) => {
        if (!cancelled) setRolesError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, tab]);

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
                          {t.round >= 2 && <span data-testid="task-round-badge"> · {COPY.roundBadge(t.round)}</span>}
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
                      {t.round >= 2 && <span data-testid="history-round-badge"> · {COPY.roundBadge(t.round)}</span>}
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
          <div className="box" data-testid="project-settings-brief">
            {briefView?.readOnly ? (
              <>
                <div className="row sb">
                  <h2>项目简介</h2>
                  <span className="tag">只读</span>
                </div>
                <p className="muted" data-testid="project-brief-readonly" style={{ marginTop: '6px' }}>
                  {briefView.readOnlyNote ?? '本项目使用 docs/PROJECT_CONTEXT.md'}
                </p>
              </>
            ) : briefView ? (
              <ProjectBriefForm
                initial={briefView.brief}
                title="项目简介"
                submitLabel="保存项目简介"
                busy={briefBusy}
                outboundNotice={briefView.outboundNotice}
                savedNotice={briefSavedNotice}
                serverError={briefError}
                onSubmit={async (brief) => {
                  setBriefError(null);
                  setBriefSavedNotice(null);
                  setBriefBusy(true);
                  try {
                    const updated = await studio().saveProjectBrief(project.id, brief);
                    setBriefView(updated);
                    setBriefSavedNotice('项目简介已保存。');
                  } catch (e) {
                    setBriefError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBriefBusy(false);
                  }
                }}
              />
            ) : (
              <>
                <h2>项目简介</h2>
                {briefError ? (
                  <p role="alert" className="error">{briefError}</p>
                ) : (
                  <p className="muted">正在加载项目简介…</p>
                )}
              </>
            )}
          </div>

          <div className="box" data-testid="project-settings-roles">
            <h2>AI 角色</h2>
            {(() => {
              const roleName = (c: ChiefRoleChoice | ReviewerRoleChoice) =>
                c === 'claude' ? 'Claude' : c === 'codex' ? 'Codex' : c === 'none' ? '不复核' : '未设置';
              const needUnset = roleMode === 'custom' && (roleChief === 'unset' || roleReviewer === 'unset');
              const needClaude = roleMode === 'custom' && (roleChief === 'claude' || roleReviewer === 'claude') && !rolesView?.claudeAvailable;
              const needCodex = roleMode === 'custom' && (roleChief === 'codex' || roleReviewer === 'codex') && !rolesView?.codexAvailable;
              const unconnectedWarn = needUnset
                ? '存在「未设置」的角色（可能已删除 Key），请重新选择后再保存。'
                : needClaude
                  ? 'Claude 尚未接入（未配置可用 API Key），请先在全局「设置 → AI 与角色」接入后再保存。'
                  : needCodex
                    ? 'Codex 尚未接入或未登录，请先在终端登录 Codex 后再保存。'
                    : null;
              const sameAiNotice =
                roleMode === 'custom' && (roleChief === 'codex' || roleChief === 'claude') && roleChief === roleReviewer
                  ? `「首席」与「复核」均选择了 ${roleName(roleChief)}：将按单思考者模式运行，并标记「未经独立评审」。`
                  : null;
              const handleSaveRoles = async (e: FormEvent) => {
                e.preventDefault();
                if (rolesBusy || unconnectedWarn) return;
                setRolesError(null);
                setRolesSavedNotice(null);
                setRolesBusy(true);
                try {
                  const next = await studio().saveProjectRoles(project.id, roleMode, roleChief, roleReviewer);
                  setRolesView(next);
                  setRoleMode(next.mode);
                  setRoleChief(next.chief);
                  setRoleReviewer(next.reviewer);
                  setRolesSavedNotice('本项目 AI 角色设置已保存（已开始的讨论线程不受影响）。');
                } catch (err) {
                  setRolesError(err instanceof Error ? err.message : String(err));
                } finally {
                  setRolesBusy(false);
                }
              };
              return (
                <form onSubmit={handleSaveRoles} noValidate style={{ marginTop: '6px' }}>
                  <div className="item">
                    <div className="grow">
                      <label htmlFor={`proj-role-mode-${project.id}`}>
                        <strong>首席 / 复核 / 执行</strong>
                      </label>
                      <div className="muted">选择跟随全局设置，或仅在本项目单独指定思考者角色。</div>
                    </div>
                    <select
                      id={`proj-role-mode-${project.id}`}
                      aria-label="角色来源"
                      data-testid="project-role-mode"
                      value={roleMode}
                      onChange={(e) => {
                        setRoleMode(e.target.value as ProjectRoleMode);
                        setRolesError(null);
                        setRolesSavedNotice(null);
                      }}
                    >
                      <option value="global">跟随全局设置</option>
                      <option value="custom">本项目单独设置</option>
                    </select>
                  </div>

                  {roleMode === 'global' && rolesView && (
                    <p className="muted" style={{ marginTop: '8px' }} data-testid="project-role-inherited">
                      当前沿用全局设置：首席 {roleName(rolesView.globalRoles.chief)} · 复核{' '}
                      {roleName(rolesView.globalRoles.reviewer)} · 执行 Codex
                    </p>
                  )}

                  {roleMode === 'custom' && (
                    <>
                      <div className="item">
                        <div className="grow">
                          <label htmlFor={`proj-chief-${project.id}`}>
                            <strong>首席</strong> <span className="muted">· 写方案</span>
                          </label>
                        </div>
                        <select
                          id={`proj-chief-${project.id}`}
                          aria-label="项目首席"
                          data-testid="project-role-chief"
                          value={roleChief}
                          onChange={(e) => {
                            setRoleChief(e.target.value as ChiefRoleChoice);
                            setRolesError(null);
                            setRolesSavedNotice(null);
                          }}
                        >
                          {roleChief === 'unset' && (
                            <option value="unset" disabled>
                              未设置（请重新选择）
                            </option>
                          )}
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                        </select>
                      </div>

                      <div className="item">
                        <div className="grow">
                          <label htmlFor={`proj-reviewer-${project.id}`}>
                            <strong>复核</strong> <span className="muted">· 独立找错</span>
                          </label>
                        </div>
                        <select
                          id={`proj-reviewer-${project.id}`}
                          aria-label="项目复核"
                          data-testid="project-role-reviewer"
                          value={roleReviewer}
                          onChange={(e) => {
                            setRoleReviewer(e.target.value as ReviewerRoleChoice);
                            setRolesError(null);
                            setRolesSavedNotice(null);
                          }}
                        >
                          {roleReviewer === 'unset' && (
                            <option value="unset" disabled>
                              未设置（请重新选择）
                            </option>
                          )}
                          <option value="none">不复核</option>
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                        </select>
                      </div>

                      <div className="item">
                        <div className="grow">
                          <strong>执行</strong> <span className="muted">· 每个任务一个（目前仅支持 Codex）</span>
                        </div>
                        <span data-testid="project-role-executor" className="tag">
                          Codex（固定）
                        </span>
                      </div>
                    </>
                  )}

                  {sameAiNotice && (
                    <p className="notice" style={{ marginTop: '8px' }} data-testid="project-same-ai-notice">
                      {sameAiNotice}
                    </p>
                  )}
                  {unconnectedWarn && (
                    <p role="alert" className="error" style={{ marginTop: '8px' }} data-testid="project-role-unconnected-warn">
                      {unconnectedWarn}
                    </p>
                  )}
                  {rolesError && (
                    <p role="alert" className="error" style={{ marginTop: '8px' }} data-testid="project-roles-error">
                      {rolesError}
                    </p>
                  )}
                  {rolesSavedNotice && (
                    <p role="status" className="muted" style={{ marginTop: '8px' }} data-testid="project-roles-saved">
                      {rolesSavedNotice}
                    </p>
                  )}
                  <div className="row" style={{ marginTop: '10px' }}>
                    <button
                      type="submit"
                      className="btn pri"
                      disabled={rolesBusy || !!unconnectedWarn}
                      data-testid="project-roles-save"
                    >
                      {rolesBusy ? '保存中…' : '保存角色设置'}
                    </button>
                  </div>
                </form>
              );
            })()}
          </div>

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
