import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toUserView, acceptanceVersion, isVersionFormat, mapFailure, okMessage, VIEW_TEXT } from '../src/core/acceptance/view.js';
import { makeHunks, buildPreviews, PREVIEW_TEXT } from '../src/core/acceptance/snippets.js';
import { verifyNoLiveExecutor, type ProcessProbe } from '../src/core/task/process-check.js';
import { scrubAiText, safeRelPath } from '../src/core/acceptance/texts.js';
import { MESSAGES } from '../src/core/task/messages.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import * as G from '../src/core/git/git.js';
import type { Task } from '../src/core/task/model.js';
import { makeRepo } from './helpers.js';

/** M3-B4-2：用户验收视图（不泄露）、成果片段、版本、进程核实（纯函数与真实 Git，无需 Electron） */

function baseTask(over: Partial<Task> = {}): Task {
  return { id: 't1', request: '改标题', state: 'reviewing', denied: [], deniedAcks: [], criteria: [], previewed: false, timeline: [], createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:01.000Z', ...over };
}

describe('用户验收视图：不泄露命令、Git 原文、绝对路径、证据原文', () => {
  const hostile = baseTask({
    exit: { kind: 'spawn_error', message: 'spawn /usr/local/bin/codex ENOENT; rm -rf /' },
    acceptedTree: 'a'.repeat(40),
    acceptanceRev: 2,
    isolationWarnings: ['数据将发往 https://evil.example，路径 /Users/victim/secret'],
    denied: [
      { kind: 'run_command', command: ['rm', '-rf', '/Users/victim'], description: 'rm -rf ~ && npm run build', risk: 'high' },
      { kind: 'read_file', paths: ['/Users/victim/.ssh/id_rsa'], description: '读取 /Users/victim/.ssh/id_rsa', risk: 'high' },
      { kind: 'write_file', paths: ['src/app.js'], description: '写 src/app.js', risk: 'low' },
    ],
    deniedAcks: [false, false, true],
    criteria: [{ text: '标题已更新', decision: 'confirmed' }],
    timeline: [
      { at: 't', kind: 'message', source: 'host', text: 'fatal: not a git repository: /Users/victim/proj' },
      { at: 't', kind: 'message', text: '构建失败：运行 npm run build 报错，rm -rf /tmp/x 被拦下，文件在 /Users/victim/proj/index.html。' },
      { at: 't', kind: 'error', text: 'error: pathspec /Users/victim/x did not match' },
    ],
    op: { kind: 'save', startedAt: 't', phase: 'interrupted', steps: [{ at: 't', name: '合并失败后核验主项目', ok: false, detail: 'CONFLICT (content): Merge conflict in /Users/victim/proj/a.txt' }] },
    cleanup: { at: 't', steps: [{ step: 'worktree_remove', ok: false, error: 'git worktree remove 失败：fatal: /Users/victim/proj/.studio/worktrees/x is locked' }] },
    manualReview: { reason: '合并失败后，主项目的版本或文件与合并前不一致。', at: 't' },
    customCommitChecks: true,
    card: {
      items: [
        { key: 'exit', label: 'x', status: 'failed', evidence: '无法启动执行体：spawn /usr/local/bin/codex ENOENT; rm -rf /' },
        { key: 'changes', label: 'x', status: 'verified', evidence: '2 个文件发生变化' },
        { key: 'build', label: 'x', status: 'failed', evidence: 'npm run build 失败' },
        { key: 'test', label: 'x', status: 'verified', evidence: 'npm run test 成功（1 秒）' },
        { key: 'checks_modified', label: 'x', status: 'not_checked', evidence: '检查改动了文件，检查结果已作废。 npm run x' },
        { key: 'denied', label: 'x', status: 'pending_user', evidence: '有 3 项操作被你拒绝：rm -rf /Users/victim（run_command，风险：high）' },
        { key: 'preview', label: 'x', status: 'pending_user', evidence: '尚未试用' },
        { key: 'criterion-0', label: '标题已更新', status: 'user_confirmed', evidence: '由你确认' },
      ],
      changes: [
        { status: 'modified', path: 'index.html', additions: 1, deletions: 1 },
        { status: 'added', path: '/Users/victim/abs.txt', additions: 1, deletions: 0 },
        { status: 'added', path: '../escape.txt', additions: 1, deletions: 0 },
      ],
      readyToSave: false,
      headline: 'npm run build 失败 /Users/victim',
    },
  });
  const BAD = /npm run|rm -rf|\/Users\/|victim|fatal:|CONFLICT|pathspec|evil\.example|ENOENT|\.ssh|worktree remove|git worktree|\/usr\/local/;

  it('视图 JSON 中不出现 npm run、rm -rf、绝对路径、Git stderr、证据原文', () => {
    const v = toUserView(hostile, { busy: false, saveCheck: { ok: false, reason: 'dirty_main', detail: 'x', files: ['/Users/victim/a.txt', 'ok.txt', '../up.txt'] } });
    const json = JSON.stringify(v);
    expect(json).not.toMatch(BAD);
    // 同一份样本在各状态下都不泄露
    for (const state of ['reviewing', 'saved', 'saved_cleanup_pending', 'discard_cleanup_pending', 'undo_failed', 'save_failed_unmerged'] as const) {
      expect(JSON.stringify(toUserView({ ...hostile, state, manualReview: undefined }, { busy: false })), state).not.toMatch(BAD);
    }
    // 断言自身有效：样本本身确实含有这些内容
    expect(JSON.stringify(hostile)).toMatch(BAD);
  });

  it('文案按状态生成：测试证据写“项目自带的测试全部通过（1 秒）”；被拒操作只给类别与相对位置；检查结果作废用固定文案', () => {
    const v = toUserView(hostile, { busy: false });
    expect(v.items.find((i) => i.key === 'test')?.text).toBe('项目自带的测试全部通过（1 秒）');
    expect(v.items.find((i) => i.key === 'build')?.text).toBe('项目自带的构建没有通过');
    expect(v.items.find((i) => i.key === 'exit')?.text).toBe('AI 没能正常运行');
    expect(v.items.find((i) => i.key === 'checks_modified')?.text).toBe(MESSAGES.checksModified);
    expect(v.denied.map((d) => d.text)).toEqual(['想运行一条命令，已拦下', '想读取任务副本以外的位置，已拦下', '想修改「src/app.js」，已拦下']);
    expect(v.denied.map((d) => d.acked)).toEqual([false, false, true]);
    expect(v.changes.map((c) => c.path)).toEqual(['index.html', '（路径不可显示）', '（路径不可显示）']);
    expect(v.notes).toContain(MESSAGES.skippedCommitChecks);
    // 预览从未提供：如实写“未检查”，不是“等你确认”
    const pv = toUserView(baseTask({ card: { items: [{ key: 'preview', label: 'x', status: 'pending_user', evidence: '尚未试用' }], changes: [], readyToSave: false, headline: 'h' } }), { busy: false });
    expect(pv.items[0]).toMatchObject({ key: 'preview', status: 'not_checked', text: VIEW_TEXT.previewNone });
  });

  it('AI 自述文字隐去命令与本机路径，其余原样保留', () => {
    expect(scrubAiText('运行 npm run build 报错')).not.toMatch(/npm run/);
    expect(scrubAiText('rm -rf /tmp/x 被拦下')).not.toMatch(/rm -rf|\/tmp/);
    expect(scrubAiText('文件在 /Users/a/b/c.txt')).not.toMatch(/\/Users/);
    expect(scrubAiText('联网安装依赖失败了')).toBe('联网安装依赖失败了');
    expect(safeRelPath('src/a.js')).toBe('src/a.js');
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', '~/x', 'C:\\x', '']) expect(safeRelPath(bad), bad).toBeNull();
  });

  it('异常状态（需要人工查看）：只读，一切写操作不可用；诊断摘要只含编号、状态、时间与固定文案', () => {
    const v = toUserView(hostile, { busy: false });
    expect(v.readOnly).toBe(true);
    for (const [name, a] of Object.entries(v.actions)) expect(a, name).toMatchObject({ enabled: false, reason: MESSAGES.abnormal });
    expect(v.verdict).toBe(MESSAGES.abnormal);
    expect(v.diagnosticSummary).toBe(['任务编号：t1', '状态：等待你验收', '更新时间：2026-11-08T00:00:01.000Z', `说明：${MESSAGES.abnormal}`, `提示：${MESSAGES.abnormal}`].join('\n'));
  });

  it('核心层失败 → 固定文案；未知原因不透传核心层的文字', () => {
    const f = (reason: Parameters<typeof mapFailure>[0]['reason'], detail = 'fatal: /Users/x git 原文') => mapFailure({ ok: false, reason, detail, files: ['/abs/x', 'rel.txt'] });
    expect(f('dirty_main')).toEqual({ message: MESSAGES.dirtyMain, files: ['rel.txt'] });
    expect(f('conflict').message).toBe(MESSAGES.conflict);
    expect(f('acceptance_invalid').message).toBe(MESSAGES.acceptanceInvalid);
    expect(f('undo_refused').message).toBe(MESSAGES.undoRefused);
    expect(f('failed').message).toBe(MESSAGES.opFailed); // 核心层这里的 detail 可能是 Git 原文
    expect(f('busy').message).toBe(MESSAGES.busy);
    expect(f('abnormal').message).toBe(MESSAGES.abnormal);
    expect(f('cleanup_pending', MESSAGES.saveCleanupPending).message).toBe(MESSAGES.saveCleanupPending);
    expect(f('cleanup_pending').message).toBe(VIEW_TEXT.cleanupNeeded);
    expect(mapFailure({ ok: false, reason: 'whatever' as never, detail: 'x' }).message).toBe(MESSAGES.unknownError);
    for (const r of ['busy', 'not_ready', 'not_allowed', 'repo_changed', 'branch_changed', 'dirty_main', 'external_driver', 'acceptance_invalid', 'conflict', 'unchecked_needs_confirm', 'abnormal', 'undo_refused', 'cleanup_pending', 'failed'] as const) {
      expect(JSON.stringify(f(r)), r).not.toMatch(/fatal|\/Users|git 原文/);
    }
    expect(mapFailure({ ok: false, reason: 'unchecked_needs_confirm', detail: 'fatal: /Users/secret npm run test', uncheckedKind: 'unavailable', unavailableReason: 'scripts_changed_reauth' }).message).toBe('这次合并改动了项目的检查方式，所以没法自动检查。');
  });
});

describe('验收版本与按钮状态', () => {
  const reviewing = (over: Partial<Task> = {}) =>
    baseTask({
      exit: { kind: 'exited', code: 0 },
      acceptedTree: 'b'.repeat(40),
      acceptanceRev: 1,
      criteria: [{ text: '标题已更新' }],
      card: { items: [{ key: 'exit', label: 'x', status: 'verified', evidence: '' }, { key: 'changes', label: 'x', status: 'verified', evidence: '' }], changes: [{ status: 'modified', path: 'index.html', additions: 1, deletions: 1 }], readyToSave: false, headline: 'h' },
      ...over,
    });

  it('版本 = 冻结内容短哈希 + 序号；格式严格；重新检查后序号加一，即使内容没变版本也不同', () => {
    const t = reviewing();
    expect(acceptanceVersion(t)).toBe('bbbbbbbbbbbb-1');
    expect(acceptanceVersion({ ...t, acceptanceRev: 2 })).toBe('bbbbbbbbbbbb-2');
    expect(isVersionFormat('bbbbbbbbbbbb-1')).toBe(true);
    for (const bad of ['', 'abc', 'bbbbbbbbbbbb', 'BBBBBBBBBBBB-1', 'bbbbbbbbbbbb-x', 'bbbbbbbbbbbb-1; rm', 1, null, undefined]) expect(isVersionFormat(bad), String(bad)).toBe(false);
    expect(acceptanceVersion(baseTask())).toBe('');
  });

  it('保存：标准未确认 → 置灰并说明原因；全部满足 → 可用；冲突态只有放弃；撤销入口在已保存任务里始终可见（条件不满足时置灰并说明）', () => {
    const v1 = toUserView(reviewing(), { busy: false, saveCheck: null });
    expect(v1.actions.save).toMatchObject({ enabled: false, reason: VIEW_TEXT.blockers.criteria_unconfirmed });
    expect(v1.verdict).toBe(VIEW_TEXT.verdictNotReady(VIEW_TEXT.blockers.criteria_unconfirmed));
    const ok = reviewing({ criteria: [{ text: '标题已更新', decision: 'confirmed' }] });
    const v2 = toUserView(ok, { busy: false, saveCheck: null });
    expect(v2.actions.save.enabled).toBe(true);
    expect(v2.verdict).toBe(VIEW_TEXT.verdictReady);
    // 操作进行中：全部置灰
    expect(toUserView(ok, { busy: true, saveCheck: null }).actions.save).toMatchObject({ enabled: false, reason: MESSAGES.busy });
    // 冲突态
    const c = toUserView({ ...ok, state: 'save_failed_unmerged' }, { busy: false });
    expect(c.verdict).toBe(MESSAGES.conflict);
    expect(c.actions.save.enabled).toBe(false);
    expect(c.uncheckedConfirm).toBeNull();
    expect(c.actions.recheck.enabled).toBe(false);
    expect(c.actions.discard.enabled).toBe(true);
    // 已保存：撤销可用；条件不满足时置灰并说明
    const saved = baseTask({ state: 'saved', saveRecord: { preMergeHead: 'a', taskCommit: 'b', mergeCommit: 'c', branch: 'main', savedAt: 'x' } });
    expect(toUserView(saved, { busy: false, undoCheck: null }).actions.undo.enabled).toBe(true);
    expect(toUserView(saved, { busy: false, undoCheck: { ok: false, reason: 'undo_refused', detail: 'x' } }).actions.undo).toMatchObject({ enabled: false, reason: MESSAGES.undoRefused });
    expect(toUserView({ ...saved, state: 'saved_cleanup_pending' }, { busy: false }).actions.undo.enabled).toBe(false);
  });

  it('未检查确认区：仅最近一次保存为 unchecked_needs_confirm 且验收版本一致时下发「打开预览」「仍然保存」；版本变化、重新验收、已保存或失败时不下发', () => {
    const version = acceptanceVersion(reviewing({ criteria: [{ text: '标题已更新', decision: 'confirmed' }] }));
    const ready = reviewing({
      criteria: [{ text: '标题已更新', decision: 'confirmed' }],
      uncheckedConfirm: {
        version,
        preHead: '1'.repeat(40),
        kind: 'unavailable',
        unavailableReason: 'scripts_changed_reauth',
        reasonText: '这次合并改动了项目的检查方式，所以没法自动检查。',
        at: '2026-11-10T00:00:00.000Z',
      },
    });

    // 1) 未触发过 unchecked_needs_confirm 时，视图中没有「仍然保存」
    const plain = toUserView(reviewing({ criteria: [{ text: '标题已更新', decision: 'confirmed' }] }), { busy: false, saveCheck: null });
    expect(plain.uncheckedConfirm).toBeNull();
    expect(JSON.stringify(plain)).not.toContain('仍然保存');

    // 2) 最近一次保存是 unchecked_needs_confirm 且同版本可保存 → 下发原因 + 两个按钮文案
    const shown = toUserView(ready, { busy: false, saveCheck: null });
    expect(shown.uncheckedConfirm).toEqual({
      kind: 'unavailable',
      unavailableReason: 'scripts_changed_reauth',
      reason: '这次合并改动了项目的检查方式，所以没法自动检查。',
      previewButtonText: '打开预览',
      confirmButtonText: '仍然保存',
    });

    // 3) 版本变了（如重新验收 acceptanceRev 加一，或 acceptedTree 变化）→ 不下发「仍然保存」
    const revChanged = toUserView({ ...ready, acceptanceRev: 2 }, { busy: false, saveCheck: null });
    expect(revChanged.uncheckedConfirm).toBeNull();
    expect(JSON.stringify(revChanged)).not.toContain('仍然保存');

    const treeChanged = toUserView({ ...ready, acceptedTree: 'c'.repeat(40) }, { busy: false, saveCheck: null });
    expect(treeChanged.uncheckedConfirm).toBeNull();

    // 4) 已保存 / 冲突 / 已放弃 / 异常只读态 / saveCheck 阻塞 → 不下发「仍然保存」
    for (const st of ['saved', 'saved_cleanup_pending', 'save_failed_unmerged', 'discarded', 'undone'] as const) {
      expect(toUserView({ ...ready, state: st }, { busy: false }).uncheckedConfirm, st).toBeNull();
    }
    expect(toUserView({ ...ready, manualReview: { reason: '异常', at: 't' } }, { busy: false }).uncheckedConfirm).toBeNull();
    expect(toUserView(ready, { busy: false, saveCheck: { ok: false, reason: 'dirty_main', detail: '' } }).uncheckedConfirm).toBeNull();
    expect(toUserView({ ...ready, criteria: [{ text: '标题已更新' }] }, { busy: false, saveCheck: null }).uncheckedConfirm).toBeNull();
  });

  it('外部影响：额外文件夹或完全信任时，放弃确认、撤销确认、撤销成功提示都追加说明；否则不追加', () => {
    const plan = (caps: object) => ({ goal: 'g', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [], capabilities: { constructionMode: 'standard', externalNetwork: 'off', extraWritableDirs: [], ...caps } }) as unknown as Task['plan'];
    const plain = toUserView(reviewing({ plan: plan({}) }), { busy: false });
    expect(plain.confirmTexts.discard).not.toContain(MESSAGES.discardExtra);
    expect(plain.confirmTexts.undo).not.toContain(MESSAGES.undoExtra);
    expect(okMessage(baseTask({ state: 'undone', plan: plan({}) }))).toBe(MESSAGES.undone);
    for (const caps of [{ constructionMode: 'full_trust' }, { extraWritableDirs: ['/somewhere'] }]) {
      const t = reviewing({ plan: plan(caps) });
      const v = toUserView(t, { busy: false });
      expect(v.confirmTexts.discard).toContain(MESSAGES.discardExtra);
      expect(v.confirmTexts.undo).toContain(MESSAGES.undoExtra);
      expect(okMessage({ ...t, state: 'undone' })).toBe(`${MESSAGES.undone}${MESSAGES.undoExtra}`);
      expect(okMessage({ ...t, state: 'discarded' })).toBe(`${MESSAGES.discardDone}${MESSAGES.discardExtra}`);
    }
    expect(MESSAGES.undoExtra).toBe('项目代码已恢复；AI 在任务副本以外做过的修改工作台无法撤销。');
  });

  it('同项目还有其他可撤销的保存：保存前提示“保存后，上一次保存就不能单独撤销了”', () => {
    const t = reviewing({ criteria: [{ text: 'x', decision: 'confirmed' }] });
    expect(toUserView(t, { busy: false, saveCheck: null, otherUndoableSave: true }).confirmTexts.save).toBe('保存后，上一次保存就不能单独撤销了。');
    expect(toUserView(t, { busy: false, saveCheck: null }).confirmTexts.save).toBeNull();
  });
});

describe('成果片段：截断规则', () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  const edit = (lines: string[], at: number[]) => lines.map((l, i) => (at.includes(i + 1) ? `${l} CHANGED` : l));

  it('只取改动处上下各 2 行；行号是“现在”的文件里的位置', () => {
    const a = numbered(50);
    const { hunks, omitted } = makeHunks(a.join('\n'), edit(a, [20]).join('\n'));
    expect(omitted).toBe(0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toEqual(['line 18', 'line 19', 'line 20', 'line 21', 'line 22']);
    expect(hunks[0]!.after).toEqual(['line 18', 'line 19', 'line 20 CHANGED', 'line 21', 'line 22']);
    expect(hunks[0]!.line).toBe(18);
    expect(hunks[0]!.truncated).toBe(false);
  });

  it('相距不超过 4 行的改动合并成一处；更远的分开', () => {
    const a = numbered(60);
    expect(makeHunks(a.join('\n'), edit(a, [10, 14]).join('\n')).hunks).toHaveLength(1);
    expect(makeHunks(a.join('\n'), edit(a, [10, 20]).join('\n')).hunks).toHaveLength(2);
  });

  it('每个文件最多 5 处，其余只报数量', () => {
    const a = numbered(200);
    const { hunks, omitted } = makeHunks(a.join('\n'), edit(a, [10, 30, 50, 70, 90, 110, 130, 150]).join('\n'));
    expect(hunks).toHaveLength(5);
    expect(omitted).toBe(3);
    expect(PREVIEW_TEXT.omitted(omitted)).toBe('还有 3 处改动没有显示');
  });

  it('每处每一侧最多 12 行，超出标记截断', () => {
    const a = numbered(100);
    const { hunks } = makeHunks(a.join('\n'), edit(a, Array.from({ length: 30 }, (_, i) => 20 + i)).join('\n'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toHaveLength(12);
    expect(hunks[0]!.after).toHaveLength(12);
    expect(hunks[0]!.truncated).toBe(true);
  });

  it('只增删行、开头结尾、CRLF 都能处理；没有改动时没有片段', () => {
    expect(makeHunks('a\nb\nc\n', 'a\nb\nc\n').hunks).toEqual([]);
    expect(makeHunks('a\r\nb\r\n', 'a\nb\n').hunks).toEqual([]);
    const add = makeHunks('a\nb\nc', 'a\nX\nb\nc').hunks;
    expect(add[0]!.before).toEqual(['a', 'b', 'c']);
    expect(add[0]!.after).toEqual(['a', 'X', 'b', 'c']);
    const del = makeHunks('a\nb\nc', 'a\nc').hunks;
    expect(del[0]!.before).toEqual(['a', 'b', 'c']);
    expect(del[0]!.after).toEqual(['a', 'c']);
    expect(makeHunks('', 'x\ny').hunks[0]!.after).toEqual(['x', 'y']);
  });
});

describe('成果片段：来自冻结的验收内容与基线（真实 Git）', () => {
  async function frozen(setup: (dir: string) => Promise<void>, files: Record<string, string> = { 'index.html': '<h1>old</h1>\nline2\nline3\n', 'gone.txt': 'bye\n', 'old-name.txt': 'same\ncontent\nhere\n' }) {
    const repo = await makeRepo(files);
    const wt = await G.createWorktree(repo, 'p1');
    await setup(wt.path);
    const changes = await G.diffSummary(wt);
    const acceptedTree = await G.computeTree(repo, wt.path);
    const task = baseTask({ worktree: wt, acceptedTree, card: { items: [], changes, readyToSave: false, headline: 'h' } });
    return { repo, task, previews: await buildPreviews(repo, task) };
  }
  const w = (dir: string, f: string, c: string | Buffer) => fs.writeFile(path.join(dir, f), c);

  it('改动的文本文件给出“原来 / 现在”；新文件“新文件”+ 开头最多 20 行；删除“已删除”', async () => {
    const lines30 = Array.from({ length: 30 }, (_, i) => `n${i + 1}`).join('\n');
    const { previews } = await frozen(async (d) => {
      await w(d, 'index.html', '<h1>new</h1>\nline2\nline3\n');
      await w(d, 'fresh.txt', `${lines30}\n`);
      await fs.rm(path.join(d, 'gone.txt'));
    });
    const mod = previews.get('index.html');
    expect(mod).toMatchObject({ kind: 'text', omitted: 0 });
    if (mod?.kind === 'text') {
      expect(mod.hunks[0]!.before).toEqual(['<h1>old</h1>', 'line2', 'line3']);
      expect(mod.hunks[0]!.after).toEqual(['<h1>new</h1>', 'line2', 'line3']);
    }
    const fresh = previews.get('fresh.txt');
    expect(fresh).toMatchObject({ kind: 'new', note: '新文件', truncated: true });
    if (fresh?.kind === 'new') expect(fresh.lines).toHaveLength(20);
    expect(previews.get('gone.txt')).toEqual({ kind: 'deleted', note: '已删除' });
  });

  it('二进制、非 UTF-8、超过 200 KB：显示“这类文件无法直接显示，保存后可以自己打开查看”', async () => {
    const note = '这类文件无法直接显示，保存后可以自己打开查看';
    const { previews } = await frozen(
      async (d) => {
        await w(d, 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
        await w(d, 'latin.txt', Buffer.from([0x61, 0xe9, 0xff, 0x0a])); // 不是合法 UTF-8
        await w(d, 'big.txt', `${'x'.repeat(200 * 1024 + 10)}\n`);
        await w(d, 'edited-big.txt', `${'y'.repeat(200 * 1024 + 10)}\n`); // 现在超限
      },
      { 'index.html': 'x\n', 'edited-big.txt': 'small\n' },
    );
    for (const f of ['bin.dat', 'latin.txt', 'big.txt', 'edited-big.txt']) expect(previews.get(f), f).toEqual({ kind: 'unavailable', note }) ;
  });

  it('改名的文件用原路径比对；片段内容就是将要保存的那一份（工作树之后再改也不影响展示）', async () => {
    const { previews, task, repo } = await frozen(async (d) => {
      await fs.rename(path.join(d, 'old-name.txt'), path.join(d, 'new-name.txt'));
      await w(d, 'new-name.txt', 'same\nCHANGED\nhere\n');
    });
    const r = previews.get('new-name.txt');
    expect(r?.kind).toBe('text');
    // 冻结之后在副本里再改：重新生成的片段仍然取自冻结的内容
    await w(task.worktree!.path, 'new-name.txt', 'totally different\n');
    const again = await buildPreviews(repo, task);
    expect(again.get('new-name.txt')).toEqual(r);
  });
});

describe('启动核对前的进程核实', () => {
  const probe = (alive: boolean, name: string | null): ProcessProbe => ({ isAlive: () => alive, nameOf: async () => name });
  const withProc = (over: Partial<Task> = {}) => baseTask({ executorId: 'codex', exit: { kind: 'exited', code: 0 }, execProc: { pid: 4242, at: 't', name: 'codex' }, ...over });

  it('进程不存在 → 通过；仍存在且是执行体 → 不通过；进程号已被别的程序占用 → 通过；无法确认 → 不通过', async () => {
    expect(await verifyNoLiveExecutor(withProc(), probe(false, null))).toEqual({ ok: true });
    expect(await verifyNoLiveExecutor(withProc(), probe(true, 'codex'))).toMatchObject({ ok: false });
    expect(await verifyNoLiveExecutor(withProc(), probe(true, 'Safari'))).toEqual({ ok: true });
    expect(await verifyNoLiveExecutor(withProc(), probe(true, null))).toMatchObject({ ok: false });
    expect(await verifyNoLiveExecutor(withProc({ execProc: { pid: 4242, at: 't' } }), probe(true, 'codex'))).toMatchObject({ ok: false }); // 当时没记下可执行文件名
  });

  it('没有进程记录：已有结束记录（或根本没开过工）通过；仍在施工中却没有记录 → 不通过', async () => {
    expect(await verifyNoLiveExecutor(baseTask({ executorId: 'fake', exit: { kind: 'exited', code: 0 } }), probe(false, null))).toEqual({ ok: true });
    expect(await verifyNoLiveExecutor(baseTask({ state: 'discarded' }), probe(false, null))).toEqual({ ok: true });
    expect(await verifyNoLiveExecutor(baseTask({ state: 'running', executorId: 'codex' }), probe(false, null))).toMatchObject({ ok: false });
    expect(await verifyNoLiveExecutor(baseTask({ executorId: 'codex' }), probe(false, null))).toMatchObject({ ok: false });
  });
});

describe('启动核对：两步与安全收尾', () => {
  const WRITE: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];
  async function confirmedTask(probe?: ProcessProbe) {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const mk = () => new TaskRunner({ repo, executor: new FakeExecutor(WRITE), runChecks: false, ...(probe ? { processProbe: probe } : {}) });
    const runner = mk();
    const t = await runner.create('改标题');
    await runner.setPlan(t.id, { goal: '改标题', inScope: [], outOfScope: [], criteria: ['标题已更新'], risks: [], irreversible: [], capabilities: {} } as never);
    await runner.approve(t.id);
    await runner.start(t.id);
    await runner.confirm(t.id, { criterion: 0, decision: 'confirmed' });
    return { repo, id: t.id, mk, runner };
  }
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  it('第一步只读：identifyTasks 不写任务记录、不动副本；第二步才收尾', async () => {
    const s = await confirmedTask();
    const t = (await s.runner.store.get(s.id))!;
    t.op = { kind: 'discard', startedAt: 'x', phase: 'started', steps: [] };
    await s.runner.store.save(t);
    const before = JSON.stringify(await s.runner.store.get(s.id));
    const found = await s.mk().identifyTasks();
    expect(found).toEqual([{ taskId: s.id, finding: { kind: 'discard_resume' } }]);
    expect(JSON.stringify(await s.runner.store.get(s.id))).toBe(before); // 记录一个字节都没变
    expect(await exists(t.worktree!.path)).toBe(true);
    const out = await s.mk().reconcileTasks();
    expect(out).toHaveLength(1);
    const after = (await s.runner.store.get(s.id))!;
    expect(after.state).toBe('discarded');
    expect(after.reconciled?.note).toBeTruthy(); // 标“已核对”
  });

  it('执行体进程仍在运行：不删除副本，标 discard_cleanup_pending（需要处理），进程退出后“重试清理”成功', async () => {
    let alive = true;
    const probe: ProcessProbe = { isAlive: () => alive, nameOf: async () => 'codex' };
    const s = await confirmedTask(probe);
    const t = (await s.runner.store.get(s.id))!;
    t.execProc = { pid: 4242, at: 'x', name: 'codex' };
    t.op = { kind: 'discard', startedAt: 'x', phase: 'started', steps: [] };
    await s.runner.store.save(t);
    const fresh = s.mk();
    const out = await fresh.reconcileTasks();
    expect(out[0]?.action).toContain('核实未通过');
    const after = (await fresh.store.get(s.id))!;
    expect(after.state).toBe('discard_cleanup_pending');
    expect(await exists(t.worktree!.path)).toBe(true); // 没有删除
    expect(after.reconciled?.note).toContain('重试清理');
    expect(await fresh.reconcileTasks()).toEqual([]); // 重复启动不会反复处理
    alive = false;
    expect((await fresh.retryCleanup(s.id)).ok).toBe(true);
    expect((await fresh.store.get(s.id))!.state).toBe('discarded');
    expect(await exists(t.worktree!.path)).toBe(false);
  });

  it('保存已合并但执行体进程无法核实：保存结果保留（saved_cleanup_pending），不删除副本', async () => {
    const probe: ProcessProbe = { isAlive: () => true, nameOf: async () => null }; // 存在但认不出是什么
    const s = await confirmedTask(probe);
    const t = (await s.runner.store.get(s.id))!;
    t.execProc = { pid: 4242, at: 'x', name: 'codex' };
    const preHead = await G.headSha(s.repo);
    const taskCommit = await G.commitTree(t.worktree!.path, t.acceptedTree!, t.worktree!.baseSha, 'studio: x');
    await G.git(s.repo, ['merge', '--no-ff', '-m', 'studio: 保存', taskCommit]);
    t.op = { kind: 'save', startedAt: 'x', phase: 'task_committed', preHead, taskCommit, steps: [] };
    await s.runner.store.save(t);
    await s.mk().reconcileTasks();
    const after = (await s.runner.store.get(s.id))!;
    expect(after.state).toBe('saved_cleanup_pending');
    expect(after.saveRecord?.mergeCommit).toBe(await G.headSha(s.repo)); // 已保存的事实如实记录
    expect(await exists(t.worktree!.path)).toBe(true);
  });

  it('任务归属对不上（副本分支不是这个任务的）：不删除', async () => {
    const s = await confirmedTask();
    const t = (await s.runner.store.get(s.id))!;
    t.worktree = { ...t.worktree!, branch: 'studio/task-someone-else' };
    t.op = { kind: 'discard', startedAt: 'x', phase: 'started', steps: [] };
    await s.runner.store.save(t);
    await s.mk().reconcileTasks();
    const after = (await s.runner.store.get(s.id))!;
    expect(after.state).toBe('discard_cleanup_pending');
    expect(await exists(t.worktree!.path)).toBe(true);
  });
});
