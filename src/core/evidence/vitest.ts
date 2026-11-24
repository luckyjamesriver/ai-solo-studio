import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOwnedDir, verifyOwnedDir, readOwnedFile, type OwnedDir } from '../persistence/owned-dir.js';
import type { ExecutionCaseResult, ExecutionFileCounts, ExecutionManifest, TestCounts, TestReportEvidence } from './model.js';

/**
 * Vitest 结构化证据采集（AISS-A1 第一阶段完整支持链）。
 *
 * 为什么不能只解析 stdout：`echo "Tests 5 passed"`、外层脚本吞掉失败退出码、旧报告复用，
 * 都能让「看起来通过」。这里改为由宿主注入 CLI JSON 报告器，把报告写到宿主随机生成、
 * 运行前清空的路径，再对报告做结构与交叉完整性校验。
 *
 * 信任边界（必须在文档中如实声明）：执行体可以修改测试文件、配置、甚至 node_modules 里的运行器。
 * 宿主采集退出码与结构化报告不等于不可伪造证据；因此同时施加：
 *  - 随机路径 + 运行前清空 + 运行窗口 mtime/startTime 校验 → 拒绝复用旧报告；
 *  - 计数内部一致性 + success 与 failed 一致性 + stdout 摘要交叉核对 → 发现伪造/篡改；
 *  - 脚本、锁文件、配置、运行器包、测试清单指纹 → 配置/运行器被替换时证据失效；
 *  - 运行前后内容 tree 比对（在调用方）/ 测试范围基线比对 → 运行期间改源码、削弱测试范围时失效。
 */

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

export interface VitestRunPlan {
  reportPath: string;
  reportDir: string;
  argv: string[];
  /** 报告目录与会话随机标识（不保存到任务记录，只用于本次运行） */
  nonce: string;
  /** 创建时核实的工作树真实根目录（读取时用于确认工作树身份） */
  realRootDir: string;
  /**
   * R4-01：报告目录在本次运行创建时记录授权根与目录身份；读取只信任这份记录。
   * **宿主绝不删除它**（见 cleanupVitestRun）：可变工作树路径上不做递归删除，
   * 残留随任务副本一起由 git worktree remove（带归属校验）回收。
   */
  ownedEvidenceRoot?: OwnedDir;
  ownedReportDir?: OwnedDir;
}

/**
 * 校验并确保工作树受控父目录存在，并记录创建时的授权根与每一级目录身份（R3-01）。
 * 绝不信任事后可被替换的父路径。
 */
export async function assertSafeControlledDir(dir: string, subPath: string): Promise<{ realRoot: string; controlledPath: string; owned: OwnedDir }> {
  try {
    const owned = await createOwnedDir(dir, subPath);
    const leaf = owned.chain[owned.chain.length - 1]!;
    return { realRoot: owned.rootPath, controlledPath: leaf.path, owned };
  } catch (e) {
    throw new Error(`被测工作树的受控目录不可信任：${(e as Error).message}`);
  }
}

/** 生成宿主专用的报告路径，并确保运行前不存在任何旧文件。 */
export async function prepareVitestRun(dir: string, script: string): Promise<VitestRunPlan> {
  const ownedEvidenceRoot = await createOwnedDir(dir, path.join('.studio', 'evidence'));
  const evidenceRootPath = ownedEvidenceRoot.chain[ownedEvidenceRoot.chain.length - 1]!.path;

  // 报告目录必须在沙箱可写范围内（任务副本），否则真实受限沙箱里的 Vitest 写不出报告。
  // R4-01 的修复不是“换一个更隐蔽的路径”，而是**宿主不再删除这个可变路径**（见 cleanupVitestRun）。
  let nonce = '';
  let ownedReportDir: OwnedDir | undefined;
  for (let attempt = 0; attempt < 5 && !ownedReportDir; attempt += 1) {
    const candidate = randomBytes(16).toString('hex');
    try {
      const owned = await createOwnedDir(evidenceRootPath, candidate);
      nonce = candidate;
      ownedReportDir = owned;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
  }
  if (!ownedReportDir) throw new Error('无法创建本次运行的报告目录（随机路径连续冲突）');
  const reportDir = ownedReportDir.chain[ownedReportDir.chain.length - 1]!.path;
  const reportPath = path.join(reportDir, 'vitest-report.json');
  const argv = ['npm', 'run', 'test', '--silent', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`];
  return { reportPath, reportDir, argv, nonce, realRootDir: ownedEvidenceRoot.rootPath, ownedEvidenceRoot, ownedReportDir };
}

/**
 * R4-01：**保守保留**。宿主不在可变的被测工作树路径上做任何递归删除。
 * 报告目录位于任务副本内，会随副本由 `git worktree remove`（git 自身校验 `.git` 归属）一起回收；
 * 这里保留目录和报告文件，避免“父目录被替换后宿主沿路径删除”的整类风险。
 */
export async function cleanupVitestRun(_plan: VitestRunPlan): Promise<void> {
  return;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 从 stdout 里提取 Vitest 的人类可读摘要（只作交叉核对，绝不用来判定通过）。 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function parseStdoutSummary(stdout: string): { passed: number; failed: number; skipped: number } | undefined {
  // CI/终端可能给输出加上 ANSI 颜色；先去掉再解析（否则交叉核对会“看起来没发生”）
  const plain = stdout.replace(ANSI_RE, '');
  const line = plain.split('\n').find((l) => /^\s*Tests\s+/.test(l) && /\d/.test(l));
  if (!line) return undefined;
  const num = (label: string) => {
    const m = line.match(new RegExp(`(\\d+)\\s+${label}`));
    return m ? Number(m[1]) : 0;
  };
  const passed = num('passed');
  const failed = num('failed');
  const skipped = num('skipped');
  if (passed === 0 && failed === 0 && skipped === 0) return undefined;
  return { passed, failed, skipped };
}

interface RawAssertion {
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
  failureMessages?: unknown;
}
interface RawTestResult {
  assertionResults?: unknown;
  name?: unknown;
}
interface RawVitestReport {
  numTotalTestSuites?: unknown;
  numPassedTestSuites?: unknown;
  numFailedTestSuites?: unknown;
  numPendingTestSuites?: unknown;
  numTotalTests?: unknown;
  numPassedTests?: unknown;
  numFailedTests?: unknown;
  numPendingTests?: unknown;
  numTodoTests?: unknown;
  startTime?: unknown;
  success?: unknown;
  testResults?: unknown;
}

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export type ReportParseResult =
  | {
      status: 'ok';
      sha256: string;
      bytes: number;
      counts: TestCounts;
      failedNames: string[];
      executedFiles: string[];
      execution?: ExecutionManifest;
      startTime: number;
      problems: string[];
      checks: Record<string, boolean>;
    }
  | { status: 'missing' }
  | { status: 'reused'; detail: string }
  | { status: 'invalid'; detail: string; sha256?: string; bytes?: number }
  | { status: 'inconsistent'; detail: string; sha256?: string; bytes?: number };

/**
 * 读取并严格校验本次运行产生的 Vitest JSON 报告。
 * `window` 是本次真实进程运行的时间窗（毫秒），用于拒绝复用旧报告。
 */
/**
 * 报告必须位于「创建时固定的授权根」下的报告目录，且整条所有权链（工作树根 → .studio → evidence → nonce）
 * 的 dev/ino 与真实路径都必须与创建时一致。任何一级被替换/移动/链接都会让本次报告失效。
 * （R4-01：这里只做读取校验；宿主不删除该目录。）
 */
async function reportPathProblem(plan: VitestRunPlan, rootDir: string): Promise<string | undefined> {
  if (!plan.ownedEvidenceRoot || !plan.ownedReportDir) return '报告目录缺少创建时固定的所有权记录，无法确认归属';
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch {
    return '被测工作树不可解析';
  }
  if (realRoot !== plan.ownedEvidenceRoot.rootPath) return '被测工作树真实路径与创建时不一致';
  const rootProblem = await verifyOwnedDir(plan.ownedEvidenceRoot);
  if (rootProblem) return `报告父目录不可信任：${rootProblem.detail}`;
  const dirProblem = await verifyOwnedDir(plan.ownedReportDir);
  if (dirProblem) return `报告目录不可信任：${dirProblem.detail}`;
  const expectedDir = path.join(plan.ownedEvidenceRoot.chain[plan.ownedEvidenceRoot.chain.length - 1]!.path, plan.nonce);
  if (plan.ownedReportDir.chain[plan.ownedReportDir.chain.length - 1]!.path !== expectedDir) return '报告目录不在受控位置（可能经过符号链接或路径逃逸）';
  return undefined;
}

const CASE_SAMPLE_LIMIT = 2000;

/**
 * 从报告构建「实际执行清单」（R3-03）。
 * 关键点：perFile 用例计数与 casesDigest 都覆盖**全部**用例（cases 字段只是给界面/记录的样本），
 * 因此不能用“测试文件数”或“测试总数”冒充执行范围一致。
 */
function buildExecutionManifest(testResults: RawTestResult[], realRoot: string): ExecutionManifest {
  const files: string[] = [];
  const perFile = new Map<string, ExecutionFileCounts>();
  const cases: ExecutionCaseResult[] = [];
  const canonical: string[] = [];
  for (const tr of testResults) {
    const name = typeof tr.name === 'string' ? tr.name : '';
    if (!name) continue;
    let rel: string;
    try {
      rel = path.relative(realRoot, name).split(path.sep).join('/');
    } catch {
      rel = name;
    }
    if (rel.startsWith('..')) rel = name;
    files.push(rel);
    const counts = perFile.get(rel) ?? { file: rel, total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    const assertions = Array.isArray(tr.assertionResults) ? (tr.assertionResults as RawAssertion[]) : [];
    for (const a of assertions) {
      const st = a.status;
      const status: ExecutionCaseResult['status'] = st === 'passed' ? 'passed'
        : st === 'failed' ? 'failed'
          : st === 'pending' || st === 'skipped' ? 'skipped'
            : st === 'todo' ? 'todo'
              : 'other';
      const caseName = (typeof a.fullName === 'string' ? a.fullName : typeof a.title === 'string' ? a.title : '').slice(0, 300) || '（未命名用例）';
      counts.total += 1;
      if (status === 'passed') counts.passed += 1;
      else if (status === 'failed') counts.failed += 1;
      else if (status === 'skipped') counts.skipped += 1;
      else if (status === 'todo') counts.todo += 1;
      canonical.push(JSON.stringify([rel, caseName, status]));
      if (cases.length < CASE_SAMPLE_LIMIT) cases.push({ file: rel, name: caseName, status });
    }
    perFile.set(rel, counts);
  }
  canonical.sort();
  const casesDigest = sha256Text(canonical.join('\n'));
  const perFileList = [...perFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const sortedFiles = [...files].sort();
  const counts: TestCounts = {
    total: perFileList.reduce((n, f) => n + f.total, 0),
    passed: perFileList.reduce((n, f) => n + f.passed, 0),
    failed: perFileList.reduce((n, f) => n + f.failed, 0),
    skipped: perFileList.reduce((n, f) => n + f.skipped, 0),
    todo: perFileList.reduce((n, f) => n + f.todo, 0),
  };
  const fingerprint = sha256Text(JSON.stringify({ files: sortedFiles, perFile: perFileList, casesDigest, counts }));
  return { schemaVersion: 1, files: sortedFiles, perFile: perFileList, casesDigest, cases, casesTruncated: canonical.length > cases.length, counts, fingerprint };
}

export async function readVitestReport(
  plan: VitestRunPlan,
  window: { startMs: number; endMs: number },
  rootDir: string,
): Promise<ReportParseResult> {
  const pathProblem = await reportPathProblem(plan, rootDir);
  if (pathProblem) return { status: 'invalid', detail: pathProblem };
  if (!plan.ownedReportDir) return { status: 'invalid', detail: '报告目录缺少所有权记录' };

  // 通过受控目录打开：O_NOFOLLOW + fd 身份 + 真实路径 + 读取后再复核父目录身份（R3-01）
  let read: Awaited<ReturnType<typeof readOwnedFile>>;
  try {
    read = await readOwnedFile(plan.ownedReportDir, 'vitest-report.json', { maxBytes: MAX_REPORT_BYTES });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', detail: `无法读取报告：${(e as Error).message}` };
  }
  const stat = read.stat;
  const mtimeMs = Number(stat.mtimeMs);
  if (mtimeMs < window.startMs - 2000) {
    return { status: 'reused', detail: `报告修改时间早于本次运行（${new Date(mtimeMs).toISOString()}）` };
  }
  const buf = read.buf;
  const sha = createHash('sha256').update(buf).digest('hex');
  const bytes = buf.length;
  let raw: RawVitestReport;
  try {
    raw = JSON.parse(buf.toString('utf8')) as RawVitestReport;
  } catch {
    return { status: 'invalid', detail: '报告不是合法 JSON', sha256: sha, bytes };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.testResults)) {
    return { status: 'invalid', detail: '报告缺少 testResults 数组' };
  }
  const problems: string[] = [];
  const nums = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'] as const;
  for (const k of nums) if (!isNonNegInt(raw[k])) problems.push(`缺少或非法的计数字段 ${k}`);
  if (typeof raw.startTime !== 'number' || !Number.isFinite(raw.startTime)) problems.push('缺少 startTime');
  if (typeof raw.success !== 'boolean') problems.push('缺少 success 标志');
  if (problems.length) {
    return { status: 'inconsistent', detail: problems.join('；'), sha256: sha, bytes };
  }
  const counts: TestCounts = {
    total: raw.numTotalTests as number,
    passed: raw.numPassedTests as number,
    failed: raw.numFailedTests as number,
    skipped: raw.numPendingTests as number,
    todo: raw.numTodoTests as number,
  };
  if (counts.total !== counts.passed + counts.failed + counts.skipped + counts.todo) {
    problems.push(`总数与分项不一致：total=${counts.total}，分项和=${counts.passed + counts.failed + counts.skipped + counts.todo}`);
  }
  // 逐条核对 assertionResults，既要计数一致，也要能列出真实失败的用例名
  let aggPassed = 0;
  let aggFailed = 0;
  let aggSkipped = 0;
  let aggTodo = 0;
  const failedNames: string[] = [];
  for (const tr of raw.testResults as RawTestResult[]) {
    const assertions = Array.isArray(tr.assertionResults) ? (tr.assertionResults as RawAssertion[]) : [];
    for (const a of assertions) {
      const st = a.status;
      if (st === 'passed') aggPassed += 1;
      else if (st === 'failed') {
        aggFailed += 1;
        const name = typeof a.fullName === 'string' ? a.fullName : typeof a.title === 'string' ? a.title : '（未命名用例）';
        failedNames.push(name.slice(0, 200));
      } else if (st === 'pending' || st === 'skipped') aggSkipped += 1;
      else if (st === 'todo') aggTodo += 1;
      else problems.push(`未知的用例状态：${String(st)}`);
    }
  }
  if (aggPassed !== counts.passed) problems.push(`通过计数不一致：报告=${counts.passed}，逐条=${aggPassed}`);
  if (aggFailed !== counts.failed) problems.push(`失败计数不一致：报告=${counts.failed}，逐条=${aggFailed}`);
  if (aggSkipped !== counts.skipped) problems.push(`跳过计数不一致：报告=${counts.skipped}，逐条=${aggSkipped}`);
  if (aggTodo !== counts.todo) problems.push(`todo 计数不一致：报告=${counts.todo}，逐条=${aggTodo}`);
  const expectSuccess = counts.failed === 0;
  if (raw.success !== expectSuccess) {
    problems.push(`success 标志与失败计数矛盾：success=${String(raw.success)}，failed=${counts.failed}`);
  }
  const startTime = raw.startTime as number;
  if (startTime < window.startMs - 5000 || startTime > window.endMs + 5000) {
    problems.push(`报告运行时间不在本次运行窗口内（startTime=${new Date(startTime).toISOString()}）`);
  }
  const countsInconsistent = problems.some((p) => p.includes('不一致') || p.includes('矛盾'));
  if (countsInconsistent) {
    return { status: 'inconsistent', detail: problems.join('；'), sha256: sha, bytes };
  }
  const executedFiles: string[] = [];
  // 报告里的文件名是真实路径（vitest 会把工作树 realpath 化），根目录也必须取 realpath 才能算相对路径。
  let realRoot = rootDir;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch {
    realRoot = rootDir;
  }
  const execution = buildExecutionManifest(raw.testResults as RawTestResult[], realRoot);
  executedFiles.push(...execution.files);
  const checks: Record<string, boolean> = {
    regularFile: stat.isFile(),
    notSymlink: !stat.isSymbolicLink(),
    noHardlink: stat.nlink <= 1n,
    sizeOk: stat.size > 0n && stat.size <= BigInt(MAX_REPORT_BYTES),
    mtimeInWindow: Number(stat.mtimeMs) >= window.startMs - 2000,
    startTimeInWindow: startTime >= window.startMs - 5000 && startTime <= window.endMs + 5000,
    countsConsistent: !countsInconsistent,
    successConsistent: raw.success === (counts.failed === 0),
    testResultsArray: Array.isArray(raw.testResults),
  };
  return { status: 'ok', sha256: sha, bytes, counts, failedNames: failedNames.slice(0, 50), executedFiles, execution, startTime, problems, checks };
}

/** 生成报告证据对象（写入任务记录）。 */
export function buildReportEvidence(opts: {
  plan: VitestRunPlan;
  parse: Extract<ReportParseResult, { status: 'ok' }>;
  stdoutSummary: { passed: number; failed: number } | undefined;
}): TestReportEvidence {
  const { parse, stdoutSummary } = opts;
  // R1-05：如实记录「交叉核对是否真的发生」。拿不到 stdout 摘要时 performed=false，
  // 不得把缺失的核验标记为成功。
  const performed = !!stdoutSummary;
  const agrees = performed && stdoutSummary!.passed === parse.counts.passed && stdoutSummary!.failed === parse.counts.failed;
  const problems = [...parse.problems];
  if (!performed) problems.push('无法从进程 stdout 取得测试摘要，报告交叉核对未发生（不能当作已核对）');
  else if (!agrees) problems.push(`stdout 摘要与报告不一致：stdout=${stdoutSummary!.passed} passed/${stdoutSummary!.failed} failed，报告=${parse.counts.passed}/${parse.counts.failed}`);
  const checks = { ...parse.checks, crossCheckPerformed: performed, crossCheckAgrees: agrees };
  return {
    format: 'vitest-json',
    executedFiles: parse.executedFiles,
    ...(parse.execution ? { execution: parse.execution } : {}),
    pathHash: sha256Text(path.basename(opts.plan.reportDir)).slice(0, 16),
    sha256: parse.sha256,
    bytes: parse.bytes,
    producedDuringRun: !!parse.checks.mtimeInWindow,
    startTimeWithinRun: !!parse.checks.startTimeInWindow,
    counts: parse.counts,
    failedNames: parse.failedNames,
    integrity: { ok: problems.length === 0 && Object.values(checks).every(Boolean), problems, checks },
    crossCheck: {
      performed,
      ...(stdoutSummary ? { stdoutSummary: { passed: stdoutSummary.passed, failed: stdoutSummary.failed } } : {}),
      agrees,
      ...(performed ? {} : { detail: 'stdout 摘要不可解析' }),
    },
  };
}
