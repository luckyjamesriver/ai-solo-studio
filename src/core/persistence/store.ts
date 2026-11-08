import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { CorruptRecordError, StaleRunError, StateConflictError, UnsupportedSchemaError, WriterLockedError } from './errors.js';
import { appendLineDurable, atomicWrite, removeFile, truncateTo } from './files.js';
import { applyPatch, diffRecord, type RecordPatch } from './patch.js';
import { requireLocalVolume, type VolumeProbe } from './volume.js';

/**
 * 持久化服务（ADR 0005）。一个 RecordStore 管一个数据根目录（项目的 `.studio/`，或应用的 userData）：
 * - 唯一写入者：打开时取得数据目录租约（proper-lockfile），同一时刻只有一个写入者；
 * - 每次提交带 runId、attemptId、expectedRevision，做 CAS 校验；冲突、过期运行都显式报告并记入日志，绝不静默覆盖；
 * - 提交顺序：持锁 → 校验 → 追加事件日志并落盘 → 原子写汇总；
 * - 汇总（records/<集合>/<id>.json）是事件日志（events.jsonl）的投影，可重建；启动时自动对账。
 */

export interface CollectionDef<T> {
  /** 集合名，同时是 records/ 下的目录名 */
  name: string;
  /** 记录格式版本（和 revision 是两回事：revision 是每次提交加一的并发计数） */
  schemaVersion: number;
  /** 当前格式的数据校验 */
  schema: z.ZodType<T>;
  /** 低版本数据迁移到当前版本（返回的内容再过 schema 校验） */
  migrate?: (fromVersion: number, raw: unknown) => unknown;
}

export interface CommitCmd {
  runId: string;
  attemptId: string;
  /** 提交者读到的版本；新建记录用 0 */
  expectedRevision: number;
  /** 开始新的一次运行：把记录的当前 runId 换成 cmd.runId（之后旧 runId 的提交一律拒绝） */
  startRun?: boolean;
  /** 写入日志的备注（例如 fence、migrated） */
  note?: string;
}

export interface Stored<T> {
  id: string;
  value: T;
  revision: number;
  currentRunId?: string | undefined;
}

export type CommitOutcome<T> =
  | { ok: true; revision: number; value: T; duplicate: boolean }
  | { ok: false; reason: 'conflict'; expected: number; actual: number }
  | { ok: false; reason: 'stale_run'; currentRunId?: string | undefined };

export interface RecordProblem {
  id: string;
  error: Error;
}

/** 存储层接口：UI 与 Agent 只能依赖它，不能绕过（依赖边界检查，ADR 0006） */
export interface Repository<T> {
  get(id: string): Promise<Stored<T> | null>;
  list(): Promise<Stored<T>[]>;
  /** 同上，同时返回无法读取的记录（解析失败、格式版本过高等），不把它们当作“不存在” */
  listAll(): Promise<{ items: Stored<T>[]; problems: RecordProblem[] }>;
  commit(id: string, cmd: CommitCmd, value: T): Promise<CommitOutcome<T>>;
}

type Obj = Record<string, unknown>;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ATTEMPTS = 200;

const Envelope = z.object({
  schema_version: z.number().int().min(0),
  revision: z.number().int().min(1),
  currentRunId: z.string().optional(),
  updatedAt: z.string(),
  attempts: z.array(z.object({ id: z.string(), revision: z.number().int() })).default([]),
  data: z.record(z.string(), z.unknown()),
});
type EnvelopeT = z.infer<typeof Envelope>;

interface LogEvent {
  seq: number;
  ts: string;
  type: string;
  collection?: string;
  id?: string;
  revision?: number;
  runId?: string;
  attemptId?: string;
  startRun?: boolean;
  schema_version?: number;
  snapshot?: Obj;
  patch?: RecordPatch;
  note?: string;
  detail?: unknown;
}

export interface ReconcileReport {
  /** 由日志重建（或补写）了汇总的记录 */
  rebuilt: string[];
  /** 汇总与日志同一修订号但内容不同，已按日志改正 */
  diverged: string[];
  /** 汇总比日志新（日志缺失），已补记入日志 */
  adopted: string[];
  /** 日志末行不完整，已截断 */
  truncatedLog: boolean;
  /** 清理掉的残留临时文件 */
  removedTemp: string[];
  warnings: string[];
}

export interface OpenOptions {
  /** 数据目录所在卷的检查（生产里传 localApfsProbe；不传不检查） */
  volumeProbe?: VolumeProbe;
  /** 取不到数据目录租约时最多等多久（毫秒）；默认 0，立即报告 */
  lockWaitMs?: number;
  /** 租约视为过期的时间（毫秒，至少 5000）。进程崩溃后，别的进程要等这么久才能接手 */
  staleMs?: number;
}

const checkName = (s: string, what: string): string => {
  if (!ID_RE.test(s)) throw new Error(`非法的${what}：${s}`);
  return s;
};
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface ReplayState {
  data: Obj;
  revision: number;
  currentRunId: string | undefined;
  schema: number;
  attempts: { id: string; revision: number }[];
  ts: string;
  prev?: Omit<ReplayState, 'prev'> | undefined;
}

export class RecordStore {
  private static readonly opened = new Map<string, Promise<RecordStore>>();

  /** 打开（取得租约并对账）。同一进程里同一目录只会有一个 RecordStore：同一进程就是同一个写入者。 */
  static async open(root: string, opts: OpenOptions = {}): Promise<RecordStore> {
    await requireLocalVolume(root, opts.volumeProbe); // 先检查所在的卷，再创建任何东西
    await fs.mkdir(root, { recursive: true });
    const key = await fs.realpath(root); // 符号链接指向同一目录时也只算一个写入者
    const existing = RecordStore.opened.get(key);
    if (existing) return existing;
    const p = RecordStore.create(key, opts);
    RecordStore.opened.set(key, p);
    p.catch(() => RecordStore.opened.delete(key));
    return p;
  }

  /** 关闭本进程打开的所有记录库（释放数据目录租约）。应用退出时调用。 */
  static async closeAll(): Promise<void> {
    const all = [...RecordStore.opened.values()];
    for (const p of all) await p.then((s) => s.close()).catch(() => undefined);
  }

  private static async create(root: string, opts: OpenOptions): Promise<RecordStore> {
    const lockTarget = path.join(root, '.writer');
    await fs.appendFile(lockTarget, '');
    const store = new RecordStore(root);
    const wait = opts.lockWaitMs ?? 0;
    try {
      store.release = await lockfile.lock(lockTarget, {
        stale: Math.max(5000, opts.staleMs ?? 10_000),
        update: 2000,
        retries: wait > 0 ? { retries: Math.ceil(wait / 500), minTimeout: 500, maxTimeout: 500, factor: 1 } : 0,
        onCompromised: (err) => {
          store.compromised = err;
        },
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOCKED') throw new WriterLockedError(root, '另一个写入者持有数据目录租约');
      throw e;
    }
    try {
      store.report = await store.reconcile();
    } catch (e) {
      await store.close();
      throw e;
    }
    return store;
  }

  private release: (() => Promise<void>) | undefined;
  private compromised: Error | undefined;
  private closed = false;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** 最近一次（打开时）对账的结果 */
  report: ReconcileReport = { rebuilt: [], diverged: [], adopted: [], truncatedLog: false, removedTemp: [], warnings: [] };

  private constructor(readonly root: string) {}

  get logFile(): string {
    return path.join(this.root, 'events.jsonl');
  }
  private recordsDir(collection: string): string {
    return path.join(this.root, 'records', checkName(collection, '集合名'));
  }
  recordFile(collection: string, id: string): string {
    return path.join(this.recordsDir(collection), `${checkName(id, '记录编号')}.json`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    RecordStore.opened.delete(this.root);
    await this.release?.().catch(() => undefined);
  }

  /** 串行执行：同一个数据目录的所有写入排队（进程内互斥） */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private assertWritable(): void {
    if (this.closed) throw new WriterLockedError(this.root, '数据目录已关闭');
    if (this.compromised) throw new WriterLockedError(this.root, `租约已丢失（${this.compromised.message}）`);
  }

  // ───────────────────────── 读取 ─────────────────────────

  private async readEnvelope(file: string): Promise<EnvelopeT | null> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new CorruptRecordError(file, `JSON 解析失败：${(e as Error).message}`);
    }
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) throw new CorruptRecordError(file, '外层结构不对');
    return parsed.data;
  }

  private async readValid<T>(def: CollectionDef<T>, id: string): Promise<(Stored<T> & { env: EnvelopeT }) | null> {
    const file = this.recordFile(def.name, id);
    const env = await this.readEnvelope(file);
    if (!env) return null;
    // 先看格式版本：更高的版本拒绝读取（不当作不存在，也不覆盖）
    if (env.schema_version > def.schemaVersion) throw new UnsupportedSchemaError(file, env.schema_version, def.schemaVersion);
    let data: unknown = env.data;
    if (env.schema_version < def.schemaVersion) {
      if (!def.migrate) throw new CorruptRecordError(file, `旧版本 ${env.schema_version} 没有迁移方法`);
      data = def.migrate(env.schema_version, data);
    }
    const ok = def.schema.safeParse(data);
    if (!ok.success) throw new CorruptRecordError(file, `内容不符合格式：${ok.error.issues.map((i) => i.path.join('.') || '(根)').slice(0, 3).join('、')}`);
    return { id, value: ok.data, revision: env.revision, currentRunId: env.currentRunId, env };
  }

  repo<T>(def: CollectionDef<T>): Repository<T> {
    const strip = (s: Stored<T> & { env?: EnvelopeT }): Stored<T> => ({ id: s.id, value: s.value, revision: s.revision, currentRunId: s.currentRunId });
    const listAll = async () => {
      const items: Stored<T>[] = [];
      const problems: RecordProblem[] = [];
      let names: string[] = [];
      try {
        names = await fs.readdir(this.recordsDir(def.name));
      } catch {
        return { items, problems };
      }
      for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
        const id = n.slice(0, -5);
        try {
          const r = await this.readValid(def, id);
          if (r) items.push(strip(r));
        } catch (e) {
          problems.push({ id, error: e as Error });
        }
      }
      return { items, problems };
    };
    return {
      get: async (id) => {
        const r = await this.readValid(def, id);
        return r ? strip(r) : null;
      },
      list: async () => (await listAll()).items,
      listAll,
      commit: (id, cmd, value) => this.commit(def, id, cmd, value),
    };
  }

  // ───────────────────────── 写入 ─────────────────────────

  private async logEvent(e: Omit<LogEvent, 'seq' | 'ts'>): Promise<LogEvent> {
    const ev: LogEvent = { seq: this.seq + 1, ts: new Date().toISOString(), ...e };
    await appendLineDurable(this.logFile, JSON.stringify(ev));
    this.seq = ev.seq;
    return ev;
  }

  /** 记一条不改动记录的事件（诊断、拒绝等）。失败不抛出到调用方之外的地方：由调用方决定。 */
  appendEvent(type: string, detail?: unknown): Promise<void> {
    return this.serial(async () => {
      this.assertWritable();
      await this.logEvent({ type, ...(detail !== undefined ? { detail } : {}) });
    });
  }

  commit<T>(def: CollectionDef<T>, id: string, cmd: CommitCmd, value: T): Promise<CommitOutcome<T>> {
    return this.serial(() => this.commitLocked(def, id, cmd, value));
  }

  private async commitLocked<T>(def: CollectionDef<T>, id: string, cmd: CommitCmd, value: T): Promise<CommitOutcome<T>> {
    this.assertWritable();
    const file = this.recordFile(def.name, id);
    const cur = await this.readEnvelope(file);
    if (cur && cur.schema_version > def.schemaVersion) throw new UnsupportedSchemaError(file, cur.schema_version, def.schemaVersion);
    const curRev = cur?.revision ?? 0;
    const base = { collection: def.name, id, runId: cmd.runId, attemptId: cmd.attemptId };

    // 幂等：同一个 attemptId 已经提交过 → 返回首次的结果，不重复写、不重复触发副作用
    const dup = cur?.attempts.find((a) => a.id === cmd.attemptId);
    if (cur && dup) {
      await this.logEvent({ type: 'duplicate', ...base, revision: dup.revision });
      return { ok: true, revision: dup.revision, value: cur.data as T, duplicate: true };
    }
    // 过期的运行身份
    if (cur?.currentRunId !== undefined && !cmd.startRun && cmd.runId !== cur.currentRunId) {
      await this.logEvent({ type: 'stale_run', ...base, revision: curRev, detail: { currentRunId: cur.currentRunId } });
      return { ok: false, reason: 'stale_run', currentRunId: cur.currentRunId };
    }
    // CAS
    if (cmd.expectedRevision !== curRev) {
      await this.logEvent({ type: 'conflict', ...base, revision: curRev, detail: { expected: cmd.expectedRevision, actual: curRev } });
      return { ok: false, reason: 'conflict', expected: cmd.expectedRevision, actual: curRev };
    }

    const data = json(value) as Obj;
    const ok = def.schema.safeParse(data);
    if (!ok.success) throw new CorruptRecordError(file, `拒绝写入不符合格式的内容：${ok.error.issues.map((i) => i.path.join('.') || '(根)').slice(0, 3).join('、')}`);

    const revision = curRev + 1;
    const currentRunId = cmd.startRun ? cmd.runId : cur?.currentRunId;
    // 迁移过的旧记录按“当前格式”写回，所以事件里的快照以当前格式为准
    const prevData = cur && cur.schema_version === def.schemaVersion ? cur.data : null;
    const ev: Omit<LogEvent, 'seq' | 'ts'> = {
      type: cmd.note ?? 'commit',
      ...base,
      revision,
      schema_version: def.schemaVersion,
      ...(cmd.startRun ? { startRun: true } : {}),
      ...(prevData ? { patch: diffRecord(prevData, data) } : { snapshot: data }),
    };
    await this.logEvent(ev); // 先追加日志并落盘……
    const attempts = [...(cur?.attempts ?? []), { id: cmd.attemptId, revision }].slice(-MAX_ATTEMPTS);
    const env: EnvelopeT = { schema_version: def.schemaVersion, revision, ...(currentRunId !== undefined ? { currentRunId } : {}), updatedAt: new Date().toISOString(), attempts, data };
    try {
      await atomicWrite(file, JSON.stringify(env, null, 2));
    } catch (e) {
      // 汇总没写成（磁盘满、权限不足）：原文件保持不变；在日志里标记这次提交作废，避免重启后“复活”，然后显式报告
      await this.logEvent({ type: 'rollback', ...base, revision }).catch(() => undefined);
      throw e;
    }
    return { ok: true, revision, value: data as T, duplicate: false };
  }

  // ───────────────────────── 启动对账 ─────────────────────────

  private async readLog(): Promise<{ events: LogEvent[]; validBytes: number; truncated: boolean; badLines: number[] }> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.logFile);
    } catch {
      return { events: [], validBytes: 0, truncated: false, badLines: [] };
    }
    const lastNl = buf.lastIndexOf(0x0a);
    const validBytes = lastNl + 1;
    const truncated = validBytes < buf.length; // 最后一行没有换行：写到一半
    const text = buf.subarray(0, validBytes).toString('utf8');
    const events: LogEvent[] = [];
    const badLines: number[] = [];
    text
      .split('\n')
      .filter((l, i, a) => !(i === a.length - 1 && l === ''))
      .forEach((line, i) => {
        try {
          const e = JSON.parse(line) as LogEvent;
          if (e && typeof e === 'object' && typeof e.seq === 'number' && typeof e.type === 'string') events.push(e);
          else badLines.push(i + 1);
        } catch {
          badLines.push(i + 1);
        }
      });
    return { events, validBytes, truncated, badLines };
  }

  private replay(events: LogEvent[], warnings: string[]): Map<string, ReplayState & { collection: string; id: string }> {
    const states = new Map<string, ReplayState & { collection: string; id: string }>();
    for (const e of events) {
      if (!e.collection || !e.id) continue;
      const key = `${e.collection}/${e.id}`;
      const st = states.get(key);
      if (e.type === 'rollback') {
        if (st && st.revision === e.revision) {
          if (st.prev) states.set(key, { ...st.prev, collection: e.collection, id: e.id });
          else states.delete(key);
        }
        continue;
      }
      if (e.revision === undefined || (!e.snapshot && !e.patch)) continue; // duplicate / conflict / stale_run 等不改变记录
      if (e.type === 'duplicate' || e.type === 'conflict' || e.type === 'stale_run') continue;
      let data: Obj;
      if (e.snapshot) data = e.snapshot;
      else if (st && e.patch) data = applyPatch(st.data, e.patch);
      else {
        warnings.push(`日志里 ${key} 的修订 ${e.revision} 找不到上一版，已跳过`);
        continue;
      }
      if (st && e.revision !== st.revision + 1 && !e.snapshot) warnings.push(`日志里 ${key} 的修订号不连续（${st.revision} → ${e.revision}）`);
      const attempts = [...(st?.attempts ?? []), ...(e.attemptId ? [{ id: e.attemptId, revision: e.revision }] : [])].slice(-MAX_ATTEMPTS);
      const prevRun = st?.currentRunId;
      const { prev: _drop, ...prevBare } = st ?? ({} as ReplayState);
      void _drop;
      states.set(key, {
        collection: e.collection,
        id: e.id,
        data,
        revision: e.revision,
        currentRunId: e.startRun ? e.runId : prevRun,
        schema: e.schema_version ?? st?.schema ?? 0,
        attempts,
        ts: e.ts,
        prev: st ? (prevBare as Omit<ReplayState, 'prev'>) : undefined,
      });
    }
    return states;
  }

  /** 启动对账：截断不完整的日志末行；以日志为准补写/重建汇总；清理残留临时文件。 */
  private async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { rebuilt: [], diverged: [], adopted: [], truncatedLog: false, removedTemp: [], warnings: [] };
    const log = await this.readLog();
    if (log.truncated) {
      await truncateTo(this.logFile, log.validBytes);
      report.truncatedLog = true;
      report.warnings.push('事件日志的最后一行不完整（可能是写到一半被中断），已忽略并截断。');
    }
    for (const n of log.badLines) report.warnings.push(`事件日志第 ${n} 行无法解析，已跳过。`);
    this.seq = log.events.reduce((m, e) => Math.max(m, e.seq), 0);
    const states = this.replay(log.events, report.warnings);

    for (const [key, st] of states) {
      const file = this.recordFile(st.collection, st.id);
      let env: EnvelopeT | null = null;
      let broken = false;
      try {
        env = await this.readEnvelope(file);
      } catch {
        broken = true;
      }
      if (env && env.revision > st.revision) {
        // 汇总比日志新：日志缺失。把汇总补记进日志，不覆盖它
        await this.logEvent({ type: 'adopt', collection: st.collection, id: st.id, revision: env.revision, schema_version: env.schema_version, snapshot: env.data, ...(env.currentRunId ? { runId: env.currentRunId } : {}) });
        report.adopted.push(key);
        continue;
      }
      const needs = !env || broken || env.revision < st.revision;
      const differs = !!env && !broken && env.revision === st.revision && !sameJson(env.data, st.data);
      if (needs || differs) {
        const rebuilt: EnvelopeT = {
          schema_version: st.schema,
          revision: st.revision,
          ...(st.currentRunId !== undefined ? { currentRunId: st.currentRunId } : {}),
          updatedAt: st.ts,
          attempts: st.attempts,
          data: st.data,
        };
        await atomicWrite(file, JSON.stringify(rebuilt, null, 2));
        (differs ? report.diverged : report.rebuilt).push(key);
      }
    }

    // 汇总存在但日志里完全没有的记录：补记进日志（以后可重建）
    const recordsRoot = path.join(this.root, 'records');
    let collections: string[] = [];
    try {
      collections = (await fs.readdir(recordsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      collections = [];
    }
    for (const c of collections) {
      const dir = path.join(recordsRoot, c);
      for (const name of await fs.readdir(dir)) {
        const f = path.join(dir, name);
        if (!name.endsWith('.json')) {
          await removeFile(f); // write-file-atomic 中断后残留的临时文件（名字是 <id>.json.<数字>）
          report.removedTemp.push(name);
          continue;
        }
        const id = name.slice(0, -5);
        if (states.has(`${c}/${id}`)) continue;
        try {
          const env = await this.readEnvelope(f);
          if (env) {
            await this.logEvent({ type: 'adopt', collection: c, id, revision: env.revision, schema_version: env.schema_version, snapshot: env.data, ...(env.currentRunId ? { runId: env.currentRunId } : {}) });
            report.adopted.push(`${c}/${id}`);
          }
        } catch {
          report.warnings.push(`记录 ${c}/${id} 无法解析，日志里也没有它，需要人工查看。`);
        }
      }
    }
    if (report.rebuilt.length || report.diverged.length || report.adopted.length || report.truncatedLog || report.removedTemp.length) {
      await this.logEvent({ type: 'reconcile', detail: { rebuilt: report.rebuilt, diverged: report.diverged, adopted: report.adopted, truncatedLog: report.truncatedLog, removedTemp: report.removedTemp } });
    }
    return report;
  }

  /** 从日志重放得到各记录的最新内容（测试与核对用，不写任何文件） */
  async replayAll(): Promise<Map<string, { data: Obj; revision: number; currentRunId?: string | undefined }>> {
    const log = await this.readLog();
    const out = new Map<string, { data: Obj; revision: number; currentRunId?: string | undefined }>();
    for (const [k, s] of this.replay(log.events, [])) out.set(k, { data: s.data, revision: s.revision, currentRunId: s.currentRunId });
    return out;
  }

  /** 读出全部事件（测试与核对用） */
  async events(): Promise<LogEvent[]> {
    return (await this.readLog()).events;
  }

  /** 新的运行编号 */
  static newRunId(): string {
    return `run-${crypto.randomUUID()}`;
  }
  static newAttemptId(): string {
    return `att-${crypto.randomUUID()}`;
  }
}
