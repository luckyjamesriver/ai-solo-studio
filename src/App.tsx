import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { WarRoom } from './components/WarRoom';
import { Canvas } from './components/Canvas';
import { ExecutionConsole } from './components/ExecutionConsole';
import { 
  ChatMessage, 
  TaskItem, 
  ProjectState, 
  CanvasDocument 
} from './types';
import { createMessage } from './coordinator/workflow';

interface ConsoleLog {
  id: string;
  time: string;
  type: 'stdout' | 'stderr' | 'system' | 'diff';
  text: string;
}

export const App: React.FC = () => {
  // Theme state: defaults to 'light' per user's preference!
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState('t-2');
  const [projectState, setProjectState] = useState<ProjectState>('idle');
  const [activeCommand, setActiveCommand] = useState<string>('');

  // Initial Documents in Right Canvas (Matching user's screenshot)
  const [documents, setDocuments] = useState<CanvasDocument[]>([
    {
      id: 'doc-spec',
      title: 'SPEC-CLIPBOARD-V1.md',
      type: 'markdown',
      sourceAgent: 'Claude 3.7 架构师',
      updatedAt: '今天 19:15',
      content: `# 【桌面极简多剪贴板工具】详细需求与架构规范书

## 1. 项目定位与目标
- **目标用户**：日常有高频文本、链接复制需求的独立创作者与普通办公人员。
- **核心原则**：纯本地运行、零多余进程、无隐私上传、轻量低功耗。

## 2. 核心模块与功能点
- **剪贴板监听器 (Watcher)**：
  - 后台轮询或系统剪贴板事件监听，自动捕获最新文本内容；
  - 自动去重过滤与长度保护（单条上限 100KB，避免超大文本卡顿）。
- **历史记录存储 (Local Store)**：
  - 默认保留最新 50 条历史记录；
  - 采用本地轻量 JSON 或 SQLite 持久化存储。
- **极简弹窗界面 (Popup UI)**：
  - 全局快捷键唤起（如 Option + V 或 Ctrl + Shift + V）；
  - 单击任意历史项即可重新复制或直接回车粘贴；
  - 模糊搜索框快速检索过往内容。

## 3. 技术风控与边界安全 (ChatGPT 审查建议)
- **密码敏感数据排除**：若剪贴板内容符合密码管理器格式（如含特定前缀或来自 1Password/Bitwarden），提供一键忽略选项；
- **纯本地沙箱**：网络权限默认关闭，杜绝任何外部数据泄露风险。`,
    },
    {
      id: 'doc-observe',
      title: 'OBSERVE-RUNNER.md',
      type: 'markdown',
      sourceAgent: '总管理员 | 观察简报',
      updatedAt: '19:10',
      content: `【HOME-UI-PRESENCE | 已就绪】 19:10 首轮运行环境检查

- **当前运行节点**：独立 Electron / Web 渲染沙箱
- **底层执行体探测**：
  - Claude Code CLI (v2.1.318) 已挂载就绪
  - Codex CLI (v0.166.0) 已挂载就绪
  - Cursor IDE 适配器就绪
- **状态**：双脑通信总线就绪，待命接收新工单。`,
    },
  ]);

  const [activeDocId, setActiveDocId] = useState<string>('doc-spec');

  // Initial Messages in War Room
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-init-1',
      sender: 'claude',
      senderName: 'Claude 3.7',
      avatarColor: 'bg-amber-600',
      roleBadge: '首席架构师',
      content: '收到老板的需求！已为你规划了【桌面极简多剪贴板工具】的核心设计蓝图。\n\n我已将完整的技术规范和架构细则自动同步至右侧画布，你可以点击下方卡片或右侧标签页进行详细阅读。',
      timestamp: '19:15',
      linkedDocId: 'doc-spec',
      docPreviewTitle: 'SPEC-CLIPBOARD-V1.md 详细架构规范书',
    },
    {
      id: 'msg-init-2',
      sender: 'chatgpt',
      senderName: 'ChatGPT 4o',
      avatarColor: 'bg-teal-600',
      roleBadge: '技术评审 & 风控',
      content: '我已核验 Claude 的架构书三项要点。补充提示：在数据持久化时应注意异常崩溃保护，并增加快捷键唤起逻辑。整体方案可行，建议立即派发工单！',
      timestamp: '19:16',
      forwardedFrom: '由 ChatGPT 从另一个聊天发送',
    },
  ]);

  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([
    {
      id: 'log-1',
      time: '19:10:00',
      type: 'system',
      text: '[Runner] AI Solo Studio 本地环境就绪。已切换为浅色工作台模式。',
    },
  ]);

  // Keep html class in sync with theme state
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  };

  const addLog = (text: string, type: ConsoleLog['type'] = 'stdout') => {
    const time = new Date().toTimeString().split(' ')[0];
    setConsoleLogs((prev) => [
      ...prev,
      {
        id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        time,
        type,
        text,
      },
    ]);
  };

  // Human sends a message in War Room
  const handleSendMessage = (text: string) => {
    const userMsg = createMessage('user', text);
    setMessages((prev) => [...prev, userMsg]);

    if (projectState === 'paused') {
      const ack = createMessage('system', `已收到老板的干预指令：“${text}”。双脑正在重新校准方案。`);
      setMessages((prev) => [...prev, ack]);
      addLog(`[INTERVENE] 收到老板干预调整指令: ${text}`, 'system');
      return;
    }

    setProjectState('discussing');
    addLog(`[ORCHESTRATOR] 接收新任务：“${text}”。触发 Claude 与 ChatGPT 跨模型磋商...`, 'system');

    // Claude responds & generates an updated doc in Right Canvas
    setTimeout(() => {
      const newDocId = `doc-${Date.now()}`;
      const docTitle = `PLAN-${new Date().toISOString().slice(0, 10)}.md`;

      const newDoc: CanvasDocument = {
        id: newDocId,
        title: docTitle,
        type: 'markdown',
        sourceAgent: 'Claude 3.7 架构师',
        updatedAt: '刚刚',
        content: `# 【${text}】新一轮执行计划书\n\n## 1. 目标概述\n针对老板指令：“${text}”，已由 Claude 架构师梳理出实施路线图。\n\n## 2. 实施方案步骤\n1. 模块设计与边界隔离；\n2. 核心逻辑编码 (调度 Cursor / Claude Code)；\n3. 自动化测试用例验证。\n\n## 3. 验收标准\n- 退出码为 0，本地编译无报错；\n- 产物写入本地 workspace 目录。`,
      };

      setDocuments((prev) => [newDoc, ...prev]);
      setActiveDocId(newDocId);

      const claudeMsg: ChatMessage = {
        ...createMessage(
          'claude',
          `根据老板提出的新想法：“${text}”，我已制定新的实施方案，并生成了文档 **${docTitle}** 同步到了右侧画布！\n请 ChatGPT 审查并提出修订。`
        ),
        linkedDocId: newDocId,
        docPreviewTitle: `${docTitle} 执行计划书`,
      };
      setMessages((prev) => [...prev, claudeMsg]);

      // ChatGPT reviews
      setTimeout(() => {
        const gptMsg: ChatMessage = {
          ...createMessage(
            'chatgpt',
            `已核对 Claude 的最新实施计划书。经风险评估，边界清晰，逻辑稳健。本轮 Owner 明确按此计划实施！`
          ),
          forwardedFrom: '由 ChatGPT 从另一个聊天发送',
        };
        setMessages((prev) => [...prev, gptMsg]);
        setProjectState('awaiting_approval');
        addLog('[CHECKPOINT] 双脑方案一致，在右侧画布更新就绪，等待老板批准！', 'system');
      }, 1200);
    }, 1000);
  };

  const handleOpenDoc = (docId: string) => {
    setActiveDocId(docId);
  };

  const handleCloseDoc = (docId: string) => {
    setDocuments((prev) => {
      const filtered = prev.filter((d) => d.id !== docId);
      if (activeDocId === docId && filtered.length > 0) {
        setActiveDocId(filtered[0].id);
      }
      return filtered;
    });
  };

  const handlePause = () => {
    setProjectState('paused');
    addLog('[EMERGENCY PAUSE] 🔴 用户触发了紧急暂停！所有后台流转已就地冻结。', 'stderr');
    setMessages((prev) => [
      ...prev,
      createMessage('system', '⏸️ **紧急暂停已生效！**\n所有后台操作已就地冻结。你可以在左下方输入调整意见，或点击顶部的【继续推进】。'),
    ]);
  };

  const handleResume = () => {
    setProjectState('executing');
    addLog('[RESUME] 🟢 紧急暂停已解除，继续推进。', 'system');
    setMessages((prev) => [
      ...prev,
      createMessage('system', '▶️ **已恢复执行！** 任务流水线继续作业。'),
    ]);
  };

  const handleReset = () => {
    setProjectState('idle');
    addLog('[RESET] 看板与状态机已重置。', 'system');
  };

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden font-sans transition-colors ${
      theme === 'light' ? 'bg-[#f8fafc] text-slate-800' : 'bg-[#0b0f17] text-slate-100'
    }`}>
      {/* Top Header */}
      <Header
        projectState={projectState}
        activeTitle="X5 | 首页需求推演与方案 (接续待命)"
        theme={theme}
        onToggleTheme={toggleTheme}
        onPause={handlePause}
        onResume={handleResume}
        onReset={handleReset}
      />

      {/* Main 3-Column Studio Layout (Matching user's screenshot!) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Sidebar (Projects & Threads) */}
        <Sidebar
          activeThreadId={activeThreadId}
          onSelectThread={(id) => setActiveThreadId(id)}
          onNewChat={() => {
            const newMsg = createMessage('system', '已创建全新议题，请输入你的新 Idea！');
            setMessages([newMsg]);
          }}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          theme={theme}
        />

        {/* Middle Column: War Room (Conversational Flow) */}
        <WarRoom
          messages={messages}
          projectState={projectState}
          onSendMessage={handleSendMessage}
          onOpenDoc={handleOpenDoc}
          theme={theme}
        />

        {/* Right Column: Canvas (Detailed Document / Code / Plan Editor) */}
        <Canvas
          documents={documents}
          activeDocId={activeDocId}
          onSelectDoc={(id) => setActiveDocId(id)}
          onCloseDoc={handleCloseDoc}
          theme={theme}
        />
      </div>

      {/* Bottom Foldable Console */}
      <ExecutionConsole
        logs={consoleLogs}
        activeCommand={activeCommand}
        isExecuting={projectState === 'executing'}
      />
    </div>
  );
};
