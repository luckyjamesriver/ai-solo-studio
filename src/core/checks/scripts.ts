import fs from 'node:fs/promises';
import path from 'node:path';
import { run, type ProcOutcome } from '../proc/run.js';

export type CheckName = 'build' | 'test';

export type CheckResult =
  | { name: CheckName; status: 'not_available'; reason: string }
  | { name: CheckName; status: 'passed' | 'failed'; outcome: ProcOutcome; output: string; durationMs: number };

/** 读取 package.json 中声明的脚本；不存在则返回空。 */
export async function detectScripts(dir: string): Promise<Partial<Record<CheckName, string>>> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const s = pkg?.scripts ?? {};
    const out: Partial<Record<CheckName, string>> = {};
    if (typeof s.build === 'string') out.build = s.build;
    // npm 默认的占位 test 脚本不算真正的测试
    if (typeof s.test === 'string' && !/no test specified/.test(s.test)) out.test = s.test;
    return out;
  } catch {
    return {};
  }
}

export async function runCheck(
  dir: string,
  name: CheckName,
  opts: { timeoutMs?: number; npmCommand?: string } = {},
): Promise<CheckResult> {
  const scripts = await detectScripts(dir);
  if (!scripts[name]) {
    return { name, status: 'not_available', reason: `项目没有 ${name} 脚本，因此未检查。` };
  }
  const npm = opts.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const r = await run(npm, ['run', name, '--silent'], {
    cwd: dir,
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    env: { ...process.env, CI: '1' },
  });
  const passed = r.outcome.kind === 'exited' && r.outcome.code === 0;
  const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-20_000);
  return { name, status: passed ? 'passed' : 'failed', outcome: r.outcome, output, durationMs: r.durationMs };
}
