/**
 * 本地订阅制 CLI 工具目录与强制风险确认门禁（ADR 0010 · 阶段 8B）。
 *
 * 与 `modes.ts` 的 `requireFullTrustConfirmed` 同理：
 * 任何本地订阅 CLI 执行适配器在 `start()` 真正拉起子进程前，必须先通过
 * `requireRiskAcknowledged(cliId, riskGate)` 核验用户已阅读并显式勾选同意对应工具的风险条款。
 */

export type SubscriptionCliId = 'claude_cli' | 'agy' | 'cursor';

export interface SubscriptionCliSpec {
  readonly id: SubscriptionCliId;
  readonly name: string;
  readonly binaryName: 'claude' | 'agy' | 'agent';
  readonly displayName: string;
  readonly riskVersion: number;
  readonly riskTitle: string;
  readonly riskBullets: readonly string[];
  readonly officialAlternative: string;
  readonly isolationHonesty: string;
  readonly suggestedModels: readonly string[];
}

export const SUBSCRIPTION_CLI_CATALOG: readonly SubscriptionCliSpec[] = [
  {
    id: 'claude_cli',
    name: 'Claude Code',
    binaryName: 'claude',
    displayName: 'Claude Code（本机订阅）',
    riskVersion: 1,
    riskTitle: '启用 Claude Code 本机订阅执行者的条款与隔离说明',
    riskBullets: [
      'Anthropic 服务条款要求自动化或第三方集成优先使用官方 Anthropic API Key；将个人 Claude Pro/Max 订阅用于第三方调度存在账号被限流或停用的风险，由您本人自担后果。',
      '本应用只通过命令行启动您本机官方 `claude` 可执行文件，不会读取、导出或保存任何外部工具的账号凭证。',
      '标准模式下本应用会启用受限模式与安全设置档（关闭外部 MCP、技能、斜杠命令与钩子），限制文件修改在当前任务副本内，且不开启外部命令执行。',
    ],
    officialAlternative: '官方合规替代：在上方「常用 AI API 执行者接入」中选择 Anthropic（Claude API）并填写 API Key。',
    isolationHonesty:
      '通过官方安全受限参数将文件工具收敛至任务副本并禁用外部脚本运行，但无法像 Codex 那样单独列出或按条目阻断本机读取路径；未配备单独检查沙箱时，保存验收仍须经你手动确认未检查。',
    suggestedModels: ['sonnet', 'opus', 'haiku'],
  },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    binaryName: 'agy',
    displayName: 'Antigravity（本机订阅）',
    riskVersion: 1,
    riskTitle: '启用 Antigravity 本机订阅执行者的条款与账号风险说明',
    riskBullets: [
      'Antigravity 服务条款明确限制经由第三方软件调用；虽社区存在本地无头模式运行讨论，但条款冲突带来的封号后果可能波及您的整个 Google 账号。',
      '本应用仅在您手动确认本说明后，按受限终端与禁用默认自定义扩展的参数启动本机 `agy`，绝不读取或导出任何登录资料。',
      'Antigravity 工具调用会受应用内工作副本路径核验保护（越界写入或触发外部命令请求会被拒绝），但仍不具备操作系统的独立目录白名单级隔离。',
    ],
    officialAlternative: '官方合规替代：在上方「常用 AI API 执行者接入」中选择 Google Gemini API 并填写 API Key。',
    isolationHonesty:
      '使用命令行自带终端约束并拒绝副本外写操作，但无法按操作系统目录白名单拦截所有读取位置；未配备 Codex 沙箱时无法自动运行项目构建与测试脚本。',
    suggestedModels: [],
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    binaryName: 'agent',
    displayName: 'Cursor CLI（本机订阅）',
    riskVersion: 1,
    riskTitle: '启用 Cursor CLI 本机订阅执行者的条款与隔离说明',
    riskBullets: [
      'Cursor 服务条款禁止账号共享、转售或代管；使用额度受您本机账户订阅池上限约束，开启后的一切配额消耗与账号合规后果由您自行承担。',
      '本应用只按受限参数连接本机 `agent` 服务，在启动子进程前会剔除其他服务商密钥环境变量，也不会读取或保存您的 Cursor 登录凭据。',
      '工作树外写操作或未授权命令会在权限回调阶段直接拦截并记入验收卡，但读取与网络能力受您本机 CLI 配置制约。',
    ],
    officialAlternative: '官方合规替代：在「常用 AI API 执行者接入」中配置 OpenAI / Anthropic / DeepSeek API Key。',
    isolationHonesty:
      '依赖受限参数与工作树权限边界拦截写操作，受您本机已有工具配置与网络状态影响，不能保证完全禁止网络或敏感目录读取。',
    suggestedModels: [],
  },
];

export function findSubscriptionCliSpec(id: string): SubscriptionCliSpec | undefined {
  return SUBSCRIPTION_CLI_CATALOG.find((c) => c.id === id);
}

export function isSubscriptionCliId(id: string): id is SubscriptionCliId {
  return id === 'claude_cli' || id === 'agy' || id === 'cursor';
}

export interface RiskGateRecord {
  enabled?: boolean;
  riskAcknowledgedAt?: string;
  acknowledgedRiskVersion?: number;
}

export interface SubscriptionRiskGate {
  getRiskRecord(cliId: SubscriptionCliId): Promise<RiskGateRecord | null | undefined>;
}

/**
 * 订阅 CLI 启动的唯一强制门禁：未持久化确认当前版本风险说明，拒绝启动任何订阅 CLI 进程。
 */
export async function requireRiskAcknowledged(
  cliId: SubscriptionCliId,
  gate: SubscriptionRiskGate | undefined,
): Promise<void> {
  const spec = findSubscriptionCliSpec(cliId);
  if (!spec) throw new Error(`未识别的本地订阅执行者：${cliId}`);
  const rec = gate ? await gate.getRiskRecord(cliId) : null;
  if (!rec || rec.enabled !== true || !rec.riskAcknowledgedAt || rec.acknowledgedRiskVersion !== spec.riskVersion) {
    throw new Error(`尚未阅读并确认「${spec.name}」的条款与风险说明，禁止启动该本地订阅执行者。`);
  }
}
