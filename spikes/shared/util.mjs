// 两个候选共用的小工具：临时仓库、哈希、样本脱敏、带超时的子进程。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const TASK = '在 index.html 中加入一个文字为 Hello 的 h1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : null);

/** base/repo 是全新 Git 仓库（只有 index.html）；base/outside.txt 用来测试“仓库外”访问。 */
export function mkRepo({ inHome = false } = {}) {
  // inHome：放在主目录的隐藏临时目录下。Codex 的 workspace-write 沙箱默认也允许写系统临时目录，
  // 所以测试“仓库外写入”时必须放在临时目录之外，否则结果无效。
  const base = inHome ? mkdtempSync(path.join(os.homedir(), '.spike-')) : mkdtempSync(path.join(os.tmpdir(), 'spike-'));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n<html><body>\n<p>spike</p>\n</body></html>\n');
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', 'add', '.');
  git('-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', 'commit', '-q', '-m', 'init');
  return { base, repo, outside: path.join(base, 'outside.txt'), index: path.join(repo, 'index.html'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function listFiles(dir) {
  return readdirSync(dir).filter((f) => f !== '.git').sort();
}

/** 去掉账号、路径、令牌等信息后再保存样本。 */
export function sanitize(text, extra = []) {
  let t = text.split(os.homedir()).join('~').replace(/\/(private\/)?(var\/folders|tmp)\/[^\s"']*?spike-[A-Za-z0-9]+/g, '/tmp/spike-XXXX').replace(/~\/\.spike-[A-Za-z0-9]+/g, '~/.spike-XXXX');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  t = t.split(os.userInfo().username).join('user').replace(/"planType":"[^"]*"/g, '"planType":"<plan>"');
  t = t.replace(/(sk-|ghp_|eyJ)[A-Za-z0-9._-]{12,}/g, '<token>');
  for (const e of extra) t = t.split(e).join('<redacted>');
  return t;
}

/**
 * 启动子进程，逐行回调 stdout；返回 { code, signal, ms, stdout, stderr }。
 * onLine(line, ctl) 里可以调用 ctl.kill(signal) 做中断实验，ctl.send(str) 写 stdin。
 */
export function runProc(cmd, args, { cwd, env, input, timeoutMs = 120_000, onLine } = {}) {
  const t0 = Date.now();
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', buf = '';
  const ctl = { child, kill: (sig = 'SIGTERM') => { ctl.killedAt = Date.now(); child.kill(sig); }, send: (s) => child.stdin.write(s) };
  child.stdout.on('data', (d) => {
    stdout += d; buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine?.(line, ctl); }
  });
  child.stderr.on('data', (d) => (stderr += d));
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => { ctl.timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  return new Promise((resolve) => child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, ms: Date.now() - t0, stdout, stderr, timedOut: !!ctl.timedOut, killedAt: ctl.killedAt, exitedAt: Date.now() });
  }));
}
