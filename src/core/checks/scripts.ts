import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcOutcome } from '../proc/run.js';
import type { Capabilities } from '../capabilities/model.js';
import { hostEnv } from '../env/host-env.js';
import { makeDir } from '../persistence/files.js';
import type { FullTrustRecords } from '../executor/modes.js';
import { uncheckedReasonText } from '../task/messages.js';

/**
 * 项目脚本检查（build / test）。B3：脚本不再由宿主直接运行，而是通过执行体提供的“沙箱命令运行器”
 * （Codex app-server 的 command/exec，与施工使用同一权限配置档）运行。
 * 受限环境不可用 → 结果为“未检查”（not_available），绝不回退到宿主直接运行。
 * 授权绑定脚本内容摘要：批准时记录摘要，运行前重算，不一致则授权失效、不运行。
 */

export type CheckName = 'build' | 'test';

export type CheckResult =
  | { name: CheckName; status: 'not_available'; reason: string }
  | { name: CheckName; status: 'passed' | 'failed'; outcome: ProcOutcome; output: string; durationMs: number };

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

export interface RunCheckOptions {
  timeoutMs?: number;
  /** 批准时记录的脚本摘要；不传表示没有授权 → 不运行 */
  authorizedDigest?: string | undefined;
  capabilities?: Capabilities;
  taskId?: string;
  fullTrustRecords?: FullTrustRecords;
}

export async function runCheck(dir: string, name: CheckName, runner: SandboxCommandRunner | undefined, opts: RunCheckOptions = {}): Promise<CheckResult> {
  const scripts = await detectScripts(dir);
  if (!scripts[name]) {
    return { name, status: 'not_available', reason: `项目没有 ${name} 脚本，因此未检查。` };
  }
  if (!runner) return { name, status: 'not_available', reason: '没有可用的受限运行环境，脚本不会在你的电脑上直接运行，因此未检查。' };
  // 授权必须绑定脚本内容：没有授权记录、或脚本相对批准时发生了变化，一律不运行
  const digest = await scriptsDigest(dir);
  if (!opts.authorizedDigest) return { name, status: 'not_available', reason: '这些脚本没有经过你的批准，因此未检查。' };
  if (digest !== opts.authorizedDigest) return { name, status: 'not_available', reason: '脚本内容与你批准时不同（授权已失效），因此未检查。' };

  await makeDir(path.join(dir, '.studio', 'tmp'));
  const developerDir = await fs.stat('/Library/Developer/CommandLineTools').then(() => true, () => false);
  const r = await runner.runCommand({
    cwd: dir,
    argv: ['npm', 'run', name, '--silent'],
    env: minimalCheckEnv(hostEnv(), dir, developerDir),
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.fullTrustRecords ? { fullTrustRecords: opts.fullTrustRecords } : {}),
  });
  if (r.status === 'unavailable') return { name, status: 'not_available', reason: `受限运行环境不可用（${r.reason}），因此未检查。` };
  const outcome: ProcOutcome = r.timedOut ? { kind: 'timed_out' } : r.exitCode === null ? { kind: 'spawn_error', message: '命令没有返回退出码' } : { kind: 'exited', code: r.exitCode };
  const passed = outcome.kind === 'exited' && outcome.code === 0;
  const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-20_000);
  return { name, status: passed ? 'passed' : 'failed', outcome, output, durationMs: r.durationMs };
}

export interface ChecksSummary {
  passed: number;
  failed: number;
}

export type UncheckedKind = 'none' | 'unavailable';
export type UnavailableReason = 'sandbox_unavailable' | 'scripts_changed_reauth' | 'other';
export type ProjectChecksKind = UncheckedKind | 'ran';

export interface ProjectChecksOutcome {
  /** none：无构建/测试脚本；unavailable：有脚本但至少一项未能运行；ran：声明的脚本全部运行 */
  kind: ProjectChecksKind;
  /** kind === 'unavailable' 时的原因分类 */
  unavailableReason?: UnavailableReason;
  /** none / unavailable 时给用户看的说明文案 */
  reasonText?: string;
  results: CheckResult[];
  /** 至少声明了一项脚本且全部实际运行并通过（没有任何脚本被跳过为 not_available），才为 true */
  checked: boolean;
  summary: ChecksSummary;
  failed: CheckResult[];
  checkedAt?: string;
}

function classifyUnavailable(
  notAvailable: Extract<CheckResult, { status: 'not_available' }>[],
  digestChangedOrMissing: boolean,
): UnavailableReason {
  if (digestChangedOrMissing || notAvailable.some((c) => c.reason.startsWith('脚本内容与你批准时不同') || c.reason.startsWith('这些脚本没有经过你的批准'))) {
    return 'scripts_changed_reauth';
  }
  if (notAvailable.some((c) => c.reason.includes('受限运行环境'))) {
    return 'sandbox_unavailable';
  }
  return 'other';
}

/**
 * 复用 detectScripts 的识别结果，在指定目录（如保存试合并的临时 worktree）运行项目声明的自动检查。
 * 区分 none（无脚本）/ unavailable（有脚本但至少一项没能运行）/ ran（全部运行）。
 * 没有可用脚本或任一项无法在受限环境运行时，checked 为 false，绝不把未检查标成通过。
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
    };
  }
  const results: CheckResult[] = [];
  for (const name of names) {
    results.push(await runCheck(dir, name, runner, opts));
  }
  const passed = results.filter((c) => c.status === 'passed').length;
  const failed = results.filter((c) => c.status === 'failed');
  const notAvail = results.filter((c): c is Extract<CheckResult, { status: 'not_available' }> => c.status === 'not_available');
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
      ...checkedAt,
    };
  }
  const checked = failed.length === 0;
  return {
    kind: 'ran',
    results,
    checked,
    summary: { passed, failed: failed.length },
    failed,
    ...checkedAt,
  };
}
