import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { codexLaunchConfig } from '../../src/core/executor/adapters/codex.js';
import { AppServerClient } from './appserver-client.js';
import { tmpDir } from '../helpers.js';

/**
 * 扩展隔离（hooks / notify / memories 等）。默认跳过：STUDIO_REAL_CODEX=1 npx vitest run tests/integration/extensions.real.test.ts
 * 正控会用本机已有的 Codex 登录发起一次极小的真实回合（只回复 ok）；不读取、不转发任何凭证。
 */
const enabled = process.env.STUDIO_REAL_CODEX === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('扩展隔离：hooks / notify / memories', () => {
  // hooks 的正控做不了：未经用户信任的 hook（trustStatus=untrusted）不会运行，而授予信任需要写用户配置。
  // hooks 的关闭改用官方的 hooks/list 证明：基线能列出用户层 hook，关闭后列表为空（见下一个测试）。
  it('正控：不关闭时，真实回合会触发 notify（证明哨兵方法能观察到）', async () => {
    const dir = await tmpDir('ext-pos-');
    const mark = path.join(dir, 'm');
    const c = new AppServerClient(
      [
        'app-server', '--listen', 'stdio://',
        '-c', `notify=["/bin/sh","-c","echo notify >> ${mark}-notify"]`,
        '--disable', 'plugins', '--disable', 'apps',
      ],
      { cwd: dir },
    );
    try {
      await c.init();
      const t = await c.rpc('thread/start', { cwd: dir, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'read-only' });
      const threadId = t.result?.thread?.id;
      expect(threadId).toBeTruthy();
      await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: '只回复 ok，不要做任何其他事。' }], cwd: dir, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
      expect(await c.waitFor('turn/completed', 90_000)).toBe(true);
      await sleep(1500);
      expect(fs.existsSync(`${mark}-notify`)).toBe(true);
    } finally {
      c.kill();
    }
  }, 120_000);

  it('我们的启动参数：用户层配置的 notify / hooks 哨兵被覆盖或关闭（config/read 与 hooks/list 为证），且没有任何哨兵被执行', async () => {
    const home = await tmpDir('ext-home-');
    const mark = path.join(home, 'm');
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `notify = ["/bin/sh","-c","echo notify >> ${mark}-notify"]\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo hook >> ${mark}-hook"\n`,
    );
    const cwd = await tmpDir('ext-cwd-');
    const base = new AppServerClient(['app-server', '--listen', 'stdio://'], { cwd, env: { CODEX_HOME: home } });
    try {
      await base.init();
      const before = await base.rpc('hooks/list', { cwds: [cwd] });
      expect(JSON.stringify(before.result)).toContain('sessionStart'); // 基线：用户层 hook 确实被加载
    } finally {
      base.kill();
    }
    const c = new AppServerClient(codexLaunchConfig(cwd, { mcpServers: [] }).args, { cwd, env: { CODEX_HOME: home } });
    try {
      await c.init();
      const cfg = await c.effectiveConfig(cwd);
      expect(cfg.notify).toEqual([]);
      expect(cfg.features).toMatchObject({ hooks: false, memories: false });
      expect(cfg.memories).toMatchObject({ use_memories: false, generate_memories: false });
      const hl = await c.rpc('hooks/list', { cwds: [cwd] });
      expect(hl.result?.data?.[0]?.hooks).toEqual([]);
      await c.rpc('thread/start', { cwd, ephemeral: true });
      await sleep(2000);
      expect(fs.existsSync(`${mark}-notify`)).toBe(false);
      expect(fs.existsSync(`${mark}-hook`)).toBe(false);
    } finally {
      c.kill();
    }
  }, 60_000);
});
