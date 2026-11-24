import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeDir, removeSafeSubtree, removeTree } from '../persistence/files.js';
import type { TestCounts, TestReportEvidence } from './model.js';

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
  /** 创建时核实的工作树真实根目录（用于清理前重新核实身份，防止符号链接逃逸与目录身份变化） */
  realRootDir: string;
}

/**
 * 校验并确保工作树受控父目录存在且绝对非符号链接（针对 R2-01：严防符号链接逃逸与非预期目录）。
 * 返回受控的 .studio/evidence 真实路径。
 */
export async function assertSafeControlledDir(dir: string, subPath: string): Promise<{ realRoot: string; controlledPath: string }> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(dir);
  } catch (e) {
    throw new Error(`被测工作树不可解析或不存在: ${(e as Error).message}`);
  }
  const rootStat = await fs.lstat(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`工作树根路径不是普通目录: ${realRoot}`);
  }

  // 严格逐级校验与安全创建，沿途（.studio 及子路径）严禁为符号链接
  const parts = subPath.split(path.sep).filter(Boolean);
  let cur = realRoot;
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      const lst = await fs.lstat(cur);
      if (lst.isSymbolicLink()) {
        throw new Error(`受控目录沿途包含符号链接，拒绝使用: ${cur}`);
      }
      if (!lst.isDirectory()) {
        throw new Error(`受控路径不是目录: ${cur}`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        await makeDir(cur);
        const postLst = await fs.lstat(cur);
        if (postLst.isSymbolicLink() || !postLst.isDirectory()) {
          throw new Error(`创建受控目录后校验失败: ${cur}`);
        }
      } else {
        throw err;
      }
    }
    const realCur = await fs.realpath(cur);
    if (realCur !== cur) {
      throw new Error(`受控目录发生真实路径漂移或包含链接: ${cur} !== ${realCur}`);
    }
  }

  return { realRoot, controlledPath: cur };
}

/** 生成宿主专用的报告路径，并确保运行前不存在任何旧文件。 */
export async function prepareVitestRun(dir: string, script: string): Promise<VitestRunPlan> {
  const { realRoot, controlledPath: evidenceRootPath } = await assertSafeControlledDir(dir, path.join('.studio', 'evidence'));
  const nonce = randomBytes(16).toString('hex');
  const reportDir = path.join(evidenceRootPath, nonce);

  // 若预存 nonce 目录则先清理
  try {
    await removeSafeSubtree(evidenceRootPath, reportDir);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  await makeDir(reportDir);
  const lstat = await fs.lstat(reportDir);
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    throw new Error(`新建报告目录不安全: ${reportDir}`);
  }

  const reportPath = path.join(reportDir, 'vitest-report.json');
  const argv = ['npm', 'run', 'test', '--silent', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`];
  return { reportPath, reportDir, argv, nonce, realRootDir: realRoot };
}

export async function cleanupVitestRun(plan: VitestRunPlan): Promise<void> {
  try {
    const evidenceRoot = path.join(plan.realRootDir, '.studio', 'evidence');
    await removeSafeSubtree(evidenceRoot, plan.reportDir);
  } catch {
    // 清理失败不抛给上层，但严格受 removeSafeSubtree 保护决不越界删除外部文件
  }
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
/** 报告路径必须位于受控目录（工作树 .studio/evidence/<nonce>/），且沿途不得是符号链接。 */
async function reportPathProblem(plan: VitestRunPlan, rootDir: string): Promise<string | undefined> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch {
    return '被测工作树不可解析';
  }
  try {
    const evidenceRoot = path.join(realRoot, '.studio', 'evidence');
    const realDir = await fs.realpath(plan.reportDir);
    if (realDir !== path.join(evidenceRoot, plan.nonce)) return '报告目录不在受控位置（可能经过符号链接或路径逃逸）';
    const lstat = await fs.lstat(plan.reportDir);
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) return '报告目录是符号链接';
    try {
      const realFile = await fs.realpath(plan.reportPath);
      if (realFile !== path.join(realDir, 'vitest-report.json')) return '报告文件路径逃逸';
    } catch {
      // 文件不存在是合法状态（缺失报告），由 readVitestReport 返回 missing；这里只校验父目录受控
    }
  } catch (e) {
    return `报告路径不可核实：${(e as Error).message}`;
  }
  return undefined;
}

export async function readVitestReport(
  plan: VitestRunPlan,
  window: { startMs: number; endMs: number },
  rootDir: string,
): Promise<ReportParseResult> {
  const pathProblem = await reportPathProblem(plan, rootDir);
  if (pathProblem) return { status: 'invalid', detail: pathProblem };

  // 原子性打开报告文件描述符，并在文件描述符上执行 fstat，防御 TOCTOU / 符号链接替换竞态
  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fs.open(plan.reportPath, 'r');
  } catch (err: any) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', detail: `无法打开报告文件: ${err.message}` };
  }

  let stat: import('node:fs').Stats;
  let buf: Buffer;
  try {
    // 确保真实文件路径依然与计划路径完全一致
    const realFile = await fs.realpath(plan.reportPath);
    const realDir = await fs.realpath(plan.reportDir);
    if (realFile !== path.join(realDir, 'vitest-report.json')) {
      return { status: 'invalid', detail: '报告文件路径发生替换或逃逸' };
    }

    stat = await fh.stat();
    if (stat.isSymbolicLink()) return { status: 'invalid', detail: '报告路径是符号链接' };
    if (!stat.isFile()) return { status: 'invalid', detail: '报告路径不是普通文件' };
    if (stat.nlink > 1) return { status: 'invalid', detail: '报告文件存在硬链接（可能被复用或预置）' };
    if (stat.size <= 0 || stat.size > MAX_REPORT_BYTES) return { status: 'invalid', detail: `报告大小异常：${stat.size}` };
    // 报告必须产生于本次运行窗口内（运行前目录已被清空）
    if (stat.mtimeMs < window.startMs - 2000) return { status: 'reused', detail: `报告修改时间早于本次运行（${new Date(stat.mtimeMs).toISOString()}）` };

    buf = await fh.readFile();
  } catch (e) {
    return { status: 'invalid', detail: `无法读取报告：${(e as Error).message}` };
  } finally {
    await fh.close().catch(() => undefined);
  }
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
  for (const tr of raw.testResults as RawTestResult[]) {
    const name = typeof tr.name === 'string' ? tr.name : '';
    if (!name) continue;
    let rel: string;
    try {
      rel = path.relative(realRoot, name).split(path.sep).join('/');
    } catch {
      rel = name;
    }
    executedFiles.push(rel.startsWith('..') ? name : rel);
  }
  const checks: Record<string, boolean> = {
    regularFile: stat.isFile(),
    notSymlink: !stat.isSymbolicLink(),
    noHardlink: stat.nlink <= 1,
    sizeOk: stat.size > 0 && stat.size <= MAX_REPORT_BYTES,
    mtimeInWindow: stat.mtimeMs >= window.startMs - 2000,
    startTimeInWindow: startTime >= window.startMs - 5000 && startTime <= window.endMs + 5000,
    countsConsistent: !countsInconsistent,
    successConsistent: raw.success === (counts.failed === 0),
    testResultsArray: Array.isArray(raw.testResults),
  };
  return { status: 'ok', sha256: sha, bytes, counts, failedNames: failedNames.slice(0, 50), executedFiles, startTime, problems, checks };
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
