import fs from 'node:fs/promises';
import path from 'node:path';
import type { SandboxCommandRunner } from '../../checks/scripts.js';
import type { Capabilities } from '../../capabilities/model.js';
import { resolveCapabilities } from '../../capabilities/model.js';
import { CHECK_ENV_WHITELIST } from '../../checks/scripts.js';
import { writeWorktreeTextFile } from '../../persistence/worktree-fs.js';
import { requireFullTrustConfirmed, sensitiveFallbackList, type EffectivePermissions } from '../modes.js';
import type { Decision, DeniedOperation, DetectResult, Executor, ExecutorEvent, ExecutorRun, IsolationInfo, StartOptions } from '../types.js';
import { isOfficialEndpointForPreset, type ApiProtocol, type BuiltinApiProviderId } from '../api/catalog.js';
import {
  callProviderModel,
  redactApiSecrets,
  testProviderConnection,
  type AgentToolSpec,
  type AgentTurnMessage,
} from '../api/client.js';

export interface ApiAgentExecutorOptions {
  id: string;
  displayName: string;
  presetId: BuiltinApiProviderId;
  protocol: ApiProtocol;
  endpoint: string;
  model: string;
  requiresKey?: boolean;
  getSecret: () => Promise<string | null>;
  sandboxRunner?: SandboxCommandRunner;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
  commandTimeoutMs?: number;
}

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_READ_BYTES = 128 * 1024;
const SKIP_SEARCH_DIRS = new Set(['.git', 'node_modules', '.studio', 'dist', 'dist-electron', 'dist-renderer']);

const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'list_dir',
    description: 'List files and subdirectories inside a directory relative to the task worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Relative directory path inside the worktree (defaults to ".").' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read UTF-8 text lines from a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path (or allowed readable path).' },
        startLine: { type: 'integer', description: '1-based start line (optional).' },
        endLine: { type: 'integer', description: '1-based end line inclusive (optional).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search text substring across files in a worktree subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring to match (case-sensitive).' },
        dir: { type: 'string', description: 'Relative directory to scan (defaults to ".").' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the writable worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path inside the task worktree.' },
        content: { type: 'string', description: 'Full text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact substring inside an existing writable file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path inside the task worktree.' },
        target: { type: 'string', description: 'Exact existing text to replace.' },
        replacement: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'target', 'replacement'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a single non-interactive command inside the sandboxed worktree when sandbox execution is available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name (e.g. node, npm).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument array.' },
      },
      required: ['command'],
    },
  },
];

function isSubPath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function containsDotGit(p: string): boolean {
  return /(^|[\\/])\.git([\\/]|$)/.test(p);
}

async function resolveRealOrNearestParent(targetAbs: string): Promise<string> {
  const pending: string[] = [];
  let cur = path.resolve(targetAbs);
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return targetAbs;
      pending.push(path.basename(cur));
      cur = parent;
    }
  }
}

function sandboxEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHECK_ENV_WHITELIST) {
    const val = process.env[k];
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * 内置通用 AI API 执行体（Stage 8A · ADR 0010）：
 * - 基于 Node 内置 fetch 兼容 OpenAI Compatible / Anthropic Messages / Google Gemini 三协议；
 * - 文件写操作通过 realpath 严格锁定在任务 worktree（及用户显式授权目录）且禁改 .git；
 * - 命令行执行严格委托给 sandboxRunner，绝不回退到无沙箱宿主直跑。
 */
export class ApiAgentExecutor implements Executor {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = { permissionPrompts: false, resumeAfterStop: false } as const;
  readonly sandboxRunner?: SandboxCommandRunner;

  constructor(private readonly opts: ApiAgentExecutorOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    if (opts.sandboxRunner) this.sandboxRunner = opts.sandboxRunner;
  }

  async detect(): Promise<DetectResult> {
    let secret: string | null = null;
    try {
      secret = await this.opts.getSecret();
    } catch (e) {
      return {
        installed: true,
        loggedIn: 'no',
        verified: false,
        note: e instanceof Error ? e.message : String(e),
      };
    }
    if (!secret && this.opts.requiresKey !== false) {
      return { installed: true, loggedIn: 'no', verified: false, note: '尚未配置 API Key。' };
    }
    const res = await testProviderConnection({
      protocol: this.opts.protocol,
      endpoint: this.opts.endpoint,
      model: this.opts.model,
      secret,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
    if (!res.ok) {
      return { installed: true, loggedIn: 'no', verified: false, note: redactApiSecrets(res.message, secret) };
    }
    if (!res.toolCallingSupported) {
      return { installed: true, loggedIn: 'yes', verified: false, note: res.warning };
    }
    return { installed: true, loggedIn: 'yes', verified: true };
  }

  start(startOpts: StartOptions): ExecutorRun {
    const queue = new AsyncEventQueue<ExecutorEvent>();
    const ac = new AbortController();
    let stopRequested = false;
    let activeTimedOut = false;

    const executeLoop = async () => {
      const caps: Capabilities = resolveCapabilities(startOpts.capabilities);
      const denied: DeniedOperation[] = [];
      let secret: string | null = null;

      try {
        if (caps.constructionMode === 'full_trust') {
          await requireFullTrustConfirmed(startOpts.taskId ?? '', startOpts.fullTrustRecords ?? { get: async () => null });
        }
        secret = await this.opts.getSecret();
        if (!secret && this.opts.requiresKey !== false) {
          throw new Error(`执行者「${this.displayName}」缺少可用 API Key。`);
        }

        const realCwd = await resolveRealOrNearestParent(startOpts.cwd);
        const realExtra = await Promise.all(caps.extraWritableDirs.map((d) => resolveRealOrNearestParent(d)));
        const writableRoots = [realCwd, ...realExtra];
        const denyReadRoots = await Promise.all(sensitiveFallbackList().map((d) => resolveRealOrNearestParent(d)));
        const official = isOfficialEndpointForPreset(this.opts.presetId, this.opts.endpoint);
        const endpointOrigin = (() => {
          try {
            return new URL(this.opts.endpoint).origin;
          } catch {
            return this.opts.endpoint;
          }
        })();

        const hostNotes: string[] = [];
        if (!official) {
          hostNotes.push(`数据发往非官方/自定义地址：${endpointOrigin}`);
        }
        if (!this.opts.sandboxRunner) {
          hostNotes.push('当前 API 执行模式未配备受限命令沙箱，施工期间模型无法执行终端命令；文件改动会在独立副本完成后供你验收。');
        }

        const permissions: EffectivePermissions = {
          mode: caps.constructionMode,
          approvalPolicy: caps.constructionMode === 'full_trust' ? 'full_trust' : 'strict_containment',
          sandboxType: caps.constructionMode === 'full_trust' ? 'unrestrictedHostTools' : 'worktreeContainment',
          networkAccess: caps.externalNetwork === 'on',
          networkEnabled: caps.externalNetwork === 'on',
          allowedDomains: caps.allowedNetworkDomains,
          writableRoots: caps.constructionMode === 'full_trust' ? [] : writableRoots,
          summary: `API 执行体（${this.opts.model}）：可写仅限 ${writableRoots.join('、')}`,
        };
        const iso: IsolationInfo = {
          model: startOpts.model?.trim() || this.opts.model,
          instructionSources: [],
          approvalPolicy: permissions.approvalPolicy,
          sandbox: permissions.sandboxType ?? 'worktreeContainment',
          permissions,
          grantedMcp: [],
          modelProvider: this.opts.presetId,
          warnings: [],
        };
        queue.push({ type: 'isolation', info: iso });
        if (hostNotes.length) {
          queue.push({ type: 'message', text: hostNotes.join(' '), source: 'host' });
        }

        const recordDenied = (op: DeniedOperation): string => {
          denied.push(op);
          queue.push({ type: 'blocked', operation: op });
          return `PERMISSION_DENIED: ${op.description}`;
        };

        const runTool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
          const rawPath = typeof args.path === 'string' ? args.path : typeof args.dir === 'string' ? args.dir : '.';
          const candidateAbs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(realCwd, rawPath);
          const resolved = await resolveRealOrNearestParent(candidateAbs);

          const isBlockedRead = () => {
            if (caps.constructionMode !== 'full_trust' && denyReadRoots.some((d) => isSubPath(resolved, d))) return true;
            return containsDotGit(resolved);
          };
          const canWriteTarget = () => {
            if (caps.fileAccess === 'worktree_read_only') return false;
            if (containsDotGit(resolved)) return false;
            return writableRoots.some((root) => isSubPath(resolved, root));
          };

          if (name === 'list_dir') {
            if (isBlockedRead()) {
              return { text: recordDenied({ kind: 'read_file', paths: [rawPath], description: `读取受保护目录被拒：${rawPath}`, risk: 'high' }), isError: true };
            }
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`);
            return { text: lines.join('\n') || '(empty directory)' };
          }

          if (name === 'read_file') {
            if (isBlockedRead()) {
              return { text: recordDenied({ kind: 'read_file', paths: [rawPath], description: `读取受保护文件被拒：${rawPath}`, risk: 'high' }), isError: true };
            }
            const stat = await fs.stat(resolved);
            if (stat.size > MAX_READ_BYTES) {
              const buf = Buffer.alloc(MAX_READ_BYTES);
              const fh = await fs.open(resolved, 'r');
              try {
                await fh.read(buf, 0, MAX_READ_BYTES, 0);
              } finally {
                await fh.close();
              }
              return { text: `${buf.toString('utf8')}\n...[truncated at 128KB]` };
            }
            const content = await fs.readFile(resolved, 'utf8');
            const lines = content.split('\n');
            const startLine = typeof args.startLine === 'number' && args.startLine > 0 ? Math.floor(args.startLine) : 1;
            const endLine = typeof args.endLine === 'number' && args.endLine >= startLine ? Math.floor(args.endLine) : lines.length;
            return { text: lines.slice(startLine - 1, endLine).join('\n') };
          }

          if (name === 'search_files') {
            const pattern = typeof args.pattern === 'string' ? args.pattern : '';
            if (!pattern) return { text: 'Missing pattern argument', isError: true };
            if (isBlockedRead()) {
              return { text: recordDenied({ kind: 'read_file', paths: [rawPath], description: `搜索受保护目录被拒：${rawPath}`, risk: 'high' }), isError: true };
            }
            const matches: string[] = [];
            const walkSearch = async (dirAbs: string): Promise<void> => {
              if (matches.length >= 100) return;
              const es = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
              for (const e of es) {
                if (matches.length >= 100) break;
                if (SKIP_SEARCH_DIRS.has(e.name)) continue;
                const full = path.join(dirAbs, e.name);
                if (e.isDirectory()) {
                  await walkSearch(full);
                } else if (e.isFile()) {
                  const st = await fs.stat(full).catch(() => null);
                  if (!st || st.size > MAX_READ_BYTES) continue;
                  const txt = await fs.readFile(full, 'utf8').catch(() => '');
                  if (!txt.includes(pattern)) continue;
                  const lines = txt.split('\n');
                  lines.forEach((line, idx) => {
                    if (matches.length < 100 && line.includes(pattern)) {
                      matches.push(`${path.relative(realCwd, full)}:${idx + 1}: ${line.slice(0, 160)}`);
                    }
                  });
                }
              }
            };
            await walkSearch(resolved);
            return { text: matches.join('\n') || 'No matches found.' };
          }

          if (name === 'write_file') {
            if (!canWriteTarget()) {
              return {
                text: recordDenied({ kind: 'write_file', paths: [rawPath], description: `尝试写入副本外或受保护路径：${rawPath}`, risk: 'high' }),
                isError: true,
              };
            }
            const content = typeof args.content === 'string' ? args.content : '';
            await writeWorktreeTextFile(resolved, content);
            return { text: `Wrote ${path.relative(realCwd, resolved) || rawPath} (${content.length} chars).` };
          }

          if (name === 'edit_file') {
            if (!canWriteTarget()) {
              return {
                text: recordDenied({ kind: 'write_file', paths: [rawPath], description: `尝试修改副本外或受保护路径：${rawPath}`, risk: 'high' }),
                isError: true,
              };
            }
            const target = typeof args.target === 'string' ? args.target : '';
            const replacement = typeof args.replacement === 'string' ? args.replacement : '';
            if (!target) return { text: 'Missing target substring.', isError: true };
            const cur = await fs.readFile(resolved, 'utf8');
            if (!cur.includes(target)) return { text: 'Target substring not found in file.', isError: true };
            const updated = cur.split(target).join(replacement);
            await writeWorktreeTextFile(resolved, updated);
            return { text: `Updated ${path.relative(realCwd, resolved) || rawPath}.` };
          }

          if (name === 'run_command') {
            const cmd = typeof args.command === 'string' ? args.command.trim() : '';
            const cmdArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [];
            const argv = [cmd, ...cmdArgs].filter(Boolean);
            if (!cmd) return { text: 'Missing command.', isError: true };
            if (!this.opts.sandboxRunner) {
              return {
                text: recordDenied({
                  kind: 'run_command',
                  command: argv,
                  description: `无沙箱命令执行环境，已拦下终端命令：${argv.join(' ')}`,
                  risk: 'medium',
                }),
                isError: true,
              };
            }
            const execRes = await this.opts.sandboxRunner.runCommand({
              cwd: realCwd,
              argv,
              env: sandboxEnv(),
              timeoutMs: this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
              capabilities: caps,
              ...(startOpts.taskId ? { taskId: startOpts.taskId } : {}),
              ...(startOpts.fullTrustRecords ? { fullTrustRecords: startOpts.fullTrustRecords } : {}),
            });
            if (execRes.status === 'unavailable') {
              return {
                text: recordDenied({
                  kind: 'run_command',
                  command: argv,
                  description: `沙箱运行器拒绝或不可用：${execRes.reason}`,
                  risk: 'medium',
                }),
                isError: true,
              };
            }
            const out = [
              `exitCode: ${String(execRes.exitCode)}${execRes.timedOut ? ' (timedOut)' : ''}`,
              execRes.stdout ? `stdout:\n${execRes.stdout.slice(0, 4000)}` : '',
              execRes.stderr ? `stderr:\n${execRes.stderr.slice(0, 2000)}` : '',
            ]
              .filter(Boolean)
              .join('\n');
            return { text: out, isError: execRes.exitCode !== 0 || execRes.timedOut };
          }

          return { text: `Unknown tool: ${name}`, isError: true };
        };

        const systemPrompt = [
          'You are an AI software coding executor operating inside an isolated Git worktree.',
          `Worktree root: ${realCwd}`,
          'Use the provided tools to inspect files, implement the requested changes concisely inside the worktree, and report what you changed and any items you could not complete.',
          'Never fabricate test/build results. When finished making edits, reply with a concise plain summary without calling more tools.',
        ].join('\n');

        const messages: AgentTurnMessage[] = [{ role: 'user', content: startOpts.prompt }];
        const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;
        const modelId = startOpts.model?.trim() || this.opts.model;
        let finishedCleanly = false;

        const deadlineTimer =
          typeof startOpts.timeoutMs === 'number' && startOpts.timeoutMs > 0
            ? setTimeout(() => {
                activeTimedOut = true;
                ac.abort();
              }, startOpts.timeoutMs)
            : null;

        try {
          for (let step = 0; step < maxSteps; step++) {
            if (stopRequested || ac.signal.aborted) break;
            const turn = await callProviderModel({
              protocol: this.opts.protocol,
              endpoint: this.opts.endpoint,
              model: modelId,
              secret,
              system: systemPrompt,
              messages,
              tools: AGENT_TOOLS,
              maxTokens: 4096,
              ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
              signal: ac.signal,
            });

            if (stopRequested || activeTimedOut) break;
            if (!turn.ok) {
              const safeMsg = redactApiSecrets(turn.message, secret);
              queue.push({ type: 'message', text: safeMsg, source: 'host' });
              queue.push({ type: 'exit', outcome: { kind: 'exited', code: 1 }, denied });
              return;
            }

            if (turn.toolCalls.length === 0) {
              if (turn.text.trim()) {
                queue.push({ type: 'message', text: redactApiSecrets(turn.text, secret) });
              }
              finishedCleanly = true;
              break;
            }

            messages.push({
              role: 'assistant',
              text: turn.text,
              toolCalls: turn.toolCalls,
              ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
            });

            const toolResults = [];
            for (const tc of turn.toolCalls) {
              if (stopRequested || ac.signal.aborted) break;
              const summaryTarget =
                typeof tc.arguments.path === 'string'
                  ? tc.arguments.path
                  : typeof tc.arguments.command === 'string'
                    ? tc.arguments.command
                    : '';
              queue.push({
                type: 'tool',
                name: tc.name,
                summary: redactApiSecrets(summaryTarget ? `${tc.name}(${summaryTarget})` : tc.name, secret),
              });
              let result: { text: string; isError?: boolean };
              try {
                result = await runTool(tc.name, tc.arguments);
              } catch (toolErr) {
                result = {
                  text: redactApiSecrets(toolErr instanceof Error ? toolErr.message : String(toolErr), secret),
                  isError: true,
                };
              }
              toolResults.push({
                callId: tc.id,
                name: tc.name,
                content: redactApiSecrets(result.text, secret),
                ...(result.isError ? { isError: true } : {}),
              });
            }
            if (stopRequested || activeTimedOut) break;
            messages.push({ role: 'tool_results', results: toolResults });
          }
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }

        if (stopRequested) {
          queue.push({ type: 'exit', outcome: { kind: 'stopped' }, denied });
          return;
        }
        if (activeTimedOut) {
          queue.push({ type: 'exit', outcome: { kind: 'timed_out' }, denied });
          return;
        }
        if (!finishedCleanly) {
          queue.push({
            type: 'message',
            text: `已达到 API 执行单轮步数上限（${maxSteps} 步），尚未自行结束，请查看目前改动并决定继续或调整需求。`,
            source: 'host',
          });
          queue.push({ type: 'exit', outcome: { kind: 'exited', code: 1 }, denied });
          return;
        }
        queue.push({ type: 'exit', outcome: { kind: 'exited', code: 0 }, denied });
      } catch (err) {
        const msg = redactApiSecrets(err instanceof Error ? err.message : String(err), secret);
        queue.push({ type: 'message', text: msg, source: 'host' });
        queue.push({ type: 'exit', outcome: { kind: 'spawn_error', message: msg }, denied });
      } finally {
        queue.close();
      }
    };

    void executeLoop();

    return {
      events: queue,
      respond: async (_requestId: string, _decision: Decision) => undefined,
      stop: async () => {
        stopRequested = true;
        ac.abort();
      },
    };
  }
}
