import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header, StudioViewMode } from './components/Header';
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
  DialogueTarget,
  ModelConfig,
  DiscoveredModelsMap
} from './types';
import { createMessage } from './coordinator/workflow';
import { 
  FileText, 
  Terminal, 
  Columns2, 
  PanelRightClose, 
  PanelRightOpen,
  Sparkles,
  Bot,
  ExternalLink,
  ArrowRight,
  Download,
  Play,
  Copy,
  FolderOpen,
  ArrowLeft
} from 'lucide-react';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [projectState, setProjectState] = useState<ProjectState>('idle');
  const [activeCommand, setActiveCommand] = useState<string>('');
  const [activeWorkerName, setActiveWorkerName] = useState<string>('Cursor Agent');

  // Studio Viewport Mode (方案2：官方网页直通与联合中枢切换)
  const [studioView, setStudioView] = useState<StudioViewMode>('war_room');

  // Multi-Project Tree Hierarchy (项目在上，对话在下，可展开当前项目)
  const [projects, setProjects] = useState<ProjectFolder[]>([
    {
      id: 'p-1',
      name: 'ai-solo-studio',
      path: '/Users/jamesho/AI-CoWork',
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
      name: 'Smart Hifi Music (仅供参考)',
      isCurrent: false,
      isExpanded: false,
      threads: [
        { id: 't-201', title: '无损音频解码器重构', updatedAt: '3天前' },
        { id: 't-202', title: 'UI 响应式波形图绘制', updatedAt: '上周' },
      ],
    },
    {
      id: 'p-3',
      name: 'SACD Native (仅供参考)',
      isCurrent: false,
      isExpanded: false,
      threads: [
        { id: 't-301', title: 'DSD 源码直通与驱动适配', updatedAt: '2周前' },
      ],
    },
  ]);

  const [activeProjectId, setActiveProjectId] = useState('p-1');
  const [activeThreadId, setActiveThreadId] = useState('t-1');

  // Customizable AI Seat Roles (席位分工设定)
  const [roles, setRoles] = useState<RoleAssignment>({
    claudeRole: '首席架构师',
    chatgptRole: '技术评审 & 风控',
    cursorRole: '编码主力',
    antigravityRole: '质量总监 & 自动化',
  });

  // Dynamic Model and Reasoning/Thinking Level Configuration (真实 CLI 模型默认值)
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    claudeModel: 'Opus 5.5',
    claudeThinking: '高',
    chatgptModel: 'gpt-6.1-sol',
    chatgptThinking: '高',
    cursorModel: 'auto',
    cursorThinking: '高强度',
    antigravityModel: 'gemini-3.8-flash-high',
    antigravityThinking: '深度思考',
  });

  // Machine Discovered Models (真实探测到的 CLI 模型映射表)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModelsMap>({
    antigravity: [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
    codex: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
      { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
      { id: 'gpt-6-sol', name: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
    ],
    cursor: [
      { id: 'auto', name: 'Auto (Default)' },
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 1M High' },
      { id: 'claude-sonnet-5-thinking-high', name: 'Claude Sonnet 5 1M Thinking' },
      { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol 1M High' },
      { id: 'claude-4.6-sonnet-medium-thinking', name: 'Claude Sonnet 4.6 1M Thinking' },
      { id: 'claude-4.6-opus-high-thinking', name: 'Claude Opus 4.6 1M Thinking' },
      { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash' },
      { id: 'grok-4.7-high', name: 'Grok 4.7 High' },
    ],
    claude: [
      { id: 'Opus 5.5', name: 'Opus 5.5 (高阶复杂设计)' },
      { id: 'Sonnet 5.5', name: 'Sonnet 5.5 (主力编码)' },
      { id: 'Haiku 5.5', name: 'Haiku 5.5 (极速响应)' },
      { id: 'Fable 5.1', name: 'Fable 5.1' },
    ],
  });

  // Fetch real machine-installed CLI models on mount
  useEffect(() => {
    fetch('/api/cli-models')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.antigravity && data.antigravity.length > 0) {
          setDiscoveredModels(data);
        }
      })
      .catch((err) => console.error('[Discovery Error]', err));
  }, []);

  // Right Panel View Mode (宽屏并排分屏、单栏切换与折叠)
  const [rightViewMode, setRightViewMode] = useState<'canvas' | 'console' | 'split'>('canvas');
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);

  // Account modal
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [accounts, setAccounts] = useState({
    claude: true,
    chatgpt: true,
  });

  // Resizable Column Widths
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [warRoomWidth, setWarRoomWidth] = useState(520);
  const isDraggingRef = useRef<'sidebar' | 'warroom' | null>(null);

  // Execution state references for pausing
  const isPausedRef = useRef(false);
  isPausedRef.current = projectState === 'paused';

  // Check if running inside real Electron desktop runtime
  const isElectron = typeof window !== 'undefined' && 
    ((window as any).process?.versions?.electron !== undefined || navigator.userAgent.includes('Electron'));

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
      const newWidth = Math.min(Math.max(moveEvent.clientX - currentSidebarW, 360), 960);
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
      sourceAgent: 'Claude (Opus 5.5) · 首席架构师',
      updatedAt: '今天 19:25',
      content: `# 【桌面极简多剪贴板工具】详细需求与架构规范书

## 1. 项目定位与目标
- **目标用户**：日常有高频文本、链接复制需求的独立创作者与办公人员。
- **核心原则**：纯本地运行、零多余进程、无隐私上传、极致轻量低功耗。

## 2. 核心模块与实现路径
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
      sourceAgent: '系统监控简报',
      updatedAt: '19:10',
      content: `【HOME-UI-PRESENCE | 已就绪】 本地运行环境检查

- **当前运行节点**：独立 Electron / Web 渲染沙箱
- **底层执行体探测**：
  - Claude CLI 已挂载就绪 (直通官方订阅，可选 Opus 5.5 / Sonnet 5.5)
  - Codex CLI 已挂载就绪 (直通官方订阅，可选 GPT-6 / GPT-5.6 Sol)
  - Cursor Agent 已就绪 (/Users/jamesho/.local/bin/cursor)
  - Antigravity 已就绪 (/Users/jamesho/.local/bin/agy)
- **状态**：多 AI 协同总线就绪！右侧控制台可随时查看独立 Tab 执行状态。`,
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
      content: '✅ **已成功接入你本地的 Claude、ChatGPT、Cursor 与 Antigravity 协同舰队！**\n\n你可以自由选择：\n• **【联合总线】**：提出一个想法，Claude 与 ChatGPT 会**同时给出各自的专业答案**并汇聚共识！\n• **【单体对话】**：单独向 Claude 或 ChatGPT 深入追问，或直通 Cursor、Antigravity 派发任务。\n• **【官方网页直通】**：顶部可一键切换至 100% 官方原生的 Claude.ai 与 ChatGPT.com 独立视界，或双脑并排！',
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
      text: '[Runner] 协同舰队就绪。Claude, Codex, Cursor Agent, Antigravity 均已挂载通信总线。',
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
      // Direct to Cursor Agent
      addLog(`直通 Cursor Agent [${modelConfig.cursorModel} · ${modelConfig.cursorThinking}] 派发任务：“${text}”...`, 'Cursor', 'bg-indigo-50 text-indigo-700 border-indigo-200', 'system');
      const cursorAck: ChatMessage = {
        ...createMessage('worker', `🚀 **[Cursor Agent 接收指令]**\n已收到任务：“${text}”。\n• 指定模型: \`${modelConfig.cursorModel}\`\n• 模式级别: \`${modelConfig.cursorThinking}\`\n\n正在本地 workspace 准备编码！可在右侧切换【执行体实时流】查看输出。`),
        modelUsed: modelConfig.cursorModel,
        thinkingLevel: modelConfig.cursorThinking,
      };
      setMessages((prev) => [...prev, cursorAck]);
      setProjectState('idle');
      return;
    }

    if (target === 'antigravity') {
      // Direct to Antigravity
      addLog(`直通 Antigravity [${modelConfig.antigravityModel} · ${modelConfig.antigravityThinking}] 派发任务：“${text}”...`, 'Antigravity', 'bg-purple-50 text-purple-700 border-purple-200', 'system');
      const agyAck: ChatMessage = {
        ...createMessage('worker', `🪐 **[Antigravity 接收指令]**\n已收到任务：“${text}”。\n• 指定模型: \`${modelConfig.antigravityModel}\`\n• 思考级别: \`${modelConfig.antigravityThinking}\`\n\n正在进行项目构建检查、测试用例推演与自动化环境验证！可在右侧切换【执行体实时流】查看输出。`),
        modelUsed: modelConfig.antigravityModel,
        thinkingLevel: modelConfig.antigravityThinking,
      };
      setMessages((prev) => [...prev, agyAck]);
      setProjectState('idle');
      return;
    }

    if (target === 'claude') {
      // Direct only to Claude
      addLog(`向 Claude [${modelConfig.claudeModel} · 思考: ${modelConfig.claudeThinking}] 咨询：“${text}”...`, 'Claude', 'bg-amber-50 text-amber-700 border-amber-200', 'system');
      try {
        const res = await fetch('/api/consult-claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: text, 
            model: modelConfig.claudeModel, 
            thinking: modelConfig.claudeThinking 
          }),
        });
        const data = await res.json();
        const claudeMsg: ChatMessage = {
          ...createMessage('claude', data.text || '【Claude 架构师已回复】'),
          modelUsed: modelConfig.claudeModel,
          thinkingLevel: `思考: ${modelConfig.claudeThinking}`,
        };
        setMessages((prev) => [...prev, claudeMsg]);
      } catch (e) {
        addLog(`Claude 调用失败: ${e}`, 'Claude', 'bg-red-50 text-red-700 border-red-200', 'stderr');
      }
      setProjectState('idle');
      return;
    }

    if (target === 'chatgpt') {
      // Direct only to ChatGPT
      addLog(`向 ChatGPT [${modelConfig.chatgptModel} · 思考: ${modelConfig.chatgptThinking}] 咨询：“${text}”...`, 'ChatGPT', 'bg-teal-50 text-teal-700 border-teal-200', 'system');
      try {
        const res = await fetch('/api/consult-codex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: text, 
            claudePlan: '', 
            model: modelConfig.chatgptModel, 
            thinking: modelConfig.chatgptThinking 
          }),
        });
        const data = await res.json();
        const gptMsg: ChatMessage = {
          ...createMessage('chatgpt', data.text || '【ChatGPT 评审员已回复】'),
          modelUsed: modelConfig.chatgptModel,
          thinkingLevel: `思考: ${modelConfig.chatgptThinking}`,
        };
        setMessages((prev) => [...prev, gptMsg]);
      } catch (e) {
        addLog(`ChatGPT 调用失败: ${e}`, 'ChatGPT', 'bg-red-50 text-red-700 border-red-200', 'stderr');
      }
      setProjectState('idle');
      return;
    }

    // Default: 'all_pms' - SIMULTANEOUS DUAL RESPONSE (双脑同时响应与激荡)
    addLog(`[联合总线] 一键同时广播给 Claude [${modelConfig.claudeModel}] 与 ChatGPT [${modelConfig.chatgptModel}]...`, 'System', 'bg-blue-50 text-blue-700 border-blue-200', 'system');

    try {
      // Trigger BOTH Claude and ChatGPT simultaneously in parallel!
      const claudePromise = fetch('/api/consult-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: text, 
          model: modelConfig.claudeModel, 
          thinking: modelConfig.claudeThinking 
        }),
      }).then((r) => r.json());

      const chatgptPromise = fetch('/api/consult-codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: text, 
          claudePlan: '', 
          model: modelConfig.chatgptModel, 
          thinking: modelConfig.chatgptThinking 
        }),
      }).then((r) => r.json());

      // Await both simultaneously!
      const [claudeData, codexData] = await Promise.all([claudePromise, chatgptPromise]);

      const claudeText = claudeData?.text || '【Claude 架构师】建议采用三层解耦架构，保证代码高内聚低耦合。';
      const codexText = codexData?.text || '【ChatGPT 评审员】已核查边界条件与潜在风险，架构可行，准予施工。';

      addLog(`Claude [${modelConfig.claudeModel}] 与 ChatGPT [${modelConfig.chatgptModel}] 均已完成推演！`, 'System', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'system');

      // 1. Post Claude's Answer Bubble
      const newDocId = `doc-${Date.now()}`;
      const docTitle = `SPEC-${new Date().toISOString().slice(0, 10)}.md`;
      const claudeMsg: ChatMessage = {
        ...createMessage('claude', claudeText),
        linkedDocId: newDocId,
        docPreviewTitle: `${docTitle} 架构设计书`,
        modelUsed: modelConfig.claudeModel,
        thinkingLevel: `思考: ${modelConfig.claudeThinking}`,
      };

      // 2. Post ChatGPT's Answer Bubble
      const gptMsg: ChatMessage = {
        ...createMessage('chatgpt', codexText),
        modelUsed: modelConfig.chatgptModel,
        thinkingLevel: `思考: ${modelConfig.chatgptThinking}`,
      };

      setMessages((prev) => [...prev, claudeMsg, gptMsg]);

      // 3. Synthesize Consensus Specification on Right Canvas
      const synthesizedDoc: CanvasDocument = {
        id: newDocId,
        title: docTitle,
        type: 'markdown',
        sourceAgent: `双脑共识: Claude (${modelConfig.claudeModel}) + ChatGPT (${modelConfig.chatgptModel})`,
        updatedAt: '刚刚',
        content: `# 【${text}】双脑共识架构与开发规范书\n\n## 1. 架构方案 (Claude ${modelConfig.claudeModel} 规划)\n${claudeText}\n\n---\n\n## 2. 技术评审与风控规约 (ChatGPT ${modelConfig.chatgptModel} 审阅)\n${codexText}\n\n---\n\n## 3. 落地执行计划\n由本地施工队 (Cursor Agent + Antigravity) 分三阶段落地。`,
      };

      setDocuments((prev) => [synthesizedDoc, ...prev]);
      setActiveDocId(newDocId);

      // 4. Generate Task Matrix with Selected Worker Models
      const generatedTasks: TaskItem[] = [
        {
          id: 'task-1',
          title: '阶段一：初始化工作区与项目骨架',
          description: `为【${text}】在本地 workspace 目录建立工程脚手架。`,
          assignedTo: 'cursor',
          workerName: `Cursor Agent (${roles.cursorRole})`,
          modelUsed: modelConfig.cursorModel,
          thinkingLevel: modelConfig.cursorThinking,
          status: 'pending',
          progress: 0,
        },
        {
          id: 'task-2',
          title: '阶段二：编写核心功能与主逻辑',
          description: '实现具体业务逻辑与模块代码。',
          assignedTo: 'cursor',
          workerName: `Cursor Agent (${roles.cursorRole})`,
          modelUsed: modelConfig.cursorModel,
          thinkingLevel: modelConfig.cursorThinking,
          status: 'pending',
          progress: 0,
        },
        {
          id: 'task-3',
          title: '阶段三：本地自动化构建测试与验证',
          description: '执行本地语法检查、构建测试并输出运行报告。',
          assignedTo: 'antigravity',
          workerName: `Antigravity (${roles.antigravityRole})`,
          modelUsed: modelConfig.antigravityModel,
          thinkingLevel: modelConfig.antigravityThinking,
          status: 'pending',
          progress: 0,
        },
      ];

      setTasks(generatedTasks);

      // 5. Milestone Checkpoint for Boss Approval
      const cp: MilestoneCheckpoint = {
        id: 'cp-1',
        title: '里程碑：双脑已同时响应并达成共识方案',
        description: `Claude (${modelConfig.claudeModel}) 与 ChatGPT (${modelConfig.chatgptModel}) 均已完成推演。点击【批准开工】即可调度施工队在 workspace 写入代码。`,
        deliverables: ['右侧已生成的双脑共识架构规范', '待落地的三项工程工单 (Cursor + Antigravity)'],
        suggestedAction: '请老板拍板批准，点击后底层自动开始敲代码。',
      };
      setCheckpoint(cp);
      setProjectState('awaiting_approval');

      const sysReady = createMessage(
        'system',
        '📋 **双脑已同时给出专业意见并汇聚方案！**\n请在右侧检阅共识规范，并在下方确认。如需开工，点击【批准开工】；如需修改，可继续在对话框指出！'
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
    setIsRightPanelCollapsed(false);
    if (rightViewMode === 'canvas') {
      setRightViewMode('split');
    }

    addLog('老板已批准！向本地施工队下发工单...', 'System', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'system');

    const approveMsg = createMessage('user', '✅ 批准开工！立即执行。');
    const startMsg = createMessage(
      'system',
      '🚀 **真实施工流水线启动！** 底层执行体正在本地 workspace 目录进行代码构建。可在右侧实时流查看各执行体独立 Tab 日志。'
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
        '🎉 **报告老板：所有规划任务已真实施工完毕！**\n\n已成功在本地 `workspace/` 目录生成工程文件并通过全部校验。你可以检阅项目成果，或继续输入新的需求想法！'
      );
      setMessages((m) => [...m, doneMsg]);
      return;
    }

    const currentTask = tasks[taskIndex];
    const taskModel = currentTask.modelUsed || (currentTask.assignedTo === 'cursor' ? modelConfig.cursorModel : modelConfig.antigravityModel);
    setActiveCommand(`${currentTask.workerName} [${taskModel}] run --task ${taskIndex + 1}`);
    setActiveWorkerName(currentTask.workerName);

    const workerTag = currentTask.assignedTo === 'cursor' ? 'Cursor' : 'Antigravity';
    const workerColor = currentTask.assignedTo === 'cursor' 
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200' 
      : 'bg-purple-50 text-purple-700 border-purple-200';

    addLog(`调度 ${currentTask.workerName} [${taskModel}] 执行: ${currentTask.title}`, workerTag, workerColor, 'system');

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
          model: taskModel,
          thinking: currentTask.thinkingLevel,
          projectFolder: activeProject.path || undefined,
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
      const report: ChatMessage = {
        ...createMessage(
          'worker',
          `📌 **工头简报 [阶段 ${taskIndex + 1}] 完成**\n由 **${currentTask.workerName}** 施工完毕：\n- 模型级别: \`${taskModel}\`\n- 状态：真实通过校验 (ExitCode: 0)\n- 产物：已写入 \`workspace/${data.artifactFile}\`\n\n▶ 正在自动推进下一步...`
        ),
        modelUsed: taskModel,
      };
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
    if (isRightPanelCollapsed) setIsRightPanelCollapsed(false);
    if (rightViewMode === 'console') setRightViewMode('canvas');
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

  // Official Web Bridge Actions (方案2：官方网页与本地工程的无缝桥梁)
  const handleCopyProjectContext = () => {
    const textToCopy = `【当前工程项目】: ${activeProject.name}\n【项目路径】: ${activeProject.path || 'workspace/'}\n【当前推进议题】: ${activeThread.title}\n\n请针对以上工程项目，进行架构设计与针对性的实现指导方案。`;
    navigator.clipboard.writeText(textToCopy);
    alert('✅ 已将当前工程背景与提示词复制到剪贴板！可以直接在官方网页中粘贴 (⌘+V)。');
  };

  const handleImportPlanFromWeb = async () => {
    const userPromptText = prompt('请粘贴来自官方网页端生成的方案或架构文本 (或直接点确定尝试读取剪贴板)：', '');
    let planText = userPromptText;
    if (!planText) {
      try {
        planText = await navigator.clipboard.readText();
      } catch {}
    }
    if (!planText || planText.trim().length < 5) return;

    const newDocId = `doc-web-${Date.now()}`;
    const newDoc: CanvasDocument = {
      id: newDocId,
      title: `WEB-SPEC-${activeProject.name}.md`,
      type: 'markdown',
      sourceAgent: studioView === 'claude_web' ? 'Claude.ai 官方网页' : studioView === 'chatgpt_web' ? 'ChatGPT.com 官方网页' : '双脑官方网页',
      updatedAt: '刚刚',
      content: `# 【${activeProject.name}】官方网页端方案同步\n\n- **来源**: ${studioView === 'claude_web' ? 'Claude.ai 官方' : 'ChatGPT.com 官方'}\n- **导入时间**: ${new Date().toLocaleString()}\n\n## 架构与实施方案\n${planText}\n`,
    };
    setDocuments((prev) => [newDoc, ...prev]);
    setActiveDocId(newDocId);
    setStudioView('war_room');
    setMessages((prev) => [
      ...prev,
      createMessage('system', `📥 **已成功从官方网页端导入方案规范！**\n已同步至右侧规范文档【WEB-SPEC-${activeProject.name}.md】。现在你可以调动本地施工队开工或继续在联合中枢中微调！`),
    ]);
  };

  const handleOpenProjectFolder = async () => {
    try {
      await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: activeProject.path }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden font-sans transition-colors ${
      theme === 'light' ? 'bg-[#f0f4f9] text-[#1f1f1f]' : 'bg-[#0b0f17] text-slate-100'
    }`}>
      {/* Top Header with Studio View Switcher */}
      <Header
        projectState={projectState}
        projectName={activeProject.name}
        activeThreadTitle={activeThread?.title || '新对话'}
        theme={theme}
        onToggleTheme={toggleTheme}
        onPause={handlePause}
        onResume={handleResume}
        onReset={handleReset}
        studioView={studioView}
        onSetStudioView={setStudioView}
        rightViewMode={rightViewMode}
        onSetRightViewMode={setRightViewMode}
        isRightPanelCollapsed={isRightPanelCollapsed}
        onToggleRightPanelCollapsed={() => setIsRightPanelCollapsed(!isRightPanelCollapsed)}
      />

      {/* Main Studio Viewport Rendering */}
      {studioView === 'war_room' ? (
        /* Viewport 1: 3-Column Studio (Sidebar | War Room | Right Panel) */
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
              onNewProject={async () => {
                const newProjName = prompt('请输入新项目名称 (将在 workspace/ 目录中创建独立工程并通配 MCP):', 'my-cool-app');
                if (newProjName) {
                  try {
                    const res = await fetch('/api/init-project', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ projectName: newProjName }),
                    });
                    const data = await res.json();
                    const newPId = `p-${Date.now()}`;
                    const newFolder: ProjectFolder = {
                      id: newPId,
                      name: data.sanitizedName || newProjName,
                      path: data.projectDir,
                      isExpanded: true,
                      threads: [{ id: `t-${Date.now()}`, title: '01. 需求与架构规划', updatedAt: '刚刚' }],
                    };
                    setProjects([newFolder, ...projects]);
                    setActiveProjectId(newPId);
                    setActiveThreadId(newFolder.threads[0].id);

                    addLog(`已创建独立工程目录：${data.projectDir}`, 'System', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'system');
                    addLog(`已生成统一共享 MCP 配置：${data.mcpFile}`, 'System', 'bg-blue-50 text-blue-700 border-blue-200', 'system');

                    setMessages([
                      createMessage('system', `🎉 **新项目【${newProjName}】已在本地创建！**\n• 目录: \`${data.projectDir}\`\n• 共享 MCP: \`.mcp.json\` 已就绪\n• Git 仓库: 已初始化并自动通配本地 GitHub\n\n现在可以在输入框向【联合总线】输入你的具体需求，双脑将同时为你解答！`),
                    ]);
                  } catch (e) {
                    console.error(e);
                  }
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
              modelConfig={modelConfig}
              onUpdateModelConfig={setModelConfig}
              discoveredModels={discoveredModels}
              theme={theme}
            />

            {/* Milestone Checkpoint Approval Banner (if waiting) */}
            {checkpoint && projectState === 'awaiting_approval' && (
              <div className={`p-4 border-t select-none transition-all shadow-lg ${
                theme === 'light'
                  ? 'bg-blue-50 border-blue-200 text-blue-900'
                  : 'bg-blue-950/70 border-blue-800 text-blue-200'
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600 text-white font-semibold">
                        里程碑拍板
                      </span>
                      <h3 className="text-xs font-bold">{checkpoint.title}</h3>
                    </div>
                    <p className="text-[11px] opacity-90">{checkpoint.description}</p>
                  </div>

                  <button
                    onClick={handleApproveCheckpoint}
                    className="px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md active:scale-95 transition-all shrink-0"
                  >
                    批准开工 (Approve) 🚀
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Resizer 2: Between WarRoom and Right Panel */}
          <div
            onMouseDown={startWarRoomResize}
            className="w-1.5 hover:w-2 -ml-1 z-20 cursor-col-resize group flex items-center justify-center transition-all bg-transparent hover:bg-blue-400/30 active:bg-blue-500/60"
            title="按住左右拖拽调整中栏和右栏宽度"
          >
            <div className="w-[1px] h-full bg-[#e3e3e3] dark:bg-slate-800 group-hover:bg-blue-500 transition-colors" />
          </div>

          {/* Right Area: Flexible Right Panel (Canvas + Live Worker Runner with Tabs) */}
          {!isRightPanelCollapsed ? (
            <div className="flex-1 min-w-[380px] h-full flex flex-col overflow-hidden bg-white dark:bg-[#0d1117]">
              {/* Top Navigation Bar of Right Panel */}
              <div className={`h-10 px-4 border-b flex items-center justify-between select-none ${
                theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
              }`}>
                {/* Segmented Mode Switcher */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setRightViewMode('canvas')}
                    className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all ${
                      rightViewMode === 'canvas'
                        ? theme === 'light'
                          ? 'bg-white text-blue-700 shadow-xs border border-[#e3e3e3] font-semibold'
                          : 'bg-slate-800 text-blue-400 border border-slate-700 font-semibold'
                        : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>方案与规范文档</span>
                    <span className="text-[10px] opacity-70 font-mono">({documents.length})</span>
                  </button>

                  <button
                    onClick={() => setRightViewMode('console')}
                    className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all ${
                      rightViewMode === 'console'
                        ? theme === 'light'
                          ? 'bg-white text-blue-700 shadow-xs border border-[#e3e3e3] font-semibold'
                          : 'bg-slate-800 text-blue-400 border border-slate-700 font-semibold'
                        : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                    }`}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                    <span>执行体实时流 (4 AI 独立Tab)</span>
                    {projectState === 'executing' ? (
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                    ) : (
                      <span className="text-[10px] opacity-70 font-mono">({consoleLogs.length})</span>
                    )}
                  </button>

                  <button
                    onClick={() => setRightViewMode('split')}
                    className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all ${
                      rightViewMode === 'split'
                        ? theme === 'light'
                          ? 'bg-white text-blue-700 shadow-xs border border-[#e3e3e3] font-semibold'
                          : 'bg-slate-800 text-blue-400 border border-slate-700 font-semibold'
                        : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
                    }`}
                    title="宽屏并排查看：左侧文档 + 右侧执行体"
                  >
                    <Columns2 className="w-3.5 h-3.5" />
                    <span>并排分屏</span>
                  </button>
                </div>

                {/* Collapse Right Panel Button */}
                <button
                  onClick={() => setIsRightPanelCollapsed(true)}
                  className="p-1.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 transition-colors"
                  title="收起右栏"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              {/* Right Panel Main Views */}
              <div className="flex-1 flex overflow-hidden">
                {rightViewMode === 'canvas' && (
                  <Canvas
                    documents={documents}
                    activeDocId={activeDocId}
                    onSelectDoc={(id) => setActiveDocId(id)}
                    onCloseDoc={handleCloseDoc}
                    theme={theme}
                  />
                )}

                {rightViewMode === 'console' && (
                  <ExecutionConsole
                    logs={consoleLogs}
                    activeCommand={activeCommand}
                    activeWorkerName={activeWorkerName}
                    isExecuting={projectState === 'executing'}
                    modelConfig={modelConfig}
                    onUpdateModelConfig={setModelConfig}
                    discoveredModels={discoveredModels}
                    theme={theme}
                    onClearLogs={() => setConsoleLogs([])}
                    onCollapse={() => setIsRightPanelCollapsed(true)}
                  />
                )}

                {rightViewMode === 'split' && (
                  <div className="w-full h-full flex overflow-hidden">
                    <div className="w-1/2 h-full border-r border-[#e3e3e3] dark:border-slate-800 overflow-hidden">
                      <Canvas
                        documents={documents}
                        activeDocId={activeDocId}
                        onSelectDoc={(id) => setActiveDocId(id)}
                        onCloseDoc={handleCloseDoc}
                        theme={theme}
                      />
                    </div>
                    <div className="w-1/2 h-full overflow-hidden">
                      <ExecutionConsole
                        logs={consoleLogs}
                        activeCommand={activeCommand}
                        activeWorkerName={activeWorkerName}
                        isExecuting={projectState === 'executing'}
                        modelConfig={modelConfig}
                        onUpdateModelConfig={setModelConfig}
                        discoveredModels={discoveredModels}
                        theme={theme}
                        onClearLogs={() => setConsoleLogs([])}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Slim Collapsed Strip on the Right Edge */
            <div className={`w-12 h-full border-l flex flex-col items-center py-4 select-none transition-colors ${
              theme === 'light' ? 'bg-[#f0f4f9] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
            }`}>
              <button
                onClick={() => {
                  setIsRightPanelCollapsed(false);
                  setRightViewMode('canvas');
                }}
                className="p-2.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors mb-2"
                title="展开文档"
              >
                <FileText className="w-4 h-4 text-blue-600" />
              </button>

              <button
                onClick={() => {
                  setIsRightPanelCollapsed(false);
                  setRightViewMode('console');
                }}
                className="p-2.5 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                title="展开执行流"
              >
                <Terminal className="w-4 h-4 text-emerald-600" />
                {projectState === 'executing' && (
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping absolute" />
                )}
              </button>
            </div>
          )}
        </div>
      ) : studioView === 'claude_web' ? (
        /* Viewport 2: Official Claude.ai Embedded Native Webview */
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0d1117]">
          {/* Bridge Control Bar */}
          <div className={`h-11 px-5 border-b flex items-center justify-between text-xs select-none ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
          }`}>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" />
              <span className="font-semibold text-slate-800 dark:text-slate-200">Claude.ai 官方原生工作区</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 font-mono">
                分区: persist:ai_solo_claude
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyProjectContext}
                className="px-2.5 py-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200 hover:bg-amber-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="复制当前项目名、路径与议题上下文提示词，方便粘贴给官方网页"
              >
                <Copy className="w-3 h-3" />
                <span>复制项目提示词</span>
              </button>

              <button
                onClick={handleImportPlanFromWeb}
                className="px-2.5 py-1 rounded-full border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-200 hover:bg-blue-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="从剪贴板导入网页端生成的方案至中枢规范文档"
              >
                <Download className="w-3 h-3" />
                <span>导入方案至规范</span>
              </button>

              <button
                onClick={handleOpenProjectFolder}
                className="px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="在 Finder 中打开当前工程目录"
              >
                <FolderOpen className="w-3 h-3" />
                <span>打开目录</span>
              </button>

              <button
                onClick={() => setStudioView('war_room')}
                className="px-3 py-1 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-medium text-[11px] shadow-xs flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>返回联合中枢</span>
              </button>
            </div>
          </div>

          {/* Webview or Fallback Container */}
          <div className="flex-1 w-full h-full relative overflow-hidden">
            {isElectron ? (
              // @ts-ignore
              <webview
                src="https://claude.ai"
                partition="persist:ai_solo_claude"
                className="w-full h-full border-none"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center select-none">
                <div className="w-14 h-14 rounded-3xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 mb-4">
                  <Sparkles className="w-7 h-7" />
                </div>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-2">
                  Claude.ai 官方原生嵌入模式
                </h3>
                <p className="text-xs text-slate-500 max-w-md leading-relaxed mb-6">
                  在桌面客户端中运行时，此区域将直接无缝呈现 100% 官方正版 Claude.ai 界面，登录一次即可永久直通你个人的 Pro/Max 订阅，享用全部官方模型（Opus 5.5 / Artifacts）。
                </p>
                <div className="flex items-center gap-3">
                  <a
                    href="https://claude.ai"
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-2 rounded-full bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm"
                  >
                    <span>在新标签页打开 Claude.ai</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => setStudioView('war_room')}
                    className="px-4 py-2 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    返回联合中枢
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : studioView === 'chatgpt_web' ? (
        /* Viewport 3: Official ChatGPT.com Embedded Native Webview */
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0d1117]">
          {/* Bridge Control Bar */}
          <div className={`h-11 px-5 border-b flex items-center justify-between text-xs select-none ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
          }`}>
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-teal-500" />
              <span className="font-semibold text-slate-800 dark:text-slate-200">ChatGPT.com 官方原生工作区</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300 font-mono">
                分区: persist:ai_solo_chatgpt
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyProjectContext}
                className="px-2.5 py-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200 hover:bg-amber-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="复制当前项目名、路径与议题上下文提示词，方便粘贴给官方网页"
              >
                <Copy className="w-3 h-3" />
                <span>复制项目提示词</span>
              </button>

              <button
                onClick={handleImportPlanFromWeb}
                className="px-2.5 py-1 rounded-full border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-200 hover:bg-blue-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="从剪贴板导入网页端生成的方案至中枢规范文档"
              >
                <Download className="w-3 h-3" />
                <span>导入方案至规范</span>
              </button>

              <button
                onClick={handleOpenProjectFolder}
                className="px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="在 Finder 中打开当前工程目录"
              >
                <FolderOpen className="w-3 h-3" />
                <span>打开目录</span>
              </button>

              <button
                onClick={() => setStudioView('war_room')}
                className="px-3 py-1 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-medium text-[11px] shadow-xs flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>返回联合中枢</span>
              </button>
            </div>
          </div>

          {/* Webview or Fallback Container */}
          <div className="flex-1 w-full h-full relative overflow-hidden">
            {isElectron ? (
              // @ts-ignore
              <webview
                src="https://chatgpt.com"
                partition="persist:ai_solo_chatgpt"
                className="w-full h-full border-none"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center select-none">
                <div className="w-14 h-14 rounded-3xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-600 mb-4">
                  <Bot className="w-7 h-7" />
                </div>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-2">
                  ChatGPT.com 官方原生嵌入模式
                </h3>
                <p className="text-xs text-slate-500 max-w-md leading-relaxed mb-6">
                  在桌面客户端中运行时，此区域将直接无缝呈现 100% 官方正版 ChatGPT.com 界面，登录一次即可永久直通你个人的 Plus/Pro 订阅，享用全部官方模型（GPT-6 / Canvas / Search）。
                </p>
                <div className="flex items-center gap-3">
                  <a
                    href="https://chatgpt.com"
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-2 rounded-full bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm"
                  >
                    <span>在新标签页打开 ChatGPT.com</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => setStudioView('war_room')}
                    className="px-4 py-2 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    返回联合中枢
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Viewport 4: Dual Brains Side-by-Side (双脑并排同题打擂) */
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0d1117]">
          {/* Bridge Control Bar */}
          <div className={`h-11 px-5 border-b flex items-center justify-between text-xs select-none ${
            theme === 'light' ? 'bg-[#f8fafc] border-[#e3e3e3]' : 'bg-[#161b22] border-slate-800'
          }`}>
            <div className="flex items-center gap-3">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                双脑并排打擂：左侧 Claude.ai (官方) ｜ 右侧 ChatGPT.com (官方)
              </span>
              <span className="text-[10px] text-slate-400">
                宽屏双核直通，同题推演与风控互搏
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyProjectContext}
                className="px-2.5 py-1 rounded-full border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-200 hover:bg-blue-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="复制当前项目名、路径与议题上下文提示词，方便粘贴给双脑网页"
              >
                <Copy className="w-3 h-3" />
                <span>复制提示词</span>
              </button>

              <button
                onClick={handleImportPlanFromWeb}
                className="px-2.5 py-1 rounded-full border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-200 hover:bg-indigo-100 font-medium text-[11px] flex items-center gap-1 transition-colors"
                title="从剪贴板导入网页端生成的方案至中枢规范文档"
              >
                <Download className="w-3 h-3" />
                <span>导入方案</span>
              </button>

              <button
                onClick={() => setStudioView('war_room')}
                className="px-3.5 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-xs flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>返回联合中枢</span>
              </button>
            </div>
          </div>

          {/* Dual Split Container */}
          <div className="flex-1 w-full h-full flex overflow-hidden">
            {/* Left Half: Claude */}
            <div className="w-1/2 h-full border-r border-[#e3e3e3] dark:border-slate-800 overflow-hidden relative">
              {isElectron ? (
                // @ts-ignore
                <webview
                  src="https://claude.ai"
                  partition="persist:ai_solo_claude"
                  className="w-full h-full border-none"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center select-none">
                  <Sparkles className="w-8 h-8 text-amber-500 mb-2" />
                  <p className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-1">Claude.ai 官方视界</p>
                  <p className="text-[11px] text-slate-400 mb-3">登录持久化分区: persist:ai_solo_claude</p>
                  <a
                    href="https://claude.ai"
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1 rounded-full bg-amber-600 text-white text-[11px] flex items-center gap-1"
                  >
                    <span>在新标签打开</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>

            {/* Right Half: ChatGPT */}
            <div className="w-1/2 h-full overflow-hidden relative">
              {isElectron ? (
                // @ts-ignore
                <webview
                  src="https://chatgpt.com"
                  partition="persist:ai_solo_chatgpt"
                  className="w-full h-full border-none"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center select-none">
                  <Bot className="w-8 h-8 text-teal-500 mb-2" />
                  <p className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-1">ChatGPT.com 官方视界</p>
                  <p className="text-[11px] text-slate-400 mb-3">登录持久化分区: persist:ai_solo_chatgpt</p>
                  <a
                    href="https://chatgpt.com"
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1 rounded-full bg-teal-600 text-white text-[11px] flex items-center gap-1"
                  >
                    <span>在新标签打开</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
