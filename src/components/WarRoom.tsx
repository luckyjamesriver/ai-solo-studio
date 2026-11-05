import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, ProjectState } from '../types';
import { 
  Send, 
  User, 
  Sparkles, 
  Bot, 
  Terminal, 
  AlertCircle, 
  HelpCircle, 
  FileText, 
  ArrowUpRight,
  ExternalLink
} from 'lucide-react';

interface WarRoomProps {
  messages: ChatMessage[];
  projectState: ProjectState;
  onSendMessage: (text: string) => void;
  onOpenDoc: (docId: string) => void;
  theme: 'light' | 'dark';
}

export const WarRoom: React.FC<WarRoomProps> = ({
  messages,
  projectState,
  onSendMessage,
  onOpenDoc,
  theme,
}) => {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const getAvatar = (sender: ChatMessage['sender']) => {
    switch (sender) {
      case 'user':
        return <User className="w-4 h-4 text-white" />;
      case 'claude':
        return <Sparkles className="w-4 h-4 text-white" />;
      case 'chatgpt':
        return <Bot className="w-4 h-4 text-white" />;
      case 'worker':
        return <Terminal className="w-4 h-4 text-white" />;
      default:
        return <AlertCircle className="w-4 h-4 text-white" />;
    }
  };

  return (
    <div className={`w-[480px] shrink-0 flex flex-col h-full border-r transition-colors overflow-hidden select-text ${
      theme === 'light' 
        ? 'bg-[#ffffff] border-slate-200 text-slate-800' 
        : 'bg-[#0e131d] border-[#1e293b] text-slate-200'
    }`}>
      {/* Subheader */}
      <div className={`px-4 py-2.5 border-b flex items-center justify-between text-xs select-none ${
        theme === 'light' ? 'bg-[#f8fafc] border-slate-200' : 'bg-[#161b22] border-slate-800'
      }`}>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            双脑磋商对话流
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> Claude
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-teal-500" /> ChatGPT
          </span>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.sender === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            {/* Forwarded Header (Matching screenshot: "由 ChatGPT 从另一个聊天发送") */}
            {msg.forwardedFrom && (
              <div className="text-[10px] text-slate-400 mb-1 flex items-center gap-1 font-mono">
                <Bot className="w-3 h-3 text-slate-400" />
                <span>{msg.forwardedFrom}</span>
              </div>
            )}

            <div className={`flex gap-2.5 max-w-[95%] ${
              msg.sender === 'user' ? 'flex-row-reverse' : 'flex-row'
            }`}>
              {/* Avatar */}
              <div
                className={`w-7 h-7 rounded-lg ${msg.avatarColor} flex items-center justify-center shrink-0 shadow-sm mt-0.5`}
              >
                {getAvatar(msg.sender)}
              </div>

              {/* Bubble Content */}
              <div
                className={`rounded-2xl p-3.5 shadow-sm text-xs leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-none'
                    : theme === 'light'
                    ? 'bg-[#f8fafc] border border-slate-200 text-slate-800 rounded-tl-none'
                    : 'bg-[#161f30] border border-slate-700 text-slate-200 rounded-tl-none'
                }`}
              >
                {/* Sender Title */}
                {msg.sender !== 'user' && (
                  <div className="flex items-center justify-between gap-3 mb-1.5 pb-1 border-b border-black/5 dark:border-white/10 text-[11px] opacity-80 font-medium">
                    <span>{msg.senderName}</span>
                    <span className="font-mono text-[10px] opacity-60">{msg.timestamp}</span>
                  </div>
                )}

                {/* Text Content */}
                <div className="whitespace-pre-wrap font-sans">
                  {msg.content}
                </div>

                {/* Linked Document Card (Matching Screenshot: Click to open in Right Canvas) */}
                {msg.linkedDocId && (
                  <div
                    onClick={() => onOpenDoc(msg.linkedDocId!)}
                    className={`mt-2.5 p-2 rounded-xl border flex items-center justify-between gap-2 cursor-pointer transition-all ${
                      theme === 'light'
                        ? 'bg-white hover:bg-blue-50/60 border-blue-200 text-blue-700 shadow-sm'
                        : 'bg-[#0d1117] hover:bg-blue-950/40 border-blue-500/40 text-blue-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                      <span className="font-medium truncate text-[11px]">
                        {msg.docPreviewTitle || '查看详细规范文档'}
                      </span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 font-semibold shrink-0 flex items-center gap-0.5">
                      右侧研读 <ArrowUpRight className="w-3 h-3" />
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <div className={`p-3 border-t select-none ${
        theme === 'light' ? 'border-slate-200 bg-[#f8fafc]' : 'border-slate-800 bg-[#161b22]'
      }`}>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              projectState === 'paused'
                ? '已暂停：输入干预调整指令...'
                : '用大白话输入你的新需求或任务想法...'
            }
            className={`flex-1 border rounded-xl px-3.5 py-2 text-xs focus:outline-none transition-all ${
              theme === 'light'
                ? 'bg-white border-slate-300 focus:border-blue-500 text-slate-800 placeholder-slate-400'
                : 'bg-[#090d13] border-slate-700 focus:border-blue-500 text-slate-100 placeholder-slate-500'
            }`}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1 shadow-sm shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>发送</span>
          </button>
        </form>

        {/* Quick Suggestions */}
        <div className="mt-2 flex items-center gap-1.5 overflow-x-auto text-[10px] text-slate-400">
          <span className="shrink-0 text-slate-400">💡 示例:</span>
          <button
            type="button"
            onClick={() => setInput('我想做一个极简的桌面多剪贴板历史记录工具')}
            className={`shrink-0 px-2 py-0.5 rounded border transition-colors ${
              theme === 'light'
                ? 'bg-white hover:bg-slate-100 border-slate-200 text-slate-600'
                : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-300'
            }`}
          >
            📋 桌面剪贴板工具
          </button>
          <button
            type="button"
            onClick={() => setInput('生成一个自动抓取并整理科技快讯的脚本')}
            className={`shrink-0 px-2 py-0.5 rounded border transition-colors ${
              theme === 'light'
                ? 'bg-white hover:bg-slate-100 border-slate-200 text-slate-600'
                : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-300'
            }`}
          >
            🤖 科技快讯整理
          </button>
        </div>
      </div>
    </div>
  );
};
