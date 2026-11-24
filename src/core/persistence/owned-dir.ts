import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * 宿主受控目录的「创建时所有权」原语（AISS-A1-R3 / R3-01）。
 *
 * 为什么需要它：清理临时目录时**不能重新信任路径**。攻击者可以在目录合法创建之后，
 * 把 `.studio`（或更上层）替换成指向外部的符号链接、甚至把真正的目录整体移出授权根再链接回来。
 * 后者会让 `dev/ino` 与创建时完全一致，因此只做「身份校验」仍然会误删外部文件。
 *
 * 本模块的规则：
 *  1. 创建时固定「授权根真实路径 + 每一级目录的 dev/ino」，读取/清理前逐级复核；
 *  2. 复核同时要求 **真实路径等于创建时的字面路径**（阻止“移动后链接回来”），并逐级拒绝符号链接；
 *  3. 打开目录用 `O_NOFOLLOW | O_DIRECTORY`，`fstat` 的身份必须与记录的 dev/ino 完全一致；
 *  4. 删除只针对**本模块自己创建的那一级目录**：不递归跟随符号链接，遇到子目录立即拒绝；
 *    任何一项不能确认归属就保守保留残留文件（调用方把失败当作“清理未完成”，而不是越界删除）。
 *
 * 残留的已知边界（如实声明）：Node 没有暴露 `unlinkat`/`rmdirat`，所以“校验 → unlink”之间仍有
 * 一个极短的路径解析窗口。实现把窗口压到最小（每次删除前重新校验直接父目录的身份），
 * 且绝不删除未知条目；主要攻击面（父链被替换、目标被替换、身份不符、移动后链接回来）全部被确定性拒绝。
 */

export interface DirIdentity {
  dev: string;
  ino: string;
}

export interface OwnedDirEntry {
  /** 创建时的绝对字面路径（根为 realpath） */
  path: string;
  identity: DirIdentity;
}

/** 从授权根到叶子目录的所有权记录（chain[0] 是根）。 */
export interface OwnedDir {
  rootPath: string;
  chain: OwnedDirEntry[];
}

export type OwnedDirProblem =
  | { kind: 'missing'; path: string; detail: string }
  | { kind: 'not_owned'; path: string; detail: string };

function identityOf(st: { dev: bigint | number; ino: bigint | number }): DirIdentity {
  return { dev: String(st.dev), ino: String(st.ino) };
}

function sameIdentity(a: DirIdentity, b: DirIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** 打开目录并取得 fd 上的身份；路径含符号链接（含最后一级）时直接失败。 */
async function openDirIdentity(dir: string): Promise<DirIdentity> {
  const flags = FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW;
  const fh = await fs.open(dir, flags);
  try {
    // fstat 拿到的必须是同一个目录对象
    const st = await fh.stat({ bigint: true });
    if (!st.isDirectory()) throw new Error(`不是普通目录：${dir}`);
    return identityOf(st);
  } finally {
    await fh.close();
  }
}

async function lstatIdentity(dir: string): Promise<DirIdentity> {
  const st = await fs.lstat(dir, { bigint: true });
  if (st.isSymbolicLink()) throw new Error(`受控路径是符号链接：${dir}`);
  if (!st.isDirectory()) throw new Error(`受控路径不是目录：${dir}`);
  return identityOf(st);
}

function normalizeSubPath(subPath: string): string[] {
  const abs = path.isAbsolute(subPath);
  const parts = subPath.split(path.sep).filter((p) => p.length > 0);
  if (abs || parts.some((p) => p === '.' || p === '..')) {
    throw new Error(`受控子路径必须是授权根内的相对路径：${subPath}`);
  }
  return parts;
}

/**
 * 在授权根下创建（或复用）受控目录，并记录每一级的目录身份。
 * 任何一级是符号链接、真实路径漂移、身份在 lstat 与 open 之间被换掉，都直接拒绝。
 */
export async function createOwnedDir(rootDir: string, subPath: string): Promise<OwnedDir> {
  let rootPath: string;
  try {
    rootPath = await fs.realpath(rootDir);
  } catch (e) {
    throw new Error(`受控根目录不可解析或不存在：${(e as Error).message}`);
  }
  const rootIdentity = await lstatIdentity(rootPath);
  const openedRoot = await openDirIdentity(rootPath);
  if (!sameIdentity(rootIdentity, openedRoot)) throw new Error(`受控根目录身份在打开前后不一致：${rootPath}`);

  const chain: OwnedDirEntry[] = [{ path: rootPath, identity: rootIdentity }];
  let cur = rootPath;
  for (const part of normalizeSubPath(subPath)) {
    const next = path.join(cur, part);
    let exists = true;
    try {
      await fs.lstat(next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      exists = false;
    }
    if (!exists) {
      // 单级创建：父级已经在 chain 里核实过；创建后立即复核，绝不 recursive 跟随链接
      await fs.mkdir(next);
    }
    const lstIdentity = await lstatIdentity(next);
    const opened = await openDirIdentity(next);
    if (!sameIdentity(lstIdentity, opened)) throw new Error(`受控目录在创建/打开之间被替换：${next}`);
    const real = await fs.realpath(next);
    if (real !== next) throw new Error(`受控目录的真实路径离开授权根（可能是符号链接或挂载替换）：${next} !== ${real}`);
    chain.push({ path: next, identity: lstIdentity });
    cur = next;
  }
  return { rootPath, chain };
}

/** 复核所有权链；任一环节不能确认归属就返回问题（调用方必须据此拒绝清理/读取）。 */
export async function verifyOwnedDir(owned: OwnedDir): Promise<OwnedDirProblem | undefined> {
  for (const entry of owned.chain) {
    let lstIdentity: DirIdentity;
    try {
      lstIdentity = await lstatIdentity(entry.path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing', path: entry.path, detail: '目录已经不存在' };
      return { kind: 'not_owned', path: entry.path, detail: (e as Error).message };
    }
    if (!sameIdentity(lstIdentity, entry.identity)) {
      return { kind: 'not_owned', path: entry.path, detail: '目录身份（dev/ino）与创建时不一致' };
    }
    let openedIdentity: DirIdentity;
    try {
      openedIdentity = await openDirIdentity(entry.path);
    } catch (e) {
      return { kind: 'not_owned', path: entry.path, detail: (e as Error).message };
    }
    if (!sameIdentity(openedIdentity, entry.identity)) {
      return { kind: 'not_owned', path: entry.path, detail: '打开后的目录身份与创建时不一致' };
    }
    let real: string;
    try {
      real = await fs.realpath(entry.path);
    } catch (e) {
      return { kind: 'not_owned', path: entry.path, detail: `真实路径不可解析：${(e as Error).message}` };
    }
    if (real !== entry.path) {
      return { kind: 'not_owned', path: entry.path, detail: `真实路径离开授权根：${entry.path} !== ${real}` };
    }
  }
  return undefined;
}

export type RemoveOutcome = 'removed' | 'already_gone' | 'retained_residual';

/**
 * 只清理「本模块创建的最后一级目录」：先复核完整所有权链，再逐个删除其中的**非目录**条目，
 * 最后 rmdir。遇到任何不能确认归属的情况（身份变化、真实路径漂移、出现子目录、目录非空）都保守保留。
 */
export async function removeOwnedDir(owned: OwnedDir): Promise<RemoveOutcome> {
  const problem = await verifyOwnedDir(owned);
  if (problem) {
    if (problem.kind === 'missing') return 'already_gone';
    throw new Error(`拒绝清理：${problem.detail}（${problem.path}）`);
  }
  const leaf = owned.chain[owned.chain.length - 1]!;
  const entries = await fs.readdir(leaf.path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(leaf.path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      // 我们不创建子目录：不知道归属就不动它
      return 'retained_residual';
    }
    // 删除前重新核实直接父目录身份（压缩 TOCTOU 窗口）
    const parentProblem = await verifyOwnedDir(owned);
    if (parentProblem) {
      if (parentProblem.kind === 'missing') return 'already_gone';
      throw new Error(`拒绝清理：${parentProblem.detail}（${parentProblem.path}）`);
    }
    const lst = await fs.lstat(entryPath);
    if (lst.isDirectory() && !lst.isSymbolicLink()) return 'retained_residual';
    await fs.unlink(entryPath);
  }
  try {
    await fs.rmdir(leaf.path);
    return 'removed';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'already_gone';
    // ENOTEMPTY / 其他异常：保守保留
    return 'retained_residual';
  }
}

/**
 * 安全读取受控目录里的一个文件：复核所有权链后用 O_NOFOLLOW 打开，并在 fd 上校验真实身份。
 * 返回 fd 内容；任何逃逸/替换都抛错（调用方按“报告无效”处理，不静默当作没有报告）。
 */
export async function readOwnedFile(
  owned: OwnedDir,
  fileName: string,
  opts: { maxBytes: number; requireRegularFile?: boolean; singleLink?: boolean },
): Promise<{ buf: Buffer; bytes: number; sha256: string; stat: import('node:fs').BigIntStats }> {
  if (fileName.includes(path.sep) || fileName === '.' || fileName === '..') throw new Error(`非法文件名：${fileName}`);
  const problem = await verifyOwnedDir(owned);
  if (problem) {
    if (problem.kind === 'missing') {
      const e = new Error('文件不存在') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    }
    throw new Error(`受控目录不可信任：${problem.detail}（${problem.path}）`);
  }
  const leaf = owned.chain[owned.chain.length - 1]!;
  const filePath = path.join(leaf.path, fileName);
  const fh = await fs.open(filePath, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    const st = await fh.stat({ bigint: true });
    if (st.isSymbolicLink()) throw new Error('受控文件是符号链接');
    if (opts.requireRegularFile !== false && !st.isFile()) throw new Error('受控文件不是普通文件');
    if (opts.singleLink !== false && st.nlink > 1n) throw new Error('受控文件存在硬链接（可能被复用或预置）');
    if (st.size <= 0n || st.size > BigInt(opts.maxBytes)) throw new Error(`受控文件大小异常：${st.size}`);
    const real = await fs.realpath(filePath);
    if (real !== filePath) throw new Error('受控文件的真实路径发生逃逸或替换');
    // 打开后再确认父目录身份没有在读取过程中被换掉
    const after = await verifyOwnedDir(owned);
    if (after) throw new Error(`读取期间受控目录身份发生变化：${after.detail}`);
    const buf = await fh.readFile();
    return { buf, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), stat: st };
  } finally {
    await fh.close();
  }
}
