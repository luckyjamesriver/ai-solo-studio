import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ANTHROPIC_API_VERSION,
  ClaudeKeyStore,
  DEFAULT_CLAUDE_API_MODEL,
  validateAnthropicKey,
  type SecretVault,
} from '../src/core/app/claude-key.js';
import { buildDisclosure, DisclosureStore } from '../src/core/app/disclosure.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { SettingsPage } from '../src/renderer/SettingsPage.js';

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

function makeCryptoVault(available = { ok: true as boolean, reason: undefined as string | undefined }): SecretVault {
  const aesKey = crypto.randomBytes(32);
  return {
    async isAvailable() {
      return available.ok ? { ok: true } : { ok: false, reason: available.reason ?? '加密存储不可用' };
    },
    async encrypt(plaintext: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString('base64');
    },
    async decrypt(cipherB64: string) {
      const raw = Buffer.from(cipherB64, 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  };
}

async function startFakeAnthropicServer(
  handler: (req: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) => { status: number; body: unknown },
): Promise<{ url: string; received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> }> {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      received.push({ headers: req.headers, body });
      const out = handler({ headers: req.headers, body });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanServers.push(server);
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}/v1/messages`, received };
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanServers.length > 0) {
    const s = cleanServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 5b 提交②：Claude API Key 加密存储与验证', () => {
  it('先发最小请求验证再加密落盘；userData 磁盘、IPC 返回值与界面 HTML 均不出现特征 Key 明文', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-ckey-'));
    cleanDirs.push(dataDir);
    const srv = await startFakeAnthropicServer(() => ({
      status: 200,
      body: { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    }));

    const CANARY = 'sk-ant-CANARY-FEATURE-SECRET-9876';
    const store = new ClaudeKeyStore(dataDir, makeCryptoVault());
    const saved = await store.save(CANARY, { endpoint: srv.url });

    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('expected ok');
    expect(saved.status.configured).toBe(true);
    expect(saved.status.available).toBe(true);
    expect(saved.status.last4).toBe('9876');

    // 验证最小请求未携带工具定义且使用当前官方文档版本头与默认模型
    expect(srv.received).toHaveLength(1);
    expect(srv.received[0]!.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(srv.received[0]!.headers['x-api-key']).toBe(CANARY);
    expect(srv.received[0]!.body.model).toBe(DEFAULT_CLAUDE_API_MODEL);
    expect(srv.received[0]!.body.tools).toBeUndefined();

    // 全量扫描 userData 落盘文件（records + events.jsonl）、IPC 返回对象、外发说明与设置界面渲染
    const diskFiles = await walkFiles(dataDir);
    expect(diskFiles.length).toBeGreaterThan(0);
    for (const f of diskFiles) {
      const content = await fs.readFile(f, 'utf8');
      expect(content, f).not.toContain(CANARY);
      expect(content, f).not.toContain('CANARY-FEATURE-SECRET');
    }

    const status = await store.status();
    const disc = buildDisclosure({ codexInstalled: true, claudeApiConfigured: true, devPersonalClaude: false });
    await new DisclosureStore(dataDir).accept(disc);
    expect(JSON.stringify({ saved, status, disc })).not.toContain('CANARY-FEATURE-SECRET');

    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        tab: 'ai',
        disc: { content: disc, accepted: null },
        env: null,
        claudeKey: status,
        error: null,
        onTabChange: () => undefined,
        onShowDisclosure: () => undefined,
        onRefreshEnv: () => undefined,
      }),
    );
    expect(html).toContain('尾号 9876');
    expect(html).not.toContain('CANARY-FEATURE-SECRET');

    // 主进程仍可正常解密使用
    expect(await store.getSecret()).toBe(CANARY);
  });

  it('safeStorage 不可用时拒绝保存、说明原因且绝不明文落盘；已保存时若后续不可用也如实标为不可用', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-novault-'));
    cleanDirs.push(dataDir);
    let calls = 0;
    const srv = await startFakeAnthropicServer(() => {
      calls += 1;
      return { status: 200, body: { id: 'msg_1', type: 'message', content: [] } };
    });

    const unavailableState = { ok: false, reason: 'Linux 环境当前仅存在明文 basic_text 后端，拒绝保存密钥。' };
    const vault = makeCryptoVault(unavailableState);
    const store = new ClaudeKeyStore(dataDir, vault);

    const res = await store.save('sk-ant-CANARY-NO-PLAINTEXT-1122', { endpoint: srv.url });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected fail');
    expect(res.category).toBe('storage_unavailable');
    expect(res.message).toContain('basic_text');
    expect(calls).toBe(0); // 加密存储不可用时直接拒绝，连验证请求也不必要地保存

    const diskFiles = await walkFiles(dataDir);
    for (const f of diskFiles) {
      expect(await fs.readFile(f, 'utf8')).not.toContain('NO-PLAINTEXT');
    }
    expect(await store.status()).toMatchObject({ configured: false, available: false });

    // 先在可用时保存，随后环境变成不可用 → status().available=false 且 getSecret 拒绝解密
    unavailableState.ok = true;
    const saved = await store.save('sk-ant-CANARY-LATER-LOST-3344', { endpoint: srv.url });
    expect(saved.ok).toBe(true);
    unavailableState.ok = false;
    const s2 = await store.status();
    expect(s2.configured).toBe(true);
    expect(s2.available).toBe(false);
    expect(s2.last4).toBe('3344');
    await expect(store.getSecret()).rejects.toThrow(/basic_text/);
  });

  it('验证失败分类（Key 无效 / 网络不通 / 服务不可用）准确且绝不回显 Key，且不会误保存', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-kfail-'));
    cleanDirs.push(dataDir);
    const store = new ClaudeKeyStore(dataDir, makeCryptoVault());
    const SECRET = 'sk-ant-CANARY-FAIL-CASE-5566';

    // 1) Key 无效（即使服务端错误信息回显了密钥，也不得透出）
    const s401 = await startFakeAnthropicServer(() => ({
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${SECRET}` } },
    }));
    const r401 = await store.save(SECRET, { endpoint: s401.url });
    expect(r401).toMatchObject({ ok: false, category: 'invalid_key' });
    if (!r401.ok) {
      expect(r401.message).toContain('Key 无效');
      expect(r401.message).not.toContain(SECRET);
    }
    expect((await store.status()).configured).toBe(false);

    // 2) 网络不通
    const rNet = await validateAnthropicKey(SECRET, { endpoint: 'http://127.0.0.1:1/unreachable' });
    expect(rNet.ok).toBe(false);
    if (!rNet.ok) {
      expect(rNet.category).toBe('network_error');
      expect(rNet.reason).toContain('网络不通');
      expect(rNet.reason).not.toContain(SECRET);
    }

    // 3) 服务不可用（429 / 529 / 402）
    const s529 = await startFakeAnthropicServer(() => ({
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: `Overloaded for ${SECRET}` } },
    }));
    const r529 = await store.save(SECRET, { endpoint: s529.url });
    expect(r529).toMatchObject({ ok: false, category: 'service_unavailable' });
    if (!r529.ok) {
      expect(r529.message).toContain('服务不可用');
      expect(r529.message).not.toContain(SECRET);
    }
    expect((await store.status()).configured).toBe(false);
  });

  it('支持删除 Key，并触发回调使关联状态可立即回退', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-kdel-'));
    cleanDirs.push(dataDir);
    const srv = await startFakeAnthropicServer(() => ({ status: 200, body: { id: 'm', type: 'message', content: [] } }));
    const store = new ClaudeKeyStore(dataDir, makeCryptoVault());
    await store.save('sk-ant-CANARY-DEL-7788', { endpoint: srv.url });
    let cbCount = 0;
    const after = await store.delete(() => {
      cbCount += 1;
    });
    expect(cbCount).toBe(1);
    expect(after).toEqual({ configured: false, available: false, last4: null, verifiedAt: null, unavailableReason: null });
    expect(await store.getSecret()).toBeNull();
  });
});
