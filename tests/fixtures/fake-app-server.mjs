// 可脚本化的假 codex app-server（stdio，换行分隔 JSON-RPC）。仅用于测试。
// 剧本：环境变量 FAKE_APP_SCRIPT（JSON 数组）；记录：环境变量 FAKE_RECORD（JSON 行文件）。
// 步骤：{say}、{cmd:{command,cwd}}、{fileStart:{id,changes}}、{fileDone:{id,changes,status}}、
//      {askCommand:{command,cwd,reason}}、{askFile:{itemId,reason,grantRoot}}、{askOther:{method}}、
//      {sleep:ms}、{hang:{ignoreInterrupt}}、{complete:{status,error}}、{crash:code}
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const script = JSON.parse(process.env.FAKE_APP_SCRIPT ?? '[]');
const record = (o) => process.env.FAKE_RECORD && appendFileSync(process.env.FAKE_RECORD, JSON.stringify(o) + '\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
record({ kind: 'argv', argv: process.argv.slice(2) });

// 假的“实际生效配置”：根据启动参数推导，模拟真实 app-server 的 config/read、hooks/list 与 thread/start 响应。
// FAKE_IGNORE（逗号分隔）让指定项“不生效”，用来测试启动后核验：approval,sandbox,network,notify,hooks,memories,login_shell,mcp,hooks_list
// FAKE_CONFIG_ERROR=1 让 config/read 报错；FAKE_MCP_CONFIGURED 为 JSON 数组，表示用户配置里的 MCP 服务名。
const argv = process.argv.slice(2);
const cflags = argv.flatMap((x, i) => (x === '-c' ? [argv[i + 1]] : []));
const disabledFeatures = argv.flatMap((x, i) => (x === '--disable' ? [argv[i + 1]] : []));
const ignore = (process.env.FAKE_IGNORE ?? '').split(',').filter(Boolean);
const mcpConfigured = JSON.parse(process.env.FAKE_MCP_CONFIGURED ?? '[]');
const flagIs = (kv) => cflags.includes(kv);
function effectiveConfig() {
  const off = (k) => !ignore.includes(k);
  const mcp_servers = Object.fromEntries(
    mcpConfigured.map((n) => [n, { enabled: !(off('mcp') && (flagIs(`mcp_servers.${n}.enabled=false`) || flagIs(`mcp_servers."${n}".enabled=false`))) }]),
  );
  return {
    notify: off('notify') && flagIs('notify=[]') ? [] : ['/bin/sh', '-c', 'x'],
    features: { hooks: !(off('hooks') && disabledFeatures.includes('hooks')), memories: !(off('memories') && disabledFeatures.includes('memories')) },
    memories: { use_memories: !(off('memories') && flagIs('memories.use_memories=false')), generate_memories: !(off('memories') && flagIs('memories.generate_memories=false')) },
    allow_login_shell: !(off('login_shell') && flagIs('allow_login_shell=false')),
    mcp_servers,
  };
}
function threadResult(p) {
  const sb = p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
  return {
    thread: { id: 'thread-1' },
    model: 'fake-model',
    approvalPolicy: ignore.includes('approval') ? 'on-request' : p.approvalPolicy,
    sandbox: { type: ignore.includes('sandbox') ? 'dangerFullAccess' : sb, networkAccess: ignore.includes('network') },
    instructionSources: ['/home/u/.codex/AGENTS.md'],
  };
}

let turnId = 'turn-1';
let nextServerId = 100;
let interrupted = false;
let ignoreInterrupt = false;
let wake;
const pending = new Map();

const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const item = (type, extra) => ({ type, id: `item-${Math.random().toString(36).slice(2, 8)}`, ...extra });
const notify = (method, params) => send({ method, params });
const complete = (status, error) => notify('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status, error: error ? { message: error } : null, items: [] } });

async function play() {
  for (const step of script) {
    if (interrupted && !ignoreInterrupt) return;
    if (step.say !== undefined) {
      const i = item('agentMessage', { text: step.say });
      notify('item/started', { threadId: 'thread-1', turnId, item: { ...i, text: '' } });
      notify('item/completed', { threadId: 'thread-1', turnId, item: i });
    } else if (step.cmd) {
      const i = item('commandExecution', { command: step.cmd.command, cwd: step.cmd.cwd ?? process.cwd(), status: 'inProgress' });
      notify('item/started', { threadId: 'thread-1', turnId, item: i });
      notify('item/completed', { threadId: 'thread-1', turnId, item: { ...i, status: 'completed' } });
    } else if (step.fileStart) {
      notify('item/started', { threadId: 'thread-1', turnId, item: { type: 'fileChange', id: step.fileStart.id, status: 'inProgress', changes: step.fileStart.changes.map((c) => ({ path: c.path, kind: { type: c.kind }, diff: '' })) } });
    } else if (step.fileDone) {
      notify('item/completed', { threadId: 'thread-1', turnId, item: { type: 'fileChange', id: step.fileDone.id, status: step.fileDone.status ?? 'completed', changes: step.fileDone.changes.map((c) => ({ path: c.path, kind: { type: c.kind }, diff: '' })) } });
    } else if (step.askCommand) {
      const r = await ask('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId, itemId: 'cmd-item', ...step.askCommand });
      record({ kind: 'decision', request: 'command', result: r });
    } else if (step.askFile) {
      const r = await ask('item/fileChange/requestApproval', { threadId: 'thread-1', turnId, ...step.askFile });
      record({ kind: 'decision', request: 'fileChange', result: r });
    } else if (step.askOther) {
      const r = await ask(step.askOther.method, { threadId: 'thread-1', turnId });
      record({ kind: 'decision', request: step.askOther.method, result: r });
    } else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
    else if (step.hang) {
      ignoreInterrupt = !!step.hang.ignoreInterrupt;
      await new Promise((r) => (wake = r));
      if (interrupted && !ignoreInterrupt) return;
    } else if (step.complete) return complete(step.complete.status, step.complete.error);
    else if (step.crash !== undefined) process.exit(step.crash);
  }
  complete('completed');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record({ kind: 'recv', msg: m });
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake-app-server/0.0.0' } });
  else if (m.method === 'thread/start') {
    send({ id: m.id, result: threadResult(m.params ?? {}) });
    // 模拟隔离失败：FAKE_MCP_LEAK 指定的服务器仍然启动
    if (process.env.FAKE_MCP_LEAK) notify('mcpServer/startupStatus/updated', { name: process.env.FAKE_MCP_LEAK, status: 'ready', threadId: 'thread-1' });
  }
  else if (m.method === 'config/read') {
    if (process.env.FAKE_CONFIG_ERROR) send({ id: m.id, error: { code: -32000, message: 'config unavailable' } });
    else send({ id: m.id, result: { config: effectiveConfig() } });
  } else if (m.method === 'hooks/list') {
    const present = ignore.includes('hooks_list');
    send({ id: m.id, result: { data: [{ cwd: process.cwd(), hooks: present ? [{ key: 'k' }] : [], warnings: [], errors: [] }] } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    notify('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [] } });
    play();
  } else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    interrupted = true;
    if (!ignoreInterrupt) {
      complete('interrupted');
      wake?.();
    }
  } else if (m.id !== undefined && !m.method) {
    const r = pending.get(m.id);
    pending.delete(m.id);
    r?.(m.error ? { error: m.error } : m.result);
  }
});
process.on('SIGTERM', () => process.exit(143));
