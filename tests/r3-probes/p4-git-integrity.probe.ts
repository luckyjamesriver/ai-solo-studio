/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-04 反向探针：Git 完整性比较的路径语义。
 *
 * 旧候选 `diffTreePaths` 把任务路径直接放到 `git diff-tree --` 之后，Git 按通配 pathspec 解释：
 *  - 特殊文件名（如 `[abc].txt`）可能匹配到别的文件 → 真实漂移被漏检（假阴性，最危险）；
 *  - 通配文件名（如 `star*.txt`）会同时匹配别的路径 → 合法保存被误判为漂移（假阳性）。
 * 新候选必须使用字面路径语义。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { git, diffTreePaths, treeOf } from '../../src/core/git/git.js';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import { makeRepo, testSandboxRunner, tmpDir } from '../helpers.js';

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
async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--no-verify', '--allow-empty', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

describe('R3-04 探针 A：特殊文件名必须按字面路径比较', () => {
  it('`star*.txt` 不得把 `starX.txt` 也算成它（通配假阳性）', async () => {
    const repo = await makeRepo({ 'star*.txt': 'one\n', 'starX.txt': 'x\n' });
    const c1 = await commitAll(repo, 'v1');
    await fs.writeFile(path.join(repo, 'star*.txt'), 'two\n');
    await fs.writeFile(path.join(repo, 'starX.txt'), 'y\n');
    const c2 = await commitAll(repo, 'change both');
    const changed = await diffTreePaths(repo, c1, c2, ['star*.txt']);
    expect(changed).toEqual(['star*.txt']);
  });

  it('`q?.txt` 不得把 `qX.txt` 也算成它（单字符通配假阳性）', async () => {
    const repo = await makeRepo({ 'q?.txt': 'one\n', 'qX.txt': 'x\n' });
    const c1 = await commitAll(repo, 'v1');
    await fs.writeFile(path.join(repo, 'q?.txt'), 'two\n');
    await fs.writeFile(path.join(repo, 'qX.txt'), 'y\n');
    const c2 = await commitAll(repo, 'change both');
    const changed = await diffTreePaths(repo, c1, c2, ['q?.txt']);
    expect(changed).toEqual(['q?.txt']);
  });

  it('仓库根目录以冒号开头的文件名不得被当作 pathspec magic 而静默漏检', async () => {
    const repo = await makeRepo({ ':magic.txt': 'v1\n' });
    const c1 = await commitAll(repo, 'v1');
    await fs.writeFile(path.join(repo, ':magic.txt'), 'v2\n');
    const c2 = await commitAll(repo, 'v2');
    const changed = await diffTreePaths(repo, c1, c2, [':magic.txt']);
    expect(changed).toEqual([':magic.txt']);
  });

  it('空格、引号、前导连字符、非 ASCII 文件名都按字面路径处理', async () => {
    const names = ['sp ace.txt', 'quote"q.txt', '-dash.txt', 'ünïcode 文件.txt'];
    const repo = await makeRepo({ 'index.html': 'x\n' });
    for (const n of names) await fs.writeFile(path.join(repo, n), 'v1\n');
    const c1 = await commitAll(repo, 'add odd names');
    for (const n of names) await fs.writeFile(path.join(repo, n), 'v2\n');
    const c2 = await commitAll(repo, 'change odd names');
    const changed = await diffTreePaths(repo, c1, c2, names);
    expect([...changed].sort()).toEqual([...names].sort());
  });
});

describe('R3-04 探针 B：超过 500 个路径的真实仓库', () => {
  it('全量分批比较必须发现第 600 个路径之后的漂移，不能只比对前 500 个', async () => {
    const repo = await makeRepo({ 'index.html': 'x\n' });
    await fs.mkdir(path.join(repo, 'bulk'), { recursive: true });
    const total = 620;
    for (let i = 0; i < total; i += 1) {
      await fs.writeFile(path.join(repo, `bulk/f${String(i).padStart(3, '0')}.txt`), `v1-${i}\n`);
    }
    const c1 = await commitAll(repo, 'bulk v1');
    // 只改最后几个文件：任何“只检查前 500 个”的实现都会漏掉
    for (const i of [520, 590, 619]) {
      await fs.writeFile(path.join(repo, `bulk/f${String(i).padStart(3, '0')}.txt`), `v2-${i}\n`);
    }
    const c2 = await commitAll(repo, 'bulk v2 late changes');

    const allPaths: string[] = [];
    for (let i = 0; i < total; i += 1) allPaths.push(`bulk/f${String(i).padStart(3, '0')}.txt`);
    const changed: string[] = [];
    const BATCH = 200;
    for (let i = 0; i < allPaths.length; i += BATCH) {
      changed.push(...(await diffTreePaths(repo, c1, c2, allPaths.slice(i, i + BATCH))));
    }
    expect([...changed].sort()).toEqual(['bulk/f520.txt', 'bulk/f590.txt', 'bulk/f619.txt']);
  }, 120_000);
});

describe('R3-04 探针 C：特殊文件名走真实保存链路（不得误判漂移）', () => {
  it('任务改动包含 `[abc].txt` 时，保存成功且内容完整', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const data = await temp('r3p4-data-');
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: '[abc].txt', content: 'special\n' },
          { do: 'write' as const, path: 'sp ace.txt', content: 'space\n' },
          { do: 'write' as const, path: 'index.html', content: '<h1>new</h1>\n' },
          { do: 'exit' as const, code: 0 },
        ]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
    });
    const created = await ctl.create('特殊文件名');
    await ctl.savePlan(created.id, { goal: '特殊文件名', criteria: ['已写入'], mode: 'standard', network: false });
    await ctl.start(created.id, false);
    let view = await until(async () => {
      const v = await ctl.getAcceptanceView(created.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
    for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;
    // 项目没有 build/test 脚本：先明确“未检查确认”，再保存；这里验证的是特殊文件名不会误判内容漂移
    const first = await ctl.saveTask(created.id, view.version);
    expect(first.ok).toBe(false);
    expect(first.view.saveOutcome?.kind).toBe('unchecked_needs_confirm');
    const confirmed = await ctl.saveUncheckedTask(created.id, (await ctl.getAcceptanceView(created.id)).version);
    expect(confirmed.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, '[abc].txt'), 'utf8')).toBe('special\n');
    expect(await fs.readFile(path.join(repo, 'sp ace.txt'), 'utf8')).toBe('space\n');
  }, 120_000);
});
