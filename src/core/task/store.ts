import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Task } from './model.js';

/** 任务以 JSON 存放在 <项目>/.studio/tasks/，与项目放在一起，便于迁移。 */
export class TaskStore {
  constructor(private readonly repo: string) {}

  private dir() {
    return path.join(this.repo, '.studio', 'tasks');
  }

  static newId(): string {
    const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `${t}-${crypto.randomBytes(3).toString('hex')}`;
  }

  async save(task: Task): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    task.updatedAt = new Date().toISOString();
    const file = path.join(this.dir(), `${task.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(task, null, 2));
    await fs.rename(tmp, file); // 原子写入
  }

  async get(id: string): Promise<Task | null> {
    if (!/^[a-z0-9-]+$/.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(), `${id}.json`), 'utf8')) as Task;
    } catch {
      return null;
    }
  }

  async list(): Promise<Task[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const tasks = await Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.replace(/\.json$/, ''))),
    );
    return tasks.filter((t): t is Task => !!t).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
