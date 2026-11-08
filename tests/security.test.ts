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

  it('M3-A2：流程引擎与交接模块只依赖 Thinker 接口，不引用任何具体思考者实现', () => {
    const concrete = /ClaudeCliThinker|CodexThinker|FakeThinker|claude-cli(?:\.js)?['"]|\/codex(?:\.js)?['"]|\/fake(?:\.js)?['"]|DEV_PERSONAL_ENV/;
    const files = [...walk('src/core/thinking/flow'), ...walk('src/core/thinking/handoff')].filter((x) => /\.ts$/.test(x));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(read(f), f).not.toMatch(concrete);
    // 具体实现只允许出现在入口层（cli/presets.ts）
    const users = walk('src/core/thinking').filter((x) => /\.ts$/.test(x) && concrete.test(read(x)) && !/thinking\/(claude-cli|codex|fake|index)\.ts$/.test(x));
    expect(users.map((u) => path.relative('src/core/thinking', u))).toEqual(['cli/presets.ts']);
    // 断言自身有效：样例确实会被匹配
    expect("import { CodexThinker } from '../codex.js';").toMatch(concrete);
  });

  it('M3-A2：思考者只返回结构化内容——流程与交接模块不让思考者拿到写权限（宿主写入）', () => {
    // 流程/交接里不出现把写文件能力交给思考者的字样
    for (const f of [...walk('src/core/thinking/flow'), ...walk('src/core/thinking/handoff')].filter((x) => /\.ts$/.test(x))) {
      expect(read(f), f).not.toMatch(/fileAccess\s*:\s*['"]worktree_write['"]|grantedMcp\s*:\s*\[\s*['"]/);
    }
  });

  // ---------- M3-B1 新增（只增不减） ----------
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const envAppFiles = [...walk('src/core/env'), ...walk('src/core/app')].filter((x) => /\.ts$/.test(x));

  it('M3-B1：渲染进程 API 清单固定，且没有任何一个接受“路径”参数（只有编号或布尔值）', () => {
    const preload = read('src/preload/index.cts');
    const entries = [...preload.matchAll(/^\s{2}(\w+): \(([^)]*)\) =>\s*ipcRenderer\.invoke\('([^']+)'/gm)].map((m) => ({ name: m[1]!, params: m[2]!, channel: m[3]! }));
    expect(entries.map((e) => e.name)).toEqual(['detectEnvironment', 'chooseProject', 'recentProjects', 'openRecent', 'projectStatus', 'initProject', 'getDisclosure', 'acceptDisclosure']);
    for (const e of entries) expect(['', 'id: string', 'consent: boolean'], `${e.name}(${e.params})`).toContain(e.params);
    // 每个 IPC 通道在主进程中都有处理函数，且主进程处理函数的参数只可能是 id / consent
    const main = read('src/main/index.ts');
    for (const e of entries) expect(main, e.channel).toContain(`ipcMain.handle('${e.channel}'`);
    for (const m of main.matchAll(/ipcMain\.handle\('[^']+',\s*(?:async\s*)?\(([^)]*)\)/g)) {
      expect(['', '_e', '_e, id: unknown', '_e, consent: unknown'], m[1]).toContain(m[1]);
    }
  });

  it('M3-B1：主进程只从系统对话框或最近项目列表（按编号）获得项目路径', () => {
    const main = read('src/main/index.ts');
    const calls = [...main.matchAll(/openValidated\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['input: string', 'r.filePaths[0]', 'r.path']);
    expect(main).toMatch(/dialog\.showOpenDialog\(/);
  });

  it('M3-B1：PATH 补全不读取、不执行用户 shell 配置文件，不启动登录 shell，不改 process.env', () => {
    const rc = /\.zshrc|\.zprofile|\.zshenv|\.zlogin|\.bashrc|\.bash_profile|\.bash_login|\.profile\b|path_helper|\bsource\s|\/etc\/(?:zsh|bash|profile|paths)/;
    const shells = /['"`](?:\/bin\/)?(?:zsh|bash|sh|fish|dash)['"`]|\s-l(?:c)?\s|login shell|--login/;
    for (const f of envAppFiles) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      expect(s, f).not.toMatch(rc);
      expect(s, f).not.toMatch(shells);
      expect(s, f).not.toMatch(/process\.env(?:\.\w+|\[[^\]]+\])?\s*=[^=]/);
    }
    // 全部源码都不得改写 process.env（补全只进入子进程环境副本）
    for (const [f, s] of sources) expect(stripComments(s), f).not.toMatch(/process\.env(?:\.\w+|\[[^\]]+\])?\s*=[^=]/);
    // 断言自身有效：样例确实会被匹配
    expect('source ~/.zshrc').toMatch(rc);
    expect("spawn('zsh', ['-lc', 'echo $PATH'])").toMatch(shells);
    expect('process.env.PATH = x').toMatch(/process\.env(?:\.\w+|\[[^\]]+\])?\s*=[^=]/);
  });

  it('M3-B1：体检与应用数据模块不读取登录凭证文件，也不写死个人路径', () => {
    for (const f of envAppFiles) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      expect(s, f).not.toMatch(/auth\.json|\.credentials|keychain|security find-|\.ssh\b|\.netrc/i);
      expect(s, f).not.toMatch(/\/Users\/[a-z]|\/home\/[a-z]/i);
    }
  });

  it('M3-B1：外发入口必须经过“已确认外发说明”检查；确认记录只在主进程写入', () => {
    const d = read('src/core/app/disclosure.ts');
    expect(d).toMatch(/async requireAccepted\(\)/);
    expect(d).toMatch(/throw new Error\('你还没有确认外发说明/);
    // 渲染进程 API 里没有“写入确认记录”之外的外发能力；acceptDisclosure 不接受参数
    expect(read('src/preload/index.cts')).toMatch(/acceptDisclosure: \(\) =>/);
  });

  it('M3-B1 遗留：src/main 中每个 ClaudeCliThinker 构造点都必须显式传入 isPackaged', () => {
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
