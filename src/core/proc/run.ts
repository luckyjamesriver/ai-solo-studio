import { spawn, type ChildProcess } from 'node:child_process';
import { hostEnv } from '../env/host-env.js';

/** 进程的真实结束方式。只有 exited && code === 0 才算正常成功。 */
export type ProcOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: NodeJS.Signals }
  | { kind: 'stopped' }
  | { kind: 'timed_out' }
  | { kind: 'spawn_error'; message: string };

export interface ProcResult {
  outcome: ProcOutcome;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** 每级信号之间的等待时间（SIGINT → SIGTERM → SIGKILL） */
  killGraceMs?: number;
  maxOutputBytes?: number;
}

export interface RunningProc {
  result: Promise<ProcResult>;
  /** 请求停止：SIGINT，宽限期后 SIGTERM，再宽限期后 SIGKILL。 */
  stop(): void;
  readonly pid: number | undefined;
}

export function isSuccess(r: ProcResult): boolean {
  return r.outcome.kind === 'exited' && r.outcome.code === 0;
}

/** 启动子进程。始终使用参数数组，不经过 shell，避免命令注入。 */
export function runProcess(command: string, args: readonly string[], opts: RunOptions): RunningProc {
  const started = Date.now();
  const grace = opts.killGraceMs ?? 5000;
  const maxBytes = opts.maxOutputBytes ?? 2_000_000;
  let stdout = '';
  let stderr = '';
  let reason: 'stopped' | 'timed_out' | null = null;
  let child: ChildProcess | undefined;
  const timers: NodeJS.Timeout[] = [];
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;

  const escalate = () => {
    if (!alive()) return;
    child!.kill('SIGINT');
    timers.push(
      setTimeout(() => {
        if (alive()) child!.kill('SIGTERM');
        timers.push(setTimeout(() => alive() && child!.kill('SIGKILL'), grace));
      }, grace),
    );
  };

  const result = new Promise<ProcResult>((resolve) => {
    let settled = false;
    const finish = (outcome: ProcOutcome) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve({ outcome, stdout, stderr, durationMs: Date.now() - started });
    };
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? hostEnv(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ kind: 'spawn_error', message: (e as Error).message });
      return;
    }
    child.on('error', (err) => finish({ kind: 'spawn_error', message: err.message }));
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      if (stdout.length < maxBytes) stdout += c;
      opts.onStdout?.(c);
    });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => {
      if (stderr.length < maxBytes) stderr += c;
      opts.onStderr?.(c);
    });
    child.on('close', (code, signal) => {
      if (reason) return finish({ kind: reason });
      if (signal) return finish({ kind: 'signaled', signal });
      finish({ kind: 'exited', code: code ?? -1 });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin ?? '');
    if (opts.timeoutMs) {
      timers.push(
        setTimeout(() => {
          if (!reason) reason = 'timed_out';
          escalate();
        }, opts.timeoutMs),
      );
    }
  });

  return {
    result,
    stop() {
      if (!alive()) return;
      if (!reason) reason = 'stopped';
      escalate();
    },
    get pid() {
      return child?.pid;
    },
  };
}

export function run(command: string, args: readonly string[], opts: RunOptions): Promise<ProcResult> {
  return runProcess(command, args, opts).result;
}
