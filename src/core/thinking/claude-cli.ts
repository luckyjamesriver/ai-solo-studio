import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../proc/run.js';
import { classifyServiceError } from './errors.js';
import { buildThinkPrompt, parseStructured } from './prompt.js';
import type { ThinkRequest, ThinkResult, Thinker, ThinkerDetect } from './types.js';

/**
 * ClaudeCliThinker——开发者自用模式（ADR 0002 补充）。
 * 仅当环境变量 STUDIO_DEV_PERSONAL_CLAUDE=1 且不是打包后的应用时可用；没有界面开关；
 * 只启动未经修改的 `claude` 二进制，由它使用本机自己的登录。绝不读取、复制或转发任何登录凭证。
 *
 * 官方参数（Claude Code 2.1.x；文档：https://code.claude.com/docs/en/headless 与 /cli-reference）：
 * - `-p`（非交互）+ `--output-format stream-json --verbose`：逐行 JSON；`system/init` 报告 tools / mcp_servers / skills /
 *   slash_commands，`result` 事件含 is_error / subtype / result / usage / modelUsage / total_cost_usd；
 * - `--tools ""`：“Use "" to disable all”，禁用全部内置工具；
 * - `--safe-mode`：禁用 CLAUDE.md、skills、plugins、hooks、MCP 服务器等一切自定义，认证与模型照常（注意：另一个“精简模式”开关不会读取 OAuth 登录，所以不用）；
 * - `--strict-mcp-config`：只使用 --mcp-config 给的 MCP（我们不给）；`--disable-slash-commands`：禁用 skills 与命令；
 * - `--no-session-persistence`：不落盘会话；`--max-turns 1`：只允许一轮；
 * - 提示词走标准输入（不放进命令行参数）；
 * - 不使用任何跳过权限的参数（没有工具，也就没有需要放行的操作）。
 * - 子进程环境移除 ANTHROPIC_API_KEY：存在时 `-p` 总会改用该密钥计费（env-vars 文档），自用模式要走本机订阅登录。
 * 实测（2.1.318）：基线下 --settings 注入的 SessionStart/UserPromptSubmit hook 会执行、工作目录里的 CLAUDE.md 会生效；
 * 加 --safe-mode 后二者都不生效；init 里 tools/mcp_servers/skills/slash_commands 均为空。
 */
export const DEV_PERSONAL_ENV = 'STUDIO_DEV_PERSONAL_CLAUDE';

export interface ClaudeCliOptions {
  command?: string;
  /** 放在 claude 参数之前的参数（测试中用来传脚本路径） */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * 是否为打包后的应用。src/main 中的任何构造点必须显式传入（可直接传 app.isPackaged；tests/security.test.ts 扫描 src/main 强制）。
   * 仅在未传入时才回退到启发式：在 Electron 内且不是 `electron .` 开发启动即视为已打包。
   */
  isPackaged?: boolean | (() => boolean);
  model?: string;
  timeoutMs?: number;
}

const defaultIsPackaged = () => !!process.versions.electron && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;

/** 生成 claude 命令行参数（不含提示词——提示词走标准输入）。导出以便测试。 */
export function claudeCliArgs(opts: { model?: string } = {}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns',
    '1',
    ...(opts.model ? ['--model', opts.model] : []),
  ];
}

export class ClaudeCliThinker implements Thinker {
  readonly id = 'claude-cli-personal';
  readonly displayName = 'Claude（本机登录，开发者自用）';
  readonly service = 'Anthropic（Claude，经本机 claude CLI 的登录）';

  constructor(private readonly options: ClaudeCliOptions = {}) {}

  private get prefix() {
    return this.options.prefixArgs ?? [];
  }
  private get command() {
    return this.options.command ?? 'claude';
  }
  private env(): NodeJS.ProcessEnv {
    const e = { ...process.env, ...this.options.env };
    delete e.ANTHROPIC_API_KEY;
    return e;
  }
  /** 开关逻辑：返回不可用的原因；可用返回 undefined。 */
  private disabledReason(): string | undefined {
    const flag = (this.options.env ?? process.env)[DEV_PERSONAL_ENV];
    const p = this.options.isPackaged;
    if ((typeof p === 'boolean' ? p : (p ?? defaultIsPackaged)()) === true) return '打包后的应用中不可用：本机登录自用模式只用于开发者自己开发，面向其他用户的版本只支持 API Key。';
    if (flag !== '1') return `未开启：这是开发者自用模式，需要设置环境变量 ${DEV_PERSONAL_ENV}=1（默认关闭，没有界面开关）。`;
    return undefined;
  }

  async detect(): Promise<ThinkerDetect> {
    const off = this.disabledReason();
    if (off) return { available: false, note: off };
    const cwd = os.tmpdir();
    const v = await run(this.command, [...this.prefix, '--version'], { cwd, env: this.env(), timeoutMs: 20_000, killGraceMs: 500 });
    if (v.outcome.kind !== 'exited' || v.outcome.code !== 0) return { available: false, note: '没有找到可运行的 claude 命令。' };
    // 只看退出码（0=已登录），输出不读取、不记录
    const s = await run(this.command, [...this.prefix, 'auth', 'status'], { cwd, env: this.env(), timeoutMs: 20_000, killGraceMs: 500 });
    if (!(s.outcome.kind === 'exited' && s.outcome.code === 0)) return { available: false, note: 'claude 尚未登录（请在终端运行 claude 并登录）。' };
    return {
      available: true,
      note: '开发者自用模式：使用本机 claude 的登录。',
      unconfirmed: ['init 事件的 plugins 字段仍列出已安装插件：--safe-mode 文档称其禁用插件，但无法从输出确认它们没有被加载', '用户级 ~/.claude 下的记忆文件只确认了项目级 CLAUDE.md 被忽略'],
    };
  }

  async think(req: ThinkRequest): Promise<ThinkResult> {
    const { prompt, sent } = buildThinkPrompt(req);
    const base = { sent, service: this.service };
    const off = this.disabledReason();
    if (off) return { ...base, status: 'failed', rawText: '', error: off };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-think-'));
    try {
      const r = await run(this.command, [...this.prefix, ...claudeCliArgs(this.options.model ? { model: this.options.model } : {})], {
        cwd,
        env: this.env(),
        stdin: prompt,
        timeoutMs: req.timeoutMs ?? this.options.timeoutMs ?? 180_000,
        killGraceMs: 1000,
      });
      if (r.outcome.kind === 'timed_out') return { ...base, status: 'timeout', rawText: '', error: '思考超时' };
      if (r.outcome.kind === 'spawn_error') return { ...base, status: 'failed', rawText: '', error: `无法启动 claude：${r.outcome.message}` };

      let init: Record<string, any> | undefined;
      let result: Record<string, any> | undefined;
      const retryErrors: string[] = [];
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === 'system' && m.subtype === 'init') init = m;
        else if (m.type === 'system' && m.subtype === 'api_retry' && m.error) retryErrors.push(String(m.error));
        else if (m.type === 'result') result = m;
      }
      const model = typeof init?.model === 'string' ? init.model : undefined;
      const mu = result?.modelUsage && typeof result.modelUsage === 'object' ? (Object.values(result.modelUsage)[0] as Record<string, any> | undefined) : undefined;
      const usage = result
        ? {
            ...(typeof result.usage?.input_tokens === 'number' ? { inputTokens: result.usage.input_tokens } : typeof mu?.inputTokens === 'number' ? { inputTokens: mu.inputTokens } : {}),
            ...(typeof result.usage?.output_tokens === 'number' ? { outputTokens: result.usage.output_tokens } : typeof mu?.outputTokens === 'number' ? { outputTokens: mu.outputTokens } : {}),
            ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
          }
        : undefined;
      const evidence = init ? (['tools', 'mcp_servers', 'skills', 'slash_commands'] as const).map((k) => `${k}=${Array.isArray(init![k]) ? init![k].length : '?'}`).join(', ') : undefined;
      const common = { ...base, ...(evidence ? { isolationEvidence: evidence } : {}), ...(model ? { model } : {}), ...(usage && Object.keys(usage).length ? { usage } : {}) };

      // 调用后核验：实际可用的工具、MCP、技能、斜杠命令必须全部为空（无法确认 → 不把结果当正式产物）
      if (init) {
        const nonEmpty = (['tools', 'mcp_servers', 'skills', 'slash_commands'] as const).filter((k) => Array.isArray(init![k]) && init![k].length > 0);
        if (nonEmpty.length) {
          return { ...common, status: 'failed', rawText: '', error: `隔离无法确认：思考者实际带有 ${nonEmpty.join('、')}（应为空）` };
        }
        if (!(['tools', 'mcp_servers'] as const).every((k) => Array.isArray(init![k]))) {
          return { ...common, status: 'failed', rawText: '', error: '隔离无法确认：init 事件没有报告 tools / mcp_servers' };
        }
      }

      const text = typeof result?.result === 'string' ? result.result : '';
      const diag = `${text}\n${retryErrors.join('\n')}\n${r.stderr}\n${r.stdout.length < 4000 ? r.stdout : ''}`;
      if (!result || result.is_error || r.outcome.kind !== 'exited' || r.outcome.code !== 0) {
        const cls = classifyServiceError(diag);
        return { ...common, status: cls ?? 'failed', rawText: text, error: text.trim() || r.stderr.trim().slice(0, 300) || `claude 异常结束（${r.outcome.kind}）` };
      }
      if (!init) return { ...common, status: 'failed', rawText: text, error: '隔离无法确认：没有收到 init 事件' };
      const parsed = parseStructured(text, req.output);
      if (!parsed.ok) return { ...common, status: 'incomplete', rawText: text, error: parsed.error };
      return { ...common, status: 'complete', content: parsed.content, rawText: text };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}
