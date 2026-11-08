import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  CorruptRecordError,
  RecordStore,
  StaleRunError,
  StateConflictError,
  UnsupportedSchemaError,
  VolumeNotSupportedError,
  WriterLockedError,
  localApfsProbe,
  type CollectionDef,
} from '../src/core/persistence/index.js';
import { atomicWrite } from '../src/core/persistence/files.js';
import { TaskStore } from '../src/core/task/store.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { canFire, next, InvalidTransition } from '../src/core/task/state.js';
import type { Task } from '../src/core/task/model.js';
import { FakeExecutor, type FakeStep } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import * as G from '../src/core/git/git.js';
import { makeRepo, tmpDir } from './helpers.js';

/**
 * ADR 0005 的 9 个验收场景（评审原文）+ 附加检查。全部在临时目录里运行，沙箱可跑。
 * 规则出处：docs/adr/0005-data-storage.md 第 2、2.1、7 节。
 */

type Note = { id: string; state: string; n: number; items: string[] };
const NOTES: CollectionDef<Note> = {
  name: 'notes',
  schemaVersion: 1,
  schema: z.looseObject({ id: z.string(), state: z.string(), n: z.number(), items: z.array(z.string()) }) as unknown as z.ZodType<Note>,
};
const att = () => RecordStore.newAttemptId();
const cmd = (rev: number, runId = 'r1', extra: { startRun?: boolean; attemptId?: string } = {}) => ({ runId, attemptId: extra.attemptId ?? att(), expectedRevision: rev, ...(extra.startRun ? { startRun: true } : {}) });
const note = (id: string, over: Partial<Note> = {}): Note => ({ id, state: 'running', n: 0, items: [], ...over });
async function newStore(dir?: string) {
  const d = dir ?? (await tmpDir('persist-'));
  return { dir: d, store: await RecordStore.open(d) };
}
const noteFile = (dir: string, id: string) => path.join(dir, 'records', 'notes', `${id}.json`);
async function until<T>(f: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 25));
  }
}
function mkTask(id: string, state: Task['state'] = 'reviewing'): Task {
  const now = new Date().toISOString();
  return { id, request: 'x', state, criteria: [], denied: [], deniedAcks: [], previewed: false, timeline: [], createdAt: now, updatedAt: now };
}
/** 子进程（像“另一个应用进程”）：运行 tests/fixtures 里的脚本，返回输出 */
function child(script: string, args: string[]) {
  const p = spawn(process.execPath, [path.join(process.cwd(), 'tests', 'fixtures', script), ...args], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  return { p, exited, output: () => out };
}

const WRITE_NEW: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }, { do: 'exit', code: 0 }];
async function confirmedTask(files: Record<string, string> = { 'index.html': '<h1>old</h1>\n' }, script: FakeStep[] = WRITE_NEW) {
  const repo = await makeRepo(files);
  const runner = new TaskRunner({ repo, executor: new FakeExecutor(script), runChecks: false });
  const t = await runner.create('改标题');
  await runner.setPlan(t.id, { goal: '改标题', inScope: [], outOfScope: [], criteria: ['标题已更新'], risks: [], irreversible: [], capabilities: {} } as never);
  await runner.approve(t.id);
  await runner.start(t.id);
  await runner.confirm(t.id, { criterion: 0, decision: 'confirmed' });
  return { repo, runner, id: t.id };
}

describe('ADR 0005 验收场景', () => {
  it('1. 两个 Agent 同时修改同一任务：不发生静默覆盖，冲突可识别、可处理', async () => {
    const { store } = await newStore();
    const repo = store.repo(NOTES);
    expect(await repo.commit('t1', cmd(0, 'r1', { startRun: true }), note('t1'))).toMatchObject({ ok: true, revision: 1 });
    const a = (await repo.get('t1'))!;
    const b = (await repo.get('t1'))!; // 两个 Agent 读到的都是修订 1
    expect(await repo.commit('t1', cmd(a.revision), { ...a.value, n: 1, items: ['A'] })).toMatchObject({ ok: true, revision: 2 });
    const rb = await repo.commit('t1', cmd(b.revision), { ...b.value, n: 2, items: ['B'] });
    expect(rb).toEqual({ ok: false, reason: 'conflict', expected: 1, actual: 2 }); // 冲突可识别
    expect((await repo.get('t1'))!.value.items).toEqual(['A']); // 没有被覆盖
    expect((await store.events()).filter((e) => e.type === 'conflict')).toHaveLength(1); // 冲突入日志
    // 可处理：落败者读取最新记录，在最新内容上重新提出
    const latest = (await repo.get('t1'))!;
    expect(await repo.commit('t1', cmd(latest.revision), { ...latest.value, items: [...latest.value.items, 'B'] })).toMatchObject({ ok: true, revision: 3 });
    expect((await repo.get('t1'))!.value.items).toEqual(['A', 'B']);

    // 任务层：TaskStore.save 对同一冲突抛出 StateConflictError（不会静默覆盖）
    const ts = new TaskStore(await tmpDir('tasks-'));
    await ts.save(mkTask('t-one'));
    const x = (await ts.get('t-one'))!;
    const y = (await ts.get('t-one'))!;
    x.request = 'from A';
    y.request = 'from B';
    await ts.save(x);
    await expect(ts.save(y)).rejects.toBeInstanceOf(StateConflictError);
    expect((await ts.get('t-one'))!.request).toBe('from A');
  });

  it('2. 10 个任务并行更新同一项目：所有已确认提交的状态最终可恢复，项目汇总准确', async () => {
    const { dir, store } = await newStore();
    const repo = store.repo(NOTES);
    const ids = Array.from({ length: 10 }, (_, i) => `task-${i}`);
    const acked: Record<string, number> = {};
    await Promise.all(
      ids.map(async (id) => {
        let rev = 0;
        for (let k = 1; k <= 5; k++) {
          const r = await repo.commit(id, cmd(rev, `run-${id}`, { startRun: k === 1 }), note(id, { n: k, items: Array.from({ length: k }, (_, j) => `u${j}`) }));
          if (!r.ok) throw new Error(`提交失败：${JSON.stringify(r)}`);
          rev = r.revision;
          acked[id] = rev; // 已确认（返回成功）的提交
        }
      }),
    );
    const before = Object.fromEntries((await repo.list()).map((s) => [s.id, s]));
    expect(Object.values(acked)).toEqual(Array(10).fill(5));
    // 汇总（项目级投影）：10 个任务，每个修订 5、n=5
    expect(Object.values(before).reduce((s, x) => s + x.value.n, 0)).toBe(50);
    // 丢掉全部汇总，关闭并重开（相当于应用重启）：由日志重建，所有已确认提交都在
    await store.close();
    await fs.rm(path.join(dir, 'records'), { recursive: true });
    const s2 = await RecordStore.open(dir);
    expect(s2.report.rebuilt).toHaveLength(10);
    const after = Object.fromEntries((await s2.repo(NOTES).list()).map((s) => [s.id, s]));
    expect(after).toEqual(before);
    for (const id of ids) {
      const revs = (await s2.events()).filter((e) => e.type === 'commit' && e.id === id).map((e) => e.revision);
      expect(revs).toEqual([1, 2, 3, 4, 5]); // 日志里每条记录的修订号连续
    }
  });

  it('3. 任务取消与完成几乎同时发生：最终状态符合明确的状态机规则', async () => {
    // 状态机规则（src/core/task/state.ts）：saved 只能撤销、不能放弃；discarded 是终态、不能保存
    const ts = new TaskStore(await tmpDir('tasks-'));
    await ts.save(mkTask('race-a'));
    const a = (await ts.get('race-a'))!;
    const b = (await ts.get('race-a'))!;
    a.state = next(a.state, 'save');
    b.state = next(b.state, 'discard');
    await ts.save(a); // 完成先到
    await expect(ts.save(b)).rejects.toBeInstanceOf(StateConflictError); // 取消后到：冲突，不覆盖
    const re = (await ts.get('race-a'))!;
    expect(re.state).toBe('saved');
    expect(canFire(re.state, 'discard')).toBe(false);
    expect(() => next(re.state, 'discard')).toThrow(InvalidTransition);

    await ts.save(mkTask('race-b'));
    const c = (await ts.get('race-b'))!;
    const d = (await ts.get('race-b'))!;
    c.state = next(c.state, 'discard');
    d.state = next(d.state, 'save');
    await ts.save(c); // 取消先到
    await expect(ts.save(d)).rejects.toBeInstanceOf(StateConflictError);
    const re2 = (await ts.get('race-b'))!;
    expect(re2.state).toBe('discarded');
    expect(canFire(re2.state, 'save')).toBe(false);

    // 编排器层：同一项目的保存与放弃互斥，先到者胜；最终状态与项目内容一致
    for (const order of ['save-first', 'discard-first'] as const) {
      const s = await confirmedTask();
      const calls = order === 'save-first' ? [() => s.runner.save(s.id), () => s.runner.discard(s.id)] : [() => s.runner.discard(s.id), () => s.runner.save(s.id)];
      const [r1, r2] = await Promise.all(calls.map((f) => f()));
      const final = (await s.runner.store.get(s.id))!.state;
      expect(final).toBe(order === 'save-first' ? 'saved' : 'discarded');
      expect(r1).toMatchObject({ ok: true });
      expect(r2).toMatchObject({ ok: false, reason: 'busy' });
      const main = await fs.readFile(path.join(s.repo, 'index.html'), 'utf8');
      expect(main).toBe(order === 'save-first' ? '<h1>new</h1>\n' : '<h1>old</h1>\n');
      // 终态之后再取消/完成：被状态机拒绝
      expect(await (order === 'save-first' ? s.runner.discard(s.id) : s.runner.save(s.id))).toMatchObject({ ok: false });
    }
  });

  it('4. 任务完成事件重复回传：不重复提交，也不重复触发副作用', async () => {
    const { dir, store } = await newStore();
    const repo = store.repo(NOTES);
    await repo.commit('t4', cmd(0, 'r1', { startRun: true }), note('t4'));
    let sideEffects = 0;
    const deliver = async () => {
      const r = await repo.commit('t4', { runId: 'r1', attemptId: 'complete-1', expectedRevision: 1 }, note('t4', { state: 'done', n: 1 }));
      if (r.ok && !r.duplicate) sideEffects++; // 副作用（合并、清理、通知）只在首次触发
      return r;
    };
    const first = await deliver();
    const second = await deliver(); // 重复回传：期望的修订号已经过期，但按 attemptId 识别为重复
    const third = await deliver();
    expect(first).toMatchObject({ ok: true, revision: 2, duplicate: false });
    expect(second).toMatchObject({ ok: true, revision: 2, duplicate: true });
    expect(third).toMatchObject({ ok: true, duplicate: true });
    expect(sideEffects).toBe(1);
    expect((await repo.get('t4'))!.revision).toBe(2); // 没有重复提交
    const ev = await store.events();
    expect(ev.filter((e) => e.type === 'commit' && e.attemptId === 'complete-1')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'duplicate')).toHaveLength(2);
    // 重启、甚至汇总丢失之后，去重依据仍在（来自日志）
    await store.close();
    await fs.rm(path.join(dir, 'records'), { recursive: true });
    const s2 = await RecordStore.open(dir);
    expect(await s2.repo(NOTES).commit('t4', { runId: 'r1', attemptId: 'complete-1', expectedRevision: 1 }, note('t4', { state: 'done', n: 1 }))).toMatchObject({ ok: true, duplicate: true });
    // 任务层同理
    const ts = new TaskStore(await tmpDir('tasks-'));
    const t = mkTask('t4-task');
    await ts.save(t);
    t.state = 'saved';
    await ts.save(t, { attemptId: 'exit-1' });
    const rev = t.revision;
    await ts.save(t, { attemptId: 'exit-1' });
    expect((await ts.get('t4-task'))!.revision).toBe(rev);
  });

  it('5. App 退出后重开，旧 Agent 回传结果：过期运行身份不能覆盖新状态', async () => {
    // 5a：编排器——任务施工中“应用退出”，重开后的启动核对换掉运行编号；旧 Agent 之后回传的结果被拒绝
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    const hang: FakeStep[] = [{ do: 'write', path: 'index.html', content: '<h1>half</h1>\n' }, { do: 'say', text: 'working' }, { do: 'hang' }];
    const r1 = new TaskRunner({ repo, executor: new FakeExecutor(hang), runChecks: false });
    const t = await r1.create('x');
    await r1.setPlan(t.id, { goal: 'x', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [], capabilities: {} } as never);
    await r1.approve(t.id);
    const p1 = r1.start(t.id).catch((e: unknown) => e);
    await until(async () => (await r1.store.get(t.id))?.timeline.some((e) => e.text === 'working'));
    const oldRun = (await r1.store.get(t.id))!.runId!;
    const r2 = new TaskRunner({ repo, executor: new FakeExecutor([]), runChecks: false }); // 重开后的新应用实例
    const out = await r2.reconcileTasks();
    expect(out.map((o) => o.taskId)).toEqual([t.id]);
    const fenced = (await r2.store.get(t.id))!;
    expect(fenced.runId).not.toBe(oldRun);
    await r1.stop(t.id); // 旧 Agent 现在回传“已停止”
    await p1;
    const after = (await r2.store.get(t.id))!;
    expect(JSON.stringify(after)).toBe(JSON.stringify(fenced)); // 没有被旧运行改写
    expect((await (await r2.store.recordStore()).events()).some((e) => e.type === 'stale_run' && e.runId === oldRun)).toBe(true);

    // 5b：存储层——换掉运行编号并重启之后，旧运行编号的提交仍被拒绝
    const { dir, store } = await newStore();
    const nr = store.repo(NOTES);
    await nr.commit('t5', cmd(0, 'run-old', { startRun: true }), note('t5'));
    await nr.commit('t5', cmd(1, 'run-new', { startRun: true }), note('t5', { n: 1 })); // 重新开工：新的运行
    await store.close();
    const s2 = await RecordStore.open(dir); // App 退出后重开
    const rep = s2.repo(NOTES);
    const cur = (await rep.get('t5'))!;
    expect(cur.currentRunId).toBe('run-new');
    expect(await rep.commit('t5', cmd(cur.revision, 'run-old'), note('t5', { n: 99, state: 'overwritten' }))).toEqual({ ok: false, reason: 'stale_run', currentRunId: 'run-new' });
    expect((await rep.get('t5'))!.value.n).toBe(1);
    const ts = new TaskStore(await tmpDir('tasks-'));
    const task = mkTask('t5-task', 'running');
    task.runId = 'run-A';
    await ts.save(task, { startRun: true });
    const stale = (await ts.get('t5-task'))!;
    stale.runId = 'run-OLD';
    await expect(ts.save(stale)).rejects.toBeInstanceOf(StaleRunError);
  });

  it('6. 保存时进程被强制终止：可恢复为旧版本或新版本，不接受无法解析的半成品作为权威数据', async () => {
    // 6a：真实 SIGKILL——子进程用 write-file-atomic 不停地覆盖写，在不同时刻被杀；文件任何时候都是完整的某个版本
    const dir = await tmpDir('kill-');
    const target = path.join(dir, 'doc.json');
    await fs.writeFile(target, JSON.stringify({ revision: 0, filler: '' }));
    for (const delay of [30, 80, 140, 200, 260]) {
      const c = child('atomic-writer.mjs', [target]);
      await until(async () => c.output().includes('READY'));
      await new Promise((r) => setTimeout(r, delay));
      c.p.kill('SIGKILL');
      await c.exited;
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as { revision: number; filler: string };
      expect(Number.isInteger(parsed.revision)).toBe(true); // 完整可解析，没有半个文件
      expect(parsed.filler.startsWith('xxx') || parsed.filler === '').toBe(true);
    }
    // 6b：写入中途失败（临时文件已创建）→ 原文件不变，临时文件被清理，错误显式抛出
    const before = await fs.readFile(target, 'utf8');
    await expect(atomicWrite(target, 'NEW', { tmpfileCreated: () => { throw new Error('boom'); } })).rejects.toThrow('boom');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect((await fs.readdir(dir)).filter((f) => f !== 'doc.json' && !/^doc\.json\.\d+$/.test(f))).toEqual([]);

    // 6c：服务层的几种“被杀后”的磁盘状态
    const { dir: d2, store } = await newStore();
    const repo = store.repo(NOTES);
    await repo.commit('t6', cmd(0, 'r1', { startRun: true }), note('t6', { items: ['v1'], n: 1 }));
    const v1Text = await fs.readFile(noteFile(d2, 't6'), 'utf8');
    await repo.commit('t6', cmd(1), note('t6', { items: ['v1', 'v2'], n: 2 }));
    const v2Text = await fs.readFile(noteFile(d2, 't6'), 'utf8');
    await store.close();
    //  (i) 日志已追加、汇总还是旧版本 → 重开后恢复为新版本
    await fs.writeFile(noteFile(d2, 't6'), v1Text);
    const s1 = await RecordStore.open(d2);
    expect(s1.report.rebuilt).toContain('notes/t6');
    expect((await s1.repo(NOTES).get('t6'))!.value.items).toEqual(['v1', 'v2']);
    await s1.close();
    //  (ii) 汇总是写到一半的半成品 → 读取时报“无法解析”（不当作权威数据、也不当作不存在）；重开后由日志恢复
    await fs.writeFile(noteFile(d2, 't6'), v2Text.slice(0, Math.floor(v2Text.length / 2)));
    const s2 = await RecordStore.open(d2);
    expect(s2.report.rebuilt).toContain('notes/t6'); // 启动对账已经修好
    expect((await s2.repo(NOTES).get('t6'))!.revision).toBe(2);
    //  运行中发现半成品：显式报错，而不是返回 null
    await fs.writeFile(noteFile(d2, 't6'), '{ "schema_version": 1, "revi');
    await expect(s2.repo(NOTES).get('t6')).rejects.toBeInstanceOf(CorruptRecordError);
    expect((await s2.repo(NOTES).listAll()).problems.map((p) => p.id)).toEqual(['t6']);
    await expect(s2.repo(NOTES).commit('t6', cmd(2), note('t6'))).rejects.toBeInstanceOf(CorruptRecordError); // 也不会覆盖它
    await s2.close();
    //  (iii) 残留的临时文件在对账时被清理
    await fs.writeFile(`${noteFile(d2, 't6')}.123456789`, '{ "partial');
    const s3 = await RecordStore.open(d2);
    expect(s3.report.removedTemp).toContain('t6.json.123456789');
    expect((await fs.readdir(path.dirname(noteFile(d2, 't6')))).sort()).toEqual(['t6.json']);
    expect((await s3.repo(NOTES).get('t6'))!.value.items).toEqual(['v1', 'v2']);
  });

  it('7. 磁盘写满、权限不足：原有效数据保持完整，失败显式报告', async () => {
    const { dir, store } = await newStore();
    const repo = store.repo(NOTES);
    await repo.commit('t7', cmd(0, 'r1', { startRun: true }), note('t7', { items: ['ok'], n: 1 }));
    const file = noteFile(dir, 't7');
    const intact = await fs.readFile(file, 'utf8');
    const recordsDir = path.dirname(file);

    // 7a：权限不足（目录只读）
    await fs.chmod(recordsDir, 0o555);
    try {
      await expect(repo.commit('t7', cmd(1), note('t7', { items: ['ok', 'lost'], n: 2 }))).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    } finally {
      await fs.chmod(recordsDir, 0o755);
    }
    expect(await fs.readFile(file, 'utf8')).toBe(intact); // 原数据一字节未动
    expect((await fs.readdir(recordsDir)).sort()).toEqual(['t7.json']); // 没有临时文件残留

    // 7b：磁盘写满（让底层写入返回 ENOSPC）
    const real = fsSync.write;
    const spy = vi.spyOn(fsSync, 'write').mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    }) as unknown as typeof fsSync.write);
    try {
      await expect(repo.commit('t7', cmd(1), note('t7', { items: ['ok', 'lost2'], n: 3 }))).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      spy.mockRestore();
      expect(fsSync.write).toBe(real);
    }
    expect(await fs.readFile(file, 'utf8')).toBe(intact);
    expect((await fs.readdir(recordsDir)).sort()).toEqual(['t7.json']);

    // 失败被记录（作废标记），之后修订号没有空洞，重启后失败的提交不会“复活”
    const ev = await store.events();
    expect(ev.filter((e) => e.type === 'rollback')).toHaveLength(2);
    expect(await repo.commit('t7', cmd(1), note('t7', { items: ['ok', 'later'], n: 4 }))).toMatchObject({ ok: true, revision: 2 });
    await store.close();
    const s2 = await RecordStore.open(dir);
    const got = (await s2.repo(NOTES).get('t7'))!;
    expect(got.revision).toBe(2);
    expect(got.value.items).toEqual(['ok', 'later']);

    // 日志写不进去（权限不足）：汇总同样保持完整，失败显式报告
    const logFile = path.join(dir, 'events.jsonl');
    await fs.chmod(logFile, 0o444);
    const before = await fs.readFile(noteFile(dir, 't7'), 'utf8');
    try {
      await expect(s2.repo(NOTES).commit('t7', cmd(2), note('t7', { n: 9 }))).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    } finally {
      await fs.chmod(logFile, 0o644);
    }
    expect(await fs.readFile(noteFile(dir, 't7'), 'utf8')).toBe(before);
  });

  it('8. 两个应用进程尝试操作同一数据目录：不允许两个独立写入者同时提交', async () => {
    // 8a：另一个进程持有租约 → 本进程拒绝写入并报告
    const dir = await tmpDir('lock-');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, '.writer'), '');
    const holder = child('lock-hold.mjs', [path.join(dir, '.writer')]);
    await until(async () => holder.output().includes('READY'));
    await expect(RecordStore.open(dir)).rejects.toBeInstanceOf(WriterLockedError);
    expect(await fs.readdir(dir)).not.toContain('events.jsonl'); // 什么都没写
    holder.p.stdin!.end();
    await holder.exited;

    // 8b：本进程持有租约 → 另一个进程取不到
    const store = await RecordStore.open(dir);
    const probe = child('lock-try.mjs', [path.join(dir, '.writer')]);
    await probe.exited;
    expect(probe.output().trim()).toBe('LOCKED');
    // 同一进程里同一目录始终是同一个写入者（不会出现两个独立写入者）
    expect(await RecordStore.open(dir)).toBe(store);
    await store.close();
    const probe2 = child('lock-try.mjs', [path.join(dir, '.writer')]);
    await probe2.exited;
    expect(probe2.output().trim()).toBe('OK'); // 释放之后别的进程可以接手

    // 8c：持有者被强杀（租约没有释放）→ 过期之后才能接手；过期前不能
    const holder2 = child('lock-hold.mjs', [path.join(dir, '.writer')]);
    await until(async () => holder2.output().includes('READY'));
    holder2.p.kill('SIGKILL');
    await holder2.exited;
    await expect(RecordStore.open(dir)).rejects.toBeInstanceOf(WriterLockedError); // 还没过期
    const taken = await RecordStore.open(dir, { lockWaitMs: 9000, staleMs: 5000 });
    expect(taken).toBeDefined();
    await taken.close();
  }, 30_000);

  it('9. 两个 Agent 修改同一源码文件：隔离或冲突检测生效，不出现无提示的最后写入覆盖', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n', 'other.txt': 'o\n' });
    // 同一个执行体，按任务目标给出不同的改动：A 与 B 都改 index.html 的同一行
    const exec = new FakeExecutor((prompt) => (prompt.includes('目标：A') ? [{ do: 'write', path: 'index.html', content: '<h1>from A</h1>\n' }] : [{ do: 'write', path: 'index.html', content: '<h1>from B</h1>\n' }]));
    const runner = new TaskRunner({ repo, executor: exec, runChecks: false });
    const mk = async (goal: string) => {
      const t = await runner.create(goal);
      await runner.setPlan(t.id, { goal, inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [], capabilities: {} } as never);
      await runner.approve(t.id);
      return t.id;
    };
    const [a, b] = [await mk('A'), await mk('B')];
    await Promise.all([runner.start(a), runner.start(b)]); // 并行执行
    // 隔离：各自的副本里是各自的内容，主项目没有被动过
    const ta = (await runner.store.get(a))!;
    const tb = (await runner.store.get(b))!;
    expect(ta.worktree!.path).not.toBe(tb.worktree!.path);
    expect(await fs.readFile(path.join(ta.worktree!.path, 'index.html'), 'utf8')).toBe('<h1>from A</h1>\n');
    expect(await fs.readFile(path.join(tb.worktree!.path, 'index.html'), 'utf8')).toBe('<h1>from B</h1>\n');
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>old</h1>\n');
    expect(ta.runId).not.toBe(tb.runId); // 各自是独立的运行
    await runner.confirm(a, { overall: true });
    await runner.confirm(b, { overall: true });
    // 先保存 A；再保存 B：与 A 冲突 → 提示用户，不覆盖
    expect(await runner.save(a)).toMatchObject({ ok: true });
    const rb = await runner.save(b);
    expect(rb).toMatchObject({ ok: false, reason: 'conflict', detail: MESSAGES.conflict });
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toBe('<h1>from A</h1>\n'); // A 的内容还在，没有被 B 的最后写入覆盖
    expect(await G.dirtyFiles(repo)).toEqual([]); // 主项目干净、没有半个合并
    const fa = (await runner.store.get(a))!;
    const fb = (await runner.store.get(b))!;
    expect(fa.state).toBe('saved');
    expect(fb.state).toBe('save_failed_unmerged');
    expect(fb.worktree).toBeDefined(); // B 的成果仍保留
    expect(fa.revision).toBeGreaterThan(1);
    expect(fb.revision).toBeGreaterThan(1);
    // 事件日志里两个任务各有自己的提交序列，修订号连续
    const ev = await (await runner.store.recordStore()).events();
    for (const id of [a, b]) {
      const revs = ev.filter((e) => e.collection === 'tasks' && e.id === id && e.revision !== undefined && !['duplicate', 'conflict', 'stale_run', 'rollback'].includes(e.type)).map((e) => e.revision!);
      expect(revs).toEqual(Array.from({ length: revs.length }, (_, i) => i + 1));
    }
  });
});

describe('ADR 0005 附加检查（不计入 9 条）', () => {
  it('汇总丢失或损坏：由事件日志重建，逐字段与原来一致', async () => {
    const { dir, store } = await newStore();
    const repo = store.repo(NOTES);
    let rev = 0;
    for (let i = 1; i <= 8; i++) {
      const r = await repo.commit('t', cmd(rev, 'r1', { startRun: i === 1 }), note('t', { n: i, state: i % 2 ? 'running' : 'paused', items: Array.from({ length: i }, (_, j) => `i${j}`) }));
      if (r.ok) rev = r.revision;
    }
    const original = await fs.readFile(noteFile(dir, 't'), 'utf8');
    await store.close();
    await fs.rm(noteFile(dir, 't'));
    const s1 = await RecordStore.open(dir);
    expect(s1.report.rebuilt).toEqual(['notes/t']);
    expect(JSON.parse(await fs.readFile(noteFile(dir, 't'), 'utf8')).data).toEqual(JSON.parse(original).data);
    expect(JSON.parse(await fs.readFile(noteFile(dir, 't'), 'utf8')).revision).toBe(8);
    await s1.close();
    // 汇总被改成别的内容（同一修订号）：以日志为准改正
    const env = JSON.parse(original);
    env.data.n = 777;
    await fs.writeFile(noteFile(dir, 't'), JSON.stringify(env));
    const s2 = await RecordStore.open(dir);
    expect(s2.report.diverged).toEqual(['notes/t']);
    expect((await s2.repo(NOTES).get('t'))!.value.n).toBe(8);
  });

  it('日志末行被截断：忽略不完整末行并报告，之前记录不受影响，之后可继续追加', async () => {
    const { dir, store } = await newStore();
    const repo = store.repo(NOTES);
    await repo.commit('t', cmd(0, 'r1', { startRun: true }), note('t'));
    await repo.commit('t', cmd(1), note('t', { n: 1 }));
    const goodLog = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
    await store.close();
    await fs.appendFile(path.join(dir, 'events.jsonl'), '{"seq":99,"ts":"2026-11-09T00:00:00.000Z","type":"commit","collection":"notes","id":"t","revi'); // 写到一半被杀
    const s = await RecordStore.open(dir);
    expect(s.report.truncatedLog).toBe(true);
    expect(s.report.warnings.join('')).toContain('不完整');
    const afterOpen = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
    expect(afterOpen.startsWith(goodLog)).toBe(true); // 截断回最后一个完整行：原有的完整记录一字不变
    expect(afterOpen.slice(goodLog.length).split('\n').filter(Boolean).map((l) => JSON.parse(l).type)).toEqual(['reconcile']); // 之后只多了一条对账记录
    expect((await s.repo(NOTES).get('t'))!.revision).toBe(2);
    expect(await s.repo(NOTES).commit('t', cmd(2), note('t', { n: 2 }))).toMatchObject({ ok: true, revision: 3 });
    const events = await s.events(); // 全部行都能解析，seq 递增
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    expect((await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
  });

  it('读到更高的 schema_version：拒绝读取并提示升级，不当作不存在，不覆盖', async () => {
    const { dir, store } = await newStore();
    await store.repo(NOTES).commit('t', cmd(0, 'r1', { startRun: true }), note('t'));
    await store.close();
    const env = JSON.parse(await fs.readFile(noteFile(dir, 't'), 'utf8'));
    env.schema_version = 99;
    const text = JSON.stringify(env, null, 2);
    await fs.writeFile(noteFile(dir, 't'), text);
    const s = await RecordStore.open(dir); // 对账不会碰它（修订号与内容一致）
    const repo = s.repo(NOTES);
    await expect(repo.get('t')).rejects.toBeInstanceOf(UnsupportedSchemaError);
    await expect(repo.get('t')).rejects.toThrow('升级');
    expect((await repo.listAll()).problems[0]?.error).toBeInstanceOf(UnsupportedSchemaError);
    await expect(repo.commit('t', cmd(1), note('t', { n: 5 }))).rejects.toBeInstanceOf(UnsupportedSchemaError);
    expect(await fs.readFile(noteFile(dir, 't'), 'utf8')).toBe(text); // 没有被覆盖
  });

  it('数据目录不在本地 APFS：拒绝启用写入并提示（检测接口可注入）', async () => {
    const dir = path.join(await tmpDir('vol-'), 'data');
    await expect(RecordStore.open(dir, { volumeProbe: async () => ({ ok: false, reason: '磁盘类型是 smbfs，不是 APFS。' }) })).rejects.toBeInstanceOf(VolumeNotSupportedError);
    await expect(RecordStore.open(dir, { volumeProbe: async () => ({ ok: false, reason: 'x' }) })).rejects.toThrow('本地 APFS');
    expect(fsSync.existsSync(dir)).toBe(false); // 检查先于创建：什么都没写
    const ok = await RecordStore.open(dir, { volumeProbe: async () => ({ ok: true }) });
    expect(ok.root).toBeTruthy();
    await ok.close();
    // 真实探测：在 macOS 上，临时目录所在的卷是本地 APFS；其他平台一律不支持
    const real = await localApfsProbe(await tmpDir('vol-real-'));
    if (process.platform === 'darwin') expect(real).toEqual({ ok: true });
    else expect(real.ok).toBe(false);
  });
});
