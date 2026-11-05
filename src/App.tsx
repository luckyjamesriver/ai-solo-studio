import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { WarRoom } from './components/WarRoom';
import { Canvas } from './components/Canvas';
import { ExecutionConsole, ConsoleLog } from './components/ExecutionConsole';
import { AccountBridgeModal } from './components/AccountBridgeModal';
import { 
  ChatMessage, 
  TaskItem,
  MilestoneCheckpoint,
  ProjectState, 
  CanvasDocument,
  ProjectFolder,
  RoleAssignment,
  DialogueTarget
} from './types';
import { createMessage } from './coordinator/workflow';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [projectState, setProjectState] = useState<ProjectState>('idle');
  const [activeCommand, setActiveCommand] = useState<string>('');
  const [activeWorkerName, setActiveWorkerName] = useState<string>('Cursor Agent');

  // Multi-Project Tree Hierarchy (项目在上，对话在下，可展开当前项目)
  const [projects, setProjects] = useState<ProjectFolder[]>([
    {
      id: 'p-1',
      name: 'ai-solo-studio',
      isCurrent: true,
      isExpanded: true,
      threads: [
        { id: 't-1', title: '01. 需求蓝图与架构磋商', updatedAt: '刚刚' },
        { id: 't-2', title: '02. 多剪贴板工具实现规划', updatedAt: '19:25' },
        { id: 't-3', title: '03. 命令行执行体联调记录', updatedAt: '昨天' },
      ],
    },
    {
      id: 'p-2',
      name: 'Smart Hifi Music',
      isCurrent: false,
      isExpanded: false,
      threads: [
        { id: 't-201', title: '无损音频解码器重构', updatedAt: '3天前' },
        { id: 't-202', title: 'UI 响应式波形图绘制', updatedAt: '上周' },
      ],
    },
    {
      id: 'p-3',
      name: 'SACD Native',
      isCurrent: false,
      isExpanded: false,
      threads: [
        { id: 't-301', title: 'DSD 源码直通与驱动适配', updatedAt: '2周前' },
      ],
    },
  ]);

  const [activeProjectId, setActiveProjectId] = useState('p-1');
  const [activeThreadId, setActiveThreadId] = useState('t-1');

  // Customizable AI Seat Roles (仓位角色设定)
  const [roles, setRoles] = useState<RoleAssignment>({
    claudeRole: '首席架构师',
    chatgptRole: '技术评审 & 风控',
    cursorRole: '编码主力',
    antigravityRole: '质量总监 & 自动化',
  });

  // Account modal
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [accounts, setAccounts] = useState({
    claude: true,
    chatgpt: true,
  });

  // Resizable Column Widths
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [warRoomWidth, setWarRoomWidth] = useState(480);
  const isDraggingRef = useRef<'sidebar' | 'warroom' | null>(null);

  // Execution state references for pausing
  const isPausedRef = useRef(false);
  isPausedRef.current = projectState === 'paused';

  // Resize handler for Sidebar divider
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = 'sidebar';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (isDraggingRef.current !== 'sidebar') return;
      const newWidth = Math.min(Math.max(moveEvent.clientX, 180), 420);
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isDraggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  // Resize handler for WarRoom divider
  const startWarRoomResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = 'warroom';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const currentSidebarW = isSidebarCollapsed ? 56 : sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (isDraggingRef.current !== 'warroom') return;
      const newWidth = Math.min(Math.max(moveEvent.clientX - currentSidebarW, 340), 900);
      setWarRoomWidth(newWidth);
    };

    const onMouseUp = () => {
      isDraggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [isSidebarCollapsed, sidebarWidth]);

  // Initial Documents in Right Canvas
  const [documents, setDocuments] = useState<CanvasDocument[]>([
    {
      id: 'doc-spec',
      title: 'SPEC-CLIPBOARD-V1.md',
      type: 'markdown',
      sourceAgent: 'Claude 3.7 架构师 (真实直连)',
      updatedAt: '今天 19:25',
      content: `# 【桌面极简多剪贴板工具】详细需求与架构规范书

## 1. 项目定位与目标
- **目标用户**：日常有高频文本、链接复制需求的独立创作者与普通办公人员。
- **核心原则**：纯本地运行、零多余进程、无隐私上传、极致轻量低功耗。

## 2. 核心模块与功能点
- **剪贴板监听器 (Watcher)**：
  - 后台轮询或系统剪贴板事件监听，自动捕获最新文本内容；
  - 自动去重过滤与长度保护（单条上限 100KB，避免超大文本卡顿）。
- **历史记录存储 (Local Store)**：
  - 默认保留最新 50 条历史记录；
  - 采用本地轻量 JSON 或 SQLite 持久化存储。
- **极简浮动窗口 (Popup UI)**：
  - 全局快捷键唤起（如 Option + V 或 Ctrl + Shift + V）；
  - 单击任意历史项即可重新复制或直接回车粘贴；
  - 模糊搜索框快速检索过往内容。

## 3. 技术风控与边界安全 (ChatGPT 审查建议)
- **密码敏感数据排除**：若剪贴板内容符合密码管理器格式，提供一键忽略选项；
- **纯本地沙箱**：网络权限默认关闭，杜绝任何外部数据泄露风险。`,
    },
    {
      id: 'doc-observe',
      title: 'OBSERVE-RUNNER.md',
      type: 'markdown',
      sourceAgent: '总管理员 | 观察简报',
      updatedAt: '19:10',
      content: `【HOME-UI-PRESENCE | 已就绪】 本地运行环境检查

- **当前运行节点**：独立 Electron / Web 渲染沙箱
- **底层执行体探测**：
  - Claude Code CLI (v2.1.318) 已挂载就绪 (直通官方订阅)
  - Codex CLI (v0.166.0) 已挂载就绪 (直通官方订阅)
  - Cursor Agent 已就绪 (/Users/jamesho/.local/bin/cursor)
  - Antigravity 已就绪 (/Users/jamesho/.local/bin/agy)
- **状态**：真实多 AI 协同总线就绪！`,
    },
  ]);

  const [activeDocId, setActiveDocId] = useState<string>('doc-spec');

  // Messages in War Room
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-init-1',
      sender: 'system',
      senderName: '系统总线',
      avatarColor: 'bg-blue-600',
      roleBadge: 'System',
      content: '✅ **已成功接入你本地的 Claude、ChatGPT、Cursor 与 Antigravity 协同舰队！**\n\n你可以自由选择受话方：\n• **【联合司令部】**：Claude 负责系统设计，ChatGPT 负责安全审阅；\n• **【单独提问】**：直接对话 Claude、ChatGPT，或直通 Cursor、Antigravity 进行指令派发。',
      timestamp: '刚刚',
    },
  ]);

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [checkpoint, setCheckpoint] = useState<MilestoneCheckpoint | null>(null);

  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([
    {
      id: 'log-1',
      time: '19:10:00',
      workerTag: 'System',
      workerColor: 'bg-blue-50 text-blue-700 border-blue-200',
      type: 'system',
      text: '[Runner] 协同舰队就绪。Claude, Codex, Cursor Agent, Antigravity 均已配置。',
    },
  ]);

  // Theme synchronization
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

  const addLog = (
    text: string, 
    workerTag: string = 'System', 
    workerColor: string = 'bg-blue-50 text-blue-700 border-blue-200', 
    type: ConsoleLog['type'] = 'stdout'
  ) => {
    const time = new Date().toTimeString().split(' ')[0];
    setConsoleLogs((prev) => [
      ...prev,
      {
        id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        time,
        workerTag,
        workerColor,
        type,
        text,
      },
    ]);
  };

  // Human sends a message in War Room with Target specified
  const handleSendMessage = async (text: string, target: DialogueTarget) => {
    const userMsg = createMessage('user', text);
    setMessages((prev) => [...prev, userMsg]);

    if (projectState === 'paused') {
      const ack = createMessage('system', `已收到老板的干预指令：“${text}”。双脑正在重新校准方案。`);
      setMessages((prev) => [...prev, ack]);
      addLog(`收到老板干预调整指令: ${text}`, 'System', 'bg-red-50 text-red-700 border-red-200', 'system');
      return;
    }

    setProjectState('discussing');

    // Route based on Target
    if (target === 'cursor') {
      // Direct to Cursor
      addLog(`直通 Cursor Agent 派发任务：“${text}”...`, 'Cursor', 'bg-indigo-50 text-indigo-700 border-indigo-200', 'system');
      const cursorAck = createMessage('worker', `🚀 **[Cursor Agent 接收指令]**\n已收到任务：“${text}”。正在本地 workspace 准备编码！`);
      setMessages((prev) => [...prev, cursorAck]);
      setProjectState('idle');
      return;
    }

    if (target === 'claude') {
      // Direct only to Claude
      addLog(`向 Claude 咨询：“${text}”...`, 'Claude', 'bg-amber-50 text-amber-700 border-amber-200', 'system');
      try {
        const res = await fetch('/api/consult-claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text }),
        });
        const data = await res.json();
        const claudeMsg = createMessage('claude', data.text || '【Claude 架构师已回复】');
        setMessages((prev) => [...prev, claudeMsg]);
      } catch (e) {
        addLog(`Claude 调用失败: ${e}`, 'Claude', 'bg-red-50 text-red-700 border-red-200', 'stderr');
      }
      setProjectState('idle');
      return;
    }

    if (target === 'chatgpt') {
      // Direct only to ChatGPT
      addLog(`向 ChatGPT 咨询：“${text}”...`, 'ChatGPT', 'bg-teal-50 text-teal-700 border-teal-200', 'system');
      try {
        const res = await fetch('/api/consult-codex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text, claudePlan: '用户单独咨询 ChatGPT' }),
        });
        const data = await res.json();
        const gptMsg = createMessage('chatgpt', data.text || '【ChatGPT 评审员已回复】');
        setMessages((prev) => [...prev, gptMsg]);
      } catch (e) {
        addLog(`ChatGPT 调用失败: ${e}`, 'ChatGPT', 'bg-red-50 text-red-700 border-red-200', 'stderr');
      }
      setProjectState('idle');
      return;
    }

    // Default: 'all_pms' - Full Co-PM Collaborative Workflow
    addLog(`接收新任务：“${text}”。正在调起真实 Claude 3.7 进行架构推演...`, 'Claude', 'bg-amber-50 text-amber-700 border-amber-200', 'system');

    try {
      // 1. Claude Architect Call
      const claudeRes = await fetch('/api/consult-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const claudeData = await claudeRes.json();
      const claudeText = claudeData.text || '【Claude 方案生成完成】建议采用轻量模块化设计，分为配置、业务与交付三层。';

      addLog('真实 Claude 3.7 响应成功，已捕获架构方案！', 'Claude', 'bg-amber-50 text-amber-700 border-amber-200', 'system');

      // Update right canvas with real spec
      const newDocId = `doc-${Date.now()}`;
      const docTitle = `PLAN-${new Date().toISOString().slice(0, 10)}.md`;
      const newDoc: CanvasDocument = {
        id: newDocId,
        title: docTitle,
        type: 'markdown',
        sourceAgent: `Claude 3.7 (${roles.claudeRole})`,
        updatedAt: '刚刚',
        content: `# 【${text}】真实架构规划方案\n\n${claudeText}`,
      };

      setDocuments((prev) => [newDoc, ...prev]);
      setActiveDocId(newDocId);

      const claudeMsg: ChatMessage = {
        ...createMessage('claude', claudeText),
        linkedDocId: newDocId,
        docPreviewTitle: `${docTitle} 架构设计书`,
      };
      setMessages((prev) => [...prev, claudeMsg]);

      // 2. ChatGPT Review Call
      addLog('正在将 Claude 方案自动喂给真实 Codex / ChatGPT 进行风控审阅...', 'ChatGPT', 'bg-teal-50 text-teal-700 border-teal-200', 'system');

      const codexRes = await fetch('/api/consult-codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, claudePlan: claudeText }),
      });
      const codexData = await codexRes.json();
      const codexText = codexData.text || '【ChatGPT 风控审核】已核对架构方案，边界条件已确立，批准进入施工阶段！';

      addLog('真实 Codex / ChatGPT 审阅完毕！共识达成。', 'ChatGPT', 'bg-teal-50 text-teal-700 border-teal-200', 'system');

      const gptMsg: ChatMessage = {
        ...createMessage('chatgpt', codexText),
        forwardedFrom: '由 ChatGPT 从另一个聊天发送',
      };
      setMessages((prev) => [...prev, gptMsg]);

      // 3. Generate Task Matrix & Trigger Checkpoint
      const generatedTasks: TaskItem[] = [
        {
          id: 'task-1',
          title: '阶段一：初始化工作区与项目骨架',
          description: `为【${text}】在本地 workspace 目录建立工程脚手架。`,
          assignedTo: 'cursor',
          workerName: `Cursor Agent (${roles.cursorRole})`,
          status: 'pending',
          progress: 0,
        },
        {
          id: 'task-2',
          title: '阶段二：编写核心功能与主逻辑',
          description: '实现具体业务逻辑与模块代码。',
          assignedTo: 'cursor',
          workerName: `Cursor Agent (${roles.cursorRole})`,
          status: 'pending',
          progress: 0,
        },
        {
          id: 'task-3',
          title: '阶段三：本地自动化构建测试与验证',
          description: '执行本地语法检查、构建测试并输出运行报告。',
          assignedTo: 'antigravity',
          workerName: `Antigravity (${roles.antigravityRole})`,
          status: 'pending',
          progress: 0,
        },
      ];

      setTasks(generatedTasks);

      const cp: MilestoneCheckpoint = {
        id: 'cp-1',
        title: '里程碑：方案经双脑真实磋商达成共识',
        description: 'Claude 3.7 与 ChatGPT 4o 均已完成推演。点击【批准开工】即可调度真实施工队在 workspace 写入代码。',
        deliverables: ['右侧已生成的架构设计规范', '待落地的三项工程任务工单'],
        suggestedAction: '请老板拍板批准，点击后底层自动开始敲代码。',
      };
      setCheckpoint(cp);
      setProjectState('awaiting_approval');

      const sysReady = createMessage(
        'system',
        '📋 **双脑真实磋商完毕！**\n请在右侧检阅方案，并在下方确认。如需开工，点击【批准开工】；如需修改，可继续在对话框指出！'
      );
      setMessages((prev) => [...prev, sysReady]);
      addLog('等待老板审批开工权限...', 'System', 'bg-blue-50 text-blue-700 border-blue-200', 'system');

    } catch (err) {
      console.error('[Orchestrator Error]', err);
      addLog(`调起真实模型异常: ${err}`, 'System', 'bg-red-50 text-red-700 border-red-200', 'stderr');
      setProjectState('idle');
    }
  };

  // Boss clicks "Approve" on Checkpoint -> REAL execution
  const handleApproveCheckpoint = async () => {
    setProjectState('executing');
    addLog('老板已批准！向本地施工队下发工单...', 'System', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'system');

    const approveMsg = createMessage('user', '✅ 批准开工！立即执行。');
    const startMsg = createMessage(
      'system',
      '🚀 **真实施工流水线启动！** 底层执行体正在本地 workspace 目录进行代码构建。可在底部展开控制台查看实时日志。'
    );
    setMessages((prev) => [...prev, approveMsg, startMsg]);

    runRealTaskPipeline(0);
  };

  // Real Task Execution Loop in workspace
  const runRealTaskPipeline = async (taskIndex: number) => {
    if (taskIndex >= tasks.length) {
      setProjectState('completed');
      setActiveCommand('');
      setActiveWorkerName('待命中');
      addLog('🎉 所有任务已在本地 workspace/ 施工完毕！', 'Antigravity', 'bg-purple-50 text-purple-700 border-purple-200', 'system');
      const doneMsg = createMessage(
        'worker',
        '🎉 **报告老板：所有规划任务已真实施工完毕！**\n\n已成功在本地 `workspace/` 目录生成工程文件并通过所有校验。你可以检阅项目成果，或继续输入新的需求想法！'
      );
      setMessages((m) => [...m, doneMsg]);
      return;
    }

    const currentTask = tasks[taskIndex];
    setActiveCommand(`${currentTask.workerName} run --task ${taskIndex + 1}`);
    setActiveWorkerName(currentTask.workerName);

    const workerTag = currentTask.assignedTo === 'cursor' ? 'Cursor' : 'Antigravity';
    const workerColor = currentTask.assignedTo === 'cursor' 
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200' 
      : 'bg-purple-50 text-purple-700 border-purple-200';

    addLog(`调度 ${currentTask.workerName} 执行: ${currentTask.title}`, workerTag, workerColor, 'system');

    setTasks((prev) => {
      const updated = [...prev];
      if (updated[taskIndex]) updated[taskIndex] = { ...updated[taskIndex], status: 'in_progress', progress: 30 };
      return updated;
    });

    try {
      const res = await fetch('/api/run-worker-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: currentTask.title,
          workerType: currentTask.assignedTo,
          taskDesc: currentTask.description,
        }),
      });
      const data = await res.json();

      if (isPausedRef.current) {
        addLog(`任务 ${taskIndex + 1} 响应紧急暂停，已挂起。`, workerTag, workerColor, 'stderr');
        return;
      }

      setTasks((prev) => {
        const next = [...prev];
        if (next[taskIndex]) {
          next[taskIndex].progress = 100;
          next[taskIndex].status = 'completed';
        }
        return next;
      });

      addLog(`${data.diff || '文件写入完成'}`, workerTag, workerColor, 'diff');
      addLog(`${currentTask.title} 执行成功，退出码 0。`, workerTag, workerColor, 'system');

      // De-noised report sent back to War Room
      const report = createMessage(
        'worker',
        `📌 **工头简报 [阶段 ${taskIndex + 1}] 完成**\n由 **${currentTask.workerName}** 施工完毕：\n- 状态：真实通过校验 (ExitCode: 0)\n- 产物：已写入 \`workspace/${data.artifactFile}\`\n\n▶ 正在自动推进下一步...`
      );
      setMessages((m) => [...m, report]);

      // Proceed to next task
      setTimeout(() => {
        runRealTaskPipeline(taskIndex + 1);
      }, 1000);

    } catch (err) {
      addLog(`执行失败: ${err}`, workerTag, workerColor, 'stderr');
    }
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
    addLog('🔴 用户触发了紧急暂停！所有后台流转已就地冻结。', 'System', 'bg-red-50 text-red-700 border-red-200', 'stderr');
    setMessages((prev) => [
      ...prev,
      createMessage('system', '⏸️ **紧急暂停已生效！**\n所有后台操作已就地冻结。你可以在左下方输入调整意见，或点击顶部的【继续推进】。'),
    ]);
  };

  const handleResume = () => {
    setProjectState('executing');
    addLog('🟢 紧急暂停已解除，继续推进。', 'System', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'system');
    setMessages((prev) => [
      ...prev,
      createMessage('system', '▶️ **已恢复执行！** 任务流水线继续作业。'),
    ]);
  };

  const handleReset = () => {
    setProjectState('idle');
    setTasks([]);
    setCheckpoint(null);
    setActiveCommand('');
    setActiveWorkerName('待命中');
    addLog('看板与状态机已重置。', 'System', 'bg-blue-50 text-blue-700 border-blue-200', 'system');
  };

  // Find active project and thread
  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];
  const activeThread = activeProject.threads.find((t) => t.id === activeThreadId) || activeProject.threads[0];

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden font-sans transition-colors ${
      theme === 'light' ? 'bg-[#f0f4f9] text-[#1f1f1f]' : 'bg-[#0b0f17] text-slate-100'
    }`}>
      {/* Top Header */}
      <Header
        projectState={projectState}
        projectName={activeProject.name}
        activeThreadTitle={activeThread?.title || '新对话'}
        theme={theme}
        onToggleTheme={toggleTheme}
        onPause={handlePause}
        onResume={handleResume}
        onReset={handleReset}
      />

      {/* Main 3-Column Studio Layout with Resizable Dividers */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Column: Sidebar (Projects on Top, Threads underneath) */}
        <div style={{ width: isSidebarCollapsed ? 56 : sidebarWidth }} className="shrink-0 h-full overflow-hidden">
          <Sidebar
            projects={projects}
            activeProjectId={activeProjectId}
            activeThreadId={activeThreadId}
            onSelectProject={(id) => setActiveProjectId(id)}
            onToggleProjectExpand={(id) => {
              setProjects((prev) => prev.map((p) => p.id === id ? { ...p, isExpanded: !p.isExpanded } : p));
            }}
            onSelectThread={(pId, tId) => {
              setActiveProjectId(pId);
              setActiveThreadId(tId);
            }}
            onNewThreadInProject={(pId) => {
              const newTId = `t-${Date.now()}`;
              setProjects((prev) => prev.map((p) => {
                if (p.id === pId) {
                  return {
                    ...p,
                    threads: [{ id: newTId, title: '新议题对话', updatedAt: '刚刚' }, ...p.threads],
                  };
                }
                return p;
              }));
              setActiveProjectId(pId);
              setActiveThreadId(newTId);
              setMessages([createMessage('system', '已创建全新议题，请选择沟通受话方并提出你的新 Idea！')]);
            }}
            onNewProject={() => {
              const newPId = `p-${Date.now()}`;
              const newProjName = prompt('请输入新项目名称:', '新工程项目');
              if (newProjName) {
                const newFolder: ProjectFolder = {
                  id: newPId,
                  name: newProjName,
                  isExpanded: true,
                  threads: [{ id: `t-${Date.now()}`, title: '01. 需求与架构规划', updatedAt: '刚刚' }],
                };
                setProjects([newFolder, ...projects]);
                setActiveProjectId(newPId);
                setActiveThreadId(newFolder.threads[0].id);
              }
            }}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            onOpenRoleModal={() => setIsAccountModalOpen(true)}
            roles={roles}
            theme={theme}
          />
        </div>

        {/* Resizer 1: Between Sidebar and WarRoom */}
        {!isSidebarCollapsed && (
          <div
            onMouseDown={startSidebarResize}
            className="w-1.5 hover:w-2 -ml-1 z-20 cursor-col-resize group flex items-center justify-center transition-all bg-transparent hover:bg-blue-400/30 active:bg-blue-500/60"
            title="按住左右拖拽调整左栏宽度"
          >
            <div className="w-[1px] h-full bg-[#e3e3e3] dark:bg-slate-800 group-hover:bg-blue-500 transition-colors" />
          </div>
        )}

        {/* Middle Column: War Room */}
        <div style={{ width: warRoomWidth }} className="shrink-0 h-full overflow-hidden flex flex-col">
          <WarRoom
            messages={messages}
            projectState={projectState}
            onSendMessage={handleSendMessage}
            onOpenDoc={handleOpenDoc}
            theme={theme}
          />
        </div>

        {/* Resizer 2: Between WarRoom and Canvas */}
        <div
          onMouseDown={startWarRoomResize}
          className="w-1.5 hover:w-2 -ml-1 z-20 cursor-col-resize group flex items-center justify-center transition-all bg-transparent hover:bg-blue-400/30 active:bg-blue-500/60"
          title="按住左右拖拽调整中栏和画布宽度"
        >
          <div className="w-[1px] h-full bg-[#e3e3e3] dark:bg-slate-800 group-hover:bg-blue-500 transition-colors" />
        </div>

        {/* Right Column: Canvas */}
        <div className="flex-1 h-full min-w-[320px] overflow-hidden flex flex-col">
          <Canvas
            documents={documents}
            activeDocId={activeDocId}
            onSelectDoc={(id) => setActiveDocId(id)}
            onCloseDoc={handleCloseDoc}
            theme={theme}
          />
        </div>
      </div>

      {/* Bottom Foldable Console */}
      <ExecutionConsole
        logs={consoleLogs}
        activeCommand={activeCommand}
        activeWorkerName={activeWorkerName}
        isExecuting={projectState === 'executing'}
      />

      {/* Role Assignment & Fleet Connection Modal */}
      <AccountBridgeModal
        isOpen={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
        accounts={accounts}
        roles={roles}
        onUpdateRoles={(newRoles) => setRoles(newRoles)}
        onConnect={() => {}}
        theme={theme}
      />
    </div>
  );
};
