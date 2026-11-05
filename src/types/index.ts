export type AgentRole = 'user' | 'claude' | 'chatgpt' | 'system' | 'worker';

export type WorkerType = 'cursor' | 'claude_code' | 'antigravity' | 'deepseek';

export type DialogueTarget = 'all_pms' | 'claude' | 'chatgpt' | 'cursor' | 'antigravity';

export interface CanvasDocument {
  id: string;
  title: string;
  type: 'markdown' | 'code' | 'diff';
  content: string;
  sourceAgent?: string;
  updatedAt: string;
  meta?: {
    sha?: string;
    filesCount?: number;
    testPassed?: boolean;
  };
}

export interface ChatMessage {
  id: string;
  sender: AgentRole;
  senderName: string;
  avatarColor: string;
  roleBadge: string;
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  forwardedFrom?: string; // e.g. "由 ChatGPT 从另一个聊天发送"
  linkedDocId?: string;   // Reference to CanvasDocument
  docPreviewTitle?: string;
  target?: DialogueTarget;
}

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

export interface ThreadItem {
  id: string;
  title: string;
  unreadCount?: number;
  updatedAt?: string;
}

export interface ProjectFolder {
  id: string;
  name: string;
  isCurrent?: boolean;
  isExpanded: boolean;
  threads: ThreadItem[];
}

export interface RoleAssignment {
  claudeRole: string;
  chatgptRole: string;
  cursorRole: string;
  antigravityRole: string;
}
