import React from 'react';
import { TaskItem, MilestoneCheckpoint, ProjectState } from '../types';
import { CheckCircle2, Clock, PlayCircle, AlertCircle, ArrowRight, ShieldCheck, Cpu } from 'lucide-react';

interface TaskBoardProps {
  tasks: TaskItem[];
  checkpoint: MilestoneCheckpoint | null;
  projectState: ProjectState;
  onApproveCheckpoint: () => void;
  onRequestChange: () => void;
}

export const TaskBoard: React.FC<TaskBoardProps> = ({
  tasks,
  checkpoint,
  projectState,
  onApproveCheckpoint,
  onRequestChange,
}) => {
  const getWorkerBadge = (assignedTo: TaskItem['assignedTo'], name: string) => {
    const colors = {
      cursor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
      claude_code: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      antigravity: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
      deepseek: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    }[assignedTo];

    return (
      <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${colors} flex items-center gap-1`}>
        <Cpu className="w-2.5 h-2.5" />
        {name}
      </span>
    );
  };

  const getStatusIcon = (status: TaskItem['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'in_progress':
        return <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />;
      case 'paused':
        return <AlertCircle className="w-4 h-4 text-amber-400" />;
      case 'failed':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      default:
        return <Clock className="w-4 h-4 text-slate-500" />;
    }
  };

  return (
    <div className="w-96 flex flex-col h-full bg-[#161b22]/50 border-r border-[#30363d] overflow-hidden select-none">
      {/* Board Header */}
      <div className="px-4 py-3 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            施工工单看板 (Task Matrix)
          </h2>
        </div>
        <span className="text-[11px] text-slate-400 font-mono">
          {tasks.filter((t) => t.status === 'completed').length}/{tasks.length} 完成
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Milestone Checkpoint Card */}
        {checkpoint && (
          <div className="p-4 rounded-xl bg-gradient-to-br from-indigo-950/70 via-slate-900 to-slate-950 border border-indigo-500/40 shadow-xl shadow-indigo-950/30">
            <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold mb-1">
              <ShieldCheck className="w-4 h-4" />
              <span>{checkpoint.title}</span>
            </div>
            <p className="text-xs text-slate-300 mb-3 leading-relaxed">
              {checkpoint.description}
            </p>

            {/* Deliverables list */}
            <div className="space-y-1 mb-4">
              <div className="text-[11px] text-slate-400 font-medium">规划交付成果：</div>
              {checkpoint.deliverables.map((item, idx) => (
                <div key={idx} className="flex items-center gap-1.5 text-xs text-slate-200">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            {/* Approval Action Buttons */}
            {projectState === 'awaiting_approval' && (
              <div className="flex flex-col gap-2 pt-2 border-t border-indigo-500/20">
                <button
                  onClick={onApproveCheckpoint}
                  className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/30 transition-all active:scale-95"
                >
                  <PlayCircle className="w-4 h-4" />
                  <span>批准开工 (Proceed)</span>
                </button>
                <button
                  onClick={onRequestChange}
                  className="w-full py-1.5 px-3 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-slate-300 text-xs font-medium transition-colors"
                >
                  提出修改意见
                </button>
              </div>
            )}
          </div>
        )}

        {/* Task List */}
        {tasks.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-slate-500">
            <Clock className="w-8 h-8 stroke-[1.5] mb-2 text-slate-600" />
            <p className="text-xs">暂无活跃任务工单</p>
            <p className="text-[11px] text-slate-600 mt-1">
              在左侧战略研讨室提出想法，Claude 和 ChatGPT 将自动为你生成施工拆解清单。
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              className={`p-3.5 rounded-xl border transition-all ${
                task.status === 'in_progress'
                  ? 'bg-[#1c2128] border-blue-500/60 shadow-lg shadow-blue-500/10'
                  : task.status === 'completed'
                  ? 'bg-[#161b22]/80 border-emerald-500/30 opacity-90'
                  : 'bg-[#161b22]/40 border-[#30363d]'
              }`}
            >
              {/* Task Header */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <span className="text-xs font-medium text-slate-200 line-clamp-1">
                  {task.title}
                </span>
                {getStatusIcon(task.status)}
              </div>

              {/* Task Description */}
              <p className="text-[11px] text-slate-400 mb-2.5 leading-normal">
                {task.description}
              </p>

              {/* Progress Bar (if in progress) */}
              {task.status === 'in_progress' && (
                <div className="w-full bg-[#0d1117] h-1.5 rounded-full overflow-hidden mb-2.5">
                  <div
                    className="bg-blue-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
              )}

              {/* Task Footer */}
              <div className="flex items-center justify-between pt-2 border-t border-[#30363d]/60 text-[10px]">
                {getWorkerBadge(task.assignedTo, task.workerName)}
                <span className="text-slate-500 font-mono">
                  {task.status === 'completed'
                    ? '已归档'
                    : task.status === 'in_progress'
                    ? `${task.progress}% 施工中`
                    : '排队中'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
