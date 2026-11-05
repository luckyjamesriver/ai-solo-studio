import React, { useState } from 'react';
import { Terminal, ChevronUp, ChevronDown, Cpu } from 'lucide-react';

export interface ConsoleLog {
  id: string;
  time: string;
  workerTag: string; // e.g. "Cursor", "Antigravity", "Claude", "System"
  workerColor: string; // e.g. "text-indigo-600 bg-indigo-50 border-indigo-200"
  type: 'stdout' | 'stderr' | 'system' | 'diff';
  text: string;
}

interface ExecutionConsoleProps {
  logs: ConsoleLog[];
  activeCommand?: string;
  activeWorkerName?: string;
  isExecuting: boolean;
}

export const ExecutionConsole: React.FC<ExecutionConsoleProps> = ({
  logs,
  activeCommand,
  activeWorkerName = 'Cursor Agent',
  isExecuting,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div
      className={`border-t border-[#e3e3e3] dark:border-[#30363d] bg-[#f8fafc] dark:bg-[#0d1117] transition-all duration-300 flex flex-col select-none ${
        isExpanded ? 'h-56' : 'h-10'
      }`}
    >
      {/* Console Header Bar */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="h-10 px-4 bg-white dark:bg-[#161b22] border-b border-[#e3e3e3] dark:border-[#30363d]/60 flex items-center justify-between cursor-pointer hover:bg-slate-50 dark:hover:bg-[#21262d] transition-colors"
      >
        <div className="flex items-center gap-2.5 text-xs font-mono text-[#1f1f1f] dark:text-slate-300">
          <Terminal className="w-4 h-4 text-blue-600" />
          <span className="font-semibold">底层执行体实时流 (Live Worker Runner)</span>
          
          {/* Active Worker Status Badge (清楚告知用户谁在干活) */}
          {isExecuting ? (
            <span className="flex items-center gap-1.5 text-[11px] font-sans font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-2.5 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              当前执行者: <strong>{activeWorkerName}</strong> ({activeCommand || '执行中...'})
            </span>
          ) : (
            <span className="text-[11px] font-sans text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700">
              待命中
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-slate-400 text-xs">
          <span className="text-[11px] font-mono text-slate-500">{logs.length} 行输出</span>
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-slate-500" />
          ) : (
            <ChevronUp className="w-4 h-4 text-slate-500" />
          )}
        </div>
      </div>

      {/* Terminal Output Area with Worker Badges */}
      {isExpanded && (
        <div className="flex-1 p-3 overflow-y-auto font-mono text-xs space-y-1.5 bg-[#ffffff] dark:bg-[#090d13] select-text">
          {logs.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-400">
              终端待命中，等待调度 Cursor 或 Antigravity 派发指令...
            </div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className={`flex items-start gap-2.5 leading-relaxed ${
                  log.type === 'stderr'
                    ? 'text-red-600 dark:text-red-400'
                    : log.type === 'diff'
                    ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-500/5 px-1 rounded'
                    : log.type === 'system'
                    ? 'text-blue-700 dark:text-blue-400 font-semibold'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                {/* Timestamp */}
                <span className="text-slate-400 select-none text-[10px] w-14 shrink-0 font-mono mt-0.5">
                  {log.time}
                </span>

                {/* Executor Label Badge (执行者标签) */}
                <span className={`text-[10px] font-sans px-2 py-0.2 rounded-md font-medium shrink-0 border ${
                  log.workerColor || 'bg-slate-100 text-slate-600 border-slate-200'
                }`}>
                  {log.workerTag || 'System'}
                </span>

                {/* Log Text */}
                <span className="flex-1 break-all whitespace-pre-wrap">{log.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
