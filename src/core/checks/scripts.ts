import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcOutcome } from '../proc/run.js';
import type { Capabilities } from '../capabilities/model.js';
import { hostEnv } from '../env/host-env.js';
import { makeDir } from '../persistence/files.js';
import type { FullTrustRecords } from '../executor/modes.js';
import { uncheckedReasonText } from '../task/messages.js';
import {
  EVIDENCE_SCHEMA,
  COLLECTOR_VERSION,
  type CheckUnknownReason,
  type CheckVerdict,
  type ConfigFingerprint,
  type EvidenceIdentity,
  type EvidenceTrust,
  type HostCheckEvidence,
  type ScopeAssessment,
  type TestInventory,
} from '../evidence/model.js';
import {
  assessScopeChange,
  detectTestRunner,
  readConfigFingerprints,
  readConfigFingerprintsFromTree,
  readPackageLockDigest,
  readPackageLockDigestFromTree,
  scanTestInventory,
  scanTestInventoryFromTree,
  scopeFingerprint,
  sha256Text,
} from '../evidence/inventory.js';
import { buildReportEvidence, cleanupVitestRun, parseStdoutSummary, prepareVitestRun, readVitestReport } from '../evidence/vitest.js';

/**
 * 项目脚本检查（build / test）。B3：脚本不再由宿主直接运行，而是通过执行体提供的「沙箱命令运行器」
 * （Codex app-server 的 command/exec，与施工使用同一权限配置档）运行。
 * 受限环境不可用 → 结果为「未检查」（not_available），绝不回退到宿主直接运行。
 * 授权绑定脚本内容摘要：批准时记录摘要，运行前重算，不一致则授权失效、不运行。
 *
 * AISS-A1（可信证据）：
 * - **构建**：真实进程退出码 0 在受限沙箱内是构建成功的有效证据（构建的语义就是「命令成功」）。
 * - **自动测试**：退出码 0 不再等于「测试通过」。只有当宿主注入的 Vitest JSON 报告器在本次运行窗口内
 *   产出的结构化报告证明「有测试真实执行且全部通过」时才是 passed；其余为 failed / unverified / not_available。
 * - 每个结果附带 `HostCheckEvidence`：身份、被测内容 tree、运行身份与时间、脚本/配置/运行器/测试清单指纹、
 *   真实进程退出状态、测试执行/通过/失败/跳过数量、报告来源与完整性、有效性与失效原因。
 */

export type CheckName = 'build' | 'test';
export type { CheckVerdict };

export type CheckResult =
  | { name: CheckName; status: 'not_available'; unknownReason: CheckUnknownReason; reason: string; evidence?: HostCheckEvidence }
  | {
      name: CheckName;
      status: 'unverified';
      unknownReason: CheckUnknownReason;
      reason: string;
      outcome?: ProcOutcome;
      output: string;
      durationMs: number;
      evidence?: HostCheckEvidence;
    }
  | {
      name: CheckName;
      status: 'passed' | 'failed';
      outcome: ProcOutcome;
      output: string;
      durationMs: number;
      evidence?: HostCheckEvidence;
    };

export interface SandboxExecRequest {
  cwd: string;
  argv: string[];
  /** 传给沙箱内进程的环境（已最小化；运行器只会把这些变量合并进沙箱环境） */
  env: Record<string, string>;
  timeoutMs: number;
  capabilities?: Capabilities;
  taskId?: string;
  /** 完全信任模式的门禁需要读取任务记录 */
  fullTrustRecords?: FullTrustRecords;
}

export type SandboxExecResult =
  | { status: 'ran'; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
  | { status: 'unavailable'; reason: string };

/** 在与施工相同的权限配置档下运行一条命令。实现必须保证：不可用时返回 unavailable，而不是在宿主上运行。 */
export interface SandboxCommandRunner {
  /** 运行环境种类，仅用于证据记录（不参与判定） */
  readonly kind?: string;
  runCommand(req: SandboxExecRequest): Promise<SandboxExecResult>;
}

/** 运行脚本时允许进入沙箱的环境变量白名单（取值来自宿主；其余一律不传）。 */
export const CHECK_ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'] as const;

/** 读取 package.json 中声明的脚本；不存在则返回空。 */
export async function detectScripts(dir: string): Promise<Partial<Record<CheckName, string>>> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const s = pkg?.scripts ?? {};
    const out: Partial<Record<CheckName, string>> = {};
    if (typeof s.build === 'string') out.build = s.build;
    // npm 默认的占位 test 脚本不算真正的测试
    if (typeof s.test === 'string' && !/no test specified/.test(s.test)) out.test = s.test;
    return out;
  } catch {
    return {};
  }
}

/** npm 运行 `npm run X` 时还会运行 preX / postX，所以它们一并纳入摘要。 */
const DIGEST_KEYS = ['prebuild', 'build', 'postbuild', 'pretest', 'test', 'posttest'] as const;

/**
 * 脚本内容摘要：只取 package.json 的 scripts 字段里与 build/test 相关的条目（含 pre/post），排序后哈希。
 * 没有 package.json 或没有任何相关脚本 → undefined。
 */
export async function scriptsDigest(dir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const s = pkg?.scripts ?? {};
    const picked: Record<string, string> = {};
    for (const k of DIGEST_KEYS) if (typeof s[k] === 'string') picked[k] = s[k];
    if (!Object.keys(picked).length) return undefined;
    return createHash('sha256').update(JSON.stringify(picked)).digest('hex');
  } catch {
    return undefined;
  }
}

/** 沙箱内进程的最小环境：白名单 + 副本内私有的临时目录（沙箱里 /tmp 与 $TMPDIR 只读）。 */
export function minimalCheckEnv(base: NodeJS.ProcessEnv, dir: string, developerDirExists: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHECK_ENV_WHITELIST) {
    const v = base[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  // 临时目录放在副本内 .studio/tmp（该目录由 .git/info/exclude 忽略）。
  env.TMPDIR = path.join(dir, '.studio', 'tmp');
  env.CI = '1';
  // B3-1 实测：同时设置 TMPDIR（副本内）与 DEVELOPER_DIR 才能消除 Apple git 的 xcrun 报错
  if (developerDirExists) env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
  return env;
}

/** 批准时记录的测试范围基线（可选；缺失时退化为「任务基线提交 + 当前运行器」）。 */
export interface ApprovedScopeBaseline {
  at: string;
  runnerName?: string;
  runnerVersion?: string;
  runnerPackageJsonSha256?: string;
  inventoryDigest?: string;
  testFileCount?: number;
  testBlockCount?: number;
  assertionCount?: number;
  configDigests?: { path: string; sha256: string }[];
  packageLockDigest?: string;
  scriptsDigest?: string;
}

/** 证据身份上下文：由调用方（TaskRunner / 保存前试检查）提供，保证证据与任务、轮次、验收版本、被测内容绑定。 */
export interface EvidenceIdentityContext {
  /** 项目根真实路径（只取哈希写入记录） */
  projectRoot: string;
  taskId: string;
  round: number;
  acceptanceRev: number;
  /** 运行开始时的被测内容 tree（调用方在跑检查前计算） */
  testedTree: string;
  /** 任务基线提交：测试范围削弱的判定基线（executor 不可篡改的历史提交） */
  baselineRev?: string | undefined;
  /** 批准时记录的测试范围基线（可选） */
  approvedScope?: ApprovedScopeBaseline | undefined;
}

export interface RunCheckOptions {
  timeoutMs?: number;
  /** 批准时记录的脚本摘要；不传表示没有授权 → 不运行 */
  authorizedDigest?: string | undefined;
  capabilities?: Capabilities;
  taskId?: string;
  fullTrustRecords?: FullTrustRecords;
  /** 证据身份；不传则不产出可绑定证据（只用于探测/单元测试路径） */
  identity?: EvidenceIdentityContext;
  /** 检查运行所在的受限环境种类（用于证据记录） */
  sandboxKind?: string;
  /**
   * 仅由「用户明确确认当前测试范围」的动作传入：把当前范围当作已复核基线。
   * 绝不允许由自动流程设置 —— 自动反馈闭环不得自行确认范围变化或未检查风险。
   */
  acceptCurrentScope?: boolean;
}

function hostPathHash(p: string): string {
  return sha256Text(p).slice(0, 32);
}

function newEvidenceId(): string {
  return randomBytes(16).toString('hex');
}

function exitOutcome(r: Extract<SandboxExecResult, { status: 'ran' }>): ProcOutcome {
  return r.timedOut ? { kind: 'timed_out' } : r.exitCode === null ? { kind: 'spawn_error', message: '命令没有返回退出码' } : { kind: 'exited', code: r.exitCode };
}

const NO_SCOPE: ScopeAssessment = { kind: 'not_assessed', baselineAvailable: false, reasons: ['构建检查不涉及测试范围评估。'] };

interface Fingerprints {
  config: ConfigFingerprint;
  currentInventory?: TestInventory | undefined;
  baselineConfigs: { path: string; sha256: string }[];
  baselineLock?: string | undefined;
}

async function collectFingerprints(dir: string, opts: RunCheckOptions, withInventory: boolean): Promise<Fingerprints> {
  const scripts = await scriptsDigest(dir);
  const packageLockDigest = await readPackageLockDigest(dir);
  const testConfigFiles = await readConfigFingerprints(dir);
  const inventory = withInventory ? await scanTestInventory(dir) : undefined;
  const detected = withInventory ? await detectScripts(dir) : {};
  const runner = withInventory && detected.test ? await detectTestRunner(dir, detected.test) : undefined;
  const config: ConfigFingerprint = {
    ...(scripts ? { scriptsDigest: scripts } : {}),
    ...(packageLockDigest ? { packageLockDigest } : {}),
    ...(runner ? { runnerPackage: { name: runner.name, version: runner.version, packageJsonSha256: runner.packageJsonSha256 } } : {}),
    testConfigFiles,
    ...(inventory
      ? {
          testInventoryDigest: inventory.digest,
          testFileCount: inventory.testFileCount,
          testBlockCount: inventory.testBlockCount,
          assertionCount: inventory.assertionCount,
          skipMarkerCount: inventory.skipMarkerCount,
          onlyMarkerCount: inventory.onlyMarkerCount,
        }
      : {}),
    reporterMode: runner?.argsAppendable ? 'vitest-json-cli' : 'none',
    collectorVersion: COLLECTOR_VERSION,
  };
  const baselineRev = opts.identity?.baselineRev;
  const baselineConfigs = baselineRev ? await readConfigFingerprintsFromTree(dir, baselineRev) : [];
  const baselineLock = baselineRev ? await readPackageLockDigestFromTree(dir, baselineRev) : undefined;
  return { config, currentInventory: inventory, baselineConfigs, baselineLock };
}

/** 相对任务基线提交评估测试范围是否被削弱。 */
async function assessTestScope(dir: string, opts: RunCheckOptions, fp: Fingerprints): Promise<ScopeAssessment> {
  if (opts.acceptCurrentScope) {
    return { kind: 'assessed_unchanged', baselineAvailable: true, reasons: ['你已明确确认按当前测试范围验收。'], baselineSource: '用户重新确认' };
  }
  const baselineRev = opts.identity?.baselineRev;
  const current = fp.currentInventory ?? (await scanTestInventory(dir));
  const baseInventory = baselineRev ? await scanTestInventoryFromTree(dir, baselineRev) : undefined;
  if (!baseInventory || (baseInventory.testFileCount === 0 && current.testFileCount === 0)) {
    // 无基线提交：无法判断「已有覆盖是否被削弱」（历史任务）。如实标记未评估，不伪造结论。
    return { kind: 'not_assessed', baselineAvailable: false, reasons: ['缺少任务基线提交，无法核对已有测试覆盖是否被削弱。'] };
  }
  const approved = opts.identity?.approvedScope;
  const baselineRunner = approved?.runnerVersion
    ? { name: approved.runnerName ?? 'vitest', version: approved.runnerVersion, packageJsonSha256: approved.runnerPackageJsonSha256 ?? '' }
    : undefined;
  const assessment = assessScopeChange({
    baseline: baseInventory,
    current,
    baselineConfigs: fp.baselineConfigs,
    currentConfigs: fp.config.testConfigFiles,
    baselineLock: fp.baselineLock,
    currentLock: fp.config.packageLockDigest,
    baselineRunner,
    currentRunner: fp.config.runnerPackage
      ? { name: fp.config.runnerPackage.name, version: fp.config.runnerPackage.version, packageJsonSha256: fp.config.runnerPackage.packageJsonSha256 }
      : undefined,
    baselineScriptsDigest: opts.authorizedDigest,
    currentScriptsDigest: fp.config.scriptsDigest,
  });
  return { ...assessment, baselineSource: `基线提交 ${baselineRev ?? '（无）'}` };
}

function makeIdentity(ctx: EvidenceIdentityContext | undefined, testedTree: string, dir: string): EvidenceIdentity | undefined {
  if (!ctx) return undefined;
  return {
    schemaVersion: EVIDENCE_SCHEMA,
    evidenceId: newEvidenceId(),
    projectRootHash: hostPathHash(ctx.projectRoot),
    taskId: ctx.taskId,
    round: ctx.round,
    acceptanceRev: ctx.acceptanceRev,
    testedTree,
    worktreePathHash: hostPathHash(dir),
  };
}

function makeRunRecord(opts: {
  argv: string[];
  startedAt: string;
  finishedAt: string;
  env: 'sandbox' | 'local';
  sandboxKind: string;
  timedOut: boolean;
  outcome: ProcOutcome;
  durationMs: number;
  stdout: string;
  stderr: string;
}): HostCheckEvidence['run'] {
  return {
    runId: randomBytes(12).toString('hex'),
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    env: opts.env,
    sandboxKind: opts.sandboxKind,
    argv: opts.argv,
    timedOut: opts.timedOut,
    exitKind: opts.outcome.kind,
    exitCode: opts.outcome.kind === 'exited' ? opts.outcome.code : null,
    durationMs: opts.durationMs,
    stdoutSha256: sha256Text(opts.stdout),
    stdoutBytes: Buffer.byteLength(opts.stdout),
    stderrSha256: sha256Text(opts.stderr),
  };
}

export async function runCheck(dir: string, name: CheckName, runner: SandboxCommandRunner | undefined, opts: RunCheckOptions = {}): Promise<CheckResult> {
  const scripts = await detectScripts(dir);
  const testedTree = opts.identity?.testedTree ?? '';
  const envKind: 'sandbox' | 'local' = opts.capabilities?.constructionMode === 'full_trust' ? 'local' : 'sandbox';
  const sandboxKind = opts.sandboxKind ?? runner?.kind ?? 'unknown';

  const notAvailable = (unknownReason: CheckUnknownReason, reason: string, fp?: Fingerprints): CheckResult => {
    const ident = makeIdentity(opts.identity, testedTree, dir);
    const evidence: HostCheckEvidence | undefined = ident
      ? {
          schemaVersion: EVIDENCE_SCHEMA,
          kind: name,
          verdict: 'not_available',
          trust: 'none',
          reason: unknownReason,
          identity: ident,
          run: makeRunRecord({
            argv: [],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            env: envKind,
            sandboxKind,
            timedOut: false,
            outcome: { kind: 'spawn_error', message: 'not started' },
            durationMs: 0,
            stdout: '',
            stderr: '',
          }),
          config: fp?.config ?? { testConfigFiles: [], reporterMode: 'none', collectorVersion: COLLECTOR_VERSION },
          scope: NO_SCOPE,
          valid: true,
        }
      : undefined;
    return { name, status: 'not_available', unknownReason, reason, ...(evidence ? { evidence } : {}) };
  };

  if (!scripts[name]) return notAvailable('no_script', `项目没有 ${name} 脚本，因此未检查。`);
  if (!runner) return notAvailable('sandbox_unavailable', '没有可用的受限运行环境，脚本不会在你的电脑上直接运行，因此未检查。');
  // 授权必须绑定脚本内容：没有授权记录、或脚本相对批准时发生了变化，一律不运行
  const digest = await scriptsDigest(dir);
  if (!opts.authorizedDigest) return notAvailable('scripts_not_approved', '这些脚本没有经过你的批准，因此未检查。');
  if (digest !== opts.authorizedDigest) return notAvailable('scripts_changed_reauth', '脚本内容与你批准时不同（授权已失效），因此未检查。');

  const fp = await collectFingerprints(dir, opts, name === 'test');
  const testRunner = name === 'test' && scripts.test ? await detectTestRunner(dir, scripts.test) : undefined;

  await makeDir(path.join(dir, '.studio', 'tmp'));
  const developerDir = await fs.stat('/Library/Developer/CommandLineTools').then(() => true, () => false);
  const sandboxEnv = minimalCheckEnv(hostEnv(), dir, developerDir);
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

  // 测试：只有 Vitest 且脚本可安全追加参数时，才建立可信结构化报告通道
  const useStructured = name === 'test' && !!testRunner && testRunner.argsAppendable;
  const plan = useStructured ? await prepareVitestRun(dir, scripts.test ?? '') : undefined;
  const argv = plan ? plan.argv : ['npm', 'run', name, '--silent'];
  const startedAt = new Date();
  const startMs = Date.now();
  const r = await runner.runCommand({
    cwd: dir,
    argv,
    env: sandboxEnv,
    timeoutMs,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.fullTrustRecords ? { fullTrustRecords: opts.fullTrustRecords } : {}),
  });
  const endMs = Date.now();
  const finishedAt = new Date();
  if (r.status === 'unavailable') {
    if (plan) await cleanupVitestRun(plan);
    return notAvailable('sandbox_unavailable', `受限运行环境不可用（${r.reason}），因此未检查。`, fp);
  }

  const outcome = exitOutcome(r);
  const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-20_000);
  const runRecord = makeRunRecord({
    argv,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    env: envKind,
    sandboxKind,
    timedOut: r.timedOut,
    outcome,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  const exitZero = outcome.kind === 'exited' && outcome.code === 0;
  const evidenceFor = (verdict: CheckVerdict, unknownReason: CheckUnknownReason | undefined, trust: EvidenceTrust, extra: Partial<HostCheckEvidence> = {}): HostCheckEvidence | undefined => {
    const ident = makeIdentity(opts.identity, testedTree, dir);
    if (!ident) return undefined;
    return {
      schemaVersion: EVIDENCE_SCHEMA,
      kind: name,
      verdict,
      trust,
      ...(unknownReason ? { reason: unknownReason } : {}),
      identity: ident,
      run: runRecord,
      config: fp.config,
      scope: NO_SCOPE,
      valid: true,
      ...extra,
    };
  };

  if (name === 'build') {
    const verdict: CheckVerdict = exitZero ? 'passed' : 'failed';
    const evidence = evidenceFor(verdict, exitZero ? undefined : undefined, 'trusted');
    return { name, status: verdict, outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
  }

  // ── 自动测试 ──
  if (!plan || !useStructured) {
    if (plan) await cleanupVitestRun(plan);
    if (!exitZero) {
      const evidence = evidenceFor('failed', undefined, 'weak');
      return { name, status: 'failed', outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
    }
    const unknownReason: CheckUnknownReason = testRunner ? 'no_structured_evidence' : 'unsupported_test_runner';
    const reason = testRunner
      ? '测试命令结束了，但测试脚本无法建立可信的结构化报告通道，因此未取得可信测试证据。'
      : '这个项目的测试运行器尚未适配可信结构化证据采集，只能记录命令执行结果，不能当作测试通过。';
    const evidence = evidenceFor('unverified', unknownReason, 'weak');
    return { name, status: 'unverified', unknownReason, reason, outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
  }

  const reportParse = await readVitestReport(plan, { startMs: startMs - 1, endMs });
  await cleanupVitestRun(plan);
  const stdoutSummary = parseStdoutSummary(r.stdout);
  const scope = await assessTestScope(dir, opts, fp);

  const unverified = (unknownReason: CheckUnknownReason, reason: string, extra: Partial<HostCheckEvidence> = {}): CheckResult => {
    const evidence = evidenceFor('unverified', unknownReason, 'weak', { scope, ...extra });
    return { name, status: 'unverified', unknownReason, reason, outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
  };
  const failed = (reasonText: string, extra: Partial<HostCheckEvidence> = {}): CheckResult => {
    const evidence = evidenceFor('failed', undefined, 'trusted', { scope, ...extra });
    return { name, status: 'failed', outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
  };

  if (reportParse.status === 'missing') {
    return unverified(
      'report_missing',
      exitZero
        ? '测试命令以 0 退出，但没有产出宿主可校验的结构化测试报告；不能据此判定测试通过。'
        : '测试命令没有产出结构化测试报告，且进程没有正常结束。',
    );
  }
  if (reportParse.status === 'reused') return unverified('report_reused', '测试报告不是本次运行产生的（可能被复用或预置），证据无效。');
  if (reportParse.status === 'invalid' || reportParse.status === 'inconsistent') {
    const unknownReason: CheckUnknownReason = reportParse.status === 'invalid' ? 'report_invalid' : 'report_inconsistent';
    return unverified(unknownReason, `结构化测试报告未通过完整性校验：${reportParse.detail}`);
  }

  const report = buildReportEvidence({ plan, parse: reportParse, stdoutSummary });
  const counts = report.counts;
  const withReport: Partial<HostCheckEvidence> = { report };

  // 报告是权威事实：真实失败优先（即使外层脚本把失败退出码吞成 0）
  if (counts.failed > 0) return failed(`结构化报告显示有 ${counts.failed} 项测试失败。`, withReport);
  if (!report.integrity.ok) {
    return unverified('report_inconsistent', `结构化测试报告的完整性校验未通过：${report.integrity.problems.join('；')}`, withReport);
  }
  if (counts.total === 0) return unverified('tests_not_executed', '测试运行器正常结束，但报告显示没有执行任何测试用例（零测试不算通过）。', withReport);
  if (counts.passed === 0 && counts.skipped > 0) {
    return unverified('all_tests_skipped', `报告显示 ${counts.skipped} 项测试全部被跳过，没有真实执行（全部跳过不算通过）。`, withReport);
  }
  if (!exitZero) return failed('测试进程没有以 0 退出（即使报告没有失败用例，也不能算通过）。', withReport);
  if (scope.kind === 'assessed_weakened') {
    return unverified(
      'test_scope_weakened',
      `相对任务基线，测试范围被削弱或验证基础设施被修改，自动通过已被阻断：${scope.reasons.join('；')}`,
      withReport,
    );
  }
  const evidence = evidenceFor('passed', undefined, 'trusted', { scope, ...withReport });
  return { name, status: 'passed', outcome, output, durationMs: r.durationMs, ...(evidence ? { evidence } : {}) };
}

export interface ChecksSummary {
  passed: number;
  failed: number;
}

export type UncheckedKind = 'none' | 'unavailable' | 'unverified';
export type UnavailableReason = 'sandbox_unavailable' | 'scripts_changed_reauth' | 'other' | 'evidence_unverified';
export type ProjectChecksKind = 'none' | 'unavailable' | 'ran' | 'unverified';

export interface ProjectChecksOutcome {
  /** none：无构建/测试脚本；unavailable：有脚本但至少一项未能运行；unverified：运行了但没有可信通过证据；ran：声明的脚本全部运行并通过 */
  kind: ProjectChecksKind;
  /** kind === 'unavailable' | 'unverified' 时的原因分类 */
  unavailableReason?: UnavailableReason;
  /** 给用户看的说明文案 */
  reasonText?: string;
  results: CheckResult[];
  /** 至少声明了一项脚本、全部实际运行且都有可信通过证据，才为 true */
  checked: boolean;
  summary: ChecksSummary;
  failed: CheckResult[];
  /** 运行了但没有取得可信通过证据的检查（绝不等于通过） */
  unverified: CheckResult[];
  checkedAt?: string;
}

function classifyUnavailable(
  notAvailable: Extract<CheckResult, { status: 'not_available' }>[],
  digestChangedOrMissing: boolean,
): UnavailableReason {
  if (digestChangedOrMissing || notAvailable.some((c) => c.unknownReason === 'scripts_changed_reauth' || c.unknownReason === 'scripts_not_approved')) {
    return 'scripts_changed_reauth';
  }
  if (notAvailable.some((c) => c.unknownReason === 'sandbox_unavailable')) return 'sandbox_unavailable';
  return 'other';
}

/**
 * 复用 detectScripts 的识别结果，在指定目录（如保存试合并的临时 worktree）运行项目声明的自动检查。
 * 没有可用脚本、任一项无法在受限环境运行、或任一项缺乏可信通过证据时，checked 为 false，
 * 绝不把未检查 / 不可信标成通过。
 */
export async function runProjectChecks(
  dir: string,
  runner: SandboxCommandRunner | undefined,
  opts: RunCheckOptions = {},
): Promise<ProjectChecksOutcome> {
  const detected = await detectScripts(dir);
  const names = (['build', 'test'] as const).filter((n) => typeof detected[n] === 'string');
  if (names.length === 0) {
    return {
      kind: 'none',
      reasonText: uncheckedReasonText('none'),
      results: [],
      checked: false,
      summary: { passed: 0, failed: 0 },
      failed: [],
      unverified: [],
    };
  }
  const results: CheckResult[] = [];
  for (const name of names) results.push(await runCheck(dir, name, runner, opts));
  const passed = results.filter((c) => c.status === 'passed').length;
  const failed = results.filter((c): c is Extract<CheckResult, { status: 'passed' | 'failed' }> => c.status === 'failed');
  const notAvail = results.filter((c): c is Extract<CheckResult, { status: 'not_available' }> => c.status === 'not_available');
  const unverified = results.filter((c): c is Extract<CheckResult, { status: 'unverified' }> => c.status === 'unverified');
  const anyRan = results.some((c) => c.status !== 'not_available');
  const checkedAt = anyRan ? { checkedAt: new Date().toISOString() } : {};
  if (notAvail.length > 0) {
    const digest = await scriptsDigest(dir);
    const unavailableReason = classifyUnavailable(notAvail, !opts.authorizedDigest || digest !== opts.authorizedDigest);
    return {
      kind: 'unavailable',
      unavailableReason,
      reasonText: uncheckedReasonText('unavailable', unavailableReason),
      results,
      checked: false,
      summary: { passed, failed: failed.length },
      failed,
      unverified,
      ...checkedAt,
    };
  }
  if (unverified.length > 0) {
    return {
      kind: 'unverified',
      unavailableReason: 'evidence_unverified',
      reasonText: uncheckedReasonText('unverified'),
      results,
      checked: false,
      summary: { passed, failed: failed.length },
      failed,
      unverified,
      ...checkedAt,
    };
  }
  return {
    kind: 'ran',
    results,
    checked: failed.length === 0,
    summary: { passed, failed: failed.length },
    failed,
    unverified,
    ...checkedAt,
  };
}

/** 从结果里提取测试数量的真实事实（仅用于展示；没有可信证据时返回 null，绝不猜测）。 */
export function testCountsFromEvidence(c: CheckResult): { passed: number; failed: number; skipped: number; total: number } | null {
  const counts = c.evidence?.report?.counts;
  if (!counts) return null;
  return { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, total: counts.total };
}

/** 测试范围指纹（供「重新确认验收范围」绑定当前范围）。 */
export async function currentScopeFingerprint(dir: string): Promise<string> {
  const scripts = await detectScripts(dir);
  const inv = await scanTestInventory(dir);
  const configs = await readConfigFingerprints(dir);
  const runner = scripts.test ? await detectTestRunner(dir, scripts.test) : undefined;
  return scopeFingerprint(inv, configs, runner ? { version: runner.version, packageJsonSha256: runner.packageJsonSha256 } : undefined);
}

/**
 * 在批准计划时采集测试范围基线（记录到任务的 checkAuth.scope）。
 * 记录的是「批准那一刻项目里的测试范围」，用于之后判断执行体是否削弱了已有覆盖。
 */
export async function collectApprovedScopeBaseline(dir: string): Promise<ApprovedScopeBaseline> {
  const inventory = await scanTestInventory(dir);
  const configs = await readConfigFingerprints(dir);
  const scripts = await detectScripts(dir);
  const runner = scripts.test ? await detectTestRunner(dir, scripts.test) : undefined;
  const lock = await readPackageLockDigest(dir);
  const scriptsDigestValue = await scriptsDigest(dir);
  return {
    at: new Date().toISOString(),
    ...(runner ? { runnerName: runner.name, runnerVersion: runner.version, runnerPackageJsonSha256: runner.packageJsonSha256 } : {}),
    inventoryDigest: inventory.digest,
    testFileCount: inventory.testFileCount,
    testBlockCount: inventory.testBlockCount,
    assertionCount: inventory.assertionCount,
    configDigests: configs,
    ...(lock ? { packageLockDigest: lock } : {}),
    ...(scriptsDigestValue ? { scriptsDigest: scriptsDigestValue } : {}),
  };
}
