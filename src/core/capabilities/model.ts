/**
 * 能力模型（需求 v1.5 第 5.1 节；B3 起按“施工模式”调整）：
 * 默认值就是最小权限；放宽必须在计划里显式写出，由用户批准。
 *
 * B3：施工中不再有任何审批（审批策略恒为 never，见 executor/modes.ts）；所有授权在开工前一次完成。
 * 因此旧的“命令执行：每条询问 / 沙箱内自动”不再存在。
 */
export type FileAccess = 'worktree_write' | 'worktree_read_only';
export type ExternalNetwork = 'off' | 'on';
/** 标准模式（默认）：权限配置档，系统强制。完全信任：danger-full-access，只能经任务级确认进入。 */
export type ConstructionModeName = 'standard' | 'full_trust';

export interface Capabilities {
  fileAccess: FileAccess;
  externalNetwork: ExternalNetwork;
  /** 凭证访问：只有一个取值，永远不提供 */
  credentialAccess: 'none';
  /** 授予的 MCP 服务器名称（默认空；每一项都属于上述某类能力，计划卡须逐个说明风险） */
  grantedMcp: string[];
  /**
   * 模型服务地址不是官方默认（api.openai.com / chatgpt.com）时是否仍允许开始：
   * 数据会发往用户配置的其他地址。默认 deny；只能由任务能力显式允许。
   */
  nonOfficialModelEndpoint: 'deny' | 'allow';
  /** 施工模式。默认 standard；full_trust 还需要任务记录中的确认标记（门禁函数 requireFullTrustConfirmed）。 */
  constructionMode: ConstructionModeName;
  /** 扩展权限：用户选定的额外可写目录（绝对路径） */
  extraWritableDirs: string[];
  /** 扩展权限：联网开启时只放行的域名（空 = 不限域名；需要官方网络代理功能） */
  allowedNetworkDomains: string[];
}

export const DEFAULT_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  fileAccess: 'worktree_write',
  externalNetwork: 'off',
  credentialAccess: 'none',
  grantedMcp: [],
  nonOfficialModelEndpoint: 'deny',
  constructionMode: 'standard',
  extraWritableDirs: [],
  allowedNetworkDomains: [],
});

/** 用默认值补全，并拒绝任何试图授予凭证访问的输入。 */
export function resolveCapabilities(input?: Partial<Capabilities> | null): Capabilities {
  const c = { ...DEFAULT_CAPABILITIES, grantedMcp: [], extraWritableDirs: [], allowedNetworkDomains: [], ...(input ?? {}) } as Capabilities;
  if (c.credentialAccess !== 'none') throw new Error('不能授予凭证访问。');
  if (!['worktree_write', 'worktree_read_only'].includes(c.fileAccess)) throw new Error(`无效的文件权限：${String(c.fileAccess)}`);
  if (!['off', 'on'].includes(c.externalNetwork)) throw new Error(`无效的网络权限：${String(c.externalNetwork)}`);
  if (!['deny', 'allow'].includes(c.nonOfficialModelEndpoint)) throw new Error('无效的模型服务地址策略。');
  if (!['standard', 'full_trust'].includes(c.constructionMode)) throw new Error(`无效的施工模式：${String(c.constructionMode)}`);
  if (!Array.isArray(c.grantedMcp) || c.grantedMcp.some((n) => typeof n !== 'string' || !n)) throw new Error('无效的 MCP 授予列表。');
  if (!Array.isArray(c.extraWritableDirs) || c.extraWritableDirs.some((d) => typeof d !== 'string' || !d.startsWith('/'))) throw new Error('额外可写目录必须是绝对路径。');
  if (!Array.isArray(c.allowedNetworkDomains) || c.allowedNetworkDomains.some((d) => typeof d !== 'string' || !/^[a-z0-9*.-]+$/i.test(d))) throw new Error('无效的网络域名列表。');
  if (c.allowedNetworkDomains.length && c.externalNetwork !== 'on') throw new Error('指定放行域名必须同时开启联网。');
  return { ...c, grantedMcp: [...new Set(c.grantedMcp)], extraWritableDirs: [...new Set(c.extraWritableDirs)], allowedNetworkDomains: [...new Set(c.allowedNetworkDomains)] };
}
