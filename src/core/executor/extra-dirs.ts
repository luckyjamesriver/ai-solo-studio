/**
 * “允许修改另一个文件夹”的运行时校验（核心层，不只在界面）。
 * 纯规则（checkExtraDir）：绝对路径；不是根目录；不是用户主目录本身或其上级；路径中任何一段都不是 .git；
 *   不落在敏感清单（sensitiveFallbackList）内、也不包含其中任何一项；不在任务副本/.studio 内，也不包含任务副本或主仓库（主仓库里有 .git）。
 * 文件系统规则（validateExtraDir）：必须是已存在的目录；对真实路径（解析符号链接后）再检查一遍纯规则。
 * 比较一律忽略大小写（macOS 默认大小写不敏感），宁可多拒绝。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sensitiveFallbackList } from './modes.js';

export interface ExtraDirContext {
  home?: string;
  /** 项目主仓库（用户的项目文件夹） */
  repo?: string;
  /** 任务副本（worktree）路径 */
  worktree?: string;
}

const norm = (p: string) => path.resolve(p).toLowerCase();
const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** 返回 null 表示通过，否则是中文原因。 */
export function checkExtraDir(input: string, ctx: ExtraDirContext = {}): string | null {
  if (typeof input !== 'string' || !path.isAbsolute(input)) return '额外目录必须是绝对路径。';
  const dir = norm(input);
  const home = norm(ctx.home ?? os.homedir());
  if (dir === path.parse(dir).root.toLowerCase()) return '不能选择根目录。';
  if (isInside(home, dir)) return dir === home ? '不能选择你的用户主目录本身。' : '不能选择用户主目录的上级目录。';
  if (path.resolve(input).split(path.sep).some((seg) => seg.toLowerCase() === '.git')) return '路径中不能包含 .git（版本记录目录不允许让 AI 修改）。';
  for (const s of sensitiveFallbackList(ctx.home ?? os.homedir())) {
    const sn = norm(s);
    if (isInside(dir, sn)) return '这个位置属于已被保护的敏感位置（例如密钥、账号凭证），不能让 AI 修改。';
    if (isInside(sn, dir)) return '这个目录包含了受保护的敏感位置（例如密钥、账号凭证），不能让 AI 修改。';
  }
  if (ctx.repo) {
    const repo = norm(ctx.repo);
    if (isInside(repo, dir)) return '不能选择项目文件夹本身或它的上级目录：项目的版本记录（.git）在里面。';
    if (isInside(dir, path.join(repo, '.studio').toLowerCase())) return '不能选择任务副本所在的内部目录。';
  }
  if (ctx.worktree) {
    const wt = norm(ctx.worktree);
    if (isInside(dir, wt) || isInside(wt, dir)) return '不能选择任务副本本身（或包含它的目录）：AI 本来就只能修改任务副本。';
  }
  return null;
}

export type ExtraDirResult = { ok: true; dir: string } | { ok: false; reason: string };

/** 完整校验：已存在的目录，且真实路径同样满足纯规则。通过时返回真实路径。 */
export async function validateExtraDir(input: string, ctx: ExtraDirContext = {}): Promise<ExtraDirResult> {
  const first = checkExtraDir(input, ctx);
  if (first) return { ok: false, reason: first };
  let real: string;
  try {
    real = await fs.realpath(input);
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: '这不是一个文件夹。' };
  } catch {
    return { ok: false, reason: '这个文件夹不存在。' };
  }
  const second = checkExtraDir(real, ctx);
  if (second) return { ok: false, reason: second };
  return { ok: true, dir: real };
}
