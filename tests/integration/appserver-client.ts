import { spawn, type ChildProcess } from 'node:child_process';

/** 测试用的最小 app-server 客户端（JSON-RPC over stdio）。 */
export class AppServerClient {
  readonly child: ChildProcess;
  readonly notifications: { method: string; params: any }[] = [];
  private buf = '';
  private id = 1;
  private waiting = new Map<number, (m: any) => void>();
  private listeners: ((n: { method: string; params: any }) => void)[] = [];

  constructor(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
    this.child = spawn('codex', args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined && m.method) {
          // 服务端请求（审批等）：测试里一律拒绝
          this.child.stdin!.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: 'test client' } })}\n`);
        } else if (m.id !== undefined) this.waiting.get(m.id)?.(m);
        else if (m.method) {
          const n = { method: m.method, params: m.params };
          this.notifications.push(n);
          this.listeners.forEach((l) => l(n));
        }
      }
    });
  }
  rpc(method: string, params: object): Promise<any> {
    return new Promise((resolve) => {
      const i = this.id++;
      this.waiting.set(i, resolve);
      this.child.stdin!.write(`${JSON.stringify({ method, id: i, params })}\n`);
    });
  }
  async init() {
    await this.rpc('initialize', { clientInfo: { name: 'studio_test', title: 't', version: '0' } });
    this.child.stdin!.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }
  waitFor(method: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.notifications.some((n) => n.method === method)) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      this.listeners.push((n) => {
        if (n.method === method) {
          clearTimeout(t);
          resolve(true);
        }
      });
    });
  }
  async effectiveConfig(cwd: string): Promise<any> {
    return (await this.rpc('config/read', { includeLayers: false, cwd })).result?.config ?? {};
  }
  kill() {
    this.child.kill('SIGKILL');
  }
}
