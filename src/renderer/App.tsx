import { useCallback, useEffect, useRef, useState } from 'react';
import { EnvOnboarding } from './EnvOnboarding.js';
import { ProjectBoard, type ProjectBoardTab } from './ProjectBoard.js';
import { Disclosure, SettingsPage, type SettingsTab } from './SettingsPage.js';
import { Sidebar, type SidebarActive } from './Sidebar.js';
import { TaskPage } from './TaskPage.js';
import { Workbench } from './Workbench.js';
import {
  studio,
  type ClaudeKeySaveResult,
  type ClaudeKeyStatus,
  type DisclosureState,
  type GlobalAiSettingsView,
  type HealthReport,
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

export type AppScreen =
  | { kind: 'onboarding' }
  | { kind: 'workbench' }
  | { kind: 'project'; projectId: string; tab: ProjectBoardTab }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'settings'; tab: SettingsTab };

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
  const [claudeKey, setClaudeKey] = useState<ClaudeKeyStatus | null>(null);
  const [aiSettings, setAiSettings] = useState<GlobalAiSettingsView | null>(null);

  const mountedRef = useRef(true);
  const refreshSeqRef = useRef<Record<string, number>>({});
  const userNavigatedRef = useRef(false);

  const navigate = useCallback((next: AppScreen) => {
    userNavigatedRef.current = true;
    setNotice(null);
    setError(null);
    setScreen(next);
  }, []);

  const refreshAiSettings = useCallback(() => {
    studio()
      .getAiSettings()
      .then((s) => {
        if (!mountedRef.current) return;
        setAiSettings(s);
        setClaudeKey(s.claudeKey);
      })
      .catch((e: Error) => {
        if (mountedRef.current) setError(e.message);
      });
  }, []);

  const refreshClaudeKey = useCallback(() => {
    refreshAiSettings();
  }, [refreshAiSettings]);

  const refreshDisclosure = useCallback(() => {
    studio()
      .getDisclosure()
      .then((d) => {
        if (mountedRef.current) setDisc(d);
      })
      .catch(() => undefined);
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
    refreshClaudeKey();
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
  }, [refreshEnv, refreshRecent, refreshWorkbench, refreshClaudeKey]);

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
    activeTaskList.some((t) => t.running || t.layer.isRunning || BUSY.includes(t.state));

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

  const handleSaveClaudeKey = async (secret: string): Promise<ClaudeKeySaveResult> => {
    const res = await studio().saveClaudeKey(secret);
    if (res.ok && mountedRef.current) {
      setClaudeKey(res.status);
      refreshAiSettings();
      refreshDisclosure();
    }
    return res;
  };

  const handleDeleteClaudeKey = async (): Promise<ClaudeKeyStatus> => {
    const s = await studio().deleteClaudeKey();
    if (mountedRef.current) {
      setClaudeKey(s);
      refreshAiSettings();
      refreshDisclosure();
    }
    return s;
  };

  const handleSaveAiRoles = async (chief: string, reviewer: string, model: string): Promise<GlobalAiSettingsView> => {
    const updated = await studio().saveAiRoles(chief, reviewer, model);
    if (mountedRef.current) {
      setAiSettings(updated);
      setClaudeKey(updated.claudeKey);
    }
    return updated;
  };

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
          navigate({ kind: 'settings', tab: 'ai' });
          refreshEnv();
          refreshClaudeKey();
        }}
      />

      <div className="main-scroll">
        {screen.kind === 'onboarding' && (
          <EnvOnboarding
            env={env}
            notice={notice}
            error={error}
            onRefresh={() => refreshEnv()}
            onContinue={() => navigate({ kind: 'workbench' })}
          />
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
            preferredMode={
              tasksByProject[screen.projectId]?.preferredMode ??
              workbench.projects.find((p) => p.id === screen.projectId)?.preferredMode ??
              'standard'
            }
            tab={screen.tab}
            disclosure={disc}
            error={error}
            notice={notice}
            onTabChange={(tab) => setScreen({ kind: 'project', projectId: screen.projectId, tab })}
            onCreateTask={(req) => createTask(screen.projectId, req)}
            onOpenTask={(tid) => openTaskPage(screen.projectId, tid)}
            onHistoryChanged={() => {
              loadProjectData(screen.projectId);
              refreshWorkbench();
            }}
            onRevealProject={() => studio().revealProject().catch((e: Error) => setError(e.message))}
            onCloseProject={() => closeProject(screen.projectId)}
            onOpenDisclosure={() => setShowDisc(true)}
          />
        )}

        {screen.kind === 'task' && activeTask && (
          <TaskPage
            projectId={screen.projectId}
            projectName={currentProjectStatus?.name ?? screen.projectId}
            task={activeTask}
            preferredMode={tasksByProject[screen.projectId]?.preferredMode ?? 'standard'}
            error={error}
            onBackToProject={() => selectProject(screen.projectId, 'tasks')}
            onStop={() => stopTask(screen.projectId, activeTask.id)}
            onTaskChanged={(t) => {
              upsertTask(screen.projectId, t);
              refreshProjectTasks(screen.projectId);
              refreshWorkbench();
            }}
            onTaskReplaced={(nextTask) => {
              const seq = (refreshSeqRef.current[screen.projectId] ?? 0) + 1;
              refreshSeqRef.current[screen.projectId] = seq;
              upsertTask(screen.projectId, nextTask);
              setScreen({ kind: 'task', projectId: screen.projectId, taskId: nextTask.id });
              refreshProjectTasks(screen.projectId);
              refreshWorkbench();
            }}
            onAcceptanceChanged={() => {
              refreshProjectTasks(screen.projectId);
              loadProjectData(screen.projectId);
              refreshWorkbench();
            }}
            onOpenAiSettings={() => {
              navigate({ kind: 'settings', tab: 'ai' });
              refreshEnv();
              refreshAiSettings();
            }}
            onOpenHistory={() => selectProject(screen.projectId, 'history')}
            onOpenTask={(tid) => openTaskPage(screen.projectId, tid)}
          />
        )}

        {screen.kind === 'settings' && (
          <SettingsPage
            tab={screen.tab}
            disc={disc}
            env={env}
            claudeKey={claudeKey}
            aiSettings={aiSettings}
            error={error}
            onTabChange={(tab) => {
              setScreen({ kind: 'settings', tab });
              if (tab === 'ai') refreshAiSettings();
            }}
            onShowDisclosure={() => setShowDisc(true)}
            onRefreshEnv={() => {
              refreshEnv();
              refreshAiSettings();
            }}
            onSaveClaudeKey={handleSaveClaudeKey}
            onDeleteClaudeKey={handleDeleteClaudeKey}
            onSaveAiRoles={handleSaveAiRoles}
          />
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
