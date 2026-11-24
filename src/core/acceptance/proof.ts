import os from 'node:os';
import type { StoredCheckProof, Task, TaskRound } from '../task/model.js';
import type { DeniedOperation } from '../executor/types.js';
import type { FileChange } from '../git/git.js';
import type { ChangePreview } from './snippets.js';
import { deniedImpactText, deniedText, notCheckedText, safeRelPath, scrubAiText } from './texts.js';
import { adjudicateEvidence, adjudicateStoredProof, type CheckAdjudication, type EvidenceIdentityContextForAdjudication } from '../evidence/adjudicate.js';

export type ProofTab = 'test' | 'build' | 'denied' | 'changes';

export interface TestCaseProof {
  name: string;
  status: 'passed' | 'failed';
  durationText?: string;
}

export type ProofStatus = 'passed' | 'failed' | 'not_checked' | 'unverified' | 'invalidated';

/** 测试数量的唯一可信来源：结构化报告 > stdout 的显式数字摘要；都没有就是 unknown（绝不默认生成）。 */
export type ProofCountsSource = 'structured_report' | 'stdout_summary' | 'unknown';

export interface SingleCheckProof {
  key: 'build' | 'test';
  title: string;
  round: number;
  ranAtText: string | null;
  envLabel: '沙箱环境' | '本机环境';
  originNote: string;
  status: ProofStatus;
  summaryText: string;
  cases: TestCaseProof[];
  parsedNames: boolean;
  /** 真实测试数量；null = 测试数量未知（未取得有效测试证据）。用于界面展示，绝不补造。 */
  counts: { passed: number; failed: number; skipped: number; total: number } | null;
  countsSource: ProofCountsSource;
  filteredDetails: string;
  /** 缺乏可信证据 / 证据失效的结构化原因 */
  unknownReason?: string;
  /** 证据事实（运行身份、报告完整性、测试范围、配置指纹）——只展示可核对的事实 */
  proofFacts?: string[];
}

export interface ProofDeniedEntry {
  id: string;
  text: string;
  impact: string;
  acked: boolean;
}

export interface ProofChangeEntry {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
  additions: number | null;
  deletions: number | null;
  preview?: ChangePreview;
}

export interface TaskProofView {
  round: number;
  build: SingleCheckProof;
  test: SingleCheckProof;
  denied: ProofDeniedEntry[];
  changes: ProofChangeEntry[];
}

export interface FilterProofOptions {
  homeDir?: string;
  repoPath?: string;
  worktreePath?: string;
}

const ORIGIN_NOTE = '由本应用运行，不是 AI 自报';
const MAX_DETAILS_CHARS = 12_000;
const MAX_DETAIL_LINES = 160;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatProofTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 详细记录过滤：在发往界面前去掉命令行、环境变量、密钥形态字符串，并将用户主目录绝对路径替换为 ~。
 * 完整原始记录仅保存在本机 .studio/ 任务记录中，绝不直接暴露到渲染层。
 */
export function filterProofOutput(raw: string, opts: FilterProofOptions = {}): string {
  if (!raw || !raw.trim()) return '';
  let text = raw.replace(/\r\n/g, '\n');

  // 1. 去掉私钥块等跨行密钥
  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[密钥已隐去]');

  // 2. 先把已知副本/项目根与用户主目录路径替换为 ~（避免带出本机用户名）
  if (opts.worktreePath) {
    text = text.replace(new RegExp(escapeRegExp(opts.worktreePath), 'g'), '[任务副本]');
  }
  const home = opts.homeDir ?? os.homedir();
  if (home && home !== '/' && home !== '~') {
    text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  }
  // 匹配任意未命中的 /Users/<name>、/home/<name>、C:\Users\<name> 主目录前缀
  text = text
    .replace(/\/Users\/[^/\s:'")\]}<>,]+/g, '~')
    .replace(/\/home\/[^/\s:'")\]}<>,]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s:'")\]}<>,]+/g, '~');

  if (opts.repoPath) {
    const mappedRepo = opts.repoPath
      .replace(/\/Users\/[^/\s:'")\]}<>,]+/g, '~')
      .replace(/\/home\/[^/\s:'")\]}<>,]+/g, '~');
    if (mappedRepo && mappedRepo !== '~') {
      text = text.replace(new RegExp(escapeRegExp(mappedRepo), 'g'), '[项目目录]');
    }
  }

  // 其他临时目录与系统可执行目录
  text = text
    .replace(/\/(?:private\/)?var\/folders\/[^\s:'")\]}<>]+/g, '[临时路径已隐去]')
    .replace(/(?<![\w~])\/tmp\/[^\s:'")\]}<>]+/g, '[临时路径已隐去]')
    .replace(/\/usr\/(?:local\/)?(?:bin|lib|share)\/[^\s:'")\]}<>]+/g, '[本机路径已隐去]');

  // 3. 逐行过滤命令行提示与环境变量倾倒，并清洗密钥形态与内联命令
  const cleanedLines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    // 命令行（> npm test / $ vitest / + node ...）
    if (/^[>$+]\s+\S/.test(trimmed)) return '[命令行已隐去]';

    // export FOO=bar 或 env assignment line (KEY=val)
    if (/^(?:export\s+)?[A-Z_][A-Z0-9_]{1,}=.*$/.test(trimmed)) return '[环境变量已隐去]';

    let s = line;
    // 内联密钥形态字符串
    s = s
      .replace(/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{10,}\b/g, '[密钥已隐去]')
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '[密钥已隐去]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[密钥已隐去]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[密钥已隐去]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[密钥已隐去]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[密钥已隐去]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[密钥已隐去]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/gi, '[密钥已隐去]')
      .replace(/(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client_secret)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, '[密钥已隐去]');

    // 内联 KEY=VAL 环境变量形态（保留常见纯小写测试字样，仅匹配全大写键）
    s = s.replace(/(?:^|\s)(?:export\s+)?[A-Z][A-Z0-9_]{1,}=(?:"[^"]*"|'[^']*'|\S+)/g, ' [环境变量已隐去]');

    // 内联完整命令行调用（先去掉 npm/npx/vitest/node 完整命令行，再复用 scrubAiText 并保护已转换的 ~ 主目录路径）
    s = s
      .replace(/\b(?:npm|npx|yarn|pnpm)\s+(?:(?:run|exec|test|build|install|ci)\s+|vitest\b|jest\b)[^\n,，;；]*/gi, '[命令行已隐去]')
      .replace(/\b(?:vitest|jest|mocha|pytest|cargo\s+test|go\s+test)\s+[^\n,，;；]*/gi, '[命令行已隐去]')
      .replace(/\bnode\s+(?:-[A-Za-z-]+|[^\s]*(?:\.c?js|\.mjs|\.ts)\b)[^\n,，;；]*/gi, '[命令行已隐去]');
    const keptHomePaths: string[] = [];
    s = s.replace(/(^|[\s:'"(\[{])(~(?:[\\/][\w.@+~ -]+)+)/g, (_m, lead: string, hp: string) => {
      const idx = keptHomePaths.length;
      keptHomePaths.push(hp);
      return `${lead}__STUDIO_HOME_PATH_${idx}__`;
    });
    s = scrubAiText(s);
    s = s.replace(/__STUDIO_HOME_PATH_(\d+)__/g, (_m, idx: string) => keptHomePaths[Number(idx)] ?? '~');

    return s.trimEnd();
  });

  const nonEmptyCollapsed: string[] = [];
  for (const l of cleanedLines) {
    if (l === '[命令行已隐去]' && nonEmptyCollapsed.at(-1) === '[命令行已隐去]') continue;
    if (l === '[环境变量已隐去]' && nonEmptyCollapsed.at(-1) === '[环境变量已隐去]') continue;
    nonEmptyCollapsed.push(l);
  }
  return nonEmptyCollapsed.slice(0, MAX_DETAIL_LINES).join('\n').trim().slice(0, MAX_DETAILS_CHARS);
}

export interface ParsedStdoutCases {
  cases: TestCaseProof[];
  parsedNames: boolean;
  /** 仅当 stdout 里存在**显式数字摘要**时才返回计数；否则 null（未知） */
  counts: { passed: number; failed: number; skipped: number; total: number } | null;
}

/**
 * 从过滤后的测试输出中尽量解析逐项测试名称，以及**显式出现**的通过/失败数量。
 *
 * AISS-A1 修正（P0-2）：旧实现会在解析不出数量时按「检查状态」默认生成 1 项通过 / 1 项失败，
 * 这是虚构证据。现在解析不出就返回 null，由界面显示「测试数量未知」，绝不生成通过数量。
 */
export function parseTestCases(filtered: string, _checkStatus?: 'passed' | 'failed' | 'unverified' | 'not_available'): ParsedStdoutCases {
  const cases: TestCaseProof[] = [];
  let summaryPassed: number | null = null;
  let summaryFailed: number | null = null;
  let summarySkipped: number | null = null;

  for (const rawLine of filtered.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // 统计总结行（Vitest / Jest / Node test / Mocha）
    const vSum = line.match(/Tests?\s+(?:(\d+)\s+failed\s*\|\s*)?(?:(\d+)\s+skipped\s*\|\s*)?(\d+)\s+passed/i);
    if (vSum) {
      summaryFailed = vSum[1] ? Number(vSum[1]) : 0;
      summarySkipped = vSum[2] ? Number(vSum[2]) : 0;
      summaryPassed = Number(vSum[3]);
      continue;
    }
    const vFailOnly = line.match(/Tests?\s+(\d+)\s+failed(?:\s+\((\d+)\))?/i);
    if (vFailOnly) {
      summaryFailed = Number(vFailOnly[1]);
      summaryPassed = 0;
      continue;
    }
    const vSkipOnly = line.match(/Tests?\s+(\d+)\s+skipped(?:\s+\((\d+)\))?/i);
    if (vSkipOnly) {
      summarySkipped = Number(vSkipOnly[1]);
      continue;
    }
    const tapPass = line.match(/^pass\s+(\d+)/i);
    const tapFail = line.match(/^fail\s+(\d+)/i);
    if (tapPass) { summaryPassed = Number(tapPass[1]); continue; }
    if (tapFail) { summaryFailed = Number(tapFail[1]); continue; }

    // 跳过 Vitest 文件汇总行（如 ✓ tests/a.test.ts (3 tests) 10ms）
    if (/^[✓✔✗×✖✘]\s+\S+\.(?:test|spec)\.\w+\s+\(\d+\s+tests?\)/i.test(line)) continue;

    let m = line.match(/^[✓✔√]\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      const name = m[1]!.trim();
      if (name && !/^\d+\s+passing/i.test(name)) cases.push({ name: name.slice(0, 160), status: 'passed', ...(m[2] ? { durationText: m[2] } : {}) });
      continue;
    }
    m = line.match(/^[✗×✖✘]\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      const name = m[1]!.trim();
      if (name && !/^\d+\s+failing/i.test(name)) cases.push({ name: name.slice(0, 160), status: 'failed', ...(m[2] ? { durationText: m[2] } : {}) });
      continue;
    }
    m = line.match(/^(?:PASS|ok\s+\d+\s+-)\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) { cases.push({ name: m[1]!.trim().slice(0, 160), status: 'passed', ...(m[2] ? { durationText: m[2] } : {}) }); continue; }
    m = line.match(/^(?:FAIL|not ok\s+\d+\s+-)\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) { cases.push({ name: m[1]!.trim().slice(0, 160), status: 'failed', ...(m[2] ? { durationText: m[2] } : {}) }); continue; }

    const mochaPass = line.match(/^(\d+)\s+passing/i);
    const mochaFail = line.match(/^(\d+)\s+failing/i);
    if (mochaPass) summaryPassed = Number(mochaPass[1]);
    if (mochaFail) summaryFailed = Number(mochaFail[1]);
  }

  const hasSummary = summaryPassed !== null || summaryFailed !== null || summarySkipped !== null;
  if (!hasSummary) {
    // 没有显式数字摘要：只返回逐项名称（若有），数量未知
    return { cases, parsedNames: cases.length > 0, counts: null };
  }
  const passed = summaryPassed ?? 0;
  const failed = summaryFailed ?? 0;
  const skipped = summarySkipped ?? 0;
  return {
    cases,
    parsedNames: cases.length > 0,
    counts: { passed, failed, skipped, total: passed + failed + skipped },
  };
}

function formatCountsSummary(counts: { passed: number; failed: number; skipped: number; total: number } | null): string {
  if (!counts) return '测试数量未知（未取得有效测试证据）';
  const parts = [`${counts.passed} 项通过`, `${counts.failed} 项失败`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} 项跳过`);
  return parts.join(' · ');
}

function proofFactsOf(stored: StoredCheckProof | undefined): string[] {
  const ev = stored?.evidence;
  if (!ev) return ['历史任务记录：没有新证据模型的宿主证据，标记为历史未核实（未补造证据）'];
  const facts: string[] = [];
  facts.push(`运行环境：${ev.run.env === 'local' ? '本机' : '沙箱'}（${ev.run.sandboxKind}）`);
  facts.push(`被测内容：${ev.identity.testedTree.slice(0, 12)} · 第 ${ev.identity.round} 轮 · 验收版本 ${ev.identity.acceptanceRev}`);
  if (ev.report) {
    facts.push(`测试报告：${ev.report.format} · sha256 ${ev.report.sha256.slice(0, 12)} · ${ev.report.counts.total} 项（通过 ${ev.report.counts.passed} / 失败 ${ev.report.counts.failed} / 跳过 ${ev.report.counts.skipped}）`);
    facts.push(ev.report.integrity?.ok ? '报告完整性校验：通过' : `报告完整性校验：未通过（${(ev.report.integrity?.problems ?? []).join('；')}）`);
    facts.push(ev.report.crossCheck?.performed ? (ev.report.crossCheck.agrees ? '报告与进程输出摘要：一致' : '报告与进程输出摘要：不一致') : '报告与进程输出摘要：未核对（不能当作已核对）');
    facts.push(`实际执行测试文件：${ev.report.executedFiles?.length ?? 0} 个`);
  }
  facts.push(
    ev.scope.kind === 'not_assessed'
      ? '测试范围核对：缺少任务基线，无法核对'
      : `测试范围核对：${ev.scope.kind === 'assessed_weakened' ? '削弱' : ev.scope.kind === 'assessed_needs_review' ? '变化（需人工复核）' : ev.scope.kind === 'assessed_stronger' ? '增强或新增' : '与基线一致'}${ev.scope.reasons.length ? `（${ev.scope.reasons.join('；')}）` : ''}（保守静态核对，不声称证明语义未削弱）`,
  );
  if (ev.config.testInventoryDigest) facts.push(`测试清单指纹：${ev.config.testInventoryDigest.slice(0, 12)} · ${ev.config.testFileCount ?? 0} 文件 / ${ev.config.testBlockCount ?? 0} 测试块 / ${ev.config.assertionCount ?? 0} 断言`);
  if (ev.config.runnerPackage) facts.push(`测试运行器：${ev.config.runnerPackage.name}@${ev.config.runnerPackage.version}`);
  return facts;
}

function proofStatusOf(adj: CheckAdjudication): ProofStatus {
  switch (adj.status) {
    case 'verified':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'not_checked':
      return 'not_checked';
    case 'invalidated':
      return 'invalidated';
    default:
      return 'unverified';
  }
}

function buildSingleCheckProof(
  key: 'build' | 'test',
  round: number,
  stored: StoredCheckProof | undefined,
  ctx: EvidenceIdentityContextForAdjudication | undefined,
  envDefault: 'sandbox' | 'local',
  fallbackTime: string | undefined,
  filterOpts: FilterProofOptions,
  cardItemStatus?: string,
  cardItemEvidence?: string,
): SingleCheckProof {
  const title = key === 'build' ? '构建检查' : '自动测试';
  const env = stored?.env ?? envDefault;
  const envLabel: '沙箱环境' | '本机环境' = env === 'local' ? '本机环境' : '沙箱环境';
  const missingMsg = key === 'build' ? '未检查：这个项目没有构建检查' : '未检查：这个项目没有自动测试';
  // 统一裁决入口：证据详情页不自行解释 passed / 不自行决定有效性与范围
  const adj: CheckAdjudication = stored
    ? adjudicateStoredProof(stored, ctx ?? { taskId: stored.evidence?.identity.taskId ?? '', round, historical: true })
    : cardItemStatus === 'not_checked' || !cardItemStatus
      ? { name: key, status: 'not_checked', detail: missingMsg }
      : adjudicateEvidence(undefined, key, ctx ?? { taskId: '', round, historical: true });
  const status = proofStatusOf(adj);
  const filteredDetails = filterProofOutput(stored?.rawOutput ?? '', filterOpts);
  const ranAtText = formatProofTime(stored?.ranAt ?? fallbackTime);
  const reportCounts = stored?.evidence?.report?.counts ?? null;
  const parsed = key === 'test' ? parseTestCases(filteredDetails) : { cases: [], parsedNames: false, counts: null };
  // R1：数量只来自结构化报告。stdout 里的数字（即使显式）在“没有可信报告”时不能当作测试数量，
  // 否则伪造摘要又能影响展示；这种情形统一显示「测试数量未知」。
  const counts = key === 'test' && reportCounts ? { passed: reportCounts.passed, failed: reportCounts.failed, skipped: reportCounts.skipped, total: reportCounts.total } : null;
  const countsSource: ProofCountsSource = reportCounts ? 'structured_report' : 'unknown';
  let summaryText: string;
  if (status === 'not_checked') {
    const isNone = (cardItemEvidence ?? '').startsWith('项目没有') || (stored?.unavailableReason ?? '').includes('项目没有');
    summaryText = isNone ? missingMsg : adj.detail || notCheckedText(key, cardItemEvidence ?? stored?.unavailableReason ?? '');
  } else if (status === 'unverified') {
    summaryText = `未取得可信证据：${adj.detail}`;
  } else if (status === 'invalidated') {
    summaryText = `证据失效：${adj.detail}`;
  } else if (key === 'test') {
    summaryText = formatCountsSummary(counts);
  } else {
    const sec = stored?.durationMs !== undefined ? Math.round(stored.durationMs / 1000) : null;
    summaryText = status === 'passed' ? `通过${sec !== null ? `（${sec} 秒）` : ''}` : '构建未通过';
  }
  return {
    key,
    title,
    round,
    ranAtText: status === 'not_checked' ? null : ranAtText,
    envLabel,
    originNote: ORIGIN_NOTE,
    status,
    summaryText,
    cases: key === 'test' ? parsed.cases.slice(0, 80) : [],
    parsedNames: key === 'test' ? parsed.parsedNames : false,
    counts,
    countsSource,
    filteredDetails,
    ...(adj.reason ? { unknownReason: adj.reason } : {}),
    proofFacts: proofFactsOf(stored),
  };
}

export function buildTaskProofFromParts(opts: {
  round: number;
  checks?: StoredCheckProof[] | undefined;
  cardItems?: { key: string; status: string; evidence: string }[] | undefined;
  /** 统一裁决上下文（当前轮次做身份校验；历史轮次 historical=true） */
  evidenceContext?: EvidenceIdentityContextForAdjudication | undefined;
  denied: DeniedOperation[];
  deniedAcks: boolean[];
  changes: FileChange[];
  previews?: Map<string, ChangePreview> | undefined;
  constructionMode?: 'standard' | 'full_trust' | undefined;
  fallbackTime?: string | undefined;
  filterOpts: FilterProofOptions;
}): TaskProofView {
  const envDefault: 'sandbox' | 'local' = opts.constructionMode === 'full_trust' ? 'local' : 'sandbox';
  const buildStored = opts.checks?.find((c) => c.name === 'build');
  const testStored = opts.checks?.find((c) => c.name === 'test');
  const buildItem = opts.cardItems?.find((i) => i.key === 'build');
  const testItem = opts.cardItems?.find((i) => i.key === 'test');

  return {
    round: opts.round,
    build: buildSingleCheckProof('build', opts.round, buildStored, opts.evidenceContext, envDefault, opts.fallbackTime, opts.filterOpts, buildItem?.status, buildItem?.evidence),
    test: buildSingleCheckProof('test', opts.round, testStored, opts.evidenceContext, envDefault, opts.fallbackTime, opts.filterOpts, testItem?.status, testItem?.evidence),
    denied: opts.denied.map((d, i) => ({
      id: `d${i}`,
      text: deniedText(d),
      impact: deniedImpactText(d),
      acked: opts.deniedAcks[i] === true,
    })),
    changes: opts.changes.map((c) => {
      const preview = opts.previews?.get(c.path);
      return {
        path: safeRelPath(c.path) ?? '（路径不可显示）',
        kind: c.status,
        additions: c.additions,
        deletions: c.deletions,
        ...(preview ? { preview } : {}),
      };
    }),
  };
}

export function buildTaskProof(
  t: Task,
  opts: { previews?: Map<string, ChangePreview>; repoPath?: string } = {},
): TaskProofView {
  const round = t.currentRound ?? 1;
  return buildTaskProofFromParts({
    round,
    checks: t.currentChecks,
    cardItems: t.card?.items,
    denied: t.denied ?? [],
    deniedAcks: t.deniedAcks ?? [],
    changes: t.card?.changes ?? [],
    previews: opts.previews,
    constructionMode: t.plan?.capabilities.constructionMode,
    fallbackTime: t.roundEndedAt ?? t.updatedAt,
    filterOpts: {
      ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
      ...(t.worktree?.path ? { worktreePath: t.worktree.path } : {}),
    },
    evidenceContext: {
      taskId: t.id,
      round,
      ...(t.acceptanceRev !== undefined ? { acceptanceRev: t.acceptanceRev } : {}),
      ...(t.acceptanceRev !== undefined && t.acceptedTree ? { acceptanceVersion: `${t.acceptedTree.slice(0, 12)}-${t.acceptanceRev}` } : {}),
      ...(t.acceptedTree ? { acceptedTree: t.acceptedTree } : {}),
      ...(t.binding?.repoPath ? { projectRoot: t.binding.repoPath } : {}),
      ...(t.worktree?.path ? { worktreePath: t.worktree.path } : {}),
      ...(t.evidenceInvalid?.reason ? { deepInvalidReason: t.evidenceInvalid.reason } : {}),
      ...(t.scopeReview ? { scopeReview: t.scopeReview } : {}),
    },
  });
}

export function buildRoundProof(
  t: Pick<Task, 'id' | 'worktree' | 'plan'>,
  r: TaskRound,
  opts: { previews?: Map<string, ChangePreview>; repoPath?: string } = {},
): TaskProofView {
  return buildTaskProofFromParts({
    round: r.round,
    checks: r.checks,
    evidenceContext: { taskId: t.id ?? '', round: r.round, historical: true },
    cardItems: r.card?.items,
    denied: r.denied ?? [],
    deniedAcks: r.deniedAcks ?? [],
    changes: r.card?.changes ?? [],
    previews: opts.previews,
    constructionMode: r.capabilities?.constructionMode ?? t.plan?.capabilities.constructionMode,
    fallbackTime: r.endedAt ?? r.startedAt,
    filterOpts: {
      ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
      ...(t.worktree?.path ? { worktreePath: t.worktree.path } : {}),
    },
  });
}
