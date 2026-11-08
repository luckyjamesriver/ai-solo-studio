import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexLaunchConfig, CodexExecutor } from '../../src/core/executor/adapters/codex.js';
import * as G from '../../src/core/git/git.js';
import { AppServerClient } from './appserver-client.js';
import { realEnabled } from './gate.js';

/**
 * M3-B3-1b：真实 worktree 下标准模式小实测（git 与 npm test）。默认跳过；经 `npm run test:real`，套件名 b3-1b（见 gate.ts）。
 * 测试仓库放在 ~/ai-solo-studio-b3wt-probe/（测试创建、结束删除）；任务 worktree 由产品代码自己的 createWorktree 生成。
 * 前半段用 command/exec（不经模型）；之后最多 3 次模型回合（各自的开关见 ONLY），每个回合只发送测试仓库里的内容。
 * 原始记录写入 ~/AI-CoWork-rebuild-import/b3-1b-events/。
 */
const enabled = realEnabled('b3-1b');
/** 单项重跑：把要跑的项写在这里（null = 全部）。不要在命令行加环境变量。 */
const ONLY = null as string[] | null;
const want = (id: string) => !ONLY || ONLY.includes(id);

const home = os.homedir();
const root = path.join(home, 'ai-solo-studio-b3wt-probe');
const logDir = path.join(home, 'AI-CoWork-rebuild-import', 'b3-1b-events');
const TASK_ID = 'wtprobe1';

let repo = '';
let wt: G.Worktree;
let gitDir = '';
let mcpNames: string[] = [];

const clip = (s: unknown, n = 300) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t && t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : (t ?? '');
};

function save(name: string, data: unknown) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${name}.json`), JSON.stringify(data, null, 2));
  console.info(`B3-1b ${name} ${JSON.stringify(data)}`);
}

/** 与产品一致：默认能力下的标准模式配置（permissionLaunchFor），只读取 MCP 名称后逐个关闭 */
function client() {
  const cfg = codexLaunchConfig(wt.path, { mcpServers: mcpNames });
  return { cfg, c: new AppServerClient(cfg.args, { cwd: wt.path }) };
}

async function exec(c: AppServerClient, argv: string[], env?: Record<string, string | null>) {
  const r = await c.rpc('command/exec', { command: argv, cwd: wt.path, timeoutMs: 60_000, ...(env ? { env } : {}) });
  return r.error ? { error: clip(r.error) } : { exitCode: r.result?.exitCode, stdout: clip(r.result?.stdout, 200), stderr: clip(r.result?.stderr, 500) };
}

describe.skipIf(!enabled)('M3-B3-1b：真实 worktree 下标准模式（git 与 npm test）', () => {
  beforeAll(async () => {
    if (fs.existsSync(root)) throw new Error(`${root} 已存在，为避免删除不属于本测试的内容而中止；请先确认并手动删除。`);
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
    repo = fs.realpathSync(path.join(root, 'repo'));
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n<html><head><title>Old Title</title></head><body><h1>Demo</h1></body></html>\n');
    fs.writeFileSync(path.join(repo, 'test.js'), "const fs = require('fs');\nconst m = /<title>(.*?)<\\/title>/.exec(fs.readFileSync('index.html', 'utf8'));\nif (!m || !m[1] || m[1] === 'Old Title') { console.error('title not updated'); process.exit(1); }\nconsole.log('ok: ' + m[1]);\n");
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'b3wt-demo', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
    await G.initRepo(repo); // 产品的初始化流程：init + 第一个保存点
    wt = await G.createWorktree(repo, TASK_ID); // 产品的 worktree 创建流程（任务运行器实际使用的函数）
    gitDir = path.join(repo, '.git', 'worktrees', TASK_ID);
    mcpNames = (await new CodexExecutor().preflight(wt.path)).mcpServers;
  }, 60_000);
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!want('cmd'))('1.1–1.6：worktree 内逐条命令（command/exec，不经模型）', async () => {
    const { cfg, c } = client();
    const out: Record<string, unknown> = { worktree: wt.path, expectedGitDir: gitDir };
    const OPT0 = { GIT_OPTIONAL_LOCKS: '0' };
    try {
      await c.init();
      const t = await c.rpc('thread/start', { ...cfg.threadStart });
      out.thread = { activePermissionProfile: t.result?.activePermissionProfile, approvalPolicy: t.result?.approvalPolicy };
      // 1
      out['1:git status'] = await exec(c, ['git', 'status']);
      out['1:git diff'] = await exec(c, ['git', 'diff']);
      out['1:git log -1'] = await exec(c, ['git', 'log', '-1', '--oneline']);
      out['1:git rev-parse --git-dir'] = await exec(c, ['git', 'rev-parse', '--git-dir']);
      // 2：改一个文件后再看
      out['2:modify index.html'] = await exec(c, ['/bin/sh', '-c', "printf '<!-- touched -->\\n' >> index.html && echo modified"]);
      out['2:git status'] = await exec(c, ['git', 'status']);
      out['2:git diff'] = await exec(c, ['git', 'diff']);
      // 5：同样的 1、2，加 GIT_OPTIONAL_LOCKS=0
      out['5:git status +OPTIONAL_LOCKS=0'] = await exec(c, ['git', 'status'], OPT0);
      out['5:git diff +OPTIONAL_LOCKS=0'] = await exec(c, ['git', 'diff'], OPT0);
      out['5:git log -1 +OPTIONAL_LOCKS=0'] = await exec(c, ['git', 'log', '-1', '--oneline'], OPT0);
      out['5:git rev-parse --git-dir +OPTIONAL_LOCKS=0'] = await exec(c, ['git', 'rev-parse', '--git-dir'], OPT0);
      // 3：git add -A（预期可能失败，如实记录）
      out['3:git add -A'] = await exec(c, ['git', 'add', '-A']);
      out['3:git status after add'] = await exec(c, ['git', 'status', '--short']);
      // 4
      out['4:npm run test'] = await exec(c, ['npm', 'run', 'test']);
      // 6：越界写入（都应被拒）
      out['6:write new file in .git/worktrees/<id>/'] = await exec(c, ['/bin/sh', '-c', `echo x > ${path.join(gitDir, 'probe-file')} && echo wrote`]);
      out['6:append to <repo>/.git/config'] = await exec(c, ['/bin/sh', '-c', `echo '# x' >> ${path.join(repo, '.git', 'config')} && echo wrote`]);
      out['6:write <repo> workspace file'] = await exec(c, ['/bin/sh', '-c', `echo x > ${path.join(repo, 'outside.txt')} && echo wrote`]);
      out['6:write <repo>/.git/hooks/pre-commit'] = await exec(c, ['/bin/sh', '-c', `echo x > ${path.join(repo, '.git', 'hooks', 'pre-commit')} && echo wrote`]);
    } finally {
      c.kill();
    }
    // 宿主侧复核：越界写入确实没有发生
    out.hostCheck = {
      gitDirProbeFileExists: fs.existsSync(path.join(gitDir, 'probe-file')),
      repoConfigHasMarker: fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8').includes('# x'),
      outsideFileExists: fs.existsSync(path.join(repo, 'outside.txt')),
      hookExists: fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')),
    };
    save('1-commands', out);
    expect(out.hostCheck).toEqual({ gitDirProbeFileExists: false, repoConfigHasMarker: false, outsideFileExists: false, hookExists: false });
  }, 240_000);

  // 补充：上一项的 stderr 被 xcrun 噪音占满且截断，看不到 git add 的真正错误。这里仅为本探测抑制噪音（TMPDIR 指向副本内 + DEVELOPER_DIR），并完整记录 stderr。
  it.skipIf(!want('cmd2'))('1.2/1.3/1.5 补充：抑制 xcrun 噪音后的完整 stderr（git add -A、只读命令）', async () => {
    const { cfg, c } = client();
    const tmp = path.join(wt.path, '.studio', 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const quiet = { TMPDIR: tmp, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' };
    const full = async (argv: string[], env: Record<string, string | null>) => {
      const r = await c.rpc('command/exec', { command: argv, cwd: wt.path, timeoutMs: 60_000, env });
      return r.error ? { error: clip(r.error, 800) } : { exitCode: r.result?.exitCode, stdout: clip(r.result?.stdout, 300), stderr: clip(r.result?.stderr, 1200) };
    };
    const out: Record<string, unknown> = {};
    try {
      await c.init();
      await c.rpc('thread/start', { ...cfg.threadStart });
      await exec(c, ['/bin/sh', '-c', "printf '<!-- touched2 -->\\n' >> index.html"]);
      out['status (modified tree)'] = await full(['git', 'status'], quiet);
      out['diff (modified tree)'] = await full(['git', 'diff', '--stat'], quiet);
      out['status +OPTIONAL_LOCKS=0'] = await full(['git', 'status'], { ...quiet, GIT_OPTIONAL_LOCKS: '0' });
      out['git add -A'] = await full(['git', 'add', '-A'], quiet);
      out['git add index.html'] = await full(['git', 'add', 'index.html'], quiet);
      out['git commit (expected to fail)'] = await full(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-am', 'x'], quiet);
      out['index/lock files left in gitdir'] = fs.readdirSync(gitDir).filter((f) => /lock|index/.test(f));
    } finally {
      c.kill();
    }
    save('1-commands-quiet', out);
    expect(Object.keys(out).length).toBeGreaterThan(5);
  }, 240_000);

  it.skipIf(!want('model1'))('模型回合 1：改标题、npm test、git status / git diff', async () => {
    // 回到干净的 worktree 状态（命令实测可能留下改动）
    fs.writeFileSync(path.join(wt.path, 'index.html'), '<!doctype html>\n<html><head><title>Old Title</title></head><body><h1>Demo</h1></body></html>\n');
    const { cfg, c } = client();
    const prompt = 'Change the page title in index.html to "WT Title", then run npm test, and finally look at the changes with git status and git diff.';
    let summary: Record<string, unknown> = {};
    try {
      await c.init();
      const t = await c.rpc('thread/start', { ...cfg.threadStart, ephemeral: true });
      const threadId = t.result?.thread?.id as string;
      const st = await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...cfg.turnOverrides });
      const done = await c.waitFor('turn/completed', 200_000);
      if (!done) await c.rpc('turn/interrupt', { threadId, turnId: st.result?.turn?.id }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      const items = c.notifications.filter((x) => x.method === 'item/completed').map((x) => x.params?.item ?? {});
      const cmds = items.filter((i) => i.type === 'commandExecution');
      summary = {
        threadProfile: t.result?.activePermissionProfile,
        turn: done ? c.notifications.find((x) => x.method === 'turn/completed')?.params?.turn?.status : 'hung',
        approvals: c.serverRequests.filter((x) => /requestApproval$/.test(x.method)).length,
        itemTypes: items.map((i) => i.type),
        commands: cmds.map((i) => ({ command: clip(i.command, 200), status: i.status, exitCode: i.exitCode, output: clip(i.aggregatedOutput, 400) })),
        fileChanges: items.filter((i) => i.type === 'fileChange').length,
        titleNow: /<title>(.*?)<\/title>/.exec(fs.readFileSync(path.join(wt.path, 'index.html'), 'utf8'))?.[1],
        finalMessage: clip(items.filter((i) => i.type === 'agentMessage').map((i) => String(i.text ?? '')).at(-1) ?? '', 400),
        errorNotifications: c.notifications.filter((x) => x.method === 'error').map((x) => clip(x.params, 300)),
      };
    } finally {
      c.kill();
    }
    // 宿主侧（不在沙箱内）：用产品代码读取该 worktree 的改动列表与 diff
    const changes = await G.diffSummary(wt);
    const diff = await G.diffText(wt);
    summary.hostSide = { changes, diffHasNewTitle: diff.includes('+<html><head><title>WT Title</title>'), diffHead: clip(diff, 500) };
    save('2-model-turn-1', summary);
    expect(summary.approvals).toBe(0);
  }, 300_000);
});
