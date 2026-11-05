import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { WarRoom } from './components/WarRoom';
import { TaskBoard } from './components/TaskBoard';
import { ExecutionConsole } from './components/ExecutionConsole';
import { ChatMessage, TaskItem, MilestoneCheckpoint, ProjectState } from './types';
import { INITIAL_MESSAGES, createMessage } from './coordinator/workflow';

interface ConsoleLog {
  id: string;
  time: string;
  type: 'stdout' | 'stderr' | 'system' | 'diff';
  text: string;
}

export const App: React.FC = () => {
  const [projectState, setProjectState] = useState<ProjectState>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [checkpoint, setCheckpoint] = useState<MilestoneCheckpoint | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([
    {
      id: 'log-1',
      time: '00:00:01',
      type: 'system',
      text: '[Runner] AI Solo Studio 本地执行环境初始化就绪。支持调用本地已登录的 CLI (Claude Code, Cursor, Antigravity)。',
    },
  ]);
  const [activeCommand, setActiveCommand] = useState<string>('');

  // Execution state references for pausing
  const isPausedRef = useRef(false);
  isPausedRef.current = projectState === 'paused';

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
      // User is intervening
      const systemAck = createMessage(
        'system',
        `已收到老板的干预指令：“${text}”。Claude 和 ChatGPT 正在重新调准方向并更新施工计划。`
      );
      setMessages((prev) => [...prev, systemAck]);
      addLog(`[INTERVENE] 用户干预指令注入: ${text}`, 'system');
      return;
    }

    // Normal new Idea flow: Trigger Co-PM Consultation
    setProjectState('discussing');
    addLog(`[ORCHESTRATOR] 接收到新想法: "${text}"。正在唤醒 Claude 与 ChatGPT 展开跨模型磋商...`, 'system');

    // Step 1: Claude Architect responds
    setTimeout(() => {
      const claudeMsg = createMessage(
        'claude',
        `收到老板的需求！这个方向非常实用。我从系统架构层面做初步规划：\n\n1. **技术选型**：建议采用轻量模块化方案，保持零多余依赖，确保一次性跑通；\n2. **核心模块划分**：\n   - 模块 A：基础框架与数据持久化逻辑；\n   - 模块 B：交互界面与操作入口；\n   - 模块 C：本地自测与结果格式化输出。\n\n请 ChatGPT 进行审查，指出可能的边缘用例或潜在漏洞。`
      );
      setMessages((prev) => [...prev, claudeMsg]);
      addLog('[Co-PM] Claude 架构师方案起草完毕，转交 ChatGPT 审查...', 'stdout');

      // Step 2: ChatGPT Risk Reviewer responds
      setTimeout(() => {
        const gptMsg = createMessage(
          'chatgpt',
          `完全赞同 Claude 的模块划分。我补充两点关键风控考量：\n\n1. **防崩溃与容错**：在数据持久化时必须处理空值和权限异常；\n2. **小白友好度**：避免引入复杂环境，尽量生成单一入口文件，让用户双击或一键就能看效果。\n\n**共识达成**：我建议拆解为 3 个执行阶段，交由 Cursor 和 Claude Code 分别执行。`
        );
        setMessages((prev) => [...prev, gptMsg]);
        addLog('[Co-PM] ChatGPT 审查通过，达成一致共识。开始自动生成任务工单...', 'stdout');

        // Step 3: Generate Task Matrix
        setTimeout(() => {
          const generatedTasks: TaskItem[] = [
            {
              id: 'task-1',
              title: '阶段一：初始化工程骨架与配置',
              description: '搭建项目根目录结构，配置基础运行环境与轻量依赖。',
              assignedTo: 'cursor',
              workerName: 'Cursor Agent',
              status: 'pending',
              progress: 0,
            },
            {
              id: 'task-2',
              title: '阶段二：编写核心功能与主逻辑',
              description: '实现具体业务逻辑、数据存取与错误捕获机制。',
              assignedTo: 'claude_code',
              workerName: 'Claude Code CLI',
              status: 'pending',
              progress: 0,
            },
            {
              id: 'task-3',
              title: '阶段三：本地自动化构建测试与交付',
              description: '执行自动化语法校验、运行功能冒烟测试并生成应用产物。',
              assignedTo: 'antigravity',
              workerName: 'Antigravity Runner',
              status: 'pending',
              progress: 0,
            },
          ];

          setTasks(generatedTasks);

          const cp: MilestoneCheckpoint = {
            id: 'cp-1',
            title: '里程碑 1：施工蓝图确认',
            description: 'Claude 与 ChatGPT 已完成需求细化与风控推演，制定了以上 3 个工单。',
            deliverables: ['工程基础骨架代码', '完整业务逻辑模块', '自测通过的发布版本'],
            suggestedAction: '请老板拍板批准，点击后将自动调度底层施工队敲代码。',
          };
          setCheckpoint(cp);
          setProjectState('awaiting_approval');

          const sysPrompt = createMessage(
            'system',
            '📋 **工单已制定完成！**\n请在右侧看板检阅任务，点击【批准开工】即可启动全自动流水线。如需调整，可直接在下方输入修改意见。'
          );
          setMessages((prev) => [...prev, sysPrompt]);
          addLog('[CHECKPOINT] 等待老板审批开工权限...', 'system');
        }, 1000);
      }, 1400);
    }, 1000);
  };

  // Boss clicks "Approve" on Checkpoint
  const handleApproveCheckpoint = () => {
    setProjectState('executing');
    addLog('[DISPATCH] 老板已批准！正在向底层施工队下发指令...', 'system');

    const approveMsg = createMessage('user', '✅ 批准开工！立即执行。');
    const startMsg = createMessage(
      'system',
      '🚀 **施工流水线启动！** 底层执行体正在工作区进行代码构建。可在底部展开控制台查看实时日志。'
    );
    setMessages((prev) => [...prev, approveMsg, startMsg]);

    runTaskPipeline(0);
  };

  // Sequential Execution Pipeline with Human Pause support
  const runTaskPipeline = (taskIndex: number) => {
    setTasks((prev) => {
      if (taskIndex >= prev.length) {
        // All tasks completed
        setProjectState('completed');
        setActiveCommand('');
        addLog('[COMPLETE] 所有工单施工完毕，测试全部通过！', 'system');
        const doneMsg = createMessage(
          'worker',
          '🎉 **报告老板：所有规划任务已 100% 施工完毕！**\n\n已成功生成代码文件并在本地工作区通过所有构建测试。你可以检阅项目成果，或继续输入新的需求想法！'
        );
        setMessages((m) => [...m, doneMsg]);
        return prev;
      }

      const updated = [...prev];
      updated[taskIndex] = { ...updated[taskIndex], status: 'in_progress', progress: 10 };
      return updated;
    });

    const currentTask = tasks[taskIndex] || {
      title: '执行任务',
      assignedTo: 'cursor',
      workerName: 'Worker',
    };
    setActiveCommand(`${currentTask.workerName} execute --job ${taskIndex + 1}`);
    addLog(`[TASK-${taskIndex + 1} START] 调度 ${currentTask.workerName} 执行: ${currentTask.title}`, 'system');

    // Simulate real execution progression with log streams
    let currentProgress = 10;
    const interval = setInterval(() => {
      if (isPausedRef.current) {
        addLog(`[PAUSED] 任务 ${taskIndex + 1} 已响应全局紧急暂停，进程挂起中...`, 'stderr');
        return;
      }

      currentProgress += 30;
      if (currentProgress < 100) {
        setTasks((prev) => {
          const next = [...prev];
          if (next[taskIndex]) next[taskIndex].progress = currentProgress;
          return next;
        });
        addLog(`[${currentTask.workerName}] 写入文件 src/module_${taskIndex + 1}.ts (+48 lines)`, 'diff');
      } else {
        clearInterval(interval);
        setTasks((prev) => {
          const next = [...prev];
          if (next[taskIndex]) {
            next[taskIndex].progress = 100;
            next[taskIndex].status = 'completed';
          }
          return next;
        });

        addLog(`[TASK-${taskIndex + 1} DONE] ${currentTask.title} 执行成功，退出码 0。`, 'system');

        // De-noised report sent back to War Room
        const report = createMessage(
          'worker',
          `📌 **工头简报 [阶段 ${taskIndex + 1}] 完成**\n由 **${currentTask.workerName}** 施工完毕：\n- 状态：成功通过校验 (ExitCode: 0)\n- 变更：已更新工作区源码，无语法错误。\n\n▶ 正在自动推进下一步...`
        );
        setMessages((m) => [...m, report]);

        // Proceed to next task after brief delay
        setTimeout(() => {
          runTaskPipeline(taskIndex + 1);
        }, 1200);
      }
    }, 900);
  };

  // Pause Button
  const handlePause = () => {
    setProjectState('paused');
    addLog('[EMERGENCY PAUSE] 🔴 用户触发了紧急暂停！所有执行流与命令已就地冻结。', 'stderr');
    const pauseMsg = createMessage(
      'system',
      '⏸️ **紧急暂停已生效！**\n所有后台 AI 执行体已停止操作。你可以在左下方输入任何调整意见，或点击顶部的【继续推进】恢复流转。'
    );
    setMessages((prev) => [...prev, pauseMsg]);
  };

  // Resume Button
  const handleResume = () => {
    setProjectState('executing');
    addLog('[RESUME] 🟢 紧急暂停已解除，恢复自动化施工流水线。', 'system');
    const resumeMsg = createMessage('system', '▶️ **已恢复执行！** 施工队继续作业。');
    setMessages((prev) => [...prev, resumeMsg]);
  };

  // Reset Board
  const handleReset = () => {
    setProjectState('idle');
    setTasks([]);
    setCheckpoint(null);
    setMessages(INITIAL_MESSAGES);
    setActiveCommand('');
    addLog('[RESET] 看板与状态机已重置为初始待命状态。', 'system');
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0b0e14] text-slate-100 overflow-hidden font-sans">
      {/* Top Header */}
      <Header
        projectState={projectState}
        onPause={handlePause}
        onResume={handleResume}
        onReset={handleReset}
      />

      {/* Main Studio Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: War Room (Claude & ChatGPT co-op chat) */}
        <WarRoom
          messages={messages}
          projectState={projectState}
          onSendMessage={handleSendMessage}
        />

        {/* Right: Task Matrix & Milestone Checkpoints */}
        <TaskBoard
          tasks={tasks}
          checkpoint={checkpoint}
          projectState={projectState}
          onApproveCheckpoint={handleApproveCheckpoint}
          onRequestChange={() => handleSendMessage('请重新审视方案，我需要一些修改。')}
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
