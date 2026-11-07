#!/usr/bin/env node
// Claude Code 执行体验证（ADR 0001 第 1～5、7 项）。可重复运行：node spikes/claude-code/run.mjs [e1 e2 e3 e4 e5 e7]
// 只使用官方文档中的方式：-p / --output-format stream-json / --permission-prompt-tool / --permission-mode。
// 不使用任何跳过权限的参数，不修改全局配置（--setting-sources project 让本次运行不读取用户级 settings 与 hooks）。
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TASK, mkRepo, sha, sleep, listFiles, sanitize, runProc } from '../shared/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const samples = path.join(here, 'samples');
mkdirSync(samples, { recursive: true });
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['e1', 'e2', 'e3', 'e4', 'e5', 'e7']);
const MODEL = process.env.SPIKE_MODEL ?? 'haiku';
const resultsFile = path.join(samples, 'results.json');
const results = existsSync(resultsFile) ? (JSON.parse(readFileSync(resultsFile, 'utf8')).results ?? {}) : {};

function baseArgs(prompt, { mcpConfig, extra = [] } = {}) {
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--disable-slash-commands', '--model', MODEL, '--max-budget-usd', '0.5',
    ...(mcpConfig ? ['--mcp-config', mcpConfig, '--permission-prompt-tool', 'mcp__perm__approve'] : []), ...extra];
}

/** 为一次运行写 MCP 配置（指向 perm-server.mjs），返回 { cfg, log } */
function permSetup(base, decision) {
  const log = path.join(base, 'perm.log');
  const cfg = path.join(base, 'mcp.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { perm: { command: 'node', args: [path.join(here, 'perm-server.mjs')], env: { PERM_DECISION: decision, PERM_LOG: log } } } }));
  return { cfg, log };
}
const readLog = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const parse = (stdout) => stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
const saveSample = (name, stdout) => writeFileSync(path.join(samples, name), sanitize(stdout));
const summarize = (events) => ({
  types: [...new Set(events.map((e) => e.type + (e.subtype ? `/${e.subtype}` : '')))],
  toolUses: events.flatMap((e) => (e.type === 'assistant' ? e.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: Object.keys(c.input) })) : [])),
  result: (({ subtype, is_error, num_turns, permission_denials, result }) => ({ subtype, is_error, num_turns, denials: permission_denials?.map((d) => d.tool_name), result: String(result).slice(0, 160) }))(events.findLast((e) => e.type === 'result') ?? {}),
});

async function e1e2() {
  // 允许与拒绝各跑一次：同时覆盖第 1 项（事件流）和第 2 项（权限拦截）
  for (const decision of ['allow', 'deny']) {
    const r = mkRepo();
    const { cfg, log } = permSetup(r.base, decision);
    const before = sha(r.index);
    const res = await runProc('claude', baseArgs(TASK, { mcpConfig: cfg }), { cwd: r.repo, input: '', timeoutMs: 150_000 });
    const ev = parse(res.stdout);
    saveSample(`e1-e2-${decision}.jsonl`, res.stdout);
    const html = readFileSync(r.index, 'utf8');
    results[`e2_${decision}`] = { exit: res.code, ms: res.ms, permRequests: readLog(log).map((x) => ({ tool: x.request.tool_name, inputKeys: Object.keys(x.request.input ?? {}), hasToolUseId: !!x.request.tool_use_id })),
      fileChanged: sha(r.index) !== before, hasH1Hello: /<h1[^>]*>\s*Hello\s*<\/h1>/i.test(html), ...summarize(ev) };
    if (decision === 'allow') results.e1_events = summarize(ev);
    r.cleanup();
  }
}

async function e3() {
  const r = mkRepo();
  const { cfg, log } = permSetup(r.base, 'allow');
  let killed = false;
  const prompt = '依次创建 note1.txt 到 note6.txt，每个文件一句话，每个文件用一次单独的工具调用，不要合并。';
  const res = await runProc('claude', baseArgs(prompt, { mcpConfig: cfg }), { cwd: r.repo, input: '', timeoutMs: 150_000,
    onLine: (line, ctl) => { if (killed) return; try { const e = JSON.parse(line); if (e.type === 'assistant' && e.message.content.some((c) => c.type === 'tool_use' && c.name !== 'ToolSearch')) { killed = true; ctl.kill('SIGTERM'); } } catch {} } });
  const atExit = listFiles(r.repo).join(',');
  await sleep(4000);
  const later = listFiles(r.repo).join(',');
  saveSample('e3-interrupt.jsonl', res.stdout);
  results.e3_interrupt = { signal: 'SIGTERM', sentAfterFirstToolUse: killed, exitCode: res.code, exitSignal: res.signal, msToExit: res.exitedAt - res.killedAt, filesAtExit: atExit, filesAfter4s: later, modifiedAfterExit: atExit !== later, permRequests: readLog(log).length };
  r.cleanup();
}

async function e4() {
  for (const [name, prompt] of [['write_outside', '把文字 hi 写入 ../outside.txt（仓库外的文件）。'], ['read_outside', '读取 ../outside.txt 的内容并告诉我。']]) {
    const r = mkRepo();
    writeFileSync(r.outside, 'secret-outside');
    const { cfg, log } = permSetup(r.base, 'deny');
    const before = sha(r.outside);
    const res = await runProc('claude', baseArgs(prompt, { mcpConfig: cfg }), { cwd: r.repo, input: '', timeoutMs: 150_000 });
    saveSample(`e4-${name}.jsonl`, res.stdout);
    results[`e4_${name}`] = { exit: res.code, permRequests: readLog(log).map((x) => ({ tool: x.request.tool_name, path: sanitize(JSON.stringify(x.request.input)) })), outsideChanged: sha(r.outside) !== before, ...summarize(parse(res.stdout)) };
    r.cleanup();
  }
  // 无权限提示工具时（默认 -p）：需要批准的调用是否被拒绝
  const r = mkRepo();
  const res = await runProc('claude', baseArgs('把文字 hi 写入 ../outside.txt。'), { cwd: r.repo, input: '', timeoutMs: 150_000 });
  results.e4_no_prompt_tool = { exit: res.code, outsideCreated: existsSync(r.outside), ...summarize(parse(res.stdout)) };
  r.cleanup();
}

async function e5() {
  const r = mkRepo();
  const bad = await runProc('claude', baseArgs(TASK, { extra: [] }).map((a) => (a === MODEL ? 'no-such-model-xyz' : a)), { cwd: r.repo, input: '', timeoutMs: 90_000 });
  saveSample('e5-bad-model.jsonl', bad.stdout);
  const evBad = parse(bad.stdout);
  results.e5_bad_model = { exit: bad.code, stderr: sanitize(bad.stderr).slice(0, 300), ...summarize(evBad) };
  const { cfg } = permSetup(r.base, 'allow');
  const turns = await runProc('claude', baseArgs('依次创建 a.txt b.txt c.txt，每个一次工具调用。', { mcpConfig: cfg, extra: ['--max-turns', '1'] }), { cwd: r.repo, input: '', timeoutMs: 90_000 });
  saveSample('e5-max-turns.jsonl', turns.stdout);
  results.e5_max_turns = { exit: turns.code, ...summarize(parse(turns.stdout)) };
  r.cleanup();
}

async function e7() {
  const v = await runProc('claude', ['--version'], { input: '', timeoutMs: 20_000 });
  const s = await runProc('claude', ['auth', 'status'], { input: '', timeoutMs: 20_000 });
  let j = {}; try { j = JSON.parse(s.stdout); } catch {}
  const empty = mkdtempSync(path.join(os.tmpdir(), 'spike-cfg-'));
  const out = await runProc('claude', ['auth', 'status'], { input: '', timeoutMs: 20_000, env: { CLAUDE_CONFIG_DIR: empty } });
  let jo = {}; try { jo = JSON.parse(out.stdout); } catch {}
  results.e7_detect = { version: v.stdout.trim(), versionExit: v.code, loggedIn: { exit: s.code, loggedIn: j.loggedIn, authMethod: j.authMethod },
    emptyConfigDir: { exit: out.code, loggedIn: jo.loggedIn, authMethod: jo.authMethod, raw: sanitize(out.stdout || out.stderr).slice(0, 200) } };
}

if (want.has('e1') || want.has('e2')) await e1e2();
if (want.has('e3')) await e3();
if (want.has('e4')) await e4();
if (want.has('e5')) await e5();
if (want.has('e7')) await e7();
const ver = (await runProc('claude', ['--version'], { input: '' })).stdout.trim();
writeFileSync(path.join(samples, 'results.json'), JSON.stringify({ tool: 'claude', version: ver, model: MODEL, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
