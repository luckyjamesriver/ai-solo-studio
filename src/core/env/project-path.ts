import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** 整个目录树都不允许作为项目（系统目录）。 */
const BLOCKED_TREES = ['/System', '/usr', '/bin', '/sbin', '/etc', '/dev', '/Library', '/Applications', '/private/etc', '/boot', '/proc', '/sys'];
/** 只禁止这个目录本身（它们的子目录是正常的，例如 /Users/某人/项目）。 */
const BLOCKED_EXACT = ['/', '/Users', '/Volumes', '/private', '/var', '/tmp', '/opt', '/home', '/private/var', '/private/tmp'];

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

export interface ProjectPathOptions {
  home?: string;
  blockedTrees?: readonly string[];
  blockedExact?: readonly string[];
}

/**
 * 规范化并校验项目路径：解析符号链接；必须存在且是目录；拒绝系统目录、用户主目录本身（及其上级目录）。
 * 返回的是解析后的真实路径——之后所有操作都用它，避免“符号链接绕过校验”。
 */
export async function validateProjectPath(input: unknown, opts: ProjectPathOptions = {}): Promise<PathCheck> {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: '没有选择文件夹。' };
  if (!path.isAbsolute(input)) return { ok: false, reason: '路径不是绝对路径。' };
  let real: string;
  try {
    real = await fs.realpath(input);
  } catch {
    return { ok: false, reason: '这个文件夹不存在了（可能被移动或删除）。' };
  }
  let st;
  try {
    st = await fs.stat(real);
  } catch {
    return { ok: false, reason: '无法读取这个文件夹。' };
  }
  if (!st.isDirectory()) return { ok: false, reason: '选中的不是文件夹。' };

  const realOf = async (p: string) => {
    try {
      return await fs.realpath(p);
    } catch {
      return p;
    }
  };
  const home = await realOf(opts.home ?? os.homedir());
  if (real === home) return { ok: false, reason: '不能把整个用户主目录当作项目，请选择主目录里的某个项目文件夹。' };
  if (inside(home, real)) return { ok: false, reason: '这个文件夹包含你的整个用户主目录，请选择更具体的项目文件夹。' };

  const trees = await Promise.all((opts.blockedTrees ?? BLOCKED_TREES).map(realOf));
  const exact = await Promise.all((opts.blockedExact ?? BLOCKED_EXACT).map(realOf));
  const rawTrees = opts.blockedTrees ?? BLOCKED_TREES;
  const rawExact = opts.blockedExact ?? BLOCKED_EXACT;
  if ([...trees, ...rawTrees].some((t) => inside(real, t))) return { ok: false, reason: '这是系统文件夹，不能作为项目。' };
  if ([...exact, ...rawExact].some((t) => real === t)) return { ok: false, reason: '这个文件夹太宽泛，请选择具体的项目文件夹。' };
  return { ok: true, path: real };
}
