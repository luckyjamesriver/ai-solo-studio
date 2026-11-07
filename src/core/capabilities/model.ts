/**
 * 能力模型（需求 v1.5 第 5.1 节）：四类能力分别控制，外加“授予的 MCP 列表”。
 * 默认值就是最小权限；放宽必须在计划里显式写出，由用户批准。
 */
export type FileAccess = 'worktree_write' | 'worktree_read_only';
/**
 * 命令执行：
 * - ask_each：每条命令都先询问（含沙箱内的命令；运行项目脚本本身就是命令执行，可启动任意子进程）。默认。
 * - sandbox_auto：沙箱内的命令不询问，只有要越出沙箱时才询问（较弱，必须由计划显式选择）。
 */
export type CommandExecution = 'ask_each' | 'sandbox_auto';
export type ExternalNetwork = 'off' | 'on';

export interface Capabilities {
  fileAccess: FileAccess;
  commandExecution: CommandExecution;
  externalNetwork: ExternalNetwork;
  /** 凭证访问：只有一个取值，永远不提供 */
  credentialAccess: 'none';
  /** 授予的 MCP 服务器名称（默认空；每一项都属于上述某类能力，计划卡须逐个说明风险） */
  grantedMcp: string[];
}

export const DEFAULT_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  fileAccess: 'worktree_write',
  commandExecution: 'ask_each',
  externalNetwork: 'off',
  credentialAccess: 'none',
  grantedMcp: [],
});

/** 用默认值补全，并拒绝任何试图授予凭证访问的输入。 */
export function resolveCapabilities(input?: Partial<Capabilities> | null): Capabilities {
  const c = { ...DEFAULT_CAPABILITIES, grantedMcp: [], ...(input ?? {}) } as Capabilities;
  if (c.credentialAccess !== 'none') throw new Error('不能授予凭证访问。');
  if (!['worktree_write', 'worktree_read_only'].includes(c.fileAccess)) throw new Error(`无效的文件权限：${String(c.fileAccess)}`);
  if (!['ask_each', 'sandbox_auto'].includes(c.commandExecution)) throw new Error(`无效的命令权限：${String(c.commandExecution)}`);
  if (!['off', 'on'].includes(c.externalNetwork)) throw new Error(`无效的网络权限：${String(c.externalNetwork)}`);
  if (!Array.isArray(c.grantedMcp) || c.grantedMcp.some((n) => typeof n !== 'string' || !n)) throw new Error('无效的 MCP 授予列表。');
  return { ...c, grantedMcp: [...new Set(c.grantedMcp)] };
}
