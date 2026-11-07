#!/usr/bin/env node
// 最小 MCP stdio 服务器，只提供一个工具 approve，用作 `claude --permission-prompt-tool mcp__perm__approve`。
// Claude Code 需要权限时会调用它；我们把请求记到 PERM_LOG，并按 PERM_DECISION(allow|deny) 回答。
// 真实集成时，这里应改为把请求转发给主应用（IPC / 本地 socket），由用户在界面上点“允许/拒绝”。
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const decision = process.env.PERM_DECISION === 'deny' ? 'deny' : 'allow';
const log = (o) => process.env.PERM_LOG && appendFileSync(process.env.PERM_LOG, JSON.stringify(o) + '\n');
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'perm', version: '0.0.1' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: [{ name: 'approve', description: 'Approve or deny a tool use', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
  } else if (m.method === 'tools/call') {
    const a = m.params?.arguments ?? {};
    log({ at: new Date().toISOString(), request: a, decision });
    const out = decision === 'allow' ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: '用户在 spike 中拒绝了这次操作' };
    send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
  } else if (m.id !== undefined) {
    send({ id: m.id, result: {} });
  }
});
