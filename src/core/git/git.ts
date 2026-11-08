import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { run, isSuccess } from '../proc/run.js';
import { hostEnv } from '../env/host-env.js';

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

/**
 * 受控 Git 执行层（B4-plan 第 1 节）：宿主所有 git 调用都只经过 git() 这一个函数。
 * 固定附加的 -c 参数让项目配置里的钩子、fsmonitor、签名程序、外部 diff、分页器全部失效；
 * 这些是“关闭会执行项目自带程序的入口”，不改变文件内容语义。
 * 做不到“关闭后内容语义不变”的入口（filter / merge / diff 驱动、git-lfs）不在这里关闭，而是由 detectExternalDrivers 检测后停止。
 * GIT_CONFIG_NOSYSTEM 不设置（会改变用户语义）。
 */
export const SAFE_GIT_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'diff.external=',
  '-c', 'core.pager=cat',
];

const hostGitEnv = (extra?: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...hostEnv(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // 继承来的这些变量会让 git 操作落到别的仓库或索引上；外部 diff 程序一律清空
  for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PAGER']) delete env[k];
  return { ...env, ...(extra ?? {}) };
};

/** 按子命令补充固定参数：diff 类不调用外部 diff 与 textconv；提交与合并不运行钩子。 */
function decorate(args: string[]): string[] {
  const [cmd, ...rest] = args;
  if (cmd === 'diff' || cmd === 'log' || cmd === 'show') return [cmd, '--no-ext-diff', '--no-textconv', ...rest];
  if (cmd === 'commit') return [cmd, '--no-verify', ...rest];
  if (cmd === 'merge' && !rest.some((a) => a === '--abort' || a === '--quit' || a === '--continue')) return [cmd, '--no-verify', ...rest];
  return args;
}

export interface GitOptions {
  /** 追加的环境变量（例如 GIT_INDEX_FILE 指向临时索引） */
  env?: Record<string, string>;
  stdin?: string;
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await run('git', [...SAFE_GIT_CONFIG, ...decorate(args)], {
    cwd,
    env: hostGitEnv(opts.env),
    timeoutMs: 60_000,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  if (!isSuccess(r)) throw new GitError(`git ${args[0]} 失败`, r.stderr || r.stdout);
  return r.stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** 初始化仓库并创建第一个保存点。只应在用户同意后调用。 */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main']);
  await ensureIdentity(dir);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--allow-empty', '-m', 'studio: 初始保存点']);
}

/** 仓库若无提交者身份则设置一个仅限本仓库的默认身份，避免提交失败。 */
export async function ensureIdentity(dir: string): Promise<void> {
  const has = async (k: string) => {
    try {
      return (await git(dir, ['config', k])).trim().length > 0;
    } catch {
      return false;
    }
  };
  if (!(await has('user.name'))) await git(dir, ['config', 'user.name', 'AI Solo Studio']);
  if (!(await has('user.email'))) await git(dir, ['config', 'user.email', 'studio@localhost']);
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function headSha(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/**
 * 未提交改动的文件（含未跟踪文件；忽略 .studio/ 内部目录）。
 * 使用 -z 输出，文件名里有空格或中文也不会被转义。
 */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (/[RC]/.test(xy)) i++; // 重命名/复制后面跟着原路径
    if (p === '.studio' || p.startsWith('.studio/')) continue;
    files.push(p);
  }
  return files;
}

export async function isClean(dir: string): Promise<boolean> {
  return (await dirtyFiles(dir)).length === 0;
}

/** 仓库根目录的真实路径；dir 不在任何仓库内则返回 null。 */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const out = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return out ? await fs.realpath(out) : null;
  } catch {
    return null;
  }
}

/** 未提交改动的文件数（含未跟踪文件；忽略 .studio/ 内部目录）。 */
export async function uncommittedCount(dir: string): Promise<number> {
  return (await dirtyFiles(dir)).length;
}

export async function refExists(dir: string, ref: string): Promise<boolean> {
  return gitOk(dir, ['rev-parse', '--verify', '--quiet', ref]);
}

/** a 是否是 b 的祖先（含相同提交） */
export async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  return gitOk(dir, ['merge-base', '--is-ancestor', a, b]);
}

export async function mergeInProgress(dir: string): Promise<boolean> {
  return refExists(dir, 'MERGE_HEAD');
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export function taskBranch(taskId: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(taskId)) throw new Error(`非法任务 ID：${taskId}`);
  return `studio/task-${taskId}`;
}

/** 为任务创建隔离 worktree，位于 <repo>/.studio/worktrees/<id>。 */
export async function createWorktree(repo: string, taskId: string): Promise<Worktree> {
  const branch = taskBranch(taskId);
  const baseSha = await headSha(repo);
  const wtRoot = path.join(repo, '.studio', 'worktrees');
  await fs.mkdir(wtRoot, { recursive: true });
  await ensureStudioIgnored(repo);
  const wtPath = path.join(wtRoot, taskId);
  await git(repo, ['worktree', 'add', '-b', branch, wtPath, baseSha]);
  return { path: wtPath, branch, baseSha };
}

/** 通过 .git/info/exclude 忽略 .studio/，不修改用户的 .gitignore。 */
async function ensureStudioIgnored(repo: string): Promise<void> {
  const gitDir = (await git(repo, ['rev-parse', '--git-common-dir'])).trim();
  const exclude = path.resolve(repo, gitDir, 'info', 'exclude');
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  let content = '';
  try {
    content = await fs.readFile(exclude, 'utf8');
  } catch {}
  if (!content.split('\n').includes('.studio/')) {
    await fs.appendFile(exclude, `${content.endsWith('\n') || content === '' ? '' : '\n'}.studio/\n`);
  }
}

/** 把 worktree 中所有改动（含新文件）提交为一个提交；无改动时返回 null。保存流程不使用它（保存用 commitTree 冻结的验收内容）。 */
export async function commitWorktree(wt: Worktree, message: string): Promise<string | null> {
  await ensureIdentity(wt.path);
  await git(wt.path, ['add', '-A']);
  if (await isClean(wt.path)) {
    const ahead = (await git(wt.path, ['rev-list', '--count', `${wt.baseSha}..HEAD`])).trim();
    return ahead === '0' ? null : headSha(wt.path);
  }
  await git(wt.path, ['commit', '-m', message]);
  return headSha(wt.path);
}

/**
 * 验收内容冻结（B4-plan 第 2 节）：用临时索引（放在 <主仓库>/.studio/ 内，用后删除）把副本当前的全部内容写成一个 tree。
 * 临时索引从副本 HEAD 读起再 add -A：这样“已跟踪但被忽略”的文件也不会被丢掉。不触碰副本自己的索引与任何用户文件。
 */
export async function computeTree(repo: string, worktreePath: string): Promise<string> {
  const dir = path.join(repo, '.studio');
  await fs.mkdir(dir, { recursive: true });
  const idx = path.join(dir, `tree-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    await git(worktreePath, ['read-tree', 'HEAD'], { env });
    await git(worktreePath, ['add', '-A'], { env });
    return (await git(worktreePath, ['write-tree'], { env })).trim();
  } finally {
    await fs.rm(idx, { force: true });
    await fs.rm(`${idx}.lock`, { force: true });
  }
}

/** 以给定 tree 生成提交（不改动任何分支、索引或工作区）。 */
export async function commitTree(dir: string, tree: string, parent: string, message: string): Promise<string> {
  await ensureIdentity(dir);
  return (await git(dir, ['commit-tree', tree, '-p', parent, '-m', message])).trim();
}

export async function treeOf(dir: string, rev: string): Promise<string> {
  return (await git(dir, ['rev-parse', `${rev}^{tree}`])).trim();
}

export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
  path: string;
  additions: number | null;
  deletions: number | null;
  /** 改名时的原路径 */
  oldPath?: string;
}

/** 读取某个 tree / 提交里的一个文件（成果展示用，只读）。不存在返回 null；超过 maxBytes 只返回大小。 */
export type BlobRead = { kind: 'missing' } | { kind: 'too_large'; size: number } | { kind: 'ok'; size: number; text: string };
export async function readBlob(dir: string, rev: string, filePath: string, maxBytes: number): Promise<BlobRead> {
  // rev 必须是 40 位十六进制（tree 或提交）；文件路径只作为 <rev>:<path> 的一部分，不会被当成选项
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error('无效的版本。');
  const spec = `${rev}:${filePath}`;
  let size: number;
  try {
    size = Number((await git(dir, ['cat-file', '-s', spec])).trim());
  } catch {
    return { kind: 'missing' };
  }
  if (!Number.isFinite(size)) return { kind: 'missing' };
  if (size > maxBytes) return { kind: 'too_large', size };
  return { kind: 'ok', size, text: await git(dir, ['cat-file', '-p', spec]) };
}

/** 相对基线的改动清单（包含未提交与未跟踪文件）。 */
export async function diffSummary(wt: Worktree): Promise<FileChange[]> {
  await git(wt.path, ['add', '-A', '--intent-to-add']).catch(() => undefined);
  const nameStatus = await git(wt.path, ['diff', '--name-status', '-M', wt.baseSha]);
  const numstat = await git(wt.path, ['diff', '--numstat', '-M', wt.baseSha]);
  const counts = new Map<string, [number | null, number | null]>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t');
    const p = rest[rest.length - 1] ?? '';
    counts.set(p, [a === '-' ? null : Number(a), d === '-' ? null : Number(d)]);
  }
  const map: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
  return nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const code = (parts[0] ?? '?')[0] ?? '?';
      const p = parts[parts.length - 1] ?? '';
      const [additions, deletions] = counts.get(p) ?? [null, null];
      const change: FileChange = { status: map[code] ?? 'other', path: p, additions, deletions };
      if (code === 'R' && parts.length > 2 && parts[1]) change.oldPath = parts[1];
      return change;
    });
}

export async function diffText(wt: Worktree, maxBytes = 200_000): Promise<string> {
  await git(wt.path, ['add', '-A', '--intent-to-add']).catch(() => undefined);
  const out = await git(wt.path, ['diff', '-M', wt.baseSha]);
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n…（差异过长，已截断）' : out;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'dirty_main'; detail: string };

/**
 * 把一个提交（或分支）以 --no-ff 合并进当前分支。
 * 发生冲突时中止合并；调用方必须再核验主项目状态（见 TaskRunner.save）。
 */
export async function mergeNoFf(repo: string, rev: string, message: string): Promise<MergeResult> {
  if (!(await isClean(repo))) {
    return { ok: false, reason: 'dirty_main', detail: '主项目中有未保存的改动，请先处理后再保存任务。' };
  }
  await ensureIdentity(repo);
  try {
    await git(repo, ['merge', '--no-ff', '-m', message, rev]);
    return { ok: true, sha: await headSha(repo) };
  } catch (e) {
    await git(repo, ['merge', '--abort']).catch(() => undefined);
    return { ok: false, reason: 'conflict', detail: (e as GitError).stderr ?? String(e) };
  }
}

/** 将任务分支合并回主线（保留给简单场景与测试；任务保存走 TaskRunner.save 的完整流程）。 */
export function mergeTask(repo: string, wt: Worktree, message: string): Promise<MergeResult> {
  return mergeNoFf(repo, wt.branch, message);
}

/** 在 preHead..HEAD 的第一父线上找到“第二个父提交是 secondParent”的合并提交（用于中断后核对）。 */
export async function findMergeCommit(repo: string, preHead: string, secondParent: string): Promise<string | null> {
  const out = await git(repo, ['rev-list', '--first-parent', '--parents', `${preHead}..HEAD`]);
  for (const line of out.split('\n').filter(Boolean)) {
    const [commit, ...parents] = line.split(' ');
    if (commit && parents[1] === secondParent) return commit;
  }
  return null;
}

export interface CleanupStep {
  step: 'check' | 'worktree_remove' | 'worktree_prune' | 'branch_delete';
  ok: boolean;
  error?: string;
}
export interface CleanupResult {
  ok: boolean;
  steps: CleanupStep[];
}

/** 清理只针对本任务：路径必须是 <repo>/.studio/worktrees/<id>，分支必须是 studio/task-<id>，两者不符一律不动手。 */
function checkOwnWorktree(repo: string, wt: Worktree): string | null {
  const prefix = 'studio/task-';
  if (!wt.branch.startsWith(prefix)) return `分支 ${wt.branch} 不是任务分支，已拒绝清理。`;
  const id = wt.branch.slice(prefix.length);
  try {
    taskBranch(id);
  } catch {
    return `分支 ${wt.branch} 的任务编号不合法，已拒绝清理。`;
  }
  const expected = path.resolve(repo, '.studio', 'worktrees', id);
  if (path.resolve(wt.path) !== expected) return `目录 ${wt.path} 不是这个任务的副本目录，已拒绝清理。`;
  return null;
}

/** 任务归属核实（启动核对用）：副本必须正是这个任务编号对应的分支与目录。返回问题说明，null 表示没问题。 */
export function worktreeOwnershipProblem(repo: string, wt: Worktree, taskId: string): string | null {
  let expectedBranch: string;
  try {
    expectedBranch = taskBranch(taskId);
  } catch {
    return '任务编号不合法。';
  }
  if (wt.branch !== expectedBranch) return '任务副本的分支与任务编号不一致。';
  return checkOwnWorktree(repo, wt);
}

/**
 * 删除任务副本与任务分支。每一步的结果都如实返回，不吞错；已经不存在的东西视为该步成功（可重复调用）。
 * 主线不受影响。
 */
export async function removeWorktree(repo: string, wt: Worktree): Promise<CleanupResult> {
  const steps: CleanupStep[] = [];
  const bad = checkOwnWorktree(repo, wt);
  if (bad) return { ok: false, steps: [{ step: 'check', ok: false, error: bad }] };
  const attempt = async (step: CleanupStep['step'], fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ step, ok: true });
    } catch (e) {
      steps.push({ step, ok: false, error: e instanceof GitError ? `${e.message}：${e.stderr.trim()}` : String(e) });
    }
  };
  await attempt('worktree_remove', async () => {
    const exists = await fs.stat(wt.path).then(() => true, () => false);
    if (exists) await git(repo, ['worktree', 'remove', '--force', wt.path]);
  });
  await attempt('worktree_prune', async () => void (await git(repo, ['worktree', 'prune'])));
  await attempt('branch_delete', async () => {
    if (await refExists(repo, `refs/heads/${wt.branch}`)) await git(repo, ['branch', '-D', wt.branch]);
  });
  return { ok: steps.every((s) => s.ok), steps };
}

/** 副本目录与任务分支是否都已不存在（用于重试清理与启动核对）。 */
export async function worktreeGone(repo: string, wt: Worktree): Promise<boolean> {
  const dirGone = await fs.stat(wt.path).then(() => false, () => true);
  const branchGone = !(await refExists(repo, `refs/heads/${wt.branch}`));
  return dirGone && branchGone;
}

export interface SavePoint {
  sha: string;
  message: string;
  date: string;
}

export async function savePoints(repo: string, limit = 50): Promise<SavePoint[]> {
  const out = await git(repo, ['log', '--first-parent', `-n${limit}`, '--format=%H%x1f%s%x1f%cI']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha = '', message = '', date = ''] = l.split('\x1f');
      return { sha, message, date };
    });
}

/**
 * 回到某个保存点：以一个新提交恢复该保存点的文件内容，不改写历史。
 * 中途失败时把工作区与索引恢复到调用前的 HEAD（调用前已核验工作区干净，所以其中的改动都是本函数造成的）。
 */
export async function restoreTo(repo: string, sha: string, message?: string): Promise<string> {
  if (!(await isClean(repo))) throw new Error('主项目中有未保存的改动，无法回退。');
  await ensureIdentity(repo);
  await git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
  try {
    await git(repo, ['read-tree', '-u', '--reset', sha]);
    if (await isClean(repo)) return headSha(repo);
    await git(repo, ['commit', '-m', message ?? `studio: 回到保存点 ${sha.slice(0, 7)}`]);
    return headSha(repo);
  } catch (e) {
    await git(repo, ['read-tree', '-u', '--reset', 'HEAD']).catch(() => undefined);
    throw e;
  }
}

// ───────────────────────── 外部驱动检测与自定义提交检查 ─────────────────────────

export const EXTERNAL_DRIVER_MESSAGE = '这个项目使用了需要外部程序处理的文件类型，工作台暂不支持自动保存';

export interface DriverCheck {
  supported: boolean;
  /** 命中的驱动（人类可读，例如 filter=lfs（logo.png）） */
  drivers: string[];
  /** 不支持时的中文原因（EXTERNAL_DRIVER_MESSAGE），支持时为空 */
  reason: string;
}

interface ConfigEntry {
  origin: string;
  key: string;
  value: string;
}

/** 生效配置（系统、全局、仓库、worktree），排除我们自己用 -c 附加的命令行参数。 */
async function effectiveConfig(dir: string): Promise<ConfigEntry[]> {
  const out = await git(dir, ['config', '-z', '--list', '--show-origin']);
  const parts = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i] ?? '';
    const kv = parts[i + 1] ?? '';
    const nl = kv.indexOf('\n');
    const key = nl === -1 ? kv : kv.slice(0, nl);
    const value = nl === -1 ? '' : kv.slice(nl + 1);
    if (origin.startsWith('command line:')) continue;
    entries.push({ origin, key, value });
  }
  return entries;
}

/**
 * 外部驱动检测（B4-plan 第 1 节）：读取目录里所有会被 git 处理的文件（已跟踪 + 未跟踪未忽略）的 filter / diff / merge 属性
 * （git check-attr，已包含各级 .gitattributes、.git/info/attributes 与全局属性文件），
 * 若某个驱动名在生效配置里定义了外部程序 → 不支持。git-lfs（filter=lfs）无论配置是否存在都归入不支持。
 * 不会关闭驱动后继续；调用本函数不会运行任何驱动（只读取属性与配置）。
 */
export async function detectExternalDrivers(dir: string): Promise<DriverCheck> {
  const files = (await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  const config = await effectiveConfig(dir);
  const defined = { filter: new Set<string>(), diff: new Set<string>(), merge: new Set<string>() };
  for (const { key, value } of config) {
    let m = key.match(/^filter\.(.+)\.(clean|smudge|process)$/);
    if (m && value.trim()) defined.filter.add(m[1]!);
    m = key.match(/^diff\.(.+)\.(command|textconv)$/);
    if (m && value.trim()) defined.diff.add(m[1]!);
    m = key.match(/^merge\.(.+)\.driver$/);
    if (m && value.trim()) defined.merge.add(m[1]!);
  }
  const hits = new Map<string, string>();
  if (files.length) {
    const out = await git(dir, ['check-attr', '-z', '--stdin', 'filter', 'diff', 'merge'], { stdin: files.join('\0') + '\0' });
    const f = out.split('\0');
    for (let i = 0; i + 2 < f.length; i += 3) {
      const [file = '', attr = '', value = ''] = [f[i], f[i + 1], f[i + 2]];
      if (['unspecified', 'unset', 'set'].includes(value)) continue;
      let hit = false;
      if (attr === 'filter') hit = value === 'lfs' || defined.filter.has(value);
      else if (attr === 'diff') hit = defined.diff.has(value);
      else if (attr === 'merge') hit = !['text', 'binary', 'union'].includes(value) && defined.merge.has(value);
      const label = `${attr}=${value}`;
      if (hit && !hits.has(label)) hits.set(label, file);
    }
  }
  const drivers = [...hits].map(([label, file]) => `${label}（${file}）`);
  return { supported: drivers.length === 0, drivers, reason: drivers.length ? EXTERNAL_DRIVER_MESSAGE : '' };
}

/**
 * 项目是否有自定义的提交检查（core.hooksPath 已设置，或 .git/hooks 下有非 .sample 的可执行文件）。
 * 工作台保存时不会运行它们；为此验收卡要如实说明（B4-2 显示）。
 */
export async function hasCustomCommitChecks(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['config', '--show-origin', '--get-all', 'core.hooksPath']);
    if (out.split('\n').some((l) => l.trim() && !l.startsWith('command line:'))) return true;
  } catch {
    // 退出码 1 = 没有设置
  }
  try {
    const common = (await git(dir, ['rev-parse', '--git-common-dir'])).trim();
    const hooks = path.resolve(dir, common, 'hooks');
    for (const name of await fs.readdir(hooks)) {
      if (name.endsWith('.sample')) continue;
      const st = await fs.stat(path.join(hooks, name)).catch(() => null);
      if (st?.isFile() && (st.mode & 0o111) !== 0) return true;
    }
  } catch {}
  return false;
}
