// 最小 Codex app-server 客户端（stdio，换行分隔的 JSON-RPC，省略 "jsonrpc" 字段）。
// 官方文档：https://learn.chatgpt.com/docs/app-server ；协议 schema 可用 `codex app-server generate-json-schema --out <dir>` 生成。
import { spawn } from 'node:child_process';

export function startAppServer({ cwd, args = [], env = {}, onServerRequest, onNotification }) {
  const child = spawn('codex', ['app-server', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const log = [];            // 所有收发消息（用于样本）
  let nextId = 1, buf = '', stderr = '';
  const write = (o) => { log.push({ dir: 'out', ...o }); child.stdin.write(JSON.stringify(o) + '\n'); };
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      log.push({ dir: 'in', t: Date.now(), ...m });
      if (m.id !== undefined && m.method) {                        // 服务端发来的请求（审批等）
        const decision = onServerRequest?.(m);
        write({ id: m.id, result: decision ?? {} });
      } else if (m.id !== undefined) {                             // 对我们请求的响应
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result);
      } else onNotification?.(m);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); write({ method, id, params }); });
  const notify = (method, params = {}) => write({ method, params });
  const exited = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
  return { child, request, notify, log, exited, stderr: () => stderr, close: () => child.kill('SIGTERM') };
}

export async function handshake(srv) {
  await srv.request('initialize', { clientInfo: { name: 'ai_solo_studio_spike', title: 'AI Solo Studio spike', version: '0.0.1' } });
  srv.notify('initialized', {});
}
