import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Channel } from '../channel.js';
import { run } from '../../proc/run.js';
import { hostEnv } from '../../env/host-env.js';
import type { DeniedOperation, DetectResult, Decision, Executor, ExecutorEvent, ExecutorRun, ExitOutcome, PermissionRequest, StartOptions } from '../types.js';
import { resolveCapabilities, type Capabilities } from '../../capabilities/model.js';
import { assess } from '../../policy/risk.js';
import { parseCommand } from './codex-command.js';

/**
 * Codex 适配器：通过 `codex app-server`（stdio，换行分隔的 JSON-RPC）驱动。
 * 协议与行为以 spikes/codex/ 的实测和 `codex app-server generate-json-schema` 生成的 schema 为准。
 * app-server 被官方标注为 experimental，协议可能变化。
 */

/**
 * 配置层（-c）的 approval_policy 只接受 on-request（实测：`approval_policy="untrusted"` 会让 app-server 拒绝启动，
 * 报 “no longer supported”）；“每条命令都询问”（untrusted）只能通过 thread/start 与 turn/start 的参数声明。
 * 实测对比见 ADR 0001“approval_policy 实测”。启动后会用 thread/start 的响应核验实际生效值。
 */
const CONFIG_APPROVAL_POLICY = 'on-request';

export interface CodexLaunchConfig {
  /** `codex app-server` 的命令行参数（不含可执行文件本身） */
  args: string[];
  /** thread/start 的参数 */
  threadStart: Record<string, unknown>;
  /** turn/start 中每个回合都再次显式声明的参数（不依赖线程或用户配置的默认值） */
  turnOverrides: Record<string, unknown>;
  /** 期望在 thread/start 响应里看到的实际生效值（启动后核验用） */
  expected: { approvalPolicy: string; sandboxType: 'workspaceWrite' | 'readOnly'; networkAccess: boolean };
}

/** 能力 → Codex 参数的映射（单点定义，便于测试） */
export function mapCapabilities(c: Capabilities) {
  return {
    sandboxMode: c.fileAccess === 'worktree_write' ? 'workspace-write' : 'read-only',
    sandboxType: (c.fileAccess === 'worktree_write' ? 'workspaceWrite' : 'readOnly') as 'workspaceWrite' | 'readOnly',
    approvalPolicy: c.commandExecution === 'ask_each' ? 'untrusted' : 'on-request',
    network: c.externalNetwork === 'on',
  };
}

/** TOML 键：裸键只允许 A-Za-z0-9_-，其余加引号并转义 */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 经过验证的 Codex 版本。其他版本不阻止使用，但 detect() 会提示“未经验证”。 */
export const VERIFIED_CODEX_VERSION = '0.166.0';

/**
 * 最终生效的隔离与安全参数——全部集中在这里，便于测试。
 * - app-server 没有“忽略用户配置”的开关，所以：命令行用 -c 覆盖沙箱与审批，线程与回合参数里再各声明一次；
 * - 沙箱：只有任务 worktree 可写，且不包含系统临时目录；默认不联网；
 * - 审批：需要时询问（on-request）；
 * - 禁用插件。
 */
export function codexLaunchConfig(cwd: string, opts: { model?: string; mcpServers?: string[]; capabilities?: Partial<Capabilities> } = {}): CodexLaunchConfig {
  const caps = resolveCapabilities(opts.capabilities);
  const m = mapCapabilities(caps);
  return {
    expected: { approvalPolicy: m.approvalPolicy, sandboxType: m.sandboxType, networkAccess: m.network },
    args: [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      `sandbox_mode="${m.sandboxMode}"`,
      '-c',
      `approval_policy="${CONFIG_APPROVAL_POLICY}"`,
      // 用户在 config.toml 里写的自定义指令不进入会话（官方配置键 instructions / developer_instructions）
      '-c',
      'instructions=""',
      '-c',
      'developer_instructions=""',
      '-c',
      'include_apps_instructions=false',
      // 逐个关闭用户配置的 MCP 服务器（官方键 mcp_servers.<名称>.enabled；没有“全部关闭”的总开关）
      ...(opts.mcpServers ?? []).flatMap((name) => ['-c', `mcp_servers.${tomlKey(name)}.enabled=false`]),
      // ---- 其他会执行用户程序、带入用户数据或联网的扩展（M2.5 第 3 项；清单与验证见 ADR 0001）----
      '-c',
      'notify=[]', // 回合结束时运行用户指定的程序
      '--disable',
      'hooks', // 用户/项目配置的 hooks（会运行任意命令）
      '--disable',
      'memories', // 把用户历史记忆带入会话，并把本任务内容写进用户的全局记忆
      '-c',
      'memories.use_memories=false',
      '-c',
      'memories.generate_memories=false',
      '--disable',
      'multi_agent', // 子代理不在我们的审批与核验范围内
      '--disable',
      'remote_plugin',
      '--disable',
      'shell_snapshot', // 快照用户的 shell 环境（含 rc 文件）
      '-c',
      'allow_login_shell=false', // 命令不经登录 shell，不加载用户的 .zprofile / .zshrc
      '-c',
      'shell_environment_policy.inherit="core"', // 命令只继承核心环境变量，不带入宿主进程里的密钥类变量
      '-c',
      `web_search="${caps.externalNetwork === 'on' ? 'live' : 'disabled'}"`, // 模型侧联网搜索（外部网络）
      '--disable',
      'plugins',
      // 关闭 ChatGPT 连接器（apps）：否则会话里会出现数百个来自用户账号的连接器工具
      '--disable',
      'apps',
    ],
    threadStart: {
      cwd,
      approvalPolicy: m.approvalPolicy,
      sandbox: m.sandboxMode,
      ephemeral: true,
      ...(opts.model ? { model: opts.model } : {}),
    },
    turnOverrides: {
      cwd,
      approvalPolicy: m.approvalPolicy,
      sandboxPolicy:
        m.sandboxType === 'workspaceWrite'
          ? { type: 'workspaceWrite', writableRoots: [cwd], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: m.network }
          : { type: 'readOnly' },
    },
  };
}

const OFFICIAL_ORIGINS = new Set(['https://api.openai.com', 'https://chatgpt.com']);
const originOf = (u: unknown): string => {
  try {
    return new URL(String(u)).origin;
  } catch {
    return '（地址无法解析）';
  }
};

/**
 * 实际生效的模型服务提供方与地址里，哪些不是官方默认。只看提供方名称与地址的“源”（协议+主机+端口），
 * 不读取任何密钥、请求头或令牌字段。
 */
export function nonOfficialEndpoints(thread: { modelProvider?: unknown } | undefined, conf: Record<string, any>): string[] {
  const out: string[] = [];
  const provider = String(thread?.modelProvider ?? conf.model_provider ?? 'openai');
  if (provider !== 'openai') {
    const base = conf.model_providers?.[provider]?.base_url;
    out.push(`提供方「${provider}」${base ? `（${originOf(base)}）` : '（地址未知）'}`);
  }
  for (const key of ['openai_base_url', 'chatgpt_base_url', 'experimental_thread_store_endpoint'] as const) {
    const v = conf[key];
    if (typeof v === 'string' && v && !OFFICIAL_ORIGINS.has(originOf(v))) out.push(`${key}=${originOf(v)}`);
  }
  return out;
}

/**
 * 启动前自检：独立于构造函数，逐项确认“要求的保护”确实都在参数里。任何一项缺失 → 返回问题清单，调用方不得启动。
 */
export function selfCheckLaunch(cfg: CodexLaunchConfig, caps: Capabilities, disabledMcp: string[]): string[] {
  const problems: string[] = [];
  const a = cfg.args;
  const pair = (flag: string, value: string) => a.some((x, i) => x === flag && a[i + 1] === value);
  const m = mapCapabilities(caps);
  if (!pair('-c', `sandbox_mode="${m.sandboxMode}"`)) problems.push('沙箱模式');
  if (!pair('-c', `approval_policy="${CONFIG_APPROVAL_POLICY}"`)) problems.push('配置层审批策略');
  if (cfg.threadStart.approvalPolicy !== m.approvalPolicy || (cfg.turnOverrides as { approvalPolicy?: unknown }).approvalPolicy !== m.approvalPolicy) problems.push('命令审批策略');
  if (cfg.threadStart.sandbox !== m.sandboxMode) problems.push('线程沙箱');
  const sp = (cfg.turnOverrides as { sandboxPolicy?: { type?: string; writableRoots?: string[]; networkAccess?: boolean } }).sandboxPolicy;
  if (sp?.type !== m.sandboxType) problems.push('回合沙箱类型');
  if (m.sandboxType === 'workspaceWrite') {
    if (!(sp?.writableRoots?.length === 1 && sp.writableRoots[0] === cfg.threadStart.cwd)) problems.push('可写根（只能是任务工作树）');
    if (sp?.networkAccess !== m.network) problems.push('外部网络开关');
  }
  for (const f of ['hooks', 'memories', 'multi_agent', 'remote_plugin', 'shell_snapshot', 'plugins', 'apps']) if (!pair('--disable', f)) problems.push(`扩展 ${f} 未关闭`);
  for (const kv of ['notify=[]', 'memories.use_memories=false', 'memories.generate_memories=false', 'allow_login_shell=false', 'shell_environment_policy.inherit="core"', 'instructions=""', 'developer_instructions=""']) {
    if (!pair('-c', kv)) problems.push(`配置项 ${kv.split('=')[0]}`);
  }
  if (!pair('-c', `web_search="${caps.externalNetwork === 'on' ? 'live' : 'disabled'}"`)) problems.push('联网搜索开关');
  for (const name of disabledMcp) if (!pair('-c', `mcp_servers.${tomlKey(name)}.enabled=false`)) problems.push(`MCP「${name}」未关闭`);
  return problems;
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
  /** 列出用户配置的 MCP 服务器名称（默认通过官方 app-server 的 config/read，只取名称）。测试中可注入。 */
  discoverMcpServers?: (cwd: string) => Promise<string[]>;
  /** thread/start 之后、开始回合之前，等待 MCP 启动通知的时间（毫秒）。默认 1500。 */
  mcpSettleMs?: number;
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

  /**
   * 只读取名称：用一个临时的 app-server 调官方 `config/read`（只取 mcp_servers 的键），随即关闭。
   * 不能用 `codex mcp list`：它还会列出插件自带的服务器，而对“用户配置里并不存在”的名字写 enabled=false 会让 app-server 无法启动（已实测）。
   * 配置内容（可能含环境变量等敏感项）只在内存里取键，不记录、不转发。
   */
  private async discoverMcpServers(cwd: string): Promise<string[]> {
    if (this.options.discoverMcpServers) return this.options.discoverMcpServers(cwd);
    const env = { ...hostEnv(), ...this.options.env };
    return new Promise<string[]>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, [...this.prefix, 'app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'apps'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (e) {
        reject(Object.assign(e as Error, { spawnError: true }));
        return;
      }
      let settled = false;
      let buf = '';
      let nextId = 1;
      const waiting = new Map<number, (m: RpcMessage) => void>();
      const end = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        fn();
      };
      const timer = setTimeout(() => end(() => reject(new Error('读取 Codex 配置超时'))), 30_000);
      const rpc = (method: string, params: object) =>
        new Promise<RpcMessage>((res) => {
          const id = nextId++;
          waiting.set(id, res);
          child.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
        });
      child.on('error', (err) => end(() => reject(Object.assign(err, { spawnError: true }))));
      child.on('close', () => end(() => reject(new Error('读取 Codex 配置时 app-server 提前退出'))));
      child.stdin?.on('error', () => {});
      child.stdout?.setEncoding('utf8').on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const m = JSON.parse(line) as RpcMessage;
            if (m.id !== undefined && !m.method) waiting.get(m.id as number)?.(m);
          } catch {}
        }
      });
      (async () => {
        await rpc('initialize', { clientInfo: { name: 'ai_solo_studio', title: 'AI Solo Studio', version: '0.3.0' } });
        child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        const r = await rpc('config/read', { includeLayers: false, cwd });
        if (r.error) throw new Error(r.error.message ?? 'config/read 失败');
        const servers = (r.result as { config?: { mcp_servers?: Record<string, unknown> } } | undefined)?.config?.mcp_servers ?? {};
        end(() => resolve(Object.keys(servers)));
      })().catch((e: Error) => end(() => reject(e)));
    });
  }

  /** 官方方式关不掉的用户级扩展：只检查文件/目录是否存在，绝不读取内容。 */
  private unisolatable(): string[] {
    const home = this.options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const notes: string[] = [];
    if (fs.existsSync(path.join(home, 'AGENTS.override.md')) || fs.existsSync(path.join(home, 'AGENTS.md'))) {
      notes.push('检测到用户级 AGENTS.md：Codex 没有官方方式在会话中关闭它，它可能影响 AI 的行为。');
    }
    if (fs.existsSync(path.join(home, 'skills'))) {
      notes.push('检测到用户级技能（skills）：Codex 没有官方的单次会话关闭方式，AI 可能按需读取它们。');
    }
    return notes;
  }

  /**
   * 体检用的启动前自检（只读，不启动任务）：读取用户配置里的 MCP 名称（官方 config/read），
   * 按默认能力构建与任务相同的启动参数，再跑 selfCheckLaunch。返回问题清单；读取配置失败则抛错（调用方显示“未知”）。
   */
  async preflight(cwd: string): Promise<{ problems: string[]; mcpServers: string[] }> {
    const configured = await this.discoverMcpServers(cwd);
    const caps = resolveCapabilities();
    const cfg = codexLaunchConfig(cwd, { mcpServers: configured, capabilities: caps });
    return { problems: selfCheckLaunch(cfg, caps, configured), mcpServers: configured };
  }

  async detect(): Promise<DetectResult> {
    const cwd = process.cwd();
    const env = { ...hostEnv(), ...this.options.env };
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
    const verified = !version || version.includes(VERIFIED_CODEX_VERSION);
    const notes = [text ? text.split('\n').at(-1)! : '', verified ? '' : `未经验证的 Codex 版本（本应用验证过的是 ${VERIFIED_CODEX_VERSION}），可能不兼容。`].filter(Boolean);
    return { installed: true, loggedIn, ...(version ? { version } : {}), verified, ...(this.unisolatable().length ? { isolationNotes: this.unisolatable() } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
  }

  start(opts: StartOptions): ExecutorRun {
    const ch = new Channel<ExecutorEvent>();
    let cwd = opts.cwd;
    try {
      cwd = fs.realpathSync(opts.cwd);
    } catch {}
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
    let abortedForIsolation = false;
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
      if (note) ch.push({ type: 'message', text: note, source: 'host' });
      if (denied.length) ch.push({ type: 'message', source: 'host', text: `有 ${denied.length} 项操作被拒绝，没有执行：${denied.map((d) => d.description.split('\n').at(-1)).join('；')}` });
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
      } else if (m.method === 'account/chatgptAuthTokens/refresh') {
        // 该请求要求客户端把 accessToken 交还给 Codex（schema：response.required = accessToken、chatgptAccountId），
        // 属于“外部宿主管理令牌”模式，且官方标注 FOR OPENAI INTERNAL USE ONLY。我们不接触凭证，保持拒绝。
        write({ id: m.id, error: { code: -32601, message: 'AI Solo Studio does not manage or supply credentials' } });
        ch.push({ type: 'log', stream: 'stderr', text: '已拒绝令牌刷新请求：本应用不接触登录凭证。\n' });
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

    const caps = resolveCapabilities(opts.capabilities);
    const granted = new Set(caps.grantedMcp);
    const leaked = new Set<string>();
    const mcpBreach = (name: string) => {
      if (granted.has(name) || leaked.has(name) || finished) return;
      leaked.add(name);
      abortedForIsolation = true;
      declineAllPending();
      finish({ kind: 'exited', code: 1 }, `隔离失败：MCP 服务器“${name}”仍然启动了（未被授予，应当关闭）。为避免外部工具进入任务，已中止。`);
      terminate();
    };

    const onNotification = (m: RpcMessage) => {
      const p = m.params ?? {};
      switch (m.method) {
        case 'turn/started':
          turnId = p.turn?.id ?? turnId;
          break;
        case 'mcpServer/startupStatus/updated':
          // 我们已逐个关闭了用户的 MCP 服务器；只要仍有服务器进入启动流程，就说明隔离没有生效，必须中止（不得静默继续）。
          if (p.status === 'starting' || p.status === 'ready') mcpBreach(String(p.name ?? '?'));
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
    const launch = (configured: string[]) => {
    // 启动前构建：未被授予的 MCP 全部关闭；授予的必须真的存在于用户配置里
    const missing = caps.grantedMcp.filter((n) => !configured.includes(n));
    const disabledMcp = configured.filter((n) => !granted.has(n));
    const cfg = codexLaunchConfig(cwd, { ...(opts.model ? { model: opts.model } : {}), mcpServers: disabledMcp, capabilities: caps });
    // 启动前自检：任何一项无法确认，就不启动进程
    const problems = [...missing.map((n) => `授予的 MCP「${n}」不在用户配置中`), ...selfCheckLaunch(cfg, caps, disabledMcp)];
    if (problems.length) {
      finish({ kind: 'exited', code: 1 }, `隔离无法确认：${problems.join('；')}。任务未开始。`);
      return;
    }
    try {
      child = spawn(this.command, [...this.prefix, ...cfg.args], {
        cwd,
        env: { ...hostEnv(), ...this.options.env },
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

      const verifyEffective = async (t: any): Promise<string[]> => {
        const bad: string[] = [];
        let nonOfficial: string[] = [];
        if (t?.approvalPolicy !== cfg.expected.approvalPolicy) bad.push(`命令审批策略（实际：${JSON.stringify(t?.approvalPolicy)}）`);
        if (t?.sandbox?.type !== cfg.expected.sandboxType) bad.push(`沙箱类型（实际：${JSON.stringify(t?.sandbox?.type)}）`);
        // 网络：只在“关闭”时核验（开启时线程级响应无法反映回合级的放行）
        if (cfg.expected.sandboxType === 'workspaceWrite' && cfg.expected.networkAccess === false && t?.sandbox?.networkAccess !== false) bad.push('外部网络未关闭');
        try {
          const c = (await request('config/read', { includeLayers: false, cwd })) ?? {};
          const conf = c.config ?? {};
          if (!Array.isArray(conf.notify) || conf.notify.length !== 0) bad.push('notify 未关闭');
          if (conf.features?.hooks !== false) bad.push('hooks 未关闭');
          if (conf.features?.memories !== false || conf.memories?.use_memories !== false || conf.memories?.generate_memories !== false) bad.push('memories 未关闭');
          if (conf.allow_login_shell !== false) bad.push('登录 shell 未关闭');
          const servers = conf.mcp_servers ?? {};
          for (const [name, v] of Object.entries<any>(servers)) if (!granted.has(name) && v?.enabled !== false) bad.push(`MCP「${name}」未关闭`);
          for (const g of caps.grantedMcp) if (!(g in servers)) bad.push(`授予的 MCP「${g}」不在配置中`);
          // 模型服务地址：只读提供方名称与地址（取到“源”，丢弃路径与用户信息），绝不读取密钥
          nonOfficial = nonOfficialEndpoints(t, conf);
        } catch (e) {
          bad.push(`无法读取实际生效的配置（${(e as Error).message}）`);
        }
        try {
          const h = await request('hooks/list', { cwds: [cwd] });
          const n = ((h?.data ?? []) as { hooks?: unknown[] }[]).reduce((k, x) => k + (x.hooks?.length ?? 0), 0);
          if (n > 0) bad.push(`仍有 ${n} 个 hook 生效`);
        } catch (e) {
          bad.push(`无法读取 hooks 列表（${(e as Error).message}）`);
        }
        const warnings: string[] = [];
        if (nonOfficial.length) {
          const w = `数据将发往非官方地址：${nonOfficial.join('、')}`;
          if (caps.nonOfficialModelEndpoint === 'allow') warnings.push(w);
          else bad.push(`${w}（默认拒绝；需要在任务能力中显式允许）`);
        }
        if (!bad.length) {
          ch.push({
            type: 'isolation',
            info: {
              model: typeof t?.model === 'string' ? t.model : undefined,
              instructionSources: Array.isArray(t?.instructionSources) ? t.instructionSources.map(String) : Object.values(t?.instructionSources ?? {}).map(String),
              approvalPolicy: t.approvalPolicy,
              sandbox: t.sandbox?.type,
              grantedMcp: caps.grantedMcp,
              modelProvider: typeof t?.modelProvider === 'string' ? t.modelProvider : undefined,
              warnings,
            },
          });
        }
        return bad;
      };

      (async () => {
        await request('initialize', { clientInfo: { name: 'ai_solo_studio', title: 'AI Solo Studio', version: '0.3.0' } });
        write({ method: 'initialized', params: {} });
        const t = await request('thread/start', cfg.threadStart);
        threadId = t?.thread?.id;
        if (!threadId) throw new Error('app-server 没有返回线程 ID');
        if (stopRequested || timedOut) return;
        // 启动后核验：以 app-server 报告的实际生效值为准，任何一项无法确认都不开始回合
        const unverified = await verifyEffective(t);
        if (unverified.length) {
          if (!finished) finish({ kind: 'exited', code: 1 }, `隔离无法确认：${unverified.join('；')}。任务未开始。`);
          return;
        }
        // 等待 MCP 启动通知：此时仍有服务器启动则 mcpBreach 会中止任务
        await new Promise((r) => timers.push(setTimeout(r, this.options.mcpSettleMs ?? 1500)));
        if (abortedForIsolation || finished || stopRequested || timedOut) return;
        const r = await request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }], ...cfg.turnOverrides });
        turnId = r?.turn?.id ?? turnId;
        if (stopRequested || timedOut) interrupt();
      })().catch((e: Error) => {
        if (!finished && !stopRequested && !timedOut) finish({ kind: 'exited', code: 1 }, `无法启动 Codex 任务：${e.message}`);
      });
    }

    };

    // 先（只读地）查出用户配置了哪些 MCP 服务器，再带着“逐个关闭”的参数启动。查不出来就不启动：宁可失败，也不让用户的外部工具悄悄进入会话。
    (async () => {
      let names: string[];
      try {
        names = await this.discoverMcpServers(cwd);
      } catch (e) {
        if ((e as { spawnError?: boolean }).spawnError) {
          if (!finished) finish({ kind: 'spawn_error', message: (e as Error).message });
          return;
        }
        if (!finished) finish({ kind: 'exited', code: 1 }, `无法确认用户配置的 MCP 服务器，为保证隔离已中止：${(e as Error).message}`);
        return;
      }
      if (finished) return; // 启动前已被停止
      launch(names);
    })();

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
        if (!child) finish({ kind: 'stopped' }); // 还没启动进程（正在查 MCP 配置）：直接结束，之后不会再启动
        else interrupt();
        await done;
      },
    };
  }
}
