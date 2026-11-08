import fs from 'node:fs/promises';
import path from 'node:path';

export type ModePreference = 'standard' | 'full_trust';

/**
 * 项目级偏好：只记“上次选了哪种模式”，用来预选。
 * **偏好永远不能代替确认**：选了完全信任的项目下次只是预选，每个任务开工前仍必须重新确认。
 */
export class TaskPrefs {
  constructor(private readonly dataDir: string) {}
  private file() {
    return path.join(this.dataDir, 'task-prefs.json');
  }
  private async read(): Promise<Record<string, { lastMode: ModePreference }>> {
    try {
      const v = JSON.parse(await fs.readFile(this.file(), 'utf8')) as { projects?: Record<string, { lastMode: ModePreference }> };
      return v.projects ?? {};
    } catch {
      return {};
    }
  }
  async getMode(project: string): Promise<ModePreference> {
    return (await this.read())[project]?.lastMode === 'full_trust' ? 'full_trust' : 'standard';
  }
  async setMode(project: string, mode: ModePreference): Promise<void> {
    const all = await this.read();
    all[project] = { lastMode: mode };
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.file(), JSON.stringify({ projects: all }, null, 2));
  }
}
