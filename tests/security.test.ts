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

  /**
   * M3-B3-1 修订（维护者 2026-11-08 批准，范围严格限定，见 docs/plans/2026-11-08-B3.md 第 5 节）：
   * 原断言：Codex 适配器源码与生成的参数中完全不得出现 danger-full-access / dangerFullAccess / "never" / =never，
   *        且必须是 sandbox_mode="workspace-write" + approval_policy="on-request" + 线程审批 untrusted。
   * 新断言：
   *  1) never 只允许出现在模式映射模块（src/core/executor/modes.ts）；其他源码位置仍然禁止；
   *  2) danger-full-access / dangerFullAccess 只允许出现在 modes.ts，且只在完全信任分支（buildFullTrustMode），
   *     该函数必须调用 requireFullTrustConfirmed；
   *  3) 全部源码不得出现 acceptWithExecpolicyAmendment（“以后都允许”）；
   *  4) 不得出现 sandbox_mode 与 default_permissions 同时配置（逐文件 + 生成的参数）；
   *  5) 检查脚本运行路径不得直接使用 proc/run 启动 npm（必须经 command/exec）。
   * 其余禁止项（dangerously、--yolo、bypass、full-auto、登录凭证文件）不变，仍对全部相关源码生效。
   */
  const MODES = 'src/core/executor/modes.ts';
  const neverLiteral = /["'`]never["'`]|=never\b|=["']never["']/;
  const fullAccess = /danger-full-access|dangerFullAccess/;
  const stillForbidden = /dangerously|--yolo|bypass|full-auto/i;

  it('B3-1：never 与 danger-full-access 只出现在模式映射模块；完全信任分支必须经过门禁；其余禁止项不变', () => {
    for (const [f, s] of sources) {
      const code = stripComments(s);
      if (f !== path.join('src', 'core', 'executor', 'modes.ts')) {
        expect(code, `${f} 不得出现 never`).not.toMatch(neverLiteral);
        expect(code, `${f} 不得出现 danger-full-access`).not.toMatch(fullAccess);
      }
    }
    for (const f of ['src/core/executor/adapters/codex.ts', 'src/core/executor/adapters/codex-command.ts', 'src/core/executor/adapters/codex-readonly.ts', MODES]) {
      expect(stripComments(read(f)), f).not.toMatch(stillForbidden);
    }
    // modes.ts：danger-full-access 只出现在完全信任构建函数里，且该函数调用 requireFullTrustConfirmed
    const code = stripComments(read(MODES));
    const fnStart = code.indexOf('export async function buildFullTrustMode');
    expect(fnStart).toBeGreaterThan(0);
    const next = code.indexOf('\nexport ', fnStart + 10);
    const fn = code.slice(fnStart, next === -1 ? undefined : next);
    expect(fn).toMatch(/await requireFullTrustConfirmed\(/);
    expect(fn.indexOf('requireFullTrustConfirmed(')).toBeLessThan(fn.search(fullAccess)); // 先过门禁，再出现完全信任参数
    const outside = code.slice(0, fnStart) + (next === -1 ? '' : code.slice(next));
    // 函数之外只有期望值核验里的比较（出现类型名而不是启动参数）；启动参数形式 danger-full-access 不得出现在函数之外
    expect(outside).not.toMatch(/danger-full-access/);
    expect([...outside.matchAll(/dangerFullAccess/g)].length).toBeLessThanOrEqual(3); // 类型声明、期望值与核验
    // 断言自身有效：样例确实会被匹配
    expect("approvalPolicy: 'never'").toMatch(neverLiteral);
    expect('x=never').toMatch(neverLiteral);
    expect("sandbox: 'danger-full-access'").toMatch(fullAccess);
  });

  it('B3-1：全部源码不得出现“以后都允许”（acceptWithExecpolicyAmendment）；审批回调在施工模式下只回 decline', () => {
    for (const [f, s] of sources) expect(s, f).not.toMatch(/acceptWithExecpolicyAmendment|execpolicy_amendment|ExecpolicyAmendment/i);
    const codex = stripComments(read('src/core/executor/adapters/codex.ts'));
    // 施工模式下唯一的审批处理函数只写 decline
    const m = /const rejectUnexpectedApproval[\s\S]*?\n    \};/.exec(codex);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/decision: 'decline'/);
    expect(m![0]).not.toMatch(/accept/i);
    // 回复 accept 的唯一位置是思考层的只读流程（respond('allow')），且受 constructionMode 分支保护
    expect(codex).toMatch(/if \(constructionMode && \(m\.method === 'item\/commandExecution\/requestApproval'/);
    expect(codex.match(/'accept'/g)?.length).toBe(1);
    // 断言自身有效
    expect('{ acceptWithExecpolicyAmendment: {} }').toMatch(/acceptWithExecpolicyAmendment/);
  });

  it('B3-1：不得同时配置 sandbox_mode 与 default_permissions（逐文件 + 生成的参数）', async () => {
    const legacy = /sandbox_mode=["'`]|sandbox_mode=\\?"/;
    const profile = /default_permissions=["'`$]|default_permissions=\\?"/;
    for (const [f, s] of sources) {
      const code = stripComments(s);
      expect(legacy.test(code) && profile.test(code), `${f} 同时配置了 sandbox_mode 与 default_permissions`).toBe(false);
    }
    expect(stripComments(read(MODES))).not.toMatch(legacy);
    expect(stripComments(read('src/core/executor/adapters/codex-readonly.ts'))).not.toMatch(profile);
    const { codexLaunchConfig, permissionLaunchFor } = await import('../src/core/executor/adapters/codex.js');
    const { resolveCapabilities } = await import('../src/core/capabilities/model.js');
    for (const caps of [resolveCapabilities(), resolveCapabilities({ externalNetwork: 'on' }), resolveCapabilities({ fileAccess: 'worktree_read_only' })]) {
      const cfg = codexLaunchConfig('/work/tree', { model: 'm', capabilities: caps });
      const hasLegacy = cfg.args.some((a) => /^sandbox_mode=/.test(a));
      const hasProfile = cfg.args.some((a) => /^default_permissions=/.test(a));
      expect(hasLegacy && hasProfile).toBe(false);
      expect(hasLegacy || hasProfile).toBe(true);
      // 标准模式没有任何完全信任字样；线程/回合参数里也没有
      if (caps.fileAccess === 'worktree_write') expect(JSON.stringify(cfg)).not.toMatch(fullAccess);
    }
    expect(permissionLaunchFor('/w', resolveCapabilities()).args).toContain('default_permissions="studio_standard"');
    // 断言自身有效
    expect('sandbox_mode="workspace-write" default_permissions="x"').toMatch(legacy);
    expect('-c default_permissions="x"').toMatch(profile);
  });

  it('B3-1：检查脚本不得由宿主直接运行（不得用 proc/run 启动 npm），必须经沙箱运行器（command/exec）', () => {
    const s = stripComments(read('src/core/checks/scripts.ts'));
    expect(s).not.toMatch(/from ['"][^'"]*proc\/run(?:\.js)?['"][^;\n]*\brun\b|import\s*\{[^}]*\brun\b[^}]*\}\s*from\s*['"][^'"]*proc\/run/);
    expect(s).not.toMatch(/node:child_process|\bspawn\(|\bexecFile\(|\bfork\(/);
    expect(s).toMatch(/runner\.runCommand\(/);
    // 任务编排器不得自己启动 npm，也不得为检查直接引入进程运行模块
    const r = stripComments(read('src/core/task/runner.ts'));
    expect(r).not.toMatch(/proc\/run|child_process|['"]npm['"]/);
    // 沙箱运行器的实现通过 app-server 的 command/exec
    expect(stripComments(read('src/core/executor/adapters/codex.ts'))).toMatch(/rpc\('command\/exec'/);
    // 只有 codex.ts / codex-command.ts 之外的源码里，没有任何地方把 'npm' 作为命令启动
    for (const [f, src] of sources) {
      if (f.endsWith(path.join('checks', 'scripts.ts'))) continue;
      expect(stripComments(src), f).not.toMatch(/\b(?:run|spawn|execFile)\(\s*(?:npm|['"]npm(?:\.cmd)?['"])/);
    }
    // 断言自身有效
    expect("import { run } from '../proc/run.js';").toMatch(/import\s*\{[^}]*\brun\b[^}]*\}\s*from\s*['"][^'"]*proc\/run/);
  });

  it('Codex 适配器：标准模式生成的参数符合预期（权限配置档 + never，无旧式沙箱参数）', async () => {
    const { codexLaunchConfig } = await import('../src/core/executor/adapters/codex.js');
    const cfg = codexLaunchConfig('/work/tree', { model: 'm' });
    expect(cfg.args).toContain('default_permissions="studio_standard"');
    expect(cfg.args.some((a) => /^sandbox_mode=/.test(a) || /^approval_policy=/.test(a))).toBe(false);
    expect(cfg.threadStart).toMatchObject({ approvalPolicy: 'never' });
    expect(cfg.threadStart).not.toHaveProperty('sandbox');
    expect(cfg.turnOverrides).toMatchObject({ approvalPolicy: 'never' });
    expect(cfg.turnOverrides).not.toHaveProperty('sandboxPolicy');
    // 思考层的只读启动保持原样：旧式只读 + 每条命令询问
    const { codexLaunchConfig: c2 } = await import('../src/core/executor/adapters/codex.js');
    const ro = c2('/work/tree', { capabilities: { fileAccess: 'worktree_read_only', externalNetwork: 'off', credentialAccess: 'none', grantedMcp: [], nonOfficialModelEndpoint: 'deny', constructionMode: 'standard', extraWritableDirs: [], allowedNetworkDomains: [] } });
    expect(ro.args).toContain('sandbox_mode="read-only"');
    expect(ro.threadStart).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
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
