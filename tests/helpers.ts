import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
