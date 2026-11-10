import os from 'node:os';
import type { StoredCheckProof, Task } from '../task/model.js';
import type { DeniedOperation } from '../executor/types.js';
import type { FileChange } from '../git/git.js';
import type { ChangePreview } from './snippets.js';
import { deniedImpactText, deniedText, notCheckedText, safeRelPath, scrubAiText } from './texts.js';

export type ProofTab = 'test' | 'build' | 'denied' | 'changes';

export interface TestCaseProof {
  name: string;
  status: 'passed' | 'failed';
  durationText?: string;
}

export interface SingleCheckProof {
  key: 'build' | 'test';
  title: string;
  round: number;
  ranAtText: string | null;
  envLabel: '沙箱环境' | '本机环境';
  originNote: string;
  status: 'passed' | 'failed' | 'not_checked';
  summaryText: string;
  cases: TestCaseProof[];
  parsedNames: boolean;
  passedCount: number;
  failedCount: number;
  filteredDetails: string;
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

/** 从过滤后的测试输出中尽量解析逐项测试名称；无法解析出具体测试名时回退为通过/失败数量。 */
export function parseTestCases(
  filtered: string,
  checkStatus: 'passed' | 'failed',
): { cases: TestCaseProof[]; parsedNames: boolean; passedCount: number; failedCount: number } {
  const cases: TestCaseProof[] = [];
  let summaryPassed: number | null = null;
  let summaryFailed: number | null = null;

  for (const rawLine of filtered.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // 统计总结行（Vitest / Jest / Node test / Mocha）
    const vSum = line.match(/Tests?\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i);
    if (vSum) {
      summaryFailed = vSum[1] ? Number(vSum[1]) : 0;
      summaryPassed = Number(vSum[2]);
      continue;
    }
    const vFailOnly = line.match(/Tests?\s+(\d+)\s+failed(?:\s+\((\d+)\))?/i);
    if (vFailOnly) {
      summaryFailed = Number(vFailOnly[1]);
      summaryPassed = vFailOnly[2] ? Math.max(0, Number(vFailOnly[2]) - summaryFailed) : 0;
      continue;
    }
    const tapPass = line.match(/^pass\s+(\d+)/i);
    const tapFail = line.match(/^fail\s+(\d+)/i);
    if (tapPass) {
      summaryPassed = Number(tapPass[1]);
      continue;
    }
    if (tapFail) {
      summaryFailed = Number(tapFail[1]);
      continue;
    }

    // 跳过 Vitest 文件汇总行（如 ✓ tests/a.test.ts (3 tests) 10ms）
    if (/^[✓✔✗×✖✘]\s+\S+\.(?:test|spec)\.\w+\s+\(\d+\s+tests?\)/i.test(line)) continue;

    let m = line.match(/^[✓✔√]\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      const name = m[1]!.trim();
      if (name && !/^\d+\s+passing/i.test(name)) {
        cases.push({ name: name.slice(0, 160), status: 'passed', ...(m[2] ? { durationText: m[2] } : {}) });
      }
      continue;
    }
    m = line.match(/^[✗×✖✘]\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      const name = m[1]!.trim();
      if (name && !/^\d+\s+failing/i.test(name)) {
        cases.push({ name: name.slice(0, 160), status: 'failed', ...(m[2] ? { durationText: m[2] } : {}) });
      }
      continue;
    }
    m = line.match(/^(?:PASS|ok\s+\d+\s+-)\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      cases.push({ name: m[1]!.trim().slice(0, 160), status: 'passed', ...(m[2] ? { durationText: m[2] } : {}) });
      continue;
    }
    m = line.match(/^(?:FAIL|not ok\s+\d+\s+-)\s+(.+?)(?:\s+\(?(\d+\s*m?s)\)?)?$/);
    if (m) {
      cases.push({ name: m[1]!.trim().slice(0, 160), status: 'failed', ...(m[2] ? { durationText: m[2] } : {}) });
      continue;
    }

    const mochaPass = line.match(/^(\d+)\s+passing/i);
    const mochaFail = line.match(/^(\d+)\s+failing/i);
    if (mochaPass) summaryPassed = Number(mochaPass[1]);
    if (mochaFail) summaryFailed = Number(mochaFail[1]);
  }

  if (cases.length > 0) {
    const passedFromCases = cases.filter((c) => c.status === 'passed').length;
    const failedFromCases = cases.filter((c) => c.status === 'failed').length;
    return {
      cases,
      parsedNames: true,
      passedCount: summaryPassed ?? passedFromCases,
      failedCount: summaryFailed ?? failedFromCases,
    };
  }

  return {
    cases: [],
    parsedNames: false,
    passedCount: summaryPassed ?? (checkStatus === 'passed' ? 1 : 0),
    failedCount: summaryFailed ?? (checkStatus === 'failed' ? 1 : 0),
  };
}

function buildSingleCheckProof(
  key: 'build' | 'test',
  round: number,
  stored: StoredCheckProof | undefined,
  cardItemStatus: string | undefined,
  cardItemEvidence: string | undefined,
  envDefault: 'sandbox' | 'local',
  fallbackTime: string | undefined,
  filterOpts: FilterProofOptions,
): SingleCheckProof {
  const title = key === 'build' ? '构建检查' : '自动测试';
  const env = stored?.env ?? envDefault;
  const envLabel: '沙箱环境' | '本机环境' = env === 'local' ? '本机环境' : '沙箱环境';
  const missingMsg = key === 'build' ? '未检查：这个项目没有构建检查' : '未检查：这个项目没有自动测试';

  if (stored) {
    if (stored.status === 'not_available') {
      const reason = stored.unavailableReason ?? '';
      const isNone = reason.includes('项目没有');
      return {
        key,
        title,
        round,
        ranAtText: null,
        envLabel,
        originNote: ORIGIN_NOTE,
        status: 'not_checked',
        summaryText: isNone ? missingMsg : notCheckedText(key, reason),
        cases: [],
        parsedNames: false,
        passedCount: 0,
        failedCount: 0,
        filteredDetails: '',
      };
    }
    const filteredDetails = filterProofOutput(stored.rawOutput ?? '', filterOpts);
    const ranAtText = formatProofTime(stored.ranAt ?? fallbackTime);
    if (key === 'test') {
      const parsed = parseTestCases(filteredDetails, stored.status);
      return {
        key,
        title,
        round,
        ranAtText,
        envLabel,
        originNote: ORIGIN_NOTE,
        status: stored.status,
        summaryText: `${parsed.passedCount} 项通过 · ${parsed.failedCount} 项失败`,
        cases: parsed.cases,
        parsedNames: parsed.parsedNames,
        passedCount: parsed.passedCount,
        failedCount: parsed.failedCount,
        filteredDetails,
      };
    }
    const sec = stored.durationMs !== undefined ? Math.round(stored.durationMs / 1000) : null;
    return {
      key,
      title,
      round,
      ranAtText,
      envLabel,
      originNote: ORIGIN_NOTE,
      status: stored.status,
      summaryText: stored.status === 'passed' ? `通过${sec !== null ? `（${sec} 秒）` : ''}` : '构建未通过',
      cases: [],
      parsedNames: false,
      passedCount: stored.status === 'passed' ? 1 : 0,
      failedCount: stored.status === 'failed' ? 1 : 0,
      filteredDetails,
    };
  }

  // 兼容只有旧验收卡条目而尚未存储 StoredCheckProof 的任务（如纯单元测试样本）
  if (cardItemStatus === 'verified' || cardItemStatus === 'failed') {
    const passed = cardItemStatus === 'verified';
    return {
      key,
      title,
      round,
      ranAtText: formatProofTime(fallbackTime),
      envLabel,
      originNote: ORIGIN_NOTE,
      status: passed ? 'passed' : 'failed',
      summaryText: passed ? (key === 'test' ? '1 项通过 · 0 项失败' : '通过') : (key === 'test' ? '0 项通过 · 1 项失败' : '未通过'),
      cases: [],
      parsedNames: false,
      passedCount: passed ? 1 : 0,
      failedCount: passed ? 0 : 1,
      filteredDetails: '',
    };
  }

  const isNone = !cardItemEvidence || cardItemEvidence.startsWith('项目没有');
  return {
    key,
    title,
    round,
    ranAtText: null,
    envLabel,
    originNote: ORIGIN_NOTE,
    status: 'not_checked',
    summaryText: isNone ? missingMsg : notCheckedText(key, cardItemEvidence),
    cases: [],
    parsedNames: false,
    passedCount: 0,
    failedCount: 0,
    filteredDetails: '',
  };
}

export function buildTaskProofFromParts(opts: {
  round: number;
  checks?: StoredCheckProof[] | undefined;
  cardItems?: { key: string; status: string; evidence: string }[] | undefined;
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
    build: buildSingleCheckProof('build', opts.round, buildStored, buildItem?.status, buildItem?.evidence, envDefault, opts.fallbackTime, opts.filterOpts),
    test: buildSingleCheckProof('test', opts.round, testStored, testItem?.status, testItem?.evidence, envDefault, opts.fallbackTime, opts.filterOpts),
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
  });
}
