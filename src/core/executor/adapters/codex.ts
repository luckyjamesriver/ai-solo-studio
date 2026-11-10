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
import { readOnlyLaunch } from './codex-readonly.js';
import type { SandboxCommandRunner, SandboxExecRequest, SandboxExecResult } from '../../checks/scripts.js';
import { buildFullTrustMode, buildStandardMode, effectivePermissionsOf, sensitiveFallbackList, verifyEffectivePermissions, type EffectivePermissions, type FullTrustRecords, type ModeExpectation } from '../modes.js';

type PermissionLaunch = Pick<ReturnType<typeof buildStandardMode>, 'args' | 'threadStart' | 'turnOverrides' | 'describe'> & { expected: ModeExpectation };

/**
 * Codex 适配器：通过 `codex app-server`（stdio，换行分隔的 JSON-RPC）驱动。
 * 协议与行为以 spikes/codex/ 的实测和 `codex app-server generate-json-schema` 生成的 schema 为准。
 * app-server 被官方标注为 experimental，协议可能变化。
 */

export interface CodexLaunchConfig {
  /** `codex app-server` 的命令行参数（不含可执行文件本身） */
  args: string[];
  /** thread/start 的参数 */
  threadStart: Record<string, unknown>;
  /** turn/start 中每个回合都再次显式声明的参数（不依赖线程或用户配置的默认值） */
  turnOverrides: Record<string, unknown>;
  /** 期望在 thread/start 响应里看到的实际生效值（启动后核验用） */
  expected: ModeExpectation;
  /** 人读摘要：本次启动配置的权限（写入任务记录） */
  describe: string;
}

/** 能力 → 权限启动参数（单点定义，便于测试）。完全信任需要异步门禁，必须由调用方先构建后经 opts.launch 传入。 */
export function permissionLaunchFor(cwd: string, c: Capabilities): PermissionLaunch {
  if (c.fileAccess === 'worktree_read_only') return readOnlyLaunch(cwd);
  if (c.constructionMode === 'full_trust') throw new Error('完全信任模式必须先通过 buildFullTrustMode（任务级确认门禁）。');
  return buildStandardMode({
    cwd,
    extraWritable: c.extraWritableDirs,
    network: c.externalNetwork === 'on',
    allowedDomains: c.allowedNetworkDomains,
    denyRead: standardDenyList(cwd, c.extraWritableDirs),
  });
}

/**
 * 标准模式的读取拒绝清单：固定敏感清单。B3-1 实测：整个主目录 deny 在 macOS 上会让 node（lstat 主目录）与 git（~/.gitconfig）失效，
 * 无法用于真实项目，所以不作为默认（原因与证据见 modes.ts 与 B3-1 报告）。
 */
export function standardDenyList(_cwd: string, _extra: string[]): string[] {
  return sensitiveFallbackList();
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
export function codexLaunchConfig(cwd: string, opts: { model?: string; mcpServers?: string[]; capabilities?: Partial<Capabilities>; launch?: PermissionLaunch } = {}): CodexLaunchConfig {
  const caps = resolveCapabilities(opts.capabilities);
  const m = opts.launch ?? permissionLaunchFor(cwd, caps);
  return {
    expected: m.expected,
    describe: m.describe,
    args: [
      'app-server',
      '--listen',
      'stdio://',
      // 权限（权限配置档或思考层的只读参数）：不再有旧式沙箱配置键与它并用
      ...m.args,
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
    threadStart: { ...m.threadStart, ephemeral: true, ...(opts.model ? { model: opts.model } : {}) },
    turnOverrides: { ...m.turnOverrides },
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
  const exp = cfg.expected;
  // 审批策略：线程与回合各声明一次，且等于期望
  if (cfg.threadStart.approvalPolicy !== exp.approvalPolicy || (cfg.turnOverrides as { approvalPolicy?: unknown }).approvalPolicy !== exp.approvalPolicy) problems.push('命令审批策略');
  const cfgArgs = a.filter((_, i) => a[i - 1] === '-c');
  const hasLegacy = cfgArgs.some((x) => /^sandbox_mode\s*=/.test(x));
  const hasProfile = cfgArgs.some((x) => /^default_permissions\s*=/.test(x));
  if (hasLegacy && hasProfile) problems.push('旧式沙箱配置与权限配置档不能并用');
  if (exp.mode === 'standard') {
    if (!hasProfile) problems.push('权限配置档（default_permissions）');
    if (hasLegacy) problems.push('标准模式不得使用旧式沙箱配置');
    if (!cfgArgs.some((x) => x.startsWith(`permissions.${exp.profileId}=`))) problems.push('权限配置档内容（permissions.<id>）');
    if (cfg.threadStart.sandbox !== undefined || (cfg.turnOverrides as { sandboxPolicy?: unknown }).sandboxPolicy !== undefined) problems.push('标准模式不得再传旧式 sandbox / sandboxPolicy');
    // 可写根只能是任务副本与用户选定的额外目录：权限配置档里出现的 =“write” 条目必须正是这些路径
    const profile = cfgArgs.find((x) => x.startsWith('permissions.')) ?? '';
    const writes = [...profile.matchAll(/"((?:[^"\\]|\\.)*)"="write"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
    const allowed = new Set([String(cfg.threadStart.cwd), ...caps.extraWritableDirs]);
    for (const w of writes) if (!allowed.has(w)) problems.push(`可写根（只能是任务副本与额外目录）：${w}`);
    if (!writes.includes(String(cfg.threadStart.cwd))) problems.push('可写根缺少任务副本');
    if (exp.networkEnabled !== (caps.externalNetwork === 'on')) problems.push('外部网络开关');
    if (/network=\{enabled=true/.test(profile) !== exp.networkEnabled) problems.push('权限配置档中的网络开关');
  } else if (exp.mode === 'read_only') {
    if (!pair('-c', 'sandbox_mode="read-only"')) problems.push('只读沙箱');
  } else {
    if (hasLegacy || hasProfile) problems.push('完全信任模式不应带任何权限配置');
    // 完全信任的沙箱参数只由 modes.ts 的完全信任分支产生；这里只确认它确实带着（具体取值由启动后的生效沙箱核验）
    if (typeof cfg.threadStart.sandbox !== 'string') problems.push('线程沙箱');
  }
  for (const f of ['hooks', 'memories', 'multi_agent', 'remote_plugin', 'shell_snapshot', 'plugins', 'apps']) if (!pair('--disable', f)) problems.push(`扩展 ${f} 未关闭`);
  for (const kv of ['notify=[]', 'memories.use_memories=false', 'memories.generate_memories=false', 'allow_login_shell=false', 'shell_environment_policy.inherit="core"', 'instructions=""', 'developer_instructions=""']) {
    if (!pair('-c', kv)) problems.push(`配置项 ${kv.split('=')[0]}`);
  }
  if (!pair('-c', `web_search="${caps.externalNetwork === 'on' ? 'live' : 'disabled'}"`)) problems.push('联网搜索开关');
  for (const name of disabledMcp) if (!pair('-c', `mcp_servers.${tomlKey(name)}.enabled=false`)) problems.push(`MCP「${name}」未关闭`);
  return problems;
}

const NO_RECORDS: FullTrustRecords = { get: async () => undefined };

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

  /**
   * 项目脚本的沙箱运行器：用 app-server 的 command/exec，在与施工相同的权限配置档（及同一套隔离参数）下运行一条命令。
   * 任何一步无法确认（读不到 MCP 名单、自检不过、生效权限与期望不一致、进程起不来）→ unavailable，调用方标“未检查”；
   * 绝不在宿主上直接运行。
   */
  readonly sandboxRunner: SandboxCommandRunner = { runCommand: (req) => this.execInSandbox(req) };

  private async execInSandbox(req: SandboxExecRequest): Promise<SandboxExecResult> {
    let cwd = req.cwd;
    try {
      cwd = fs.realpathSync(req.cwd);
    } catch {}
    const started = Date.now();
    let caps: Capabilities;
    let launch: PermissionLaunch | undefined;
    try {
      caps = resolveCapabilities(req.capabilities);
      if (caps.constructionMode === 'full_trust' && caps.fileAccess !== 'worktree_read_only') launch = await buildFullTrustMode(req.taskId ?? '', cwd, req.fullTrustRecords ?? NO_RECORDS);
    } catch (e) {
      return { status: 'unavailable', reason: (e as Error).message };
    }
    let names: string[];
    try {
      names = await this.discoverMcpServers(cwd);
    } catch (e) {
      return { status: 'unavailable', reason: `无法确认用户配置的 MCP 服务器：${(e as Error).message}` };
    }
    let cfg: CodexLaunchConfig;
    try {
      cfg = codexLaunchConfig(cwd, { mcpServers: names, capabilities: caps, ...(launch ? { launch } : {}) });
    } catch (e) {
      return { status: 'unavailable', reason: (e as Error).message };
    }
    const problems = selfCheckLaunch(cfg, caps, names);
    if (problems.length) return { status: 'unavailable', reason: `权限配置无法确认：${problems.join('；')}` };

    return new Promise<SandboxExecResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, [...this.prefix, ...cfg.args], { cwd, env: { ...hostEnv(), ...this.options.env }, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (e) {
        resolve({ status: 'unavailable', reason: (e as Error).message });
        return;
      }
      let settled = false;
      let buf = '';
      let nextId = 1;
      const waiting = new Map<number, (m: RpcMessage) => void>();
      const end = (r: SandboxExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(r);
      };
      // 整体兜底：命令超时之外再留出启动与核验的时间
      const timer = setTimeout(() => end({ status: 'ran', exitCode: null, stdout: '', stderr: '', timedOut: true, durationMs: Date.now() - started }), req.timeoutMs + 30_000);
      const rpc = (method: string, params: object) =>
        new Promise<RpcMessage>((res) => {
          const id = nextId++;
          waiting.set(id, res);
          child.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
        });
      child.on('error', (err) => end({ status: 'unavailable', reason: err.message }));
      child.on('close', () => end({ status: 'unavailable', reason: '受限运行环境（app-server）提前退出' }));
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
            if (m.id !== undefined && m.method) {
              // 不应有任何服务端请求（无回合、无审批）：一律拒绝
              child.stdin?.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: 'unsupported by AI Solo Studio' } })}\n`);
            } else if (m.id !== undefined) waiting.get(m.id as number)?.(m);
          } catch {}
        }
      });
      (async () => {
        await rpc('initialize', { clientInfo: { name: 'ai_solo_studio', title: 'AI Solo Studio', version: '0.3.0' } });
        child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        // 先建一个临时线程，只为拿到“实际生效的权限”并与期望核验（不发起任何回合、不调用模型）
        const t = await rpc('thread/start', cfg.threadStart);
        if (t.error) return end({ status: 'unavailable', reason: `无法建立受限环境：${t.error.message ?? '未知错误'}` });
        const bad = verifyEffectivePermissions(cfg.expected, t.result);
        if (bad.length) return end({ status: 'unavailable', reason: `生效权限与期望不一致：${bad.join('；')}` });
        const r = await rpc('command/exec', { command: req.argv, cwd, env: req.env, timeoutMs: req.timeoutMs });
        if (r.error) return end({ status: 'unavailable', reason: `受限环境无法运行命令：${r.error.message ?? '未知错误'}` });
        const res = (r.result ?? {}) as { exitCode?: number | null; stdout?: string; stderr?: string };
        // command/exec 没有单独的“超时”字段：以“耗时已达上限且没有以 0 退出”判定为超时（保守：宁可报超时也不报成功）
        const timedOut = Date.now() - started >= req.timeoutMs && res.exitCode !== 0;
        end({ status: 'ran', exitCode: typeof res.exitCode === 'number' ? res.exitCode : null, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut, durationMs: Date.now() - started });
      })().catch((e: Error) => end({ status: 'unavailable', reason: e.message }));
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
    /** 施工模式下收到的（不应出现的）审批请求 */
    const anomalies: string[] = [];
    /** 当前启动是否为施工模式（标准 / 完全信任）；思考层的只读启动为 false */
    let constructionMode = false;
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
      if (anomalies.length) ch.push({ type: 'message', source: 'host', text: `异常：施工模式不应出现审批请求，但收到了 ${anomalies.length} 次（均已拒绝）。` });
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

    /**
     * 施工模式（标准 / 完全信任）下审批策略是 never，理论上不会收到任何审批请求。
     * 万一收到：一律拒绝（只回 decline，绝不回任何“以后都允许”类决定），记为异常并如实带进验收卡。
     */
    const rejectUnexpectedApproval = (m: RpcMessage) => {
      const p = m.params ?? {};
      const isCmd = m.method === 'item/commandExecution/requestApproval';
      write({ id: m.id, result: { decision: 'decline' } });
      const what = isCmd ? `命令：${parseCommand(String(p.command ?? '')).inner || String(p.command ?? '')}` : `修改文件：${(fileItems.get(String(p.itemId)) ?? []).map((c) => c.path).join('、') || '（未提供文件列表）'}`;
      anomalies.push(what);
      const op: DeniedOperation = { kind: isCmd ? 'run_command' : 'write_file', ...(isCmd ? { command: parseCommand(String(p.command ?? '')).argv } : {}), description: `异常的审批请求（施工模式不应出现，已拒绝）：${what}`, risk: 'high', anomaly: true };
      denied.push(op);
      ch.push({ type: 'blocked', operation: op });
      ch.push({ type: 'log', stream: 'stderr', text: `异常：施工模式下收到审批请求，已拒绝。${what}\n` });
    };

    const onServerRequest = (m: RpcMessage) => {
      const p = m.params ?? {};
      if (constructionMode && (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval')) {
        rejectUnexpectedApproval(m);
      } else if (m.method === 'item/commandExecution/requestApproval') {
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
    const launch = (configured: string[], fullTrustLaunch?: PermissionLaunch) => {
    // 启动前构建：未被授予的 MCP 全部关闭；授予的必须真的存在于用户配置里
    const missing = caps.grantedMcp.filter((n) => !configured.includes(n));
    const disabledMcp = configured.filter((n) => !granted.has(n));
    const cfg = codexLaunchConfig(cwd, { ...(opts.model ? { model: opts.model } : {}), mcpServers: disabledMcp, capabilities: caps, ...(fullTrustLaunch ? { launch: fullTrustLaunch } : {}) });
    constructionMode = cfg.expected.mode !== 'read_only';
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
        // 生效权限核验：以 thread/start 响应的 approvalPolicy、activePermissionProfile、网络状态为准，与期望逐项比对
        const bad: string[] = [...verifyEffectivePermissions(cfg.expected, t)];
        let nonOfficial: string[] = [];
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
              permissions: effectivePermissionsOf(cfg.expected, t, cfg.describe),
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
      // 完全信任：先过任务级确认门禁（没有本任务的确认标记就不启动任何进程）
      let fullTrustLaunch: PermissionLaunch | undefined;
      if (caps.fileAccess !== 'worktree_read_only' && caps.constructionMode === 'full_trust') {
        try {
          fullTrustLaunch = await buildFullTrustMode(opts.taskId ?? '', cwd, opts.fullTrustRecords ?? NO_RECORDS);
        } catch (e) {
          if (!finished) finish({ kind: 'exited', code: 1 }, `完全信任模式未获确认，任务未开始：${(e as Error).message}`);
          return;
        }
      }
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
      launch(names, fullTrustLaunch);
    })();

    return {
      events: ch,
      /** 执行体进程号（进程启动后才有）；任务记录据此在启动核对时判断执行体是否还在运行 */
      get pid(): number | undefined {
        return child?.pid;
      },
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
