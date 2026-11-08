import fs from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 在没有终端环境（图形界面启动）时定位命令行工具。
 * 做法：先看当前 PATH；找不到再看一份固定的常见安装位置候选名单，逐项校验“存在、是文件、可执行”。
 * **不执行也不读取用户的 shell 配置文件**（.zshrc、.zprofile 等），不启动登录 shell。
 * 局限：只装在 nvm/fnm 等版本管理器目录里的工具，找不到时如实显示“未找到”。
 */

/** 常见安装位置（固定名单）。家目录下的候选由调用方传入的 home 展开。 */
export function candidateDirs(home: string = os.homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];
}

export interface ToolLocation {
  name: string;
  /** 可执行文件路径（未解析符号链接） */
  path: string;
  /** 解析符号链接后的真实路径 */
  realPath: string;
  dir: string;
  /** path = 在当前 PATH 中找到；fallback = 通过补全的候选位置找到 */
  via: 'path' | 'fallback';
}

/** 去重并只保留绝对路径（空项与相对项不可信，丢弃）。符号链接指向同一目录的重复项也会合并。 */
export async function uniqueAbsoluteDirs(dirs: readonly string[]): Promise<string[]> {
  const seenReal = new Set<string>();
  const seenRaw = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || !path.isAbsolute(d) || seenRaw.has(d)) continue;
    seenRaw.add(d);
    let real: string;
    try {
      real = await fs.realpath(d);
    } catch {
      continue; // 目录不存在
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    out.push(d);
  }
  return out;
}

/** 目录里是否有名为 name 的可执行文件（跟随符号链接；断链、目录、不可执行都算没有）。 */
export async function findExecutable(dir: string, name: string): Promise<{ path: string; realPath: string } | null> {
  const p = path.join(dir, name);
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return null;
    await fs.access(p, fsc.X_OK);
    return { path: p, realPath: await fs.realpath(p) };
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** 当前 PATH 字符串（默认 process.env.PATH） */
  pathEnv?: string;
  candidates?: readonly string[];
}

export async function resolveTool(name: string, opts: ResolveOptions = {}): Promise<ToolLocation | null> {
  const pathDirs = await uniqueAbsoluteDirs((opts.pathEnv ?? process.env.PATH ?? '').split(':'));
  for (const dir of pathDirs) {
    const f = await findExecutable(dir, name);
    if (f) return { name, ...f, dir, via: 'path' };
  }
  const fallback = await uniqueAbsoluteDirs(opts.candidates ?? candidateDirs());
  for (const dir of fallback) {
    if (pathDirs.includes(dir)) continue;
    const f = await findExecutable(dir, name);
    if (f) return { name, ...f, dir, via: 'fallback' };
  }
  return null;
}

export interface HostPathResolution {
  tools: Record<string, ToolLocation | null>;
  /** 需要补充到子进程 PATH 末尾的目录（仅包含“通过补全找到”的工具所在目录，去重） */
  supplementalDirs: string[];
}

export async function resolveHostTools(names: readonly string[], opts: ResolveOptions = {}): Promise<HostPathResolution> {
  const tools: Record<string, ToolLocation | null> = {};
  const extra: string[] = [];
  for (const n of names) {
    const t = await resolveTool(n, opts);
    tools[n] = t;
    if (t?.via === 'fallback' && !extra.includes(t.dir)) extra.push(t.dir);
  }
  return { tools, supplementalDirs: extra };
}
