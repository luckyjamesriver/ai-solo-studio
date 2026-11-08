import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRunner, buildPrompt, type PendingPermission } from '../src/core/task/runner.js';
import { Channel } from '../src/core/executor/channel.js';
import type { Executor, ExecutorEvent } from '../src/core/executor/types.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, testSandboxRunner } from './helpers.js';

const plan = {
  goal: '加入深色模式',
  inScope: ['首页支持深色'],
  outOfScope: ['其他页面'],
  criteria: ['首页可以切换深色'],
  risks: [],
  irreversible: [],
};

async function setup(script: FakeStep[], extra: Partial<ConstructorParameters<typeof TaskRunner>[0]> = {}, files?: Record<string, string>) {
  const repo = await makeRepo(files);
  const runner = new TaskRunner({ repo, executor: new FakeExecutor(script), runChecks: false, ...extra });
  const t = await runner.create('给首页加深色模式');
  await runner.setPlan(t.id, plan);
  await runner.approve(t.id);
  return { repo, runner, id: t.id };
}

describe('任务闭环（模拟执行体 + 真实 Git）', () => {
  it('快乐路径：施工 → 验收 → 确认 → 保存到主线', async () => {
    const { repo, runner, id } = await setup([
      { do: 'say', text: '开始修改' },
      { do: 'write', path: 'index.html', content: '<h1 class="dark">hello</h1>\n' },
      { do: 'exit', code: 0 },
    ]);
    const t = await runner.start(id);
    expect(t.state).toBe('reviewing');
    expect(t.card?.readyToSave).toBe(false); // 用户还没确认
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>hello</h1>\n'); // 主线未动

    expect((await runner.save(id)).ok).toBe(false); // 未确认不能保存
    await runner.confirm(id, { criterion: 0, decision: 'confirmed' });
    const r = await runner.save(id);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toContain('dark');
    expect((await runner.store.get(id))?.state).toBe('saved');
  });

  it('未批准不能开工', async () => {
    const repo = await makeRepo();
    const runner = new TaskRunner({ repo, executor: new FakeExecutor([]), runChecks: false });
    const t = await runner.create('x');
    await expect(runner.start(t.id)).rejects.toThrow(/批准/);
  });

  it('执行体非零退出：如实记录失败，不可保存，可撤销且主线不变', async () => {
    const { repo, runner, id } = await setup([
      { do: 'write', path: 'index.html', content: 'half\n' },
      { do: 'exit', code: 2 },
    ]);
    const head = await G.headSha(repo);
    const t = await runner.start(id);
    expect(t.exit).toEqual({ kind: 'exited', code: 2 });
    expect(t.card?.items[0]?.status).toBe('failed');
    await runner.confirm(id, { criterion: 0, decision: 'confirmed' });
    expect((await runner.save(id)).ok).toBe(false);
    await runner.discard(id);
    expect(await G.headSha(repo)).toBe(head);
  });

  it('停止：真实中断执行并记为 stopped', async () => {
    const { runner, id } = await setup([{ do: 'say', text: '工作中' }, { do: 'hang' }]);
    // 确定性等待：执行体已经启动并发出第一条消息（此时 run 已登记、下一步就是挂起）才停止。
    // 不能用固定毫秒数：创建 worktree 等准备工作在机器繁忙时可能超过它，stop() 会落空导致测试挂起。
    const working = new Promise<void>((resolve) => {
      runner.on('update', (task) => {
        if (task.timeline.some((e: { kind: string; text: string }) => e.kind === 'message' && e.text === '工作中')) resolve();
      });
    });
    const p = runner.start(id);
    await working;
    await runner.stop(id);
    const t = await p;
    expect(t.exit).toEqual({ kind: 'stopped' });
    expect(t.card?.readyToSave).toBe(false);
  });

  it('准备阶段收到停止：不启动执行体，任务进入 stopped 并照常验收', async () => {
    const repo = await makeRepo();
    const inner = new FakeExecutor([{ do: 'write', path: 'index.html', content: 'SHOULD NOT EXIST\n' }, { do: 'exit', code: 0 }]);
    let started = 0;
    const executor = Object.assign(Object.create(inner), {
      start: (o: Parameters<FakeExecutor['start']>[0]) => {
        started++;
        return inner.start(o);
      },
    }) as FakeExecutor;
    const runner = new TaskRunner({ repo, executor, runChecks: false });
    const t0 = await runner.create('x');
    await runner.setPlan(t0.id, plan);
    await runner.approve(t0.id);
    const p = runner.start(t0.id); // 同步进入准备阶段（读取任务、创建 worktree 都还没完成）
    await runner.stop(t0.id);
    const t = await p;
    expect(started).toBe(0);
    expect(t.exit).toEqual({ kind: 'stopped' });
    expect(t.state).toBe('reviewing');
    expect(t.card?.readyToSave).toBe(false);
    expect(await fs.readFile(path.join(t.worktree!.path, 'index.html'), 'utf8')).toBe('<h1>hello</h1>\n');
    await runner.discard(t0.id); // 照常进入验收，可以撤销
  });

  it('执行体刚启动的瞬间收到停止：同样生效，没有任何文件被写入', async () => {
    const repo = await makeRepo();
    const inner = new FakeExecutor([{ do: 'write', path: 'new.txt', content: 'x' }, { do: 'write', path: 'index.html', content: 'CHANGED\n' }, { do: 'exit', code: 0 }]);
    let runner!: TaskRunner;
    let id = '';
    const executor = Object.assign(Object.create(inner), {
      // 在 start() 内部发出停止：此时执行体已被创建，但 runner 还没拿到 run 句柄
      start: (o: Parameters<FakeExecutor['start']>[0]) => {
        void runner.stop(id);
        return inner.start(o);
      },
    }) as FakeExecutor;
    runner = new TaskRunner({ repo, executor, runChecks: false });
    const t0 = await runner.create('x');
    id = t0.id;
    await runner.setPlan(id, plan);
    await runner.approve(id);
    const t = await runner.start(id);
    expect(t.exit).toEqual({ kind: 'stopped' });
    expect(t.card?.changes).toEqual([]);
    await expect(fs.access(path.join(t.worktree!.path, 'new.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(t.worktree!.path, 'index.html'), 'utf8')).toBe('<h1>hello</h1>\n');
  });

  it('报告绑定 Git 状态：开始与结束时的主线 HEAD、工作树路径与 HEAD 记录在任务与验收卡里', async () => {
    const repo = await makeRepo();
    const executor: Executor = {
      id: 'committer',
      displayName: 'committer',
      capabilities: { permissionPrompts: false, resumeAfterStop: false },
      detect: async () => ({ installed: true, loggedIn: 'yes' }),
      start(o) {
        const ch = new Channel<ExecutorEvent>();
        void (async () => {
          await fs.writeFile(path.join(o.cwd, 'new.txt'), 'x');
          await G.commitWorktree({ path: o.cwd, branch: '', baseSha: '' }, 'executor commit'); // 执行体在工作树里提交了一次
          ch.push({ type: 'exit', outcome: { kind: 'exited', code: 0 } });
          ch.close();
        })();
        return { events: ch, respond: async () => {}, stop: async () => {} };
      },
    };
    const runner = new TaskRunner({ repo, executor, runChecks: false });
    const t0 = await runner.create('x');
    await runner.setPlan(t0.id, plan);
    await runner.approve(t0.id);
    const mainBefore = await G.headSha(repo);
    const t = await runner.start(t0.id);
    const g = t.card?.git;
    expect(g).toBeDefined();
    expect(g).toEqual(t.gitBinding);
    expect(g?.mainHeadAtStart).toBe(mainBefore);
    expect(g?.mainHeadAtEnd).toBe(mainBefore); // 主线没动
    expect(g?.worktreePath).toBe(t.worktree!.path);
    expect(g?.worktreeHeadAtStart).toBe(t.worktree!.baseSha);
    expect(g?.worktreeHeadAtEnd).toBe(await G.headSha(t.worktree!.path));
    expect(g?.worktreeHeadAtEnd).not.toBe(g?.worktreeHeadAtStart); // 执行体提交后，工作树 HEAD 变了
    // 验收阶段确认后，验收卡仍带着同一份绑定
    const c = await runner.confirm(t0.id, { criterion: 0, decision: 'confirmed' });
    expect(c.card?.git).toEqual(g);
  });

  it('任务提示词包含全部约束：目录内修改、不提交不推送、不读取或列出目录之外的内容', async () => {
    const { runner, id } = await setup([{ do: 'exit', code: 0 }]);
    const t = (await runner.store.get(id))!;
    const p = buildPrompt(t);
    expect(p).toContain('只在当前目录内修改文件');
    expect(p).toContain('不要提交 Git、不要推送、不要修改当前目录以外的任何文件');
    expect(p).toContain('不要读取或列出当前目录以外的任何文件或目录');
  });

  it('超时记为 timed_out', async () => {
    const { runner, id } = await setup([{ do: 'hang' }], { timeoutMs: 150 });
    const t = await runner.start(id);
    expect(t.exit).toEqual({ kind: 'timed_out' });
  });

  it('权限请求：低风险可自动批准；默认需要用户决定', async () => {
    const script: FakeStep[] = [{ do: 'write', path: 'a.txt', content: 'a', ask: true }, { do: 'exit', code: 0 }];
    const auto = await setup(script, { autoApprove: { autoLow: true } });
    expect((await auto.runner.start(auto.id)).card?.changes.length).toBe(1);

    const manual = await setup(script);
    const seen: PendingPermission[] = [];
    manual.runner.on('permission', (p: PendingPermission) => {
      seen.push(p);
      void manual.runner.respond(p.taskId, p.request.id, 'deny');
    });
    const t = await manual.runner.start(manual.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.risk.level).toBe('low');
    expect(t.card?.changes.length).toBe(0); // 被拒绝，没有写入
  });

  it('被拒绝的操作进入验收卡：需逐项确认知晓后才能保存', async () => {
    const { runner, id } = await setup([
      { do: 'write', path: 'a.txt', content: 'a' },
      { do: 'write', path: 'b.txt', content: 'b', ask: true },
      { do: 'exit', code: 0 },
    ]);
    runner.on('permission', (p: PendingPermission) => void runner.respond(p.taskId, p.request.id, 'deny'));
    const t = await runner.start(id);
    expect(t.denied).toHaveLength(1);
    expect(t.denied[0]).toMatchObject({ kind: 'write_file', paths: ['b.txt'] });
    expect(t.card?.items.find((i) => i.key === 'denied')?.status).toBe('pending_user');
    await runner.confirm(id, { criterion: 0, decision: 'confirmed' });
    expect((await runner.save(id)).ok).toBe(false); // 还没确认知晓被拒绝的操作
    const t2 = await runner.confirm(id, { deniedAck: 0 });
    expect(t2.card?.items.find((i) => i.key === 'denied')?.status).toBe('user_confirmed');
    expect((await runner.save(id)).ok).toBe(true);
  });

  it('越界路径永远需要用户决定，即使开启了自动批准', async () => {
    const { runner, id } = await setup(
      [{ do: 'ask', request: { kind: 'write_file', paths: ['../../outside.txt'], description: '写外部文件' }, onDeny: 'fail' }],
      { autoApprove: { autoLow: true } },
    );
    const seen: PendingPermission[] = [];
    runner.on('permission', (p: PendingPermission) => {
      seen.push(p);
      void runner.respond(p.taskId, p.request.id, 'deny');
    });
    const t = await runner.start(id);
    expect(seen[0]?.risk).toMatchObject({ level: 'high', reversible: false });
    expect(t.exit).toEqual({ kind: 'exited', code: 1 });
  });

  it('修复：在同一隔离副本上继续，并重新要求确认', async () => {
    let round = 0;
    const repo = await makeRepo();
    const runner = new TaskRunner({
      repo,
      runChecks: false,
      executor: new FakeExecutor(() => {
        round++;
        return [{ do: 'write', path: 'index.html', content: `v${round}\n` }, { do: 'exit', code: 0 }];
      }),
    });
    const t0 = await runner.create('x');
    await runner.setPlan(t0.id, plan);
    await runner.approve(t0.id);
    await runner.start(t0.id);
    await runner.confirm(t0.id, { criterion: 0, decision: 'rejected' });
    const t = await runner.requestFix(t0.id, '颜色太暗');
    expect(t.state).toBe('reviewing');
    expect(t.criteria[0]?.decision).toBeUndefined();
    expect(await fs.readFile(path.join(t.worktree!.path, 'index.html'), 'utf8')).toBe('v2\n');
  });

  it('真实运行项目的 build / test 脚本，失败时如实标记', async () => {
    const files = {
      'package.json': JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"', test: 'node check.js' },
      }),
      'check.js': 'const s=require("fs").readFileSync("index.html","utf8"); process.exit(s.includes("dark")?0:1);\n',
      'index.html': 'light\n',
    };
    const good = await setup([{ do: 'write', path: 'index.html', content: 'dark\n' }, { do: 'exit', code: 0 }], { runChecks: true, sandboxRunner: testSandboxRunner() }, files);
    const tg = await good.runner.start(good.id);
    expect(tg.card?.items.find((i) => i.key === 'build')?.status).toBe('verified');
    expect(tg.card?.items.find((i) => i.key === 'test')?.status).toBe('verified');

    const bad = await setup([{ do: 'write', path: 'index.html', content: 'still light\n' }, { do: 'exit', code: 0 }], { runChecks: true, sandboxRunner: testSandboxRunner() }, files);
    const tb = await bad.runner.start(bad.id);
    expect(tb.card?.items.find((i) => i.key === 'test')?.status).toBe('failed');
    await bad.runner.confirm(bad.id, { criterion: 0, decision: 'confirmed' });
    expect((await bad.runner.save(bad.id)).ok).toBe(false);
  });
});
