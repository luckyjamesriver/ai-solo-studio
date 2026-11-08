import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { migrateLegacyFiles, RecordStore, StaleRunError, StateConflictError, type CollectionDef, type OpenOptions, type RecordProblem, type Repository } from '../persistence/index.js';
import { TASK_STATES } from './state.js';
import type { Task } from './model.js';

/**
 * 任务记录的存储（ADR 0005）：记录库里的 `tasks` 集合——`<项目>/.studio/records/tasks/<id>.json`，
 * 事件日志在 `<项目>/.studio/events.jsonl`。读写都经持久化服务：每次提交做 CAS，冲突与过期运行显式报错。
 * 交接清单仍在 `.studio/tasks/`；旧版本放在那里的任务记录在第一次打开时迁移到记录库。
 */

const TASK_ID = /^[a-z0-9-]+$/;

// 校验记录的关键字段，其余字段原样保留（looseObject）。校验不过的记录不会被当作“不存在”，而是报告为无法读取。
const TaskSchema = z.looseObject({
  id: z.string().regex(TASK_ID),
  request: z.string(),
  state: z.string().refine((s) => (TASK_STATES as string[]).includes(s), '未知的任务状态'),
  denied: z.array(z.unknown()).optional(),
  deniedAcks: z.array(z.boolean()).optional(),
  criteria: z.array(z.looseObject({ text: z.string() })),
  previewed: z.boolean(),
  timeline: z.array(z.looseObject({ at: z.string(), kind: z.string(), text: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as unknown as z.ZodType<Task>;

export const TASK_COLLECTION: CollectionDef<Task> = { name: 'tasks', schemaVersion: 1, schema: TaskSchema };

export interface SaveOptions {
  /** 这次提交所属的动作编号（幂等用）；不传则自动生成 */
  attemptId?: string;
  /** 开始新的一次运行：任务的 runId 换成 task.runId（调用方先设置好），之后旧 runId 的提交一律被拒绝 */
  startRun?: boolean;
  note?: string;
}

/** 提交被拒（修订号不一致、运行已过期）时抛出的错误：调用方应重新读取后再提出，不能覆盖。 */
export { StateConflictError, StaleRunError };

export class TaskStore {
  private storeP: Promise<RecordStore> | undefined;
  /** 最近一次 list 时无法读取的记录（解析失败、格式版本过高等）：不会被当作“不存在”，也不会被覆盖 */
  problems: RecordProblem[] = [];

  constructor(private readonly repo: string, private readonly opts: OpenOptions = {}) {}

  static newId(): string {
    const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `${t}-${crypto.randomBytes(3).toString('hex')}`;
  }

  /** 打开记录库（第一次用到时才打开）；顺便迁移旧版本的任务文件 */
  recordStore(): Promise<RecordStore> {
    this.storeP ??= (async () => {
      const store = await RecordStore.open(path.join(this.repo, '.studio'), this.opts);
      await this.migrateLegacy(store);
      return store;
    })();
    return this.storeP;
  }

  private async migrateLegacy(store: RecordStore): Promise<void> {
    const dir = path.join(this.repo, '.studio', 'tasks');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const files = names.filter((n) => /^[a-z0-9-]+\.json$/.test(n)).map((n) => ({ file: path.join(dir, n), id: n.slice(0, -5) }));
    if (!files.length) return;
    await migrateLegacyFiles(store, TASK_COLLECTION, files, (raw, id) => {
      const t = raw as Partial<Task> | null;
      // 只认任务记录（有 state 与 request，编号与文件名一致）；交接清单等其他文件不动
      if (!t || typeof t !== 'object' || typeof t.state !== 'string' || typeof t.request !== 'string' || t.id !== id) return null;
      return TaskSchema.safeParse(t).success ? (t as Task) : null;
    });
  }

  private async repository(): Promise<Repository<Task>> {
    return (await this.recordStore()).repo(TASK_COLLECTION);
  }

  async get(id: string): Promise<Task | null> {
    if (!TASK_ID.test(id)) return null;
    const s = await (await this.repository()).get(id);
    return s ? { ...s.value, revision: s.revision, ...(s.currentRunId !== undefined ? { runId: s.currentRunId } : {}) } : null;
  }

  async list(): Promise<Task[]> {
    const { items, problems } = await (await this.repository()).listAll();
    this.problems = problems;
    return items
      .map((s) => ({ ...s.value, revision: s.revision, ...(s.currentRunId !== undefined ? { runId: s.currentRunId } : {}) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 提交任务记录。task.revision 是读到时的修订号（新建为空 = 0）；成功后会更新为新的修订号。
   * 修订号不一致 → StateConflictError；运行已过期 → StaleRunError。
   */
  async save(task: Task, opts: SaveOptions = {}): Promise<void> {
    const repo = await this.repository();
    task.updatedAt = new Date().toISOString();
    const { revision, runId, ...data } = task;
    const r = await repo.commit(
      task.id,
      { runId: runId ?? 'init', attemptId: opts.attemptId ?? RecordStore.newAttemptId(), expectedRevision: revision ?? 0, ...(opts.startRun ? { startRun: true } : {}), ...(opts.note ? { note: opts.note } : {}) },
      data as Task,
    );
    if (!r.ok) {
      if (r.reason === 'conflict') throw new StateConflictError(TASK_COLLECTION.name, task.id, r.expected, r.actual);
      throw new StaleRunError(TASK_COLLECTION.name, task.id, runId ?? 'init', r.currentRunId);
    }
    task.revision = r.revision;
    if (opts.startRun && runId) task.runId = runId;
  }
}
