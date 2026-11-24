/**
 * AISS-A1 修复前后对照探针：同一组断言
 *  - 在基线 e69ca85 上应当【失败】（证明 P0-1/P0-2/P0-3 缺陷真实存在）；
 *  - 在 A1 修复后应当【通过】（证明缺陷已消除）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runCheck, scriptsDigest } from '../../src/core/checks/scripts.js';
import { parseTestCases } from '../../src/core/acceptance/proof.js';
import { buildCard } from '../../src/core/acceptance/card.js';
import { spawn } from 'node:child_process';
import os from 'node:os';

const runner = {
  runCommand: (req: { cwd: string; argv: string[]; env: Record<string, string> }) =>
    new Promise<{ status: 'ran'; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>((resolve) => {
      const t0 = Date.now();
      let stdout = '';
      let stderr = '';
      const child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env: req.env, shell: false });
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', () => resolve({ status: 'ran', exitCode: null, stdout, stderr, timedOut: false, durationMs: 0 }));
      child.on('close', (code) => resolve({ status: 'ran', exitCode: code, stdout, stderr, timedOut: false, durationMs: Date.now() - t0 }));
    }),
} as never;

async function fixture(script: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a1-probe-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: script } }));
  return dir;
}

describe('A1 修复前后对照：命令成功不得伪装成测试通过（P0-1）', () => {
  it('echo 脚本退出 0 → 非 PASS', async () => {
    const dir = await fixture('echo "Tests 5 passed (5)"');
    const r = await runCheck(dir, 'test', runner, { authorizedDigest: (await scriptsDigest(dir))! });
    expect(r.status).not.toBe('passed');
  });

  it('只输出伪造成功摘要的脚本退出 0 → 非 PASS', async () => {
    const dir = await fixture('node -e "console.log(\'Test Files 1 passed\\nTests 99 passed (99)\')"');
    const r = await runCheck(dir, 'test', runner, { authorizedDigest: (await scriptsDigest(dir))! });
    expect(r.status).not.toBe('passed');
  });

  it('零测试（passWithNoTests）与全部跳过 → 非 PASS', async () => {
    // 用 node --test 风格命令模拟：没有任何测试时退出 0
    const dir = await fixture('node -e "process.exit(0)"');
    const r = await runCheck(dir, 'test', runner, { authorizedDigest: (await scriptsDigest(dir))! });
    expect(r.status).not.toBe('passed');
  });
});

describe('A1 修复前后对照：不得虚构测试通过数量（P0-2）', () => {
  it('解析不出数量时不生成「1 项通过」', () => {
    const parsed = parseTestCases('all assertions succeeded', 'passed') as unknown as { passedCount?: number; counts?: unknown };
    // 基线：parsedCount 被兜底成 1；A1：counts 为 null
    expect(parsed.passedCount).toBeUndefined();
    expect(parsed.counts).toBeNull();
  });
});

describe('A1 修复前后对照：验收卡不得把命令成功/人工确认变成测试通过（P0-3）', () => {
  it('没有结构化测试证据时 test 条目不得是 verified', () => {
    const card = buildCard({
      exit: { kind: 'exited', code: 0 },
      changes: [{ status: 'modified', path: 'a', additions: 1, deletions: 0 }],
      checks: [{ name: 'test', status: 'passed', outcome: { kind: 'exited', code: 0 }, output: '', durationMs: 1 }],
      criteria: [{ text: 'x', decision: 'confirmed' }],
      previewed: true,
    } as never);
    expect(card.items.find((i) => i.key === 'test')?.status).not.toBe('verified');
  });
});
