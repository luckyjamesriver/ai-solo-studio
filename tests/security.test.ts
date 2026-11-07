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
    // M2.5：默认“每条命令都询问”（untrusted，比 on-request 更严格），只能经 thread/start 与 turn/start 参数声明
    expect(cfg.threadStart).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
    expect(cfg.turnOverrides).toMatchObject({ approvalPolicy: 'untrusted' });
    expect(codexLaunchConfig('/work/tree', { capabilities: { fileAccess: 'worktree_write', commandExecution: 'sandbox_auto', externalNetwork: 'off', credentialAccess: 'none', grantedMcp: [] } }).threadStart).toMatchObject({ approvalPolicy: 'on-request' });
  });

  it('思考者实现中不出现跳过权限/放开沙箱的参数，也不读取登录凭证文件', () => {
    const forbidden = /dangerously|--yolo|bypassPermissions|skip-permissions|danger-full-access|dangerFullAccess|--bare\b|["']never["']|=never|auth\.json|\.credentials|keychain|security find-/i;
    for (const f of walk('src/core/thinking').filter((x) => /\.ts$/.test(x))) expect(read(f), f).not.toMatch(forbidden);
  });

  it('ClaudeCliThinker：打包环境下不可用（即使设置了环境变量）；默认关闭；子进程不继承 ANTHROPIC_API_KEY', async () => {
    const { ClaudeCliThinker, claudeCliArgs, DEV_PERSONAL_ENV } = await import('../src/core/thinking/claude-cli.js');
    const packaged = new ClaudeCliThinker({ env: { [DEV_PERSONAL_ENV]: '1' }, isPackaged: () => true });
    expect((await packaged.detect()).available).toBe(false);
    expect((await packaged.think({ role: 'planner', system: 's', context: { required: [] }, task: 't', output: { type: 'object', properties: {}, required: [] } })).status).toBe('failed');
    expect((await new ClaudeCliThinker({ env: {}, isPackaged: () => false }).detect()).available).toBe(false);
    expect(claudeCliArgs()).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
    expect(read('src/core/thinking/claude-cli.ts')).toMatch(/delete e\.ANTHROPIC_API_KEY/);
    // isPackaged 可传布尔值或函数；布尔 true 同样不可用
    expect((await new ClaudeCliThinker({ env: { [DEV_PERSONAL_ENV]: '1' }, isPackaged: true }).detect()).available).toBe(false);
  });

  it('M3-A1 遗留：src/main 中每个 ClaudeCliThinker 构造点都必须显式传入 isPackaged', () => {
    for (const f of walk('src/main').filter((x) => /\.(c?ts|tsx)$/.test(x))) {
      const s = read(f);
      for (const m of s.matchAll(/new\s+ClaudeCliThinker\s*\(([\s\S]*?)\)\s*[;,)\n]/g)) {
        expect(m[1], `${f}: new ClaudeCliThinker(...) 缺少 isPackaged`).toMatch(/\bisPackaged\b/);
      }
    }
    // 断言自身有效：对一个缺参的构造点样例，匹配结果确实不含 isPackaged
    const sample = 'const t = new ClaudeCliThinker({ model: "x" });';
    const m = [...sample.matchAll(/new\s+ClaudeCliThinker\s*\(([\s\S]*?)\)\s*[;,)\n]/g)];
    expect(m).toHaveLength(1);
    expect(m[0]![1]).not.toMatch(/\bisPackaged\b/);
  });
});
