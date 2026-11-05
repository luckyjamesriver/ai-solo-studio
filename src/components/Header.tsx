import React from 'react';
import { ProjectState } from '../types';
import { Pause, Play, Sparkles, ShieldAlert, CheckCircle2, RefreshCw } from 'lucide-react';

interface HeaderProps {
  projectState: ProjectState;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  projectState,
  onPause,
  onResume,
  onReset,
}) => {
  const getStatusBadge = () => {
    switch (projectState) {
      case 'discussing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
            <Sparkles className="w-3.5 h-3.5" /> 双脑磋商中 (Claude ⇄ ChatGPT)
          </span>
        );
      case 'awaiting_approval':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" /> 等待老板拍板 (Checkpoint)
          </span>
        );
      case 'executing':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 执行体施工中...
          </span>
        );
      case 'paused':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/40">
            <ShieldAlert className="w-3.5 h-3.5" /> 进程已冻结 (人类干预中)
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" /> 本轮施工已完成
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
            待命中 / 等待新 Idea
          </span>
        );
    }
  };

  return (
    <header className="h-16 px-6 bg-[#161b22]/90 backdrop-blur border-b border-[#30363d] flex items-center justify-between z-10 select-none">
      {/* Brand & Title */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
          AS
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-sm tracking-wide text-white">AI Solo Studio</h1>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              v0.1 Prototype
            </span>
          </div>
          <p className="text-[11px] text-slate-400">独立创作者的虚拟 AI 协同工作台</p>
        </div>
      </div>

      {/* Status Center */}
      <div className="flex items-center gap-3">
        {getStatusBadge()}
      </div>

      {/* Boss Controls (干预与控制) */}
      <div className="flex items-center gap-2">
        {projectState === 'executing' || projectState === 'discussing' ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-md shadow-red-600/30 transition-all active:scale-95"
            title="随时一键叫停所有 AI"
          >
            <Pause className="w-3.5 h-3.5 fill-current" />
            紧急暂停 (Pause)
          </button>
        ) : projectState === 'paused' ? (
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 transition-all active:scale-95"
            title="恢复自动流转"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            继续推进 (Resume)
          </button>
        ) : null}

        <button
          onClick={onReset}
          className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-[#21262d] border border-transparent hover:border-[#30363d] transition-all"
        >
          重置看板
        </button>
      </div>
    </header>
  );
};
