import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskController, type AcceptanceActionResult } from '../src/core/app/task-controller.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import { TaskRunner } from '../src/core/task/runner.js';
import type { UserAcceptanceView } from '../src/core/acceptance/view.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir, testSandboxRunner } from './helpers.js';

/**
 * M3-B4-2 操作闭环（控制器层）：与界面使用同一批方法（getAcceptanceView / confirm* / saveTask / discardTask / undoSave / retryCleanup / recheck），
 * 执行体用 FakeExecutor，0 次真实调用。Electron 窗口里的对应用例在 e2e/shell.e2e.ts（待维护者运行）。
 */

const WRITE_TITLE: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];
const form = (o: Partial<{ goal: string; criteria: string[]; mode: 'standard' | 'full_trust'; network: boolean }> = {}) => ({ goal: '改标题', criteria: ['标题已更新'], mode: 'standard' as const, network: false, ...o });

async function until<T>(f: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(o: { script?: FakeStep[]; files?: Record<string, string>; criteria?: string[]; mode?: 'standard' | 'full_trust'; sandbox?: boolean; openPreview?: (t: { kind: 'web' | 'finder'; targetPath: string }) => Promise<void> } = {}) {
  const repo = await makeRepo(o.files ?? { 'index.html': '<h1>old</h1>\n' });
  const data = await tmpDir('data-');
  const make = () => {
    const ex = new FakeExecutor(o.script ?? WRITE_TITLE, { emitPermissions: true });
    if (o.sandbox) (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
    return new TaskController({ repo, makeExecutor: () => ex, pickDirectory: async () => null, prefs: new TaskPrefs(data), openPreview: o.openPreview });
  };
  const ctl = make();
  const t = await ctl.create('改标题');
  await ctl.savePlan(t.id, form({ ...(o.criteria ? { criteria: o.criteria } : {}), ...(o.mode ? { mode: o.mode } : {}) }));
  await ctl.start(t.id, o.mode === 'full_trust');
  const view = await until(async () => {
    const v = await ctl.getAcceptanceView(t.id);
    // 记录刚显示“等待验收”时编排器可能还在收尾（视图会标 busy）：等它真正空闲再继续
    return v.state === 'reviewing' && !v.busy ? v : false;
  });
  return { repo, data, ctl, id: t.id, view, make };
}

/** 逐条确认到可以保存 */
async function confirmAll(ctl: TaskController, id: string): Promise<UserAcceptanceView> {
  let v = await ctl.getAcceptanceView(id);
  for (const c of v.criteria) v = (await ctl.confirmCriterion(id, c.id, v.version)).view;
  if (v.overall.needed) v = (await ctl.confirmOverall(id, v.version)).view;
  for (const d of v.denied) v = (await ctl.ackDenied(id, d.id, v.version)).view;
  return v;
}

const read = (repo: string, f = 'index.html') => fs.readFile(path.join(repo, f), 'utf8');
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const taskOf = async (repo: string, id: string) => (await new TaskRunner({ repo, executor: new FakeExecutor([]) }).store.get(id))!;

async function saveUncheckedFlow(ctl: TaskController, id: string, version: string): Promise<AcceptanceActionResult> {
  const first = await ctl.saveTask(id, version);
  expect(first.ok).toBe(false);
  expect(first.view.uncheckedConfirm).not.toBeNull();
  return ctl.saveUncheckedTask(id, first.view.version);
}

describe('保存与撤销', () => {
  it('保存成功 → 主项目可见；视图变为已保存，撤销入口可用', async () => {
    const { repo, ctl, id, view } = await setup();
    expect(view.actions.save).toMatchObject({ enabled: false }); // 标准还没确认
    const ready = await confirmAll(ctl, id);
    expect(ready.actions.save.enabled).toBe(true);
    expect(ready.verdict).toMatch(/可以保存/);
    const first = await ctl.saveTask(id, ready.version);
    expect(first.ok).toBe(false);
    expect(first.view.uncheckedConfirm).toMatchObject({ previewButtonText: '打开预览', confirmButtonText: '仍然保存' });
    const r = await ctl.saveUncheckedTask(id, first.view.version);
    expect(r.ok).toBe(true);
    expect(r.message).toBe(MESSAGES.saved);
    expect(r.view.state).toBe('saved');
    expect(r.view.uncheckedConfirm).toBeNull();
    expect(r.view.actions.undo.enabled).toBe(true);
    expect(await read(repo)).toBe('<h1>new</h1>\n');
  });

  it('撤销 → 项目恢复；成功提示是 messages.undone（没有外部影响时不追加说明）', async () => {
    const { repo, ctl, id } = await setup();
    const ready = await confirmAll(ctl, id);
    await saveUncheckedFlow(ctl, id, ready.version);
    const r = await ctl.undoSave(id);
    expect(r).toMatchObject({ ok: true, message: MESSAGES.undone });
    expect(r.view.state).toBe('undone');
    expect(await read(repo)).toBe('<h1>old</h1>\n');
  });

  it('撤销条件不满足：入口仍可见但置灰并说明（保存之后项目又有改动）；条件恢复后可用', async () => {
    const { repo, ctl, id } = await setup();
    await saveUncheckedFlow(ctl, id, (await confirmAll(ctl, id)).version);
    await fs.writeFile(path.join(repo, 'later.txt'), 'x\n'); // 保存之后项目里有了新的未保存修改
    const v = await ctl.getAcceptanceView(id);
    expect(v.state).toBe('saved');
    expect(v.actions.undo).toMatchObject({ enabled: false, reason: MESSAGES.undoRefused });
    const r = await ctl.undoSave(id); // 点击时核心层再判一次
    expect(r).toMatchObject({ ok: false, message: MESSAGES.undoRefused });
    expect(await read(repo)).toBe('<h1>new</h1>\n');
    await fs.rm(path.join(repo, 'later.txt'));
    expect((await ctl.getAcceptanceView(id)).actions.undo.enabled).toBe(true);
  });

  it('用过完全信任：放弃/撤销确认框与撤销成功提示都追加“无法撤销”的说明', async () => {
    const { ctl, id, view } = await setup({ mode: 'full_trust' });
    expect(view.confirmTexts.discard).toContain(MESSAGES.discardExtra);
    expect(view.confirmTexts.undo).toContain(MESSAGES.undoExtra);
    await saveUncheckedFlow(ctl, id, (await confirmAll(ctl, id)).version);
    const r = await ctl.undoSave(id);
    expect(r.message).toBe(`${MESSAGES.undone}${MESSAGES.undoExtra}`);
    expect(r.message).toContain('项目代码已恢复；AI 在任务副本以外做过的修改工作台无法撤销。');
  });

  it('同项目还有其他已保存且可撤销的任务：保存前提示“保存后，上一次保存就不能单独撤销了”', async () => {
    const a = await setup();
    await saveUncheckedFlow(a.ctl, a.id, (await confirmAll(a.ctl, a.id)).version);
    // 同一项目里的第二个任务
    const t2 = await a.ctl.create('第二个任务');
    await a.ctl.savePlan(t2.id, form());
    await a.ctl.start(t2.id, false);
    const v2 = await until(async () => {
      const v = await a.ctl.getAcceptanceView(t2.id);
      return v.state === 'reviewing' && !v.busy ? v : false;
    });
    expect(v2.confirmTexts.save).toBe('保存后，上一次保存就不能单独撤销了。');
  });
});

describe('放弃与清理', () => {
  it('放弃：项目不变；标准模式不追加外部影响说明', async () => {
    const { repo, ctl, id, view } = await setup();
    expect(view.confirmTexts.discard).not.toContain(MESSAGES.discardExtra);
    const t = await taskOf(repo, id);
    const r = await ctl.discardTask(id);
    expect(r).toMatchObject({ ok: true, message: MESSAGES.discardDone });
    expect(r.view.state).toBe('discarded');
    expect(await read(repo)).toBe('<h1>old</h1>\n');
    expect(await exists(t.worktree!.path)).toBe(false);
  });

  it('放弃（完全信任）：提示里含外部影响说明', async () => {
    const { ctl, id } = await setup({ mode: 'full_trust' });
    const r = await ctl.discardTask(id);
    expect(r.message).toBe(`${MESSAGES.discardDone}${MESSAGES.discardExtra}`);
  });

  it('清理失败 → cleanup_pending（视图标“需要处理”并给出重试）→ 重试成功', async () => {
    const { repo, ctl, id } = await setup();
    const t = await taskOf(repo, id);
    await G.git(repo, ['worktree', 'lock', t.worktree!.path]);
    const r = await ctl.discardTask(id);
    expect(r).toMatchObject({ ok: true, message: MESSAGES.discardCleanupPending });
    expect(r.view.state).toBe('discard_cleanup_pending');
    expect(r.view.stateText).toContain('需要处理');
    expect(r.view.actions.retryCleanup.enabled).toBe(true);
    const bad = await ctl.retryCleanup(id); // 仍被锁住
    expect(bad).toMatchObject({ ok: false, message: MESSAGES.discardCleanupPending });
    expect(JSON.stringify(bad)).not.toMatch(/locked|fatal|worktree remove/); // Git 原文不会出现在界面
    await G.git(repo, ['worktree', 'unlock', t.worktree!.path]);
    const ok = await ctl.retryCleanup(id);
    expect(ok).toMatchObject({ ok: true, message: MESSAGES.discardDone });
    expect(ok.view.state).toBe('discarded');
  });
});

describe('检查失败、验收失效、重新检查', () => {
  it('检查失败时保存置灰，说明原因，且 Git 与命令原文不出现在视图里', async () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'node check.js' } }), 'check.js': 'process.exit(1);\n', 'index.html': '<h1>old</h1>\n' };
    const { ctl, id, view } = await setup({ files, sandbox: true });
    const test = view.items.find((i) => i.key === 'test');
    expect(test).toMatchObject({ status: 'failed', text: '项目自带的测试没有通过' });
    expect(view.verdict).toBe('有检查未通过，还不能保存。');
    const v = await confirmAll(ctl, id);
    expect(v.actions.save).toMatchObject({ enabled: false });
    expect(JSON.stringify(v)).not.toMatch(/npm run|node check\.js|process\.exit/);
    const r = await ctl.saveTask(id, v.version);
    expect(r.ok).toBe(false);
    expect(r.view.state).toBe('reviewing');
  });

  it('自动检查项不可由任何确认方法改写；执行失败的任务确认全部后仍不可保存', async () => {
    const { ctl, id } = await setup({ script: [{ do: 'write', path: 'index.html', content: 'x\n' }, { do: 'exit', code: 2 }] });
    const v = await confirmAll(ctl, id);
    expect(v.items.find((i) => i.key === 'exit')).toMatchObject({ status: 'failed' });
    expect(v.actions.save.enabled).toBe(false);
    expect((await ctl.saveTask(id, v.version)).ok).toBe(false);
    // 条目编号只有 c<n> / d<n>：没有任何办法用确认方法去改 exit / build / test
    await expect(ctl.confirmCriterion(id, 'exit', v.version)).rejects.toThrow();
    await expect(ctl.confirmCriterion(id, 'build', v.version)).rejects.toThrow();
    await expect(ctl.ackDenied(id, 'test', v.version)).rejects.toThrow();
  });

  it('验收失效（确认之后副本内容变了）→ 保存置灰并突出“重新检查”→ 重新检查后旧确认全部清空、旧版本的请求被拒绝', async () => {
    const { repo, ctl, id } = await setup();
    const confirmed = await confirmAll(ctl, id);
    expect(confirmed.criteria.every((c) => c.confirmed)).toBe(true);
    const t = await taskOf(repo, id);
    await fs.writeFile(path.join(t.worktree!.path, 'index.html'), '<h1>sneaky</h1>\n');
    const invalid = await ctl.getAcceptanceView(id);
    expect(invalid.actions.save).toMatchObject({ enabled: false, reason: MESSAGES.acceptanceInvalid });
    expect(invalid.actions.recheck.highlight).toBe(true);
    expect(invalid.verdict).toContain(MESSAGES.acceptanceInvalid);
    expect(await ctl.saveTask(id, invalid.version)).toMatchObject({ ok: false, message: MESSAGES.acceptanceInvalid });
    expect(await read(repo)).toBe('<h1>old</h1>\n');

    const re = await ctl.recheck(id);
    expect(re.ok).toBe(true);
    expect(re.view.criteria.every((c) => !c.confirmed)).toBe(true); // 确认清空
    expect(re.view.version).not.toBe(confirmed.version);
    // 旧版本的所有确认类请求与保存一律拒绝
    for (const old of [confirmed.version]) {
      expect(await ctl.confirmCriterion(id, 'c0', old)).toMatchObject({ ok: false, message: MESSAGES.acceptanceInvalid });
      expect(await ctl.saveTask(id, old)).toMatchObject({ ok: false, message: MESSAGES.acceptanceInvalid });
    }
    // 用新版本重新确认后，保存的正是副本里现在的内容
    const v = await confirmAll(ctl, id);
    expect((await saveUncheckedFlow(ctl, id, v.version)).ok).toBe(true);
    expect(await read(repo)).toBe('<h1>sneaky</h1>\n');
  });

  it('重新检查后即使内容没变，版本也不同（旧版本请求照样被拒绝）', async () => {
    const { ctl, id, view } = await setup();
    const re = await ctl.recheck(id);
    expect(re.view.version).not.toBe(view.version);
    expect(re.view.version.slice(0, 12)).toBe(view.version.slice(0, 12)); // 内容相同，只是序号变了
    expect(await ctl.confirmCriterion(id, 'c0', view.version)).toMatchObject({ ok: false, message: MESSAGES.acceptanceInvalid });
  });
});

describe('主项目有未保存修改、冲突', () => {
  it('dirtyMain：保存置灰，列出文件（相对路径），保存请求返回同样的文件清单', async () => {
    const { repo, ctl, id } = await setup();
    await fs.writeFile(path.join(repo, 'notes.txt'), '我自己在写\n');
    const v = await confirmAll(ctl, id);
    expect(v.actions.save).toMatchObject({ enabled: false, reason: MESSAGES.dirtyMain, files: ['notes.txt'] });
    const r = await ctl.saveTask(id, v.version);
    expect(r).toMatchObject({ ok: false, message: MESSAGES.dirtyMain, files: ['notes.txt'] });
    expect(await read(repo, 'notes.txt')).toBe('我自己在写\n'); // 不动用户的文件
  });

  it('冲突：只有“放弃”（以及界面的“暂不处理”），没有保存、没有重新检查、没有让 AI 修改；成果仍保留；放弃后清理', async () => {
    const { repo, ctl, id } = await setup();
    const v = await confirmAll(ctl, id);
    await fs.writeFile(path.join(repo, 'index.html'), '<h1>other</h1>\n');
    await G.git(repo, ['commit', '-am', 'someone else changed the same line']);
    const r = await ctl.saveTask(id, v.version);
    expect(r).toMatchObject({ ok: false, message: MESSAGES.conflict });
    expect(r.view.state).toBe('save_failed_unmerged');
    expect(r.view.verdict).toBe(MESSAGES.conflict);
    expect(r.view.actions.save.enabled).toBe(false);
    expect(r.view.actions.recheck.enabled).toBe(false);
    expect(r.view.actions.discard.enabled).toBe(true);
    expect(Object.keys(r.view.actions).sort()).toEqual(['discard', 'recheck', 'retryCleanup', 'save', 'undo']); // 没有 request_fix 之类的入口
    const t = await taskOf(repo, id);
    expect(await exists(t.worktree!.path)).toBe(true); // 成果仍保留
    expect(await read(repo)).toBe('<h1>other</h1>\n');
    // 冲突态下再点保存也不会成功
    expect((await ctl.saveTask(id, r.view.version)).ok).toBe(false);
    const d = await ctl.discardTask(id);
    expect(d.view.state).toBe('discarded');
    expect(await exists(t.worktree!.path)).toBe(false);
  });
});

describe('重复点击、伪造参数、异常态', () => {
  it('重复点击保存只生效一次（另一次返回 busy），主项目只有一个合并提交', async () => {
    const { repo, ctl, id } = await setup({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), 'index.html': '<h1>old</h1>\n' },
      sandbox: true,
    });
    const v = await confirmAll(ctl, id);
    const before = (await G.git(repo, ['rev-list', '--count', 'HEAD'])).trim();
    const rs: AcceptanceActionResult[] = await Promise.all([ctl.saveTask(id, v.version), ctl.saveTask(id, v.version), ctl.saveTask(id, v.version)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => r.message === MESSAGES.busy)).toBe(true);
    // 合并提交 + 任务提交 = 2 个新提交
    expect(Number((await G.git(repo, ['rev-list', '--count', 'HEAD'])).trim()) - Number(before)).toBe(2);
  });

  it('伪造参数被拒绝：任务编号、条目编号、版本格式；不存在的条目', async () => {
    const { ctl, id, view } = await setup();
    await expect(ctl.getAcceptanceView('../../etc/passwd')).rejects.toThrow();
    await expect(ctl.getAcceptanceView({ id } as unknown)).rejects.toThrow();
    await expect(ctl.saveTask('../x', view.version)).rejects.toThrow(/无效的参数/);
    await expect(ctl.saveTask(id, 'latest')).rejects.toThrow(/无效的参数/);
    await expect(ctl.saveTask(id, undefined)).rejects.toThrow(/无效的参数/);
    await expect(ctl.confirmCriterion(id, 'c0; rm -rf /', view.version)).rejects.toThrow(/无效的参数/);
    await expect(ctl.confirmCriterion(id, 'c7', view.version)).rejects.toThrow(/无效的参数/); // 没有第 8 条标准
    await expect(ctl.ackDenied(id, 'd0', view.version)).rejects.toThrow(/无效的参数/); // 没有被拦下的操作
    await expect(ctl.confirmOverall(id, true as unknown)).rejects.toThrow(/无效的参数/);
    await expect(ctl.discardTask(42 as unknown)).rejects.toThrow();
    expect((await ctl.getAcceptanceView(id)).state).toBe('reviewing'); // 什么都没发生
  });

  it('被拦下的操作只能逐条确认；没有整体确认', async () => {
    const script: FakeStep[] = [
      { do: 'write', path: 'index.html', content: '<h1>new</h1>\n' },
      { do: 'ask', request: { kind: 'run_command', command: ['npm', 'install'], description: '运行 npm install' } },
      { do: 'ask', request: { kind: 'read_file', paths: ['/Users/x/.ssh/id_rsa'], description: '读取密钥' } },
    ];
    // FakeExecutor 的询问需要有人回答：这里用 deny（经 runner.respond）模拟用户拒绝——控制器层没有“允许”入口，所以直接拿 runner 拒绝
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const data = await tmpDir('data-');
    const ex = new FakeExecutor(script, { emitPermissions: true });
    const ctl = new TaskController({ repo, makeExecutor: () => ex, pickDirectory: async () => null, prefs: new TaskPrefs(data) });
    const runner = (ctl as unknown as { r(): TaskRunner }).r();
    runner.on('permission', (p: { taskId: string; request: { id: string } }) => void runner.respond(p.taskId, p.request.id, 'deny'));
    const t = await ctl.create('x');
    await ctl.savePlan(t.id, form());
    await ctl.start(t.id, false);
    const v = await until(async () => {
      const x = await ctl.getAcceptanceView(t.id);
      return x.state === 'reviewing' && !x.busy ? x : false;
    });
    expect(v.denied.map((d) => d.text)).toEqual(['想运行一条命令，已拦下', '想读取任务副本以外的位置，已拦下']);
    expect(JSON.stringify(v)).not.toMatch(/npm install|\.ssh|\/Users/);
    let cur = (await ctl.confirmCriterion(t.id, 'c0', v.version)).view;
    expect(cur.actions.save).toMatchObject({ enabled: false, reason: expect.stringContaining('拦下') });
    cur = (await ctl.ackDenied(t.id, 'd0', cur.version)).view;
    expect(cur.actions.save.enabled).toBe(false); // 只确认了一条
    cur = (await ctl.ackDenied(t.id, 'd1', cur.version)).view;
    expect(cur.actions.save.enabled).toBe(true);
  });

  it('异常态：只读，没有任何写操作；写请求被拒绝并不改变任何东西；诊断摘要不含命令与 Git 原文', async () => {
    const { repo, ctl, id } = await setup();
    const runner = new TaskRunner({ repo, executor: new FakeExecutor([]) });
    const t = (await runner.store.get(id))!;
    t.manualReview = { reason: '合并失败后，主项目的版本或文件与合并前不一致。', at: new Date().toISOString() };
    t.op = { kind: 'save', startedAt: 'x', phase: 'interrupted', steps: [{ at: 'x', name: '合并失败后核验主项目', ok: false, detail: 'fatal: CONFLICT /tmp/secret npm run x' }] };
    await runner.store.save(t);
    const v = await ctl.getAcceptanceView(id);
    expect(v.readOnly).toBe(true);
    for (const a of Object.values(v.actions)) expect(a.enabled).toBe(false);
    expect(v.diagnosticSummary).toContain(id);
    expect(v.diagnosticSummary).toContain(MESSAGES.abnormal);
    expect(JSON.stringify(v)).not.toMatch(/fatal|CONFLICT|\/tmp\/secret|npm run/);
    for (const call of [() => ctl.discardTask(id), () => ctl.undoSave(id), () => ctl.recheck(id), () => ctl.retryCleanup(id), () => ctl.saveTask(id, v.version)]) {
      expect(await call()).toMatchObject({ ok: false, message: MESSAGES.abnormal });
    }
    expect((await runner.store.get(id))!.state).toBe('reviewing'); // 一个字节都没动
    expect(await exists(t.worktree!.path)).toBe(true);
  });
});

describe('重启后状态一致、成果片段、启动核对', () => {
  it('重启（新控制器）后：验收阶段的版本、按钮状态、确认情况与重启前一致；已保存的任务重启后仍可撤销', async () => {
    const { ctl, id, make } = await setup();
    const before = await confirmAll(ctl, id);
    const again = await make().getAcceptanceView(id);
    expect(again.version).toBe(before.version);
    expect(again.actions).toEqual(before.actions);
    expect(again.criteria).toEqual(before.criteria);
    await saveUncheckedFlow(ctl, id, before.version);
    const after = await make().getAcceptanceView(id);
    expect(after.state).toBe('saved');
    expect(after.actions.undo.enabled).toBe(true);
    expect((await make().undoSave(id)).ok).toBe(true);
  });

  it('成果片段：可见“原来 / 现在”；文件清单是相对路径', async () => {
    const { view } = await setup();
    expect(view.changes).toHaveLength(1);
    const c = view.changes[0]!;
    expect(c.path).toBe('index.html');
    expect(c.preview?.kind).toBe('text');
    if (c.preview?.kind === 'text') {
      expect(c.preview.hunks[0]!.before).toEqual(['<h1>old</h1>']);
      expect(c.preview.hunks[0]!.after).toEqual(['<h1>new</h1>']);
    }
    expect(view.items.find((i) => i.key === 'preview')?.text).toBe('尚未提供预览，保存后自己打开看看，不满意可以撤销。');
  });

  it('启动核对：保存中断后重启，控制器第一次使用前完成核对，列表与视图标“已核对”并说明', async () => {
    const { repo, id, ctl, make } = await setup();
    await confirmAll(ctl, id);
    const runner = new TaskRunner({ repo, executor: new FakeExecutor([]) });
    const t = (await runner.store.get(id))!;
    const preHead = await G.headSha(repo);
    const taskCommit = await G.commitTree(t.worktree!.path, t.acceptedTree!, t.worktree!.baseSha, 'studio: x');
    await G.git(repo, ['merge', '--no-ff', '-m', 'studio: 保存', taskCommit]);
    t.op = { kind: 'save', startedAt: 'x', phase: 'task_committed', preHead, taskCommit, steps: [] };
    await runner.store.save(t);
    const fresh = make(); // 模拟应用重启
    const list = (await fresh.list()).tasks;
    expect(list[0]).toMatchObject({ state: 'saved' });
    expect(list[0]!.reconciled).toContain('已核对');
    const v = await fresh.getAcceptanceView(id);
    expect(v.reconciled).toMatch(/^已核对：/);
    expect(v.state).toBe('saved');
    expect(await exists(t.worktree!.path)).toBe(false);
  });

  describe('成果预览（网页在浏览器打开，其他在访达显示）', () => {
    it('产物含 index.html → preview.kind 为 web，按钮为“在浏览器中打开预览”；调用 openPreview 触发浏览器回调并标记完成', async () => {
      let opened: { kind: string; targetPath: string } | null = null;
      const { id, ctl } = await setup({
        script: [{ do: 'write', path: 'index.html', content: '<h1>web</h1>' }],
        files: { 'index.html': '<h1>init</h1>' },
        openPreview: async (t) => { opened = t; },
      });
      const v = await ctl.getAcceptanceView(id);
      expect(v.preview.kind).toBe('web');
      expect(v.preview.buttonText).toBe('在浏览器中打开预览');
      expect(v.preview.completed).toBe(false);

      const r = await ctl.openPreview(id, v.version);
      expect(r.ok).toBe(true);
      expect(r.message).toContain('在浏览器中打开预览');
      expect(r.view.preview.completed).toBe(true);
      expect(opened).toMatchObject({ kind: 'web' });
      expect((opened as { kind: string; targetPath: string } | null)?.targetPath).toMatch(/index\.html$/);
    });

    it('产物不含 index.html → preview.kind 为 finder，按钮为“在访达中显示”；调用 openPreview 打开目录', async () => {
      let opened: { kind: string; targetPath: string } | null = null;
      const { id, ctl } = await setup({
        script: [{ do: 'write', path: 'readme.txt', content: 'hello' }],
        files: { 'readme.txt': 'init' },
        openPreview: async (t) => { opened = t; },
      });
      const v = await ctl.getAcceptanceView(id);
      expect(v.preview.kind).toBe('finder');
      expect(v.preview.buttonText).toBe('在访达中显示');
      expect(v.preview.completed).toBe(false);

      const r = await ctl.openPreview(id, v.version);
      expect(r.ok).toBe(true);
      expect(r.message).toContain('在访达中显示');
      expect(r.view.preview.completed).toBe(true);
      expect(opened).toMatchObject({ kind: 'finder' });
    });

    it('直接调用 skipPreview → 标记为已跳过查看并完成步骤 ①，无需触发外部打开', async () => {
      let called = false;
      const { id, ctl, repo } = await setup({
        script: [{ do: 'write', path: 'readme.txt', content: 'hello' }],
        files: { 'readme.txt': 'init' },
        openPreview: async () => { called = true; },
      });
      const v = await ctl.getAcceptanceView(id);
      const r = await ctl.skipPreview(id, v.version);
      expect(r.ok).toBe(true);
      expect(r.message).toContain('已跳过查看成果');
      expect(r.view.preview.completed).toBe(true);
      expect(r.view.preview.skipped).toBe(true);
      expect(called).toBe(false);

      const t = await taskOf(repo, id);
      expect(t.previewed).toBe(false);
      expect(t.previewSkipped).toBe(true);
    });

    it('模拟打开失败 → previewed 仍为 false，第 ② 步仍锁定', async () => {
      const { id, ctl, repo } = await setup({
        script: [{ do: 'write', path: 'index.html', content: '<h1>web</h1>' }],
        files: { 'index.html': '<h1>init</h1>' },
        openPreview: async () => {
          throw new Error('模拟外部打开失败');
        },
      });
      const v = await ctl.getAcceptanceView(id);
      expect(v.preview.completed).toBe(false);

      const r = await ctl.openPreview(id, v.version);
      expect(r.ok).toBe(false);
      expect(r.message).toBe('无法打开成果，请重试，或选择不查看直接验收');
      expect(r.view.preview.completed).toBe(false);
      // 第 ② 步仍未解锁（保存按钮等仍受门禁）
      expect(r.view.actions.save.enabled).toBe(false);

      const t = await taskOf(repo, id);
      expect(t.previewed).toBe(false);
    });

    it('未注入 openPreview 回调 → 同样视为失败，不得标记 previewed', async () => {
      const { id, ctl, repo } = await setup({
        script: [{ do: 'write', path: 'index.html', content: '<h1>web</h1>' }],
        files: { 'index.html': '<h1>init</h1>' },
      });
      const v = await ctl.getAcceptanceView(id);
      expect(v.preview.completed).toBe(false);

      const r = await ctl.openPreview(id, v.version);
      expect(r.ok).toBe(false);
      expect(r.message).toBe('无法打开成果，请重试，或选择不查看直接验收');
      expect(r.view.preview.completed).toBe(false);

      const t = await taskOf(repo, id);
      expect(t.previewed).toBe(false);
    });
  });
});
