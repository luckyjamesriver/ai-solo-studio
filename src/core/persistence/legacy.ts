import fs from 'node:fs/promises';
import path from 'node:path';
import { renameFile } from './files.js';
import { RecordStore, type CollectionDef } from './store.js';

/**
 * 旧版本的“一个文件一条记录”迁移到记录库：对每个旧文件，内容认得出（accepts 返回转换后的记录）且记录库里还没有，
 * 就作为新记录提交（日志里记 migrated），然后把旧文件改名为 <名字>.migrated（保留，不删除）。
 * 认不出的文件（例如交接清单）原样留着；解析不了的文件留着并返回提示。
 */
export async function migrateLegacyFiles<T>(
  store: RecordStore,
  def: CollectionDef<T>,
  files: { file: string; id: string }[],
  accepts: (raw: unknown, id: string) => T | null,
): Promise<{ migrated: string[]; skipped: string[] }> {
  const repo = store.repo(def);
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const { file, id } of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      skipped.push(path.basename(file));
      continue;
    }
    const value = accepts(raw, id);
    if (value === null) continue;
    if (!(await repo.get(id).catch(() => ({ id })))) {
      const r = await repo.commit(id, { runId: 'migration', attemptId: RecordStore.newAttemptId(), expectedRevision: 0, note: 'migrated' }, value);
      if (!r.ok) {
        skipped.push(path.basename(file));
        continue;
      }
    }
    await renameFile(file, `${file}.migrated`);
    migrated.push(id);
  }
  return { migrated, skipped };
}
