import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, isSuccess } from '../proc/run.js';
import { VolumeNotSupportedError } from './errors.js';

/**
 * 数据目录所在卷的检查（ADR 0005 第 12 条）：权威数据目录仅支持本地 APFS。
 * 探测函数可注入，便于测试；生产里用 localApfsProbe。
 */
export type VolumeProbe = (dir: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** df 取挂载点，再在 mount 输出里核对该挂载点的文件系统类型是 apfs 且是 local（macOS）。 */
export const localApfsProbe: VolumeProbe = async (dir) => {
  if (process.platform !== 'darwin') return { ok: false, reason: '只支持 macOS 的本地 APFS 磁盘。' };
  let real = dir;
  while (true) {
    try {
      real = await fs.realpath(real);
      break;
    } catch {
      const parent = path.dirname(real);
      if (parent === real) return { ok: false, reason: '找不到这个位置。' };
      real = parent;
    }
  }
  const df = await run('df', ['-P', real], { cwd: os.tmpdir(), timeoutMs: 10_000 });
  if (!isSuccess(df)) return { ok: false, reason: '无法读取磁盘信息。' };
  const row = df.stdout.trim().split('\n')[1];
  const mountPoint = row?.trim().split(/\s+/).slice(5).join(' ');
  if (!mountPoint) return { ok: false, reason: '无法识别所在的磁盘。' };
  const mount = await run('mount', [], { cwd: os.tmpdir(), timeoutMs: 10_000 });
  if (!isSuccess(mount)) return { ok: false, reason: '无法读取磁盘类型。' };
  const line = mount.stdout.split('\n').find((l) => l.includes(` on ${mountPoint} (`));
  if (!line) return { ok: false, reason: '无法确认所在磁盘的类型。' };
  const opts = (line.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((s) => s.trim());
  if (opts[0] !== 'apfs') return { ok: false, reason: `磁盘类型是 ${opts[0] ?? '未知'}，不是 APFS。` };
  if (!opts.includes('local')) return { ok: false, reason: '这不是本地磁盘。' };
  return { ok: true };
};

export async function requireLocalVolume(dir: string, probe: VolumeProbe | undefined): Promise<void> {
  if (!probe) return;
  const r = await probe(dir);
  if (!r.ok) throw new VolumeNotSupportedError(dir, r.reason);
}
