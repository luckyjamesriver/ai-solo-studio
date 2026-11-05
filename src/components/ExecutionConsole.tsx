import React, { useState } from 'react';
import { 
  Terminal, 
  ChevronUp, 
  ChevronDown, 
  Copy, 
  Trash2, 
  Check, 
  Sparkles, 
  Bot, 
  Cpu, 
  Layers,
  SlidersHorizontal,
  ExternalLink
} from 'lucide-react';
import { ModelConfig } from '../types';

export interface ConsoleLog {
  id: string;
  time: string;
  workerTag: string; // "Cursor" | "Antigravity" | "Claude" | "ChatGPT" | "System"
  workerColor: string; // CSS color classes
  type: 'stdout' | 'stderr' | 'system' | 'diff';
  text: string;
}

type WorkerTab = 'all' | 'cursor' | 'antigravity' | 'claude' | 'chatgpt';

interface ExecutionConsoleProps {
  logs: ConsoleLog[];
  activeCommand?: string;
  activeWorkerName?: string;
  isExecuting: boolean;
  modelConfig: ModelConfig;
  onUpdateModelConfig: (cfg: ModelConfig) => void;
  theme: 'light' | 'dark';
  onClearLogs?: () => void;
  onCollapse?: () => void;
}

export const ExecutionConsole: React.FC<ExecutionConsoleProps> = ({
  logs,
  activeCommand,
  activeWorkerName = 'Cursor Agent',
  isExecuting,
  modelConfig,
  onUpdateModelConfig,
  theme,
  onClearLogs,
  onCollapse,
}) => {
  const [activeTab, setActiveTab] = useState<WorkerTab>('all');
  const [copied, setCopied] = useState(false);

  // Filter logs by selected worker tab
  const filteredLogs = logs.filter((log) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'cursor') return log.workerTag === 'Cursor';
    if (activeTab === 'antigravity') return log.workerTag === 'Antigravity';
    if (activeTab === 'claude') return log.workerTag === 'Claude';
    if (activeTab === 'chatgpt') return log.workerTag === 'ChatGPT';
    return true;
  });

  const handleCopyLogs = () => {
    const text = filteredLogs.map((l) => `[${l.time}] [${l.workerTag}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`w-full h-full flex flex-col transition-colors overflow-hidden select-text ${
      theme === 'light' 
        ? 'bg-[#ffffff] text-[#1f1f1f]' 
        : 'bg-[#0d1117] border-[#1e293b] text-slate-200'
    }`}>
      {/* Top Header & Tab Strip */}
      <div className={`border-b select-none ${
        theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
      }`}>
        {/* Title Bar */}
        <div className="h-10 px-4 flex items-center justify-between border-b border-black/5 dark:border-white/5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
            <Terminal className="w-4 h-4 text-blue-600" />
            <span>底层执行体监控 (Live Worker Runner)</span>
            {isExecuting ? (
              <span className="flex items-center gap-1.5 text-[11px] font-sans font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-2.5 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                正在执行: {activeWorkerName}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
                待命中
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={handleCopyLogs}
              className={`p-1.5 rounded-lg border flex items-center gap-1 text-[11px] transition-colors ${
                theme === 'light'
                  ? 'bg-white hover:bg-slate-100 border-[#e3e3e3] text-slate-700'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
              }`}
              title="复制当前过滤日志"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>

            {onClearLogs && (
              <button
                onClick={onClearLogs}
                className={`p-1.5 rounded-lg border flex items-center gap-1 text-[11px] transition-colors ${
                  theme === 'light'
                    ? 'bg-white hover:bg-slate-100 border-[#e3e3e3] text-slate-700'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                }`}
                title="清空当前日志"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空</span>
              </button>
            )}

            {onCollapse && (
              <button
                onClick={onCollapse}
                className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 text-xs"
                title="收起执行栏"
              >
                收起
              </button>
            )}
          </div>
        </div>

        {/* Worker Tabs Strip (每个执行体一个Tab) */}
        <div className="flex items-center gap-1 px-3 py-1.5 overflow-x-auto text-xs">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1 rounded-full font-medium transition-all flex items-center gap-1.5 text-[11px] ${
              activeTab === 'all'
                ? theme === 'light'
                  ? 'bg-white text-blue-700 font-semibold shadow-xs border border-[#e3e3e3]'
                  : 'bg-slate-800 text-blue-400 font-semibold'
                : 'text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>全部汇总 ({logs.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('cursor')}
            className={`px-3 py-1 rounded-full font-medium transition-all flex items-center gap-1.5 text-[11px] ${
              activeTab === 'cursor'
                ? theme === 'light'
                  ? 'bg-white text-indigo-700 font-semibold shadow-xs border border-[#e3e3e3]'
                  : 'bg-slate-800 text-indigo-400 font-semibold'
                : 'text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-indigo-500" />
            <span>Cursor Agent</span>
            <span className="text-[10px] opacity-70 font-mono">
              ({logs.filter((l) => l.workerTag === 'Cursor').length})
            </span>
          </button>

          <button
            onClick={() => setActiveTab('antigravity')}
            className={`px-3 py-1 rounded-full font-medium transition-all flex items-center gap-1.5 text-[11px] ${
              activeTab === 'antigravity'
                ? theme === 'light'
                  ? 'bg-white text-purple-700 font-semibold shadow-xs border border-[#e3e3e3]'
                  : 'bg-slate-800 text-purple-400 font-semibold'
                : 'text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            <span>Antigravity</span>
            <span className="text-[10px] opacity-70 font-mono">
              ({logs.filter((l) => l.workerTag === 'Antigravity').length})
            </span>
          </button>

          <button
            onClick={() => setActiveTab('claude')}
            className={`px-3 py-1 rounded-full font-medium transition-all flex items-center gap-1.5 text-[11px] ${
              activeTab === 'claude'
                ? theme === 'light'
                  ? 'bg-white text-amber-700 font-semibold shadow-xs border border-[#e3e3e3]'
                  : 'bg-slate-800 text-amber-400 font-semibold'
                : 'text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span>Claude</span>
            <span className="text-[10px] opacity-70 font-mono">
              ({logs.filter((l) => l.workerTag === 'Claude').length})
            </span>
          </button>

          <button
            onClick={() => setActiveTab('chatgpt')}
            className={`px-3 py-1 rounded-full font-medium transition-all flex items-center gap-1.5 text-[11px] ${
              activeTab === 'chatgpt'
                ? theme === 'light'
                  ? 'bg-white text-teal-700 font-semibold shadow-xs border border-[#e3e3e3]'
                  : 'bg-slate-800 text-teal-400 font-semibold'
                : 'text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-teal-500" />
            <span>ChatGPT / Codex</span>
            <span className="text-[10px] opacity-70 font-mono">
              ({logs.filter((l) => l.workerTag === 'ChatGPT').length})
            </span>
          </button>
        </div>
      </div>

      {/* Model & Status Control Banner for Selected Tab */}
      <div className={`p-3 border-b text-xs select-none ${
        theme === 'light' ? 'bg-[#fcfdfe] border-[#e3e3e3]' : 'bg-[#121824] border-slate-800'
      }`}>
        {activeTab === 'cursor' && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-indigo-600 dark:text-indigo-400">🚀 Cursor Agent</span>
              <span className="text-[11px] text-slate-400 font-mono">/Users/jamesho/.local/bin/cursor</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">选择模型:</span>
              <select
                value={modelConfig.cursorModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, cursorModel: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="Sonnet 5.5">Sonnet 5.5 (推荐编码)</option>
                <option value="Claude 3.7 Sonnet">Claude 3.7 Sonnet</option>
                <option value="GPT-6">GPT-6</option>
                <option value="Cursor-Small">Cursor Small (极速)</option>
                <option value="Auto">Auto (自动选择)</option>
              </select>

              <select
                value={modelConfig.cursorThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, cursorThinking: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="高强度">高强度思考</option>
                <option value="标准">标准模式</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'antigravity' && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-purple-600 dark:text-purple-400">🪐 Antigravity</span>
              <span className="text-[11px] text-slate-400 font-mono">/Users/jamesho/.local/bin/agy (v1.4.12)</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">选择模型:</span>
              <select
                value={modelConfig.antigravityModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, antigravityModel: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="Gemini 2.5 Pro">Gemini 2.5 Pro (严谨架构与测试)</option>
                <option value="Gemini 2.5 Flash">Gemini 2.5 Flash (快速自愈)</option>
                <option value="Gemini 3.0 Flash">Gemini 3.0 Flash</option>
                <option value="Flash Lite">Flash Lite</option>
              </select>

              <select
                value={modelConfig.antigravityThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, antigravityThinking: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="深度思考">深度思考</option>
                <option value="快速模式">快速模式</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'claude' && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-amber-600 dark:text-amber-400">🧠 Claude</span>
              <span className="text-[11px] text-slate-400 font-mono">/Users/jamesho/.local/bin/claude</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">选择模型:</span>
              <select
                value={modelConfig.claudeModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeModel: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="Opus 5.5">Opus 5.5 (高阶日常与复杂设计)</option>
                <option value="Sonnet 5.5">Sonnet 5.5</option>
                <option value="Haiku 5.5">Haiku 5.5</option>
                <option value="Fable 5.1">Fable 5.1</option>
                <option value="Opus 5">Opus 5</option>
                <option value="Sonnet 5">Sonnet 5</option>
                <option value="Sonnet 4.6">Sonnet 4.6</option>
              </select>

              <select
                value={modelConfig.claudeThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeThinking: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="高">思考强度: 高</option>
                <option value="中">思考强度: 中</option>
                <option value="低">思考强度: 低</option>
                <option value="关闭">思考: 关闭</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'chatgpt' && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-teal-600 dark:text-teal-400">🛡️ ChatGPT / Codex</span>
              <span className="text-[11px] text-slate-400 font-mono">/opt/homebrew/bin/codex</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">选择模型:</span>
              <select
                value={modelConfig.chatgptModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptModel: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="GPT-6">GPT-6 (最新旗舰推理)</option>
                <option value="GPT-5.6 Sol">GPT-5.6 Sol</option>
                <option value="o3">o3</option>
                <option value="GPT-4.5">GPT-4.5</option>
              </select>

              <select
                value={modelConfig.chatgptThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptThinking: e.target.value })}
                className="px-2 py-0.5 rounded-lg border border-[#e3e3e3] dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
              >
                <option value="高">思考强度: 高</option>
                <option value="中">思考强度: 中</option>
                <option value="低">思考强度: 低</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'all' && (
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>
              汇总视图聚合显示全部 4 个协同体的实时通信流。点击上方单个 Tab 可分别查看并调整各 AI 的模型与思考级别。
            </span>
            {activeCommand && (
              <span className="font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950 px-2 py-0.5 rounded">
                {activeCommand}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Terminal Output Area */}
      <div className="flex-1 p-3 overflow-y-auto font-mono text-xs space-y-1.5 bg-[#ffffff] dark:bg-[#090d13] select-text">
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-1 select-none">
            <Terminal className="w-8 h-8 opacity-40 mb-1" />
            <p>该执行体暂无独立输出日志</p>
            <p className="text-[11px] text-slate-400">当下达执行指令后，终端流将在此处实时刷新。</p>
          </div>
        ) : (
          filteredLogs.map((log) => (
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

              {/* Executor Label Badge */}
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
    </div>
  );
};
