import { ChatMessage, TaskItem, MilestoneCheckpoint } from '../types';

export const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'welcome-1',
    sender: 'system',
    senderName: '系统总线',
    avatarColor: 'bg-slate-700',
    roleBadge: 'System',
    content: '欢迎进入 **AI Solo Studio** 虚拟工作室！\n\n在这里，你只需用大白话输入项目想法。**Claude（主架构师）** 与 **ChatGPT（风控与评审）** 将在右侧对话室内展开即时磋商，为你拆解任务，并调度 **Cursor / Claude Code** 施工队落地代码。\n\n随时可以按下顶部的 **【紧急暂停】** 或在关键节点拍板！',
    timestamp: '刚刚',
  },
];

export function createMessage(sender: ChatMessage['sender'], content: string): ChatMessage {
  const meta = {
    user: { name: '你 (创始人)', color: 'bg-emerald-600', badge: 'CEO / 决策者' },
    claude: { name: 'Claude 3.7', color: 'bg-amber-600', badge: '首席架构师' },
    chatgpt: { name: 'ChatGPT 4o', color: 'bg-teal-600', badge: '技术评审 & 风控' },
    system: { name: '调度总线', color: 'bg-blue-600', badge: '流程中控' },
    worker: { name: '施工播报员', color: 'bg-purple-600', badge: '工头简报' },
  }[sender];

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    sender,
    senderName: meta.name,
    avatarColor: meta.color,
    roleBadge: meta.badge,
    content,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}
