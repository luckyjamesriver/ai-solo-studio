import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { resolveCapabilities, type Capabilities } from '../../capabilities/model.js';
import type { SandboxCommandRunner } from '../../checks/scripts.js';
import { hostEnv } from '../../env/host-env.js';
import { assess } from '../../policy/risk.js';
import { run } from '../../proc/run.js';
import { Channel } from '../channel.js';
import {
  buildFullTrustMode,
  type EffectivePermissions,
  type FullTrustRecords,
} from '../modes.js';
import {
  requireRiskAcknowledged,
  type SubscriptionRiskGate,
} from '../cli/subscriptions.js';
import type {
  DeniedOperation,
  DetectResult,
  Executor,
  ExecutorEvent,
  ExecutorRun,
  ExitOutcome,
  PermissionKind,
  StartOptions,
} from '../types.js';

const NO_RECORDS: FullTrustRecords = { get: async () => null };
const STRIPPED_API_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

export interface ClaudeCodeExecutorOptions {
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  model?: string;
  riskGate?: SubscriptionRiskGate;
  sandboxRunner?: SandboxCommandRunner;
}

/** 构造安全的 Claude Code CLI 参数（绝不使用跳过权限参数，提示词走 stdin）。 */
export function claudeExecArgs(
  cwd: string,
  caps: Capabilities,
  opts: { model?: string; fullTrust?: boolean } = {},
): string[] {
  const settingsObj = opts.fullTrust
    ? {
        sandbox: { enabled: false },
        permissions: { allow: ['Read(*)', 'Edit(*)', 'Write(*)', 'Bash(*)'] },
      }
    : {
        sandbox: { enabled: true },
        permissions: { allow: ['Read(*)', 'Edit(*)', 'Write(*)'] },
      };

  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--permission-mode',
    'acceptEdits',
    '--settings',
    JSON.stringify(settingsObj),
  ];

  if (!opts.fullTrust) {
    // 实测 Claude Code 2.1.319 --restricted：将文件工具收敛至 cwd + add-dir，禁止写 .git 与设置文件，并移除非必要的命令/外网工具
    args.push('--restricted');
  }
  for (const extra of caps.extraWritableDirs) {
    args.push('--add-dir', extra);
  }
  const model = opts.model?.trim();
  if (model) {
    args.push('--model', model);
  }
  // 显式保留 cwd 传参语义（子进程同时在 cwd 启动）
  void cwd;
  return args;
}

function classifyToolKind(name: string): PermissionKind {
  if (/write|edit|notebook/i.test(name)) return 'write_file';
  if (/read|grep|glob|ls/i.test(name)) return 'read_file';
  if (/bash|shell|exec/i.test(name)) return 'run_command';
  if (/web|fetch|search/i.test(name)) return 'network';
  return 'other';
}

function sanitizeEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...hostEnv(), ...base };
  for (const k of STRIPPED_API_KEYS) delete out[k];
  return out;
}

/**
 * Claude Code 本机订阅执行适配器（阶段 8B · ADR 0010）：
 * - 通过 `claude -p --output-format stream-json --input-format stream-json` 驱动；
 * - 强制检验 `requireRiskAcknowledged('claude_cli', riskGate)` 后才可启动子进程；
 * - 剔除子进程环境变量中的其他服务商 API Key，仅走用户本机已登录的 Claude 订阅态；
 * - 标准模式结合 `--safe-mode`、`--restricted`、`--permission-prompts none`，拒绝直接修改 `.git` 与宿主越界操作。
 */
export class ClaudeCodeExecutor implements Executor {
  readonly id = 'sub:claude_cli';
  readonly displayName = 'Claude Code（本机订阅）';
  readonly capabilities = { permissionPrompts: false, resumeAfterStop: false };
  readonly sandboxRunner?: SandboxCommandRunner;

  constructor(private readonly options: ClaudeCodeExecutorOptions = {}) {
    if (options.sandboxRunner) this.sandboxRunner = options.sandboxRunner;
  }

  private get command(): string {
    return this.options.command ?? 'claude';
  }

  private get prefix(): string[] {
    return this.options.prefixArgs ?? [];
  }

  async detect(): Promise<DetectResult> {
    const cwd = os.tmpdir();
    const env = sanitizeEnv(this.options.env);
    const v = await run(this.command, [...this.prefix, '--version'], {
      cwd,
      env,
      timeoutMs: 12_000,
      killGraceMs: 500,
    });
    if (v.outcome.kind !== 'exited' || v.outcome.code !== 0) {
      return {
        installed: false,
        loggedIn: 'unknown',
        note: '未在本机找到可运行的 Claude Code（claude）命令。',
      };
    }
    const version = (v.stdout || v.stderr).trim().split('\n')[0]?.trim() || '未知版本';
    const s = await run(this.command, [...this.prefix, 'auth', 'status'], {
      cwd,
      env,
      timeoutMs: 12_000,
      killGraceMs: 500,
    });
    if (s.outcome.kind !== 'exited' || s.outcome.code !== 0) {
      return {
        installed: true,
        loggedIn: 'no',
        version,
        note: '已安装 Claude Code，但尚未在本机登录（请先在终端运行 `claude auth login`）。',
      };
    }
    return {
      installed: true,
      loggedIn: 'yes',
      version,
      note: `Claude Code（${version}）已在本机登录，可供风险自担模式启用。`,
      isolationNotes: ['通过 Claude Code 安全受限参数收敛文件读写并关闭扩展，无法按自定义域名放行网段'],
    };
  }

  start(opts: StartOptions): ExecutorRun {
    const ch = new Channel<ExecutorEvent>();
    const caps = resolveCapabilities(opts.capabilities);
    const denied: DeniedOperation[] = [];
    let child: ChildProcess | undefined;
    let stopRequested = false;
    let timedOut = false;
    let finished = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const finish = (outcome: ExitOutcome, errorText?: string) => {
      if (finished) return;
      finished = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (errorText) ch.push({ type: 'message', source: 'host', text: errorText });
      ch.push({ type: 'exit', outcome, ...(denied.length ? { denied: [...denied] } : {}) });
      ch.close();
      resolveDone();
    };

    const killChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      killTimer = setTimeout(() => {
        try {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {}
      }, 2500);
    };

    const model = opts.model ?? this.options.model;

    (async () => {
      try {
        await requireRiskAcknowledged('claude_cli', this.options.riskGate);
      } catch (e) {
        finish({ kind: 'exited', code: 1 }, (e as Error).message);
        return;
      }

      if (caps.constructionMode === 'full_trust') {
        try {
          await buildFullTrustMode(opts.taskId ?? '', opts.cwd, opts.fullTrustRecords ?? NO_RECORDS);
        } catch (e) {
          finish({ kind: 'exited', code: 1 }, `完全信任模式未获确认，任务未开始：${(e as Error).message}`);
          return;
        }
      }

      if (stopRequested) {
        finish({ kind: 'stopped' });
        return;
      }

      const fullTrust = caps.constructionMode === 'full_trust';
      const args = claudeExecArgs(opts.cwd, caps, {
        ...(model ? { model } : {}),
        fullTrust,
      });

      const effectivePerms: EffectivePermissions = {
        mode: caps.constructionMode,
        approvalPolicy: 'claude_safe_restricted',
        networkEnabled: fullTrust || caps.externalNetwork === 'on',
        allowedDomains: [],
        writableRoots: fullTrust ? [] : [opts.cwd, ...caps.extraWritableDirs],
        summary: fullTrust
          ? 'Claude Code 本机订阅（完全信任模式）'
          : `Claude Code 本机订阅（受限模式）：可写限于 ${[opts.cwd, ...caps.extraWritableDirs].join('、')}，禁用命令与外部扩展`,
      };

      ch.push({
        type: 'isolation',
        info: {
          ...(model ? { model } : {}),
          instructionSources: [],
          approvalPolicy: 'claude_safe_restricted',
          sandbox: fullTrust ? 'claude_full_trust' : 'claude_restricted',
          permissions: effectivePerms,
          grantedMcp: [],
          warnings: [],
        },
      });
      ch.push({
        type: 'message',
        source: 'host',
        text: fullTrust
          ? '已按你的完全信任确认启动 Claude Code（本机订阅 · 风险自担）。'
          : '已通过安全受限参数启动 Claude Code（本机订阅 · 风险自担）：限制文件范围在任务副本内，已关闭外部扩展与命令执行。',
      });

      try {
        child = spawn(this.command, [...this.prefix, ...args], {
          cwd: opts.cwd,
          env: sanitizeEnv(this.options.env),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        finish({ kind: 'spawn_error', message: (e as Error).message });
        return;
      }

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (finished) return;
          timedOut = true;
          killChild();
        }, opts.timeoutMs);
      }

      let stdoutBuf = '';
      let lastResult: Record<string, unknown> | undefined;
      let isolationAborted = false;

      const onLine = (line: string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          const mcp = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
          const slashes = Array.isArray(msg.slash_commands) ? msg.slash_commands : [];
          if (mcp.length > 0 || slashes.length > 0) {
            isolationAborted = true;
            killChild();
            finish(
              { kind: 'exited', code: 1 },
              `隔离无法确认：Claude Code 初始化仍带入了扩展配置（mcp=${mcp.length}、slash=${slashes.length}），已中止任务。`,
            );
            return;
          }
          return;
        }
        if (msg.type === 'assistant') {
          const inner = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
          const blocks = Array.isArray(inner?.content) ? inner.content : [];
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              ch.push({ type: 'message', text: b.text });
            } else if (b.type === 'tool_use') {
              const name = typeof b.name === 'string' ? b.name : 'tool';
              const inp = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
              const pathHint =
                typeof inp.file_path === 'string'
                  ? inp.file_path
                  : typeof inp.path === 'string'
                    ? inp.path
                    : '';
              const mappedName = /write|edit/i.test(name)
                ? 'file_change'
                : /bash/i.test(name)
                  ? 'run_command'
                  : name;
              ch.push({
                type: 'tool',
                name: mappedName,
                summary: pathHint || name,
              });
            }
          }
          return;
        }
        if (msg.type === 'result') {
          lastResult = msg;
          const denials = Array.isArray(msg.permission_denials)
            ? (msg.permission_denials as Array<Record<string, unknown>>)
            : [];
          for (const d of denials) {
            const toolName = typeof d.tool_name === 'string' ? d.tool_name : 'tool';
            const kind = classifyToolKind(toolName);
            const toolInput = (d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {}) as Record<string, unknown>;
            const rawPath =
              typeof toolInput.file_path === 'string'
                ? toolInput.file_path
                : typeof toolInput.path === 'string'
                  ? toolInput.path
                  : undefined;
            const rawCmd =
              typeof toolInput.command === 'string' && toolInput.command.trim()
                ? toolInput.command.trim().split(/\s+/)
                : undefined;
            const permReq = {
              id: String(d.tool_use_id ?? `${toolName}-${denied.length}`),
              kind,
              ...(rawPath ? { paths: [rawPath] } : {}),
              ...(rawCmd ? { command: rawCmd } : {}),
              description: `Claude Code 请求 ${toolName} 已被安全受限模式拦截`,
            };
            const op: DeniedOperation = {
              kind,
              ...(rawPath ? { paths: [rawPath] } : {}),
              ...(rawCmd ? { command: rawCmd } : {}),
              description: permReq.description,
              risk: assess(permReq, opts.cwd).level,
            };
            denied.push(op);
            ch.push({ type: 'blocked', operation: op });
          }
          if (typeof msg.result === 'string' && msg.result.trim()) {
            ch.push({ type: 'message', text: msg.result });
          }
        }
      };

      child.on('error', (err) => finish({ kind: 'spawn_error', message: err.message }));
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) onLine(line);
        }
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        const cleaned = chunk.trim();
        if (cleaned) ch.push({ type: 'log', stream: 'stderr', text: cleaned });
      });
      child.on('close', (code, signal) => {
        if (stdoutBuf.trim()) onLine(stdoutBuf.trim());
        if (finished || isolationAborted) return;
        if (timedOut) {
          finish({ kind: 'timed_out' });
        } else if (stopRequested) {
          finish({ kind: 'stopped' });
        } else if (signal) {
          finish({ kind: 'signaled', signal }, 'Claude Code 进程被信号终止。');
        } else if (lastResult && lastResult.is_error === true) {
          const errMsg =
            typeof lastResult.result === 'string' && lastResult.result.trim()
              ? lastResult.result.trim()
              : 'Claude Code 返回执行错误。';
          finish({ kind: 'exited', code: code && code !== 0 ? code : 1 }, errMsg);
        } else {
          finish({ kind: 'exited', code: code ?? 0 });
        }
      });

      const userTurn = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: opts.prompt }] },
      });
      child.stdin?.write(`${userTurn}\n`);
      child.stdin?.end();
    })();

    return {
      events: ch,
      get pid(): number | undefined {
        return child?.pid;
      },
      async respond() {
        throw new Error('Claude Code 自动以非交互受限参数运行，不挂起等待审批。');
      },
      async stop() {
        if (finished) return;
        stopRequested = true;
        if (!child) finish({ kind: 'stopped' });
        else killChild();
        await done;
      },
    };
  }
}
