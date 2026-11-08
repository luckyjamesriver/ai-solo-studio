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

  // ---------- M3-B3-2 新增（只增不减） ----------
  const rendererFiles = walk('src/renderer').filter((f) => /\.(ts|tsx)$/.test(f));
  /** 渲染层的“显示文字”：字符串字面量与 JSX 文本（不含注释、不含标识符） */
  const displayStrings = (src: string): string[] => {
    const code = stripComments(src);
    const lits = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
    const jsx = [...code.matchAll(/>([^<>{}]*[^\s<>{}][^<>{}]*)</g)].map((m) => m[1]!);
    return [...lits, ...jsx];
  };
  const INTERNAL_WORDS = /sandbox|\bnever\b|danger[-_ ]?full|full[-_]access|permission[ _-]?profile|approvalPolicy|default_permissions|execpolicy|workspace[-_ ]?write|seatbelt|acceptWith|studio_standard/i;

  it('B3-2：渲染层的显示文字里不得出现内部名词（sandbox / never / danger-full-access / permission profile 等）', () => {
    expect(rendererFiles.length).toBeGreaterThan(5);
    for (const f of rendererFiles) {
      for (const s of displayStrings(fs.readFileSync(f, 'utf8'))) expect(s, `${f}：“${s}”`).not.toMatch(INTERNAL_WORDS);
    }
    // 文案文件确实被检查到了
    expect(rendererFiles.some((f) => f.endsWith('copy.ts'))).toBe(true);
    // 断言自身有效：样例会被匹配；JSX 文本与字面量都能提取
    expect('sandbox mode').toMatch(INTERNAL_WORDS);
    expect('danger-full-access').toMatch(INTERNAL_WORDS);
    expect('permission profile').toMatch(INTERNAL_WORDS);
    expect(displayStrings("const a = 'x never y'; const b = <p>danger-full-access</p>;")).toEqual(expect.arrayContaining(['x never y', 'danger-full-access']));
    // 任何位置不显示原始命令：渲染层没有读取“命令”字段的代码
    for (const f of rendererFiles) expect(stripComments(fs.readFileSync(f, 'utf8')), f).not.toMatch(/\.command\b|\bargv\b/);
  });

  it('B3-2：施工视图组件只有“停止”一个按钮，不含任何“允许 / 批准 / 同意 / 授权 / 确认”类按钮或文字', () => {
    const code = stripComments(read('src/renderer/RunView.tsx'));
    const buttons = [...code.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/>\{COPY\.stopButton\}</);
    expect(read('src/renderer/copy.ts')).toMatch(/stopButton: '停止'/);
    const words = /允许|批准|同意|授权|确认|accept|approve|allow|decline/i;
    expect(code).not.toMatch(words);
    expect(displayStrings(read('src/renderer/RunView.tsx')).join('')).not.toMatch(words);
    // 施工视图不接收“决定”类回调：只有 onStop
    expect(code).toMatch(/\{ task, onStop \}/);
    // 断言自身有效
    expect('<button>允许</button>').toMatch(words);
    expect([...'<button a>1</button><button>2</button>'.matchAll(/<button\b[\s\S]*?<\/button>/g)]).toHaveLength(2);
  });

  it('B3-2：完全信任的开工入口只有一处——确认面板；“确认并开工”在未勾选时是禁用的', () => {
    const plan = stripComments(read('src/renderer/PlanCard.tsx'));
    // 渲染层只有 confirmTrust 会以 ack=true 开工，且它只挂在确认按钮上
    expect(plan.match(/startTask\([^)]*true\)/g)).toHaveLength(1);
    expect(plan).toMatch(/disabled=\{!ack\} onClick=\{onConfirm\}/);
    // 标准模式开工传 false；任何地方都不得以偏好为由直接传 true
    expect(plan.match(/startTask\([^)]*false\)/g)).toHaveLength(1);
    expect(plan).not.toMatch(/preferredMode[^;\n]*startTask/);
  });

  it('B3-1b（新增，只收紧）：标准模式的可写根中不得出现 .git 路径（含 .git/worktrees/<id>）；可写根只有副本与额外目录', async () => {
    const { codexLaunchConfig } = await import('../src/core/executor/adapters/codex.js');
    const { resolveCapabilities } = await import('../src/core/capabilities/model.js');
    const worktree = '/proj/.studio/worktrees/t1';
    for (const caps of [resolveCapabilities(), resolveCapabilities({ extraWritableDirs: ['/data/out'], externalNetwork: 'on' })]) {
      const cfg = codexLaunchConfig(worktree, { capabilities: caps });
      const profile = cfg.args.find((a) => a.startsWith('permissions.')) ?? '';
      const writes = [...profile.matchAll(/"((?:[^"\\]|\\.)*)"="write"/g)].map((m) => m[1]!);
      expect(writes.sort()).toEqual([worktree, ...caps.extraWritableDirs].sort());
      for (const w of writes) expect(w, `可写根不得含 .git：${w}`).not.toMatch(/(^|\/)\.git(\/|$)/);
    }
    // 断言自身有效：样例确实会被匹配
    expect('/proj/.git/worktrees/t1').toMatch(/(^|\/)\.git(\/|$)/);
    expect('/proj/.gitignore-dir/x').not.toMatch(/(^|\/)\.git(\/|$)/);
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
    // B3-2 修订（任务界面必需的新 API；原清单是前 8 项）：清单仍然固定，参数形态逐一列出——
    // 只允许 编号 / 布尔 / 需求文字 / 计划表单（文字、模式、布尔）/ 选项键；任何参数都不得叫 path/dir/folder/file，
    // 额外文件夹由主进程弹系统选择框取得，渲染进程不传路径。
    expect(entries.map((e) => e.name)).toEqual(['detectEnvironment', 'chooseProject', 'recentProjects', 'openRecent', 'projectStatus', 'initProject', 'getDisclosure', 'acceptDisclosure', 'listTasks', 'createTask', 'getTask', 'savePlan', 'addExtraDir', 'removeExtraDir', 'startTask', 'stopTask', 'getAcceptanceView', 'confirmCriterion', 'confirmOverall', 'ackDenied', 'recheck', 'saveTask', 'discardTask', 'undoSave', 'retryCleanup', 'revealProject']);
    // B4-2 修订（只增不减）：新增 10 个方法（9 个验收操作 + 1 个无参数的 revealProject）；新增的参数形态只有
    // “编号 / 条目编号 / 验收版本（字符串）”，原有形态一个不变。
    const SHAPES = ['', 'id: string', 'consent: boolean', 'request: string', 'id: string, plan: PlanInput', 'id: string, key: string', 'id: string, ack: boolean', 'id: string, version: string', 'id: string, itemId: string, version: string'];
    for (const e of entries) {
      expect(SHAPES, `${e.name}(${e.params})`).toContain(e.params);
      expect(e.params, `${e.name} 不得有路径类参数`).not.toMatch(/\b(?:path|paths|dir|dirs|folder|file|filename|cwd|url)\b\s*:/i);
    }
    // 计划表单类型里同样没有路径字段
    const planType = /interface PlanInput \{([\s\S]*?)\}/.exec(preload)?.[1] ?? '';
    expect(planType).toMatch(/goal: string/);
    expect(planType).not.toMatch(/path|dir|folder|file|cwd|url/i);
    // 每个 IPC 通道在主进程中都有处理函数，且主进程处理函数的参数形态同样固定
    const main = read('src/main/index.ts');
    for (const e of entries) expect(main, e.channel).toContain(`ipcMain.handle('${e.channel}'`);
    const MAIN_SHAPES = ['', '_e', '_e, id: unknown', '_e, consent: unknown', '_e, request: unknown', '_e, id: unknown, plan: unknown', '_e, id: unknown, key: unknown', '_e, id: unknown, ack: unknown', '_e, id: unknown, version: unknown', '_e, id: unknown, itemId: unknown, version: unknown'];
    for (const m of main.matchAll(/ipcMain\.handle\('[^']+',\s*(?:async\s*)?\(([^)]*)\)/g)) {
      expect(MAIN_SHAPES, m[1]).toContain(m[1]);
    }
    // 额外文件夹的路径只来自主进程里的系统选择框，且必须经 validateExtraDir 校验（在控制器里）
    expect(read('src/core/app/task-controller.ts')).toMatch(/validateExtraDir\(picked/);
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

  /**
   * M3-B4-1（新增，只收紧；没有放宽或修改任何已有断言）：受控 Git 层与保存流程。
   */
  describe('B4-1：受控 Git 层', () => {
    const DIRECT_GIT = /\b(?:run|runProcess|spawn|spawnSync|execFile|execFileSync)\(\s*['"]git['"]|['"]git['"]\s*,\s*\[/;
    /** 取出从 start 开始、到下一个行首 `}`（函数结束）为止的源码 */
    const fnBody = (src: string, start: string): string => {
      const i = src.indexOf(start);
      expect(i, `找不到 ${start}`).toBeGreaterThanOrEqual(0);
      const j = src.indexOf('\n}\n', i);
      return src.slice(i, j === -1 ? undefined : j);
    };
    const methodBody = (src: string, start: string): string => {
      const i = src.indexOf(start);
      expect(i, `找不到 ${start}`).toBeGreaterThanOrEqual(0);
      const j = src.indexOf('\n  }\n', i);
      return src.slice(i, j === -1 ? undefined : j);
    };

    it('src 中除 git.ts 外不得直接调用 git（run(\'git\' / [\'git\', [...] 等）；断言自身有效', () => {
      for (const [f, s] of sources) {
        if (f.endsWith(path.join('core', 'git', 'git.ts'))) continue;
        expect(s, `${f} 直接调用了 git，必须经 git.ts 的统一入口`).not.toMatch(DIRECT_GIT);
      }
      expect("run('git', args)").toMatch(DIRECT_GIT);
      expect("spawn('git', ['status'])").toMatch(DIRECT_GIT);
      expect("const argv = ['git', ['x']]").toMatch(DIRECT_GIT);
      expect("resolveTool('git', {})").not.toMatch(DIRECT_GIT); // 只是工具名，不是调用
    });

    it('git.ts 的统一入口固定附加 hooksPath、fsmonitor、gpgsign 三项参数（并且真的用在调用里）', () => {
      const g = read('src/core/git/git.ts');
      expect(g).toContain("'core.hooksPath=/dev/null'");
      expect(g).toContain("'core.fsmonitor=false'");
      expect(g).toContain("'commit.gpgsign=false'");
      expect(g).toContain("'tag.gpgsign=false'");
      expect(g).toContain("'diff.external='");
      expect(fnBody(g, 'export async function git(')).toContain('...SAFE_GIT_CONFIG');
      const dec = fnBody(g, 'function decorate(');
      expect(dec).toContain('--no-ext-diff');
      expect(dec).toContain('--no-textconv');
      expect(dec).toContain('--no-verify');
    });

    it('保存函数必须调用外部驱动检测、与 acceptedTree 比对，并用 commit-tree 生成任务提交（不再 add -A）', () => {
      const r = read('src/core/task/runner.ts');
      const save = methodBody(r, 'private async doSave(');
      expect(save).toContain('detectExternalDrivers(');
      expect(save).toContain('computeTree(');
      expect(save).toMatch(/tree\s*!==\s*t\.acceptedTree/);
      expect(save).toContain('commitTree(');
      expect(save).not.toMatch(/'add'|commitWorktree|--no-verify=false/);
      expect(r).not.toContain('commitWorktree'); // runner 不再使用“add -A 后提交”
      // 撤销同样受外部驱动检测约束
      expect(methodBody(r, 'async undo(')).toContain('detectExternalDrivers(');
      // 开工创建副本前（checkout 会触发 smudge 驱动）也必须先检测
      expect(r.indexOf('detectExternalDrivers(this.opts.repo)')).toBeLessThan(r.indexOf('G.createWorktree('));
    });

    it('removeWorktree 不得吞错（不得 .catch(() => undefined)）；清理前校验只针对本任务', () => {
      const g = read('src/core/git/git.ts');
      const body = fnBody(g, 'export async function removeWorktree(');
      expect(body).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*undefined\s*\)/);
      expect(body).toContain('checkOwnWorktree(');
      expect(fnBody(g, 'function checkOwnWorktree(')).toContain('.studio');
      // 断言自身有效
      expect("await git(a).catch(() => undefined)").toMatch(/\.catch\(\s*\(\)\s*=>\s*undefined\s*\)/);
    });
  });

  /**
   * M3-B4-2（新增，只收紧）：渲染层隔离、新增 IPC 的参数形态、启动核对必须先核实进程。
   */
  describe('B4-2：验收界面与启动核对', () => {
    const rendererFiles = walk('src/renderer').filter((f) => /\.(ts|tsx)$/.test(f));
    const methodBody = (src: string, start: string): string => {
      const i = src.indexOf(start);
      expect(i, `找不到 ${start}`).toBeGreaterThanOrEqual(0);
      const j = src.indexOf('\n  }\n', i);
      return src.slice(i, j === -1 ? undefined : j);
    };

    it('渲染层源码不得引用 AcceptanceCard 类型或 evidence 字段；断言自身有效', () => {
      expect(rendererFiles.length).toBeGreaterThan(5);
      for (const f of rendererFiles) {
        const s = read(f);
        expect(s, f).not.toMatch(/AcceptanceCard/);
        expect(s, f).not.toMatch(/\bevidence\b/i);
      }
      expect('import type { AcceptanceCard } from "x"').toMatch(/AcceptanceCard/);
      expect('card.items[0].evidence').toMatch(/\bevidence\b/i);
    });

    it('渲染层不得出现“仍然保存”“强制保存”“全部确认”“让 AI 修改”；断言自身有效', () => {
      const banned = /仍然保存|强制保存|全部确认|让 ?AI ?修改/;
      for (const f of rendererFiles) expect(read(f), f).not.toMatch(banned);
      for (const sample of ['仍然保存', '强制保存', '全部确认', '让 AI 修改', '让AI修改']) expect(sample).toMatch(banned);
    });

    it('渲染层对 core 只有类型引用（import type / export type），不引用任何运行时代码', () => {
      for (const f of rendererFiles) {
        for (const m of read(f).matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
          if (/\/core\//.test(m[3]!)) expect(m[2], `${f}: 对 ${m[3]} 必须是 type 引用`).toBeTruthy();
        }
      }
    });

    it('新增 IPC 的 preload 方法：参数只有 id / itemId / version（字符串），revealProject 无参数；主进程处理函数与通道一一对应', () => {
      const preload = read('src/preload/index.cts');
      const NEW: Record<string, string> = {
        getAcceptanceView: 'id: string',
        confirmCriterion: 'id: string, itemId: string, version: string',
        confirmOverall: 'id: string, version: string',
        ackDenied: 'id: string, itemId: string, version: string',
        recheck: 'id: string',
        saveTask: 'id: string, version: string',
        discardTask: 'id: string',
        undoSave: 'id: string',
        retryCleanup: 'id: string',
        revealProject: '',
      };
      for (const [name, params] of Object.entries(NEW)) {
        const m = new RegExp(`^\\s{2}${name}: \\(([^)]*)\\) =>\\s*ipcRenderer\\.invoke\\('([^']+)'`, 'm').exec(preload);
        expect(m, `preload 缺少 ${name}`).toBeTruthy();
        expect(m![1], name).toBe(params);
        expect(read('src/main/index.ts'), name).toContain(`ipcMain.handle('${m![2]}'`);
      }
      // 控制器对条目编号与版本做格式校验（伪造参数拒绝）
      const c = read('src/core/app/task-controller.ts');
      expect(c).toMatch(/const TASK_ID = \/\^\[a-z0-9-\]\{1,64\}\$\//);
      expect(c).toContain('/^c\\d{1,2}$/');
      expect(c).toContain('/^d\\d{1,3}$/');
      expect(c).toContain('isVersionFormat(v)');
      // revealProject 的位置只来自主进程里的当前项目
      expect(read('src/main/index.ts')).toMatch(/ipcMain\.handle\('project:reveal',\s*\(\)\s*=>\s*\{\s*shell\.showItemInFolder\(requireProject\(\)\)/);
    });

    it('启动核对：reconcile 路径上 removeWorktree 之前必须先有进程核实；reconcileTasks 本身不直接删除；强制删除只在 git.ts', () => {
      const r = read('src/core/task/runner.ts');
      const clean = methodBody(r, 'private async reconcileCleanup(');
      const verify = clean.indexOf('verifyNoLiveExecutor(');
      const remove = clean.indexOf('G.removeWorktree(');
      expect(verify, 'reconcileCleanup 必须调用 verifyNoLiveExecutor').toBeGreaterThanOrEqual(0);
      expect(remove, 'reconcileCleanup 必须调用 removeWorktree').toBeGreaterThan(verify);
      expect(clean.indexOf('worktreeOwnershipProblem(')).toBeGreaterThanOrEqual(0);
      expect(clean.indexOf('worktreeOwnershipProblem(')).toBeLessThan(remove);
      // reconcileTasks / inspectTask / identifyTasks 里不得直接调用 removeWorktree
      for (const name of ['async reconcileTasks(', 'async inspectTask(', 'async identifyTasks(']) {
        expect(methodBody(r, name), name).not.toContain('removeWorktree(');
      }
      // 启动核对的保存收尾必须走 reconcileCleanup
      const fin = methodBody(r, 'private async finishSave(');
      expect(fin).toContain('this.reconcileCleanup(');
      // identifyTasks / inspectTask 是只读的：不得写任务记录或改状态
      for (const name of ['async inspectTask(', 'async identifyTasks(']) {
        expect(methodBody(r, name), name).not.toMatch(/this\.persist\(|this\.fire\(|this\.store\.save\(|this\.opStep\(|this\.endOp\(/);
      }
      // 强制删除副本的参数只出现在 git.ts 一处
      for (const [f, s] of sources) {
        if (f.endsWith(path.join('core', 'git', 'git.ts'))) continue;
        expect(s, f).not.toMatch(/worktree['"],\s*['"]remove['"]/);
      }
    });

    it('重试清理（B4-2-fix）：retryCleanup 不直接删除，必须经 reconcileCleanup（归属 → verifyNoLiveExecutor → removeWorktree）', () => {
      const r = read('src/core/task/runner.ts');
      const retry = methodBody(r, 'async retryCleanup(');
      expect(retry).toContain('this.reconcileCleanup(');
      expect(retry).not.toContain('removeWorktree(');
      const clean = methodBody(r, 'private async reconcileCleanup(');
      expect(clean.indexOf('verifyNoLiveExecutor(')).toBeGreaterThanOrEqual(0);
      expect(clean.indexOf('verifyNoLiveExecutor(')).toBeLessThan(clean.indexOf('G.removeWorktree('));
      // runner 中所有 removeWorktree 调用点固定为三处：reconcileCleanup、用户确认放弃（discard）、用户确认保存后的正常收尾（finishSave 的非核对分支）
      expect([...r.matchAll(/G\.removeWorktree\(/g)].length).toBe(3);
      expect(methodBody(r, 'async discard(')).toContain('G.removeWorktree(');
      expect(methodBody(r, 'private async finishSave(')).toContain('G.removeWorktree(');
    });

    it('B4-2-fix：解析 Git 文件名输出一律用 -z（diffSummary、import 的 status）；不再按行拆分带引号的文件名', () => {
      const g = read('src/core/git/git.ts');
      expect(g).toContain("['diff', '--name-status', '-z', '-M'");
      expect(g).toContain("['diff', '--numstat', '-z', '-M'");
      expect(read('src/core/thinking/handoff/import.ts')).toContain("'status', '--porcelain=v1', '-z'");
      for (const [f, s] of sources) expect(s, f).not.toMatch(/'--name-status'(?!,\s*'-z')|'--numstat'(?!,\s*'-z')|'status',\s*'--porcelain'\]/);
    });

    it('view.ts 不引用命令、Git 原文类型：不读取 evidence / command / stderr 字段', () => {
      const v = stripComments(read('src/core/acceptance/view.ts'));
      expect(v).not.toMatch(/\.command\b|\.stderr\b|\.stdout\b|\bcleanup\b\.steps|\.steps\b/);
      // 证据文字只允许两种用法：取秒数（只取数字）、按类别选固定文案；不得被拼进视图
      const rest = v.replace(/it\.evidence\.match\(/g, '').replace(/notCheckedText\(it\.key, it\.evidence\)/g, '');
      expect(rest).not.toMatch(/\bevidence\b/);
    });
  });

  /**
   * ADR 0005 / 0006（新增，只收紧）：依赖边界检查——状态文件只能经持久化层写入，UI 与 Agent 绕不过 Repository。
   * 豁免清单只许减少、不许增加；每条规则都带“应当命中”的反例样本，证明检查本身有效。
   */
  describe('ADR 0006：持久化依赖边界', () => {
    const rel = (f: string) => f.split(path.sep).join('/');
    const inPersistence = (f: string) => rel(f).startsWith('src/core/persistence/');
    const FS_WRITE = /\b(?:fs|fsp|fsSync|promises)\.(?:writeFile|appendFile|rename|rm|rmdir|mkdir|link|truncate|unlink|copyFile|cp|createWriteStream|mkdtemp|symlink|chmod|writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync)\(|(?<![.\w])(?:writeFile|appendFile|mkdir|rm|rename|mkdtemp|unlink|truncate)\(/;
    /** 豁免：模拟执行体把文件写进“任务副本”（它是测试用执行体，写的是被施工的源码，不是状态） */
    const FS_WRITE_EXEMPT = ['src/core/executor/adapters/fake.ts'];
    const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]!);
    const PERSIST_API = /persistence\/(?:index|store|update|legacy|errors|patch)(?:\.js)?$/;
    const PERSIST_FILES = /persistence\/files(?:\.js)?$/;

    it('src 里只有 src/core/persistence/ 可以直接写文件（writeFile / rename / mkdir / rm / appendFile …）；豁免清单固定；断言自身有效', () => {
      const offenders = sources.filter(([f, s]) => !inPersistence(f) && FS_WRITE.test(stripComments(s))).map(([f]) => rel(f));
      expect(offenders).toEqual(FS_WRITE_EXEMPT);
      for (const sample of ['await fs.writeFile(p, x)', 'await fs.promises.rename(a, b)', 'await mkdir(dir)', 'fsSync.rmSync(d)', 'await fs.appendFile(f, t)']) expect(sample, sample).toMatch(FS_WRITE);
      for (const ok of ['await fs.readFile(p)', 'const x = form(a)', 'array.rm', 'term(x)']) expect(ok, ok).not.toMatch(FS_WRITE);
    });

    it('持久化服务与 Repository（persistence/index、store …）只能被任务存储、编排器、应用存储与控制层、主进程引用；UI 与 Agent 不得引用', () => {
      const ALLOWED = [
        'src/core/app/app-store.ts',
        'src/core/app/disclosure.ts',
        'src/core/app/prefs.ts',
        'src/core/app/recent.ts',
        'src/core/app/task-controller.ts',
        'src/core/task/runner.ts',
        'src/core/task/store.ts',
        'src/main/index.ts',
      ];
      const users = sources.filter(([f, s]) => !inPersistence(f) && importsOf(stripComments(s)).some((i) => PERSIST_API.test(i))).map(([f]) => rel(f));
      expect(users.sort()).toEqual(ALLOWED);
      // UI（renderer）、Agent（executor、thinking）、git、checks 等一律不在其中
      for (const f of users) expect(f, f).not.toMatch(/^src\/(?:renderer|preload)\/|^src\/core\/(?:executor|thinking|git|checks|policy|proc|env|capabilities|acceptance)\//);
      // 反例样本
      expect(importsOf("import { RecordStore } from '../persistence/index.js';")).toEqual(['../persistence/index.js']);
      expect('../persistence/store.js').toMatch(PERSIST_API);
      expect('../persistence/files.js').not.toMatch(PERSIST_API);
    });

    it('持久化文件原语（persistence/files）只能被这几个模块引用（清单只许减少）', () => {
      const ALLOWED = ['src/core/checks/scripts.ts', 'src/core/git/git.ts', 'src/core/thinking/claude-cli.ts', 'src/core/thinking/codex.ts', 'src/core/thinking/flow/store.ts'];
      const users = sources.filter(([f, s]) => !inPersistence(f) && importsOf(stripComments(s)).some((i) => PERSIST_FILES.test(i))).map(([f]) => rel(f));
      expect(users.sort()).toEqual(ALLOWED);
      expect('../../persistence/files.js').toMatch(PERSIST_FILES);
    });

    it('write-file-atomic 与 proper-lockfile 只在持久化层使用；zod 只在持久化层与存储模块使用', () => {
      for (const [f, s] of sources) {
        const imps = importsOf(stripComments(s));
        if (!inPersistence(f)) {
          expect(imps.filter((i) => /^(?:write-file-atomic|proper-lockfile)$/.test(i)), f).toEqual([]);
          if (!['src/core/task/store.ts', 'src/core/app/app-store.ts'].includes(rel(f))) expect(imps.filter((i) => i === 'zod'), f).toEqual([]);
        }
      }
    });

    it('所有写记录的入口都带 runId、attemptId、expectedRevision（CAS）：commit 的命令类型必填这三项，TaskStore.save 总是传齐', () => {
      const store = read('src/core/persistence/store.ts');
      const cmdType = /export interface CommitCmd \{([\s\S]*?)\n\}/.exec(store)?.[1] ?? '';
      for (const field of ['runId: string', 'attemptId: string', 'expectedRevision: number']) expect(cmdType).toContain(field);
      const ts = read('src/core/task/store.ts');
      expect(ts).toMatch(/runId: runId \?\? 'init', attemptId: opts\.attemptId \?\? RecordStore\.newAttemptId\(\), expectedRevision: revision \?\? 0/);
      // 提交顺序：先追加日志，后写汇总（出现顺序）
      const body = store.slice(store.indexOf('private async commitLocked'));
      expect(body.indexOf('await this.logEvent(ev)')).toBeGreaterThan(0);
      expect(body.indexOf('await this.logEvent(ev)')).toBeLessThan(body.indexOf('await atomicWrite(file'));
    });
  });
});
