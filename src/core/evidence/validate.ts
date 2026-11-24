import type { HostCheckEvidence } from './model.js';

/**
 * 证据有效性复核（AISS-A1）。
 *
 * 两类复核：
 * 1. **身份复核（纯计算，无 I/O）**：证据引用的任务 / 轮次 / 验收版本 / 被测内容 tree 必须与当前记录一致。
 *    任何一项不一致 ⇒ 证据失效（`invalidated`）。历史轮次按「当时有效」展示，不在此处判失效。
 * 2. **深度复核（需要文件系统）**：重启后核对检查脚本 / 测试配置 / 运行器 / 锁文件是否在验收之后被改动。
 *    由 TaskRunner 在启动核对时执行，结果写入任务的 `evidenceInvalid` 字段（只记录事实，不改写历史轮次）。
 */

export interface EvidenceIdentityInput {
  taskId: string;
  round: number;
  acceptanceRev?: number | undefined;
  acceptedTree?: string | undefined;
}

/** 证据身份是否仍对得上当前任务记录；对不上返回原因文字。 */
export function evidenceIdentityProblem(ev: HostCheckEvidence, t: EvidenceIdentityInput): string | undefined {
  if (ev.identity.taskId !== t.taskId) return '证据属于另一个任务，已失效。';
  if (ev.identity.round !== t.round) return '证据属于另一轮次，已失效。';
  if ((ev.identity.acceptanceRev ?? 0) !== (t.acceptanceRev ?? 0)) return '验收版本已经变化，旧证据已失效。';
  if (t.acceptedTree && ev.identity.testedTree !== t.acceptedTree) return '被测内容与验收冻结内容不一致，证据已失效。';
  if (ev.valid === false) return ev.invalidReason ? `证据在生成时已被标记为失效（${ev.invalidReason}）。` : '证据在生成时已被标记为失效。';
  return undefined;
}

/** 自动测试是否「取得可信通过证据」：必须有结构化报告、完整性通过、真实执行且全部通过。 */
export function hasTrustedTestPass(ev: HostCheckEvidence | undefined): boolean {
  if (!ev || ev.kind !== 'test') return false;
  if (ev.verdict !== 'passed' || ev.trust !== 'trusted' || ev.valid === false) return false;
  const report = ev.report;
  if (!report || !report.integrity.ok) return false;
  const c = report.counts;
  return c.total > 0 && c.failed === 0 && c.passed > 0;
}

/** 构建是否「取得可信通过证据」：构建的语义是命令成功，真实进程退出 0 即可。 */
export function hasTrustedBuildPass(ev: HostCheckEvidence | undefined): boolean {
  if (!ev || ev.kind !== 'build') return false;
  if (ev.verdict !== 'passed' || ev.trust !== 'trusted' || ev.valid === false) return false;
  return ev.run.exitKind === 'exited' && ev.run.exitCode === 0;
}

/** 配置文件指纹是否与当前状态一致（重启深度复核用）。 */
export function configFingerprintProblems(
  ev: HostCheckEvidence,
  current: {
    scriptsDigest?: string | undefined;
    configFiles: { path: string; sha256: string }[];
    runnerPackage?: { name: string; version: string; packageJsonSha256: string } | undefined;
    packageLockDigest?: string | undefined;
  },
): string[] {
  const problems: string[] = [];
  if ((ev.config.scriptsDigest ?? '') !== (current.scriptsDigest ?? '')) problems.push('检查脚本内容变化');
  const cur = new Map(current.configFiles.map((c) => [c.path, c.sha256]));
  for (const f of ev.config.testConfigFiles) {
    if (cur.get(f.path) !== f.sha256) problems.push(`测试配置变化：${f.path}`);
  }
  const evRunner = ev.config.runnerPackage;
  if (!!evRunner !== !!current.runnerPackage) problems.push('测试运行器身份变化');
  else if (evRunner && current.runnerPackage && (evRunner.version !== current.runnerPackage.version || evRunner.packageJsonSha256 !== current.runnerPackage.packageJsonSha256)) {
    problems.push('测试运行器版本或内容变化');
  }
  if ((ev.config.packageLockDigest ?? '') !== (current.packageLockDigest ?? '')) problems.push('依赖锁文件变化');
  return problems;
}
