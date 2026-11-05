import React from 'react';
import { ProjectState } from '../types';
import { 
  Pause, 
  Play, 
  Sparkles, 
  ShieldAlert, 
  CheckCircle2, 
  RefreshCw, 
  Sun, 
  Moon,
  FolderGit2,
  FileText,
  Terminal,
  Columns2,
  PanelRightClose,
  PanelRightOpen,
  LayoutDashboard,
  Bot,
  SplitSquareVertical
} from 'lucide-react';

export type StudioViewMode = 'war_room' | 'claude_web' | 'chatgpt_web' | 'dual_web';

interface HeaderProps {
  projectState: ProjectState;
  projectName: string;
  activeThreadTitle: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  studioView: StudioViewMode;
  onSetStudioView: (view: StudioViewMode) => void;
  rightViewMode?: 'canvas' | 'console' | 'split';
  onSetRightViewMode?: (mode: 'canvas' | 'console' | 'split') => void;
  isRightPanelCollapsed?: boolean;
  onToggleRightPanelCollapsed?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  projectState,
  projectName,
  activeThreadTitle,
  theme,
  onToggleTheme,
  onPause,
  onResume,
  onReset,
  studioView,
  onSetStudioView,
  rightViewMode = 'canvas',
  onSetRightViewMode,
  isRightPanelCollapsed = false,
  onToggleRightPanelCollapsed,
}) => {
  const getStatusBadge = () => {
    switch (projectState) {
      case 'discussing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200 dark:border-amber-800 animate-pulse">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" /> 双脑实时磋商中 (Claude ⇄ ChatGPT)
          </span>
        );
      case 'awaiting_approval':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400 border border-blue-200 dark:border-blue-800">
            <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" /> 等待老板拍板 (Checkpoint)
          </span>
        );
      case 'executing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" /> 施工队工作中 (Cursor / Antigravity)...
          </span>
        );
      case 'paused':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-400 border border-red-200 dark:border-red-800">
            <ShieldAlert className="w-3.5 h-3.5 text-red-500" /> 进程已冻结 (人类干预中)
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> 本轮施工已交付
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shadow-xs">
            待命中 / 等待新 Idea
          </span>
        );
    }
  };

  return (
    <header className={`h-13 px-4 border-b flex items-center justify-between z-10 select-none transition-colors ${
      theme === 'light'
        ? 'bg-[#f0f4f9] border-[#e3e3e3] text-[#1f1f1f]'
        : 'bg-[#161b22] border-slate-800 text-slate-100'
    }`}>
      {/* Dynamic Project Breadcrumb Path */}
      <div className="flex items-center gap-2 text-xs min-w-[200px]">
        <FolderGit2 className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
        <span className="font-semibold text-slate-700 dark:text-slate-300 truncate max-w-[120px]">
          {projectName}
        </span>
        <span className="text-slate-400">/</span>
        <span className="text-slate-500 dark:text-slate-400 truncate max-w-[150px] font-medium">
          {activeThreadTitle}
        </span>
      </div>

      {/* Main Studio Viewport Switcher (方案2：官方网页直通 & 联合中枢) */}
      <div className="flex items-center bg-white dark:bg-slate-800 p-0.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-xs text-xs">
        <button
          onClick={() => onSetStudioView('war_room')}
          className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 font-medium transition-all ${
            studioView === 'war_room'
              ? 'bg-blue-600 text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:text-blue-600'
          }`}
          title="双脑联合司令部 (同时响应、里程碑拍板与施工总线)"
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>联合中枢 (War Room)</span>
        </button>

        <button
          onClick={() => onSetStudioView('claude_web')}
          className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 font-medium transition-all ${
            studioView === 'claude_web'
              ? 'bg-amber-600 text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:text-amber-600'
          }`}
          title="官方 Claude.ai 原生视界 (持久化独立沙箱)"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
          <span>官方 Claude</span>
        </button>

        <button
          onClick={() => onSetStudioView('chatgpt_web')}
          className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 font-medium transition-all ${
            studioView === 'chatgpt_web'
              ? 'bg-teal-600 text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:text-teal-600'
          }`}
          title="官方 ChatGPT.com 原生视界 (持久化独立沙箱)"
        >
          <Bot className="w-3.5 h-3.5 text-teal-300" />
          <span>官方 ChatGPT</span>
        </button>

        <button
          onClick={() => onSetStudioView('dual_web')}
          className={`px-3 py-1.5 rounded-full flex items-center gap-1.5 font-medium transition-all ${
            studioView === 'dual_web'
              ? 'bg-indigo-600 text-white shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:text-indigo-600'
          }`}
          title="宽屏并排视界：左侧 Claude.ai + 右侧 ChatGPT.com 官方原生同题打擂"
        >
          <Columns2 className="w-3.5 h-3.5" />
          <span>双脑并排打擂</span>
        </button>
      </div>

      {/* Status Center & Right Controls */}
      <div className="flex items-center gap-2">
        {getStatusBadge()}

        {projectState === 'executing' || projectState === 'discussing' ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-sm transition-all active:scale-95"
            title="随时一键叫停所有 AI"
          >
            <Pause className="w-3.5 h-3.5 fill-current" />
            紧急暂停
          </button>
        ) : projectState === 'paused' ? (
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-all active:scale-95"
            title="恢复自动流转"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            继续推进
          </button>
        ) : null}

        {/* Right Panel View Mode Segmented Control (in War Room view only) */}
        {studioView === 'war_room' && onSetRightViewMode && (
          <div className="hidden lg:flex items-center bg-white dark:bg-slate-800 p-0.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-2xs text-xs">
            <button
              onClick={() => {
                if (isRightPanelCollapsed && onToggleRightPanelCollapsed) onToggleRightPanelCollapsed();
                onSetRightViewMode('canvas');
              }}
              className={`px-2.5 py-1 rounded-full flex items-center gap-1 text-[11px] transition-all ${
                !isRightPanelCollapsed && rightViewMode === 'canvas'
                  ? 'bg-blue-600 text-white font-medium shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title="切换到方案与规范文档"
            >
              <FileText className="w-3 h-3" />
              <span>文档</span>
            </button>

            <button
              onClick={() => {
                if (isRightPanelCollapsed && onToggleRightPanelCollapsed) onToggleRightPanelCollapsed();
                onSetRightViewMode('console');
              }}
              className={`px-2.5 py-1 rounded-full flex items-center gap-1 text-[11px] transition-all ${
                !isRightPanelCollapsed && rightViewMode === 'console'
                  ? 'bg-blue-600 text-white font-medium shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title="切换到底层执行体实时流"
            >
              <Terminal className="w-3 h-3" />
              <span>执行流</span>
            </button>

            <button
              onClick={() => {
                if (isRightPanelCollapsed && onToggleRightPanelCollapsed) onToggleRightPanelCollapsed();
                onSetRightViewMode('split');
              }}
              className={`px-2.5 py-1 rounded-full flex items-center gap-1 text-[11px] transition-all ${
                !isRightPanelCollapsed && rightViewMode === 'split'
                  ? 'bg-blue-600 text-white font-medium shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              title="宽屏并排分屏：左侧文档 + 右侧执行体"
            >
              <Columns2 className="w-3 h-3" />
              <span>分屏</span>
            </button>
          </div>
        )}

        {/* Toggle Right Panel Collapse */}
        {studioView === 'war_room' && onToggleRightPanelCollapsed && (
          <button
            onClick={onToggleRightPanelCollapsed}
            className={`p-2 rounded-full border transition-all ${
              theme === 'light'
                ? 'bg-white hover:bg-slate-100 border-[#e3e3e3] text-slate-700 shadow-xs'
                : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
            title={isRightPanelCollapsed ? '展开右侧面板' : '收起右侧面板'}
          >
            {isRightPanelCollapsed ? (
              <PanelRightOpen className="w-4 h-4 text-blue-600" />
            ) : (
              <PanelRightClose className="w-4 h-4" />
            )}
          </button>
        )}

        {/* Theme Toggle */}
        <button
          onClick={onToggleTheme}
          className={`p-2 rounded-full border transition-all ${
            theme === 'light'
              ? 'bg-white hover:bg-slate-100 border-[#e3e3e3] text-slate-700 shadow-xs'
              : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-200'
          }`}
          title={theme === 'light' ? '切换为深色模式' : '切换为浅色模式'}
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4 text-amber-400" />}
        </button>

        <button
          onClick={onReset}
          className={`px-3 py-1.5 rounded-full text-xs border transition-all ${
            theme === 'light'
              ? 'text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border-[#e3e3e3] shadow-xs'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#21262d] border-transparent hover:border-slate-700'
          }`}
        >
          重置
        </button>
      </div>
    </header>
  );
};
