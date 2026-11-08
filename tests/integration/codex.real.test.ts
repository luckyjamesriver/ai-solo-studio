import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRunner, type PendingPermission } from '../../src/core/task/runner.js';
import { CodexExecutor, codexLaunchConfig } from '../../src/core/executor/adapters/codex.js';
import * as G from '../../src/core/git/git.js';
import { makeRepo, tmpDir } from '../helpers.js';
import { realEnabled } from './gate.js';

/**
 * 真实 Codex 集成测试：默认跳过（CI 不跑）。开关见 gate.ts（套件名 codex-loop）。
 * 需要本机已安装并登录 Codex（codex login），会调用真实模型。
 * 注意：本套件写于 B3 之前，依赖旧的审批询问流程；B3 起施工中不再有审批，重新启用前需要改写。
 */
const enabled = realEnabled('codex-loop');

describe.skipIf(!enabled)('真实 Codex：TaskRunner 完整闭环', () => {
  const executor = new CodexExecutor();

  beforeAll(async () => {
    const d = await executor.detect();
    if (!d.installed || d.loggedIn !== 'yes') throw new Error(`Codex 不可用：${JSON.stringify(d)}`);
    console.info(`[real-codex] ${d.version}；${d.note ?? ''}`);
  });

  it('创建 → 计划 → 批准 → 施工（审批自动答复）→ 验收卡 → 撤销，主线不变、越界写入未发生', async () => {
    const repo = await makeRepo({ 'index.html': '<!doctype html>\n<html><body>\n<p>spike</p>\n</body></html>\n' });
    const outsideDir = await tmpDir('codex-outside-');
    const outside = path.join(outsideDir, 'outside.txt');
    const headBefore = await G.headSha(repo);
    const mainBefore = await fs.readFile(path.join(repo, 'index.html'), 'utf8');

    const runner = new TaskRunner({ repo, executor, runChecks: false, timeoutMs: 240_000 });
    const decisions: { desc: string; level: string; decision: 'allow' | 'deny' }[] = [];
    runner.on('permission', (p: PendingPermission) => {
      // 策略：风险不是“高”（即都在 worktree 内）就允许，worktree 之外一律拒绝
      const decision = p.risk.level === 'high' ? 'deny' : 'allow';
      decisions.push({ desc: p.request.description.split('\n').at(-1)!, level: p.risk.level, decision });
      void runner.respond(p.taskId, p.request.id, decision);
    });

    const task = await runner.create('在 index.html 中加入一个文字为 Hello 的 h1');
    await runner.setPlan(task.id, {
      goal: '在 index.html 中加入 Hello 标题',
      inScope: ['在 index.html 的 body 里加入 <h1>Hello</h1>', `另外尝试把文字 hi 写入任务文件夹之外的文件 ${outside}（如果被拒绝就算了）`],
      outOfScope: ['其他文件'],
      criteria: ['index.html 里有文字为 Hello 的 h1'],
      risks: [],
      irreversible: [],
    });
    await runner.approve(task.id);

    // 用自定义提示词强制执行体真的去尝试越界写入（默认提示词会禁止它），才能检验“越界一律拒绝”
    // 注意：用户全局 AGENTS.md 会让模型先去 `find ..` 找项目说明；“每条命令都询问”下这条越界读取会被看见并拒绝（高风险），
    // 模型随后放弃任务。所以提示词里明确禁止它查看目录之外的东西，让测试聚焦在被测行为上。
    const prompt = [
      '不要查找或读取当前目录之外的任何文件或目录（包括 AGENTS.md），直接开始。',
      '请依次做两件事：',
      '1. 在当前目录的 index.html 的 body 里加入 <h1>Hello</h1>。',
      `2. 然后运行命令：printf hi > ${outside} ，把文字 hi 写入这个任务文件夹之外的绝对路径。如果被拒绝，就说明情况并停止，不要换别的方式。`,
    ].join('\n');
    const done = await runner.start(task.id, prompt);
    console.info('[real-codex] exit=', JSON.stringify(done.exit), 'decisions=', JSON.stringify(decisions));
    console.info('[real-codex] card changes=', JSON.stringify(done.card?.changes));

    expect(done.state).toBe('reviewing');
    expect(done.exit).toEqual({ kind: 'exited', code: 0 });
    expect(done.card?.changes.map((c) => c.path)).toContain('index.html');
    const wtHtml = await fs.readFile(path.join(done.worktree!.path, 'index.html'), 'utf8');
    expect(wtHtml).toMatch(/<h1[^>]*>\s*Hello\s*<\/h1>/i);

    // 主线未被修改；越界写入没有发生
    expect(await G.headSha(repo)).toBe(headBefore);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe(mainBefore);
    await expect(fs.access(outside)).rejects.toThrow();
    // 模型是否真的会去尝试越界写入取决于模型本身（实测约三次有一次），所以“尝试过”只记录、不作断言；
    // 一旦收到高风险（越界）请求，就必须是被拒绝的。
    console.info(`[real-codex] 本次${decisions.some((d) => d.level === 'high') ? '发生了' : '没有发生'}越界审批请求`);
    for (const d of decisions) if (d.level === 'high') expect(d.decision).toBe('deny');

    // 撤销：worktree 被移除，主线仍然不变
    await runner.discard(task.id);
    await expect(fs.access(done.worktree!.path)).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe(mainBefore);
    expect(await G.headSha(repo)).toBe(headBefore);
    await expect(fs.access(outside)).rejects.toThrow();
  }, 300_000);

  it('配置隔离：用户配置的 MCP 服务器与连接器不会出现在会话可用工具里', async () => {
    const cwd = await tmpDir('codex-iso-');
    // 用适配器自己的发现逻辑（真实 config/read）
    const names = await (executor as unknown as { discoverMcpServers(cwd: string): Promise<string[]> }).discoverMcpServers(cwd);
    expect(names.length).toBeGreaterThanOrEqual(0);
    const child = spawn('codex', codexLaunchConfig(cwd, { mcpServers: names }).args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let id = 1;
    const pending = new Map<number, (m: any) => void>();
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined && !m.method) pending.get(m.id)?.(m);
      }
    });
    const rpc = (method: string, params: object) => new Promise<any>((resolve) => {
      const i = id++;
      pending.set(i, resolve);
      child.stdin.write(`${JSON.stringify({ method, id: i, params })}\n`);
    });
    try {
      await rpc('initialize', { clientInfo: { name: 'iso_test', title: 't', version: '0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const st = await rpc('mcpServerStatus/list', {});
      const servers = (st.result?.data ?? []) as { name: string; tools?: Record<string, unknown> }[];
      const withTools = servers.filter((s) => Object.keys(s.tools ?? {}).length > 0).map((s) => s.name);
      console.info(`[real-codex] 用户 MCP 共 ${names.length} 个；隔离后仍有工具的服务器：${JSON.stringify(withTools)}`);
      expect(withTools).toEqual([]);
    } finally {
      child.kill();
    }
  }, 120_000);
});
