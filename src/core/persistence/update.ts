import { StaleRunError, StateConflictError } from './errors.js';
import { RecordStore, type CollectionDef } from './store.js';

/**
 * 读 → 改 → 提交（带 CAS）。冲突时重新读取最新记录、对最新记录重新计算改动再提交（最多 retries 次）——
 * 这不是“静默覆盖”：每次提交都基于刚读到的修订号；超过次数仍冲突则抛出 StateConflictError。
 * 用于应用级的小记录（最近项目、偏好、外发确认等），它们没有 runId 概念，统一用 runId='app'。
 */
export async function updateRecord<T>(
  store: RecordStore,
  def: CollectionDef<T>,
  id: string,
  empty: T,
  mutate: (cur: T) => T,
  opts: { runId?: string; retries?: number; note?: string } = {},
): Promise<T> {
  const repo = store.repo(def);
  const retries = opts.retries ?? 5;
  let last: StateConflictError | undefined;
  for (let i = 0; i <= retries; i++) {
    const cur = await repo.get(id);
    const next = mutate(cur ? cur.value : empty);
    const r = await repo.commit(id, { runId: opts.runId ?? 'app', attemptId: RecordStore.newAttemptId(), expectedRevision: cur?.revision ?? 0, ...(opts.note ? { note: opts.note } : {}) }, next);
    if (r.ok) return r.value;
    if (r.reason === 'stale_run') throw new StaleRunError(def.name, id, opts.runId ?? 'app', r.currentRunId);
    last = new StateConflictError(def.name, id, r.expected, r.actual);
  }
  throw last!;
}
