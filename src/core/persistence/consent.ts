import path from 'node:path';
import { z } from 'zod';
import { ensureStudioIgnored } from '../git/git.js';
import { StateConflictError, StaleRunError } from './errors.js';
import { migrateLegacyFiles } from './legacy.js';
import { RecordStore, type CollectionDef, type CommitCmd, type CommitOutcome, type OpenOptions, type Stored } from './store.js';
import { updateRecord } from './update.js';

/**
 * 资料外发确认记录（ADR 0005）：记录库里的 `consent` 集合——`<项目>/.studio/records/consent/consent.json`，
 * 事件日志写入 `<项目>/.studio/events.jsonl`。读写带修订号做 CAS 校验，写入 JSONL 事件日志，接入启动对账。
 * 旧版本的 `.studio/consent.json` 在第一次打开时自动迁移至记录库并重命名为 `.studio/consent.json.migrated`。
 */

export type ConsentRecord = Record<string, { confirmedAt: string }>;

const ConsentSchema = z.record(
  z.string(),
  z.looseObject({
    confirmedAt: z.string(),
  }),
) as unknown as z.ZodType<ConsentRecord>;

export const CONSENT_COLLECTION: CollectionDef<ConsentRecord> = {
  name: 'consent',
  schemaVersion: 1,
  schema: ConsentSchema,
};

export const CONSENT_RECORD_ID = 'consent';

export class ConsentStore {
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
    const file = path.join(this.projectRoot, '.studio', 'consent.json');
    await migrateLegacyFiles(store, CONSENT_COLLECTION, [{ file, id: CONSENT_RECORD_ID }], (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return ConsentSchema.safeParse(raw).success ? (raw as ConsentRecord) : null;
    });
  }

  async get(): Promise<Stored<ConsentRecord> | null> {
    const store = await this.recordStore();
    return store.repo(CONSENT_COLLECTION).get(CONSENT_RECORD_ID);
  }

  async has(service: string): Promise<boolean> {
    const r = await this.get();
    return r ? service in r.value : false;
  }

  async record(service: string, opts: { runId?: string; attemptId?: string; expectedRevision?: number } = {}): Promise<void> {
    const store = await this.recordStore();
    if (opts.expectedRevision !== undefined) {
      const cur = (await this.get())?.value ?? {};
      const next: ConsentRecord = { ...cur, [service]: { confirmedAt: new Date().toISOString() } };
      const outcome = await store.commit(
        CONSENT_COLLECTION,
        CONSENT_RECORD_ID,
        {
          runId: opts.runId ?? 'consent',
          attemptId: opts.attemptId ?? RecordStore.newAttemptId(),
          expectedRevision: opts.expectedRevision,
          note: 'consent',
        },
        next,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') {
          throw new StateConflictError(CONSENT_COLLECTION.name, CONSENT_RECORD_ID, outcome.expected, outcome.actual);
        }
        throw new StaleRunError(CONSENT_COLLECTION.name, CONSENT_RECORD_ID, opts.runId ?? 'consent', outcome.currentRunId);
      }
      return;
    }
    await updateRecord(
      store,
      CONSENT_COLLECTION,
      CONSENT_RECORD_ID,
      {},
      (cur) => ({ ...cur, [service]: { confirmedAt: new Date().toISOString() } }),
      { runId: opts.runId ?? 'consent', note: 'consent' },
    );
  }

  async clear(): Promise<void> {
    const store = await this.recordStore();
    await updateRecord(
      store,
      CONSENT_COLLECTION,
      CONSENT_RECORD_ID,
      {},
      () => ({}),
      { runId: 'consent', note: 'clear' },
    );
  }

  async commit(cmd: CommitCmd, value: ConsentRecord): Promise<CommitOutcome<ConsentRecord>> {
    const store = await this.recordStore();
    return store.commit(CONSENT_COLLECTION, CONSENT_RECORD_ID, cmd, value);
  }
}
