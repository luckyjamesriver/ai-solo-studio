import React, { useState } from 'react';
import { 
  CanvasDocument 
} from '../types';
import { 
  X, 
  Copy, 
  Check, 
  Code, 
  FileText, 
  GitCompare
} from 'lucide-react';

interface CanvasProps {
  documents: CanvasDocument[];
  activeDocId: string;
  onSelectDoc: (id: string) => void;
  onCloseDoc: (id: string) => void;
  theme: 'light' | 'dark';
}

export const Canvas: React.FC<CanvasProps> = ({
  documents,
  activeDocId,
  onSelectDoc,
  onCloseDoc,
  theme,
}) => {
  const [viewMode, setViewMode] = useState<'preview' | 'diff' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const activeDoc = documents.find((d) => d.id === activeDocId) || documents[0];

  const handleCopy = () => {
    if (!activeDoc) return;
    navigator.clipboard.writeText(activeDoc.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!activeDoc) {
    return (
      <div className={`flex-1 flex flex-col items-center justify-center select-none text-slate-400 p-8 ${
        theme === 'light' ? 'bg-[#ffffff]' : 'bg-[#0b0f17]'
      }`}>
        <FileText className="w-12 h-12 stroke-[1.2] mb-3 text-slate-300" />
        <p className="text-sm font-medium text-slate-500">画布暂无打开的内容</p>
        <p className="text-xs text-slate-400 mt-1">在左侧对话中点击方案、代码或任务详情，即可在此处研读与编辑。</p>
      </div>
    );
  }

  return (
    <div className={`w-full h-full flex flex-col transition-colors overflow-hidden select-text ${
      theme === 'light' 
        ? 'bg-[#ffffff] text-[#1f1f1f]' 
        : 'bg-[#0d1117] border-[#1e293b] text-slate-200'
    }`}>
      {/* Top Tabs Bar (Gemini Style) */}
      <div className={`h-11 px-3 border-b flex items-center justify-between select-none gap-2 ${
        theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
      }`}>
        {/* Document Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1 h-full py-1">
          {documents.map((doc) => {
            const isActive = doc.id === activeDoc.id;
            return (
              <div
                key={doc.id}
                onClick={() => onSelectDoc(doc.id)}
                className={`h-7 px-3 rounded-full flex items-center gap-1.5 text-xs font-mono cursor-pointer shrink-0 transition-all ${
                  isActive
                    ? theme === 'light'
                      ? 'bg-white text-blue-700 font-semibold shadow-xs border border-[#e3e3e3]'
                      : 'bg-[#0d1117] border border-blue-500 text-white font-semibold'
                    : theme === 'light'
                    ? 'text-[#444746] hover:bg-[#dfe3e7]'
                    : 'text-slate-400 hover:bg-slate-800'
                }`}
              >
                <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span className="truncate max-w-[140px]">{doc.title}</span>
                {documents.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseDoc(doc.id);
                    }}
                    className="p-0.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Action Buttons Toolbar */}
        <div className="flex items-center gap-1 text-xs shrink-0 whitespace-nowrap">
          <button
            onClick={() => setViewMode(viewMode === 'diff' ? 'preview' : 'diff')}
            className={`px-2.5 py-1 rounded-full border flex items-center gap-1 text-[11px] font-medium transition-all shadow-xs shrink-0 whitespace-nowrap ${
              viewMode === 'diff'
                ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-300'
                : theme === 'light'
                ? 'bg-white border-[#e3e3e3] hover:bg-[#dfe3e7] text-[#1f1f1f]'
                : 'bg-[#21262d] border-slate-700 hover:bg-slate-800 text-slate-300'
            }`}
            title="显示差异对比"
          >
            <GitCompare className="w-3 h-3 shrink-0" />
            <span>对比</span>
          </button>

          <button
            onClick={() => setViewMode(viewMode === 'source' ? 'preview' : 'source')}
            className={`px-2.5 py-1 rounded-full border flex items-center gap-1 text-[11px] font-medium transition-all shadow-xs shrink-0 whitespace-nowrap ${
              viewMode === 'source'
                ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-300'
                : theme === 'light'
                ? 'bg-white border-[#e3e3e3] hover:bg-[#dfe3e7] text-[#1f1f1f]'
                : 'bg-[#21262d] border-slate-700 hover:bg-slate-800 text-slate-300'
            }`}
            title="查看源码"
          >
            <Code className="w-3 h-3 shrink-0" />
            <span>源码</span>
          </button>

          <button
            onClick={handleCopy}
            className={`p-1.5 rounded-full border transition-all shadow-xs shrink-0 ${
              theme === 'light'
                ? 'bg-white border-[#e3e3e3] hover:bg-[#dfe3e7] text-slate-600'
                : 'bg-[#21262d] border-slate-700 hover:bg-slate-800 text-slate-300'
            }`}
            title="复制全文"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Document Content Canvas (Paper Style) */}
      <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full">
        {/* Document Title & Meta Header */}
        <div className="mb-6 pb-4 border-b border-[#e3e3e3] dark:border-slate-800">
          <div className="flex items-center gap-2 text-xs font-mono text-blue-600 dark:text-blue-400 font-semibold mb-1">
            <span>{activeDoc.sourceAgent ? `[${activeDoc.sourceAgent}]` : '[项目产物]'}</span>
            <span>·</span>
            <span>更新时间: {activeDoc.updatedAt}</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-[#1f1f1f] dark:text-slate-100">
            {activeDoc.title}
          </h1>
        </div>

        {/* Content View Modes */}
        {viewMode === 'diff' ? (
          <div className="p-4 rounded-2xl bg-[#f0f4f9] dark:bg-[#090d13] border border-[#e3e3e3] dark:border-slate-800 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-slate-400 mb-2">--- a/specs/{activeDoc.title}</div>
            <div className="text-slate-400 mb-3">+++ b/specs/{activeDoc.title}</div>
            <div className="text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded">
              + [AUTO-SYNTHESIS] 本文档经 Claude 与 ChatGPT 跨模型磋商后达成共识并写入。
            </div>
            <div className="text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded">
              + [BOUNDARY] 已严格限制在本地目录内执行，不影响生产数据。
            </div>
            <div className="text-[#1f1f1f] dark:text-slate-300 whitespace-pre-wrap mt-2">
              {activeDoc.content}
            </div>
          </div>
        ) : viewMode === 'source' ? (
          <pre className="p-4 rounded-2xl bg-[#f0f4f9] dark:bg-[#090d13] border border-[#e3e3e3] dark:border-slate-800 font-mono text-xs overflow-x-auto text-[#1f1f1f] dark:text-slate-200 leading-relaxed">
            {activeDoc.content}
          </pre>
        ) : (
          <div className="prose prose-slate dark:prose-invert max-w-none text-xs leading-relaxed whitespace-pre-wrap font-sans text-[#1f1f1f] dark:text-slate-300">
            {activeDoc.content}
          </div>
        )}
      </div>
    </div>
  );
};
