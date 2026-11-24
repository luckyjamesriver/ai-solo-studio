/**
 * AISS-A1-R4-LAST-DELTA-001 / §3.1 反向探针：完整用例名称必须参与执行清单哈希。
 *
 * 两个参数化用例的名称前 300 个字符完全相同、只有尾部不同；展示样本允许截断，
 * 但参与 casesDigest 的必须是**完整名称**。旧候选先截断再哈希，导致两次不同的执行集合
 * 得到同一个执行指纹，试检查被误认为与验收一致而放行保存。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { makeRepo, realVitestScript, testSandboxRunner, tmpDir } from '../helpers.js';

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

const PREFIX = 'x'.repeat(320);
const LONG_TEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { execSync } from 'node:child_process';",
  "import { test, expect } from 'vitest';",
  "function repoRoot(): string {",
  "  const commonDir = execSync('git rev-parse --git-common-dir', { cwd: process.cwd(), encoding: 'utf8' }).trim();",
  "  return path.dirname(path.resolve(process.cwd(), commonDir));",
  "}",
  "const cfgPath = path.join(repoRoot(), '.lastdelta-cases.json');",
  `const fallback = ['${PREFIX}-A', '${PREFIX}-B'];`,
  "const params = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : fallback;",
  "test.each(params)('param %s', (p) => { expect(typeof p).toBe('string'); });",
  '',
].join('\n');

describe('LAST-DELTA 探针 P14：前 300 字符相同、尾部不同的参数化用例必须区分', () => {
  it('同数量、同文件、静态不变，但执行用例尾部不同 → 不得可信保存', async () => {
    const repo = await makeRepo({
      'index.html': '<h1>old</h1>\n',
      '.gitignore': '.lastdelta-cases.json\n',
      'tests/long.test.ts': LONG_TEST,
      'package.json': JSON.stringify({ name: 'p14', scripts: { test: realVitestScript() } }),
    });
    const data = await temp('p14-data-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'index.html', content: '<h1>p14</h1>\n' },
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
    expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
    expect(view.proof.test.counts).toMatchObject({ total: 2, passed: 2 });

    for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
    for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

    // 验收之后：把第二个参数换成“前 300 字符相同、尾部不同”的另一个值（仍是 2 条用例）
    await fs.writeFile(path.join(repo, '.lastdelta-cases.json'), JSON.stringify([`${PREFIX}-A`, `${PREFIX}-C`]));

    const result = await ctl.saveTask(created.id, view.version);
    const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
    expect(result.ok).toBe(false);
    expect(raw.saveRecord).toBeUndefined();
  }, 120_000);
});
