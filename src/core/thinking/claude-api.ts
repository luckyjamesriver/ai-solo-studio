import { classifyServiceError } from './errors.js';
import { buildThinkPromptParts, parseStructured } from './prompt.js';
import type { ThinkRequest, ThinkResult, ThinkUsage, Thinker, ThinkerDetect } from './types.js';

/** 默认 Anthropic Messages 模型（2026-11-10 查证：https://platform.claude.com/docs/en/about-claude/models/overview）。 */
export const DEFAULT_CLAUDE_API_MODEL = 'claude-opus-5-5';

/** 当前 Anthropic API 版本请求头（2026-11-10 查证：https://platform.claude.com/docs/en/api/versioning）。 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ClaudeApiOptions {
  id?: string;
  displayName?: string;
  model?: string;
  maxTokens?: number;
  endpoint?: string;
  /** 按次向主进程取回解密后的 Key；绝不在 Thinking 实例上缓存或落盘明文。 */
  getSecret: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

interface AnthropicMessagesResponse {
  id?: unknown;
  type?: unknown;
  model?: unknown;
  stop_reason?: unknown;
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cost_usd?: unknown;
  };
  error?: {
    type?: unknown;
    message?: unknown;
  };
}

export function redactSecret(text: string, secret?: string | null): string {
  let out = text;
  if (secret && secret.length > 0) {
    out = out.split(secret).join('[已隐去密钥]');
  }
  return out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, '[已隐去密钥]');
}

function extractUsage(u: AnthropicMessagesResponse['usage']): ThinkUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const inputTokens = typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens) ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens) ? u.output_tokens : undefined;
  // 零虚构原则：只有响应体直接带了金额数值才记录 costUsd；否则只记录 token 数
  const costUsd = typeof u.cost_usd === 'number' && Number.isFinite(u.cost_usd) ? u.cost_usd : undefined;
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Claude API 思考者（通过 Node 内置 fetch 调用 Anthropic Messages API）。
 * - 绝不发送 tools / MCP 等工具定义；思考者没有任何写或执行权限；
 * - 绝不内置价目表或估算费用金额；只记录响应里的 token 数与（若服务端直接返回的）costUsd。
 */
export class ClaudeApiThinker implements Thinker {
  readonly id: string;
  readonly displayName: string;
  readonly service = 'Anthropic';

  constructor(private readonly options: ClaudeApiOptions) {
    this.id = options.id ?? 'claude-api';
    this.displayName = options.displayName ?? 'Claude（API）';
  }

  async detect(): Promise<ThinkerDetect> {
    let secret: string | null = null;
    try {
      secret = await this.options.getSecret();
    } catch (e) {
      return {
        available: false,
        note: redactSecret(e instanceof Error ? e.message : String(e)),
      };
    }
    if (!secret || !secret.trim()) {
      return {
        available: false,
        note: '尚未设置可用的 Anthropic API Key，请在「设置 → AI 与角色」中添加。',
      };
    }
    return { available: true };
  }

  async think(request: ThinkRequest): Promise<ThinkResult> {
    const parts = buildThinkPromptParts(request);
    const model = this.options.model?.trim() || DEFAULT_CLAUDE_API_MODEL;
    const maxTokens = this.options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const endpoint = this.options.endpoint ?? ANTHROPIC_MESSAGES_URL;

    let secret: string | null = null;
    try {
      secret = await this.options.getSecret();
    } catch (e) {
      return {
        status: 'auth_error',
        rawText: '',
        sent: parts.sent,
        service: this.service,
        error: redactSecret(e instanceof Error ? e.message : String(e)),
      };
    }
    if (!secret || !secret.trim()) {
      return {
        status: 'auth_error',
        rawText: '',
        sent: parts.sent,
        service: this.service,
        error: '尚未设置可用的 Anthropic API Key，请前往「设置 → AI 与角色」完成配置后再重试。',
      };
    }

    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return {
        status: 'failed',
        rawText: '',
        sent: parts.sent,
        service: this.service,
        error: '当前运行环境不支持 fetch，无法调用 Anthropic API。',
      };
    }

    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': secret,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        // 思考者没有工具权限，请求体绝不携带 tools；anthropic-version=2026-10-21 亦不传采样参数
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: parts.system,
          messages: [{ role: 'user', content: parts.user }],
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) {
        return {
          status: 'timeout',
          rawText: '',
          sent: parts.sent,
          service: this.service,
          error: '调用 Anthropic API 超时，请稍后重试。',
        };
      }
      const msg = redactSecret(e instanceof Error ? e.message : String(e), secret);
      return {
        status: 'failed',
        rawText: '',
        sent: parts.sent,
        service: this.service,
        error: `网络错误：无法连接到 Anthropic 服务（${msg}）。`,
      };
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await res.text().catch(() => '');
    let parsedBody: AnthropicMessagesResponse | null = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody) as AnthropicMessagesResponse;
      } catch {
        parsedBody = null;
      }
    }

    if (!res.ok || parsedBody?.type === 'error') {
      const errType = typeof parsedBody?.error?.type === 'string' ? parsedBody.error.type : '';
      const errMessage = typeof parsedBody?.error?.message === 'string' ? parsedBody.error.message : rawBody.slice(0, 300);
      const rawDiag = redactSecret(`HTTP ${res.status} ${errType} ${errMessage}`.trim(), secret);
      const status = classifyServiceError(`${res.status} ${errType} ${errMessage}`) ?? 'failed';
      return {
        status,
        rawText: rawDiag,
        usage: extractUsage(parsedBody?.usage),
        sent: parts.sent,
        service: this.service,
        error: rawDiag,
      };
    }

    if (!parsedBody || !Array.isArray(parsedBody.content)) {
      return {
        status: 'incomplete',
        rawText: redactSecret(rawBody, secret),
        sent: parts.sent,
        service: this.service,
        error: 'Anthropic API 返回了无法识别的响应格式。',
      };
    }

    const textParts: string[] = [];
    const refusedToolRequests: string[] = [];
    for (const block of parsedBody.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        refusedToolRequests.push(block.name);
      }
    }

    const rawText = redactSecret(textParts.join('\n').trim(), secret);
    const usage = extractUsage(parsedBody.usage);
    const respModel = typeof parsedBody.model === 'string' ? parsedBody.model : model;
    const isolationEvidence = 'messages-api:tools=0';

    const structured = parseStructured(rawText, request.output);
    if (!structured.ok) {
      const truncateHint = parsedBody.stop_reason === 'max_tokens' ? '模型达到输出长度上限，' : '';
      return {
        status: 'incomplete',
        rawText,
        ...(usage ? { usage } : {}),
        model: respModel,
        sent: parts.sent,
        service: this.service,
        error: `${truncateHint}${structured.error}`,
        isolationEvidence,
        ...(refusedToolRequests.length > 0 ? { refusedToolRequests } : {}),
      };
    }

    return {
      status: 'complete',
      content: structured.content,
      rawText,
      ...(usage ? { usage } : {}),
      model: respModel,
      sent: parts.sent,
      service: this.service,
      isolationEvidence,
      ...(refusedToolRequests.length > 0 ? { refusedToolRequests } : {}),
    };
  }
}
