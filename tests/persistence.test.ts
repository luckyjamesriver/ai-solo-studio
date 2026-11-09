import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as G from '../src/core/git/git.js';
import { applyPatch, diffRecord, RecordStore, CorruptRecordError, StateConflictError, StaleRunError, ConsentStore, CONSENT_COLLECTION, CONSENT_RECORD_ID, ManifestStore, MANIFEST_COLLECTION, type TaskManifest, type CollectionDef } from '../src/core/persistence/index.js';
import { TaskStore } from '../src/core/task/store.js';
import { RecentProjects } from '../src/core/app/recent.js';
import { DisclosureStore } from '../src/core/app/disclosure.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import type { Task } from '../src/core/task/model.js';
import { makeRepo, tmpDir } from './helpers.js';

/** 持久化服务的细节：日志补丁、迁移、校验、运行编号规则（ADR 0005 的场景在 adr-0005-scenarios.test.ts） */

describe('事件日志的变更补丁', () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ a: 1 }, { a: 1 }],
    [{ a: 1, b: 'x' }, { a: 2, b: 'x', c: [1] }],
    [{ list: [1, 2] }, { list: [1, 2, 3, 4] }], // 追加
    [{ list: [1, 2, 3] }, { list: [1, 9] }], // 整体替换
    [{ list: [1, 2] }, { list: [9, 2, 3] }], // 不是前缀：整体替换
    [{ a: 1, gone: true }, { a: 1 }], // 删除
    [{ o: { x: 1 } }, { o: { x: 2 } }],
    [{ t: [{ at: 1 }] }, { t: [{ at: 1 }, { at: 2 }, { at: 3 }] }],
  ];
  it('apply(diff(a, b), a) 总是得到 b（含追加、替换、删除）', () => {
    for (const [a, b] of cases) expect(applyPatch(a, diffRecord(a, b))).toEqual(b);
  });
  it('只增不减的数组记为追加（日志不会反复写整条时间线）；没有变化时补丁为空', () => {
    expect(diffRecord({ t: [1, 2] }, { t: [1, 2, 3] })).toEqual({ append: { t: [3] } });
    expect(diffRecord({ a: 1 }, { a: 1 })).toEqual({});
  });
});

const ITEM: CollectionDef<{ id: string; n: number }> = { name: 'items', schemaVersion: 2, schema: z.looseObject({ id: z.string(), n: z.number() }) as unknown as z.ZodType<{ id: string; n: number }>, migrate: (from, raw) => (from === 1 ? { ...(raw as object), n: Number((raw as { count?: number }).count ?? 0) } : raw) };
const V1: CollectionDef<{ id: string; count: number }> = { name: 'items', schemaVersion: 1, schema: z.looseObject({ id: z.string(), count: z.number() }) as unknown as z.ZodType<{ id: string; count: number }> };

describe('记录库', () => {
  it('写入不符合格式的内容被拒绝（zod 校验），磁盘上没有任何记录', async () => {
    const dir = await tmpDir('rs-');
    const s = await RecordStore.open(dir);
    await expect(s.repo(ITEM).commit('a', { runId: 'r', attemptId: 'x', expectedRevision: 0 }, { id: 'a', n: 'nope' } as never)).rejects.toBeInstanceOf(CorruptRecordError);
    expect(await s.repo(ITEM).get('a')).toBeNull();
    expect(await s.repo(ITEM).list()).toEqual([]);
  });

  it('低版本记录读取时按 migrate 迁移，下次提交按当前版本写回（schema_version 与 revision 分开）', async () => {
    const dir = await tmpDir('rs-');
    const s = await RecordStore.open(dir);
    await s.repo(V1).commit('a', { runId: 'r', attemptId: 'x1', expectedRevision: 0 }, { id: 'a', count: 7 });
    const old = JSON.parse(await fs.readFile(path.join(dir, 'records', 'items', 'a.json'), 'utf8'));
    expect(old).toMatchObject({ schema_version: 1, revision: 1 });
    const read = (await s.repo(ITEM).get('a'))!;
    expect(read.value.n).toBe(7);
    expect(read.revision).toBe(1);
    await s.repo(ITEM).commit('a', { runId: 'r', attemptId: 'x2', expectedRevision: 1 }, { ...read.value, n: 8 });
    const now = JSON.parse(await fs.readFile(path.join(dir, 'records', 'items', 'a.json'), 'utf8'));
    expect(now).toMatchObject({ schema_version: 2, revision: 2 }); // 格式版本升了一级，修订号只是加一
    // 迁移后日志里的快照是新格式，可重建
    await s.close();
    await fs.rm(path.join(dir, 'records'), { recursive: true });
    const s2 = await RecordStore.open(dir);
    expect((await s2.repo(ITEM).get('a'))!.value.n).toBe(8);
  });

  it('运行编号：未开工的记录接受任何 runId；开工后只接受当前 runId；重新开工换成新的', async () => {
    const dir = await tmpDir('rs-');
    const repo = (await RecordStore.open(dir)).repo(ITEM);
    expect(await repo.commit('a', { runId: 'init', attemptId: '1', expectedRevision: 0 }, { id: 'a', n: 0 })).toMatchObject({ ok: true });
    expect(await repo.commit('a', { runId: 'R1', attemptId: '2', expectedRevision: 1, startRun: true }, { id: 'a', n: 1 })).toMatchObject({ ok: true });
    expect(await repo.commit('a', { runId: 'init', attemptId: '3', expectedRevision: 2 }, { id: 'a', n: 2 })).toMatchObject({ ok: false, reason: 'stale_run' });
    expect(await repo.commit('a', { runId: 'R1', attemptId: '4', expectedRevision: 2 }, { id: 'a', n: 2 })).toMatchObject({ ok: true });
    expect(await repo.commit('a', { runId: 'R2', attemptId: '5', expectedRevision: 3, startRun: true }, { id: 'a', n: 3 })).toMatchObject({ ok: true });
    expect(await repo.commit('a', { runId: 'R1', attemptId: '6', expectedRevision: 4 }, { id: 'a', n: 4 })).toMatchObject({ ok: false, reason: 'stale_run', currentRunId: 'R2' });
  });

  it('诊断事件只追加进日志；非法的集合名与记录编号被拒绝', async () => {
    const dir = await tmpDir('rs-');
    const s = await RecordStore.open(dir);
    await s.appendEvent('diagnostic', { what: 'x', raw: 'fatal: boom' });
    expect((await s.events()).at(-1)).toMatchObject({ type: 'diagnostic', detail: { raw: 'fatal: boom' } });
    expect(() => s.recordFile('../x', 'a')).toThrow();
    expect(() => s.recordFile('items', '../../etc/passwd')).toThrow();
  });
});

describe('打开项目不弄脏用户的 Git 状态', () => {
  it('记录库一创建 .studio/，就已经被 .git/info/exclude 忽略：用户的 git status 里没有它；重复打开不重复写', async () => {
    const repo = await makeRepo();
    const ts = new TaskStore(repo);
    await ts.list();
    await ts.save({ id: 'x-1', request: 'r', state: 'draft', criteria: [], denied: [], deniedAcks: [], previewed: false, timeline: [], createdAt: 'a', updatedAt: 'a' });
    expect(fsSync.existsSync(path.join(repo, '.studio', 'events.jsonl'))).toBe(true);
    expect((await G.git(repo, ['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    const exclude = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === '.studio/')).toHaveLength(1);
    await (await ts.recordStore()).close();
    await new TaskStore(repo).list();
    expect((await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).split('\n').filter((l) => l === '.studio/')).toHaveLength(1);
  });
});

describe('旧版本数据迁移', () => {
  const legacyTask = (id: string): Task => ({ id, request: '旧任务', state: 'reviewing', criteria: [], denied: [], deniedAcks: [], previewed: false, timeline: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });

  it('旧位置 .studio/tasks/<id>.json 的任务记录迁移进记录库；交接清单与导入报告原样不动；旧文件改名保留', async () => {
    const repo = await tmpDir('mig-');
    const dir = path.join(repo, '.studio', 'tasks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'old-task-1.json'), JSON.stringify(legacyTask('old-task-1')));
    await fs.writeFile(path.join(dir, 'M9-X1.json'), JSON.stringify({ schema: 1, taskId: 'M9-X1' })); // 交接清单
    await fs.writeFile(path.join(dir, 'lowercase-1.json'), JSON.stringify({ schema: 1, taskId: 'lowercase-1' })); // 全小写编号的清单：以前会被误当成任务
    await fs.writeFile(path.join(dir, 'broken-1.json'), '{ nope');
    const ts = new TaskStore(repo);
    const list = await ts.list();
    expect(list.map((t) => t.id)).toEqual(['old-task-1']); // 清单不会被当成任务
    expect(list[0]).toMatchObject({ request: '旧任务', revision: 1 });
    expect((await fs.readdir(dir)).sort()).toEqual(['M9-X1.json', 'broken-1.json', 'lowercase-1.json', 'old-task-1.json.migrated']);
    expect((await (await ts.recordStore()).events()).find((e) => e.type === 'migrated')).toMatchObject({ id: 'old-task-1', revision: 1 });
    // 再次打开不会重复迁移
    expect((await new TaskStore(repo).list()).map((t) => t.id)).toEqual(['old-task-1']);
  });

  it('旧的应用级文件（最近项目、外发确认、偏好）迁移进 userData 记录库', async () => {
    const data = await tmpDir('app-');
    await fs.writeFile(path.join(data, 'recent-projects.json'), JSON.stringify({ version: 1, entries: [{ id: 'e1', path: '/p/a', lastOpened: '2026-01-01T00:00:00.000Z' }] }));
    await fs.writeFile(path.join(data, 'disclosure.json'), JSON.stringify({ version: 1, acceptedAt: '2026-01-02T00:00:00.000Z', services: ['OpenAI（Codex）'] }));
    await fs.writeFile(path.join(data, 'task-prefs.json'), JSON.stringify({ projects: { '/p/a': { lastMode: 'full_trust' } } }));
    expect((await new RecentProjects(data).list()).map((e) => e.id)).toEqual(['e1']);
    expect(await new DisclosureStore(data).get()).toMatchObject({ acceptedAt: '2026-01-02T00:00:00.000Z' });
    expect(await new TaskPrefs(data).getMode('/p/a')).toBe('full_trust');
    expect((await fs.readdir(data)).filter((n) => n.endsWith('.migrated')).sort()).toEqual(['disclosure.json.migrated', 'recent-projects.json.migrated', 'task-prefs.json.migrated']);
  });

  it('记录库里的应用记录损坏：按“没有”处理并写诊断事件；格式版本过高则拒绝（不当作没有）', async () => {
    const data = await tmpDir('app-');
    const r = new RecentProjects(data);
    await r.record('/p/x');
    const file = path.join(data, 'records', 'app', 'recent-projects.json');
    await fs.writeFile(file, '{ nope');
    expect(await new RecentProjects(data).list()).toEqual([]);
    expect((await (await RecordStore.open(data)).events()).some((e) => e.type === 'diagnostic')).toBe(true);
    await fs.writeFile(file, JSON.stringify({ schema_version: 9, revision: 1, updatedAt: 'x', attempts: [], data: {} }));
    await expect(new RecentProjects(data).list()).rejects.toThrow('升级');
  });
});

describe('ConsentStore（资料外发确认记录）', () => {
  it('CAS 校验与并发冲突：期望版本不一致时拒绝提交，抛出 StateConflictError，日志记为 conflict', async () => {
    const dir = await tmpDir('consent-');
    const cs = new ConsentStore(dir);
    // 初始提交：期望版本 0
    await cs.record('svc-a', { runId: 'run-1', expectedRevision: 0 });
    const stored = (await cs.get())!;
    expect(stored.revision).toBe(1);
    expect(stored.value).toEqual({ 'svc-a': expect.objectContaining({ confirmedAt: expect.any(String) }) });

    // 并发修改：两个写入者都基于 revision 1 发起修改
    await cs.record('svc-b', { runId: 'run-1', expectedRevision: 1 });
    expect((await cs.get())!.revision).toBe(2);

    // 另一个写入者仍持旧版本 1 尝试提交 → 冲突
    await expect(cs.record('svc-c', { runId: 'run-1', expectedRevision: 1 })).rejects.toBeInstanceOf(StateConflictError);
    const events = await (await cs.recordStore()).events();
    expect(events.at(-1)).toMatchObject({ type: 'conflict', collection: 'consent', id: 'consent' });
  });

  it('旧运行编号不能覆盖新状态（运行隔离/Fencing）：换新 runId 后旧 runId 提交被拒绝，抛出 StaleRunError', async () => {
    const dir = await tmpDir('consent-');
    const cs = new ConsentStore(dir);
    const store = await cs.recordStore();
    // run-1 开工
    await store.commit(CONSENT_COLLECTION, CONSENT_RECORD_ID, { runId: 'run-1', attemptId: 'att-1', expectedRevision: 0, startRun: true }, { 'svc-a': { confirmedAt: 't1' } });
    expect((await cs.get())!.currentRunId).toBe('run-1');

    // run-2 换新开工（fence）
    await store.commit(CONSENT_COLLECTION, CONSENT_RECORD_ID, { runId: 'run-2', attemptId: 'att-2', expectedRevision: 1, startRun: true }, { 'svc-a': { confirmedAt: 't1' }, 'svc-b': { confirmedAt: 't2' } });
    expect((await cs.get())!.currentRunId).toBe('run-2');

    // 来自旧运行 run-1 的迟到提交被拒绝
    const outcome = await store.commit(CONSENT_COLLECTION, CONSENT_RECORD_ID, { runId: 'run-1', attemptId: 'att-3', expectedRevision: 2 }, { 'svc-a': { confirmedAt: 't1' }, 'svc-b': { confirmedAt: 't2' }, 'svc-c': { confirmedAt: 't3' } });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale_run', currentRunId: 'run-2' });

    // record 方法同样抛出 StaleRunError
    await expect(cs.record('svc-c', { runId: 'run-1', expectedRevision: 2 })).rejects.toBeInstanceOf(StaleRunError);
  });

  it('崩溃后（汇总丢失）能从 JSONL 事件日志完整恢复，修订号与数据完全一致', async () => {
    const dir = await tmpDir('consent-');
    const cs = new ConsentStore(dir);
    await cs.record('svc-a');
    await cs.record('svc-b');
    const before = (await cs.get())!;
    expect(before.revision).toBe(2);
    expect(Object.keys(before.value).sort()).toEqual(['svc-a', 'svc-b']);

    // 模拟进程崩溃且汇总 records/ 丢失或损坏
    await (await cs.recordStore()).close();
    await fs.rm(path.join(dir, '.studio', 'records'), { recursive: true });

    // 重新打开：启动对账自动从 events.jsonl 重建汇总
    const cs2 = new ConsentStore(dir);
    const after = (await cs2.get())!;
    expect(after.revision).toBe(2);
    expect(after.value).toEqual(before.value);
    expect(await cs2.has('svc-a')).toBe(true);
    expect(await cs2.has('svc-b')).toBe(true);
  });

  it('旧版本 .studio/consent.json 自动迁移进记录库，原文件重命名为 .migrated', async () => {
    const dir = await tmpDir('consent-mig-');
    await fs.mkdir(path.join(dir, '.studio'), { recursive: true });
    await fs.writeFile(path.join(dir, '.studio', 'consent.json'), JSON.stringify({ 'svc-legacy': { confirmedAt: '2026-11-01T00:00:00.000Z' } }));

    const cs = new ConsentStore(dir);
    expect(await cs.has('svc-legacy')).toBe(true);
    const stored = (await cs.get())!;
    expect(stored.revision).toBe(1);
    expect(stored.value).toMatchObject({ 'svc-legacy': { confirmedAt: '2026-11-01T00:00:00.000Z' } });
    expect(fsSync.existsSync(path.join(dir, '.studio', 'consent.json.migrated'))).toBe(true);
  });
});

describe('ManifestStore（任务清单 / 交接清单）', () => {
  const sampleManifest = (id: string): TaskManifest => ({
    schema: 1,
    taskId: id,
    threadId: 'T-1',
    repoRoot: '/p/repo',
    branch: 'main',
    worktreePath: '/p/worktree',
    startHead: '1111111111111111111111111111111111111111',
    plan: { path: 'docs/plans/p.md', sha256: 'a'.repeat(64), artifactVersion: 1 },
    singleThinker: false,
    exportedAt: '2026-11-08T00:00:00.000Z',
    taskFile: { path: '/tmp/task.md', sha256: 'b'.repeat(64) },
  });

  it('CAS 校验与并发冲突：两个并发写入者基于同一版本修改时，后提交者收到 StateConflictError', async () => {
    const dir = await tmpDir('manifest-');
    const ms = new ManifestStore(dir);
    const m = sampleManifest('M1');
    // 初次提交 expectedRevision=0
    await ms.save(m, { expectedRevision: 0, runId: 'run-1' });
    expect(m.revision).toBe(1);

    // 写入者 A 提交 revision=1 -> revision 变成 2
    await ms.save({ ...m }, { expectedRevision: 1, runId: 'run-1' });
    expect((await ms.get('M1'))!.revision).toBe(2);

    // 写入者 B 仍基于 revision 1 尝试提交 -> 冲突
    await expect(ms.save({ ...m }, { expectedRevision: 1, runId: 'run-1' })).rejects.toBeInstanceOf(StateConflictError);
    const events = await (await ms.recordStore()).events();
    expect(events.at(-1)).toMatchObject({ type: 'conflict', collection: 'manifests', id: 'M1' });
  });

  it('旧运行编号不能覆盖新状态：换新 runId 后旧 runId 提交被拒绝，抛出 StaleRunError', async () => {
    const dir = await tmpDir('manifest-');
    const ms = new ManifestStore(dir);
    const m = sampleManifest('M2');
    await ms.save(m, { runId: 'run-1', startRun: true, expectedRevision: 0 });
    expect((await ms.get('M2'))!.runId).toBe('run-1');

    // 重新开工切换 runId 到 run-2
    await ms.save({ ...m, revision: 1 }, { runId: 'run-2', startRun: true, expectedRevision: 1 });
    expect((await ms.get('M2'))!.runId).toBe('run-2');

    // 旧 runId 提交被拒绝
    await expect(ms.save({ ...m, revision: 2 }, { runId: 'run-1', expectedRevision: 2 })).rejects.toBeInstanceOf(StaleRunError);
  });

  it('崩溃后（汇总丢失）能从 JSONL 事件日志完整恢复清单记录', async () => {
    const dir = await tmpDir('manifest-');
    const ms = new ManifestStore(dir);
    const m1 = sampleManifest('M-CRASH-1');
    const m2 = sampleManifest('M-CRASH-2');
    await ms.save(m1);
    await ms.save(m2);
    expect(await ms.list()).toHaveLength(2);

    // 模拟进程崩溃，删除 records/ 汇总
    await (await ms.recordStore()).close();
    await fs.rm(path.join(dir, '.studio', 'records'), { recursive: true });

    // 重新打开：启动对账自动从 events.jsonl 重建汇总
    const ms2 = new ManifestStore(dir);
    const list = await ms2.list();
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.taskId).sort()).toEqual(['M-CRASH-1', 'M-CRASH-2']);
    const r1 = (await ms2.get('M-CRASH-1'))!;
    expect(r1.taskId).toBe('M-CRASH-1');
    expect(r1.plan.path).toBe(m1.plan.path);
    expect(r1.revision).toBe(1);
  });

  it('旧位置 .studio/tasks/<taskId>.json 的清单文件自动迁移进记录库，原文件重命名为 .migrated', async () => {
    const dir = await tmpDir('manifest-mig-');
    const legacyDir = path.join(dir, '.studio', 'tasks');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'M-LEGACY.json'), JSON.stringify(sampleManifest('M-LEGACY')));

    const ms = new ManifestStore(dir);
    const loaded = await ms.get('M-LEGACY');
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe('M-LEGACY');
    expect(loaded!.revision).toBe(1);
    expect(fsSync.existsSync(path.join(legacyDir, 'M-LEGACY.json.migrated'))).toBe(true);
  });
});
