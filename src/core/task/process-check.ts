import os from 'node:os';
import path from 'node:path';
import { run, isSuccess } from '../proc/run.js';
import type { Task } from './model.js';

/**
 * 启动核对用的进程核实（B4-2 第 6 节）：删除任务副本之前，必须确认“本应用记录过的执行体进程”已经不在运行。
 * 任何一项确认不了就返回 ok:false，调用方不得删除，而是标为“需要处理”，由用户点“重试清理”。
 */
export type ProcessVerdict = { ok: true } | { ok: false; reason: string };

export interface ProcessProbe {
  /** 进程是否存在（只发送 0 号信号，不会影响进程） */
  isAlive(pid: number): boolean;
  /** 进程的可执行文件名；查不到返回 null */
  nameOf(pid: number): Promise<string | null>;
}

export const systemProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // 存在但不属于本用户：同样视为存在
    }
  },
  async nameOf(pid) {
    const r = await run('ps', ['-p', String(pid), '-o', 'comm='], { cwd: os.tmpdir(), timeoutMs: 5000 });
    if (!isSuccess(r)) return null;
    const name = path.basename(r.stdout.trim());
    return name || null;
  },
};

/** 记录执行体进程（开工后进程启动时调用）：进程号与当时的可执行文件名 */
export async function recordProcess(pid: number, probe: ProcessProbe = systemProbe): Promise<NonNullable<Task['execProc']>> {
  const name = await probe.nameOf(pid).catch(() => null);
  return { pid, at: new Date().toISOString(), ...(name ? { name } : {}) };
}

export async function verifyNoLiveExecutor(t: Task, probe: ProcessProbe = systemProbe): Promise<ProcessVerdict> {
  const rec = t.execProc;
  if (!rec) {
    // 没有进程记录：执行已经正常记录了结束（或根本没有开过工）才说明没有进程；仍在“施工中”却没有记录，无法确认
    if (t.state === 'running' || (t.executorId && !t.exit)) return { ok: false, reason: '没有执行体进程的记录，无法确认它已经停止。' };
    return { ok: true };
  }
  if (!probe.isAlive(rec.pid)) return { ok: true };
  const name = await probe.nameOf(rec.pid).catch(() => null);
  if (!name || !rec.name) return { ok: false, reason: '记录的进程仍然存在，无法确认它是不是执行体。' };
  if (name === rec.name) return { ok: false, reason: '执行体进程仍在运行。' };
  return { ok: true }; // 进程号已被别的程序占用：原来的执行体不在了
}
