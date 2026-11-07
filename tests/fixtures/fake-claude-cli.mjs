// 假的 claude 命令行：用于测试 ClaudeCliThinker。FAKE_CLAUDE 选择行为；FAKE_CLAUDE_RECORD 记录 argv / stdin / 环境。
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE ?? 'ok';
if (a[0] === '--version') { console.log('2.1.999 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') process.exit(process.env.FAKE_LOGIN === 'no' ? 1 : 0);
let stdin = '';
process.stdin.setEncoding('utf8').on('data', (d) => (stdin += d)).on('end', () => {
  if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: a, stdin, hasApiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd() }) + '\n');
  const out = (o) => console.log(JSON.stringify(o));
  if (mode === 'hang') return setInterval(() => {}, 1000);
  const init = { type: 'system', subtype: 'init', model: 'claude-fake', tools: mode === 'tools' ? ['Bash'] : [], mcp_servers: [], skills: [], slash_commands: [], plugins: [{ name: 'p' }] };
  if (mode === 'noinit') {
    out({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}' });
    return;
  }
  out(init);
  const answer = { ok: { text: '{"verdict":"ok","points":["a","b"]}' }, fenced: { text: '好的：\n```json\n{"verdict":"ok","points":[]}\n```' }, badjson: { text: '这不是 JSON' }, missing: { text: '{"verdict":"ok"}' } };
  if (answer[mode]) {
    out({ type: 'result', subtype: 'success', is_error: false, result: answer[mode].text, total_cost_usd: 0.01, usage: { input_tokens: 11, output_tokens: 7 }, modelUsage: { 'claude-fake': { inputTokens: 11, outputTokens: 7 } } });
    return;
  }
  const errs = { ratelimit: 'API Error: Request rejected (429) · this may be a temporary capacity issue', quota: "You've hit your weekly limit · resets Mon 9:00am", auth: 'Not logged in · Please run /login', credit: 'Credit balance is too low', other: 'something odd happened' };
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: errs[mode] ?? 'unknown' });
  process.exit(1);
});
