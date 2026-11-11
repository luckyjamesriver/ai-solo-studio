import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { ApiAgentExecutor } from '../src/core/executor/adapters/api-agent.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { createStandaloneSandboxRunner } from '../src/core/executor/sandbox/index.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { SettingsPage } from '../src/renderer/SettingsPage.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-ctl-'));
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

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function startFixMathServer(): Promise<string> {
  let step = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    step += 1;
    if (step === 1) {
      res.end(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc_fix',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'math.mjs',
                        content: 'export const add = (a, b) => a + b;\n',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: '已修复 add 实现。' }, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanServers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanServers.length > 0) {
    const s = cleanServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8C · 独立检查沙箱与控制器/验收/设置页全链路集成', () => {
  it('无可用独立沙箱（如 Linux 且无 Codex）时，诚实标为 sandbox_unavailable → 需要未检查保存确认，绝不宿主直跑', async () => {
    const markerName = 'SHOULD_NOT_RUN_ON_HOST.txt';
    const repo = await makeGitRepo({
      'math.mjs': 'export const add = (a, b) => a - b;\n',
      'math.test.mjs': `import test from 'node:test'; import assert from 'node:assert'; import { add } from './math.mjs'; test('add', () => assert.equal(add(1, 2), 3));\n`,
      'package.json': JSON.stringify({
        name: 's8c-fallback-repo',
        scripts: {
          build: `node -e "require('fs').writeFileSync('${markerName}', 'ran')"`,
          test: 'node --test math.test.mjs',
        },
      }),
    });
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-linux-data-'));
    cleanDirs.push(dataDir);
    const endpoint = await startFixMathServer();

    const linuxStandalone = await createStandaloneSandboxRunner({ platform: 'linux' });
    expect(linuxStandalone.runner).toBeUndefined();
    expect(linuxStandalone.status.available).toBe(false);

    const apiExec = new ApiAgentExecutor({
      id: 'api:deepseek_1',
      displayName: 'DeepSeek · deepseek-chat（API）',
      presetId: 'deepseek',
      protocol: 'openai_compat',
      endpoint,
      model: 'deepseek-chat',
      requiresKey: true,
      getSecret: async () => 'sk-test',
    });

    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(dataDir),
      resolveExecutor: async () => ({ executor: apiExec }),
    });

    const created = await ctl.create('修复 math.mjs');
    await ctl.savePlan(created.id, { goal: '修复 add', criteria: [], mode: 'standard', network: false });
    await ctl.start(created.id, false);
    await waitUntil(async () => (await ctl.get(created.id)).state === 'reviewing', 8000);

    // 确认脚本绝没有直接在宿主跑过
    await expect(fs.stat(path.join(repo, markerName))).rejects.toThrow();

    const acc = await ctl.getAcceptanceView(created.id);
    const checkItems = acc.items.filter((i) => i.key === 'build' || i.key === 'test');
    expect(checkItems).toHaveLength(2);
    expect(checkItems.every((c) => c.status === 'not_checked')).toBe(true);
    await ctl.confirmOverall(created.id, acc.version);
    const saveRes = await ctl.saveTask(created.id, acc.version);
    expect(saveRes.saveOutcome?.kind).toBe('unchecked_needs_confirm');

    // SettingsPage SSR 如实展示状态与无沙箱文案（不含 INTERNAL_WORDS）
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        tab: 'ai',
        disc: null,
        env: null,
        aiSettings: {
          codex: { available: false, statusLabel: '不可用', detail: '未安装' },
          claudeKey: { configured: false, available: false, last4: null, verifiedAt: null, unavailableReason: null },
          roles: { chief: 'codex', reviewer: 'none', claudeModel: 'claude-opus-5-5' },
          sameAiNotice: null,
          availableClaudeModels: ['claude-opus-5-5'],
          standaloneSandbox: linuxStandalone.status,
        },
        error: null,
        onTabChange: () => undefined,
        onShowDisclosure: () => undefined,
        onRefreshEnv: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="ai-status-check-runner"');
    expect(html).toContain('独立受限检查环境');
    expect(html).toContain(linuxStandalone.status.label);
  });

  const macIt = process.platform === 'darwin' ? it : it.skip;

  macIt(
    'macOS 脱离 Codex：纯 DeepSeek API 执行者 + 独立 Seatbelt 自动跑通 build/test 检查并直接完成已检查保存',
    async () => {
      const repo = await makeGitRepo({
        'math.mjs': 'export const add = (a, b) => a - b;\n',
        'math.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './math.mjs';\ntest('add passes cleanly', () => assert.equal(add(2, 3), 5));\n`,
        'package.json': JSON.stringify({
          name: 's8c-mac-direct-save',
          scripts: {
            build: 'node --check math.mjs',
            test: 'node --test math.test.mjs',
          },
        }),
      });
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-mac-data-'));
      cleanDirs.push(dataDir);
      const endpoint = await startFixMathServer();

      const standalone = await createStandaloneSandboxRunner();
      expect(standalone.status.available).toBe(true);
      expect(standalone.runner).toBeDefined();

      const apiExec = new ApiAgentExecutor({
        id: 'api:deepseek_mac',
        displayName: 'DeepSeek · deepseek-chat（API）',
        presetId: 'deepseek',
        protocol: 'openai_compat',
        endpoint,
        model: 'deepseek-chat',
        requiresKey: true,
        getSecret: async () => 'sk-test-mac',
        sandboxRunner: standalone.runner!,
      });

      const ctl = new TaskController({
        repo,
        // 构造一旦被 start() 或调用 sandboxRunner 就报错的假 Codex，证明 Stage 8C 全程完全不依赖 Codex
        makeExecutor: () => ({
          id: 'codex-disabled',
          displayName: 'Codex（已禁用）',
          capabilities: { permissionPrompts: false, resumeAfterStop: false },
          sandboxRunner: {
            runCommand: async () => {
              throw new Error('must not touch Codex sandboxRunner in Stage 8C');
            },
          },
          detect: async () => ({ installed: false, loggedIn: 'no' as const }),
          preflight: async () => ({ ok: false, checks: [] }),
          start: () => {
            throw new Error('must not touch CodexExecutor.start in Stage 8C');
          },
        }),
        pickDirectory: async () => null,
        prefs: new TaskPrefs(dataDir),
        fallbackSandboxRunner: standalone.runner!,
        resolveExecutor: async () => ({ executor: apiExec, sandboxRunner: standalone.runner! }),
      });

      const created = await ctl.create('用 DeepSeek 修复 add 函数并自动检查保存');
      await ctl.savePlan(created.id, { goal: '修复 add', criteria: [], mode: 'standard', network: false });
      await ctl.start(created.id, false);
      await waitUntil(async () => (await ctl.get(created.id)).state === 'reviewing', 15_000);

      const acc = await ctl.getAcceptanceView(created.id);
      const checkItems = acc.items.filter((i) => i.key === 'build' || i.key === 'test');
      expect(checkItems).toHaveLength(2);
      expect(checkItems.every((c) => c.status === 'verified')).toBe(true);
      expect(acc.proof.build.status).toBe('passed');
      expect(acc.proof.build.envLabel).toBe('沙箱环境');
      expect(acc.proof.test.status).toBe('passed');
      expect(acc.proof.test.envLabel).toBe('沙箱环境');
      expect(acc.proof.test.cases.some((c) => c.name.includes('add passes cleanly') && c.status === 'passed')).toBe(true);

      await ctl.confirmOverall(created.id, acc.version);
      const saveRes = await ctl.saveTask(created.id, acc.version);
      expect(saveRes.saveOutcome?.kind).toBe('saved');

      const savedView = await ctl.get(created.id);
      expect(savedView.saveCheckText).toBe('检查通过');
      expect(await fs.readFile(path.join(repo, 'math.mjs'), 'utf8')).toBe('export const add = (a, b) => a + b;\n');
    },
    30_000,
  );
});
