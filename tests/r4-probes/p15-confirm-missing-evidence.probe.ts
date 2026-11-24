/**
 * AISS-A1-R4-LAST-DELTA-001 / §3.2 反向探针：确认后重新执行缺少有效新证据时不得用旧指纹登记确认。
 *
 * 场景（真实 Vitest + 真实控制器）：验收时有 2 条用例并进入“待确认范围”；
 * 用户查看后点击确认，重新执行时受限沙箱不可用（真实环境可能发生）→ 新的 test 证据是
 * not_available / 没有实际执行清单。
 *
 * 旧候选：用确认前的旧指纹回填 `confirmedStatic/confirmedExecution`，比较相等后登记 `confirmedAt`。
 * 新候选：缺少有效新证据或执行清单 → 保持待确认，返回 ok=false。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir } from '../helpers.js';
import type { SandboxCommandRunner } from '../../src/core/checks/scripts.js';

const cleanDirs: string[] = [];
afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});
async function temp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  cleanDirs.push(d);
  return d;
}
async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 40_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ORIGINAL_TEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { execSync } from 'node:child_process';",
  "import { describe, it, expect } from 'vitest';",
  "function repoRoot(): string {",
  "  const commonDir = execSync('git rev-parse --git-common-dir', { cwd: process.cwd(), encoding: 'utf8' }).trim();",
  "  return path.dirname(path.resolve(process.cwd(), commonDir));",
  "}",
  "const flag = path.join(repoRoot(), '.lastdelta-confirm.json');",
  "describe('confirm', () => {",
  "  it('A', () => { expect(1 + 1).toBe(2); });",
  "  it('B', () => { expect('ok').toBe('ok'); });",
  "});",
  '',
].join('\n');
const MODIFIED_TEST = ORIGINAL_TEST.replace("it('A', () => { expect(1 + 1).toBe(2); });", "it('A', () => { expect(2).toBe(2); });");

describe('LAST-DELTA 探针 P15：确认后重新执行没有有效新证据 → 必须保持待确认', () => {
  it('重新执行时沙箱不可用（not_available、无执行清单）→ 不得 confirmedAt', async () => {
    const repo = await makeRepo({
      'index.html': '<h1>old</h1>\n',
      '.gitignore': '.lastdelta-confirm.json\n',
      'tests/confirm.test.ts': ORIGINAL_TEST,
      'package.json': JSON.stringify({ name: 'p15', scripts: { test: realVitestScript() } }),
    });
    const real = testSandboxRunner();
    let calls = 0;
    const flaky: SandboxCommandRunner = {
      runCommand: (req) => {
        calls += 1;
        // 验收时正常；用户确认后的重新执行时沙箱不可用
        if (calls === 1) return real.runCommand(req);
        return Promise.resolve({ status: 'unavailable', reason: 'sandbox revoked' });
      },
    };
    const data = await temp('p15-data-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'tests/confirm.test.ts', content: MODIFIED_TEST },
          { do: 'write' as const, path: 'index.html', content: '<h1>p15</h1>\n' },
          { do: 'exit' as const, code: 0 },
        ]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = flaky;
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });
    const created = await ctl.create('改标题');
    await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
    await ctl.start(created.id, false);
    let view = await until(async () => {
      const v = await ctl.getAcceptanceView(created.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    expect(view.items.find((i) => i.key === 'test')!.status).not.toBe('verified');
    const before = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
    expect(before.scopeReview).toBeTruthy();
    expect(before.scopeReview?.executionFingerprint).toBeTruthy();
    expect(calls).toBe(1);

    const res = await ctl.confirmScopeChange(created.id, view.version);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
    expect(calls).toBe(2);
    // 旧候选：ok=true 且 confirmedAt 落盘（用旧指纹回填）；新候选：保持待确认
    expect(res.ok).toBe(false);
    expect(after.scopeReview?.confirmedAt).toBeFalsy();
  }, 120_000);
});
