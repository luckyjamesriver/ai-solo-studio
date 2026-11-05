import React, { useState } from 'react';
import { 
  X, 
  Sparkles, 
  Bot, 
  CheckCircle2, 
  Settings2,
  Terminal,
  Cpu
} from 'lucide-react';
import { RoleAssignment } from '../types';

interface AccountBridgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: {
    claude: boolean;
    chatgpt: boolean;
  };
  roles: RoleAssignment;
  onUpdateRoles: (newRoles: RoleAssignment) => void;
  onConnect: (provider: 'claude' | 'chatgpt') => void;
  theme: 'light' | 'dark';
}

export const AccountBridgeModal: React.FC<AccountBridgeModalProps> = ({
  isOpen,
  onClose,
  roles,
  onUpdateRoles,
  theme,
}) => {
  const [currentRoles, setCurrentRoles] = useState<RoleAssignment>(roles);

  if (!isOpen) return null;

  const handleSave = () => {
    onUpdateRoles(currentRoles);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs select-none">
      <div className={`w-full max-w-2xl rounded-3xl border shadow-2xl overflow-hidden transition-all ${
        theme === 'light' 
          ? 'bg-white border-[#e3e3e3] text-[#1f1f1f]' 
          : 'bg-[#161b22] border-slate-700 text-slate-100'
      }`}>
        {/* Modal Header */}
        <div className={`px-6 py-4 border-b flex items-center justify-between ${
          theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#1c2128] border-slate-800'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-blue-600/10 flex items-center justify-center text-blue-600">
              <Settings2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">多 AI 协同舰队连接与席位设置</h2>
              <p className="text-[11px] text-[#444746] dark:text-slate-400">
                显示各 AI 的本地连接状态与分工席位（具体模型与思考级别可在对话/执行界面随时切换）
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body: 4 AI Roster Cards */}
        <div className="p-6 space-y-3.5 text-xs max-h-[70vh] overflow-y-auto">
          {/* AI 1: Claude */}
          <div className={`p-4 rounded-2xl border transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 shrink-0 mt-0.5">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Claude</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold flex items-center gap-0.5">
                      <CheckCircle2 className="w-3 h-3" /> 已连接 (Pro / Max 订阅)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    路径: /Users/jamesho/.local/bin/claude
                  </p>
                </div>
              </div>

              {/* Role Dropdown */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] text-slate-400">设定团队席位:</span>
                <select
                  value={currentRoles.claudeRole}
                  onChange={(e) => setCurrentRoles({ ...currentRoles, claudeRole: e.target.value })}
                  className="px-2.5 py-1 rounded-lg border border-[#e3e3e3] bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="首席架构师">🧠 首席架构师 (规划与模块拆解)</option>
                  <option value="技术评审与风控">🛡️ 技术评审与风控</option>
                  <option value="编码主力">🚀 编码主力</option>
                  <option value="质量总监">🪐 质量总监</option>
                </select>
              </div>
            </div>
          </div>

          {/* AI 2: ChatGPT / Codex */}
          <div className={`p-4 rounded-2xl border transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-600 shrink-0 mt-0.5">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">ChatGPT / Codex</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold flex items-center gap-0.5">
                      <CheckCircle2 className="w-3 h-3" /> 已连接 (Plus / Pro 订阅)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    路径: /opt/homebrew/bin/codex
                  </p>
                </div>
              </div>

              {/* Role Dropdown */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] text-slate-400">设定团队席位:</span>
                <select
                  value={currentRoles.chatgptRole}
                  onChange={(e) => setCurrentRoles({ ...currentRoles, chatgptRole: e.target.value })}
                  className="px-2.5 py-1 rounded-lg border border-[#e3e3e3] bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="技术评审 & 风控">🛡️ 技术评审 & 风控 (审查与把关)</option>
                  <option value="首席架构师">🧠 首席架构师</option>
                  <option value="编码主力">🚀 编码主力</option>
                  <option value="质量总监">🪐 质量总监</option>
                </select>
              </div>
            </div>
          </div>

          {/* AI 3: Cursor Agent */}
          <div className={`p-4 rounded-2xl border transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                  <Terminal className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Cursor Agent</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold flex items-center gap-0.5">
                      <CheckCircle2 className="w-3 h-3" /> 本地 CLI 就绪
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    路径: /Users/jamesho/.local/bin/cursor
                  </p>
                </div>
              </div>

              {/* Role Dropdown */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] text-slate-400">设定团队席位:</span>
                <select
                  value={currentRoles.cursorRole}
                  onChange={(e) => setCurrentRoles({ ...currentRoles, cursorRole: e.target.value })}
                  className="px-2.5 py-1 rounded-lg border border-[#e3e3e3] bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="编码主力">🚀 编码主力 (写代码、改文件、搭脚手架)</option>
                  <option value="辅助重构">🛠️ 辅助重构</option>
                  <option value="质量与测试">🪐 质量与测试</option>
                </select>
              </div>
            </div>
          </div>

          {/* AI 4: Antigravity */}
          <div className={`p-4 rounded-2xl border transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-600 shrink-0 mt-0.5">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Antigravity</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold flex items-center gap-0.5">
                      <CheckCircle2 className="w-3 h-3" /> 本地 CLI 就绪
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    路径: /Users/jamesho/.local/bin/agy (v1.4.12)
                  </p>
                </div>
              </div>

              {/* Role Dropdown */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] text-slate-400">设定团队席位:</span>
                <select
                  value={currentRoles.antigravityRole}
                  onChange={(e) => setCurrentRoles({ ...currentRoles, antigravityRole: e.target.value })}
                  className="px-2.5 py-1 rounded-lg border border-[#e3e3e3] bg-white dark:bg-slate-800 text-xs font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="质量总监 & 自动化">🪐 质量总监 & 自动化 (测试验收、自愈纠错)</option>
                  <option value="全流程调度管家">⚡ 全流程调度管家</option>
                  <option value="编码主力">🚀 编码主力</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className={`px-6 py-3.5 border-t flex items-center justify-between text-xs ${
          theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#1c2128] border-slate-800'
        }`}>
          <div className="text-[11px] text-[#444746] dark:text-slate-400">
            🔒 全程直连本地已验证 CLI，0 额外 Token 费用
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-5 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-xs transition-colors"
            >
              保存设定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
