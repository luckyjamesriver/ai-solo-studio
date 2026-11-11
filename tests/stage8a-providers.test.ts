import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretVault } from '../src/core/app/claude-key.js';
import { ProviderProfileStore } from '../src/core/app/provider-profiles.js';
import {
  API_PROVIDER_CATALOG,
  isOfficialEndpointForPreset,
  normalizeApiEndpoint,
} from '../src/core/executor/api/catalog.js';
import { fetchProviderModels, redactApiSecrets, testProviderConnection } from '../src/core/executor/api/client.js';
import { RecordStore } from '../src/core/persistence/index.js';

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

function makeVault(ok = true): SecretVault {
  const aesKey = crypto.randomBytes(32);
  return {
    async isAvailable() {
      return ok ? { ok: true } : { ok: false, reason: '加密存储不可用（测试模拟）' };
    },
    async encrypt(plaintext: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    },
    async decrypt(cipherB64: string) {
      const raw = Buffer.from(cipherB64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

interface ReqLog {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function startMockHttp(
  handler: (req: ReqLog) => { status: number; body: unknown },
): Promise<{ endpoint: string; logs: ReqLog[] }> {
  const logs: ReqLog[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const entry: ReqLog = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      };
      logs.push(entry);
      const out = handler(entry);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanServers.push(server);
  const addr = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${addr.port}`, logs };
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanServers.length > 0) {
    await new Promise<void>((r) => cleanServers.pop()!.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8A 提交① · 主流 AI API 目录、三协议测试与加密存储', () => {
  it('内置 12 家常用服务商目录，且远程仅允许 HTTPS、回环地址才允许 HTTP', () => {
    const ids = API_PROVIDER_CATALOG.map((p) => p.id);
    expect(ids).toEqual([
      'deepseek',
      'openai',
      'anthropic',
      'gemini',
      'qwen',
      'zhipu',
      'moonshot',
      'minimax',
      'xai',
      'openrouter',
      'ollama',
      'custom_openai',
    ]);
    expect(normalizeApiEndpoint('https://api.deepseek.com/')).toMatchObject({ ok: true, endpoint: 'https://api.deepseek.com', isLocal: false });
    expect(normalizeApiEndpoint('http://localhost:11434/v1/')).toMatchObject({ ok: true, endpoint: 'http://localhost:11434/v1', isLocal: true });
    expect(normalizeApiEndpoint('http://api.deepseek.com')).toMatchObject({ ok: false });
    expect(isOfficialEndpointForPreset('deepseek', 'https://api.deepseek.com')).toBe(true);
    expect(isOfficialEndpointForPreset('deepseek', 'https://proxy.example.com/v1')).toBe(false);
    expect(isOfficialEndpointForPreset('custom_openai', 'https://gateway.example.com/v1')).toBe(false);
  });

  it('三协议（OpenAI Compatible / Anthropic / Gemini）连接测试、模型拉取与无工具模型拦截', async () => {
    // 1. OpenAI Compatible (DeepSeek) + /models
    const openaiMock = await startMockHttp((req) => {
      if (req.method === 'GET' && req.url === '/models') {
        return { status: 200, body: { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] } };
      }
      if (req.headers.authorization !== 'Bearer sk-ds-secret-123456') {
        return { status: 401, body: { error: { type: 'authentication_error', message: 'invalid api key' } } };
      }
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } };
    });

    const models = await fetchProviderModels({ protocol: 'openai_compat', endpoint: openaiMock.endpoint, secret: 'sk-ds-secret-123456' });
    expect(models).toEqual({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] });

    const dsPass = await testProviderConnection({
      protocol: 'openai_compat',
      endpoint: openaiMock.endpoint,
      model: 'deepseek-chat',
      secret: 'sk-ds-secret-123456',
    });
    expect(dsPass).toMatchObject({ ok: true, toolCallingSupported: true });
    expect(openaiMock.logs.filter((l) => l.method === 'POST')).toHaveLength(2);
    expect(Array.isArray(openaiMock.logs[2]!.body.tools)).toBe(true);

    // 2. Anthropic Messages
    const claudeMock = await startMockHttp((req) => {
      expect(req.headers['x-api-key']).toBe('sk-ant-test-9999');
      expect(req.url).toBe('/v1/messages');
      return { status: 200, body: { id: 'm1', type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } };
    });
    expect(
      await testProviderConnection({
        protocol: 'anthropic',
        endpoint: `${claudeMock.endpoint}/v1/messages`,
        model: 'claude-sonnet-5-5',
        secret: 'sk-ant-test-9999',
      }),
    ).toMatchObject({ ok: true, toolCallingSupported: true });

    // 3. Google Gemini v1beta (uses x-goog-api-key header, functionDeclarations schema)
    const geminiMock = await startMockHttp((req) => {
      if (req.method === 'GET' && req.url === '/v1beta/models') {
        return { status: 200, body: { models: [{ name: 'models/gemini-3.8-flash' }] } };
      }
      expect(req.headers['x-goog-api-key']).toBe('AIzaTestSecret12345');
      expect(req.url).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] } };
    });
    expect(
      await fetchProviderModels({ protocol: 'gemini', endpoint: `${geminiMock.endpoint}/v1beta`, secret: 'AIzaTestSecret12345' }),
    ).toEqual({ ok: true, models: ['gemini-3.8-flash'] });
    expect(
      await testProviderConnection({
        protocol: 'gemini',
        endpoint: `${geminiMock.endpoint}/v1beta`,
        model: 'gemini-3.8-flash',
        secret: 'AIzaTestSecret12345',
      }),
    ).toMatchObject({ ok: true, toolCallingSupported: true });

    // 4. 只支持聊天、拒绝 tools 的模型 → 不得标记为可执行者
    const chatOnlyMock = await startMockHttp((req) => {
      if (Array.isArray(req.body.tools)) {
        return { status: 400, body: { error: { message: 'This model does not support tools yet.' } } };
      }
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } };
    });
    const noTools = await testProviderConnection({
      protocol: 'openai_compat',
      endpoint: chatOnlyMock.endpoint,
      model: 'chat-only-mini',
      secret: 'sk-123456',
    });
    expect(noTools).toMatchObject({ ok: true, toolCallingSupported: false });
    expect(redactApiSecrets('err Bearer sk-ds-secret-123456 & AIzaTestSecret12345', 'my-custom-token')).not.toContain('123456');
  });

  it('ProviderProfileStore：safeStorage 不可用拒存明文；加密保存只露尾号；支持本地无 Key 模型与无工具模型拦截', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-p-'));
    cleanDirs.push(dataDir);

    const dsMock = await startMockHttp((req) => {
      if (req.headers.authorization !== 'Bearer sk-deepseek-real-secret-7788') {
        return { status: 401, body: { error: { message: 'Invalid API key' } } };
      }
      if (req.body.model === 'deepseek-no-tools' && Array.isArray(req.body.tools)) {
        return { status: 400, body: { error: { message: 'Model does not support tools' } } };
      }
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } };
    });

    // 1. safeStorage 不可用时绝不落盘明文
    const brokenStore = new ProviderProfileStore(dataDir, makeVault(false));
    const deniedSave = await brokenStore.saveAndTest({
      presetId: 'deepseek',
      endpoint: dsMock.endpoint,
      model: 'deepseek-chat',
      secret: 'sk-deepseek-real-secret-7788',
    });
    expect(deniedSave).toMatchObject({ ok: false, category: 'storage_unavailable' });
    expect(await brokenStore.listProfiles()).toHaveLength(0);

    // 2. 错误 Key 校验失败不落盘
    const store = new ProviderProfileStore(dataDir, makeVault(true));
    const badKey = await store.saveAndTest({
      presetId: 'deepseek',
      endpoint: dsMock.endpoint,
      model: 'deepseek-chat',
      secret: 'sk-wrong-key-9999',
    });
    expect(badKey).toMatchObject({ ok: false, category: 'invalid_key' });
    expect(await store.listProfiles()).toHaveLength(0);

    // 3. 正确 Key 且支持工具调用 → 加密保存、executorReady=true、磁盘零明文
    const saved = await store.saveAndTest({
      presetId: 'deepseek',
      endpoint: dsMock.endpoint,
      model: 'deepseek-chat',
      secret: 'sk-deepseek-real-secret-7788',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('expected ok');
    expect(saved.profile).toMatchObject({
      presetId: 'deepseek',
      model: 'deepseek-chat',
      last4: '7788',
      toolCallingSupported: true,
      executorReady: true,
    });
    expect(await store.getSecret(saved.profile.id)).toBe('sk-deepseek-real-secret-7788');

    // 检查所有磁盘文件不含明文 Key
    const walk = async (dir: string): Promise<string[]> => {
      const es = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const out: string[] = [];
      for (const e of es) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else out.push(p);
      }
      return out;
    };
    for (const file of await walk(dataDir)) {
      const content = await fs.readFile(file, 'utf8');
      expect(content).not.toContain('sk-deepseek-real-secret-7788');
    }

    // 4. 不支持工具调用的模型 → executorReady=false
    const nonExec = await store.saveAndTest({
      presetId: 'deepseek',
      endpoint: dsMock.endpoint,
      model: 'deepseek-no-tools',
      secret: 'sk-deepseek-real-secret-7788',
    });
    expect(nonExec.ok).toBe(true);
    if (nonExec.ok) {
      expect(nonExec.profile.toolCallingSupported).toBe(false);
      expect(nonExec.profile.executorReady).toBe(false);
    }

    // 5. 本地 Ollama 无需密钥也能测通并成为可用执行者
    const ollamaMock = await startMockHttp(() => ({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'OK' } }] },
    }));
    const localSaved = await store.saveAndTest({
      presetId: 'ollama',
      endpoint: ollamaMock.endpoint,
      model: 'qwen2.5-coder:32b',
    });
    expect(localSaved.ok).toBe(true);
    if (localSaved.ok) {
      expect(localSaved.profile.executorReady).toBe(true);
      expect(localSaved.profile.last4).toBeNull();
      expect(await store.getSecret(localSaved.profile.id)).toBeNull();
    }

    // 6. 删除配置清理元数据与密文
    await store.deleteProfile(saved.profile.id);
    await expect(store.getSecret(saved.profile.id)).rejects.toThrow(/找不到/);
  });
});
