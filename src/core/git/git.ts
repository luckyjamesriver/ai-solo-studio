import path from 'node:path';
import fs from 'node:fs/promises';
import { run, isSuccess } from '../proc/run.js';

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, env: ENV, timeoutMs: 60_000 });
  if (!isSuccess(r)) throw new GitError(`git ${args[0]} 失败`, r.stderr || r.stdout);
  return r.stdout;
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

export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, ['status', '--porcelain'])).trim() === '';
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

/** 把 worktree 中所有改动（含新文件）提交为一个任务提交；无改动时返回 null。 */
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

export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
  path: string;
  additions: number | null;
  deletions: number | null;
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
      return { status: map[code] ?? 'other', path: p, additions, deletions };
    });
}

export async function diffText(wt: Worktree, maxBytes = 200_000): Promise<string> {
  await git(wt.path, ['add', '-A', '--intent-to-add']).catch(() => undefined);
  const out = await git(wt.path, ['diff', '-M', wt.baseSha]);
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n…（差异过长，已截断）' : out;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'dirty_main'; detail: string };

/**
 * 将任务分支合并回主线（--no-ff，保留可追溯的保存点）。
 * 发生冲突时中止合并、保持主线原状，并保留任务分支。
 */
export async function mergeTask(repo: string, wt: Worktree, message: string): Promise<MergeResult> {
  if (!(await isClean(repo))) {
    return { ok: false, reason: 'dirty_main', detail: '主项目中有未保存的改动，请先处理后再保存任务。' };
  }
  await ensureIdentity(repo);
  try {
    await git(repo, ['merge', '--no-ff', '-m', message, wt.branch]);
    return { ok: true, sha: await headSha(repo) };
  } catch (e) {
    await git(repo, ['merge', '--abort']).catch(() => undefined);
    return { ok: false, reason: 'conflict', detail: (e as GitError).stderr ?? String(e) };
  }
}

/** 撤销任务：删除 worktree 与任务分支。主线不受影响。 */
export async function removeWorktree(repo: string, wt: Worktree): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', wt.path]).catch(() => undefined);
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
  await git(repo, ['branch', '-D', wt.branch]).catch(() => undefined);
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

/** 回到某个保存点：以一个新提交恢复该保存点的文件内容，不改写历史。 */
export async function restoreTo(repo: string, sha: string): Promise<string> {
  if (!(await isClean(repo))) throw new Error('主项目中有未保存的改动，无法回退。');
  await ensureIdentity(repo);
  await git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
  await git(repo, ['read-tree', '-u', '--reset', sha]);
  if (await isClean(repo)) return headSha(repo);
  await git(repo, ['commit', '-m', `studio: 回到保存点 ${sha.slice(0, 7)}`]);
  return headSha(repo);
}
