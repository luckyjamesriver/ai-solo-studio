import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Channel } from '../channel.js';
import { run } from '../../proc/run.js';
import type { DeniedOperation, DetectResult, Decision, Executor, ExecutorEvent, ExecutorRun, ExitOutcome, PermissionRequest, StartOptions } from '../types.js';
import { assess } from '../../policy/risk.js';
import { parseCommand } from './codex-command.js';

/**
 * Codex 适配器：通过 `codex app-server`（stdio，换行分隔的 JSON-RPC）驱动。
 * 协议与行为以 spikes/codex/ 的实测和 `codex app-server generate-json-schema` 生成的 schema 为准。
 * app-server 被官方标注为 experimental，协议可能变化。
 */

const APPROVAL_POLICY = 'on-request';
const SANDBOX_MODE = 'workspace-write';

export interface CodexLaunchConfig {
  /** `codex app-server` 的命令行参数（不含可执行文件本身） */
  args: string[];
  /** thread/start 的参数 */
  threadStart: Record<string, unknown>;
  /** turn/start 中每个回合都再次显式声明的参数（不依赖线程或用户配置的默认值） */
  turnOverrides: Record<string, unknown>;
}

/**
 * 最终生效的隔离与安全参数——全部集中在这里，便于测试。
 * - app-server 没有“忽略用户配置”的开关，所以：命令行用 -c 覆盖沙箱与审批，线程与回合参数里再各声明一次；
 * - 沙箱：只有任务 worktree 可写，且不包含系统临时目录；默认不联网；
 * - 审批：需要时询问（on-request）；
 * - 禁用插件。
 */
export function codexLaunchConfig(cwd: string, opts: { model?: string } = {}): CodexLaunchConfig {
  return {
    args: [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      `sandbox_mode="${SANDBOX_MODE}"`,
      '-c',
      `approval_policy="${APPROVAL_POLICY}"`,
      '--disable',
      'plugins',
    ],
    threadStart: {
      cwd,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: SANDBOX_MODE,
      ephemeral: true,
      ...(opts.model ? { model: opts.model } : {}),
    },
    turnOverrides: {
      cwd,
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
      },
    },
  };
}

export interface CodexOptions {
  /** 可执行文件，默认 `codex`；测试中指向假的 app-server */
  command?: string;
  /** 放在 app-server 参数之前的参数（测试中用来传脚本路径） */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** 发出 turn/interrupt 后等待回合结束的时间，超时再终止进程 */
  interruptGraceMs?: number;
  /** SIGTERM 后等待退出的时间，超时 SIGKILL */
  killGraceMs?: number;
}

type RpcId = number | string;
interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export class CodexExecutor implements Executor {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  // 线程以 ephemeral 方式创建，不保存会话，因此停止后不能接着做。
  readonly capabilities = { permissionPrompts: true, resumeAfterStop: false };

  constructor(private readonly options: CodexOptions = {}) {}

  private get command() {
    return this.options.command ?? 'codex';
  }
  private get prefix() {
    return this.options.prefixArgs ?? [];
  }

  async detect(): Promise<DetectResult> {
    const cwd = process.cwd();
    const env = { ...process.env, ...this.options.env };
    const v = await run(this.command, [...this.prefix, '--version'], { cwd, env, timeoutMs: 15_000, killGraceMs: 500 });
    if (v.outcome.kind === 'spawn_error') return { installed: false, loggedIn: 'unknown', note: '没有找到 Codex，请先安装。' };
    if (v.outcome.kind !== 'exited' || v.outcome.code !== 0) return { installed: false, loggedIn: 'unknown', note: 'Codex 无法运行。' };
    const lines = `${v.stdout}\n${v.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const version = lines.find((l) => /codex/i.test(l) && /\d+\.\d+/.test(l)) ?? lines.at(-1);
    const s = await run(this.command, [...this.prefix, 'login', 'status'], { cwd, env, timeoutMs: 15_000, killGraceMs: 500 });
    const text = `${s.stdout}\n${s.stderr}`.trim();
    let loggedIn: DetectResult['loggedIn'] = 'unknown';
    if (s.outcome.kind === 'exited' && s.outcome.code === 0) loggedIn = 'yes';
    else if (s.outcome.kind === 'exited' && /not logged in/i.test(text)) loggedIn = 'no';
    return { installed: true, loggedIn, ...(version ? { version } : {}), ...(text ? { note: text.split('\n').at(-1)! } : {}) };
  }

  start(opts: StartOptions): ExecutorRun {
    const ch = new Channel<ExecutorEvent>();
    let cwd = opts.cwd;
    try {
      cwd = fs.realpathSync(opts.cwd);
    } catch {}
    const cfg = codexLaunchConfig(cwd, opts.model ? { model: opts.model } : {});
    const interruptGraceMs = this.options.interruptGraceMs ?? 5000;
    const killGraceMs = this.options.killGraceMs ?? 3000;

    let child: ChildProcess | undefined;
    let buf = '';
    let nextRpc = 1;
    const pendingRpc = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const pendingApprovals = new Map<string, RpcId>(); // 我们的请求 id → app-server 的 JSON-RPC id
    const fileItems = new Map<string, { path: string; kind: string }[]>();
    const denied: DeniedOperation[] = [];
    const requests = new Map<string, PermissionRequest>();
    let seq = 0;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let stopRequested = false;
    let timedOut = false;
    let finished = false;
    let turnResult: { status: string; error?: string } | undefined;
    const timers: NodeJS.Timeout[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const alive = () => !!child && child.exitCode === null && child.signalCode === null;
    const write = (o: object) => {
      if (alive() && child!.stdin?.writable) child!.stdin.write(`${JSON.stringify(o)}\n`);
    };
    const request = (method: string, params: object) =>
      new Promise<any>((resolve, reject) => {
        const id = nextRpc++;
        pendingRpc.set(id, { resolve, reject });
        write({ method, id, params });
      });

    const finish = (outcome: ExitOutcome, note?: string) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      if (note) ch.push({ type: 'message', text: note });
      if (denied.length) ch.push({ type: 'message', text: `有 ${denied.length} 项操作被拒绝，没有执行：${denied.map((d) => d.description.split('\n').at(-1)).join('；')}` });
      ch.push({ type: 'exit', outcome, ...(denied.length ? { denied } : {}) });
      ch.close();
      // 回合结束后 app-server 仍在运行，需要主动收掉
      terminate();
      resolveDone();
    };

    const terminate = () => {
      if (!alive()) return;
      child!.kill('SIGTERM');
      const t = setTimeout(() => alive() && child!.kill('SIGKILL'), killGraceMs);
      t.unref?.();
    };

    const interrupt = () => {
      if (threadId && turnId) {
        request('turn/interrupt', { threadId, turnId }).catch(() => {});
        const t = setTimeout(() => {
          if (!finished) {
            if (stopRequested || timedOut) finish(timedOut ? { kind: 'timed_out' } : { kind: 'stopped' });
          }
        }, interruptGraceMs);
        timers.push(t);
      } else if (alive()) {
        // 还没有回合可中断：直接终止进程
        terminate();
      }
    };

    const declineAllPending = () => {
      for (const [id, rpcId] of pendingApprovals) {
        pendingApprovals.delete(id);
        write({ id: rpcId, result: { decision: 'decline' } });
      }
    };

    // ---------- 事件映射 ----------
    const permission = (req: Omit<PermissionRequest, 'id'>, rpcId: RpcId) => {
      const id = `c${++seq}`;
      pendingApprovals.set(id, rpcId);
      const full: PermissionRequest = { ...req, id };
      requests.set(id, full);
      ch.push({ type: 'permission_request', request: full });
    };

    const onServerRequest = (m: RpcMessage) => {
      const p = m.params ?? {};
      if (m.method === 'item/commandExecution/requestApproval') {
        const raw = String(p.command ?? '');
        const parsed = parseCommand(raw);
        const paths = [...parsed.paths];
        if (typeof p.cwd === 'string' && p.cwd) paths.push(p.cwd);
        permission(
          {
            kind: 'run_command',
            command: parsed.argv,
            paths,
            description: `${p.reason ? `${p.reason}\n` : ''}命令：${parsed.inner || raw}`,
          },
          m.id!,
        );
      } else if (m.method === 'item/fileChange/requestApproval') {
        const changes = fileItems.get(String(p.itemId)) ?? [];
        const paths = changes.map((c) => c.path);
        if (typeof p.grantRoot === 'string' && p.grantRoot) paths.push(p.grantRoot);
        const kinds = new Set(changes.map((c) => c.kind));
        // 不知道改哪些文件时不能当作普通写入，否则可能被误判为低风险
        const kind: PermissionRequest['kind'] = paths.length === 0 ? 'other' : kinds.size === 1 && kinds.has('delete') ? 'delete_file' : 'write_file';
        permission(
          { kind, paths, description: `${p.reason ? `${p.reason}\n` : ''}修改文件：${paths.join('、') || '（未提供文件列表）'}` },
          m.id!,
        );
      } else {
        // 其他服务端请求（额外权限、用户输入、MCP、动态工具、令牌刷新等）本适配器不支持，明确拒绝
        write({ id: m.id, error: { code: -32601, message: `unsupported by AI Solo Studio: ${m.method}` } });
        ch.push({ type: 'log', stream: 'stderr', text: `已拒绝不支持的请求：${m.method}\n` });
      }
    };

    const commandText = (item: Record<string, any>) => {
      const parsed = parseCommand(String(item.command ?? ''));
      return parsed.inner || String(item.command ?? '');
    };

    const onNotification = (m: RpcMessage) => {
      const p = m.params ?? {};
      switch (m.method) {
        case 'turn/started':
          turnId = p.turn?.id ?? turnId;
          break;
        case 'item/started': {
          const item = p.item ?? {};
          if (item.type === 'commandExecution') ch.push({ type: 'tool', name: 'run_command', summary: commandText(item) });
          else if (item.type === 'fileChange') {
            const changes = (item.changes ?? []).map((c: any) => ({ path: String(c.path), kind: String(c.kind?.type ?? c.kind ?? 'update') }));
            fileItems.set(String(item.id), changes);
          } else if (['mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) ch.push({ type: 'tool', name: item.type, summary: String(item.tool ?? item.query ?? '') });
          break;
        }
        case 'item/completed': {
          const item = p.item ?? {};
          if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) ch.push({ type: 'message', text: item.text });
          else if (item.type === 'fileChange') {
            const changes = (item.changes ?? []).map((c: any) => `${c.kind?.type ?? c.kind ?? 'update'} ${c.path}`);
            fileItems.set(String(item.id), (item.changes ?? []).map((c: any) => ({ path: String(c.path), kind: String(c.kind?.type ?? c.kind ?? 'update') })));
            ch.push({ type: 'tool', name: 'file_change', summary: `${item.status ?? ''} ${changes.join('、')}`.trim() });
          }
          break;
        }
        case 'error':
          ch.push({ type: 'log', stream: 'stderr', text: `${String(p.error?.message ?? p.message ?? JSON.stringify(p))}\n` });
          break;
        case 'turn/completed': {
          turnResult = { status: String(p.turn?.status ?? 'unknown'), ...(p.turn?.error?.message ? { error: String(p.turn.error.message) } : {}) };
          if (timedOut) finish({ kind: 'timed_out' });
          else if (turnResult.status === 'completed') finish({ kind: 'exited', code: 0 });
          else if (turnResult.status === 'interrupted' && stopRequested) finish({ kind: 'stopped' });
          else finish({ kind: 'exited', code: 1 }, `执行没有完成（状态：${turnResult.status}）${turnResult.error ? `：${turnResult.error}` : ''}`);
          break;
        }
      }
    };

    const onLine = (line: string) => {
      let m: RpcMessage;
      try {
        m = JSON.parse(line) as RpcMessage;
      } catch {
        ch.push({ type: 'log', stream: 'stdout', text: `${line}\n` });
        return;
      }
      if (m.id !== undefined && m.method) onServerRequest(m);
      else if (m.id !== undefined) {
        const p = pendingRpc.get(m.id);
        pendingRpc.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else p?.resolve(m.result);
      } else if (m.method) onNotification(m);
    };

    // ---------- 启动 ----------
    try {
      child = spawn(this.command, [...this.prefix, ...cfg.args], {
        cwd,
        env: { ...process.env, ...this.options.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ kind: 'spawn_error', message: (e as Error).message });
    }

    if (child) {
      child.on('error', (err) => finish({ kind: 'spawn_error', message: err.message }));
      child.stdin?.on('error', () => {});
      child.stdout?.setEncoding('utf8').on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      });
      child.stderr?.setEncoding('utf8').on('data', (c: string) => ch.push({ type: 'log', stream: 'stderr', text: c }));
      child.on('close', (code, signal) => {
        for (const p of pendingRpc.values()) p.reject(new Error('app-server 已退出'));
        pendingRpc.clear();
        if (finished) return;
        // 进程在回合结束前退出：如实映射，绝不报告为成功
        if (timedOut) finish({ kind: 'timed_out' });
        else if (stopRequested) finish({ kind: 'stopped' });
        else if (signal) finish({ kind: 'signaled', signal }, 'Codex 进程被信号终止。');
        else finish({ kind: 'exited', code: code && code !== 0 ? code : 1 }, `Codex 进程在任务完成前退出（退出码 ${code}）。`);
      });

      if (opts.timeoutMs) {
        timers.push(
          setTimeout(() => {
            if (finished) return;
            timedOut = true;
            declineAllPending();
            interrupt();
          }, opts.timeoutMs),
        );
      }

      (async () => {
        await request('initialize', { clientInfo: { name: 'ai_solo_studio', title: 'AI Solo Studio', version: '0.3.0' } });
        write({ method: 'initialized', params: {} });
        const t = await request('thread/start', cfg.threadStart);
        threadId = t?.thread?.id;
        if (!threadId) throw new Error('app-server 没有返回线程 ID');
        if (stopRequested || timedOut) return;
        const r = await request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }], ...cfg.turnOverrides });
        turnId = r?.turn?.id ?? turnId;
        if (stopRequested || timedOut) interrupt();
      })().catch((e: Error) => {
        if (!finished && !stopRequested && !timedOut) finish({ kind: 'exited', code: 1 }, `无法启动 Codex 任务：${e.message}`);
      });
    }

    return {
      events: ch,
      async respond(requestId: string, decision: Decision) {
        const rpcId = pendingApprovals.get(requestId);
        if (rpcId === undefined) throw new Error(`未知的权限请求：${requestId}`);
        pendingApprovals.delete(requestId);
        if (decision === 'deny') {
          const req = requests.get(requestId);
          if (req) {
            denied.push({
              kind: req.kind,
              ...(req.command ? { command: req.command } : {}),
              ...(req.paths ? { paths: req.paths } : {}),
              description: req.description,
              risk: assess(req, cwd).level,
            });
          }
        }
        write({ id: rpcId, result: { decision: decision === 'allow' ? 'accept' : 'decline' } });
      },
      async stop() {
        if (finished) return;
        stopRequested = true;
        declineAllPending();
        interrupt();
        await done;
      },
    };
  }
}
