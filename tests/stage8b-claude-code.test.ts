import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCapabilities } from '../src/core/capabilities/model.js';
import { SubscriptionCliStore } from '../src/core/app/subscription-clis.js';
import { ClaudeCodeExecutor, claudeExecArgs } from '../src/core/executor/adapters/claude-code.js';
import { requireRiskAcknowledged } from '../src/core/executor/cli/subscriptions.js';
import type { FullTrustRecords } from '../src/core/executor/modes.js';
import type { ExecutorEvent } from '../src/core/executor/types.js';
import { RecordStore } from '../src/core/persistence/index.js';

const cleanDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function collectEvents(events: AsyncIterable<ExecutorEvent>): Promise<ExecutorEvent[]> {
  const out: ExecutorEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('阶段 8B 提交① · 本地订阅 CLI 风险门禁、状态持久化与 ClaudeCodeExecutor', () => {
  it('未勾选风险确认前禁止开启或启动 ClaudeCodeExecutor，勾选验证后持久化风险确认时间戳', async () => {
    const dataDir = await makeTempDir('studio-s8b-sub-');
    const store = new SubscriptionCliStore(dataDir);

    // 未确认风险前，requireRiskAcknowledged 直接拒绝
    await expect(requireRiskAcknowledged('claude_cli', store)).rejects.toThrow('尚未阅读并确认');

    // testAndEnable 不勾 riskAck === true 一律拒绝
    const rejected = await store.testAndEnable(
      { cliId: 'claude_cli', riskAck: false },
      async () => ({ installed: true, loggedIn: 'yes', version: '2.1.319' }),
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('勾选同意');

    // 未登录时即使勾了风险确认也不允许启用
    const unlogged = await store.testAndEnable(
      { cliId: 'claude_cli', riskAck: true },
      async () => ({ installed: true, loggedIn: 'no', version: '2.1.319' }),
    );
    expect(unlogged.ok).toBe(false);
    expect(unlogged.message).toContain('尚未登录');

    // 勾选风险确认且检测通过 → 持久化并转为 executorReady=true
    const ok = await store.testAndEnable(
      { cliId: 'claude_cli', riskAck: true, model: 'sonnet' },
      async () => ({ installed: true, loggedIn: 'yes', version: '2.1.319' }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.item.executorReady).toBe(true);
    expect(ok.item.riskAcknowledgedAt).toBeTruthy();
    expect(ok.item.model).toBe('sonnet');
    await expect(requireRiskAcknowledged('claude_cli', store)).resolves.toBeUndefined();

    // 停用并验证回到未启用状态
    await store.disable('claude_cli');
    await expect(requireRiskAcknowledged('claude_cli', store)).rejects.toThrow('尚未阅读并确认');
  });

  it('ClaudeCodeExecutor 生成受限安全参数、剔除宿主 API Key、校验 init 并转换 permission_denials 为 Blocked 事件', async () => {
    const dataDir = await makeTempDir('studio-s8b-cc-data-');
    const workDir = await makeTempDir('studio-s8b-cc-work-');
    const scriptDir = await makeTempDir('studio-s8b-cc-script-');
    const store = new SubscriptionCliStore(dataDir);

    // 未过门禁时直接 start() 立即以非 0 退出，绝不拉起任何进程
    const unapproved = new ClaudeCodeExecutor({
      command: process.execPath,
      prefixArgs: ['/nonexistent-should-never-run.js'],
      riskGate: store,
    });
    const deniedEvents = await collectEvents(
      unapproved.start({ cwd: workDir, prompt: 'test', capabilities: resolveCapabilities() }).events,
    );
    const deniedExit = deniedEvents.find((e) => e.type === 'exit');
    expect(deniedExit?.type).toBe('exit');
    if (deniedExit?.type === 'exit') expect(deniedExit.outcome.kind).toBe('exited');
    expect(deniedEvents.some((e) => e.type === 'message' && e.text.includes('尚未阅读并确认'))).toBe(true);

    // 验证标准参数与完全信任参数差异
    const stdArgs = claudeExecArgs(workDir, resolveCapabilities());
    expect(stdArgs).toContain('--safe-mode');
    expect(stdArgs).toContain('--restricted');
    expect(stdArgs).toContain('--strict-mcp-config');
    expect(stdArgs).toContain('--disable-slash-commands');
    expect(stdArgs).toContain('--no-session-persistence');
    expect(stdArgs).not.toContain('--dangerously-skip-permissions');

    // 写一个假 claude 脚本：校验未继承 ANTHROPIC_API_KEY、写出 init + tool_use + result（含 permission_denials）
    const fakeScript = path.join(scriptDir, 'fake-claude.mjs');
    await fs.writeFile(
      fakeScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'const args = process.argv.slice(2);',
        "if (args[0] === '--version') { console.log('2.1.319 (Claude Code)'); process.exit(0); }",
        "if (args[0] === 'auth' && args[1] === 'status') { process.exit(0); }",
        "if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) { console.error('LEAKED_ENV_KEY'); process.exit(9); }",
        "let stdinBuf = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', d => stdinBuf += d);",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', tools: ['Read', 'Edit', 'Write'], mcp_servers: [], slash_commands: [] }));",
        "  fs.writeFileSync(path.join(process.cwd(), 'hello.txt'), 'by-claude-sub\\n');",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'hello.txt' } }, { type: 'text', text: '已写入 hello.txt' }] } }));",
        "  console.log(JSON.stringify({ type: 'result', is_error: false, result: '完成任务。', permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu2', tool_input: { command: 'rm -rf /outside' } }] }));",
        '});',
      ].join('\n'),
      'utf8',
    );

    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-stripped';
    try {
      await store.testAndEnable(
        { cliId: 'claude_cli', riskAck: true },
        async () => ({ installed: true, loggedIn: 'yes', version: '2.1.319' }),
      );
      const exec = new ClaudeCodeExecutor({
        command: process.execPath,
        prefixArgs: [fakeScript],
        riskGate: store,
      });
      const det = await exec.detect();
      expect(det.installed).toBe(true);
      expect(det.loggedIn).toBe('yes');

      const events = await collectEvents(
        exec.start({ cwd: workDir, prompt: '写 hello.txt', capabilities: resolveCapabilities() }).events,
      );
      expect(await fs.readFile(path.join(workDir, 'hello.txt'), 'utf8')).toBe('by-claude-sub\n');
      expect(events.some((e) => e.type === 'tool' && e.name === 'file_change' && e.summary === 'hello.txt')).toBe(true);
      const blocked = events.filter((e) => e.type === 'blocked');
      expect(blocked).toHaveLength(1);
      if (blocked[0]?.type === 'blocked') {
        expect(blocked[0].operation.kind).toBe('run_command');
        expect(blocked[0].operation.risk).toBe('high');
      }
      const exitEv = events.find((e) => e.type === 'exit');
      expect(exitEv?.type).toBe('exit');
      if (exitEv?.type === 'exit') {
        expect(exitEv.outcome).toEqual({ kind: 'exited', code: 0 });
        expect(exitEv.denied).toHaveLength(1);
      }

      // 若 full_trust 未确认门禁同样拒绝启动
      const noTrust: FullTrustRecords = { get: async () => null };
      const ftEvents = await collectEvents(
        exec.start({
          taskId: 't-ft',
          cwd: workDir,
          prompt: 'x',
          capabilities: resolveCapabilities({ constructionMode: 'full_trust' }),
          fullTrustRecords: noTrust,
        }).events,
      );
      expect(ftEvents.some((e) => e.type === 'message' && e.text.includes('完全信任模式未获确认'))).toBe(true);
    } finally {
      if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });

  it('ClaudeCodeExecutor 支持立即 stop() 停止运行中的子进程并忽略非空 mcp_servers 的失控初始化', async () => {
    const dataDir = await makeTempDir('studio-s8b-stop-data-');
    const workDir = await makeTempDir('studio-s8b-stop-work-');
    const scriptDir = await makeTempDir('studio-s8b-stop-script-');
    const store = new SubscriptionCliStore(dataDir);
    await store.testAndEnable(
      { cliId: 'claude_cli', riskAck: true },
      async () => ({ installed: true, loggedIn: 'yes', version: '2.1.319' }),
    );

    const hangScript = path.join(scriptDir, 'hang-claude.mjs');
    await fs.writeFile(
      hangScript,
      [
        "process.stdin.resume();",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [], slash_commands: [] }));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    const exec = new ClaudeCodeExecutor({
      command: process.execPath,
      prefixArgs: [hangScript],
      riskGate: store,
    });
    const runHandle = exec.start({ cwd: workDir, prompt: 'hang', capabilities: resolveCapabilities() });
    const collected: ExecutorEvent[] = [];
    const reader = (async () => {
      for await (const ev of runHandle.events) {
        collected.push(ev);
        if (ev.type === 'message') {
          setTimeout(() => void runHandle.stop(), 50);
        }
      }
    })();
    await reader;
    const exitEv = collected.find((e) => e.type === 'exit');
    expect(exitEv?.type).toBe('exit');
    if (exitEv?.type === 'exit') expect(exitEv.outcome.kind).toBe('stopped');

    // init 报告残留 mcp_servers 时应立刻拒绝并杀掉进程
    const leakyScript = path.join(scriptDir, 'leaky-claude.mjs');
    await fs.writeFile(
      leakyScript,
      [
        "process.stdin.resume();",
        "console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'rogue' }], slash_commands: [] }));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );
    const leakyExec = new ClaudeCodeExecutor({
      command: process.execPath,
      prefixArgs: [leakyScript],
      riskGate: store,
    });
    const leakyEvents = await collectEvents(
      leakyExec.start({ cwd: workDir, prompt: 'leak', capabilities: resolveCapabilities() }).events,
    );
    expect(leakyEvents.some((e) => e.type === 'message' && e.text.includes('隔离无法确认'))).toBe(true);
  });
});
