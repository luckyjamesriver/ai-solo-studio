import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor } from '../../src/core/executor/adapters/codex.js';
import { tmpDir } from '../helpers.js';

/**
 * 哨兵测试（默认跳过）：用一个临时 CODEX_HOME（不碰用户的 ~/.codex）配置“哨兵 MCP”，
 * 它一旦被启动就写标记文件。运行：STUDIO_REAL_CODEX=1 npx vitest run tests/integration/sentinel.real.test.ts
 */
const enabled = process.env.STUDIO_REAL_CODEX === '1';
const SENTINEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sentinel-mcp.mjs');

async function sentinelHome() {
  const home = await tmpDir('codex-home-');
  const marker = path.join(home, 'marker');
  fs.writeFileSync(path.join(home, 'config.toml'), `[mcp_servers.sentinel]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(SENTINEL)}]\nenv = { SENTINEL_FILE = ${JSON.stringify(marker)} }\n`);
  return { home, marker };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('哨兵 MCP：配置名单的获取过程不会启动 MCP', () => {
  it('正控：不做任何关闭，thread/start 之后哨兵确实会被启动（证明这个方法能观察到启动）', async () => {
    const { home, marker } = await sentinelHome();
    const cwd = await tmpDir('codex-cwd-');
    const c = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiting = new Map<number, () => void>();
    c.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        const m = JSON.parse(l);
        if (m.id !== undefined && !m.method) waiting.get(m.id)?.();
      }
    });
    let id = 1;
    const rpc = (method: string, params: object) => new Promise<void>((r) => { const i = id++; waiting.set(i, r); c.stdin.write(`${JSON.stringify({ method, id: i, params })}\n`); });
    try {
      await rpc('initialize', { clientInfo: { name: 't', title: 't', version: '0' } });
      c.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      expect(fs.existsSync(marker)).toBe(false); // initialize 之后、thread/start 之前还没启动
      await rpc('thread/start', { cwd, ephemeral: true });
      await sleep(3000);
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      c.kill('SIGKILL');
    }
  }, 60_000);

  it('现行的名单获取流程：拿到 sentinel 名字，且等待后标记文件仍不存在', async () => {
    const { home, marker } = await sentinelHome();
    const cwd = await tmpDir('codex-cwd-');
    const ex = new CodexExecutor({ env: { CODEX_HOME: home } });
    const names = await (ex as unknown as { discoverMcpServers(cwd: string): Promise<string[]> }).discoverMcpServers(cwd);
    expect(names).toEqual(['sentinel']);
    await sleep(3000);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it('完整启动流程（名单 → 逐个关闭 → 启动后核验）：哨兵始终没有被启动', async () => {
    const { home, marker } = await sentinelHome();
    const cwd = await tmpDir('codex-cwd-');
    const ex = new CodexExecutor({ env: { CODEX_HOME: home }, mcpSettleMs: 1500 });
    const run = ex.start({ cwd, prompt: '只回复 ok', timeoutMs: 20_000 });
    const events: string[] = [];
    for await (const e of run.events) events.push(e.type === 'message' ? e.text : e.type);
    await sleep(1500);
    // 临时 CODEX_HOME 没有登录，回合本身可能失败；这里只关心哨兵
    expect(events.join('\n')).not.toMatch(/仍然启动了/);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
