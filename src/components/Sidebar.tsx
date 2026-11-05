import React, { useState } from 'react';
import { 
  Plus, 
  Pin, 
  FolderKanban, 
  ChevronDown, 
  PanelLeftClose, 
  PanelLeftOpen,
  MessageSquare,
  Sparkles,
  Link2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { ThreadItem } from '../types';

interface SidebarProps {
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenAccountBridge: () => void;
  accounts: {
    claude: boolean;
    chatgpt: boolean;
  };
  theme: 'light' | 'dark';
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeThreadId,
  onSelectThread,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  onOpenAccountBridge,
  accounts,
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
          onClick={onNewChat}
          className="mt-4 p-3 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-md transition-all active:scale-95"
          title="新聊天"
        >
          <Plus className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button
          onClick={onOpenAccountBridge}
          className="p-2.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 transition-colors"
          title="官方账号连接"
        >
          <Link2 className="w-4 h-4" />
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
      {/* Top Header / App Switcher */}
      <div className={`p-4 border-b flex items-center justify-between ${
        theme === 'light' ? 'border-[#e3e3e3]' : 'border-slate-800'
      }`}>
        <div className="flex items-center gap-2 font-semibold text-sm">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold shadow-sm">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <span className={theme === 'light' ? 'text-[#1f1f1f]' : 'text-slate-100'}>
            Solo Studio
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 cursor-pointer" />
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

      {/* New Chat Button (Gemini Style Pill) */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          className={`w-full py-2.5 px-4 rounded-full border flex items-center gap-2.5 font-medium transition-all shadow-sm ${
            theme === 'light'
              ? 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-[#1f1f1f]'
              : 'bg-[#161f30] hover:bg-[#1e293b] border-slate-700 text-slate-100'
          }`}
        >
          <Plus className="w-4 h-4 text-blue-600" />
          <span>新建对话 / 项目议题</span>
        </button>
      </div>

      {/* Navigation & Section List */}
      <div className="flex-1 overflow-y-auto px-3 space-y-4">
        {/* Pinned Section */}
        <div>
          <div className="flex items-center justify-between px-3 py-1 text-[11px] font-semibold text-[#444746] dark:text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <Pin className="w-3 h-3 text-slate-400" /> 置顶任务
            </span>
          </div>
          <div className="mt-1 space-y-1">
            {pinnedThreads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              return (
                <button
                  key={thread.id}
                  onClick={() => onSelectThread(thread.id)}
                  className={`w-full text-left px-3.5 py-2.5 rounded-full flex items-center gap-2.5 transition-all text-xs ${
                    isActive
                      ? theme === 'light'
                        ? 'bg-white text-blue-700 font-semibold shadow-sm border border-[#e3e3e3]'
                        : 'bg-[#1e293b] text-blue-400 font-semibold'
                      : theme === 'light'
                      ? 'hover:bg-[#dfe3e7] text-[#444746] hover:text-[#1f1f1f]'
                      : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-600' : 'text-slate-400'}`} />
                  <span className="truncate">{thread.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Projects Section */}
        <div>
          <div className="flex items-center justify-between px-3 py-1 text-[11px] font-semibold text-[#444746] dark:text-slate-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <FolderKanban className="w-3 h-3 text-slate-400" /> 本地工程项目
            </span>
          </div>
          <div className="mt-1 space-y-1">
            {projectList.map((p) => (
              <div
                key={p.id}
                className={`px-3.5 py-2 rounded-full flex items-center gap-2.5 cursor-pointer transition-colors text-xs ${
                  theme === 'light'
                    ? 'hover:bg-[#dfe3e7] text-[#444746]'
                    : 'hover:bg-slate-800/60 text-slate-400'
                }`}
              >
                <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Account Bridge Status Card (BYOS) */}
      <div className="p-3 border-t border-[#e3e3e3] dark:border-slate-800">
        <div 
          onClick={onOpenAccountBridge}
          className={`p-3 rounded-2xl border cursor-pointer transition-all ${
            theme === 'light'
              ? 'bg-white hover:bg-slate-50 border-[#e3e3e3] shadow-xs'
              : 'bg-[#161f30] hover:bg-[#1e293b] border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[11px] flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-blue-500" />
              <span>官方订阅连接 (BYOS)</span>
            </span>
            <span className="text-[10px] text-blue-600 font-medium">配置</span>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-[#444746] dark:text-slate-400">Claude.ai (Pro)</span>
              {accounts.claude ? (
                <span className="text-emerald-600 font-semibold flex items-center gap-1 text-[10px]">
                  <CheckCircle2 className="w-3 h-3" /> 已连接
                </span>
              ) : (
                <span className="text-amber-600 flex items-center gap-1 text-[10px]">
                  <AlertCircle className="w-3 h-3" /> 待连接
                </span>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[#444746] dark:text-slate-400">ChatGPT (Plus)</span>
              {accounts.chatgpt ? (
                <span className="text-emerald-600 font-semibold flex items-center gap-1 text-[10px]">
                  <CheckCircle2 className="w-3 h-3" /> 已连接
                </span>
              ) : (
                <span className="text-amber-600 flex items-center gap-1 text-[10px]">
                  <AlertCircle className="w-3 h-3" /> 待连接
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
