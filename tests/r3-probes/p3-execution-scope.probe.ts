/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-03 反向探针：实际执行范围绑定（真实 Vitest）。
 *
 * 场景（与复核要求一致）：测试文件与静态配置完全不变，但同一测试文件内部的用例在运行期被
 * 动态条件“少执行一条”。共享状态用一个被 .gitignore 忽略的仓库根标记文件模拟——
 * 它既不在内容 tree 里，也不在测试清单/配置指纹里，因此静态分析完全看不见。
 *
 * 旧候选：报告仍被认定为可信 PASS；currentScopeFingerprint 对两次运行返回同一指纹。
 * 新候选：必须识别「同一文件内用例执行减少/动态跳过」，而且实际执行清单必须参与指纹与保存前复核。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runCheck, scriptsDigest, currentScopeFingerprint } from '../../src/core/checks/scripts.js';
import { git } from '../../src/core/git/git.js';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir } from '../helpers.js';
import type { CheckResult } from '../../src/core/checks/scripts.js';

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
async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * 测试文件：静态上永远有 2 个用例；其中一个是否“注册”取决于仓库根的一个被忽略标记文件。
 * 标记文件由 git rev-parse --git-common-dir 定位，验收 worktree 与试合并 worktree 看到的是同一份。
 */
const DYNAMIC_TEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { execSync } from 'node:child_process';",
  "import { describe, it, expect } from 'vitest';",
  "const commonDir = execSync('git rev-parse --git-common-dir', { cwd: process.cwd(), encoding: 'utf8' }).trim();",
  "const repoRoot = path.dirname(path.resolve(process.cwd(), commonDir));",
  "const full = !fs.existsSync(path.join(repoRoot, '.r3-shared-skip'));",
  "describe('shared state', () => {",
  "  it('always runs', () => { expect(1 + 1).toBe(2); });",
  "  if (full) {",
  "    it('runs only on a full run', () => { expect('ok').toBe('ok'); });",
  "  }",
  "});",
  '',
].join('\n');

async function fixture(): Promise<string> {
  const repo = await makeRepo({
    'index.html': '<h1>old</h1>\n',
    '.gitignore': '.r3-shared-skip\n',
    'tests/dynamic.test.ts': DYNAMIC_TEST,
    'package.json': JSON.stringify({ name: 'r3p3', scripts: { test: realVitestScript() } }),
  });
  // makeRepo 的 initRepo 已经提交了全部文件；基线就是这一份提交。
  return repo;
}

async function runFull(dir: string, baselineRev: string): Promise<CheckResult> {
  const tree = await git(dir, ['rev-parse', 'HEAD^{tree}']).then((s) => s.trim());
  return runCheck(dir, 'test', testSandboxRunner(), {
    authorizedDigest: (await scriptsDigest(dir))!,
    identity: { projectRoot: dir, taskId: 'r3p3', round: 1, acceptanceRev: 1, testedTree: tree, baselineRev },
  });
}

describe('R3-03 探针 A：同一测试文件内用例被动态跳过（文件与配置不变）', () => {
  it('完整运行 vs 动态少执行一条：可信结论与范围指纹都必须不同', async () => {
    const repo = await fixture();
    const baselineRev = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    const full = await runFull(repo, baselineRev);
    expect(full.status).toBe('passed');
    expect(full.evidence!.report!.counts).toMatchObject({ total: 2, passed: 2, skipped: 0 });
    expect(full.evidence!.scope.kind).toBe('assessed_unchanged');

    // 只增加一个被忽略的共享标记：测试文件、配置、脚本、锁文件全部不变
    await fs.writeFile(path.join(repo, '.r3-shared-skip'), '1');
    const partial = await runFull(repo, baselineRev);
    // 动态条件使第二个用例根本没有注册：报告里只剩 1 条真实执行用例（文件数不变）
    expect(partial.evidence!.report!.counts).toMatchObject({ total: 1, passed: 1, skipped: 0 });
    expect(partial.evidence!.report!.executedFiles).toEqual(full.evidence!.report!.executedFiles);
    // 静态清单完全一致（这就是旧候选看不见的部分）
    expect(partial.evidence!.config.testInventoryDigest).toBe(full.evidence!.config.testInventoryDigest);
    expect(partial.evidence!.scope.fingerprint).toBe(full.evidence!.scope.fingerprint);

    // 反向断言：动态少跑一条不得再取得可信通过
    expect(partial.status).not.toBe('passed');
    expect(partial.evidence!.scope.kind).not.toBe('assessed_unchanged');
    expect(partial.evidence!.scope.reasons.join('\n')).toMatch(/用例|跳过|执行/);

    // 指纹必须把“实际执行清单”算进去：两次运行不得得到同一个指纹
    const fpFull = await currentScopeFingerprint(repo, full.evidence!.report!.executedFiles, full.evidence!.report!.counts);
    const fpPartial = await currentScopeFingerprint(repo, partial.evidence!.report!.executedFiles, partial.evidence!.report!.counts);
    expect(fpPartial).not.toBe(fpFull);
  });
});

describe('R3-03 探针 B：验收完整运行 → 保存试检查时部分用例动态跳过 → 必须阻断可信保存', () => {
  it('保存不得在“试检查覆盖率下降”的情况下记录为检查通过', async () => {
    const repo = await fixture();
    const data = await temp('r3p3-data-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'index.html', content: '<h1>accepted</h1>\n' },
          { do: 'exit' as const, code: 0 },
        ]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
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
    // 验收时：完整执行 2 条用例
    expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
    expect(view.proof.test.counts).toMatchObject({ total: 2, passed: 2 });

    for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
    for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

    // 验收之后、保存试检查之前：共享状态变化，使试检查里的同一测试文件动态少执行一条用例。
    // 测试文件、配置、脚本、锁文件都没有变化。
    await fs.writeFile(path.join(repo, '.r3-shared-skip'), '1');

    const result = await ctl.saveTask(created.id, view.version);
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;

    // 旧候选：保存成功且 saveRecord.checked === true（可信通过），但试检查实际少跑了用例
    // 新候选：必须硬阻断（不能用“仍然保存”的人工确认绕过），且不留下任何保存记录
    expect(result.ok).toBe(false);
    expect(result.view.saveOutcome?.kind).not.toBe('saved');
    expect(result.message).toMatch(/不一致|范围/);
    expect(raw.saveRecord).toBeUndefined();
  });
});
