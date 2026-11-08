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
  /** 施工模式下不应出现的审批请求（已自动拒绝）；界面据此显示“意外的权限请求” */
  anomaly?: true;
}

/** 启动后核验通过时报告的实际生效情况（供时间线/验收卡记录） */
export interface IsolationInfo {
  model?: string | undefined;
  /** 实际生效的指令来源（如用户级 AGENTS.md 的路径）：只是路径，不含内容 */
  instructionSources: string[];
  approvalPolicy: string;
  sandbox: string;
  /** 实际生效的权限（取自 thread/start 响应，与期望核验一致后才会出现） */
  permissions?: EffectivePermissions;
  grantedMcp: string[];
  modelProvider?: string | undefined;
  /** 需要提醒的事项，例如“数据将发往非官方地址：<地址>” */
  warnings: string[];
}

export type ExecutorEvent =
  | { type: 'message'; text: string; /** 适配器自己加的说明（不是 AI 的话） */ source?: 'host' }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'isolation'; info: IsolationInfo }
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
  /** 底层执行体进程号（进程启动后才有；模拟执行体没有）。只用于启动核对时判断执行体是否仍在运行。 */
  readonly pid?: number | undefined;
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

import type { Capabilities } from '../capabilities/model.js';
import type { EffectivePermissions, FullTrustRecords } from './modes.js';
import type { SandboxCommandRunner } from '../checks/scripts.js';

export interface StartOptions {
  /** 任务编号（完全信任门禁按它查任务记录里的确认标记） */
  taskId?: string;
  /** 任务记录读取接口（完全信任门禁用）；缺省视为没有任何确认 */
  fullTrustRecords?: FullTrustRecords;
  /** 任务 worktree 的绝对路径；执行体只能在此目录内工作 */
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  /** 授予的能力；缺省为最小权限 */
  capabilities?: Capabilities;
}

export interface Executor {
  readonly id: string;
  readonly displayName: string;
  /** 能力声明：界面据此决定显示什么，不伪装不支持的能力 */
  readonly capabilities: { permissionPrompts: boolean; resumeAfterStop: boolean };
  detect(): Promise<DetectResult>;
  start(opts: StartOptions): ExecutorRun;
  /** 在与施工相同的权限配置档下运行项目脚本的运行器；没有则脚本检查一律为“未检查”（不回退到宿主运行） */
  readonly sandboxRunner?: SandboxCommandRunner;
}

export function isExitSuccess(o: ExitOutcome): boolean {
  return o.kind === 'exited' && o.code === 0;
}
