import { describe, it, expect } from 'vitest';
import { codexLaunchConfig } from '../../src/core/executor/adapters/codex.js';
import { resolveCapabilities } from '../../src/core/capabilities/model.js';
import { AppServerClient } from './appserver-client.js';
import { tmpDir } from '../helpers.js';

/**
 * 实测：命令执行“每次询问”需要哪个 approval_policy？（默认跳过；STUDIO_REAL_CODEX=1 运行，会发起两次极小的真实回合）
 * 结论（ADR 0001）：沙箱内的命令只有 untrusted 才会先询问；on-request 对沙箱内命令不询问。
 */
const enabled = process.env.STUDIO_REAL_CODEX === '1';
const PROMPT = '用 shell 命令运行 `ls` 查看当前目录，然后回复 done。不要用其他方式。';

async function commandApprovals(commandExecution: 'ask_each' | 'sandbox_auto') {
  const cwd = await tmpDir('ap-');
  const cfg = codexLaunchConfig(cwd, { mcpServers: [], capabilities: resolveCapabilities({ commandExecution }) });
  const c = new AppServerClient(cfg.args, { cwd });
  try {
    await c.init();
    const t = await c.rpc('thread/start', cfg.threadStart);
    const threadId = t.result?.thread?.id;
    expect(t.result?.approvalPolicy).toBe(cfg.expected.approvalPolicy); // 实际生效值
    await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: PROMPT }], ...cfg.turnOverrides });
    expect(await c.waitFor('turn/completed', 90_000)).toBe(true);
    const asked = c.serverRequests.filter((r) => r.method === 'item/commandExecution/requestApproval').length;
    const ran = c.notifications.filter((n) => n.method === 'item/started' && n.params?.item?.type === 'commandExecution').length;
    return { asked, ran };
  } finally {
    c.kill();
  }
}

describe.skipIf(!enabled)('approval_policy 实测：命令执行“每次询问”', () => {
  it('ask_each（untrusted）：沙箱内的 ls 也先询问', async () => {
    const r = await commandApprovals('ask_each');
    expect(r.ran).toBeGreaterThan(0);
    expect(r.asked).toBeGreaterThan(0);
  }, 120_000);
  it('sandbox_auto（on-request）：沙箱内的 ls 不询问（对照，说明它不满足“每次询问”）', async () => {
    const r = await commandApprovals('sandbox_auto');
    expect(r.ran).toBeGreaterThan(0);
    expect(r.asked).toBe(0);
  }, 120_000);
});
