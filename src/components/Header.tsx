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
  Moon
} from 'lucide-react';

interface HeaderProps {
  projectState: ProjectState;
  activeTitle?: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  projectState,
  activeTitle = 'X5 | 首页需求推演与方案 (接续待命)',
  theme,
  onToggleTheme,
  onPause,
  onResume,
  onReset,
}) => {
  const getStatusBadge = () => {
    switch (projectState) {
      case 'discussing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200 dark:border-amber-800 animate-pulse">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" /> 双脑磋商中 (Claude ⇄ ChatGPT)
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
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" /> 执行体施工中...
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
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> 本轮施工已完成
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shadow-sm">
            待命中 / 等待新 Idea
          </span>
        );
    }
  };

  return (
    <header className={`h-14 px-5 border-b flex items-center justify-between z-10 select-none transition-colors ${
      theme === 'light'
        ? 'bg-[#f0f4f9] border-[#e3e3e3] text-[#1f1f1f]'
        : 'bg-[#161b22] border-slate-800 text-slate-100'
    }`}>
      {/* Brand & Title (Gemini Style Sparkle) */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {/* Gemini Gradient Star */}
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 flex items-center justify-center shadow-sm">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="font-semibold text-xs text-[#1f1f1f] dark:text-slate-200 truncate max-w-sm tracking-tight">
              {activeTitle}
            </h1>
          </div>
        </div>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800">
          Gemini Style UI
        </span>
      </div>

      {/* Status Center */}
      <div className="flex items-center gap-3">
        {getStatusBadge()}
      </div>

      {/* Controls & Theme Switcher */}
      <div className="flex items-center gap-2">
        {projectState === 'executing' || projectState === 'discussing' ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-sm transition-all active:scale-95"
            title="随时一键叫停所有 AI"
          >
            <Pause className="w-3.5 h-3.5 fill-current" />
            紧急暂停 (Pause)
          </button>
        ) : projectState === 'paused' ? (
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-all active:scale-95"
            title="恢复自动流转"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            继续推进 (Resume)
          </button>
        ) : null}

        {/* Theme Toggle (Light / Dark) */}
        <button
          onClick={onToggleTheme}
          className={`p-2 rounded-full border transition-all ${
            theme === 'light'
              ? 'bg-white hover:bg-slate-100 border-[#e3e3e3] text-slate-700 shadow-sm'
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
              ? 'text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border-[#e3e3e3] shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#21262d] border-transparent hover:border-slate-700'
          }`}
        >
          重置
        </button>
      </div>
    </header>
  );
};
