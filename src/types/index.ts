export type AgentRole = 'user' | 'claude' | 'chatgpt' | 'system' | 'worker';

export interface ChatMessage {
  id: string;
  sender: AgentRole;
  senderName: string;
  avatarColor: string;
  roleBadge: string;
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export type WorkerType = 'cursor' | 'claude_code' | 'antigravity' | 'deepseek';

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  assignedTo: WorkerType;
  workerName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'failed';
  progress: number;
  outputSummary?: string;
}

export type ProjectState = 'idle' | 'discussing' | 'awaiting_approval' | 'executing' | 'paused' | 'completed';

export interface MilestoneCheckpoint {
  id: string;
  title: string;
  description: string;
  deliverables: string[];
  suggestedAction: string;
}
