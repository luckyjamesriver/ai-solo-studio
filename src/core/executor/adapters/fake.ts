import fs from 'node:fs/promises';
import path from 'node:path';
import { Channel } from '../channel.js';
import { assess } from '../../policy/risk.js';
import type { DeniedOperation, Decision, Executor, ExecutorEvent, ExecutorRun, PermissionRequest, StartOptions } from '../types.js';

/**
 * 可脚本化的模拟执行体，用于自动化测试与无订阅演示。
 * 剧本中的每一步依次执行；写文件前若声明了 permission，会先发出权限请求并等待决定。
 */
export type FakeStep =
  | { do: 'say'; text: string }
  | { do: 'write'; path: string; content: string; ask?: boolean }
  | { do: 'delete'; path: string; ask?: boolean }
  | { do: 'ask'; request: Omit<PermissionRequest, 'id'>; onDeny?: 'continue' | 'fail' }
  | { do: 'hang' }
  | { do: 'exit'; code: number };

export class FakeExecutor implements Executor {
  readonly id = 'fake';
  readonly displayName = '模拟执行体（测试用）';
  readonly capabilities = { permissionPrompts: true, resumeAfterStop: false };
  constructor(private readonly script: FakeStep[] | ((prompt: string) => FakeStep[])) {}

  async detect() {
    return { installed: true, loggedIn: 'yes' as const, version: 'fake' };
  }

  start(opts: StartOptions): ExecutorRun {
    const ch = new Channel<ExecutorEvent>();
    const pending = new Map<string, (d: Decision) => void>();
    let stopped = false;
    const waker: { fn?: () => void } = {};
    let seq = 0;
    const denied: DeniedOperation[] = [];
    const steps = typeof this.script === 'function' ? this.script(opts.prompt) : this.script;

    const safe = (p: string) => {
      const abs = path.resolve(opts.cwd, p);
      if (!abs.startsWith(opts.cwd + path.sep)) throw new Error(`越界路径：${p}`);
      return abs;
    };
    const ask = (req: Omit<PermissionRequest, 'id'>) =>
      new Promise<Decision>((resolve) => {
        const id = `p${++seq}`;
        pending.set(id, (d) => {
          if (d === 'deny' && !stopped) {
            denied.push({
              kind: req.kind,
              ...(req.command ? { command: req.command } : {}),
              ...(req.paths ? { paths: req.paths } : {}),
              description: req.description,
              risk: assess({ ...req, id }, opts.cwd).level,
            });
          }
          resolve(d);
        });
        ch.push({ type: 'permission_request', request: { ...req, id } });
      });

    const finish = (e: ExecutorEvent) => {
      ch.push(e);
      ch.close();
    };

    (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((r) => {
        if (opts.timeoutMs) timer = setTimeout(() => r('timeout'), opts.timeoutMs);
      });
      const body = (async () => {
        for (const s of steps) {
          if (stopped) return;
          if (s.do === 'say') ch.push({ type: 'message', text: s.text });
          else if (s.do === 'write' || s.do === 'delete') {
            if (s.ask) {
              const d = await ask({
                kind: s.do === 'write' ? 'write_file' : 'delete_file',
                paths: [s.path],
                description: `${s.do === 'write' ? '写入' : '删除'} ${s.path}`,
              });
              if (stopped) return;
              if (d === 'deny') {
                ch.push({ type: 'message', text: `已跳过：${s.path}` });
                continue;
              }
            }
            const abs = safe(s.path);
            if (s.do === 'write') {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              if (stopped) return;
              await fs.writeFile(abs, s.content);
            } else await fs.rm(abs, { force: true });
            ch.push({ type: 'tool', name: s.do, summary: s.path });
          } else if (s.do === 'ask') {
            const d = await ask(s.request);
            if (stopped) return;
            if (d === 'deny' && s.onDeny === 'fail') return 1;
          } else if (s.do === 'hang') {
            await new Promise<void>((r) => (waker.fn = r));
            return;
          } else if (s.do === 'exit') return s.code;
        }
        return 0;
      })();
      const r = await Promise.race([body, timeout]);
      clearTimeout(timer);
      if (r === 'timeout') {
        stopped = true;
        waker.fn?.();
        finish({ type: 'exit', outcome: { kind: 'timed_out' }, denied });
      } else if (stopped) finish({ type: 'exit', outcome: { kind: 'stopped' }, denied });
      else finish({ type: 'exit', outcome: { kind: 'exited', code: r ?? 0 }, denied });
    })().catch((e) => finish({ type: 'exit', outcome: { kind: 'spawn_error', message: String(e?.message ?? e) } }));

    return {
      events: ch,
      async respond(id, decision) {
        const r = pending.get(id);
        if (!r) throw new Error(`未知的权限请求：${id}`);
        pending.delete(id);
        r(decision);
      },
      async stop() {
        stopped = true;
        waker.fn?.();
        for (const [id, r] of pending) {
          pending.delete(id);
          r('deny');
        }
      },
    };
  }
}
