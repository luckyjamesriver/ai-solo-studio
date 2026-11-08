import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { applyPatch, diffRecord, RecordStore, CorruptRecordError, type CollectionDef } from '../src/core/persistence/index.js';
import { TaskStore } from '../src/core/task/store.js';
import { RecentProjects } from '../src/core/app/recent.js';
import { DisclosureStore } from '../src/core/app/disclosure.js';
import { TaskPrefs } from '../src/core/app/prefs.js';
import type { Task } from '../src/core/task/model.js';
import { tmpDir } from './helpers.js';

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
