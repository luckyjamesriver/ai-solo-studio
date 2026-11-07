/** 执行体（AI 编码 Agent）的统一接口。真实适配器与模拟执行体都实现它。 */

export type PermissionKind =
  | 'read_file'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'network'
  | 'other';

export interface PermissionRequest {
  id: string;
  kind: PermissionKind;
  /** 涉及的路径（相对或绝对），若有 */
  paths?: string[];
  /** 将运行的命令（参数数组形式），若有 */
  command?: string[];
  /** 执行体给出的原始描述，仅供展示 */
  description: string;
}

/** 用户拒绝（或系统明确未执行）的操作，结构化记录，供验收卡使用。 */
export interface DeniedOperation {
  kind: PermissionKind;
  /** 命令（参数数组形式），若有 */
  command?: string[];
  paths?: string[];
  /** 展示用描述 */
  description: string;
  risk: 'low' | 'medium' | 'high';
}

export type ExecutorEvent =
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; outcome: ExitOutcome; /** 本次执行中被拒绝、因此没有执行的操作 */ denied?: DeniedOperation[] };

/** 与 proc 的结果对齐：成功只有一种形态。 */
export type ExitOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: string }
  | { kind: 'stopped' }
  | { kind: 'timed_out' }
  | { kind: 'spawn_error'; message: string };

export type Decision = 'allow' | 'deny';

export interface ExecutorRun {
  events: AsyncIterable<ExecutorEvent>;
  respond(requestId: string, decision: Decision): Promise<void>;
  /** 真实停止底层进程。 */
  stop(): Promise<void>;
}

export interface DetectResult {
  installed: boolean;
  loggedIn: 'yes' | 'no' | 'unknown';
  version?: string;
  /** 版本是否为经过验证的版本（未知版本不阻止使用，仅提示） */
  verified?: boolean;
  /** 无法在会话中关闭、但本机存在的用户级扩展（只报告是否存在，不读取内容） */
  isolationNotes?: string[];
  note?: string;
}

export interface StartOptions {
  /** 任务 worktree 的绝对路径；执行体只能在此目录内工作 */
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

export interface Executor {
  readonly id: string;
  readonly displayName: string;
  /** 能力声明：界面据此决定显示什么，不伪装不支持的能力 */
  readonly capabilities: { permissionPrompts: boolean; resumeAfterStop: boolean };
  detect(): Promise<DetectResult>;
  start(opts: StartOptions): ExecutorRun;
}

export function isExitSuccess(o: ExitOutcome): boolean {
  return o.kind === 'exited' && o.code === 0;
}
