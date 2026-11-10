import { useCallback, useEffect, useRef, useState } from 'react';
import { Acceptance } from './Acceptance.js';
import { PlanCard } from './PlanCard.js';
import { ProjectBoard, type ProjectBoardTab } from './ProjectBoard.js';
import { RunView } from './RunView.js';
import { Sidebar, type SidebarActive } from './Sidebar.js';
import { Workbench } from './Workbench.js';
import { COPY } from './copy.js';
import {
  studio,
  type DisclosureState,
  type HealthItem,
  type HealthReport,
  type LayerKey,
  type LayerState,
  type OpenResult,
  type ProjectStatus,
  type RecentProject,
  type TaskView,
  type WorkbenchEntry,
  type WorkbenchView,
} from './api.js';

const BUSY = ['running', 'exec_succeeded', 'exec_failed', 'stopped', 'timed_out'];

const EMPTY_WORKBENCH: WorkbenchView = {
  needsDecision: [],
  running: [],
  recentEnded: [],
  counts: { needsDecision: 0, running: 0, recentEnded: 0 },
  projects: [],
};

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'installed', label: '已安装' },
  { key: 'starts', label: '能启动' },
  { key: 'compatible', label: '版本兼容' },
  { key: 'loggedIn', label: '已登录' },
  { key: 'secured', label: '安全配置已核验' },
];
const STATE_TEXT: Record<LayerState, string> = { pass: '✓ 通过', fail: '✗ 不通过', unknown: '？未知', na: '— 不适用' };
const OVERALL_TEXT: Record<HealthItem['overall'], string> = { pass: '可以使用', fail: '需要处理', unknown: '有项目无法确认' };

export type AppScreen =
  | { kind: 'onboarding' }
  | { kind: 'workbench' }
  | { kind: 'project'; projectId: string; tab: ProjectBoardTab }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'settings'; tab: 'disclosure' | 'health' };

export function Disclosure({ state, onAccept, onClose }: { state: DisclosureState; onAccept?: () => void; onClose: () => void }) {
  const c = state.content;
  return (
    <div className="overlay">
      <div role="dialog" aria-modal="true" aria-labelledby="disc-h" className="dialog" data-testid="disclosure">
        <h2 id="disc-h">使用前请了解：资料会发给谁</h2>
        <h3>会发送给这些 AI 服务</h3>
        {c.services.length ? (
          <ul>{c.services.map((s) => <li key={s.name}><strong>{s.name}</strong>：{s.role}</li>)}</ul>
        ) : <p className="muted">目前没有检测到可用的 AI 服务。安装并登录后，这里会列出它们的名字。</p>}
        <h3>什么时候发送</h3>
        <ul>{c.when.map((w) => <li key={w}>{w}</li>)}</ul>
        <h3>不会发送什么</h3>
        <ul>{c.never.map((w) => <li key={w}>{w}</li>)}</ul>
        {state.accepted && <p className="muted">你已于 {new Date(state.accepted.acceptedAt).toLocaleString()} 确认。</p>}
        <div className="row">
          {onAccept && <button onClick={onAccept}>我了解了，同意</button>}
          <button className="secondary" onClick={onClose}>{onAccept ? '暂不同意，先看看' : '关闭'}</button>
        </div>
        {onAccept && <p className="muted">不同意也可以浏览环境检查；涉及发送资料的功能会保持关闭。</p>}
      </div>
    </div>
  );
}

export function Health({ item }: { item: HealthItem }) {
  return (
    <li data-id={item.id} data-overall={item.overall}>
      <div className="head">
        <strong>{item.label}</strong>
        <span className="overall" data-overall={item.overall}>{OVERALL_TEXT[item.overall]}</span>
        {item.version && <span className="muted">{item.version}</span>}
      </div>
      <dl className="layers">
        {LAYERS.map((l) => {
          const layer = item.layers[l.key];
          return (
            <div key={l.key} data-layer={l.key} data-state={layer.state}>
              <dt>{l.label}</dt>
              <dd>{STATE_TEXT[layer.state]}{layer.note && <span className="muted"> {layer.note}</span>}</dd>
            </div>
          );
        })}
      </dl>
      {item.foundVia === 'fallback' && <p className="muted" data-testid={`via-${item.id}`}>通过补全路径找到（图形界面启动时系统没有提供这个位置）：{item.location}</p>}
      {item.advice && <p className="advice">怎么办：{item.advice} {item.help && <a href={item.help} target="_blank" rel="noreferrer">官方说明</a>}</p>}
    </li>
  );
}

export function App() {
  const [screen, setScreen] = useState<AppScreen>({ kind: 'onboarding' });
  const [collapsed, setCollapsed] = useState(false);
  const [env, setEnv] = useState<HealthReport | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchView>(EMPTY_WORKBENCH);
  const [filterProjectId, setFilterProjectId] = useState<string>('all');
  const [projectsById, setProjectsById] = useState<Record<string, ProjectStatus>>({});
  const [tasksByProject, setTasksByProject] = useState<Record<string, { tasks: TaskView[]; preferredMode: 'standard' | 'full_trust' }>>({});
  const [pendingInit, setPendingInit] = useState<{ name: string; path: string } | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disc, setDisc] = useState<DisclosureState | null>(null);
  const [showDisc, setShowDisc] = useState(false);

  const mountedRef = useRef(true);
  const refreshSeqRef = useRef<Record<string, number>>({});
  const userNavigatedRef = useRef(false);

  const navigate = useCallback((next: AppScreen) => {
    userNavigatedRef.current = true;
    setNotice(null);
    setError(null);
    setScreen(next);
  }, []);

  const refreshWorkbench = useCallback(() => {
    studio()
      .getWorkbench()
      .then((wb) => {
        if (mountedRef.current) setWorkbench(wb);
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
  }, []);

  const refreshEnv = useCallback((initial = false) => {
    setEnv(null);
    studio()
      .detectEnvironment()
      .then((r) => {
        if (!mountedRef.current) return;
        setEnv(r);
        if (initial && !userNavigatedRef.current) {
          setScreen(r.firstRun ? { kind: 'onboarding' } : { kind: 'workbench' });
        }
        refreshWorkbench();
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
  }, [refreshWorkbench]);

  const refreshRecent = useCallback(() => {
    studio()
      .recentProjects()
      .then((r) => {
        if (mountedRef.current) setRecent(r);
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
  }, []);

  const refreshProjectTasks = useCallback((projectId: string) => {
    const seq = (refreshSeqRef.current[projectId] ?? 0) + 1;
    refreshSeqRef.current[projectId] = seq;
    studio()
      .listTasks(projectId)
      .then((r) => {
        if (!mountedRef.current || refreshSeqRef.current[projectId] !== seq) return;
        setTasksByProject((prev) => ({ ...prev, [projectId]: r }));
        setScreen((cur) => {
          if (cur.kind === 'task' && cur.projectId === projectId && !r.tasks.some((t) => t.id === cur.taskId)) {
            return { kind: 'project', projectId, tab: 'tasks' };
          }
          return cur;
        });
      })
      .catch((e: Error) => {
        if (!mountedRef.current || refreshSeqRef.current[projectId] !== seq) return;
        setError(e.message);
      });
  }, []);

  const loadProjectData = useCallback((projectId: string) => {
    studio()
      .projectStatus(projectId)
      .then((status) => {
        if (mountedRef.current) setProjectsById((prev) => ({ ...prev, [projectId]: status }));
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
    refreshProjectTasks(projectId);
  }, [refreshProjectTasks]);

  useEffect(() => {
    mountedRef.current = true;
    refreshEnv(true);
    refreshRecent();
    refreshWorkbench();
    studio()
      .getDisclosure()
      .then((d) => {
        if (!mountedRef.current) return;
        setDisc(d);
        if (!d.accepted) setShowDisc(true);
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
    return () => {
      mountedRef.current = false;
    };
  }, [refreshEnv, refreshRecent, refreshWorkbench]);

  const activeProjectId = screen.kind === 'project' || screen.kind === 'task' ? screen.projectId : null;
  const activeTaskList = activeProjectId ? tasksByProject[activeProjectId]?.tasks ?? [] : [];
  const activeTask = screen.kind === 'task' ? activeTaskList.find((t) => t.id === screen.taskId) ?? null : null;

  useEffect(() => {
    const handleRefresh = () => {
      refreshWorkbench();
      if (activeProjectId) loadProjectData(activeProjectId);
    };
    window.addEventListener('studio:refresh', handleRefresh);
    return () => window.removeEventListener('studio:refresh', handleRefresh);
  }, [activeProjectId, loadProjectData, refreshWorkbench]);

  const shouldPoll =
    workbench.counts.running > 0 ||
    activeTaskList.some((t) => t.running || BUSY.includes(t.state));

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      refreshWorkbench();
      if (activeProjectId) refreshProjectTasks(activeProjectId);
    }, 600);
    return () => clearInterval(timer);
  }, [shouldPoll, activeProjectId, refreshProjectTasks, refreshWorkbench]);

  const handleOpenResult = (p: Promise<OpenResult>) =>
    p.then((r) => {
      setError(null);
      setNotice(null);
      if (r.kind === 'opened') {
        userNavigatedRef.current = true;
        setPendingInit(null);
        setProjectsById((prev) => ({ ...prev, [r.status.id]: r.status }));
        setScreen({ kind: 'project', projectId: r.status.id, tab: 'tasks' });
        refreshProjectTasks(r.status.id);
        refreshRecent();
        refreshEnv();
        refreshWorkbench();
      } else if (r.kind === 'needs_init') {
        userNavigatedRef.current = true;
        setPendingInit({ name: r.name, path: r.path });
        setScreen({ kind: 'workbench' });
      } else if (r.kind === 'rejected') {
        setNotice(r.reason);
      } else if (r.kind === 'declined') {
        setPendingInit(null);
        setNotice('你没有同意创建版本记录，所以没有打开这个文件夹。你的文件没有任何改动。');
      }
    }).catch((e: Error) => setError(e.message));

  const acceptDisclosure = () =>
    studio()
      .acceptDisclosure()
      .then((d) => {
        setDisc(d);
        setShowDisc(false);
      })
      .catch((e: Error) => setError(e.message));

  const selectProject = (projectId: string, tab: ProjectBoardTab = 'tasks') => {
    navigate({ kind: 'project', projectId, tab });
    loadProjectData(projectId);
  };

  const openTaskPage = (projectId: string, taskId: string) => {
    navigate({ kind: 'task', projectId, taskId });
    loadProjectData(projectId);
  };

  const handleWorkbenchAction = (entry: WorkbenchEntry) => {
    const a = entry.nextAction;
    if (a.kind === 'open_task') openTaskPage(a.projectId, a.taskId);
    else if (a.kind === 'open_history') selectProject(a.projectId, 'history');
    else {
      navigate({ kind: 'settings', tab: 'health' });
      refreshEnv();
    }
  };

  const upsertTask = (projectId: string, t: TaskView) => {
    setTasksByProject((prev) => {
      const cur = prev[projectId] ?? { tasks: [], preferredMode: 'standard' as const };
      const tasks = cur.tasks.some((x) => x.id === t.id)
        ? cur.tasks.map((x) => (x.id === t.id ? t : x))
        : [t, ...cur.tasks];
      return { ...prev, [projectId]: { ...cur, tasks } };
    });
  };

  const createTask = async (projectId: string, req: string) => {
    setError(null);
    const seq = (refreshSeqRef.current[projectId] ?? 0) + 1;
    refreshSeqRef.current[projectId] = seq;
    const t = await studio().createTask(projectId, req);
    refreshSeqRef.current[projectId] = seq + 1;
    upsertTask(projectId, t);
    setScreen({ kind: 'task', projectId, taskId: t.id });
    refreshWorkbench();
  };

  const stopTask = async (projectId: string, taskId: string) => {
    try {
      const updated = await studio().stopTask(projectId, taskId);
      upsertTask(projectId, updated);
      refreshWorkbench();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeProject = async (projectId: string) => {
    try {
      const res = await studio().closeProject(projectId);
      if (!res.ok) {
        setNotice(res.reason);
        return;
      }
      setNotice(null);
      setProjectsById((prev) => {
        const copy = { ...prev };
        delete copy[projectId];
        return copy;
      });
      setTasksByProject((prev) => {
        const copy = { ...prev };
        delete copy[projectId];
        return copy;
      });
      if (filterProjectId === projectId) setFilterProjectId('all');
      navigate({ kind: 'workbench' });
      refreshEnv();
      refreshWorkbench();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sidebarActive: SidebarActive =
    screen.kind === 'project' || screen.kind === 'task'
      ? { kind: 'project', projectId: screen.projectId }
      : screen.kind === 'settings'
        ? { kind: 'settings' }
        : screen.kind === 'onboarding'
          ? { kind: 'onboarding' }
          : { kind: 'workbench' };

  const currentProjectStatus =
    activeProjectId
      ? projectsById[activeProjectId] ??
        (() => {
          const sum = workbench.projects.find((p) => p.id === activeProjectId);
          return sum ? { id: sum.id, path: sum.path, name: sum.name, isRepo: true, uncommitted: 0, savePoints: [], tasks: [] } : null;
        })()
      : null;

  return (
    <div className="app">
      <Sidebar
        active={sidebarActive}
        collapsed={collapsed}
        projects={workbench.projects}
        needsDecisionCount={workbench.counts.needsDecision}
        hasAbnormalDecision={workbench.needsDecision.some((x) => x.isAbnormal)}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onSelectWorkbench={() => {
          navigate({ kind: 'workbench' });
          refreshWorkbench();
        }}
        onSelectProject={(id) => selectProject(id, 'tasks')}
        onOpenProject={() => handleOpenResult(studio().chooseProject())}
        onSelectSettings={() => {
          navigate({ kind: 'settings', tab: 'disclosure' });
          refreshEnv();
        }}
      />

      <div className="main-scroll">
        {screen.kind === 'onboarding' && (
          <main className="main" data-testid="env-onboarding" aria-label={COPY.onboardingTitle}>
            <div className="row sb">
              <div>
                <h1>{COPY.onboardingTitle}</h1>
                <p className="lede">{COPY.onboardingSubtitle}</p>
              </div>
              <button type="button" data-testid="onboarding-continue" onClick={() => navigate({ kind: 'workbench' })}>
                {COPY.onboardingContinue}
              </button>
            </div>
            {error && <p role="alert" className="error" data-testid="app-error">{error}</p>}
            <section className="box">
              {!env ? <p>正在检查…</p> : (
                <>
                  <ul className="env">{env.items.map((i) => <Health key={i.id} item={i} />)}</ul>
                  {env.limitations.length > 0 && (
                    <div className="limits" data-testid="limitations">
                      <strong>已知的限制（目前无法关闭）</strong>
                      <ul>{env.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                    </div>
                  )}
                  <details>
                    <summary>排查信息（PATH）</summary>
                    <p className="muted">应用看到的 PATH：<code>{env.pathInfo.processPath || '（空）'}</code></p>
                    <p className="muted">补全的目录（只用于应用启动的子进程，不修改你的电脑设置）：<code>{env.pathInfo.supplementalDirs.join(':') || '无'}</code></p>
                  </details>
                  <div className="row" style={{ marginTop: '10px' }}>
                    <button type="button" className="secondary" onClick={() => refreshEnv()}>重新检查</button>
                  </div>
                </>
              )}
            </section>
          </main>
        )}

        {screen.kind === 'workbench' && (
          <Workbench
            workbench={workbench}
            recent={recent}
            filterProjectId={filterProjectId}
            notice={notice}
            error={error}
            pendingInit={pendingInit}
            onFilterChange={setFilterProjectId}
            onAction={handleWorkbenchAction}
            onOpenProject={() => handleOpenResult(studio().chooseProject())}
            onOpenRecent={(id) => handleOpenResult(studio().openRecent(id))}
            onNewTask={(pid) => selectProject(pid, 'tasks')}
            onInitConsent={(consent) => handleOpenResult(studio().initProject(consent))}
          />
        )}

        {screen.kind === 'project' && currentProjectStatus && (
          <ProjectBoard
            project={currentProjectStatus}
            tasks={tasksByProject[screen.projectId]?.tasks ?? []}
            preferredMode={tasksByProject[screen.projectId]?.preferredMode ?? workbench.projects.find((p) => p.id === screen.projectId)?.preferredMode ?? 'standard'}
            tab={screen.tab}
            disclosure={disc}
            error={error}
            notice={notice}
            onTabChange={(tab) => setScreen({ kind: 'project', projectId: screen.projectId, tab })}
            onCreateTask={(req) => createTask(screen.projectId, req)}
            onOpenTask={(tid) => openTaskPage(screen.projectId, tid)}
            onRevealProject={() => studio().revealProject().catch((e: Error) => setError(e.message))}
            onCloseProject={() => closeProject(screen.projectId)}
            onOpenDisclosure={() => setShowDisc(true)}
          />
        )}

        {screen.kind === 'task' && activeTask && (
          <main className="main" data-testid="task-page">
            <div className="row sb">
              <div>
                <div className="crumb">
                  <button
                    type="button"
                    className="link"
                    data-testid="breadcrumb-project"
                    onClick={() => selectProject(screen.projectId, 'tasks')}
                  >
                    {currentProjectStatus?.name ?? screen.projectId}
                  </button>
                  <span aria-hidden="true">›</span>
                  <span>任务</span>
                </div>
                <h1>{activeTask.goal}</h1>
              </div>
            </div>
            {error && <p role="alert" className="error" data-testid="task-error">{error}</p>}
            <div className="taskpane" data-testid="task-pane">
              {activeTask.running || activeTask.state === 'running' ? (
                <RunView task={activeTask} onStop={() => stopTask(screen.projectId, activeTask.id)} />
              ) : ['draft', 'planned', 'approved'].includes(activeTask.state) ? (
                <PlanCard
                  key={activeTask.id}
                  projectId={screen.projectId}
                  task={activeTask}
                  preferredMode={tasksByProject[screen.projectId]?.preferredMode ?? 'standard'}
                  onChanged={(t) => {
                    upsertTask(screen.projectId, t);
                    refreshProjectTasks(screen.projectId);
                    refreshWorkbench();
                  }}
                />
              ) : (
                <Acceptance
                  key={activeTask.id}
                  projectId={screen.projectId}
                  task={activeTask}
                  onChanged={() => {
                    refreshProjectTasks(screen.projectId);
                    loadProjectData(screen.projectId);
                    refreshWorkbench();
                  }}
                />
              )}
            </div>
          </main>
        )}

        {screen.kind === 'settings' && (
          <main className="main" data-testid="settings-page" aria-label={COPY.settingsTitle}>
            <h1>{COPY.settingsTitle}</h1>
            <p className="lede">{COPY.settingsSubtitle}</p>
            {error && <p role="alert" className="error" data-testid="app-error">{error}</p>}
            <div className="tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={screen.tab === 'disclosure'}
                className={screen.tab === 'disclosure' ? 'tc' : ''}
                data-testid="tab-settings-disclosure"
                onClick={() => setScreen({ kind: 'settings', tab: 'disclosure' })}
              >
                {COPY.settingsTabDisclosure}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={screen.tab === 'health'}
                className={screen.tab === 'health' ? 'tc' : ''}
                data-testid="tab-settings-health"
                onClick={() => setScreen({ kind: 'settings', tab: 'health' })}
              >
                {COPY.settingsTabHealth}
              </button>
            </div>
            {screen.tab === 'disclosure' ? (
              <section className="box" aria-labelledby="out-h">
                <h2 id="out-h">资料外发</h2>
                <p data-testid="outbound-status">
                  {disc?.accepted ? '已确认外发说明：涉及发送资料的功能可用（每次发送前仍会让你确认清单）。' : '尚未确认外发说明：涉及发送资料的功能已关闭。'}
                </p>
                <div className="row" style={{ marginTop: '10px' }}>
                  <button type="button" className="secondary" onClick={() => setShowDisc(true)}>查看外发说明</button>
                </div>
              </section>
            ) : (
              <section className="box" aria-labelledby="env-h">
                <h2 id="env-h">你的电脑准备好了吗</h2>
                {!env ? <p>正在检查…</p> : (
                  <>
                    <ul className="env">{env.items.map((i) => <Health key={i.id} item={i} />)}</ul>
                    {env.limitations.length > 0 && (
                      <div className="limits" data-testid="limitations">
                        <strong>已知的限制（目前无法关闭）</strong>
                        <ul>{env.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                      </div>
                    )}
                    <details>
                      <summary>排查信息（PATH）</summary>
                      <p className="muted">应用看到的 PATH：<code>{env.pathInfo.processPath || '（空）'}</code></p>
                      <p className="muted">补全的目录（只用于应用启动的子进程，不修改你的电脑设置）：<code>{env.pathInfo.supplementalDirs.join(':') || '无'}</code></p>
                    </details>
                    <div className="row" style={{ marginTop: '10px' }}>
                      <button type="button" className="secondary" onClick={() => refreshEnv()}>重新检查</button>
                    </div>
                  </>
                )}
              </section>
            )}
          </main>
        )}
      </div>

      {showDisc && disc && (
        <Disclosure
          state={disc}
          {...(disc.accepted ? {} : { onAccept: acceptDisclosure })}
          onClose={() => setShowDisc(false)}
        />
      )}
    </div>
  );
}
