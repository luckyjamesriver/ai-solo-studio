import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecutor, type CodexOptions } from '../executor/adapters/codex.js';
import { resolveCapabilities } from '../capabilities/model.js';
import { classifyServiceError } from './errors.js';
import { buildThinkPrompt, parseStructured } from './prompt.js';
import type { ThinkRequest, ThinkResult, Thinker, ThinkerDetect } from './types.js';

/**
 * CodexThinker（ChatGPT）：复用 Codex app-server 与已有隔离。
 * - 能力：文件只读（沙箱 read-only）、命令每次询问（untrusted）、网络关闭、不授予凭证、不授予任何 MCP；
 *   全部用户扩展关闭、启动前自检与启动后核验照常执行（任何一项无法确认 → 不开始，返回 failed）；
 * - 工作目录：一个全新的空临时目录，用完即删；
 * - 思考者不该请求工具：收到任何审批请求一律拒绝并记录，工具调用事件也记录（refusedToolRequests）。
 */
export class CodexThinker implements Thinker {
  readonly id = 'codex';
  readonly displayName = 'ChatGPT（Codex）';
  readonly service = 'OpenAI（ChatGPT / Codex）';
  private readonly executor: CodexExecutor;

  constructor(private readonly options: CodexOptions & { model?: string } = {}) {
    this.executor = new CodexExecutor(options);
  }

  async detect(): Promise<ThinkerDetect> {
    const d = await this.executor.detect();
    if (!d.installed) return { available: false, note: d.note ?? '没有找到 Codex。' };
    if (d.loggedIn === 'no') return { available: false, note: '尚未登录 Codex。' };
    return {
      available: true,
      ...(d.note || d.isolationNotes?.length ? { note: [d.note, ...(d.isolationNotes ?? [])].filter(Boolean).join(' ') } : {}),
      ...(d.isolationNotes?.length ? { unconfirmed: d.isolationNotes } : {}),
    };
  }

  async think(req: ThinkRequest): Promise<ThinkResult> {
    const { prompt, sent } = buildThinkPrompt(req);
    const base = { sent, service: this.service };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-think-'));
    try {
      const run = this.executor.start({
        cwd,
        prompt,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
        capabilities: resolveCapabilities({ fileAccess: 'worktree_read_only', externalNetwork: 'off', grantedMcp: [] }),
      });
      const messages: string[] = []; // AI 的话
      const hostNotes: string[] = []; // 适配器的说明（如隔离失败原因）
      const logs: string[] = [];
      const refused: string[] = [];
      let exit: import('../executor/types.js').ExitOutcome | undefined;
      let model: string | undefined;
      for await (const e of run.events) {
        if (e.type === 'message') (e.source === 'host' ? hostNotes : messages).push(e.text);
        else if (e.type === 'log') logs.push(e.text);
        else if (e.type === 'tool') refused.push(`${e.name}: ${e.summary}`);
        else if (e.type === 'isolation') model = e.info.model;
        else if (e.type === 'permission_request') {
          refused.push(`${e.request.kind}: ${e.request.description.split('\n').at(-1)}`);
          await run.respond(e.request.id, 'deny');
        } else if (e.type === 'exit') exit = e.outcome;
      }
      const rawText = messages.at(-1) ?? '';
      const diag = [...messages, ...hostNotes, ...logs].join('\n');
      const extra = refused.length ? { refusedToolRequests: refused } : {};
      const common = { ...base, rawText, ...(model ? { model } : {}), ...extra };
      if (exit?.kind === 'timed_out') return { ...common, status: 'timeout', error: '思考超时' };
      if (exit?.kind !== 'exited' || exit.code !== 0) {
        const cls = classifyServiceError(diag);
        return { ...common, status: cls ?? 'failed', error: hostNotes.at(-1) ?? messages.at(-1) ?? (exit ? `执行体结束方式：${exit.kind}` : '没有结束事件') };
      }
      const parsed = parseStructured(rawText, req.output);
      if (!parsed.ok) return { ...common, status: 'incomplete', error: parsed.error };
      return { ...common, status: 'complete', content: parsed.content };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}
