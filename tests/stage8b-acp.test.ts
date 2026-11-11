import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCapabilities } from '../src/core/capabilities/model.js';
import { SubscriptionCliStore } from '../src/core/app/subscription-clis.js';
import { AcpExecutor, acpExecArgs } from '../src/core/executor/adapters/acp.js';
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

describe('阶段 8B 提交② · 通用 ACP 执行适配器（Antigravity & Cursor CLI）', () => {
  it('未确认风险前拒绝启动；agy 与 cursor 参数生成遵守受限沙箱与无跳过权限标志', async () => {
    const dataDir = await makeTempDir('studio-s8b-acp-data-');
    const workDir = await makeTempDir('studio-s8b-acp-work-');
    const store = new SubscriptionCliStore(dataDir);

    const agyArgs = acpExecArgs('agy', workDir, resolveCapabilities({ extraWritableDirs: ['/tmp/extra'] }));
    expect(agyArgs).toEqual([
      'acp',
      '--sandbox',
      '--include-default-customizations=false',
      '--stdio',
      '--add-dir',
      '/tmp/extra',
    ]);

    const cursorArgs = acpExecArgs('cursor', workDir, resolveCapabilities(), { model: 'gpt-5' });
    expect(cursorArgs).toEqual(['--sandbox', 'enabled', '--workspace', workDir, '--model', 'gpt-5', 'acp']);
    expect([...agyArgs, ...cursorArgs].join(' ')).not.toMatch(/dangerously|--yolo|--trust/);

    const agyUnapproved = new AcpExecutor({ cliId: 'agy', command: 'nonexistent', riskGate: store });
    const events = await collectEvents(
      agyUnapproved.start({ cwd: workDir, prompt: 'test', capabilities: resolveCapabilities() }).events,
    );
    expect(events.some((e) => e.type === 'message' && e.text.includes('尚未阅读并确认'))).toBe(true);
    const exitEv = events.find((e) => e.type === 'exit');
    expect(exitEv?.type === 'exit' && exitEv.outcome.kind === 'exited').toBe(true);
  });

  it('ACP 会话执行：放行副本内编辑、reject-once 拦截副本外写/.git 写与高危命令并记录为 Blocked', async () => {
    const dataDir = await makeTempDir('studio-s8b-acp-run-data-');
    const workDir = await makeTempDir('studio-s8b-acp-run-work-');
    const scriptDir = await makeTempDir('studio-s8b-acp-script-');
    const store = new SubscriptionCliStore(dataDir);
    await store.testAndEnable(
      { cliId: 'agy', riskAck: true },
      async () => ({ installed: true, loggedIn: 'unknown', version: '1.5.3' }),
    );

    const decisionLogPath = path.join(scriptDir, 'decisions.json');
    const fakeAcpScript = path.join(scriptDir, 'fake-acp.mjs');
    await fs.writeFile(
      fakeAcpScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        `const LOG = ${JSON.stringify(decisionLogPath)};`,
        'const args = process.argv.slice(2);',
        "if (args[0] === '--version') { console.log('1.5.3'); process.exit(0); }",
        "if (process.env.OPENAI_API_KEY || process.env.CURSOR_API_KEY) { console.error('LEAKED_ENV'); process.exit(9); }",
        'const decisions = [];',
        'let pendingPromptId = null;',
        'function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }',
        "let buf = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (d) => {",
        '  buf += d;',
        '  let i;',
        "  while ((i = buf.indexOf('\\n')) >= 0) {",
        '    const line = buf.slice(0, i).trim();',
        '    buf = buf.slice(i + 1);',
        '    if (!line) continue;',
        '    const m = JSON.parse(line);',
        "    if (m.method === 'initialize') {",
        "      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });",
        "    } else if (m.method === 'session/new') {",
        "      send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-1' } });",
        "    } else if (m.method === 'session/prompt') {",
        '      pendingPromptId = m.id;',
        "      if (args.includes('probe-only')) return;",
        "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', kind: 'edit', title: 'edit ok', locations: [{ path: 'app.txt' }] } } });",
        // 请求1：副本内安全文件编辑 → 期望 allow-once
        "      send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { kind: 'edit', title: 'Write app.txt', locations: [{ path: path.join(process.cwd(), 'app.txt') }] }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } });",
        // 请求2：越界写 /tmp 外部文件 → 期望 reject-once
        "      send({ jsonrpc: '2.0', id: 'perm-2', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { kind: 'edit', title: 'Write outside', locations: [{ path: '/etc/evil.txt' }] }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } });",
        // 请求3：写 .git/config → 期望 reject-once
        "      send({ jsonrpc: '2.0', id: 'perm-3', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { kind: 'edit', title: 'Write git config', locations: [{ path: path.join(process.cwd(), '.git/config') }] }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } });",
        // 请求4：高危 rm 命令 → 期望 reject-once
        "      send({ jsonrpc: '2.0', id: 'perm-4', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { kind: 'execute', title: 'Danger cmd', rawInput: { command: 'rm -rf /tmp/x' } }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } });",
        '    } else if (m.id && String(m.id).startsWith("perm-")) {',
        '      decisions.push({ id: m.id, optionId: m.result?.outcome?.optionId });',
        '      if (decisions.length === 4) {',
        '        fs.writeFileSync(LOG, JSON.stringify(decisions));',
        "        fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'acp-ok\\n');",
        "        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成 app.txt 修改，越界操作已取消。' } } } });",
        "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });",
        '      }',
        '    }',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );

    const oldOpenai = process.env.OPENAI_API_KEY;
    const oldCursor = process.env.CURSOR_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-be-stripped';
    process.env.CURSOR_API_KEY = 'cur-should-be-stripped';
    try {
      const exec = new AcpExecutor({
        cliId: 'agy',
        command: process.execPath,
        prefixArgs: [fakeAcpScript],
        riskGate: store,
      });
      const det = await exec.detect();
      expect(det.installed).toBe(true);
      expect(det.version).toBe('1.5.3');

      const events = await collectEvents(
        exec.start({ cwd: workDir, prompt: '写 app.txt', capabilities: resolveCapabilities() }).events,
      );
      expect(await fs.readFile(path.join(workDir, 'app.txt'), 'utf8')).toBe('acp-ok\n');
      const recordedDecisions = JSON.parse(await fs.readFile(decisionLogPath, 'utf8')) as Array<{ id: string; optionId: string }>;
      expect(recordedDecisions).toEqual([
        { id: 'perm-1', optionId: 'allow-once' },
        { id: 'perm-2', optionId: 'reject-once' },
        { id: 'perm-3', optionId: 'reject-once' },
        { id: 'perm-4', optionId: 'reject-once' },
      ]);
      const blocked = events.filter((e) => e.type === 'blocked');
      expect(blocked).toHaveLength(3);
      const exitEv = events.find((e) => e.type === 'exit');
      expect(exitEv?.type === 'exit' && exitEv.outcome.kind === 'exited' && exitEv.outcome.code === 0).toBe(true);
      if (exitEv?.type === 'exit') expect(exitEv.denied).toHaveLength(3);
    } finally {
      if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenai;
      if (oldCursor === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = oldCursor;
    }
  });

  it('Cursor CLI detect() 正确识别登录态并支持 stop() 发送 session/cancel 停止子进程', async () => {
    const dataDir = await makeTempDir('studio-s8b-cur-data-');
    const workDir = await makeTempDir('studio-s8b-cur-work-');
    const scriptDir = await makeTempDir('studio-s8b-cur-script-');
    const store = new SubscriptionCliStore(dataDir);
    await store.testAndEnable(
      { cliId: 'cursor', riskAck: true },
      async () => ({ installed: true, loggedIn: 'yes', version: '2026.11' }),
    );

    const fakeCursor = path.join(scriptDir, 'fake-agent.mjs');
    await fs.writeFile(
      fakeCursor,
      [
        'const args = process.argv.slice(2);',
        "if (args[0] === '--version') { console.log('2026.11.05'); process.exit(0); }",
        "if (args[0] === 'status') { console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: true })); process.exit(0); }",
        'function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }',
        "let buf = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (d) => {",
        '  buf += d;',
        '  let i;',
        "  while ((i = buf.indexOf('\\n')) >= 0) {",
        '    const line = buf.slice(0, i).trim();',
        '    buf = buf.slice(i + 1);',
        '    if (!line) continue;',
        '    const m = JSON.parse(line);',
        "    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });",
        "    else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'cur-1' } });",
        "    else if (m.method === 'session/cancel') process.exit(0);",
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );

    const exec = new AcpExecutor({
      cliId: 'cursor',
      command: process.execPath,
      prefixArgs: [fakeCursor],
      riskGate: store,
    });
    const det = await exec.detect();
    expect(det.installed).toBe(true);
    expect(det.loggedIn).toBe('yes');

    const handle = exec.start({ cwd: workDir, prompt: 'hang', capabilities: resolveCapabilities() });
    const events: ExecutorEvent[] = [];
    for await (const ev of handle.events) {
      events.push(ev);
      if (ev.type === 'isolation') {
        setTimeout(() => void handle.stop(), 40);
      }
    }
    const exitEv = events.find((e) => e.type === 'exit');
    expect(exitEv?.type === 'exit' && exitEv.outcome.kind === 'stopped').toBe(true);
  });
});
