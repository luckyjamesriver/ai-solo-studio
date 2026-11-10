import type { OpenProjectSummary } from './api.js';
import { COPY } from './copy.js';

export type SidebarActive =
  | { kind: 'workbench' }
  | { kind: 'project'; projectId: string }
  | { kind: 'settings' }
  | { kind: 'onboarding' };

interface SidebarProps {
  active: SidebarActive;
  collapsed: boolean;
  projects: OpenProjectSummary[];
  needsDecisionCount: number;
  hasAbnormalDecision: boolean;
  onToggleCollapse: () => void;
  onSelectWorkbench: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProject: () => void;
  onSelectSettings: () => void;
}

/** 固定宽度可收起侧栏（UI v2.1 第 1 节，不放尚未实现的额度行）。 */
export function Sidebar({
  active,
  collapsed,
  projects,
  needsDecisionCount,
  hasAbnormalDecision,
  onToggleCollapse,
  onSelectWorkbench,
  onSelectProject,
  onOpenProject,
  onSelectSettings,
}: SidebarProps) {
  return (
    <nav
      className={`side${collapsed ? ' collapsed' : ''}`}
      aria-label="主导航"
      data-testid="sidebar"
      data-collapsed={collapsed}
    >
      <button
        type="button"
        className={`nav${active.kind === 'workbench' ? ' on' : ''}`}
        data-testid="nav-workbench"
        aria-label={COPY.navWorkbench}
        title={COPY.navWorkbench}
        onClick={onSelectWorkbench}
      >
        <span className="nav-label">{collapsed ? '待' : COPY.navWorkbench}</span>
        {needsDecisionCount > 0 && (
          <span
            className={hasAbnormalDecision ? 'cntw' : 'cnt'}
            data-testid="workbench-badge"
            data-abnormal={hasAbnormalDecision}
          >
            {needsDecisionCount}
          </span>
        )}
      </button>

      {!collapsed && <div className="grp">{COPY.navProjectsGroup}</div>}

      {projects.map((p) => {
        const badgeCount = p.needsAttentionCount + p.runningCount;
        const abnormal = p.hasAbnormal || p.manualReviewLocked;
        const isOn = active.kind === 'project' && active.projectId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className={`nav${isOn ? ' on' : ''}`}
            data-testid={`nav-project-${p.id}`}
            aria-label={p.name}
            title={p.name}
            onClick={() => onSelectProject(p.id)}
          >
            <span className="nav-label">{collapsed ? p.name.slice(0, 1).toUpperCase() : p.name}</span>
            {badgeCount > 0 && (
              <span
                className={abnormal ? 'cntw' : 'cnt'}
                data-testid={`project-badge-${p.id}`}
                data-abnormal={abnormal}
              >
                {badgeCount}
              </span>
            )}
          </button>
        );
      })}

      <button
        type="button"
        className="nav"
        data-testid="nav-open-project"
        aria-label="打开项目文件夹"
        title="打开项目文件夹"
        onClick={onOpenProject}
      >
        <span className="nav-label">
          <span aria-hidden="true">＋</span>
          {!collapsed && ' 打开项目文件夹'}
        </span>
      </button>

      <div className="side-spacer" />

      <button
        type="button"
        className={`nav${active.kind === 'settings' ? ' on' : ''}`}
        data-testid="nav-settings"
        aria-label={COPY.navSettings}
        title={COPY.navSettings}
        onClick={onSelectSettings}
      >
        <span className="nav-label">{collapsed ? '设' : COPY.navSettings}</span>
      </button>

      <button
        type="button"
        className="secondary side-toggle"
        data-testid="sidebar-toggle"
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        onClick={onToggleCollapse}
      >
        {collapsed ? COPY.sidebarExpand : COPY.sidebarCollapse}
      </button>
    </nav>
  );
}
