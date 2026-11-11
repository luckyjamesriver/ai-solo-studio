import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCapabilities, type Capabilities } from '../../capabilities/model.js';
import type { SandboxCommandRunner } from '../../checks/scripts.js';
import { hostEnv } from '../../env/host-env.js';
import { assess } from '../../policy/risk.js';
import { run } from '../../proc/run.js';
import { Channel } from '../channel.js';
import {
  requireRiskAcknowledged,
  type SubscriptionRiskGate,
} from '../cli/subscriptions.js';
import {
  buildFullTrustMode,
  sensitiveFallbackList,
  type EffectivePermissions,
  type FullTrustRecords,
} from '../modes.js';
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

export type AcpCliId = 'agy' | 'cursor';

const NO_RECORDS: FullTrustRecords = { get: async () => null };
const STRIPPED_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'CURSOR_API_KEY',
] as const;

export interface AcpExecutorOptions {
  cliId: AcpCliId;
  command?: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  model?: string;
  riskGate?: SubscriptionRiskGate;
  sandboxRunner?: SandboxCommandRunner;
}

/** 构造安全的 ACP 启动参数（绝不使用跳过权限/免确认参数）。 */
export function acpExecArgs(
  cliId: AcpCliId,
  cwd: string,
  caps: Capabilities,
  opts: { model?: string } = {},
): string[] {
  const fullTrust = caps.constructionMode === 'full_trust';
  if (cliId === 'agy') {
    const args = [
      'acp',
      '--sandbox',
      '--include-default-customizations=false',
      '--stdio',
    ];
    for (const extra of caps.extraWritableDirs) {
      args.push('--add-dir', extra);
    }
    return args;
  }
  const args = [
    '--sandbox',
    fullTrust ? 'disabled' : 'enabled',
    '--workspace',
    cwd,
  ];
  for (const extra of caps.extraWritableDirs) {
    args.push('--add-dir', extra);
  }
  if (opts.model?.trim()) {
    args.push('--model', opts.model.trim());
  }
  args.push('acp');
  return args;
}

function sanitizeSubEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...hostEnv(), ...base };
  for (const k of STRIPPED_KEYS) delete out[k];
  return out;
}

function resolveRealOrNearest(target: string): string {
  const resolved = path.resolve(target);
  const parts: string[] = [];
  let cur = resolved;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return path.join(real, ...parts);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;
      parts.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function containsDotGit(absPath: string): boolean {
  return absPath.split(path.sep).includes('.git');
}

function isInsideRoot(targetReal: string, rootReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
}

function isSensitiveReadPath(targetReal: string): boolean {
  const denyList = sensitiveFallbackList().map((p) => resolveRealOrNearest(p));
  return denyList.some((d) => isInsideRoot(targetReal, d));
}

interface AcpPermissionDecision {
  allow: boolean;
  reason?: string;
  kind: PermissionKind;
  paths?: string[];
  command?: string[];
}

function evaluateAcpPermission(
  params: Record<string, unknown>,
  realCwd: string,
  realExtras: string[],
  caps: Capabilities,
): AcpPermissionDecision {
  const fullTrust = caps.constructionMode === 'full_trust';
  const tc = (params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : params) as Record<string, unknown>;
  const rawKind = String(tc.kind ?? tc.toolKind ?? 'other').toLowerCase();
  const title = typeof tc.title === 'string' ? tc.title : '';
  const rawInput = (tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {}) as Record<string, unknown>;
  const locs = Array.isArray(tc.locations) ? (tc.locations as Array<Record<string, unknown>>) : [];

  const pathCandidates: string[] = [];
  for (const l of locs) {
    if (typeof l.path === 'string' && l.path.trim()) pathCandidates.push(l.path.trim());
  }
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'destination']) {
    if (typeof rawInput[key] === 'string' && String(rawInput[key]).trim()) {
      pathCandidates.push(String(rawInput[key]).trim());
    }
  }
  const uniquePaths = [...new Set(pathCandidates)];

  let cmdTokens: string[] | undefined;
  if (typeof rawInput.command === 'string' && rawInput.command.trim()) {
    cmdTokens = rawInput.command.trim().split(/\s+/);
  } else if (Array.isArray(rawInput.command)) {
    cmdTokens = rawInput.command.map(String).filter(Boolean);
  } else if (Array.isArray(rawInput.argv)) {
    cmdTokens = rawInput.argv.map(String).filter(Boolean);
  }

  let kind: PermissionKind = 'other';
  if (/read|search|list|grep|glob/.test(rawKind)) kind = 'read_file';
  else if (/delete|remove/.test(rawKind)) kind = 'delete_file';
  else if (/edit|write|create|patch|move/.test(rawKind)) kind = 'write_file';
  else if (/execute|bash|shell|terminal|command/.test(rawKind)) kind = 'run_command';
  else if (/fetch|web|net|http/.test(rawKind)) kind = 'network';

  if (fullTrust) {
    return { allow: true, kind, ...(uniquePaths.length ? { paths: uniquePaths } : {}), ...(cmdTokens ? { command: cmdTokens } : {}) };
  }

  const allowedRoots = [realCwd, ...realExtras];
  for (const p of uniquePaths) {
    if (p.startsWith('~') || p.includes('$')) {
      return {
        allow: false,
        kind,
        paths: uniquePaths,
        reason: `路径「${p}」包含未展开变量，无法确认处于任务副本内`,
      };
    }
    const abs = path.isAbsolute(p) ? p : path.resolve(realCwd, p);
    const realTarget = resolveRealOrNearest(abs);
    if (kind === 'write_file' || kind === 'delete_file') {
      if (containsDotGit(realTarget)) {
        return { allow: false, kind, paths: [p], reason: '禁止直接修改 .git 目录内容' };
      }
      if (!allowedRoots.some((r) => isInsideRoot(realTarget, r))) {
        return { allow: false, kind, paths: [p], reason: `试图修改任务副本之外的路径：${p}` };
      }
    } else if (kind === 'read_file') {
      if (isSensitiveReadPath(realTarget)) {
        return { allow: false, kind, paths: [p], reason: `路径「${p}」属于敏感凭证保护清单` };
      }
    }
  }

  if (kind === 'network' && caps.externalNetwork !== 'on') {
    return {
      allow: false,
      kind: 'network',
      ...(uniquePaths.length ? { paths: uniquePaths } : {}),
      reason: '标准模式未开启外部网络，已拒绝联网请求',
    };
  }

  if (kind === 'run_command') {
    const reqCheck = {
      id: 'acp-eval',
      kind: 'run_command' as const,
      ...(uniquePaths.length ? { paths: uniquePaths } : {}),
      ...(cmdTokens ? { command: cmdTokens } : {}),
      description: title || 'run_command',
    };
    const risk = assess(reqCheck, realCwd);
    const cmdText = cmdTokens?.join(' ') ?? '';
    if (risk.level === 'high' || /\/etc\/|~\/|&&|\|\||;|\$\(|`/.test(cmdText)) {
      return {
        allow: false,
        kind: 'run_command',
        ...(uniquePaths.length ? { paths: uniquePaths } : {}),
        ...(cmdTokens ? { command: cmdTokens } : {}),
        reason: risk.explanation || '检测到高风险或跨目录命令，已被策略拒绝',
      };
    }
    if (caps.externalNetwork !== 'on' && /\b(?:curl|wget|nc|ssh|scp|git\s+(?:clone|fetch|pull|push))\b/i.test(cmdText)) {
      return {
        allow: false,
        kind: 'run_command',
        ...(cmdTokens ? { command: cmdTokens } : {}),
        reason: '未开启外部网络，已拒绝联网命令',
      };
    }
  }

  if (kind === 'other') {
    return { allow: false, kind: 'other', reason: `未授权的未知工具请求：${title || rawKind}` };
  }

  return { allow: true, kind, ...(uniquePaths.length ? { paths: uniquePaths } : {}), ...(cmdTokens ? { command: cmdTokens } : {}) };
}

function buildPermissionReply(params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : [];
  if (allow) {
    const pick =
      options.find((o) => String(o.kind) === 'allow_once' || String(o.kind) === 'allow-once') ??
      options.find((o) => /allow/i.test(String(o.kind ?? '')) && !/always/i.test(String(o.kind ?? '')));
    if (pick && typeof pick.optionId === 'string') {
      return { outcome: { outcome: 'selected', optionId: pick.optionId } };
    }
  } else {
    const reject =
      options.find((o) => String(o.kind) === 'reject_once' || String(o.kind) === 'reject-once') ??
      options.find((o) => /reject/i.test(String(o.kind ?? '')));
    if (reject && typeof reject.optionId === 'string') {
      return { outcome: { outcome: 'selected', optionId: reject.optionId } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * 通用 ACP（Agent Client Protocol, stdio JSON-RPC）本机订阅执行适配器（阶段 8B）：
 * - 驱动 Antigravity (`agy acp --sandbox --stdio`) 与 Cursor (`agent --sandbox enabled ... acp`)；
 * - 启动前强制通过 `requireRiskAcknowledged(cliId, riskGate)` 门禁；
 * - 剔除其他服务商密钥环境变量，按工作树边界响应 `session/request_permission` 回调，越界直接回 `reject-once` 并推 `blocked` 进入验收卡。
 */
export class AcpExecutor implements Executor {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = { permissionPrompts: false, resumeAfterStop: false };
  readonly sandboxRunner?: SandboxCommandRunner;

  constructor(private readonly options: AcpExecutorOptions) {
    this.id = `sub:${options.cliId}`;
    this.displayName =
      options.cliId === 'agy' ? 'Antigravity（本机订阅）' : 'Cursor CLI（本机订阅）';
    if (options.sandboxRunner) this.sandboxRunner = options.sandboxRunner;
  }

  private get command(): string {
    return this.options.command ?? (this.options.cliId === 'agy' ? 'agy' : 'agent');
  }

  private get prefix(): string[] {
    return this.options.prefixArgs ?? [];
  }

  private async probeInitialize(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; error?: string }> {
    const probeArgs =
      this.options.cliId === 'agy'
        ? ['acp', '--sandbox', '--include-default-customizations=false', '--stdio']
        : ['--sandbox', 'enabled', 'acp'];
    return new Promise((resolve) => {
      let done = false;
      let buf = '';
      let child: ChildProcess;
      const finish = (ok: boolean, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        } catch {}
        resolve(error ? { ok, error } : { ok });
      };
      try {
        child = spawn(this.command, [...this.prefix, ...probeArgs], {
          cwd: os.tmpdir(),
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        done = true;
        resolve({ ok: false, error: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => finish(false, 'ACP 握手超时'), 8000);
      child.on('error', (err) => finish(false, err.message));
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { id?: unknown; result?: { protocolVersion?: unknown }; error?: { message?: string } };
            if (msg.id === 1 && msg.result && typeof msg.result.protocolVersion === 'number') {
              finish(true);
              return;
            }
            if (msg.id === 1 && msg.error) {
              finish(false, msg.error.message ?? 'ACP initialize 返回错误');
              return;
            }
          } catch {}
        }
      });
      child.on('close', (code) => {
        if (!done) finish(false, `ACP 进程提前退出（exit ${code}）`);
      });
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'ai_solo_studio', version: '0.3.0' },
          },
        })}\n`,
      );
    });
  }

  async detect(): Promise<DetectResult> {
    const cwd = os.tmpdir();
    const env = sanitizeSubEnv(this.options.env);
    const label = this.options.cliId === 'agy' ? 'Antigravity CLI' : 'Cursor CLI';

    const v = await run(this.command, [...this.prefix, '--version'], {
      cwd,
      env,
      timeoutMs: 10_000,
      killGraceMs: 500,
    });
    if (v.outcome.kind !== 'exited' || v.outcome.code !== 0) {
      return {
        installed: false,
        loggedIn: 'unknown',
        note: `未在本机找到可运行的 ${this.command} 命令。`,
      };
    }
    const version = (v.stdout || v.stderr).trim().split('\n')[0]?.trim() || '未知版本';

    let loggedIn: DetectResult['loggedIn'] = 'unknown';
    if (this.options.cliId === 'cursor') {
      const s = await run(this.command, [...this.prefix, 'status', '--format', 'json'], {
        cwd,
        env,
        timeoutMs: 10_000,
        killGraceMs: 500,
      });
      if (s.outcome.kind === 'exited' && s.outcome.code === 0) {
        try {
          const parsed = JSON.parse(s.stdout || '{}') as { status?: unknown; isAuthenticated?: unknown };
          if (parsed.isAuthenticated === true || parsed.status === 'authenticated') loggedIn = 'yes';
          else if (parsed.isAuthenticated === false || parsed.status === 'unauthenticated') loggedIn = 'no';
        } catch {}
      } else if (s.outcome.kind === 'exited' && s.outcome.code !== 0) {
        loggedIn = 'no';
      }
      if (loggedIn === 'no') {
        return {
          installed: true,
          loggedIn: 'no',
          version,
          note: '已安装 Cursor CLI，但当前尚未登录（请先在终端运行 `agent login`）。',
        };
      }
    }

    const init = await this.probeInitialize(env);
    if (!init.ok) {
      return {
        installed: true,
        loggedIn,
        version,
        note: `${label}（${version}）ACP 服务未响应：${init.error ?? '握手失败'}`,
      };
    }

    return {
      installed: true,
      loggedIn,
      version,
      note:
        this.options.cliId === 'agy'
          ? `Antigravity（${version}）ACP 握手通过（以本机登录态运行，风险自担）。`
          : `Cursor CLI（${version}）已就绪并完成 ACP 握手。`,
      isolationNotes: ['使用命令行内置终端限制与副本路径核验；不具备 Codex 目录级读取拒绝清单能力'],
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
    let sessionId: string | null = null;
    let nextRpcId = 1;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const pendingRpc = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const writeMsg = (obj: Record<string, unknown>) => {
      if (!child?.stdin?.writable) return;
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    };

    const sendRequest = (method: string, params: Record<string, unknown>): Promise<any> => {
      const id = nextRpcId++;
      return new Promise((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
        writeMsg({ jsonrpc: '2.0', id, method, params });
      });
    };

    const finish = (outcome: ExitOutcome, errorText?: string) => {
      if (finished) return;
      finished = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      for (const p of pendingRpc.values()) p.reject(new Error('ACP 会话已结束'));
      pendingRpc.clear();
      if (errorText) ch.push({ type: 'message', source: 'host', text: errorText });
      ch.push({ type: 'exit', outcome, ...(denied.length ? { denied: [...denied] } : {}) });
      ch.close();
      resolveDone();
    };

    const killChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      if (sessionId) {
        writeMsg({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      }
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
    const label = this.options.cliId === 'agy' ? 'Antigravity' : 'Cursor CLI';

    (async () => {
      try {
        await requireRiskAcknowledged(this.options.cliId, this.options.riskGate);
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

      const realCwd = resolveRealOrNearest(opts.cwd);
      const realExtras = caps.extraWritableDirs.map((d) => resolveRealOrNearest(d));
      const fullTrust = caps.constructionMode === 'full_trust';
      const args = acpExecArgs(this.options.cliId, realCwd, caps, { ...(model ? { model } : {}) });

      const effectivePerms: EffectivePermissions = {
        mode: caps.constructionMode,
        approvalPolicy: 'acp_worktree_guard',
        networkEnabled: fullTrust || caps.externalNetwork === 'on',
        allowedDomains: [],
        writableRoots: fullTrust ? [] : [realCwd, ...realExtras],
        summary: fullTrust
          ? `${label} 本机订阅（完全信任模式）`
          : `${label} 本机订阅（ACP 受限模式 + 副本路径拦截）：可写限于 ${[realCwd, ...realExtras].join('、')}`,
      };

      ch.push({
        type: 'isolation',
        info: {
          ...(model ? { model } : {}),
          instructionSources: [],
          approvalPolicy: 'acp_worktree_guard',
          sandbox: fullTrust ? `${this.options.cliId}_full_trust` : `${this.options.cliId}_sandbox`,
          permissions: effectivePerms,
          grantedMcp: [],
          warnings: [],
        },
      });
      ch.push({
        type: 'message',
        source: 'host',
        text: `${label}（本机订阅 · 风险自担）通过 ACP 协议启动；越界写入或未授权操作将回绝并计入验收记录。`,
      });

      try {
        child = spawn(this.command, [...this.prefix, ...args], {
          cwd: realCwd,
          env: sanitizeSubEnv(this.options.env),
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
      const onLine = (line: string) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line) as Record<string, any>;
        } catch {
          return;
        }

        // JSON-RPC 响应（client -> server 请求的回执）
        if ((msg.result !== undefined || msg.error !== undefined) && msg.id !== undefined) {
          const id = Number(msg.id);
          const pending = pendingRpc.get(id);
          if (pending) {
            pendingRpc.delete(id);
            if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            else pending.resolve(msg.result);
          }
          return;
        }

        // 服务端发起的权限请求（ACP session/request_permission）
        if (msg.method === 'session/request_permission' && msg.id !== undefined) {
          const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
          const evalRes = evaluateAcpPermission(params, realCwd, realExtras, caps);
          if (!evalRes.allow) {
            const desc = evalRes.reason ?? '操作超出任务权限边界，已被拒绝';
            const op: DeniedOperation = {
              kind: evalRes.kind,
              ...(evalRes.paths ? { paths: evalRes.paths } : {}),
              ...(evalRes.command ? { command: evalRes.command } : {}),
              description: desc,
              risk: assess(
                {
                  id: String(msg.id),
                  kind: evalRes.kind,
                  ...(evalRes.paths ? { paths: evalRes.paths } : {}),
                  ...(evalRes.command ? { command: evalRes.command } : {}),
                  description: desc,
                },
                realCwd,
              ).level,
            };
            denied.push(op);
            ch.push({ type: 'blocked', operation: op });
          }
          writeMsg({
            jsonrpc: '2.0',
            id: msg.id,
            result: buildPermissionReply(params, evalRes.allow),
          });
          return;
        }

        // 其他来自服务端的未知 RPC 请求一律拒绝
        if (typeof msg.method === 'string' && msg.id !== undefined) {
          writeMsg({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
          });
          return;
        }

        // ACP 通知：session/update
        if (msg.method === 'session/update') {
          const upd = msg.params?.update ?? msg.params;
          if (!upd || typeof upd !== 'object') return;
          const uType = String(upd.sessionUpdate ?? upd.type ?? '');
          if (uType === 'agent_message_chunk' || uType === 'agent_thought_chunk') {
            const txt =
              typeof upd.content?.text === 'string'
                ? upd.content.text
                : typeof upd.text === 'string'
                  ? upd.text
                  : '';
            if (txt && uType === 'agent_message_chunk') ch.push({ type: 'message', text: txt });
          } else if (uType === 'tool_call' || uType === 'tool_call_update') {
            const kindRaw = String(upd.kind ?? '');
            const title = typeof upd.title === 'string' ? upd.title : 'tool';
            const firstPath = Array.isArray(upd.locations) && typeof upd.locations[0]?.path === 'string'
              ? upd.locations[0].path
              : '';
            const toolName = /edit|write|delete|move/i.test(kindRaw)
              ? 'file_change'
              : /execute/i.test(kindRaw)
                ? 'run_command'
                : kindRaw || 'tool';
            ch.push({ type: 'tool', name: toolName, summary: firstPath || title });
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
        if (finished) return;
        if (timedOut) finish({ kind: 'timed_out' });
        else if (stopRequested) finish({ kind: 'stopped' });
        else if (signal) finish({ kind: 'signaled', signal }, `${label} 进程被信号终止。`);
        else finish({ kind: 'exited', code: code && code !== 0 ? code : 1 }, `${label} 在任务结束前退出（退出码 ${code}）。`);
      });

      (async () => {
        await sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: 'ai_solo_studio', version: '0.3.0' },
        });
        if (stopRequested || timedOut || finished) return;
        const sess = await sendRequest('session/new', { cwd: realCwd, mcpServers: [] });
        sessionId = typeof sess?.sessionId === 'string' ? sess.sessionId : 'default';
        if (stopRequested || timedOut || finished) return;
        const promptRes = await sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: opts.prompt }],
        });
        const stopReason = typeof promptRes?.stopReason === 'string' ? promptRes.stopReason : 'end_turn';
        if (stopRequested) finish({ kind: 'stopped' });
        else if (stopReason === 'cancelled') finish({ kind: 'stopped' });
        else finish({ kind: 'exited', code: 0 });
      })().catch((err: Error) => {
        if (stopRequested) finish({ kind: 'stopped' });
        else if (timedOut) finish({ kind: 'timed_out' });
        else if (!finished) {
          killChild();
          finish({ kind: 'exited', code: 1 }, `${label} 执行出错：${err.message}`);
        }
      });
    })();

    return {
      events: ch,
      get pid(): number | undefined {
        return child?.pid;
      },
      async respond() {
        throw new Error(`${label} 由工作树权限护栏自动裁决，不挂起等待弹窗审批。`);
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
