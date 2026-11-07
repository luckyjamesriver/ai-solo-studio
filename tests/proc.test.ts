import { describe, it, expect } from 'vitest';
import { run, runProcess, isSuccess } from '../src/core/proc/run.js';

const node = process.execPath;

describe('runProcess', () => {
  it('成功退出记为 exited 0', async () => {
    const r = await run(node, ['-e', 'process.stdout.write("hi")'], { cwd: process.cwd() });
    expect(r.outcome).toEqual({ kind: 'exited', code: 0 });
    expect(r.stdout).toBe('hi');
    expect(isSuccess(r)).toBe(true);
  });

  it('非零退出码如实记录，不算成功', async () => {
    const r = await run(node, ['-e', 'process.exit(3)'], { cwd: process.cwd() });
    expect(r.outcome).toEqual({ kind: 'exited', code: 3 });
    expect(isSuccess(r)).toBe(false);
  });

  it('不经过 shell：参数中的 shell 元字符原样传递', async () => {
    const r = await run(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); rm -rf /'], {
      cwd: process.cwd(),
    });
    expect(r.stdout).toBe('$(echo pwned); rm -rf /');
  });

  it('超时记为 timed_out，不算成功', async () => {
    const r = await run(node, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(),
      timeoutMs: 200,
      killGraceMs: 200,
    });
    expect(r.outcome.kind).toBe('timed_out');
    expect(isSuccess(r)).toBe(false);
  });

  it('stop() 记为 stopped，即使进程忽略 SIGINT 也会被终止', async () => {
    const p = runProcess(node, ['-e', 'process.on("SIGINT",()=>{}); setInterval(()=>{},1000)'], {
      cwd: process.cwd(),
      killGraceMs: 150,
    });
    setTimeout(() => p.stop(), 200);
    const r = await p.result;
    expect(r.outcome.kind).toBe('stopped');
  });

  it('外部信号终止记为 signaled', async () => {
    const r = await run(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], { cwd: process.cwd() });
    expect(r.outcome).toEqual({ kind: 'signaled', signal: 'SIGKILL' });
    expect(isSuccess(r)).toBe(false);
  });

  it('命令不存在记为 spawn_error', async () => {
    const r = await run('definitely-not-a-real-cmd-xyz', [], { cwd: process.cwd() });
    expect(r.outcome.kind).toBe('spawn_error');
  });
});
