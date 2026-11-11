import { ANTHROPIC_API_VERSION } from '../../thinking/claude-api.js';
import type { ApiProtocol } from './catalog.js';

export type ApiErrorCategory = 'invalid_key' | 'network_error' | 'service_unavailable' | 'tools_unsupported';

export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type AgentTurnMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: AgentToolCall[]; reasoningContent?: string }
  | { role: 'tool_results'; results: AgentToolResult[] };

export interface ModelTurnRequest {
  protocol: ApiProtocol;
  endpoint: string;
  model: string;
  secret?: string | null;
  system?: string;
  messages: AgentTurnMessage[];
  tools?: AgentToolSpec[];
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ModelTurnResponse =
  | { ok: true; text: string; toolCalls: AgentToolCall[]; reasoningContent?: string; stopReason?: string }
  | { ok: false; category: ApiErrorCategory; status?: number; message: string };

export type ProviderConnectionTestResult =
  | { ok: true; toolCallingSupported: true; note: string }
  | { ok: true; toolCallingSupported: false; warning: string }
  | { ok: false; category: ApiErrorCategory; message: string };

export function redactApiSecrets(text: string, secret?: string | null): string {
  let out = text;
  if (secret && secret.trim().length > 0) {
    out = out.split(secret.trim()).join('[已隐去密钥]');
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [已隐去密钥]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,})/g, '[已隐去密钥]');
}

function buildUrl(protocol: ApiProtocol, endpoint: string, model: string, op: 'chat' | 'models'): string {
  const clean = endpoint.trim().replace(/\/+$/, '');
  if (protocol === 'anthropic') {
    if (op === 'models') {
      return clean.endsWith('/messages') ? `${clean.slice(0, -'/messages'.length)}/models` : clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
    }
    if (clean.endsWith('/messages')) return clean;
    return clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`;
  }
  if (protocol === 'gemini') {
    const base = clean.includes('/models') ? clean.replace(/\/models.*$/, '') : clean;
    if (op === 'models') return `${base}/models`;
    const cleanModel = model.replace(/^models\//, '');
    return `${base}/models/${encodeURIComponent(cleanModel)}:generateContent`;
  }
  if (op === 'models') {
    const base = clean.endsWith('/chat/completions') ? clean.slice(0, -'/chat/completions'.length) : clean;
    return `${base}/models`;
  }
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

function classifyHttpFailure(status: number, bodyText: string, secret?: string | null): { category: ApiErrorCategory; message: string } {
  let errType = '';
  let errMsg = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown; code?: unknown }; message?: unknown };
    if (typeof parsed?.error?.type === 'string') errType = parsed.error.type;
    if (typeof parsed?.error?.message === 'string') errMsg = parsed.error.message;
    else if (typeof parsed?.message === 'string') errMsg = parsed.message;
    if (!errType && typeof parsed?.error?.code === 'string') errType = parsed.error.code;
  } catch {
    // 非 JSON 错误正文走状态码兜底
  }

  const combined = `${errType} ${errMsg} ${bodyText.slice(0, 300)}`.trim();
  if (
    status === 401 ||
    status === 403 ||
    /authentication|permission_error|invalid[-_ ]?(?:api[-_ ]?key|x-api-key|key|token)|api key not valid|unauthorized/i.test(combined)
  ) {
    return {
      category: 'invalid_key',
      message: 'Key 无效或无权限：服务端拒绝认证，请检查 API Key 及对应账号权限。',
    };
  }
  if (
    (status === 400 || status === 422) &&
    /(?:tool|function(?:_call|Calling|Declarations)?).*(?:not\s+support|unsupported|unavailable|disabled)|does not support tools/i.test(combined)
  ) {
    return {
      category: 'tools_unsupported',
      message: '所选模型或接口不支持工具调用（Tool Calling），只能用于纯对话讨论，无法自动修改代码。',
    };
  }

  let hint = '';
  if (status === 402 || /billing|credit|insufficient_quota|quota|balance/i.test(combined)) hint = ' · 账户余额不足或额度已用完';
  else if (status === 429 || status === 529 || /rate_limit|overloaded|too many requests/i.test(combined)) hint = ' · 请求限流或服务繁忙';
  else if (status === 404 || /model_not_found|does not exist|not found/i.test(combined)) hint = ' · 未找到所选模型或接口路径有误';
  else if (status >= 500) hint = ' · 服务端暂时异常';
  const brief = errMsg ? `（${errMsg.slice(0, 120)}）` : '';
  return {
    category: 'service_unavailable',
    message: redactApiSecrets(`服务不可用：返回状态 ${status}${hint}${brief}`, secret),
  };
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function encodeOpenAiBody(req: ModelTurnRequest): Record<string, unknown> {
  const msgs: Record<string, unknown>[] = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      msgs.push({
        role: 'assistant',
        content: m.text || (m.toolCalls.length > 0 ? null : ''),
        ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
        ...(m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) {
        msgs.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
      }
    }
  }
  return {
    model: req.model,
    messages: msgs,
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.tools && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
  };
}

function decodeOpenAiResponse(json: Record<string, unknown>, secret?: string | null): ModelTurnResponse {
  if (json.error && typeof json.error === 'object') {
    return { ok: false, ...classifyHttpFailure(400, JSON.stringify(json), secret) };
  }
  const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
  const first = choices[0];
  const msg = first?.message as Record<string, unknown> | undefined;
  if (!msg) return { ok: false, category: 'service_unavailable', message: '服务返回了空的响应内容（缺少 choices[0].message）。' };
  const text = typeof msg.content === 'string' ? msg.content : '';
  const reasoningContent = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined;
  const rawCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
  const toolCalls: AgentToolCall[] = rawCalls
    .map((c, idx) => {
      const fn = (c.function ?? {}) as Record<string, unknown>;
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) return null;
      return {
        id: typeof c.id === 'string' && c.id ? c.id : `call_${idx}`,
        name,
        arguments: safeParseArgs(fn.arguments),
      };
    })
    .filter((x): x is AgentToolCall => x !== null);
  return {
    ok: true,
    text,
    toolCalls,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(typeof first?.finish_reason === 'string' ? { stopReason: first.finish_reason } : {}),
  };
}

function encodeAnthropicBody(req: ModelTurnRequest): Record<string, unknown> {
  const msgs: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      if (blocks.length > 0) msgs.push({ role: 'assistant', content: blocks });
    } else {
      msgs.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    ...(req.system ? { system: req.system } : {}),
    messages: msgs,
    ...(req.tools && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }
      : {}),
  };
}

function decodeAnthropicResponse(json: Record<string, unknown>, secret?: string | null): ModelTurnResponse {
  if (json.type === 'error' || json.error) {
    return { ok: false, ...classifyHttpFailure(400, JSON.stringify(json), secret) };
  }
  const content = Array.isArray(json.content) ? (json.content as Record<string, unknown>[]) : [];
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      toolCalls.push({
        id: typeof b.id === 'string' && b.id ? b.id : `toolu_${toolCalls.length}`,
        name: b.name,
        arguments: safeParseArgs(b.input),
      });
    }
  }
  return {
    ok: true,
    text: textParts.join(''),
    toolCalls,
    ...(typeof json.stop_reason === 'string' ? { stopReason: json.stop_reason } : {}),
  };
}

function encodeGeminiBody(req: ModelTurnRequest): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else {
      contents.push({
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { name: r.name, response: { output: r.content, isError: !!r.isError } },
        })),
      });
    }
  }
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents,
    ...(req.tools && req.tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            },
          ],
        }
      : {}),
    ...(req.maxTokens ? { generationConfig: { maxOutputTokens: req.maxTokens } } : {}),
  };
}

function decodeGeminiResponse(json: Record<string, unknown>, secret?: string | null): ModelTurnResponse {
  if (json.error) {
    return { ok: false, ...classifyHttpFailure(400, JSON.stringify(json), secret) };
  }
  const candidates = Array.isArray(json.candidates) ? (json.candidates as Record<string, unknown>[]) : [];
  const first = candidates[0];
  const content = (first?.content ?? {}) as { parts?: Record<string, unknown>[] };
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const p of parts) {
    if (typeof p?.text === 'string') textParts.push(p.text);
    const fc = p?.functionCall as Record<string, unknown> | undefined;
    if (fc && typeof fc.name === 'string') {
      toolCalls.push({
        id: `gem_${toolCalls.length}`,
        name: fc.name,
        arguments: safeParseArgs(fc.args),
      });
    }
  }
  return {
    ok: true,
    text: textParts.join(''),
    toolCalls,
    ...(typeof first?.finishReason === 'string' ? { stopReason: first.finishReason } : {}),
  };
}

function requestHeaders(protocol: ApiProtocol, secret?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const trimmed = secret?.trim() ?? '';
  if (protocol === 'anthropic') {
    if (trimmed) headers['x-api-key'] = trimmed;
    headers['anthropic-version'] = ANTHROPIC_API_VERSION;
  } else if (protocol === 'gemini') {
    if (trimmed) headers['x-goog-api-key'] = trimmed;
  } else {
    headers['authorization'] = `Bearer ${trimmed || 'local'}`;
  }
  return headers;
}

/** 对三大协议发起单轮模型调用（纯 Node fetch，不缓存任何密钥）。 */
export async function callProviderModel(req: ModelTurnRequest): Promise<ModelTurnResponse> {
  const doFetch = req.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, category: 'service_unavailable', message: '当前运行环境不支持 fetch 请求。' };
  }
  const url = buildUrl(req.protocol, req.endpoint, req.model, 'chat');
  const bodyObj =
    req.protocol === 'anthropic'
      ? encodeAnthropicBody(req)
      : req.protocol === 'gemini'
        ? encodeGeminiBody(req)
        : encodeOpenAiBody(req);

  const ac = new AbortController();
  const timeoutMs = req.timeoutMs ?? 120_000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onParentAbort = () => ac.abort();
  req.signal?.addEventListener('abort', onParentAbort, { once: true });

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: requestHeaders(req.protocol, req.secret),
      body: JSON.stringify(bodyObj),
      signal: ac.signal,
    });
  } catch {
    if (req.signal?.aborted) {
      return { ok: false, category: 'network_error', message: '请求已手动取消。' };
    }
    return { ok: false, category: 'network_error', message: '网络不通：无法连接到所选 AI 接口地址，请检查网络或代理设置。' };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onParentAbort);
  }

  const rawText = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, ...classifyHttpFailure(res.status, rawText, req.secret), status: res.status };
  }
  try {
    const parsed = JSON.parse(rawText || '{}') as Record<string, unknown>;
    if (req.protocol === 'anthropic') return decodeAnthropicResponse(parsed, req.secret);
    if (req.protocol === 'gemini') return decodeGeminiResponse(parsed, req.secret);
    return decodeOpenAiResponse(parsed, req.secret);
  } catch {
    return { ok: false, category: 'service_unavailable', message: '服务返回了无法解析的 JSON 响应。' };
  }
}

const PING_TOOL: AgentToolSpec = {
  name: 'ping_workspace',
  description: 'Read-only health probe confirming the model accepts tool schemas.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
  },
};

/**
 * 两步最小连接测试（先验证鉴权/模型可用，再验证 Tool Calling 支持）：
 * 仅两步都通过才可作为可执行任务的后台执行者。
 */
export async function testProviderConnection(opts: {
  protocol: ApiProtocol;
  endpoint: string;
  model: string;
  secret?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderConnectionTestResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const step1 = await callProviderModel({
    protocol: opts.protocol,
    endpoint: opts.endpoint,
    model: opts.model,
    secret: opts.secret,
    messages: [{ role: 'user', content: 'ok' }],
    maxTokens: 16,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs,
  });
  if (!step1.ok) {
    return { ok: false, category: step1.category, message: step1.message };
  }

  const step2 = await callProviderModel({
    protocol: opts.protocol,
    endpoint: opts.endpoint,
    model: opts.model,
    secret: opts.secret,
    messages: [{ role: 'user', content: 'Reply with OK without calling tools.' }],
    tools: [PING_TOOL],
    maxTokens: 48,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs,
  });
  if (!step2.ok) {
    if (step2.category === 'tools_unsupported' || (step2.status !== undefined && (step2.status === 400 || step2.status === 422))) {
      return {
        ok: true,
        toolCallingSupported: false,
        warning: '连接认证已通过，但该模型/接口拒绝或不支持工具调用（Tool Calling），暂不能担任改代码执行者。',
      };
    }
    if (step2.category === 'invalid_key' || step2.category === 'network_error') {
      return { ok: false, category: step2.category, message: step2.message };
    }
    return {
      ok: true,
      toolCallingSupported: false,
      warning: `基础连接通过，但工具调用握手失败（${step2.message}），暂不能担任执行者。`,
    };
  }

  return {
    ok: true,
    toolCallingSupported: true,
    note: '认证与工具调用握手均已通过，可作为后台执行者运行任务。',
  };
}

/** 尽力拉取服务端当前可用模型列表；不支持或无网时安全返回失败信息而不抛未捕获异常。 */
export async function fetchProviderModels(opts: {
  protocol: ApiProtocol;
  endpoint: string;
  secret?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; models: string[] } | { ok: false; message: string }> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, message: '当前环境不支持网络请求。' };
  const url = buildUrl(opts.protocol, opts.endpoint, '', 'models');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  const headers: Record<string, string> = {};
  const trimmed = opts.secret?.trim() ?? '';
  if (opts.protocol === 'anthropic') {
    if (trimmed) headers['x-api-key'] = trimmed;
    headers['anthropic-version'] = ANTHROPIC_API_VERSION;
  } else if (opts.protocol === 'gemini') {
    if (trimmed) headers['x-goog-api-key'] = trimmed;
  } else {
    headers['authorization'] = `Bearer ${trimmed || 'local'}`;
  }
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: ac.signal });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, message: classifyHttpFailure(res.status, raw, opts.secret).message };
    }
    const json = JSON.parse(raw || '{}') as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rawList: Array<{ id?: unknown; name?: unknown }> = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.models)
        ? json.models
        : [];
    const models = rawList
      .map((item) => {
        if (typeof item?.id === 'string') return item.id;
        if (typeof item?.name === 'string') return item.name.replace(/^models\//, '');
        return '';
      })
      .filter(Boolean);
    return { ok: true, models: [...new Set(models)] };
  } catch {
    return { ok: false, message: '拉取模型列表失败：无法连接该地址，可手动直接填写模型 ID。' };
  } finally {
    clearTimeout(timer);
  }
}
