import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, ProjectState, DialogueTarget, ModelConfig, DiscoveredModelsMap } from '../types';
import { 
  Send, 
  User, 
  Sparkles, 
  Bot, 
  Terminal, 
  AlertCircle, 
  FileText, 
  ArrowUpRight,
  Users2,
  Cpu,
  SlidersHorizontal,
  ChevronDown
} from 'lucide-react';

interface WarRoomProps {
  messages: ChatMessage[];
  projectState: ProjectState;
  onSendMessage: (text: string, target: DialogueTarget) => void;
  onOpenDoc: (docId: string) => void;
  modelConfig: ModelConfig;
  onUpdateModelConfig: (cfg: ModelConfig) => void;
  discoveredModels?: DiscoveredModelsMap;
  theme: 'light' | 'dark';
}

export const WarRoom: React.FC<WarRoomProps> = ({
  messages,
  projectState,
  onSendMessage,
  onOpenDoc,
  modelConfig,
  onUpdateModelConfig,
  discoveredModels,
  theme,
}) => {
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<DialogueTarget>('all_pms');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim(), target);
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
    <div className={`w-full h-full flex flex-col transition-colors overflow-hidden select-text ${
      theme === 'light' 
        ? 'bg-[#f0f4f9] text-[#1f1f1f]' 
        : 'bg-[#0e131d] border-[#1e293b] text-slate-200'
    }`}>
      {/* Subheader */}
      <div className={`px-5 py-3 border-b flex items-center justify-between text-xs select-none ${
        theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
      }`}>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
          <span className="font-semibold text-[#1f1f1f] dark:text-slate-300">
            多 AI 对话总线 (War Room)
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[#444746] dark:text-slate-400">
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white dark:bg-slate-800 border border-[#e3e3e3] dark:border-slate-700 shadow-xs">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> Claude ({modelConfig.claudeModel})
          </span>
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white dark:bg-slate-800 border border-[#e3e3e3] dark:border-slate-700 shadow-xs">
            <span className="w-2 h-2 rounded-full bg-teal-500" /> ChatGPT ({modelConfig.chatgptModel})
          </span>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.sender === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            {/* Forwarded Header (e.g. "由 ChatGPT 从另一个聊天发送") */}
            {msg.forwardedFrom && (
              <div className="text-[11px] text-[#444746] dark:text-slate-400 mb-1.5 flex items-center gap-1.5 font-medium px-2">
                <Bot className="w-3.5 h-3.5 text-teal-600" />
                <span>{msg.forwardedFrom}</span>
              </div>
            )}

            <div className={`flex gap-3 max-w-[95%] ${
              msg.sender === 'user' ? 'flex-row-reverse' : 'flex-row'
            }`}>
              {/* Avatar */}
              <div
                className={`w-8 h-8 rounded-full ${msg.avatarColor} flex items-center justify-center shrink-0 shadow-sm mt-0.5`}
              >
                {getAvatar(msg.sender)}
              </div>

              {/* Bubble Content (Gemini Style) */}
              <div
                className={`rounded-2xl p-4 shadow-sm text-xs leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-[#e9eef6] text-[#1f1f1f] border border-blue-200/60 rounded-tr-none'
                    : theme === 'light'
                    ? 'bg-white border border-[#e3e3e3] text-[#1f1f1f] rounded-tl-none shadow-[0_1px_3px_rgba(0,0,0,0.04)]'
                    : 'bg-[#161f30] border border-slate-700 text-slate-200 rounded-tl-none'
                }`}
              >
                {/* Sender Title, Role, and Model & Thinking Badges */}
                {msg.sender !== 'user' && (
                  <div className="flex items-center justify-between gap-3 mb-2 pb-1.5 border-b border-black/5 dark:border-white/10 text-[11px] text-[#444746] dark:text-slate-400 font-medium">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{msg.senderName}</span>
                      <span className="text-[10px] px-2 py-0.2 rounded-full bg-slate-100 dark:bg-slate-800 font-sans border border-slate-200/60 dark:border-slate-700">
                        {msg.roleBadge}
                      </span>
                      {msg.modelUsed && (
                        <span className="text-[10px] px-2 py-0.2 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-mono border border-blue-200 dark:border-blue-800">
                          {msg.modelUsed}
                        </span>
                      )}
                      {msg.thinkingLevel && (
                        <span className="text-[10px] px-2 py-0.2 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 font-mono border border-amber-200 dark:border-amber-800">
                          {msg.thinkingLevel}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] opacity-70 shrink-0">{msg.timestamp}</span>
                  </div>
                )}

                {/* Text Content */}
                <div className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                  {msg.content}
                </div>

                {/* Linked Canvas Document Preview Card */}
                {msg.linkedDocId && (
                  <div
                    onClick={() => onOpenDoc(msg.linkedDocId!)}
                    className={`mt-3.5 p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition-all ${
                      theme === 'light'
                        ? 'bg-blue-50/50 hover:bg-blue-50 border-blue-100 text-blue-900'
                        : 'bg-blue-950/20 hover:bg-blue-950/40 border-blue-900/60 text-blue-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-blue-600 shrink-0" />
                      <span className="font-medium truncate text-xs">
                        {msg.docPreviewTitle || '查看详细规范文档'}
                      </span>
                    </div>
                    <span className="text-[10px] px-2.5 py-1 rounded-full bg-white dark:bg-slate-800 border border-blue-200 text-blue-700 font-semibold shrink-0 flex items-center gap-1 shadow-xs">
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

      {/* Target Selector & Model Selector & Input Box Area */}
      <div className={`p-4 border-t select-none space-y-2.5 ${
        theme === 'light' ? 'border-[#e3e3e3] bg-[#f0f4f9]' : 'border-slate-800 bg-[#161b22]'
      }`}>
        {/* Recipient Target Selector */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] text-[#444746] py-0.5">
          <span className="text-slate-400 shrink-0 flex items-center gap-1">
            <Users2 className="w-3.5 h-3.5" /> 沟通受话方:
          </span>

          <button
            type="button"
            onClick={() => setTarget('all_pms')}
            className={`shrink-0 px-3 py-1 rounded-full border transition-all text-xs flex items-center gap-1 ${
              target === 'all_pms'
                ? 'bg-blue-600 text-white border-blue-600 font-semibold shadow-xs'
                : 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-slate-700'
            }`}
          >
            <Sparkles className="w-3 h-3 text-amber-300" />
            <span>联合司令部 (Claude策划 + GPT评审)</span>
          </button>

          <button
            type="button"
            onClick={() => setTarget('claude')}
            className={`shrink-0 px-2.5 py-1 rounded-full border transition-all text-xs flex items-center gap-1 ${
              target === 'claude'
                ? 'bg-amber-600 text-white border-amber-600 font-semibold shadow-xs'
                : 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-slate-700'
            }`}
          >
            <span>🧠 仅找 Claude</span>
          </button>

          <button
            type="button"
            onClick={() => setTarget('chatgpt')}
            className={`shrink-0 px-2.5 py-1 rounded-full border transition-all text-xs flex items-center gap-1 ${
              target === 'chatgpt'
                ? 'bg-teal-600 text-white border-teal-600 font-semibold shadow-xs'
                : 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-slate-700'
            }`}
          >
            <span>🛡️ 仅找 ChatGPT</span>
          </button>

          <button
            type="button"
            onClick={() => setTarget('cursor')}
            className={`shrink-0 px-2.5 py-1 rounded-full border transition-all text-xs flex items-center gap-1 ${
              target === 'cursor'
                ? 'bg-indigo-600 text-white border-indigo-600 font-semibold shadow-xs'
                : 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-slate-700'
            }`}
          >
            <span>🚀 直通 Cursor</span>
          </button>

          <button
            type="button"
            onClick={() => setTarget('antigravity')}
            className={`shrink-0 px-2.5 py-1 rounded-full border transition-all text-xs flex items-center gap-1 ${
              target === 'antigravity'
                ? 'bg-purple-600 text-white border-purple-600 font-semibold shadow-xs'
                : 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-slate-700'
            }`}
          >
            <span>🪐 直通 Antigravity</span>
          </button>
        </div>

        {/* Dynamic Model & Thinking Level Selector Bar (对话时的模型与级别出口) */}
        <div className="flex items-center gap-2 text-[11px] bg-white dark:bg-[#121824] p-2 rounded-xl border border-[#e3e3e3] dark:border-slate-800 shadow-2xs overflow-x-auto">
          <span className="text-slate-400 shrink-0 flex items-center gap-1">
            <SlidersHorizontal className="w-3.5 h-3.5 text-blue-600" /> 当前模型与思考级别:
          </span>

          {target === 'all_pms' && (
            <div className="flex items-center gap-3 flex-wrap">
              {/* Claude Settings */}
              <div className="flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-lg border border-amber-200 dark:border-amber-800">
                <span className="font-semibold text-amber-700 dark:text-amber-400">Claude:</span>
                <select
                  value={modelConfig.claudeModel}
                  onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeModel: e.target.value })}
                  className="bg-transparent text-amber-900 dark:text-amber-200 font-medium focus:outline-none cursor-pointer"
                >
                  <option value="Opus 5.5">Opus 5.5</option>
                  <option value="Sonnet 5.5">Sonnet 5.5</option>
                  <option value="Haiku 5.5">Haiku 5.5</option>
                  <option value="Fable 5.1">Fable 5.1</option>
                  <option value="Opus 5">Opus 5</option>
                  <option value="Sonnet 5">Sonnet 5</option>
                  <option value="Sonnet 4.6">Sonnet 4.6</option>
                </select>
                <span className="text-amber-300">|</span>
                <select
                  value={modelConfig.claudeThinking}
                  onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeThinking: e.target.value })}
                  className="bg-transparent text-amber-900 dark:text-amber-200 font-medium focus:outline-none cursor-pointer"
                >
                  <option value="高">思考: 高</option>
                  <option value="中">思考: 中</option>
                  <option value="低">思考: 低</option>
                  <option value="关闭">思考: 关闭</option>
                </select>
              </div>

              {/* ChatGPT Settings */}
              <div className="flex items-center gap-1.5 bg-teal-50 dark:bg-teal-950/40 px-2 py-0.5 rounded-lg border border-teal-200 dark:border-teal-800">
                <span className="font-semibold text-teal-700 dark:text-teal-400">ChatGPT:</span>
                <select
                  value={modelConfig.chatgptModel}
                  onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptModel: e.target.value })}
                  className="bg-transparent text-teal-900 dark:text-teal-200 font-medium focus:outline-none cursor-pointer"
                >
                  {(discoveredModels?.codex || [
                    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
                    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
                    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
                  ]).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <span className="text-teal-300">|</span>
                <select
                  value={modelConfig.chatgptThinking}
                  onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptThinking: e.target.value })}
                  className="bg-transparent text-teal-900 dark:text-teal-200 font-medium focus:outline-none cursor-pointer"
                >
                  <option value="高">思考: 高</option>
                  <option value="中">思考: 中</option>
                  <option value="低">思考: 低</option>
                </select>
              </div>
            </div>
          )}

          {target === 'claude' && (
            <div className="flex items-center gap-2">
              <span className="text-amber-700 dark:text-amber-400 font-semibold">Claude 模型:</span>
              <select
                value={modelConfig.claudeModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeModel: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                {(discoveredModels?.claude || [
                  { id: 'Opus 5.5', name: 'Opus 5.5 (高阶日常与复杂设计)' },
                  { id: 'Sonnet 5.5', name: 'Sonnet 5.5 (主力编码)' },
                  { id: 'Haiku 5.5', name: 'Haiku 5.5 (极速响应)' },
                  { id: 'Fable 5.1', name: 'Fable 5.1' },
                ]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              <span className="text-slate-400">思考强度:</span>
              <select
                value={modelConfig.claudeThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, claudeThinking: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                <option value="高">高 (深度推理)</option>
                <option value="中">中 (标准思考)</option>
                <option value="低">低 (快速响应)</option>
                <option value="关闭">关闭 (直接输出)</option>
              </select>
            </div>
          )}

          {target === 'chatgpt' && (
            <div className="flex items-center gap-2">
              <span className="text-teal-700 dark:text-teal-400 font-semibold">ChatGPT / Codex 模型:</span>
              <select
                value={modelConfig.chatgptModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptModel: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                {(discoveredModels?.codex || [
                  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
                  { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
                  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
                  { id: 'gpt-6-sol', name: 'GPT-6-Sol' },
                  { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
                  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
                ]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              <span className="text-slate-400">思考强度:</span>
              <select
                value={modelConfig.chatgptThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, chatgptThinking: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                <option value="高">高 (深层风控把关)</option>
                <option value="中">中 (标准核验)</option>
                <option value="低">低 (快速核查)</option>
              </select>
            </div>
          )}

          {target === 'cursor' && (
            <div className="flex items-center gap-2">
              <span className="text-indigo-700 dark:text-indigo-400 font-semibold">Cursor 模型:</span>
              <select
                value={modelConfig.cursorModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, cursorModel: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                {(discoveredModels?.cursor || [
                  { id: 'auto', name: 'Auto (Default)' },
                  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 1M High' },
                  { id: 'claude-sonnet-5-thinking-high', name: 'Claude Sonnet 5 1M Thinking' },
                  { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol 1M High' },
                ]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              <span className="text-slate-400">级别:</span>
              <select
                value={modelConfig.cursorThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, cursorThinking: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                <option value="高强度">高强度思考</option>
                <option value="标准">标准模式</option>
              </select>
            </div>
          )}

          {target === 'antigravity' && (
            <div className="flex items-center gap-2">
              <span className="text-purple-700 dark:text-purple-400 font-semibold">Antigravity 模型:</span>
              <select
                value={modelConfig.antigravityModel}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, antigravityModel: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                {(discoveredModels?.antigravity || [
                  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
                  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
                  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
                  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
                  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
                  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
                ]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              <span className="text-slate-400">级别:</span>
              <select
                value={modelConfig.antigravityThinking}
                onChange={(e) => onUpdateModelConfig({ ...modelConfig, antigravityThinking: e.target.value })}
                className="px-2 py-0.5 rounded border border-slate-200 bg-white dark:bg-slate-800 dark:border-slate-700 text-xs font-medium focus:outline-none"
              >
                <option value="深度思考">深度思考 (High)</option>
                <option value="标准推理">标准推理 (Medium)</option>
                <option value="快速响应">快速响应 (Low)</option>
              </select>
            </div>
          )}
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="relative flex items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              target === 'all_pms'
                ? `向【联合司令部】提出需求（Claude[${modelConfig.claudeModel}]架构规划，ChatGPT[${modelConfig.chatgptModel}]风险审阅）...`
                : target === 'claude'
                ? `向【Claude 架构师 (${modelConfig.claudeModel})】咨询系统方案与设计思考...`
                : target === 'chatgpt'
                ? `向【ChatGPT 评审员 (${modelConfig.chatgptModel})】咨询逻辑审阅与漏洞排查...`
                : target === 'cursor'
                ? `向【Cursor Agent (${modelConfig.cursorModel})】直接下达编码指令...`
                : `向【Antigravity (${modelConfig.antigravityModel})】下达构建测试或自动化任务...`
            }
            className={`w-full rounded-full py-3 pl-5 pr-14 text-xs shadow-[0_2px_8px_rgba(0,0,0,0.06)] border focus:outline-none transition-all ${
              theme === 'light'
                ? 'bg-white border-[#e3e3e3] focus:border-blue-500 text-[#1f1f1f] placeholder-slate-400'
                : 'bg-[#090d13] border-slate-700 focus:border-blue-500 text-slate-100 placeholder-slate-500'
            }`}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="absolute right-1.5 p-2 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white transition-all shadow-sm active:scale-95"
            title="发送"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>

        {/* Quick Suggestion Pills */}
        <div className="flex items-center gap-2 overflow-x-auto text-[11px] text-[#444746]">
          <span className="shrink-0 text-slate-400">💡 示例:</span>
          <button
            type="button"
            onClick={() => setInput('我想做一个极简的桌面多剪贴板历史记录工具')}
            className={`shrink-0 px-3 py-0.5 rounded-full border transition-all text-xs ${
              theme === 'light'
                ? 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-[#1f1f1f] shadow-xs'
                : 'bg-[#21262d] hover:bg-slate-700 border-slate-700 text-slate-300'
            }`}
          >
            📋 桌面剪贴板工具
          </button>
          <button
            type="button"
            onClick={() => setInput('生成一个自动抓取并整理科技快讯的脚本')}
            className={`shrink-0 px-3 py-0.5 rounded-full border transition-all text-xs ${
              theme === 'light'
                ? 'bg-white hover:bg-[#dfe3e7] border-[#e3e3e3] text-[#1f1f1f] shadow-xs'
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
