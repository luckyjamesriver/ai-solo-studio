import path from 'node:path';
import { z } from 'zod';
import { CorruptRecordError, migrateLegacyFiles, RecordStore, type CollectionDef, type OpenOptions } from '../persistence/index.js';

/**
 * 应用级小记录（最近项目、外发告知确认、任务偏好）的存储：userData 下的记录库，集合 `app`，一条记录一个 id。
 * 全部经持久化服务提交（CAS、事件日志）；旧版本的单文件（recent-projects.json 等）第一次打开时迁移。
 */
export type AppRecord = Record<string, unknown>;

export const APP_COLLECTION: CollectionDef<AppRecord> = { name: 'app', schemaVersion: 1, schema: z.record(z.string(), z.unknown()) as unknown as z.ZodType<AppRecord> };

/** 旧文件名 → 记录编号 */
const LEGACY: Record<string, string> = { 'recent-projects': 'recent-projects.json', disclosure: 'disclosure.json', 'task-prefs': 'task-prefs.json' };

export class AppStore {
  private storeP: Promise<RecordStore> | undefined;
  constructor(readonly dir: string, private readonly opts: OpenOptions = {}) {}

  store(): Promise<RecordStore> {
    this.storeP ??= (async () => {
      const store = await RecordStore.open(this.dir, this.opts);
      const files = Object.entries(LEGACY).map(([id, name]) => ({ id, file: path.join(this.dir, name) }));
      await migrateLegacyFiles(store, APP_COLLECTION, files, (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AppRecord) : null));
      return store;
    })();
    return this.storeP;
  }

  /**
   * 读取一条记录。内容损坏（解析失败、结构不对）按“没有这条记录”处理并写入诊断事件，界面照常工作；
   * 格式版本比本应用新（UnsupportedSchemaError）则照常抛出，提示升级，不当作不存在。
   */
  async read(id: string): Promise<AppRecord | null> {
    const store = await this.store();
    try {
      return (await store.repo(APP_COLLECTION).get(id))?.value ?? null;
    } catch (e) {
      if (!(e instanceof CorruptRecordError)) throw e;
      await store.appendEvent('diagnostic', { what: `应用记录 ${id} 无法读取，已按“没有”处理`, raw: e.message }).catch(() => undefined);
      return null;
    }
  }
}
