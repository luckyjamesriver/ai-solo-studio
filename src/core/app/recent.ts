import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateRecord, type OpenOptions } from '../persistence/index.js';
import { APP_COLLECTION, AppStore } from './app-store.js';
import { validateProjectPath, type ProjectPathOptions } from '../env/project-path.js';

/**
 * 最近项目列表：保存在应用数据目录（由主进程传入），只存路径与上次打开时间。
 * 渲染进程只能按条目编号（id）打开，不能传路径。打开前重新校验路径。
 */
export interface RecentEntry {
  id: string;
  path: string;
  lastOpened: string;
}

export interface RecentView extends RecentEntry {
  name: string;
  /** 路径当前是否仍然有效（存在且是目录） */
  exists: boolean;
}

const ID = 'recent-projects';
const MAX = 10;

const normalize = (raw: { entries?: unknown } | null): RecentEntry[] => {
  if (!raw || !Array.isArray(raw.entries)) return [];
  return raw.entries.filter(
    (e): e is RecentEntry => !!e && typeof e === 'object' && typeof (e as RecentEntry).id === 'string' && typeof (e as RecentEntry).path === 'string' && typeof (e as RecentEntry).lastOpened === 'string',
  );
};

export class RecentProjects {
  private readonly app: AppStore;
  constructor(private readonly dir: string, private readonly pathOpts: ProjectPathOptions = {}, storeOpts: OpenOptions = {}) {
    this.app = new AppStore(dir, storeOpts);
  }

  private async read(): Promise<RecentEntry[]> {
    return normalize(await this.app.read(ID));
  }

  private async write(change: (cur: RecentEntry[]) => RecentEntry[]): Promise<void> {
    await updateRecord(await this.app.store(), APP_COLLECTION, ID, { version: 1, entries: [] }, (cur) => ({ version: 1, entries: change(normalize(cur)) }));
  }

  /** 记录一次打开（路径应已通过 validateProjectPath）。已有同一路径则更新时间并置顶。 */
  async record(projectPath: string, now: Date = new Date()): Promise<RecentEntry> {
    let entry!: RecentEntry;
    await this.write((all) => {
      const prev = all.find((e) => e.path === projectPath);
      entry = { id: prev?.id ?? randomUUID(), path: projectPath, lastOpened: now.toISOString() };
      return [entry, ...all.filter((e) => e.path !== projectPath)].slice(0, MAX);
    });
    return entry;
  }

  async list(): Promise<RecentView[]> {
    const all = await this.read();
    return Promise.all(
      all.map(async (e) => ({ ...e, name: path.basename(e.path), exists: (await validateProjectPath(e.path, this.pathOpts)).ok })),
    );
  }

  /** 按编号取出并重新校验路径。编号不存在或路径已失效都返回原因，不抛错。 */
  async resolve(id: unknown): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    if (typeof id !== 'string') return { ok: false, reason: '无效的项目编号。' };
    const e = (await this.read()).find((x) => x.id === id);
    if (!e) return { ok: false, reason: '最近项目列表里没有这一项。' };
    const v = await validateProjectPath(e.path, this.pathOpts);
    return v.ok ? v : { ok: false, reason: v.reason };
  }

  async forget(id: string): Promise<void> {
    await this.write((all) => all.filter((e) => e.id !== id));
  }
}
