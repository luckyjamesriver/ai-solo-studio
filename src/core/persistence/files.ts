import fs from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

/**
 * 持久化目录里的文件写入原语。**整个 src 里只有 src/core/persistence/ 可以直接写状态文件**（依赖边界检查守着，ADR 0006）；
 * 其余模块要么通过 Repository / 持久化服务提交变更，要么在这里登记的原语里写入。
 */

/** 原子写（临时文件 → fsync → rename）：覆盖式。写入失败时原文件保持不变，临时文件被清理，错误原样抛出。 */
export async function atomicWrite(file: string, data: string, opts: { mode?: number; tmpfileCreated?: (tmp: string) => void | Promise<void> } = {}): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, data, { encoding: 'utf8', ...opts });
}

/** 原子且不覆盖：先写临时文件，再 link 到目标（目标已存在则失败 EEXIST），最后删除临时文件。 */
export async function atomicWriteExclusive(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFileAtomic(tmp, data, { encoding: 'utf8' });
  try {
    await fs.link(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** 追加一行并落盘（fsync）。用于只追加的日志。 */
export async function appendLineDurable(file: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, 'a');
  try {
    await fh.write(`${line}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** 追加一段文字（不要求落盘），用于诊断类文本。 */
export async function appendText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text);
}

/** 截断到指定字节数（日志末行不完整时使用）。 */
export async function truncateTo(file: string, size: number): Promise<void> {
  await fs.truncate(file, size);
}

/** 如果文件里还没有这一行，就原子地加上（例如 .git/info/exclude）；已有则什么都不做。返回是否改动。 */
export async function ensureLine(file: string, line: string): Promise<boolean> {
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  if (content.split('\n').includes(line)) return false;
  await atomicWrite(file, `${content}${content.endsWith('\n') || content === '' ? '' : '\n'}${line}\n`);
  return true;
}

export async function renameFile(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
}

/** 创建系统临时目录下的一次性工作目录（思考者的临时 cwd 等）。 */
export async function makeTempDir(prefix: string): Promise<string> {
  const os = await import('node:os');
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

export async function makeDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 删除目录树（仅限持久化层自己管理的位置，例如用后即删的临时目录）。 */
export async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
