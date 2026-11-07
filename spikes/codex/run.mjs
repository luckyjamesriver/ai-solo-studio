#!/usr/bin/env node
// Codex 执行体验证（ADR 0001 第 1～5、7 项）。可重复运行：node spikes/codex/run.mjs [e1 e2 e3 e4 e5 e7]
// 只使用官方文档中的方式：`codex exec --json`（事件流）和 `codex app-server`（审批请求）。
// 不使用任何跳过权限/沙箱的参数；用 --ignore-user-config 避免读取用户 config.toml（其中可能有宽松默认值），不修改全局配置。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK, mkRepo, sha, sleep, listFiles, sanitize, runProc } from '../shared/util.mjs';
import { startAppServer, handshake } from './appserver-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const samples = path.join(here, 'samples');
mkdirSync(samples, { recursive: true });
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['e1', 'e2', 'e3', 'e4', 'e5', 'e7']);
const resultsFile = path.join(samples, 'results.json');
const results = existsSync(resultsFile) ? (JSON.parse(readFileSync(resultsFile, 'utf8')).results ?? {}) : {};
const parse = (s) => s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
const saveSample = (name, text) => writeFileSync(path.join(samples, name), sanitize(text));
const execArgs = (prompt, sandbox, extra = []) => ['exec', '--json', '--ignore-user-config', '--ephemeral', '-s', sandbox, ...extra, prompt];
const evSummary = (ev) => ({ types: [...new Set(ev.map((e) => e.type + (e.item ? `:${e.item.type}` : '')))], last: ev.at(-1)?.type });

// ---------- codex exec 路线 ----------
async function execRuns() {
  // e1：事件流
  let r = mkRepo();
  let res = await runProc('codex', execArgs(TASK, 'workspace-write'), { cwd: r.repo, input: '', timeoutMs: 180_000 });
  saveSample('e1-exec-events.jsonl', res.stdout);
  results.e1_exec = { exit: res.code, ms: res.ms, ...evSummary(parse(res.stdout)), hasH1Hello: /<h1[^>]*>\s*Hello\s*<\/h1>/i.test(readFileSync(r.index, 'utf8')) };
  r.cleanup();

  // e2（exec 路线）：read-only 沙箱下想写文件会怎样？exec 没有审批通道，只能看到失败
  r = mkRepo();
  const before = sha(r.index);
  res = await runProc('codex', execArgs(TASK, 'read-only'), { cwd: r.repo, input: '', timeoutMs: 180_000 });
  saveSample('e2-exec-readonly.jsonl', res.stdout);
  results.e2_exec_readonly = { exit: res.code, fileChanged: sha(r.index) !== before, ...evSummary(parse(res.stdout)) };
  r.cleanup();

  // e4（exec 路线）：workspace-write 下写仓库外文件（仓库外目录在主目录下，不在临时目录里）
  r = mkRepo({ inHome: true });
  res = await runProc('codex', execArgs('把文字 hi 写入 ../outside.txt（仓库外的文件）。', 'workspace-write'), { cwd: r.repo, input: '', timeoutMs: 180_000 });
  saveSample('e4-exec-outside.jsonl', res.stdout);
  results.e4_exec_outside = { exit: res.code, outsideCreated: existsSync(r.outside), ...evSummary(parse(res.stdout)),
    commands: parse(res.stdout).filter((e) => e.item?.type === 'command_execution' && e.type === 'item.completed').map((e) => ({ exit: e.item.exit_code, status: e.item.status, out: sanitize(String(e.item.aggregated_output ?? '')).slice(0, 160) })) };
  r.cleanup();

  // e3（exec 路线）：见第一个 item.started 后发 SIGTERM
  r = mkRepo();
  let killed = false;
  res = await runProc('codex', execArgs('依次创建 note1.txt 到 note6.txt，每个文件一句话，每个文件单独执行一条命令。', 'workspace-write'), { cwd: r.repo, input: '', timeoutMs: 180_000,
    onLine: (line, ctl) => { if (killed) return; try { const e = JSON.parse(line); if (e.type === 'item.started' && e.item?.type === 'command_execution') { killed = true; ctl.kill('SIGTERM'); } } catch {} } });
  const atExit = listFiles(r.repo).join(','); await sleep(4000); const later = listFiles(r.repo).join(',');
  saveSample('e3-exec-interrupt.jsonl', res.stdout);
  results.e3_exec_interrupt = { sentAfterFirstCommandStarted: killed, exitCode: res.code, exitSignal: res.signal, msToExit: res.exitedAt - (res.killedAt ?? res.exitedAt), filesAtExit: atExit, filesAfter4s: later, modifiedAfterExit: atExit !== later };
  r.cleanup();

  // e5：退出码
  r = mkRepo();
  res = await runProc('codex', ['exec', '--json', '--ignore-user-config', '--ephemeral', '-s', 'read-only', '-m', 'no-such-model-xyz', TASK], { cwd: r.repo, input: '', timeoutMs: 90_000 });
  saveSample('e5-exec-bad-model.jsonl', res.stdout);
  results.e5_exec_bad_model = { exit: res.code, stderr: sanitize(res.stderr).slice(0, 300), ...evSummary(parse(res.stdout)), err: parse(res.stdout).filter((e) => /error|failed/.test(e.type)).map((e) => sanitize(JSON.stringify(e)).slice(0, 240)) };
  res = await runProc('codex', execArgs('读取 does-not-exist.txt 并把内容原样输出；文件不存在就直接报告失败。', 'read-only'), { cwd: r.repo, input: '', timeoutMs: 120_000 });
  results.e5_exec_failing_task = { exit: res.code, ...evSummary(parse(res.stdout)) };
  r.cleanup();
}

// ---------- app-server 路线：审批请求 ----------
async function runApp({ name, prompt, sandbox, policy, decideFor, interruptOnFirstItem = false, setup, inHome = false }) {
  const r = mkRepo({ inHome });
  setup?.(r);
  const approvals = [];
  const t0 = Date.now();
  let turnId = null, threadId = null, interruptedAt = null, completed;
  const done = new Promise((resolve) => (completed = resolve));
  const srv = startAppServer({
    cwd: r.repo, args: ['--disable', 'plugins'],
    onServerRequest: (m) => {
      if (!/requestApproval$/.test(m.method)) return {};
      const decision = decideFor(m);
      approvals.push({ method: m.method, params: Object.fromEntries(Object.entries(m.params ?? {}).filter(([k]) => ['command', 'cwd', 'reason', 'grantRoot', 'itemId'].includes(k))), decision });
      return { decision };
    },
    onNotification: (m) => {
      if (m.method === 'turn/started') turnId = m.params?.turn?.id ?? turnId;
      if (interruptOnFirstItem && m.method === 'item/started' && m.params?.item?.type !== 'userMessage' && m.params?.item?.type !== 'agentMessage' && !interruptedAt && turnId) {
        interruptedAt = Date.now();
        srv.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
      if (m.method === 'turn/completed') completed(m.params?.turn?.status ?? 'completed');
    },
  });
  try {
    await handshake(srv);
    const t = await srv.request('thread/start', { cwd: r.repo, approvalPolicy: policy, sandbox, ephemeral: true });
    threadId = t.thread.id;
    const turnResp = await srv.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    turnId = turnResp?.turn?.id ?? turnId;
    const status = await Promise.race([done, sleep(150_000).then(() => 'timeout')]);
    const endedAt = Date.now();
    const atEnd = listFiles(r.repo).join(',');
    await sleep(interruptOnFirstItem ? 4000 : 500);
    const later = listFiles(r.repo).join(',');
    saveSample(`${name}.jsonl`, srv.log.map((x) => JSON.stringify(x)).join('\n'));
    return { status, approvals, ms: endedAt - t0, msFromInterruptToEnd: interruptedAt ? endedAt - interruptedAt : null, html: readFileSync(r.index, 'utf8'), outsideExists: existsSync(r.outside), outsideContent: existsSync(r.outside) ? readFileSync(r.outside, 'utf8') : null, filesAtEnd: atEnd, filesLater: later, methods: [...new Set(srv.log.filter((x) => x.dir === 'in' && x.method).map((x) => x.method))], stderr: sanitize(srv.stderr()).slice(0, 300) };
  } finally {
    srv.close(); await Promise.race([srv.exited, sleep(3000)]); r.cleanup();
  }
}
const h1 = (html) => /<h1[^>]*>\s*Hello\s*<\/h1>/i.test(html);

async function appRuns() {
  for (const d of ['accept', 'decline']) {
    const x = await runApp({ name: `e2-app-${d}`, prompt: TASK, sandbox: 'read-only', policy: 'on-request', decideFor: () => d });
    results[`e2_app_${d}`] = { status: x.status, approvals: x.approvals, hasH1Hello: h1(x.html), ms: x.ms, methods: x.methods, stderr: x.stderr };
    if (d === 'accept') results.e1_app_events = { methods: x.methods };
  }
  const o = await runApp({ name: 'e4-app-outside', prompt: '把文字 hi 写入 ../outside.txt（仓库外的文件）。', sandbox: 'workspace-write', policy: 'on-request', decideFor: () => 'decline', inHome: true });
  results.e4_app_outside = { status: o.status, approvals: o.approvals, outsideExists: o.outsideExists, methods: o.methods };
  const i = await runApp({ name: 'e3-app-interrupt', prompt: '依次创建 note1.txt 到 note6.txt，每个文件一句话，每个文件单独执行一条命令。', sandbox: 'workspace-write', policy: 'on-request', decideFor: () => 'accept', interruptOnFirstItem: true });
  results.e3_app_interrupt = { status: i.status, msFromInterruptToTurnEnd: i.msFromInterruptToEnd, filesAtEnd: i.filesAtEnd, filesLater: i.filesLater, modifiedAfterEnd: i.filesAtEnd !== i.filesLater };
}

async function e7() {
  const v = await runProc('codex', ['--version'], { input: '', timeoutMs: 20_000 });
  const s = await runProc('codex', ['login', 'status'], { input: '', timeoutMs: 20_000 });
  const empty = path.join((await import('node:os')).tmpdir(), `spike-codexhome-${Date.now()}`);
  mkdirSync(empty);
  const out = await runProc('codex', ['login', 'status'], { input: '', timeoutMs: 20_000, env: { CODEX_HOME: empty } });
  results.e7_detect = { version: v.stdout.trim().split('\n').pop(), versionExit: v.code, loggedIn: { exit: s.code, text: sanitize(s.stdout + s.stderr).trim().split('\n').pop() },
    emptyCodexHome: { exit: out.code, text: sanitize(out.stdout + out.stderr).trim().split('\n').pop() } };
}

if (want.has('e7')) await e7();
if (['e1', 'e3', 'e4', 'e5'].some((k) => want.has(k)) || want.has('exec')) await execRuns();
if (['e2', 'e3', 'e4', 'app'].some((k) => want.has(k))) await appRuns();
const ver = (await runProc('codex', ['--version'], { input: '' })).stdout.trim().split('\n').pop();
writeFileSync(resultsFile, JSON.stringify({ tool: 'codex', version: ver, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
