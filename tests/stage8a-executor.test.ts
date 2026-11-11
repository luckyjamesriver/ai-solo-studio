import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxCommandRunner } from '../src/core/checks/scripts.js';
import { ApiAgentExecutor } from '../src/core/executor/adapters/api-agent.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import type { ExecutorEvent } from '../src/core/executor/types.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { TaskRunner } from '../src/core/task/runner.js';

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@local',
};

async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-exec-'));
  cleanDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitEnv });
  return fs.realpath(dir);
}

async function startScriptedModelServer(
  responder: (step: number, body: Record<string, unknown>, req: http.IncomingMessage) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown },
): Promise<string> {
  let step = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const out = await responder(step++, body, req);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanServers.push(server);
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanServers.length > 0) {
    await new Promise<void>((r) => cleanServers.pop()!.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8A 提交② · ApiAgentExecutor 多协议工具执行与隔离', () => {
  it('OpenAI Compatible（DeepSeek）：完成目录列表/读/改文件并安全拦下副本外写入、.git 修改与无沙箱命令', async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-wt-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-out-'));
    cleanDirs.push(worktree, outside);
    await fs.writeFile(path.join(worktree, 'index.html'), '<h1>old</h1>\n', 'utf8');
    await fs.mkdir(path.join(worktree, '.git'), { recursive: true });
    await fs.writeFile(path.join(worktree, '.git', 'config'), '[core]\n', 'utf8');
    await fs.symlink(outside, path.join(worktree, 'link_out'));

    const endpoint = await startScriptedModelServer((step) => {
      if (step === 0) {
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  reasoning_content: 'check directory first',
                  tool_calls: [{ id: 'c0', type: 'function', function: { name: 'list_dir', arguments: '{"dir":"."}' } }],
                },
              },
            ],
          },
        };
      }
      if (step === 1) {
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '../escape.txt', content: 'evil' }) } },
                    { id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'link_out/sym.txt', content: 'evil' }) } },
                    { id: 'c3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.git/config', content: 'evil' }) } },
                    { id: 'c4', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) } },
                    { id: 'c5', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'index.html', target: '<h1>old</h1>', replacement: '<h1>DeepSeek v1</h1>' }) } },
                  ],
                },
              },
            ],
          },
        };
      }
      return {
        status: 200,
        body: { choices: [{ message: { role: 'assistant', content: '已完成首页修改。' } }] },
      };
    });

    const exec = new ApiAgentExecutor({
      id: 'api:ds_1',
      displayName: 'DeepSeek · deepseek-chat',
      presetId: 'deepseek',
      protocol: 'openai_compat',
      endpoint,
      model: 'deepseek-chat',
      getSecret: async () => 'sk-test-secret-1234',
    });

    const run = exec.start({ cwd: worktree, prompt: '修改首页标题' });
    const events: ExecutorEvent[] = [];
    for await (const ev of run.events) events.push(ev);

    expect(await fs.readFile(path.join(worktree, 'index.html'), 'utf8')).toBe('<h1>DeepSeek v1</h1>\n');
    expect(await fs.readFile(path.join(worktree, '.git', 'config'), 'utf8')).toBe('[core]\n');
    await expect(fs.stat(path.join(path.dirname(worktree), 'escape.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(outside, 'sym.txt'))).rejects.toThrow();

    const exitEv = events.find((e) => e.type === 'exit');
    expect(exitEv).toMatchObject({ type: 'exit', outcome: { kind: 'exited', code: 0 } });
    if (exitEv?.type === 'exit') {
      expect(exitEv.denied?.length).toBe(4);
    }
    const hostNote = events.find((e) => e.type === 'message' && e.source === 'host');
    expect(hostNote?.type === 'message' && hostNote.text.includes('非官方/自定义地址')).toBe(true);
  });

  it('Anthropic 与 Gemini 协议均可跑通工具调用，且 stop() 能立刻中断请求并退出', async () => {
    const wt1 = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-ant-'));
    const wt2 = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8a-gem-'));
    cleanDirs.push(wt1, wt2);

    // Anthropic
    const antEndpoint = await startScriptedModelServer((step) => {
      if (step === 0) {
        return {
          status: 200,
          body: {
            id: 'a0',
            type: 'message',
            content: [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'app.txt', content: 'by-claude' } }],
          },
        };
      }
      return { status: 200, body: { id: 'a1', type: 'message', content: [{ type: 'text', text: 'done' }] } };
    });
    const antExec = new ApiAgentExecutor({
      id: 'api:ant',
      displayName: 'Anthropic · claude-sonnet-5-5',
      presetId: 'anthropic',
      protocol: 'anthropic',
      endpoint: `${antEndpoint}/v1/messages`,
      model: 'claude-sonnet-5-5',
      getSecret: async () => 'sk-ant-123',
    });
    const r1 = antExec.start({ cwd: wt1, prompt: 'write app.txt' });
    for await (const _ of r1.events) { /* drain */ }
    expect(await fs.readFile(path.join(wt1, 'app.txt'), 'utf8')).toBe('by-claude');

    // Gemini + delegated sandboxRunner + slow stop()
    const gemEndpoint = await startScriptedModelServer(async (step) => {
      if (step === 0) {
        return {
          status: 200,
          body: {
            candidates: [{ content: { parts: [{ functionCall: { name: 'run_command', args: { command: 'node', args: ['-v'] } } }] } }],
          },
        };
      }
      await new Promise((r) => setTimeout(r, 3000));
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'late' }] } }] } };
    });
    const ranCommands: string[][] = [];
    const mockSandbox: SandboxCommandRunner = {
      async runCommand(req) {
        ranCommands.push(req.argv);
        return { status: 'ran', exitCode: 0, stdout: 'v22.0.0\n', stderr: '', timedOut: false, durationMs: 5 };
      },
    };
    const gemExec = new ApiAgentExecutor({
      id: 'api:gem',
      displayName: 'Google Gemini · gemini-3.8-flash',
      presetId: 'gemini',
      protocol: 'gemini',
      endpoint: `${gemEndpoint}/v1beta`,
      model: 'gemini-3.8-flash',
      getSecret: async () => 'AIza123',
      sandboxRunner: mockSandbox,
    });
    const r2 = gemExec.start({ cwd: wt2, prompt: 'run node -v then wait' });
    const gemEvents: ExecutorEvent[] = [];
    setTimeout(() => void r2.stop(), 80);
    for await (const ev of r2.events) gemEvents.push(ev);

    expect(ranCommands).toEqual([['node', '-v']]);
    expect(gemEvents.find((e) => e.type === 'exit')).toMatchObject({ type: 'exit', outcome: { kind: 'stopped' } });
  });

  it('TaskRunner 通过 resolveExecutor 使用 ApiAgentExecutor 全流程写入文件并保存进主项目', async () => {
    const repo = await makeGitRepo({ 'hello.txt': 'before\n' });
    const endpoint = await startScriptedModelServer((step) => {
      if (step === 0) {
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'after-deepseek\n' }) } }],
                },
              },
            ],
          },
        };
      }
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: '已更新 hello.txt' } }] } };
    });

    const dsExecutor = new ApiAgentExecutor({
      id: 'api:ds_runner',
      displayName: 'DeepSeek · deepseek-chat',
      presetId: 'deepseek',
      protocol: 'openai_compat',
      endpoint,
      model: 'deepseek-chat',
      getSecret: async () => 'sk-ds-12345',
    });

    const runner = new TaskRunner({
      repo,
      executor: new FakeExecutor([]),
      resolveExecutor: async (id) => (id === dsExecutor.id ? { executor: dsExecutor } : { executor: dsExecutor }),
    });
    const task = await runner.create('改 hello.txt');
    expect(task.executorId).toBe('api:ds_runner');
    expect(task.executorName).toBe('DeepSeek · deepseek-chat');

    await runner.setPlan(task.id, {
      goal: '改 hello.txt',
      inScope: ['hello.txt'],
      outOfScope: [],
      risks: [],
      irreversible: [],
      criteria: [],
      capabilities: { externalNetwork: 'off' },
    });
    await runner.approve(task.id);
    const afterExec = await runner.start(task.id);
    expect(afterExec.state).toBe('reviewing');
    expect((afterExec.currentChecks ?? []).every((c) => c.status === 'not_available')).toBe(true); // 无 package.json 脚本且无沙箱

    await runner.confirm(task.id, { overall: true, previewed: true });
    expect(await runner.save(task.id)).toMatchObject({ ok: false, reason: 'unchecked_needs_confirm' });
    const saved = await runner.save(task.id, { confirmUnchecked: true });
    expect(saved.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'hello.txt'), 'utf8')).toBe('after-deepseek\n');
  });
});
