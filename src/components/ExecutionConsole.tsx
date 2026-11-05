import React, { useState } from 'react';
import { Terminal, ChevronUp, ChevronDown, CheckCircle, FileCode, Play, AlertTriangle } from 'lucide-react';

interface ConsoleLog {
  id: string;
  time: string;
  type: 'stdout' | 'stderr' | 'system' | 'diff';
  text: string;
}

interface ExecutionConsoleProps {
  logs: ConsoleLog[];
  activeCommand?: string;
  isExecuting: boolean;
}

export const ExecutionConsole: React.FC<ExecutionConsoleProps> = ({
  logs,
  activeCommand,
  isExecuting,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div
      className={`border-t border-[#30363d] bg-[#0d1117] transition-all duration-300 flex flex-col ${
        isExpanded ? 'h-52' : 'h-10'
      }`}
    >
      {/* Console Header Bar */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="h-10 px-4 bg-[#161b22] border-b border-[#30363d]/60 flex items-center justify-between cursor-pointer hover:bg-[#21262d] transition-colors select-none"
      >
        <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
          <Terminal className="w-3.5 h-3.5 text-blue-400" />
          <span className="font-semibold text-slate-200">底层执行体实时流 (Live Worker Runner)</span>
          {isExecuting && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              正在执行: {activeCommand || 'bash'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-slate-400 text-xs">
          <span className="text-[11px] font-mono text-slate-500">{logs.length} 行输出</span>
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronUp className="w-4 h-4" />
          )}
        </div>
      </div>

      {/* Terminal Output Area */}
      {isExpanded && (
        <div className="flex-1 p-3 overflow-y-auto font-mono text-xs space-y-1 bg-[#090d13]">
          {logs.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-600">
              终端待命中，等待执行体派发指令...
            </div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className={`flex gap-3 leading-relaxed ${
                  log.type === 'stderr'
                    ? 'text-red-400'
                    : log.type === 'diff'
                    ? 'text-emerald-300 bg-emerald-500/5 px-1 rounded'
                    : log.type === 'system'
                    ? 'text-blue-400 font-semibold'
                    : 'text-slate-300'
                }`}
              >
                <span className="text-slate-600 select-none text-[10px] w-14 shrink-0">
                  {log.time}
                </span>
                <span className="flex-1 break-all whitespace-pre-wrap">{log.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
