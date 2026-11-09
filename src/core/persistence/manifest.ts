import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ensureStudioIgnored } from '../git/git.js';
import { StateConflictError, StaleRunError } from './errors.js';
import { migrateLegacyFiles } from './legacy.js';
import { RecordStore, type CollectionDef, type CommitCmd, type CommitOutcome, type OpenOptions, type Repository } from './store.js';

/**
 * 任务清单（交接清单）的存储（ADR 0005）：记录库里的 `manifests` 集合——`<项目>/.studio/records/manifests/<taskId>.json`，
 * 事件日志写入 `<项目>/.studio/events.jsonl`。读写带修订号做 CAS 校验，写入 JSONL 事件日志，接入启动对账。
 * 旧版本的 `.studio/tasks/<taskId>.json` 在第一次打开时自动迁移至记录库并重命名为 `.migrated`。
 */

export interface TaskManifest {
  schema: 1;
  taskId: string;
  threadId: string;
  repoRoot: string;
  branch: string;
  worktreePath: string;
  startHead: string;
  plan: { path: string; sha256: string; artifactVersion: number };
  singleThinker: boolean;
  exportedAt: string;
  taskFile: { path: string; sha256: string };
  revision?: number;
  runId?: string;
}

const ManifestSchema = z.looseObject({
  schema: z.literal(1),
  taskId: z.string(),
  threadId: z.string(),
  repoRoot: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  startHead: z.string(),
  plan: z.looseObject({
    path: z.string(),
    sha256: z.string(),
    artifactVersion: z.number(),
  }),
  singleThinker: z.boolean(),
  exportedAt: z.string(),
  taskFile: z.looseObject({
    path: z.string(),
    sha256: z.string(),
  }),
}) as unknown as z.ZodType<TaskManifest>;

export const MANIFEST_COLLECTION: CollectionDef<TaskManifest> = {
  name: 'manifests',
  schemaVersion: 1,
  schema: ManifestSchema,
};

export interface SaveManifestOptions {
  attemptId?: string;
  runId?: string;
  expectedRevision?: number;
  startRun?: boolean;
  note?: string;
}

export class ManifestStore {
  private storeP: Promise<RecordStore> | undefined;

  constructor(private readonly projectRoot: string, private readonly opts: OpenOptions = {}) {}

  recordStore(): Promise<RecordStore> {
    this.storeP ??= (async () => {
      await ensureStudioIgnored(this.projectRoot).catch(() => undefined);
      const store = await RecordStore.open(path.join(this.projectRoot, '.studio'), this.opts);
      await this.migrateLegacy(store);
      return store;
    })();
    return this.storeP;
  }

  private async migrateLegacy(store: RecordStore): Promise<void> {
    const dir = path.join(this.projectRoot, '.studio', 'tasks');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const files = names
      .filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(n))
      .map((n) => ({ file: path.join(dir, n), id: n.slice(0, -5) }));
    if (!files.length) return;
    await migrateLegacyFiles(store, MANIFEST_COLLECTION, files, (raw, id) => {
      const m = raw as Partial<TaskManifest> | null;
      if (!m || typeof m !== 'object' || m.schema !== 1 || m.taskId !== id) return null;
      return ManifestSchema.safeParse(m).success ? (m as TaskManifest) : null;
    });
  }

  private async repository(): Promise<Repository<TaskManifest>> {
    return (await this.recordStore()).repo(MANIFEST_COLLECTION);
  }

  recordFile(taskId: string): string {
    return path.join(this.projectRoot, '.studio', 'records', MANIFEST_COLLECTION.name, `${taskId}.json`);
  }

  async get(taskId: string): Promise<TaskManifest | null> {
    const repo = await this.repository();
    const s = await repo.get(taskId);
    if (s) {
      return { ...s.value, revision: s.revision, ...(s.currentRunId !== undefined ? { runId: s.currentRunId } : {}) };
    }
    // Also check legacy path if not yet migrated (e.g. newly created in test without migrate)
    const legacyPath = path.join(this.projectRoot, '.studio', 'tasks', `${taskId}.json`);
    try {
      const text = await fs.readFile(legacyPath, 'utf8');
      const raw = JSON.parse(text) as Partial<TaskManifest>;
      if (raw && typeof raw === 'object' && raw.schema === 1 && raw.taskId === taskId) {
        const store = await this.recordStore();
        await this.migrateLegacy(store);
        const migrated = await repo.get(taskId);
        if (migrated) {
          return { ...migrated.value, revision: migrated.revision, ...(migrated.currentRunId !== undefined ? { runId: migrated.currentRunId } : {}) };
        }
      }
    } catch {}
    return null;
  }

  async list(): Promise<TaskManifest[]> {
    const repo = await this.repository();
    const items = await repo.list();
    return items.map((s) => ({ ...s.value, revision: s.revision, ...(s.currentRunId !== undefined ? { runId: s.currentRunId } : {}) }));
  }

  async save(manifest: TaskManifest, opts: SaveManifestOptions = {}): Promise<void> {
    const repo = await this.repository();
    const { revision, runId, ...data } = manifest;
    const r = await repo.commit(
      manifest.taskId,
      {
        runId: opts.runId ?? runId ?? 'manifest',
        attemptId: opts.attemptId ?? RecordStore.newAttemptId(),
        expectedRevision: opts.expectedRevision ?? revision ?? 0,
        ...(opts.startRun ? { startRun: true } : {}),
        ...(opts.note ? { note: opts.note } : { note: 'manifest_export' }),
      },
      data as TaskManifest,
    );
    if (!r.ok) {
      if (r.reason === 'conflict') {
        throw new StateConflictError(MANIFEST_COLLECTION.name, manifest.taskId, r.expected, r.actual);
      }
      throw new StaleRunError(MANIFEST_COLLECTION.name, manifest.taskId, opts.runId ?? runId ?? 'manifest', r.currentRunId);
    }
    manifest.revision = r.revision;
    if (opts.startRun && opts.runId) manifest.runId = opts.runId;
  }

  async commit(id: string, cmd: CommitCmd, value: TaskManifest): Promise<CommitOutcome<TaskManifest>> {
    const store = await this.recordStore();
    return store.commit(MANIFEST_COLLECTION, id, cmd, value);
  }
}
