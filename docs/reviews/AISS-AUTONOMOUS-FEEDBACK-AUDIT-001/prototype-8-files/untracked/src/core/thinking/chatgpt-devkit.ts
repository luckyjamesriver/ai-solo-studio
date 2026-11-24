import { classifyServiceError } from './errors.js';
import { buildThinkPromptParts, parseStructured } from './prompt.js';
import type { ThinkRequest, ThinkResult, ThinkUsage, Thinker, ThinkerDetect } from './types.js';

export const CHATGPT_DEVKIT_DEFAULT_MODEL = 'gpt-4o';
export const CHATGPT_DEVKIT_SERVICE_NAME = 'OpenAI (ChatGPT Plan via DevKit)';

export interface ChatGptDevKitOptions {
  id?: string;
  displayName?: string;
  model?: string;
  endpoint?: string;
  /** 获取当前登录用户的 Access Token（由 @siwc/local 或系统 Keychain 提供） */
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function redactDevKitSecret(text: string, token?: string | null): string {
  let out = text;
  if (token && token.length > 0) {
    out = out.split(token).join('[已隐去Token]');
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [已隐去Token]');
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAiChatResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

/**
 * ChatGPT DevKit 思考者：
 * - 结合官方 sign-in-with-chatgpt-devkit，使用用户已授权的 ChatGPT Plan 额度发起推理；
 * - 纯思考者：不注入任何 tools，绝不进行本地文件读写与命令执行；
 * - 安全合规：Token 动态获取，不在实例上长期落盘明文，报错严格脱敏。
 */
export class ChatGptDevKitThinker implements Thinker {
  readonly id: string;
  readonly displayName: string;
  readonly service = CHATGPT_DEVKIT_SERVICE_NAME;

  constructor(private readonly options: ChatGptDevKitOptions) {
    this.id = options.id ?? 'chatgpt-devkit';
    this.displayName = options.displayName ?? 'ChatGPT（DevKit 订阅版）';
  }

  async detect(): Promise<ThinkerDetect> {
    try {
      const token = await this.options.getAccessToken();
      if (!token || token.trim().length === 0) {
        return {
          available: false,
          note: '尚未通过 "Sign in with ChatGPT" 授权登录，无法使用个人订阅额度。',
        };
      }
      return {
        available: true,
        unconfirmed: [
          '调用通过 ChatGPT DevKit 认证通道发起，受 OpenAI 用户会话配额与速率限制策略约束',
        ],
      };
    } catch (err: any) {
      return {
        available: false,
        note: `检查 ChatGPT 授权状态失败：${err.message || String(err)}`,
      };
    }
  }

  async think(request: ThinkRequest): Promise<ThinkResult> {
    const start = Date.now();
    let token: string | null = null;
    try {
      token = await this.options.getAccessToken();
    } catch (err: any) {
      return {
        status: 'auth_error',
        rawText: '',
        sent: [],
        service: this.service,
        error: `获取授权凭证失败：${err.message || String(err)}`,
      };
    }

    if (!token || token.trim().length === 0) {
      return {
        status: 'auth_error',
        rawText: '',
        sent: [],
        service: this.service,
        error: '未检测到有效的 ChatGPT 授权 Token，请先完成登录。',
      };
    }

    const { system, user, sent } = buildThinkPromptParts(request);
    const messages: OpenAiMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const model = this.options.model ?? CHATGPT_DEVKIT_DEFAULT_MODEL;
    const endpoint = this.options.endpoint ?? 'https://api.openai.com/v1/chat/completions';
    const fetchFn = this.options.fetchImpl ?? fetch;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.trim()}`,
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const classified = classifyServiceError(errText) ?? (res.status === 401 ? 'auth_error' : res.status === 429 ? 'rate_limited' : 'failed');
        return {
          status: classified,
          rawText: '',
          sent,
          service: this.service,
          model,
          error: redactDevKitSecret(`ChatGPT DevKit 接口请求失败 (${res.status}): ${errText.slice(0, 500)}`, token),
        };
      }

      const body = (await res.json()) as OpenAiChatResponse;
      const rawText = body.choices?.[0]?.message?.content ?? '';

      let usage: ThinkUsage | undefined;
      if (body.usage) {
        usage = {
          inputTokens: body.usage.prompt_tokens,
          outputTokens: body.usage.completion_tokens,
        };
      }

      const parsed = parseStructured(rawText, request.output);
      if (!parsed.ok) {
        return {
          status: 'incomplete',
          rawText,
          sent,
          service: this.service,
          model,
          usage,
          error: `ChatGPT 返回内容未能满足要求的 JSON 结构：${parsed.error}`,
        };
      }

      return {
        status: 'complete',
        content: parsed.content,
        rawText,
        sent,
        service: this.service,
        model,
        usage,
      };
    } catch (err: any) {
      clearTimeout(timer);
      const isTimeout = err.name === 'AbortError' || Date.now() - start >= timeoutMs;
      return {
        status: isTimeout ? 'timeout' : 'failed',
        rawText: '',
        sent,
        service: this.service,
        model,
        error: redactDevKitSecret(`请求异常：${err.message || String(err)}`, token),
      };
    }
  }
}
