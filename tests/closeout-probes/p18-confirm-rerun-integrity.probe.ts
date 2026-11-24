/**
 * AISS-A1-PREMERGE-GATE-CLOSEOUT-001 / §3 修订二反向探针：
 * 确认后重新执行必须取得**经统一裁决有效的新证据**，不能只凭“evidence 对象/静态指纹/执行指纹存在”。
 *
 * 场景（真实 Vitest + 生产确认流程）：
 *  - 验收时执行体改了已有测试文件 → 静态范围进入“待确认”，但执行清单完整（真实报告）；
 *  - 用户查看后点击“确认范围”，宿主重新执行真实 Vitest；
 *  - 重跑产生的执行清单与用户查看时完全相同（同文件、同用例、同状态）；
 *  - 但沙箱返回的 stdout 摘要缺失 / 与报告不一致 → 报告交叉核对未通过，`report.integrity.ok=false`。
 *
 * 旧候选：只比较指纹是否“存在且相同” → 把这次重跑登记为 confirmedAt，自动解除范围门禁。
 * 新候选：重跑证据必须通过统一证据裁决（含报告完整性/stdout 交叉核对）才允许登记 confirmedAt；
 *        否则保持待确认，范围门禁继续阻断保存。正常有效重跑仍然可以确认（正向用例保留）。
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
async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 60_000): Promise<T> {
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
  "const flag = path.join(repoRoot(), '.closeout-b.json');",
  "describe('confirm integrity', () => {",
  "  it('A', () => { expect(1 + 1).toBe(2); });",
  "  it('B', () => { expect(fs.existsSync(flag)).toBe(false); });",
  "});",
  '',
].join('\n');
// 执行体改写已有测试文件：内容变化 → 静态范围进入待确认；用例清单不变
const MODIFIED_TEST = ORIGINAL_TEST.replace("it('A', () => { expect(1 + 1).toBe(2); });", "it('A', () => { expect(2).toBe(2); });");

type Tamper = 'none' | 'stdout_missing' | 'stdout_mismatch';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function tamperStdout(mode: Tamper, stdout: string): string {
  // Vitest 默认给摘要行加 ANSI 颜色；宿主解析前会先去色，这里同样先去色再改写
  const plain = stdout.replace(ANSI, '');
  if (mode === 'stdout_missing') {
    // 真实运行照常产出报告；只是宿主拿不到可解析的 stdout 摘要（例如输出被截断/改写）
    return plain.replace(/^.*\bTests\s+\d+.*$/gm, '');
  }
  if (mode === 'stdout_mismatch') {
    return plain.replace(/^(\s*)Tests\s+.*$/gm, '$1Tests  99 passed (99)');
  }
  return stdout;
}

async function runScenario(mode: Tamper) {
  const repo = await makeRepo({
    'index.html': '<h1>old</h1>\n',
    '.gitignore': '.closeout-b.json\n',
    'tests/confirm.test.ts': ORIGINAL_TEST,
    'package.json': JSON.stringify({ name: 'closeout-p18', scripts: { test: realVitestScript() } }),
  });
  const real = testSandboxRunner();
  let calls = 0;
  const wrapped: SandboxCommandRunner = {
    runCommand: async (req) => {
      calls += 1;
      const res = await real.runCommand(req);
      if (calls === 1 || res.status !== 'ran') return res; // 验收：真实且正常
      return { ...res, stdout: tamperStdout(mode, res.stdout) };
    },
  };
  const data = await temp(`closeout-p18-${mode}-data-`);
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor([
        { do: 'write' as const, path: 'tests/confirm.test.ts', content: MODIFIED_TEST },
        { do: 'write' as const, path: 'index.html', content: '<h1>p18</h1>\n' },
        { do: 'exit' as const, code: 0 },
      ]);
      (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = wrapped;
      return ex;
    },
    pickDirectory: async () => null,
    prefs: new TaskPrefs(data),
  });
  const created = await ctl.create('改标题');
  await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
  await ctl.start(created.id, false);
  const view = await until(async () => {
    const v = await ctl.getAcceptanceView(created.id);
    return v.state === 'reviewing' && !v.busy ? v : false;
  });
  expect(view.items.find((i) => i.key === 'test')!.status).not.toBe('verified');
  const before = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  expect(before.scopeReview).toBeTruthy();
  expect(before.scopeReview?.executionFingerprint).toBeTruthy();

  const res = await ctl.confirmScopeChange(created.id, view.version);
  const after = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  const afterView = await ctl.getAcceptanceView(created.id);
  const afterProof = (after.currentChecks ?? []).find((p) => p.name === 'test');
  return { created, view, before, res, after, afterView, afterProof, ctl, calls };
}

describe('CLOSEOUT-01 修订二：确认后重跑必须取得有效的新证据', () => {
  it('重跑执行清单相同但 stdout 摘要缺失（报告完整性失败）→ 保持待确认，不登记 confirmedAt', async () => {
    const { created, before, res, after, afterView, afterProof, ctl, calls } = await runScenario('stdout_missing');
    expect(calls).toBe(2);
    // 场景前提：真实报告存在、执行清单与用户查看时一致，只是 stdout 交叉核对缺失
    expect(afterProof?.evidence?.report?.integrity.ok).toBe(false);
    expect(afterProof?.evidence?.report?.integrity.problems.join('；')).toMatch(/stdout/);
    expect(afterProof?.evidence?.scope.executionFingerprint).toBe(before.scopeReview?.executionFingerprint);

    // 新候选：不得登记 confirmedAt，不得自动解除范围门禁
    expect(res.ok).toBe(false);
    expect(after.scopeReview).toBeTruthy();
    expect(after.scopeReview?.confirmedAt).toBeFalsy();
    expect(afterView.scopeChange?.needed).toBe(true);
    const blocked = await ctl.saveTask(created.id, afterView.version);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/重新确认|范围/);
  }, 180_000);

  it('重跑执行清单相同但 stdout 摘要与报告不一致（报告完整性失败）→ 保持待确认，不登记 confirmedAt', async () => {
    const { created, before, res, after, afterView, afterProof, ctl, calls } = await runScenario('stdout_mismatch');
    expect(calls).toBe(2);
    expect(afterProof?.evidence?.report?.integrity.ok).toBe(false);
    expect(afterProof?.evidence?.report?.integrity.problems.join('；')).toMatch(/不一致/);
    expect(afterProof?.evidence?.scope.executionFingerprint).toBe(before.scopeReview?.executionFingerprint);

    expect(res.ok).toBe(false);
    expect(after.scopeReview).toBeTruthy();
    expect(after.scopeReview?.confirmedAt).toBeFalsy();
    expect(afterView.scopeChange?.needed).toBe(true);
    const blocked = await ctl.saveTask(created.id, afterView.version);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/重新确认|范围/);
  }, 180_000);

  it('正向：正常有效重跑（执行清单一致且证据可信）仍然允许用户确认', async () => {
    const { res, after } = await runScenario('none');
    expect(res.ok).toBe(true);
    expect(after.scopeReview?.confirmedAt).toBeTruthy();
  }, 180_000);
});
