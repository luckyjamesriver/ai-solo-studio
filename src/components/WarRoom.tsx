import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, ProjectState } from '../types';
import { Send, User, Bot, Sparkles, AlertCircle, Terminal, HelpCircle } from 'lucide-react';

interface WarRoomProps {
  messages: ChatMessage[];
  projectState: ProjectState;
  onSendMessage: (text: string) => void;
}

export const WarRoom: React.FC<WarRoomProps> = ({
  messages,
  projectState,
  onSendMessage,
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

  const getAvatarIcon = (sender: ChatMessage['sender']) => {
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
    <div className="flex-1 flex flex-col h-full bg-[#0d1117] border-r border-[#30363d] overflow-hidden">
      {/* Subheader */}
      <div className="px-5 py-3 border-b border-[#30363d]/80 bg-[#161b22]/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            双脑战略研讨室 (War Room)
          </h2>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> Claude 3.7 (架构)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-teal-500" /> ChatGPT 4o (评审)
          </span>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 text-sm ${
              msg.sender === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            {msg.sender !== 'user' && (
              <div
                className={`w-8 h-8 rounded-lg ${msg.avatarColor} flex items-center justify-center shrink-0 shadow-sm mt-0.5`}
              >
                {getAvatarIcon(msg.sender)}
              </div>
            )}

            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-md ${
                msg.sender === 'user'
                  ? 'bg-blue-600 text-white rounded-tr-none'
                  : msg.sender === 'system'
                  ? 'bg-[#161b22] border border-blue-500/30 text-slate-200'
                  : msg.sender === 'worker'
                  ? 'bg-[#161b22] border border-purple-500/30 text-slate-200'
                  : 'bg-[#161b22] border border-[#30363d] text-slate-200 rounded-tl-none'
              }`}
            >
              {/* Header inside bubble */}
              <div className="flex items-center justify-between gap-4 mb-1.5 pb-1 border-b border-white/10 text-[11px]">
                <div className="flex items-center gap-1.5 font-medium opacity-90">
                  <span>{msg.senderName}</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/30 font-mono">
                    {msg.roleBadge}
                  </span>
                </div>
                <span className="text-[10px] opacity-50">{msg.timestamp}</span>
              </div>

              {/* Message text */}
              <div className="leading-relaxed whitespace-pre-wrap font-sans text-[13px] text-slate-200">
                {msg.content}
              </div>
            </div>

            {msg.sender === 'user' && (
              <div
                className={`w-8 h-8 rounded-lg ${msg.avatarColor} flex items-center justify-center shrink-0 shadow-sm mt-0.5`}
              >
                {getAvatarIcon(msg.sender)}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <div className="p-4 border-t border-[#30363d] bg-[#161b22]/70">
        {projectState === 'paused' && (
          <div className="mb-2 p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            <span>当前处于<strong>暂停干预模式</strong>。你输入的任何指令将直接重塑后续任务清单。</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              projectState === 'paused'
                ? '输入您的干预调整指令（例如：不要用某某库，换成轻量方案）...'
                : '用大白话输入你的新 Idea 或具体需求...'
            }
            className="flex-1 bg-[#0d1117] border border-[#30363d] focus:border-blue-500 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none transition-all"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 shadow-md shadow-blue-600/20 active:scale-95"
          >
            <Send className="w-4 h-4" />
            <span>发送</span>
          </button>
        </form>

        {/* Quick Suggestion Pills */}
        <div className="mt-2.5 flex items-center gap-2 overflow-x-auto text-[11px] text-slate-400">
          <span className="shrink-0 flex items-center gap-1 text-slate-500">
            <HelpCircle className="w-3 h-3" /> 灵感示例:
          </span>
          <button
            onClick={() => setInput('我想做一个极简的桌面多剪贴板历史记录工具')}
            className="shrink-0 px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-slate-300 transition-colors"
          >
            📋 桌面剪贴板工具
          </button>
          <button
            onClick={() => setInput('做一个自动化监控 GitHub 热门 AI 项目更新的 Python 脚本')}
            className="shrink-0 px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-slate-300 transition-colors"
          >
            🤖 GitHub 热门监控脚本
          </button>
          <button
            onClick={() => setInput('制作一个美观好用的个人 Markdown 知识卡片网页')}
            className="shrink-0 px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-slate-300 transition-colors"
          >
            📝 个人卡片笔记网页
          </button>
        </div>
      </div>
    </div>
  );
};
