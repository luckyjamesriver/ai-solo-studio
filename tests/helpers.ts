import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { git, initRepo } from '../src/core/git/git.js';
import type { SandboxCommandRunner } from '../src/core/checks/scripts.js';

export async function tmpDir(prefix = 'studio-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function makeRepo(files: Record<string, string> = { 'index.html': '<h1>hello</h1>\n' }) {
  const dir = await tmpDir();
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c);
  }
  await initRepo(dir);
  return dir;
}

/**
 * 仅供测试：把“沙箱命令运行器”实现为在本机直接运行（测试里没有真实沙箱）。
 * 产品代码里绝不能有这样的运行器——受限环境不可用时必须是“未检查”。
 */
export function testSandboxRunner(): SandboxCommandRunner {
  return {
    runCommand: (req) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        let stdout = '';
        let stderr = '';
        const child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env: req.env, shell: false });
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (e) => resolve({ status: 'unavailable', reason: e.message }));
        child.on('close', (code) => resolve({ status: 'ran', exitCode: code, stdout, stderr, timedOut: false, durationMs: Date.now() - t0 }));
      }),
  };
}

export { git };

/**
 * AISS-A1 测试夹具：用**真实 Vitest**作为自动测试运行器。
 * 可信测试证据要求结构化报告，只有受支持的真实测试框架才能产出；
 * 因此需要“检查通过”语义的用例必须使用真实框架，而不是 echo / node -e 之类只关心退出码的脚本。
 */
const requireFromTests = createRequire(import.meta.url);

/**
 * 真实 Vitest 可执行文件的绝对路径。
 * 不使用 process.cwd()：这个测试套件本身也可能在“任务副本里”被执行（应用自检/真实项目验证），
 * 此时 cwd 是副本路径、没有 node_modules，但模块解析仍指向主项目已安装的那一份。
 */
export function realVitestBin(): string {
  const pkgDir = path.dirname(requireFromTests.resolve('vitest/package.json'));
  return path.join(pkgDir, 'vitest.mjs');
}

export function realVitestScript(): string {
  return `${realVitestBin()} run`;
}

/**
 * 把一个已有测试夹具改成「真实 Vitest 自动测试」并提交进仓库历史：
 * 改写 package.json 的 test 脚本 → 写入真实测试文件 → git add/commit。
 * 必须在创建任务副本（worktree）之前调用，否则副本里没有这份测试。
 */
export async function useRealVitest(dir: string, opts: { failWhen?: string; testScript?: string } = {}): Promise<void> {
  const pkgPath = path.join(dir, 'package.json');
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts ? (pkg.scripts as Record<string, string>) : {};
  pkg.scripts = { ...scripts, test: opts.testScript ?? realVitestScript() };
  await fs.mkdir(path.dirname(pkgPath), { recursive: true });
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await writeVitestTests(dir, opts.failWhen ? { failWhen: opts.failWhen } : {});
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--allow-empty', '-m', 'fixture: real vitest test runner']).catch(() => undefined);
}

/** 写入一份会真实通过（或在 failingList 命中时真实失败）的 Vitest 测试文件。 */
export async function writeVitestTests(
  dir: string,
  opts: { files?: Record<string, string>; failWhen?: string } = {},
): Promise<void> {
  const testsDir = path.join(dir, 'tests');
  await fs.mkdir(testsDir, { recursive: true });
  const base = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { describe, it, expect } from 'vitest';",
    `const failWhen = ${JSON.stringify(opts.failWhen ?? '')};`,
    "const shouldFail = failWhen ? fs.existsSync(path.join(process.cwd(), failWhen)) : false;",
    "describe('fixture', () => {",
    "  it('第一条真实用例', () => { expect(1 + 1).toBe(2); });",
    "  it('第二条真实用例', () => { if (shouldFail) expect(1).toBe(2); else expect('ok').toBe('ok'); });",
    "});",
  ].join('\n');
  await fs.writeFile(path.join(testsDir, 'fixture.test.ts'), `${base}\n`);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}
