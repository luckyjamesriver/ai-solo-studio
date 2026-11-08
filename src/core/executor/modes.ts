/**
 * 施工模式映射（B3-1）：把“模式 + 扩展权限”翻译成 Codex 的启动参数与线程/回合参数。
 * 这是源码中唯一允许出现审批策略 never 与完全信任沙箱字样的位置（安全断言见 tests/security.test.ts）。
 *
 * - 标准模式：官方“权限配置档”（default_permissions + 内联 permissions.<id>，文档标注 Beta）。
 *   可写 = 任务副本（及用户选定的额外目录）；读取拒绝清单；网络默认关；审批策略 never（越界直接失败，不挂起）。
 *   不使用旧式沙箱配置键（与权限配置档不能并用，官方文档明确），线程/回合也不再传旧式沙箱参数。
 * - 完全信任模式：只能经 requireFullTrustConfirmed(taskId) 进入。
 */
import os from 'node:os';
import path from 'node:path';

export type ConstructionMode = 'standard' | 'full_trust';

/** 读取任务记录里“本任务已确认完全信任”的标记（任务存储的最小接口，便于测试注入）。 */
export interface FullTrustRecords {
  get(taskId: string): Promise<{ fullTrustConfirmedAt?: string } | null | undefined>;
}

/**
 * 完全信任的唯一门禁：任务记录中没有本任务的确认标记就抛错。
 * 确认只属于单个任务（每个任务开工时单独确认），项目偏好不能代替。
 */
export async function requireFullTrustConfirmed(taskId: string, records: FullTrustRecords): Promise<void> {
  const rec = await records.get(taskId);
  if (!rec?.fullTrustConfirmedAt) throw new Error(`任务 ${taskId} 尚未确认完全信任，不能以完全信任模式运行。`);
}

export interface ModeExpectation {
  /** read_only 只给思考层用（codex-readonly.ts），不是施工模式 */
  mode: ConstructionMode | 'read_only';
  approvalPolicy: string;
  /** 标准模式：期望的 activePermissionProfile.id */
  profileId?: string;
  /** 完全信任 / 只读：期望的线程沙箱类型 */
  sandboxType?: 'dangerFullAccess' | 'readOnly';
  /** 期望的网络状态（标准模式：权限配置档里的 network.enabled） */
  networkEnabled: boolean;
  /** 域名级限制（只放行这些域名）；空表示不限制域名 */
  allowedDomains: string[];
}

export interface ModeLaunch {
  mode: ConstructionMode;
  /** 追加到 app-server 命令行的参数（成对的 -c 与值，以及 --enable） */
  args: string[];
  threadStart: Record<string, unknown>;
  turnOverrides: Record<string, unknown>;
  expected: ModeExpectation;
  /** 供“实际生效权限”记录用的人读摘要（不含机密） */
  describe: string;
}

export interface StandardModeOptions {
  /** 任务副本（唯一默认可写目录） */
  cwd: string;
  /** 用户选定的额外可写目录（扩展权限，必须是绝对路径） */
  extraWritable?: string[];
  /** 扩展权限：允许联网 */
  network?: boolean;
  /** 网络开启时只放行这些域名（需要官方网络代理功能）；缺省不限制域名 */
  allowedDomains?: string[];
  /** 读取拒绝：路径列表（绝对路径）。默认 = 整个用户主目录，再把副本与额外可写目录重新放行 */
  denyRead?: string[];
  /** 读取拒绝之下重新放行为只读的路径（例如运行必需的位置） */
  reopenRead?: string[];
  profileId?: string;
}

export const STANDARD_PROFILE_ID = 'studio_standard';

/** TOML 字符串（基本字符串）：反斜杠与双引号转义 */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function assertAbsolute(p: string, what: string) {
  if (!path.isAbsolute(p)) throw new Error(`${what}必须是绝对路径：${p}`);
}

/**
 * 主目录整体拒绝：B3-1 实测可强制，但在 macOS 上不可用于真实项目——
 * node 解析脚本路径时要 lstat 主目录本身（EPERM），npm test 与直接 node 运行都失败；git 读不到 ~/.gitconfig。
 * 用环境变量补救（HOME 指向副本内、--preserve-symlinks-main）会让 npm 自身无法加载。因此不作为默认，仅保留供实验。
 */
export function homeDenyList(home = os.homedir()): string[] {
  return [home];
}

/**
 * 默认读取拒绝清单：固定敏感清单（相对用户主目录）。界面须如实写“已阻止读取这些敏感位置；其他位置 AI 仍可读取”，不得称“已隔离”。
 * 不含整个 ~/.config（会让 git 对 ~/.config/git/ignore 报警告）；只列凭证类子目录。清单永远不可能完整。
 */
export function sensitiveFallbackList(home = os.homedir()): string[] {
  return [
    '.ssh', '.aws', '.gnupg', '.netrc', '.docker', '.kube', '.azure',
    '.config/gh', '.config/gcloud', '.config/op',
    '.codex/auth.json', '.codex/skills',
    'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Safari',
  ].map((r) => path.join(home, r));
}

export function buildStandardMode(o: StandardModeOptions): ModeLaunch {
  assertAbsolute(o.cwd, '任务副本路径');
  const extra = o.extraWritable ?? [];
  for (const e of extra) assertAbsolute(e, '额外可写目录');
  const deny = o.denyRead ?? sensitiveFallbackList();
  for (const d of deny) assertAbsolute(d, '读取拒绝路径');
  const reopen = o.reopenRead ?? [];
  const id = o.profileId ?? STANDARD_PROFILE_ID;
  const network = o.network === true;
  const domains = network ? (o.allowedDomains ?? []) : [];

  // filesystem：先 deny，再对更具体的路径重新放行（官方：更具体的条目覆盖更宽的条目）
  const fs: string[] = [
    // 实测（B3-1）：:workspace 默认允许写 /tmp 与 $TMPDIR，会让 AI 在副本之外落盘；这里显式收回为只读（官方特殊路径 :slash_tmp / :tmpdir）
    '":slash_tmp"="read"',
    '":tmpdir"="read"',
    ...deny.map((d) => `${q(d)}="deny"`),
    ...reopen.map((r) => `${q(r)}="read"`),
    // 注意：任务副本即会话 cwd（工作区根），:workspace 已给它写权限；若它位于被拒绝的目录之下，需要显式重新放行
    `${q(o.cwd)}="write"`,
    ...extra.map((e) => `${q(e)}="write"`),
  ];
  const net = network ? `, network={enabled=true${domains.length ? `, domains={${domains.map((d) => `${q(d)}="allow"`).join(', ')}}` : ''}}` : '';
  const profile = `permissions.${id}={extends=":workspace", filesystem={${fs.join(', ')}}${net}}`;
  const args = ['-c', `default_permissions=${q(id)}`, '-c', profile, ...(domains.length ? ['-c', 'features.network_proxy=true'] : [])];
  return {
    mode: 'standard',
    args,
    // 不传旧式 sandbox / sandboxPolicy：线程与回合沿用权限配置档（实测见 B3-1 报告）
    threadStart: { cwd: o.cwd, approvalPolicy: 'never' },
    turnOverrides: { cwd: o.cwd, approvalPolicy: 'never' },
    expected: { mode: 'standard', approvalPolicy: 'never', profileId: id, networkEnabled: network, allowedDomains: domains },
    describe: `标准模式：可写 ${[o.cwd, ...extra].join('、')}；读取拒绝 ${deny.join('、') || '无'}；网络${network ? (domains.length ? `开启（仅 ${domains.join('、')}）` : '开启（不限域名）') : '关闭'}；审批 never`,
  };
}

/**
 * 完全信任：danger-full-access + never。
 * 必须经 requireFullTrustConfirmed——该函数在这里调用，是“门禁必经”断言检查的对象。
 */
export async function buildFullTrustMode(taskId: string, cwd: string, records: FullTrustRecords): Promise<ModeLaunch> {
  await requireFullTrustConfirmed(taskId, records);
  return {
    mode: 'full_trust',
    args: [],
    threadStart: { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' },
    turnOverrides: { cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    expected: { mode: 'full_trust', approvalPolicy: 'never', sandboxType: 'dangerFullAccess', networkEnabled: true, allowedDomains: [] },
    describe: '完全信任模式：AI 拥有你账户的全部权限（读写任意文件、联网）；审批 never',
  };
}

/** 生效权限核验：把 thread/start 响应与期望比对，返回不一致项（空 = 一致）。 */
export function verifyEffectivePermissions(exp: ModeExpectation, t: any): string[] {
  const bad: string[] = [];
  if (t?.approvalPolicy !== exp.approvalPolicy) bad.push(`命令审批策略（实际：${JSON.stringify(t?.approvalPolicy)}）`);
  if (exp.mode === 'standard') {
    const id = t?.activePermissionProfile?.id;
    if (id !== exp.profileId) bad.push(`权限配置档（期望 ${exp.profileId}，实际：${JSON.stringify(id)}）`);
    if (t?.activePermissionProfile?.extends !== ':workspace') bad.push(`权限配置档的父档（实际：${JSON.stringify(t?.activePermissionProfile?.extends)}）`);
    const net = t?.sandbox?.networkAccess;
    if (!exp.networkEnabled && net !== false) bad.push(`外部网络未关闭（实际：${JSON.stringify(net)}）`);
    if (t?.sandbox?.type === 'dangerFullAccess') bad.push('沙箱被放开（实际：dangerFullAccess）');
  } else if (t?.sandbox?.type !== exp.sandboxType) {
    bad.push(`沙箱类型（期望 ${exp.sandboxType}，实际：${JSON.stringify(t?.sandbox?.type)}）`);
  }
  return bad;
}

/** 写进任务记录的“实际生效权限”（取自 thread/start 响应；不含机密）。 */
export interface EffectivePermissions {
  mode: ConstructionMode | 'read_only';
  approvalPolicy: string;
  profileId?: string;
  sandboxType?: string;
  networkAccess?: boolean;
  networkEnabled: boolean;
  allowedDomains: string[];
  /** 本次期望的可写根与读取拒绝（来自我们生成的配置，便于对照） */
  summary: string;
}

export function effectivePermissionsOf(exp: ModeExpectation, t: any, summary: string): EffectivePermissions {
  return {
    mode: exp.mode,
    approvalPolicy: String(t?.approvalPolicy),
    ...(t?.activePermissionProfile?.id ? { profileId: String(t.activePermissionProfile.id) } : {}),
    ...(t?.sandbox?.type ? { sandboxType: String(t.sandbox.type) } : {}),
    ...(typeof t?.sandbox?.networkAccess === 'boolean' ? { networkAccess: t.sandbox.networkAccess } : {}),
    networkEnabled: exp.networkEnabled,
    allowedDomains: exp.allowedDomains,
    summary,
  };
}
