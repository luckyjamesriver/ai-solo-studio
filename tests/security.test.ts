import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe('安全基线（防回归）', () => {
  const main = read('src/main/index.ts');
  it('Electron 窗口启用隔离与沙箱', () => {
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).toMatch(/webviewTag:\s*false/);
  });

  const sources = walk('src').filter((f) => /\.(c?ts|tsx)$/.test(f)).map((f) => [f, fs.readFileSync(f, 'utf8')] as const);

  it('源码中不出现跳过权限的参数', () => {
    for (const [f, s] of sources) {
      expect(s, f).not.toMatch(/dangerously-skip-permissions|--trust\b|--yolo|bypassPermissions/);
    }
  });

  it('子进程不经过 shell', () => {
    for (const [f, s] of sources) {
      expect(s, f).not.toMatch(/shell:\s*true|\bexecSync\(|\bexec\(/);
    }
  });

  it('不写死任何个人路径', () => {
    for (const [f, s] of sources) expect(s, f).not.toMatch(/\/Users\/[a-z]|\/home\/[a-z]/i);
  });

  it('Codex 适配器：源码与生成的参数中不出现禁止的权限/沙箱参数', async () => {
    const forbidden = /danger-full-access|dangerFullAccess|dangerously|--yolo|bypass|full-auto|["']never["']|=never/i;
    for (const f of ['src/core/executor/adapters/codex.ts', 'src/core/executor/adapters/codex-command.ts']) {
      expect(read(f), f).not.toMatch(forbidden);
    }
    const { codexLaunchConfig } = await import('../src/core/executor/adapters/codex.js');
    const cfg = codexLaunchConfig('/work/tree', { model: 'm' });
    expect(JSON.stringify(cfg)).not.toMatch(forbidden);
    expect(cfg.args).toContain('sandbox_mode="workspace-write"');
    expect(cfg.args).toContain('approval_policy="on-request"');
    expect(cfg.threadStart).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  });
});
