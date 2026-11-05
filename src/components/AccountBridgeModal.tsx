import React from 'react';
import { 
  X, 
  ShieldCheck, 
  Sparkles, 
  Bot, 
  CheckCircle2, 
  ExternalLink, 
  Lock,
  Zap
} from 'lucide-react';

interface AccountBridgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: {
    claude: boolean;
    chatgpt: boolean;
  };
  onConnect: (provider: 'claude' | 'chatgpt') => void;
  theme: 'light' | 'dark';
}

export const AccountBridgeModal: React.FC<AccountBridgeModalProps> = ({
  isOpen,
  onClose,
  accounts,
  onConnect,
  theme,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs select-none">
      <div className={`w-full max-w-lg rounded-3xl border shadow-2xl overflow-hidden transition-all ${
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
              <Zap className="w-4 h-4 fill-current" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">AI 官方网页订阅连接中心</h2>
              <p className="text-[11px] text-[#444746] dark:text-slate-400">直连你的现成会员，0 额外 Token 费用</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-4 text-xs">
          {/* Security Banner */}
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 flex items-start gap-2.5 text-emerald-800 dark:text-emerald-300">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="leading-relaxed text-[11px]">
              <strong>安全沙箱承诺</strong>：登录凭证（Session）保存在你本地电脑的独立持久化加密目录中，<strong>绝不上云、不经第三方服务器</strong>，安全直通官方。
            </div>
          </div>

          {/* Account 1: Claude.ai */}
          <div className={`p-4 rounded-2xl border flex items-center justify-between gap-4 transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 shrink-0">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">Claude.ai</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 font-medium">
                    Pro / Team 会员
                  </span>
                </div>
                <p className="text-[11px] text-[#444746] dark:text-slate-400 mt-0.5">
                  充当【首席架构师】，负责高维逻辑推演与深度思考。
                </p>
              </div>
            </div>

            <div>
              {accounts.claude ? (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 font-semibold text-xs border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 已连接
                </div>
              ) : (
                <button
                  onClick={() => onConnect('claude')}
                  className="px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs flex items-center gap-1.5 shadow-sm active:scale-95 transition-all"
                >
                  <span>立即连接</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Account 2: ChatGPT.com */}
          <div className={`p-4 rounded-2xl border flex items-center justify-between gap-4 transition-all ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#0d1117] border-slate-800'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-600 shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">ChatGPT.com</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-100 dark:bg-teal-950/60 text-teal-700 dark:text-teal-400 font-medium">
                    Plus 会员
                  </span>
                </div>
                <p className="text-[11px] text-[#444746] dark:text-slate-400 mt-0.5">
                  充当【技术评审 & 风控】，负责找漏洞、工单拆解。
                </p>
              </div>
            </div>

            <div>
              {accounts.chatgpt ? (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 font-semibold text-xs border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 已连接
                </div>
              ) : (
                <button
                  onClick={() => onConnect('chatgpt')}
                  className="px-4 py-2 rounded-full bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs flex items-center gap-1.5 shadow-sm active:scale-95 transition-all"
                >
                  <span>立即连接</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className={`px-6 py-4 border-t flex items-center justify-between text-[11px] ${
          theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3] text-[#444746]' : 'bg-[#1c2128] border-slate-800 text-slate-400'
        }`}>
          <div className="flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            <span>只需登录一次，下次打开自动恢复连接</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-full bg-white dark:bg-slate-700 border border-[#e3e3e3] dark:border-slate-600 hover:bg-slate-100 font-medium text-xs text-[#1f1f1f] dark:text-white transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
