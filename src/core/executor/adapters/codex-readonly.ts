/**
 * 只读启动参数（仅供思考层使用，不是施工模式）：旧式沙箱配置键 + “每条命令都询问”。
 * 施工模式一律走 modes.ts 的权限配置档；两种写法绝不在同一次启动里并用，
 * 因此旧式沙箱配置键只出现在本文件，权限配置档只出现在 modes.ts（安全断言逐文件检查）。
 */
import type { ModeExpectation } from '../modes.js';

export interface ReadOnlyLaunch {
  args: string[];
  threadStart: Record<string, unknown>;
  turnOverrides: Record<string, unknown>;
  expected: ModeExpectation;
  describe: string;
}

/**
 * app-server 的配置层 approval_policy 只接受 on-request（untrusted 会让它拒绝启动，见 ADR 0001）；
 * “每条命令都询问”只能通过 thread/start 与 turn/start 的参数声明。
 */
export function readOnlyLaunch(cwd: string): ReadOnlyLaunch {
  return {
    args: ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="on-request"'],
    threadStart: { cwd, approvalPolicy: 'untrusted', sandbox: 'read-only' },
    turnOverrides: { cwd, approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } },
    expected: { mode: 'read_only', approvalPolicy: 'untrusted', sandboxType: 'readOnly', networkEnabled: false, allowedDomains: [] },
    describe: '只读（思考层）：沙箱只读；每条命令询问；网络关闭',
  };
}
