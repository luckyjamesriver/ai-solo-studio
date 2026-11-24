/**
 * AISS-A1-TRUSTED-EVIDENCE-R4 / R4-02 反向探针：普通验收路径也必须绑定实际执行清单。
 *
 * 场景（真实 Vitest，测试文件与静态配置完全不变）：验收时完整运行；保存试检查时通过一个
 * 被 .gitignore 忽略的共享开关改变实际执行的用例集合：
 *  1. 数量相同但用例身份变化（B → C）；
 *  2. 参数化用例数量变化（3 → 2）；
 *  3. 数量相同但一条用例被动态跳过（passed → skipped）。
 * 旧候选：试检查与原验收都被判 verified，保存 checked=true。
 * 新候选：实际执行清单必须与验收时绑定，任何差异硬阻断保存。
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

/** 静态 3 个测试块；实际执行集合由仓库根的忽略文件决定（验收 worktree 与试合并 worktree 共享）。 */
const DYNAMIC_TEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { execSync } from 'node:child_process';",
  "import { describe, it, test, expect } from 'vitest';",
  "function repoRoot(): string {",
  "  const commonDir = execSync('git rev-parse --git-common-dir', { cwd: process.cwd(), encoding: 'utf8' }).trim();",
  "  return path.dirname(path.resolve(process.cwd(), commonDir));",
  "}",
  "const cfgPath = path.join(repoRoot(), '.r4-exec.json');",
  "const cfg = fs.existsSync(cfgPath)",
  "  ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))",
  "  : { second: 'B', params: ['p1', 'p2', 'p3'], skipSecond: false };",
  "describe('dynamic execution set', () => {",
  "  it('A', () => { expect(1 + 1).toBe(2); });",
  "  it.skipIf(!!cfg.skipSecond)(cfg.second, () => { expect('ok').toBe('ok'); });",
  "  test.each(cfg.params)('param %s', (p) => { expect(typeof p).toBe('string'); });",
  "});",
  '',
].join('\n');

async function fixture(): Promise<string> {
  const repo = await makeRepo({
    'index.html': '<h1>old</h1>\n',
    '.gitignore': '.r4-exec.json\n',
    'tests/dynamic.test.ts': DYNAMIC_TEST,
    'package.json': JSON.stringify({ name: 'r4p7', scripts: { test: realVitestScript() } }),
  });
  return repo;
}

interface ScenarioOutcome {
  ok: boolean;
  message: string;
  checked: boolean | undefined;
  saveRecord: boolean;
  acceptedCounts: { total: number; passed: number; skipped: number } | undefined;
}

async function runScenario(afterAcceptance: Record<string, unknown> | undefined): Promise<ScenarioOutcome> {
  const repo = await fixture();
  const data = await temp('r4p7-data-');
  const ctl = new TaskController({
    repo,
    makeExecutor: () => {
      const ex = new FakeExecutor([
        { do: 'write' as const, path: 'index.html', content: '<h1>r4p7</h1>\n' },
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
  const acceptedCounts = view.proof.test.counts ?? undefined;
  // 验收时必须完整执行 5 条（A + B + p1/p2/p3）
  expect(acceptedCounts).toMatchObject({ total: 5, passed: 5 });

  for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
  for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

  if (afterAcceptance) await fs.writeFile(path.join(repo, '.r4-exec.json'), JSON.stringify(afterAcceptance));

  const result = await ctl.saveTask(created.id, view.version);
  const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
  return {
    ok: result.ok,
    message: result.message,
    checked: raw.saveRecord?.checked,
    saveRecord: !!raw.saveRecord,
    acceptedCounts,
  };
}

describe('R4-02 探针 A：数量相同但用例身份变化（B → C）', () => {
  it('试检查执行了不同的用例集合 → 不得可信保存', async () => {
    const out = await runScenario({ second: 'C', params: ['p1', 'p2', 'p3'], skipSecond: false });
    expect(out.acceptedCounts).toMatchObject({ total: 5, passed: 5 });
    expect(out.ok).toBe(false);
    expect(out.saveRecord).toBe(false);
    expect(out.message).toMatch(/不一致|范围|执行/);
  }, 120_000);
});

describe('R4-02 探针 B：参数化用例数量变化（3 → 2）', () => {
  it('同一文件内参数化用例减少 → 不得可信保存', async () => {
    const out = await runScenario({ second: 'B', params: ['p1', 'p2'], skipSecond: false });
    expect(out.acceptedCounts).toMatchObject({ total: 5, passed: 5 });
    expect(out.ok).toBe(false);
    expect(out.saveRecord).toBe(false);
  }, 120_000);
});

describe('R4-02 探针 C：数量相同但一条被动态跳过', () => {
  it('passed → skipped（总数不变）→ 不得可信保存', async () => {
    const out = await runScenario({ second: 'B', params: ['p1', 'p2', 'p3'], skipSecond: true });
    expect(out.acceptedCounts).toMatchObject({ total: 5, passed: 5 });
    expect(out.ok).toBe(false);
    expect(out.saveRecord).toBe(false);
  }, 120_000);
});

