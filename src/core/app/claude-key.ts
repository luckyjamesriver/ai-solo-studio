import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  DEFAULT_CLAUDE_API_MODEL,
  redactSecret,
} from '../thinking/claude-api.js';
import { AppStore, type AppStoreOptions } from './app-store.js';

export { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL, DEFAULT_CLAUDE_API_MODEL, redactSecret };

const CLAUDE_KEY_RECORD_ID = 'claude-api-key';

/** 主进程注入的安全加密存储接口（Electron safeStorage），使 core 层保持纯 Node 可测，不直接依赖 electron（ADR 0006）。 */
export interface SecretVault {
  isAvailable(): Promise<{ ok: boolean; reason?: string }>;
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertextBase64: string): Promise<string>;
}

export type ClaudeKeyValidationCategory = 'invalid_key' | 'network_error' | 'service_unavailable';

export interface ClaudeKeyStatus {
  configured: boolean;
  available: boolean;
  last4: string | null;
  verifiedAt: string | null;
  unavailableReason: string | null;
}

export type ClaudeKeySaveResult =
  | { ok: true; status: ClaudeKeyStatus }
  | { ok: false; category: ClaudeKeyValidationCategory | 'storage_unavailable'; message: string };

export interface ValidateClaudeKeyOptions {
  model?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function summarizeAnthropicHttpError(
  status: number,
  bodyText: string,
  secret: string,
): { category: ClaudeKeyValidationCategory; reason: string } {
  let errType = '';
  let errMessage = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
    if (typeof parsed?.error?.type === 'string') errType = parsed.error.type;
    if (typeof parsed?.error?.message === 'string') errMessage = parsed.error.message;
  } catch {
    // 非 JSON 响应体时走状态码分类
  }

  const combined = `${errType} ${errMessage}`.trim();
  if (
    status === 401 ||
    status === 403 ||
    errType === 'authentication_error' ||
    errType === 'permission_error' ||
    /invalid[-_ ]?(?:api[-_ ]?key|x-api-key)|authentication/i.test(combined)
  ) {
    return {
      category: 'invalid_key',
      reason: 'Key 无效：Anthropic 服务拒绝认证，请检查 Key 是否正确或具备权限。',
    };
  }

  let detail = '';
  if (status === 402 || errType === 'billing_error' || /credit balance|billing/i.test(combined)) {
    detail = ' · 账户额度不足或计费受限';
  } else if (status === 429 || status === 529 || errType === 'rate_limit_error' || errType === 'overloaded_error') {
    detail = ' · 请求限流或服务繁忙';
  } else if (status >= 500) {
    detail = ' · 服务端暂时异常';
  }
  return {
    category: 'service_unavailable',
    reason: redactSecret(`服务不可用：Anthropic 返回状态 ${status}${detail}，Key 尚未保存，请稍后重试。`, secret),
  };
}

/** 发起一次最小 Anthropic Messages 请求验证 Key 是否可用，不传任何工具。 */
export async function validateAnthropicKey(
  rawSecret: string,
  opts: ValidateClaudeKeyOptions = {},
): Promise<{ ok: true } | { ok: false; category: ClaudeKeyValidationCategory; reason: string }> {
  const secret = rawSecret.trim();
  if (!secret) {
    return { ok: false, category: 'invalid_key', reason: 'Key 无效：请先填写 Anthropic API Key。' };
  }

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, category: 'service_unavailable', reason: '服务不可用：当前运行环境不支持 fetch 请求。' };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = opts.endpoint ?? ANTHROPIC_MESSAGES_URL;
  const model = opts.model?.trim() || DEFAULT_CLAUDE_API_MODEL;

  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': secret,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: controller.signal,
    });
  } catch {
    return {
      ok: false,
      category: 'network_error',
      reason: '网络不通：无法连接到 Anthropic 服务，请检查网络或代理设置。',
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, ...summarizeAnthropicHttpError(res.status, text, secret) };
  }

  if (text) {
    try {
      const json = JSON.parse(text) as { type?: unknown };
      if (json?.type === 'error') {
        return { ok: false, ...summarizeAnthropicHttpError(500, text, secret) };
      }
    } catch {
      return {
        ok: false,
        category: 'service_unavailable',
        reason: '服务不可用：Anthropic 返回了无法解析的响应格式。',
      };
    }
  }
  return { ok: true };
}

/**
 * Anthropic API Key 加密存储管理（userData RecordStore，仅主进程读写与解密）。
 * - 保存前先确认 safeStorage 可用并完成最小请求验证；safeStorage 不可用时绝不明文落盘；
 * - 对外状态只暴露是否已设置、可用性与最多后 4 位，绝不返回或记录 Key 明文。
 */
export class ClaudeKeyStore {
  private readonly app: AppStore;

  constructor(
    dataDir: string,
    private readonly vault: SecretVault,
    storeOpts: AppStoreOptions = {},
  ) {
    this.app = new AppStore(dataDir, storeOpts);
  }

  async status(): Promise<ClaudeKeyStatus> {
    const rec = await this.app.read(CLAUDE_KEY_RECORD_ID);
    if (!rec || rec.configured !== true || typeof rec.cipherB64 !== 'string' || !rec.cipherB64) {
      return {
        configured: false,
        available: false,
        last4: null,
        verifiedAt: null,
        unavailableReason: null,
      };
    }
    const avail = await this.vault.isAvailable();
    return {
      configured: true,
      available: avail.ok,
      last4: typeof rec.last4 === 'string' && rec.last4 ? rec.last4 : '****',
      verifiedAt: typeof rec.verifiedAt === 'string' ? rec.verifiedAt : null,
      unavailableReason: avail.ok ? null : (avail.reason ?? '当前系统安全加密存储不可用，无法使用已保存的 Key。'),
    };
  }

  async save(rawSecret: string, opts: ValidateClaudeKeyOptions = {}): Promise<ClaudeKeySaveResult> {
    const secret = rawSecret.trim();
    if (!secret) {
      return { ok: false, category: 'invalid_key', message: 'Key 无效：请先填写 Anthropic API Key。' };
    }

    const avail = await this.vault.isAvailable();
    if (!avail.ok) {
      return {
        ok: false,
        category: 'storage_unavailable',
        message: avail.reason ?? '当前系统安全加密存储（safeStorage）不可用，拒绝保存 API Key（不得明文落盘）。',
      };
    }

    const validated = await validateAnthropicKey(secret, opts);
    if (!validated.ok) {
      return { ok: false, category: validated.category, message: validated.reason };
    }

    const cipherB64 = await this.vault.encrypt(secret);
    if (!cipherB64 || cipherB64 === secret) {
      return {
        ok: false,
        category: 'storage_unavailable',
        message: '加密存储返回了无效密文，已拒绝保存，请检查系统密钥环环境。',
      };
    }

    const last4 = secret.length > 6 ? secret.slice(-4) : '****';
    const verifiedAt = new Date().toISOString();
    await this.app.update(
      CLAUDE_KEY_RECORD_ID,
      {},
      () => ({
        configured: true,
        cipherB64,
        last4,
        verifiedAt,
      }),
      'claude-key-save',
    );
    return { ok: true, status: await this.status() };
  }

  async delete(onDeleted?: () => Promise<void> | void): Promise<ClaudeKeyStatus> {
    await this.app.update(
      CLAUDE_KEY_RECORD_ID,
      {},
      () => ({
        configured: false,
        deletedAt: new Date().toISOString(),
      }),
      'claude-key-delete',
    );
    if (onDeleted) await onDeleted();
    return this.status();
  }

  /** 仅主进程调用：在发起 API 请求前即时解密 Key。未配置返回 null，safeStorage 不可用时抛错。 */
  async getSecret(): Promise<string | null> {
    const rec = await this.app.read(CLAUDE_KEY_RECORD_ID);
    if (!rec || rec.configured !== true || typeof rec.cipherB64 !== 'string' || !rec.cipherB64) {
      return null;
    }
    const avail = await this.vault.isAvailable();
    if (!avail.ok) {
      throw new Error(avail.reason ?? '当前系统安全加密存储（safeStorage）不可用，无法解密 Anthropic API Key。');
    }
    const plain = await this.vault.decrypt(rec.cipherB64);
    if (!plain || !plain.trim()) {
      throw new Error('已保存的 Anthropic API Key 无法解密，请重新保存有效的 Key。');
    }
    return plain.trim();
  }
}
