import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCapabilities, type Capabilities } from '../../capabilities/model.js';
import type { SandboxCommandRunner, SandboxExecRequest, SandboxExecResult } from '../../checks/scripts.js';
import { hostEnv } from '../../env/host-env.js';
import { buildFullTrustMode, sensitiveFallbackList, type FullTrustRecords } from '../modes.js';

export const DEFAULT_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const MAX_CAPTURE_BYTES = 256 * 1024;
const NO_RECORDS: FullTrustRecords = { get: async () => null };

function assertNoControlChars(p: string, label: string): void {
  if (/[\0\r\n]/.test(p)) {
    throw new Error(`${label} 包含非法控制字符。`);
  }
}

function escapeSbString(p: string): string {
  assertNoControlChars(p, '沙箱路径');
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 解析路径的规范绝对形式与（即便目标尚不存在也能穿透祖先符号链接的）真实物理路径。
 * 保证如 `/tmp/...` ↔ `/private/tmp/...`、`/var/...` ↔ `/private/var/...` 在 Seatbelt 内同时生效。
 */
export function canonicalizeSandboxPaths(inputPath: string): string[] {
  assertNoControlChars(inputPath, '沙箱路径');
  const abs = path.resolve(inputPath);
  const results = new Set<string>([abs]);

  const tail: string[] = [];
  let probe = abs;
  while (true) {
    try {
      const real = fs.realpathSync(probe);
      results.add(tail.length ? path.join(real, ...tail) : real);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  return [...results];
}

function expandSubpathClauses(paths: string[]): string {
  return paths.map((p) => `(subpath ${escapeSbString(p)})`).join(' ');
}

function isDotGitPath(p: string): boolean {
  return /(?:^|\/)\.git(?:\/|$)/.test(p.replace(/\\/g, '/'));
}

export interface SeatbeltProfileOptions {
  cwd: string;
  capabilities: Capabilities;
  denyRead?: string[];
  fullTrust?: boolean;
}

/**
 * 生成脱离 Codex 的 macOS Seatbelt (SBPL) 检查沙箱配置档：
 * - standard / 只读模式：
 *   - 拒绝读取 `sensitiveFallbackList` 中的凭证与敏感目录（经规范化路径同时拦截符号链接别名）；
 *   - 仅允许写入工作副本（`cwd`）及显式授予的 `extraWritableDirs`（以及 `/dev/null` / `/dev/dtracehelper`）；
 *   - 显式禁止写入可写根内的 `.git`；
 *   - 默认完全断网（`(deny network*)`），仅当 `externalNetwork === 'on'` 且无域名白名单限制时放行网络；
 * - fullTrust 模式（只能由 `buildFullTrustMode` 核验后进入）：放开为 `(allow default)`。
 */
export function buildSeatbeltProfile(opts: SeatbeltProfileOptions): string {
  if (opts.fullTrust) {
    return ['(version 1)', '(allow default)'].join('\n');
  }

  const caps = opts.capabilities;
  const denySources = opts.denyRead ?? sensitiveFallbackList(os.homedir());
  const denyPaths = [...new Set(denySources.flatMap((d) => canonicalizeSandboxPaths(d)))];

  const writeTargets: string[] = [];
  const gitLockTargets: string[] = [];
  if (caps.fileAccess === 'worktree_write') {
    const rawRoots = [opts.cwd, ...caps.extraWritableDirs];
    for (const root of rawRoots) {
      for (const p of canonicalizeSandboxPaths(root)) {
        if (isDotGitPath(p)) continue;
        if (!writeTargets.includes(p)) writeTargets.push(p);
        const dotGit = path.join(p, '.git');
        if (!gitLockTargets.includes(dotGit)) gitLockTargets.push(dotGit);
      }
    }
  }

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow ipc-posix*)',
    '(allow signal (target self))',
    '(allow file-read*)',
  ];

  if (denyPaths.length > 0) {
    lines.push(`(deny file-read* ${expandSubpathClauses(denyPaths)})`);
  }

  const writeLiterals = ['(literal "/dev/null")', '(literal "/dev/dtracehelper")'];
  if (writeTargets.length > 0) {
    lines.push(`(allow file-write* ${expandSubpathClauses(writeTargets)} ${writeLiterals.join(' ')})`);
  } else {
    lines.push(`(allow file-write* ${writeLiterals.join(' ')})`);
  }

  if (gitLockTargets.length > 0) {
    const gitRules = gitLockTargets
      .flatMap((g) => [`(literal ${escapeSbString(g)})`, `(subpath ${escapeSbString(g)})`])
      .join(' ');
    lines.push(`(deny file-write* ${gitRules})`);
  }

  lines.push(caps.externalNetwork === 'on' ? '(allow network*)' : '(deny network*)');
  return lines.join('\n');
}

export interface SeatbeltSandboxRunnerOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  denyRead?: string[];
}

/**
 * 脱离 Codex 的 macOS Seatbelt (`sandbox-exec`) 独立命令沙箱运行器（阶段 8C）。
 * - 任何平台不支持、二进制缺失、自检失败、未通过完整门禁或能力超限（如按域名代理过滤），
 *   一律返回 `{ status: 'unavailable', reason }`，绝不回退到无沙箱宿主直跑。
 */
export class SeatbeltSandboxRunner implements SandboxCommandRunner {
  private readonly command: string;
  private readonly extraEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly denyRead?: string[];

  constructor(opts: SeatbeltSandboxRunnerOptions = {}) {
    this.command = opts.command ?? DEFAULT_SANDBOX_EXEC_PATH;
    this.extraEnv = opts.env ?? {};
    this.platform = opts.platform ?? process.platform;
    if (opts.denyRead) this.denyRead = opts.denyRead;
  }

  private async ensureBinaryReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.platform !== 'darwin') {
      return {
        ok: false,
        reason: '独立受限检查沙箱仅支持 macOS（当前平台暂不支持无 Codex 独立沙箱）',
      };
    }
    try {
      await fsp.access(this.command, fs.constants.X_OK);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: `未检测到可用的系统沙箱命令 ${this.command}`,
      };
    }
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    const bin = await this.ensureBinaryReady();
    if (!bin.ok) return { available: false, reason: bin.reason };

    const probeProfile = [
      '(version 1)',
      '(deny default)',
      '(allow process*)',
      '(allow sysctl-read)',
      '(allow file-read*)',
      '(allow signal (target self))',
    ].join('\n');

    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { available: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child: ChildProcess;
      try {
        child = spawn(this.command, ['-p', probeProfile, '/bin/echo', 'ok'], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        done({ available: false, reason: e instanceof Error ? e.message : String(e) });
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        done({ available: false, reason: '独立沙箱自检超时' });
      }, 4000);
      let stderr = '';
      child.stderr?.setEncoding('utf8').on('data', (c: string) => {
        stderr += c;
      });
      child.on('error', (err) => done({ available: false, reason: err.message }));
      child.on('close', (code) => {
        if (code === 0) done({ available: true });
        else done({ available: false, reason: stderr.trim() || `沙箱自检退出码 ${String(code)}` });
      });
    });
  }

  async runCommand(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const started = Date.now();
    const bin = await this.ensureBinaryReady();
    if (!bin.ok) return { status: 'unavailable', reason: bin.reason };
    if (!Array.isArray(req.argv) || req.argv.length === 0 || !req.argv[0]) {
      return { status: 'unavailable', reason: '沙箱执行请求缺少命令参数' };
    }

    let cwd = req.cwd;
    try {
      cwd = fs.realpathSync(req.cwd);
    } catch {}

    let caps: Capabilities;
    let fullTrust = false;
    try {
      caps = resolveCapabilities(req.capabilities);
      if (caps.externalNetwork === 'on' && caps.allowedNetworkDomains.length > 0) {
        return {
          status: 'unavailable',
          reason: '独立检查沙箱暂不支持按域名白名单代理联网，为保证网络边界已跳过执行',
        };
      }
      if (caps.constructionMode === 'full_trust' && caps.fileAccess !== 'worktree_read_only') {
        await buildFullTrustMode(req.taskId ?? '', cwd, req.fullTrustRecords ?? NO_RECORDS);
        fullTrust = true;
      }
    } catch (e) {
      return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
    }

    let profile: string;
    try {
      profile = buildSeatbeltProfile({
        cwd,
        capabilities: caps,
        ...(this.denyRead ? { denyRead: this.denyRead } : {}),
        fullTrust,
      });
    } catch (e) {
      return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
    }

    const fallbackPath = hostEnv().PATH;
    const childEnv: NodeJS.ProcessEnv = {
      ...(fallbackPath ? { PATH: fallbackPath } : {}),
      ...req.env,
      ...this.extraEnv,
    };

    return new Promise<SandboxExecResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, ['-p', profile, ...req.argv], {
          cwd,
          env: childEnv,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ status: 'unavailable', reason: e instanceof Error ? e.message : String(e) });
        return;
      }

      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';
      let killEscalation: NodeJS.Timeout | undefined;

      const appendCap = (cur: string, chunk: string) => {
        const next = cur + chunk;
        return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
      };

      const finish = (res: SandboxExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        resolve(res);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        killEscalation = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {}
        }, 800);
      }, Math.max(50, req.timeoutMs));

      child.stdout?.setEncoding('utf8').on('data', (c: string) => {
        stdout = appendCap(stdout, c);
      });
      child.stderr?.setEncoding('utf8').on('data', (c: string) => {
        stderr = appendCap(stderr, c);
      });
      child.on('error', (err) => finish({ status: 'unavailable', reason: err.message }));
      child.on('close', (code) => {
        finish({
          status: 'ran',
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}
