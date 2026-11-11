import crypto from 'node:crypto';
import { AppStore, type AppStoreOptions } from './app-store.js';
import type { SecretVault } from './claude-key.js';
import {
  API_PROVIDER_CATALOG,
  findProviderPreset,
  isOfficialEndpointForPreset,
  normalizeApiEndpoint,
  type ApiProtocol,
  type BuiltinApiProviderId,
} from '../executor/api/catalog.js';
import { redactApiSecrets, testProviderConnection, type ApiErrorCategory } from '../executor/api/client.js';

const PROFILES_RECORD_ID = 'provider-profiles';
const SECRETS_RECORD_ID = 'provider-secrets';
export const PROVIDER_PROFILE_ID_RE = /^[a-z0-9_-]{1,48}$/;

export interface StoredProviderProfile {
  id: string;
  presetId: BuiltinApiProviderId;
  label: string;
  protocol: ApiProtocol;
  endpoint: string;
  model: string;
  requiresKey: boolean;
  hasSecret: boolean;
  last4: string | null;
  verifiedAt: string | null;
  toolCallingSupported: boolean;
  executorReady: boolean;
  toolWarning?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileView {
  id: string;
  presetId: BuiltinApiProviderId;
  presetName: string;
  label: string;
  protocol: ApiProtocol;
  endpoint: string;
  endpointOrigin: string;
  officialEndpoint: boolean;
  model: string;
  requiresKey: boolean;
  configured: boolean;
  available: boolean;
  last4: string | null;
  verifiedAt: string | null;
  toolCallingSupported: boolean;
  executorReady: boolean;
  toolWarning: string | null;
  unavailableReason: string | null;
}

export interface SaveProviderProfileInput {
  id?: string;
  presetId: BuiltinApiProviderId;
  label?: string;
  endpoint?: string;
  model: string;
  secret?: string;
}

export type SaveProviderProfileResult =
  | { ok: true; profile: ProviderProfileView; message: string }
  | {
      ok: false;
      category: ApiErrorCategory | 'storage_unavailable' | 'invalid_input';
      message: string;
    };

function sanitizeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function defaultLabel(presetName: string, model: string): string {
  return model ? `${presetName} · ${model}` : presetName;
}

/**
 * 多 AI API 服务商配置与加密密钥仓库（userData AppStore）。
 * - 密钥密文独立存放在 provider-secrets，仅主进程经 SecretVault（Electron safeStorage）加解密；
 * - 对外只暴露 ProviderProfileView（含脱敏尾号 last4、验证时间与 executorReady 标记），永不暴露明文或密文；
 * - 仅认证与 Tool Calling 双重连接测试通过的配置，才会被标记为 executorReady: true。
 */
export class ProviderProfileStore {
  private readonly app: AppStore;

  constructor(
    dataDir: string,
    private readonly vault: SecretVault,
    storeOpts: AppStoreOptions = {},
  ) {
    this.app = new AppStore(dataDir, storeOpts);
  }

  private async readProfilesMap(): Promise<Record<string, StoredProviderProfile>> {
    const raw = await this.app.read(PROFILES_RECORD_ID);
    const items = raw?.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    const out: Record<string, StoredProviderProfile> = {};
    for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
      if (!PROVIDER_PROFILE_ID_RE.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      const p = v as Partial<StoredProviderProfile>;
      if (typeof p.presetId !== 'string' || typeof p.endpoint !== 'string' || typeof p.model !== 'string') continue;
      const preset = findProviderPreset(p.presetId);
      if (!preset) continue;
      out[k] = {
        id: k,
        presetId: preset.id,
        label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : defaultLabel(preset.name, p.model),
        protocol: p.protocol === 'anthropic' || p.protocol === 'gemini' || p.protocol === 'openai_compat' ? p.protocol : preset.protocol,
        endpoint: p.endpoint,
        model: p.model,
        requiresKey: p.requiresKey !== false,
        hasSecret: p.hasSecret === true,
        last4: typeof p.last4 === 'string' ? p.last4 : null,
        verifiedAt: typeof p.verifiedAt === 'string' ? p.verifiedAt : null,
        toolCallingSupported: p.toolCallingSupported === true,
        executorReady: p.executorReady === true,
        ...(typeof p.toolWarning === 'string' && p.toolWarning ? { toolWarning: p.toolWarning } : {}),
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
      };
    }
    return out;
  }

  private async readSecretsMap(): Promise<Record<string, { cipherB64: string }>> {
    const raw = await this.app.read(SECRETS_RECORD_ID);
    const items = raw?.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    const out: Record<string, { cipherB64: string }> = {};
    for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
      if (!PROVIDER_PROFILE_ID_RE.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      const rec = v as { cipherB64?: unknown };
      if (typeof rec.cipherB64 === 'string' && rec.cipherB64) out[k] = { cipherB64: rec.cipherB64 };
    }
    return out;
  }

  async listProfiles(): Promise<ProviderProfileView[]> {
    const [profiles, secrets, vaultAvail] = await Promise.all([
      this.readProfilesMap(),
      this.readSecretsMap(),
      this.vault.isAvailable(),
    ]);
    return Object.values(profiles)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => {
        const preset = findProviderPreset(p.presetId)!;
        const cipherPresent = !!secrets[p.id]?.cipherB64;
        const configured = p.hasSecret ? cipherPresent : !p.requiresKey;
        const needVault = p.hasSecret || p.requiresKey;
        const available = configured && (!needVault || vaultAvail.ok);
        const executorReady = p.executorReady && available && p.toolCallingSupported;
        let unavailableReason: string | null = null;
        if (p.hasSecret && !cipherPresent) unavailableReason = '已保存的密钥密文缺失，请重新输入并测试连接。';
        else if (needVault && !vaultAvail.ok) unavailableReason = vaultAvail.reason ?? '当前系统安全加密存储不可用。';
        return {
          id: p.id,
          presetId: p.presetId,
          presetName: preset.name,
          label: p.label,
          protocol: p.protocol,
          endpoint: p.endpoint,
          endpointOrigin: sanitizeOrigin(p.endpoint),
          officialEndpoint: isOfficialEndpointForPreset(p.presetId, p.endpoint),
          model: p.model,
          requiresKey: p.requiresKey,
          configured,
          available,
          last4: p.last4,
          verifiedAt: p.verifiedAt,
          toolCallingSupported: p.toolCallingSupported,
          executorReady,
          toolWarning: p.toolWarning ?? null,
          unavailableReason,
        };
      });
  }

  async getProfile(id: string): Promise<ProviderProfileView | null> {
    if (!PROVIDER_PROFILE_ID_RE.test(id)) return null;
    const all = await this.listProfiles();
    return all.find((p) => p.id === id) ?? null;
  }

  /** 仅主进程/执行器使用：按需即时解密 API Key（若本地服务无需 Key 则返回 null）。 */
  async getSecret(id: string): Promise<string | null> {
    if (!PROVIDER_PROFILE_ID_RE.test(id)) throw new Error('无效的服务商配置编号。');
    const [profiles, secrets] = await Promise.all([this.readProfilesMap(), this.readSecretsMap()]);
    const p = profiles[id];
    if (!p) throw new Error('找不到对应的 AI 服务商配置，可能已被删除。');
    if (!p.hasSecret) {
      if (!p.requiresKey) return null;
      throw new Error(`「${p.label}」未配置有效 API Key。`);
    }
    const sec = secrets[id]?.cipherB64;
    if (!sec) throw new Error(`「${p.label}」的加密密钥缺失，请重新配置。`);
    const avail = await this.vault.isAvailable();
    if (!avail.ok) {
      throw new Error(avail.reason ?? '当前系统安全加密存储（safeStorage）不可用，无法解密 API Key。');
    }
    const plain = await this.vault.decrypt(sec);
    if (!plain || !plain.trim()) throw new Error(`「${p.label}」的 API Key 解密失败，请重新输入并测试连接。`);
    return plain.trim();
  }

  async saveAndTest(
    input: SaveProviderProfileInput,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ): Promise<SaveProviderProfileResult> {
    const preset = findProviderPreset(input.presetId);
    if (!preset) return { ok: false, category: 'invalid_input', message: '未识别的 AI 服务商选项。' };

    const model = input.model.trim().slice(0, 160);
    if (!model) return { ok: false, category: 'invalid_input', message: '请先选择或输入模型 ID。' };

    const rawEndpoint = input.endpoint?.trim() || preset.defaultEndpoint;
    const norm = normalizeApiEndpoint(rawEndpoint);
    if (!norm.ok) return { ok: false, category: 'invalid_input', message: norm.reason };

    const existingId = input.id?.trim() || undefined;
    if (existingId && !PROVIDER_PROFILE_ID_RE.test(existingId)) {
      return { ok: false, category: 'invalid_input', message: '无效的配置编号。' };
    }
    const profiles = await this.readProfilesMap();
    const existing = existingId ? profiles[existingId] : undefined;

    let secretToTest: string | null = input.secret?.trim() || null;
    if (!secretToTest && existing?.hasSecret) {
      try {
        secretToTest = await this.getSecret(existing.id);
      } catch (err) {
        return {
          ok: false,
          category: 'storage_unavailable',
          message: err instanceof Error ? err.message : '无法读取已保存的加密 Key，请重新输入。',
        };
      }
    }
    if (!secretToTest && preset.requiresKey) {
      return { ok: false, category: 'invalid_key', message: `Key 无效：请填写 ${preset.name} 的 API Key。` };
    }

    if (secretToTest !== null) {
      const avail = await this.vault.isAvailable();
      if (!avail.ok) {
        return {
          ok: false,
          category: 'storage_unavailable',
          message: avail.reason ?? '当前系统安全加密存储（safeStorage）不可用，拒绝保存 API Key（不得明文落盘）。',
        };
      }
    }

    const tested = await testProviderConnection({
      protocol: preset.protocol,
      endpoint: norm.endpoint,
      model,
      secret: secretToTest,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!tested.ok) {
      return {
        ok: false,
        category: tested.category,
        message: redactApiSecrets(tested.message, secretToTest),
      };
    }

    const id = existing?.id ?? `${preset.id}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = new Date().toISOString();
    let hasSecret = false;
    let last4: string | null = null;
    if (secretToTest !== null) {
      const cipherB64 = await this.vault.encrypt(secretToTest);
      if (!cipherB64 || cipherB64 === secretToTest) {
        return {
          ok: false,
          category: 'storage_unavailable',
          message: '加密存储返回无效密文，已拒绝落盘，请检查系统密钥环。',
        };
      }
      hasSecret = true;
      last4 = secretToTest.length > 6 ? secretToTest.slice(-4) : '****';
      await this.app.update(
        SECRETS_RECORD_ID,
        { items: {} },
        (cur) => {
          const items = (cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>;
          return { items: { ...items, [id]: { cipherB64 } } };
        },
        'provider-secret-save',
      );
    }

    const label = input.label?.trim().slice(0, 60) || defaultLabel(preset.name, model);
    const nextProfile: StoredProviderProfile = {
      id,
      presetId: preset.id,
      label,
      protocol: preset.protocol,
      endpoint: norm.endpoint,
      model,
      requiresKey: preset.requiresKey,
      hasSecret,
      last4,
      verifiedAt: now,
      toolCallingSupported: tested.toolCallingSupported,
      executorReady: tested.toolCallingSupported,
      ...(tested.toolCallingSupported ? {} : { toolWarning: tested.warning }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.app.update(
      PROFILES_RECORD_ID,
      { items: {} },
      (cur) => {
        const items = (cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>;
        return { items: { ...items, [id]: nextProfile } };
      },
      'provider-profile-save',
    );

    const view = (await this.getProfile(id))!;
    return {
      ok: true,
      profile: view,
      message: tested.toolCallingSupported ? tested.note : tested.warning,
    };
  }

  async deleteProfile(id: string, onDeleted?: (id: string) => Promise<void> | void): Promise<ProviderProfileView[]> {
    if (!PROVIDER_PROFILE_ID_RE.test(id)) throw new Error('无效的配置编号。');
    await this.app.update(
      SECRETS_RECORD_ID,
      { items: {} },
      (cur) => {
        const items = { ...((cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>) };
        delete items[id];
        return { items };
      },
      'provider-secret-delete',
    );
    await this.app.update(
      PROFILES_RECORD_ID,
      { items: {} },
      (cur) => {
        const items = { ...((cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>) };
        delete items[id];
        return { items };
      },
      'provider-profile-delete',
    );
    if (onDeleted) await onDeleted(id);
    return this.listProfiles();
  }
}

export function listProviderPresets() {
  return API_PROVIDER_CATALOG;
}
