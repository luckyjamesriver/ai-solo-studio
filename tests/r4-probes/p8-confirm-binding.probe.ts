/**
 * AISS-A1-TRUSTED-EVIDENCE-R4 / R4-03 反向探针：人工重新确认后的“重新执行”必须复核新旧绑定。
 *
 * 场景（真实 Vitest）：
 *  - 执行体改写了测试文件（内容变化 → 静态范围进入待确认）；
 *  - 用户查看后点击“确认范围”，宿主重新执行检查；
 *  - 在用户查看与重新执行之间，共享状态让同文件内的一条用例不再注册。
 *
 * 旧候选：把重新执行得到的新结果**自动登记为用户已授权**（confirmedAt 落盘，执行清单悄悄变了）。
 * 新候选：重新执行前后必须核对内容/静态范围/实际执行清单；任何变化都重新进入待确认状态。
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

const ORIGINAL_TEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { execSync } from 'node:child_process';",
  "import { describe, it, expect } from 'vitest';",
  "function repoRoot(): string {",
  "  const commonDir = execSync('git rev-parse --git-common-dir', { cwd: process.cwd(), encoding: 'utf8' }).trim();",
  "  return path.dirname(path.resolve(process.cwd(), commonDir));",
  "}",
  "const flag = path.join(repoRoot(), '.r4-confirm.json');",
  "const extra = !fs.existsSync(flag);",
  "describe('confirm binding', () => {",
  "  it('A', () => { expect(1 + 1).toBe(2); });",
  "  if (extra) {",
  "    it('B', () => { expect('ok').toBe('ok'); });",
  "  }",
  "});",
  '',
].join('\n');

// 执行体改写的版本：内容变化（触发待确认），仍然有 2 条用例
const MODIFIED_TEST = ORIGINAL_TEST.replace("it('A', () => { expect(1 + 1).toBe(2); });", "it('A', () => { expect(2).toBe(2); });");

describe('R4-03 探针：用户确认后重新执行时执行清单发生变化，不得自动登记为已授权', () => {
  it('确认前查看的是 2 条用例，重新执行只剩 1 条 → 必须重新待确认', async () => {
    const repo = await makeRepo({
      'index.html': '<h1>old</h1>\n',
      '.gitignore': '.r4-confirm.json\n',
      'tests/confirm.test.ts': ORIGINAL_TEST,
      'package.json': JSON.stringify({ name: 'r4p8', scripts: { test: realVitestScript() } }),
    });
    const data = await temp('r4p8-data-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'tests/confirm.test.ts', content: MODIFIED_TEST },
          { do: 'write' as const, path: 'index.html', content: '<h1>r4p8</h1>\n' },
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
    // 验收：内容变化 → 测试项进入待确认（不是 verified）
    expect(view.items.find((i) => i.key === 'test')!.status).not.toBe('verified');
    const rawBefore = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
    expect(rawBefore.scopeReview).toBeTruthy();
    expect(rawBefore.scopeReview?.executionFingerprint).toBeTruthy();

    // 用户查看之后、点击确认之前：共享状态变化，使同文件内一条用例不再注册
    await fs.writeFile(path.join(repo, '.r4-confirm.json'), '1');

    const res = await ctl.confirmScopeChange(created.id, view.version);
    const after = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;

    // 旧候选：ok=true 且 confirmedAt 落盘；新候选：拒绝并把任务留在待确认
    expect(res.ok).toBe(false);
    expect(after.scopeReview?.confirmedAt).toBeFalsy();
  }, 120_000);
});
