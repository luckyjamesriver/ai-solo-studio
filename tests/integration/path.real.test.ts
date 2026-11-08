import { describe, it, expect } from 'vitest';
import { codexLaunchConfig } from '../../src/core/executor/adapters/codex.js';
import { AppServerClient } from './appserver-client.js';
import { tmpDir } from '../helpers.js';
import { realEnabled } from './gate.js';

/** 关闭登录 shell 后，真实回合里的命令能否找到 node / npm？（默认跳过；开关见 gate.ts，套件名 path） */
const enabled = realEnabled('path');

describe.skipIf(!enabled)('PATH：关闭登录 shell 后', () => {
  it('真实回合中运行 node --version 与 npm --version', async () => {
    const cwd = await tmpDir('path-');
    const cfg = codexLaunchConfig(cwd, { mcpServers: [] });
    const c = new AppServerClient(cfg.args, { cwd });
    c.approve = true;
    try {
      await c.init();
      const t = await c.rpc('thread/start', cfg.threadStart);
      const threadId = t.result?.thread?.id;
      await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: '依次用 shell 运行 `node --version` 和 `npm --version`（分别运行，各一条命令），然后回复 done。不要运行其他命令。' }], ...cfg.turnOverrides });
      expect(await c.waitFor('turn/completed', 90_000)).toBe(true);
      const done = c.notifications.filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution').map((n) => n.params.item);
      const out = done.map((i) => ({ cmd: String(i.command), exit: i.exitCode, out: String(i.aggregatedOutput ?? '').trim().slice(0, 120) }));
      console.info(`[real-codex] PATH 实测：${JSON.stringify(out)}`);
      const node = out.find((o) => /node --version/.test(o.cmd));
      const npm = out.find((o) => /npm --version/.test(o.cmd));
      expect(node?.exit).toBe(0);
      expect(npm?.exit).toBe(0);
    } finally {
      c.kill();
    }
  }, 120_000);
});
