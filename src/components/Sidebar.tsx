import React, { useState } from 'react';
import { 
  Plus, 
  Search, 
  Pin, 
  FolderKanban, 
  ChevronDown, 
  ChevronRight, 
  PanelLeftClose, 
  PanelLeftOpen,
  MessageSquare,
  Sparkles,
  Bot
} from 'lucide-react';
import { ThreadItem } from '../types';

interface SidebarProps {
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  theme: 'light' | 'dark';
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeThreadId,
  onSelectThread,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  theme,
}) => {
  const [pinnedThreads] = useState<ThreadItem[]>([
    { id: 't-1', title: '总管理员 | 项目总规划与派工', category: 'pinned' },
    { id: 't-2', title: 'X5 | 首页需求推演与方案 (接续待命)', category: 'pinned', isActive: true },
    { id: 't-3', title: 'AI 工具协同机制研究', category: 'pinned' },
    { id: 't-4', title: '总管理员 | Claude & ChatGPT 联动测试', category: 'pinned' },
  ]);

  const [projectList] = useState([
    { id: 'p-1', name: 'ai-solo-studio (当前)' },
    { id: 'p-2', name: 'Smart Hifi Music' },
    { id: 'p-3', name: 'SACD Native' },
  ]);

  if (isCollapsed) {
    return (
      <div className={`w-14 shrink-0 border-r flex flex-col items-center py-4 transition-colors select-none ${
        theme === 'light' ? 'bg-[#f8fafc] border-slate-200' : 'bg-[#0f172a] border-slate-800'
      }`}>
        <button
          onClick={onToggleCollapse}
          className={`p-2 rounded-lg transition-colors ${
            theme === 'light' ? 'hover:bg-slate-200 text-slate-600' : 'hover:bg-slate-800 text-slate-400'
          }`}
          title="展开侧边栏"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
        <button
          onClick={onNewChat}
          className={`mt-4 p-2.5 rounded-xl shadow-sm transition-all ${
            theme === 'light' 
              ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20' 
              : 'bg-blue-500 hover:bg-blue-400 text-white'
          }`}
          title="新聊天"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <aside className={`w-64 shrink-0 border-r flex flex-col h-full transition-colors select-none text-xs ${
      theme === 'light' 
        ? 'bg-[#f8fafc] border-slate-200 text-slate-700' 
        : 'bg-[#0b0f17] border-[#1e293b] text-slate-300'
    }`}>
      {/* Top Header / App Switcher */}
      <div className={`p-3.5 border-b flex items-center justify-between ${
        theme === 'light' ? 'border-slate-200' : 'border-slate-800'
      }`}>
        <div className="flex items-center gap-2 font-semibold text-sm">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shadow-sm">
            AS
          </div>
          <span className={theme === 'light' ? 'text-slate-900' : 'text-slate-100'}>
            Solo Studio
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 cursor-pointer" />
        </div>

        <button
          onClick={onToggleCollapse}
          className={`p-1.5 rounded-md transition-colors ${
            theme === 'light' ? 'hover:bg-slate-200 text-slate-500' : 'hover:bg-slate-800 text-slate-400'
          }`}
          title="折叠侧边栏"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          className={`w-full py-2 px-3 rounded-xl border flex items-center gap-2 font-medium transition-all shadow-sm ${
            theme === 'light'
              ? 'bg-white hover:bg-slate-50 border-slate-200 text-slate-800 hover:border-slate-300'
              : 'bg-[#161f30] hover:bg-[#1e293b] border-slate-700 text-slate-100'
          }`}
        >
          <Plus className="w-4 h-4 text-blue-500" />
          <span>新建对话 / 项目议题</span>
        </button>
      </div>

      {/* Navigation & Section List */}
      <div className="flex-1 overflow-y-auto px-3 space-y-4">
        {/* Pinned Section */}
        <div>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <Pin className="w-3 h-3 text-slate-400" /> 置顶任务
            </span>
          </div>
          <div className="mt-1 space-y-0.5">
            {pinnedThreads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              return (
                <button
                  key={thread.id}
                  onClick={() => onSelectThread(thread.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 transition-all ${
                    isActive
                      ? theme === 'light'
                        ? 'bg-slate-200/90 text-blue-700 font-semibold shadow-sm'
                        : 'bg-[#1e293b] text-blue-400 font-semibold'
                      : theme === 'light'
                      ? 'hover:bg-slate-200/50 text-slate-600 hover:text-slate-900'
                      : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-500' : 'text-slate-400'}`} />
                  <span className="truncate">{thread.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Projects Section */}
        <div>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <FolderKanban className="w-3 h-3 text-slate-400" /> 本地工程项目
            </span>
          </div>
          <div className="mt-1 space-y-0.5">
            {projectList.map((p) => (
              <div
                key={p.id}
                className={`px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer transition-colors ${
                  theme === 'light'
                    ? 'hover:bg-slate-200/50 text-slate-600'
                    : 'hover:bg-slate-800/60 text-slate-400'
                }`}
              >
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className={`p-3 border-t text-[11px] flex items-center justify-between ${
        theme === 'light' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-slate-800 bg-[#070a10] text-slate-500'
      }`}>
        <span className="flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-amber-500" />
          <span>Claude 3.7 + GPT-4o</span>
        </span>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-semibold">
          在线
        </span>
      </div>
    </aside>
  );
};
