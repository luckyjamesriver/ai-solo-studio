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
  Bot
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
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 animate-pulse">
            <Sparkles className="w-3.5 h-3.5" /> 双脑磋商中 (Claude ⇄ ChatGPT)
          </span>
        );
      case 'awaiting_approval':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" /> 等待老板拍板 (Checkpoint)
          </span>
        );
      case 'executing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 执行体施工中...
          </span>
        );
      case 'paused':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-500/20 text-red-700 dark:text-red-400 border border-red-500/40">
            <ShieldAlert className="w-3.5 h-3.5" /> 进程已冻结 (人类干预中)
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" /> 本轮施工已完成
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700">
            待命中 / 等待新 Idea
          </span>
        );
    }
  };

  return (
    <header className={`h-14 px-5 border-b flex items-center justify-between z-10 select-none transition-colors ${
      theme === 'light'
        ? 'bg-white/95 border-slate-200 text-slate-800 backdrop-blur'
        : 'bg-[#161b22]/95 border-slate-800 text-slate-100 backdrop-blur'
    }`}>
      {/* Current Task Title (like screenshot tab) */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h1 className="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate max-w-sm">
            {activeTitle}
          </h1>
        </div>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
          Solo Studio
        </span>
      </div>

      {/* Status Center */}
      <div className="flex items-center gap-3">
        {getStatusBadge()}
      </div>

      {/* Boss Controls & Theme Switcher */}
      <div className="flex items-center gap-2">
        {/* Emergency Pause / Resume */}
        {projectState === 'executing' || projectState === 'discussing' ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-sm transition-all active:scale-95"
            title="随时一键叫停所有 AI"
          >
            <Pause className="w-3.5 h-3.5 fill-current" />
            紧急暂停 (Pause)
          </button>
        ) : projectState === 'paused' ? (
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-all active:scale-95"
            title="恢复自动流转"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            继续推进 (Resume)
          </button>
        ) : null}

        {/* Theme Toggle (Light / Dark) */}
        <button
          onClick={onToggleTheme}
          className={`p-1.5 rounded-lg border transition-all ${
            theme === 'light'
              ? 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
              : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-200'
          }`}
          title={theme === 'light' ? '切换为深色模式' : '切换为浅色模式'}
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4 text-amber-400" />}
        </button>

        <button
          onClick={onReset}
          className={`px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
            theme === 'light'
              ? 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 border-transparent hover:border-slate-200'
              : 'text-slate-400 hover:text-slate-200 hover:bg-[#21262d] border-transparent hover:border-slate-700'
          }`}
        >
          重置
        </button>
      </div>
    </header>
  );
};
