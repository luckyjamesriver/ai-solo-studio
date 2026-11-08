import { updateRecord, type OpenOptions } from '../persistence/index.js';
import { APP_COLLECTION, AppStore } from './app-store.js';

export type ModePreference = 'standard' | 'full_trust';

const ID = 'task-prefs';
type Projects = Record<string, { lastMode: ModePreference }>;

/**
 * 项目级偏好：只记“上次选了哪种模式”，用来预选。
 * **偏好永远不能代替确认**：选了完全信任的项目下次只是预选，每个任务开工前仍必须重新确认。
 * 存储：userData 记录库里的 `app/task-prefs`（经持久化服务提交，原子写 + CAS）。
 */
export class TaskPrefs {
  private readonly app: AppStore;
  constructor(dataDir: string, storeOpts: OpenOptions = {}) {
    this.app = new AppStore(dataDir, storeOpts);
  }
  async getMode(project: string): Promise<ModePreference> {
    const v = (await this.app.read(ID)) as { projects?: Projects } | null;
    return v?.projects?.[project]?.lastMode === 'full_trust' ? 'full_trust' : 'standard';
  }
  async setMode(project: string, mode: ModePreference): Promise<void> {
    await updateRecord(await this.app.store(), APP_COLLECTION, ID, {}, (cur) => ({ projects: { ...((cur as { projects?: Projects }).projects ?? {}), [project]: { lastMode: mode } } }));
  }
}
