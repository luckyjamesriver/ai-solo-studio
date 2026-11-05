import React from 'react';
import { 
  Plus, 
  FolderKanban, 
  FolderOpen,
  ChevronDown, 
  ChevronRight,
  PanelLeftClose, 
  PanelLeftOpen,
  MessageSquare,
  Sparkles,
  Cpu,
  CheckCircle2,
  FolderPlus
} from 'lucide-react';
import { ProjectFolder, RoleAssignment } from '../types';

interface SidebarProps {
  projects: ProjectFolder[];
  activeProjectId: string;
  activeThreadId: string;
  onSelectProject: (projectId: string) => void;
  onToggleProjectExpand: (projectId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onNewThreadInProject: (projectId: string) => void;
  onNewProject: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenRoleModal: () => void;
  roles: RoleAssignment;
  theme: 'light' | 'dark';
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  activeProjectId,
  activeThreadId,
  onSelectProject,
  onToggleProjectExpand,
  onSelectThread,
  onNewThreadInProject,
  onNewProject,
  isCollapsed,
  onToggleCollapse,
  onOpenRoleModal,
  roles,
  theme,
}) => {
  if (isCollapsed) {
    return (
      <div className={`w-14 shrink-0 h-full border-r flex flex-col items-center py-4 transition-colors select-none ${
        theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#0f172a] border-slate-800'
      }`}>
        <button
          onClick={onToggleCollapse}
          className={`p-2.5 rounded-full transition-colors ${
            theme === 'light' ? 'hover:bg-[#dfe3e7] text-slate-700' : 'hover:bg-slate-800 text-slate-400'
          }`}
          title="展开侧边栏"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
        <button
          onClick={onNewProject}
          className="mt-4 p-3 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-md transition-all active:scale-95"
          title="新建项目"
        >
          <FolderPlus className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button
          onClick={onOpenRoleModal}
          className="p-2.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800 text-blue-600 transition-colors"
          title="AI 席位与角色分配"
        >
          <Cpu className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <aside className={`w-full h-full border-r flex flex-col transition-colors select-none text-xs ${
      theme === 'light' 
        ? 'bg-[#f0f4f9] border-[#e3e3e3] text-[#1f1f1f]' 
        : 'bg-[#0b0f17] border-[#1e293b] text-slate-300'
    }`}>
      {/* Brand Header */}
      <div className={`p-4 border-b flex items-center justify-between ${
        theme === 'light' ? 'border-[#e3e3e3]' : 'border-slate-800'
      }`}>
        <div className="flex items-center gap-2 font-semibold text-sm">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold shadow-sm">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <span className={theme === 'light' ? 'text-[#1f1f1f]' : 'text-slate-100'}>
            AI Solo Studio
          </span>
        </div>

        <button
          onClick={onToggleCollapse}
          className={`p-2 rounded-full transition-colors ${
            theme === 'light' ? 'hover:bg-[#dfe3e7] text-slate-600' : 'hover:bg-slate-800 text-slate-400'
          }`}
          title="折叠侧边栏"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Top Action Buttons (新建项目 & 新建议题) */}
      <div className="p-3 grid grid-cols-2 gap-2 border-b border-[#e3e3e3] dark:border-slate-800">
        <button
          onClick={onNewProject}
          className={`py-2 px-3 rounded-full border flex items-center justify-center gap-1.5 font-medium transition-all shadow-xs ${
            theme === 'light'
              ? 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-[#1f1f1f]'
              : 'bg-[#161f30] hover:bg-[#1e293b] border-slate-700 text-slate-100'
          }`}
          title="在本地初始化一个全新项目"
        >
          <FolderPlus className="w-3.5 h-3.5 text-blue-600" />
          <span>新建项目</span>
        </button>

        <button
          onClick={() => onNewThreadInProject(activeProjectId)}
          className={`py-2 px-3 rounded-full border flex items-center justify-center gap-1.5 font-medium transition-all shadow-xs ${
            theme === 'light'
              ? 'bg-blue-600 hover:bg-blue-500 text-white border-blue-600'
              : 'bg-blue-500 hover:bg-blue-400 text-white border-blue-500'
          }`}
          title="在当前项目中开始新对话"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建对话</span>
        </button>
      </div>

      {/* Projects & Nested Conversations Tree (项目在上，对话在下，可展开当前项目) */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="px-2 py-1 text-[11px] font-semibold text-[#444746] dark:text-slate-400 uppercase tracking-wider flex items-center justify-between">
          <span>工程项目与议题</span>
          <span className="text-[10px] text-slate-400 font-mono">{projects.length} 个项目</span>
        </div>

        <div className="space-y-1.5">
          {projects.map((proj) => {
            const isCurrent = proj.id === activeProjectId;
            return (
              <div key={proj.id} className="rounded-2xl overflow-hidden">
                {/* Project Header Row */}
                <div
                  onClick={() => {
                    onSelectProject(proj.id);
                    onToggleProjectExpand(proj.id);
                  }}
                  className={`px-3 py-2.5 rounded-full flex items-center justify-between cursor-pointer transition-all ${
                    isCurrent
                      ? theme === 'light'
                        ? 'bg-white border border-[#e3e3e3] shadow-xs text-blue-700 font-semibold'
                        : 'bg-[#1c2436] border border-blue-500/40 text-blue-400 font-semibold'
                      : theme === 'light'
                      ? 'hover:bg-[#dfe3e7] text-[#1f1f1f]'
                      : 'hover:bg-slate-800 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {proj.isExpanded ? (
                      <FolderOpen className="w-4 h-4 text-blue-600 shrink-0" />
                    ) : (
                      <FolderKanban className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                    <span className="truncate text-xs">{proj.name}</span>
                    {proj.isCurrent && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-600 font-normal">
                        活跃
                      </span>
                    )}
                  </div>

                  {proj.isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  )}
                </div>

                {/* Sub-Threads under Project (Nested Tree) */}
                {proj.isExpanded && (
                  <div className="ml-4 pl-2.5 border-l-2 border-slate-200 dark:border-slate-800 mt-1 space-y-1 py-1">
                    {proj.threads.map((thread) => {
                      const isThreadActive = isCurrent && thread.id === activeThreadId;
                      return (
                        <button
                          key={thread.id}
                          onClick={() => onSelectThread(proj.id, thread.id)}
                          className={`w-full text-left px-2.5 py-1.5 rounded-full flex items-center gap-2 transition-all text-[11px] ${
                            isThreadActive
                              ? theme === 'light'
                                ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200'
                                : 'bg-[#1e293b] text-blue-400 font-semibold'
                              : theme === 'light'
                              ? 'hover:bg-slate-200/60 text-[#444746] hover:text-[#1f1f1f]'
                              : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <MessageSquare className={`w-3 h-3 shrink-0 ${isThreadActive ? 'text-blue-600' : 'text-slate-400'}`} />
                          <span className="truncate">{thread.title}</span>
                        </button>
                      );
                    })}

                    {/* Quick Add Thread Button */}
                    <button
                      onClick={() => onNewThreadInProject(proj.id)}
                      className="w-full text-left px-2.5 py-1 text-[10px] text-blue-600 hover:text-blue-700 flex items-center gap-1 opacity-80 hover:opacity-100"
                    >
                      <Plus className="w-2.5 h-2.5" />
                      <span>新建对话</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Multi-AI Fleet Status & Role Assignment Button */}
      <div className="p-3 border-t border-[#e3e3e3] dark:border-slate-800">
        <div 
          onClick={onOpenRoleModal}
          className={`p-3 rounded-2xl border cursor-pointer transition-all ${
            theme === 'light'
              ? 'bg-white hover:bg-slate-50 border-[#e3e3e3] shadow-xs'
              : 'bg-[#161f30] hover:bg-[#1e293b] border-slate-700'
          }`}
          title="点击自定义每个 AI 的席位角色"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[11px] flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-600" />
              <span>多 AI 协同席位分配</span>
            </span>
            <span className="text-[10px] text-blue-600 font-medium hover:underline">角色设置 ⚙️</span>
          </div>

          <div className="space-y-1.5 text-[10px]">
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
              <span className="truncate">🧠 Claude: {roles.claudeRole}</span>
              <span className="text-emerald-600 font-semibold shrink-0">就绪</span>
            </div>
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
              <span className="truncate">🛡️ ChatGPT: {roles.chatgptRole}</span>
              <span className="text-emerald-600 font-semibold shrink-0">就绪</span>
            </div>
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
              <span className="truncate">🚀 Cursor: {roles.cursorRole}</span>
              <span className="text-blue-600 font-semibold shrink-0">本地</span>
            </div>
            <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
              <span className="truncate">🪐 Antigravity: {roles.antigravityRole}</span>
              <span className="text-indigo-600 font-semibold shrink-0">本地</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
