import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildCard } from '../src/core/acceptance/card.js';
import { filterProofOutput, parseTestCases, buildTaskProof } from '../src/core/acceptance/proof.js';
import { computeAcceptanceStatus, toUserView } from '../src/core/acceptance/view.js';
import { saveBlockerCodes } from '../src/core/task/save-rules.js';
import { TaskController } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { RecordStore } from '../src/core/persistence/index.js';
import { CheckProofPage } from '../src/renderer/CheckProofPage.js';
import type { Task } from '../src/core/task/model.js';
import { testSandboxRunner } from './helpers.js';

const tmpDirs: string[] = [];

function mk(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-s4-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

function initRepo(files: Record<string, string> = { 'index.html': '<h1>init</h1>\n' }): string {
  const repo = path.join(mk('repo'), 'proj');
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

function mkReviewingTask(over: Partial<Task> = {}): Task {
  const criteria = over.criteria ?? [{ text: '首页显示欢迎标语' }, { text: '手机布局不换行' }];
  const exit = over.exit ?? { kind: 'exited', code: 0 };
  const changes = [{ status: 'modified' as const, path: 'index.html', additions: 1, deletions: 1 }];
  return {
    id: 'task-s4-1',
    request: '更新首页',
    state: 'reviewing',
    criteria,
    denied: [],
    deniedAcks: [],
    previewed: false,
    acceptedTree: 'a'.repeat(40),
    acceptanceRev: 1,
    worktree: { path: '/tmp/wt-s4', branch: 'studio/task-s4-1', baseSha: 'b'.repeat(40) },
    exit,
    card: buildCard({ exit, changes, checks: [], criteria, previewed: false, denied: [], deniedAcks: [] }),
    timeline: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:01.000Z',
    ...over,
  };
}

afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('阶段 4 · 第一节：三种验收状态计算与「不做部分通过」规则', () => {
  it('核心层准确计算 验收通过 / 验收未完成 / 验收未通过，没有「部分通过」路径', () => {
    // 1. 有标准还没确认 -> 验收未完成；显示保存按钮（不可点，附原因）
    const tIncomplete = mkReviewingTask({
      criteria: [{ text: '条件一', decision: 'confirmed' }, { text: '条件二' }],
    });
    const vIncomplete = toUserView(tIncomplete, { busy: false, saveCheck: null });
    expect(vIncomplete.acceptanceStatus).toMatchObject({
      kind: 'incomplete',
      label: '验收未完成',
      showSaveButton: true,
    });
    expect(vIncomplete.acceptanceStatus.reason).toContain('还有 1 条验收标准没确认');
    expect(vIncomplete.actions.save.enabled).toBe(false);
    expect(saveBlockerCodes(tIncomplete)).toContain('criteria_unconfirmed');

    // 2. 任意一条为「不符合」-> 验收未通过；保存按钮不出现（showSaveButton=false），拒绝部分通过
    const tFailed = mkReviewingTask({
      criteria: [
        { text: '条件一', decision: 'confirmed' },
        { text: '条件二', decision: 'rejected', note: '手机上一行只排了 1 张' },
      ],
    });
    const vFailed = toUserView(tFailed, { busy: false, saveCheck: null });
    expect(vFailed.acceptanceStatus).toMatchObject({
      kind: 'failed',
      label: '验收未通过',
      showSaveButton: false,
    });
    expect(vFailed.actions.save.enabled).toBe(false);
    expect(vFailed.reworkAction.enabled).toBe(true);
    expect(vFailed.criteria[1]).toMatchObject({ rejected: true, note: '手机上一行只排了 1 张' });
    expect(vFailed.saveRecord).toBeNull();
    expect(vFailed.acceptanceStatus.label).not.toBe('部分通过');

    // 3. 每条都「符合」且无阻断 -> 验收通过；「验收通过并保存」可用
    const tPassed = mkReviewingTask({
      criteria: [
        { text: '条件一', decision: 'confirmed' },
        { text: '条件二', decision: 'confirmed' },
      ],
    });
    const vPassed = toUserView(tPassed, { busy: false, saveCheck: null });
    expect(vPassed.acceptanceStatus).toMatchObject({
      kind: 'passed',
      label: '验收通过',
      showSaveButton: true,
    });
    expect(vPassed.actions.save.enabled).toBe(true);

    // 直接调用 computeAcceptanceStatus 验证无“部分通过”枚举
    const statusValues = [vIncomplete.acceptanceStatus.kind, vFailed.acceptanceStatus.kind, vPassed.acceptanceStatus.kind];
    expect(statusValues).toEqual(['incomplete', 'failed', 'passed']);
    expect(computeAcceptanceStatus(tFailed, { save: vFailed.actions.save, deniedAllAcked: true, anyUnchecked: false, verdict: vFailed.verdict }).showSaveButton).toBe(false);
  });

  it('rejectCriterion 保存「不符合」及可选说明、禁止保存；再选「符合」后清空说明并解锁', async () => {
    const repo = initRepo({ 'index.html': '<h1>old</h1>\n' });
    const ctl = new TaskController({
      repo,
      makeExecutor: () => new FakeExecutor([{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }]),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs')),
    });
    const t = await ctl.create('更新首页');
    await ctl.savePlan(t.id, { goal: '更新首页', criteria: ['标语清晰', '手机适配'], mode: 'standard', network: false });
    await ctl.start(t.id, false);
    let view = await ctl.getAcceptanceView(t.id);
    while (view.state !== 'reviewing' || view.busy) {
      await new Promise((r) => setTimeout(r, 20));
      view = await ctl.getAcceptanceView(t.id);
    }

    // 第 1 条符合，第 2 条不符合并带说明 -> 验收未通过、保存禁用且主界面隐藏保存按钮
    view = (await ctl.confirmCriterion(t.id, 'c0', view.version)).view;
    view = (await ctl.rejectCriterion(t.id, 'c1', view.version, '间距还是太大')).view;
    expect(view.acceptanceStatus.kind).toBe('failed');
    expect(view.acceptanceStatus.showSaveButton).toBe(false);
    expect(view.criteria[1]).toMatchObject({ rejected: true, note: '间距还是太大' });
    expect((await ctl.saveTask(t.id, view.version)).ok).toBe(false);

    // 伪造参数被拒绝
    await expect(ctl.rejectCriterion(t.id, 'overall', view.version, 'x')).rejects.toThrow();
    await expect(ctl.rejectCriterion(t.id, 'c9', view.version, 'x')).rejects.toThrow();
    await expect(ctl.rejectCriterion(t.id, 'c1', 'bad-ver', 'x')).rejects.toThrow();

    // 改回「符合」后说明被清空、变为验收通过
    view = (await ctl.confirmCriterion(t.id, 'c1', view.version)).view;
    expect(view.acceptanceStatus.kind).toBe('passed');
    expect(view.criteria[1]).toMatchObject({ confirmed: true, rejected: false });
    expect(view.criteria[1]?.note).toBeUndefined();
  });

  it('预留「你已知晓并接受的风险」字段：无风险时不返回，有风险时清洗并下发给验收页', () => {
    const empty = toUserView(mkReviewingTask(), { busy: false });
    expect(empty.acceptedRisks).toEqual([]);

    const withRisk = toUserView(
      mkReviewingTask({
        acceptedRisks: [{ title: '保留旧版样式兼容', reason: '在 /Users/alice/app 中用户确认已知晓风险', at: '2026-11-10T01:00:00.000Z' }],
      }),
      { busy: false },
    );
    expect(withRisk.acceptedRisks).toHaveLength(1);
    expect(withRisk.acceptedRisks[0]?.title).toBe('保留旧版样式兼容');
    expect(withRisk.acceptedRisks[0]?.reason).not.toContain('/Users/alice');
  });
});

describe('阶段 4 · 第二节：检查依据页、轮次绑定、测试解析与敏感信息脱敏', () => {
  it('filterProofOutput 彻底过滤命令行、环境变量、密钥形态字符串，并把主目录绝对路径替换为 ~', () => {
    const raw = [
      '> my-site@1.0.0 test',
      '$ vitest run --maxWorkers=4',
      'export SECRET_TOKEN=super-secret-value',
      'OPENAI_API_KEY=sk-proj-1234567890abcdef',
      'Authorization: Bearer ghp_1234567890abcdefghij1234',
      'AWS key AKIAIOSFODNN7EXAMPLE',
      '✓ 首页标题能正确渲染 (12ms)',
      '✗ 手机端卡片双列排版 in /Users/alice/workspace/site/tests/mobile.test.ts (8ms)',
      'Trace in /home/bob/projects/app/index.ts',
      'Ran npx vitest run tests/a.test.ts in /tmp/scratch-check',
    ].join('\n');

    const cleaned = filterProofOutput(raw);
    expect(cleaned).not.toMatch(/vitest|my-site@1\.0\.0|npx\s|export\s+SECRET_TOKEN/);
    expect(cleaned).not.toContain('super-secret-value');
    expect(cleaned).not.toContain('sk-proj-');
    expect(cleaned).not.toContain('ghp_123456');
    expect(cleaned).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(cleaned).not.toContain('/Users/alice');
    expect(cleaned).not.toContain('/home/bob');
    expect(cleaned).toContain('~/workspace/site/tests/mobile.test.ts');
    expect(cleaned).toContain('~/projects/app/index.ts');
    expect(cleaned).toContain('首页标题能正确渲染');
    expect(cleaned).toContain('手机端卡片双列排版');
  });

  it('parseTestCases 能逐项列出测试名；不可解析时回退为通过/失败数量；无检查显示「未检查」不标通过', () => {
    const withNames = parseTestCases('✓ 首页能正常显示 (4ms)\n✓ 作品卡片数量正确 2ms\n✗ 窄屏排版对齐\nTests 1 failed | 2 passed (3)', 'failed');
    expect(withNames.parsedNames).toBe(true);
    expect(withNames.passedCount).toBe(2);
    expect(withNames.failedCount).toBe(1);
    expect(withNames.cases.map((c) => [c.name, c.status])).toEqual([
      ['首页能正常显示', 'passed'],
      ['作品卡片数量正确', 'passed'],
      ['窄屏排版对齐', 'failed'],
    ]);

    const opaque = parseTestCases('all assertions succeeded', 'passed');
    expect(opaque.parsedNames).toBe(false);
    expect(opaque.passedCount).toBe(1);
    expect(opaque.failedCount).toBe(0);

    const noScriptsProof = buildTaskProof(mkReviewingTask());
    expect(noScriptsProof.test.status).toBe('not_checked');
    expect(noScriptsProof.test.summaryText).toBe('未检查：这个项目没有自动测试');
    expect(noScriptsProof.test.summaryText).not.toContain('通过');
    expect(noScriptsProof.build.status).toBe('not_checked');
    expect(noScriptsProof.build.summaryText).toBe('未检查：这个项目没有构建检查');
  });

  it('真实运行自动检查保存原始记录到本机，界面视图与 CheckProofPage 只拿到过滤结果且默认折叠详细记录', async () => {
    const repo = initRepo({
      'package.json': JSON.stringify({
        scripts: {
          build: 'node build.cjs',
          test: 'node run-tests.cjs',
        },
      }),
      'build.cjs': 'console.log("built ok");',
      'run-tests.cjs': [
        'console.log("> app@1.0.0 test");',
        'console.log("SECRET_API_KEY=sk-proj-9999999999abcdef");',
        'console.log("✓ renders home title (5ms)");',
        'console.log("✓ keeps card layout /Users/devuser/proj/a.test.js (3ms)");',
        'console.log("Tests 2 passed (2)");',
      ].join('\n'),
      'index.html': '<h1>old</h1>\n',
    });

    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs')),
    });
    const t = await ctl.create('改进首页');
    await ctl.savePlan(t.id, { goal: '改进首页', criteria: ['首页展示正常'], mode: 'standard', network: false });
    await ctl.start(t.id, false);
    let view = await ctl.getAcceptanceView(t.id);
    while (view.state !== 'reviewing' || view.busy) {
      await new Promise((r) => setTimeout(r, 20));
      view = await ctl.getAcceptanceView(t.id);
    }

    // 原始记录存在于本机记录里；界面只获得过滤后的数据
    const rawTasks = await ctl.listTasksRaw();
    const rawTest = rawTasks[0]?.currentChecks?.find((c) => c.name === 'test');
    expect(rawTest?.rawOutput).toContain('sk-proj-9999999999abcdef');

    expect(view.proof.round).toBe(1);
    expect(view.proof.test.originNote).toBe('由本应用运行，不是 AI 自报');
    expect(view.proof.test.envLabel).toBe('沙箱环境');
    expect(view.proof.test.ranAtText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(view.proof.test.cases.length).toBe(2);
    expect(view.proof.test.filteredDetails).not.toContain('sk-proj-');
    expect(view.proof.test.filteredDetails).not.toContain('/Users/devuser');
    expect(view.proof.test.filteredDetails).toContain('~/proj/a.test.js');
    expect(JSON.stringify(view)).not.toContain('sk-proj-9999999999abcdef');

    // SSR 验证：详细记录 <details> 默认折叠（不含 open）
    const html = renderToStaticMarkup(React.createElement(CheckProofPage, { proof: view.proof, initialTab: 'test', onBack: () => undefined }));
    expect(html).toContain('第 1 轮成果');
    expect(html).toContain('由本应用运行，不是 AI 自报');
    expect(html).toContain('沙箱环境');
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
});

describe('阶段 4 · 第三节：退回修改与多轮独立记录', () => {
  it('退回修改在同一副本开始第 2 轮，自动附上不符合标准与说明，且第 1 轮记录与证据不被覆盖', async () => {
    const repo = initRepo({
      'package.json': JSON.stringify({ scripts: { test: 'node run-tests.cjs' } }),
      'run-tests.cjs': [
        'const fs = require("node:fs");',
        'const html = fs.readFileSync("index.html", "utf8");',
        'if (html.includes("round2")) { console.log("✓ round2 check (2ms)\\nTests 1 passed (1)"); process.exit(0); }',
        'console.log("✗ round2 check (2ms)\\nTests 1 failed (1)"); process.exit(1);',
      ].join('\n'),
      'index.html': '<h1>v0</h1>\n',
    });

    const promptsSeen: string[] = [];
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor((prompt) => {
          promptsSeen.push(prompt);
          return prompt.includes('上一次结果需要修改')
            ? [{ do: 'write', path: 'index.html', content: '<h1>round2</h1>\n' }, { do: 'exit', code: 0 }]
            : [{ do: 'write', path: 'index.html', content: '<h1>round1</h1>\n' }, { do: 'exit', code: 0 }];
        });
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs')),
    });

    const created = await ctl.create('优化首页标题与测试');
    await ctl.savePlan(created.id, { goal: '优化首页标题与测试', criteria: ['文案准确', '测试全部通过'], mode: 'standard', network: false });
    await ctl.start(created.id, false);
    const waitReview = async () => {
      let v = await ctl.getAcceptanceView(created.id);
      while (v.state !== 'reviewing' || v.busy) {
        await new Promise((r) => setTimeout(r, 20));
        v = await ctl.getAcceptanceView(created.id);
      }
      return v;
    };

    let v1 = await waitReview();
    expect(v1.currentRound).toBe(1);
    expect(v1.proof.test.status).toBe('failed');
    v1 = (await ctl.confirmCriterion(created.id, 'c0', v1.version)).view;
    v1 = (await ctl.rejectCriterion(created.id, 'c1', v1.version, '请补齐 round2 标记')).view;

    const rawBefore = (await ctl.listTasksRaw())[0]!;
    const worktreeRound1 = rawBefore.worktree?.path;
    expect(worktreeRound1).toBeTruthy();

    const startedR2 = await ctl.reworkTask(created.id, '请确保页面包含 round2 且通过测试');
    expect(startedR2.round).toBe(2);
    const v2 = await waitReview();

    expect(v2.currentRound).toBe(2);
    expect(v2.rounds).toHaveLength(2);
    expect(promptsSeen[1]).toContain('请确保页面包含 round2 且通过测试');
    expect(promptsSeen[1]).toContain('测试全部通过（说明：请补齐 round2 标记）');

    const rawAfter = (await ctl.listTasksRaw())[0]!;
    expect(rawAfter.worktree?.path).toBe(worktreeRound1); // 同一副本继续
    expect(rawAfter.rounds).toHaveLength(2);
    expect(rawAfter.rounds?.[0]?.round).toBe(1);
    expect(rawAfter.rounds?.[0]?.checks.find((c) => c.name === 'test')?.status).toBe('failed');
    expect(rawAfter.rounds?.[0]?.criteria[1]).toMatchObject({ decision: 'rejected', note: '请补齐 round2 标记' });
    expect(rawAfter.rounds?.[1]?.round).toBe(2);
    expect(rawAfter.rounds?.[1]?.checks.find((c) => c.name === 'test')?.status).toBe('passed');

    // 视图里第 1 轮历史与第 2 轮当前彼此独立
    expect(v2.rounds[0]?.isCurrent).toBe(false);
    expect(v2.rounds[0]?.proof.round).toBe(1);
    expect(v2.rounds[0]?.proof.test.status).toBe('failed');
    expect(v2.rounds[0]?.criteria[1]).toMatchObject({ rejected: true, note: '请补齐 round2 标记' });
    expect(v2.rounds[1]?.isCurrent).toBe(true);
    expect(v2.rounds[1]?.proof.round).toBe(2);
    expect(v2.rounds[1]?.proof.test.status).toBe('passed');
    expect(v2.rounds[1]?.criteria[0]).toMatchObject({ confirmed: false, rejected: false });
  });

  it('停止/继续执行后进入第 2 轮且记录「接着上次停下的地方继续」，修改权限会退回 planned 重新批准', async () => {
    const repo = initRepo({ 'index.html': '<h1>v0</h1>\n' });
    let turn = 0;
    const ctl = new TaskController({
      repo,
      makeExecutor: () =>
        new FakeExecutor(() =>
          turn++ === 0
            ? [{ do: 'write', path: 'index.html', content: '<h1>partial</h1>\n' }, { do: 'exit', code: 1 }]
            : [{ do: 'write', path: 'index.html', content: '<h1>done</h1>\n' }, { do: 'exit', code: 0 }],
        ),
      pickDirectory: async () => null,
      prefs: new TaskPrefs(mk('prefs2')),
    });

    const created = await ctl.create('连续轮次与改权限');
    await ctl.savePlan(created.id, { goal: '连续轮次与改权限', criteria: ['可访问'], mode: 'standard', network: false });
    await ctl.start(created.id, false);
    const waitState = async (targets: string[]) => {
      let tv = await ctl.get(created.id);
      while (!targets.includes(tv.state) || tv.running) {
        await new Promise((r) => setTimeout(r, 20));
        tv = await ctl.get(created.id);
      }
      return tv;
    };

    const r1 = await waitState(['reviewing']);
    expect(r1.round).toBe(1);
    const cont = await ctl.continueTask(created.id);
    expect(cont.round).toBe(2);
    await waitState(['reviewing']);

    const rawCont = (await ctl.listTasksRaw())[0]!;
    expect(rawCont.rounds).toHaveLength(2);
    expect(rawCont.rounds?.[1]?.feedback).toBe('接着上次停下的地方继续');

    // 从第 2 轮点“修改权限” -> 回到 planned 且保留第 1/2 轮历史，需要重新保存/批准并开工才能进入第 3 轮
    const planned = await ctl.editReworkPermissions(created.id, '开启联网后继续');
    expect(planned.state).toBe('planned');
    expect(planned.round).toBe(3);
    expect(planned.reapproveNotice).toContain('重新点击「批准并开工」');
    await ctl.savePlan(created.id, { goal: '连续轮次与改权限', criteria: ['可访问'], mode: 'standard', network: true });
    await ctl.start(created.id, false);
    await waitState(['reviewing']);

    const v3 = await ctl.getAcceptanceView(created.id);
    expect(v3.currentRound).toBe(3);
    expect(v3.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(v3.rework.permissionSummary).toContain('可联网');
  });
});
