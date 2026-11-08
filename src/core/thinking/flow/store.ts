import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord, ThreadRecord } from './types.js';
import { atomicWrite, atomicWriteExclusive } from '../../persistence/files.js';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** 恢复时发现正式产物文件与记录不一致：必须停止并报告，不得误用旧产物。 */
export class ArtifactMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactMismatchError';
  }
}

/** 原子写与“原子且不覆盖”写：统一由持久化层的原语提供（write-file-atomic），这里只是转出，保持原有的引用路径。 */
export { atomicWrite, atomicWriteExclusive };

/** 线程目录：<项目>/.studio/threads/<线程编号>/（不入库）。 */
export class ThreadStore {
  constructor(readonly projectRoot: string) {}

  threadsDir() {
    return path.join(this.projectRoot, '.studio', 'threads');
  }
  dir(id: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`非法线程编号：${id}`);
    return path.join(this.threadsDir(), id);
  }

  async save(rec: ThreadRecord): Promise<void> {
    rec.updatedAt = new Date().toISOString();
    await atomicWrite(path.join(this.dir(rec.id), 'thread.json'), JSON.stringify(rec, null, 2) + '\n');
  }

  async load(id: string): Promise<ThreadRecord> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir(id), 'thread.json'), 'utf8');
    } catch {
      throw new Error(`找不到线程 ${id}`);
    }
    const rec = JSON.parse(text) as ThreadRecord;
    if (rec.schema !== 1) throw new Error(`线程记录版本不受支持：${String(rec.schema)}`);
    return rec;
  }

  async list(): Promise<string[]> {
    try {
      return (await fs.readdir(this.threadsDir(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** 写入一个新版本的正式产物（JSON），返回记录。版本号 = 该名称已有版本数 + 1。 */
  async writeArtifact(rec: ThreadRecord, name: string, body: unknown, fromAttempt?: ArtifactRecord['fromAttempt']): Promise<ArtifactRecord> {
    const version = rec.artifacts.filter((a) => a.name === name).length + 1;
    const file = path.join('artifacts', `${name}.v${version}.json`);
    const text = JSON.stringify({ name, version, body }, null, 2) + '\n';
    await atomicWrite(path.join(this.dir(rec.id), file), text);
    const art: ArtifactRecord = { name, version, file, sha256: sha256(text), createdAt: new Date().toISOString(), ...(fromAttempt ? { fromAttempt } : {}) };
    rec.artifacts.push(art);
    return art;
  }

  latest(rec: ThreadRecord, name: string): ArtifactRecord | undefined {
    return rec.artifacts.filter((a) => a.name === name).at(-1);
  }

  /** 读取产物并校验摘要与版本；不一致 → ArtifactMismatchError。 */
  async readArtifact<T = unknown>(rec: ThreadRecord, art: ArtifactRecord): Promise<T> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir(rec.id), art.file), 'utf8');
    } catch {
      throw new ArtifactMismatchError(`正式产物缺失：${art.name} v${art.version}（${art.file}）`);
    }
    if (sha256(text) !== art.sha256) throw new ArtifactMismatchError(`正式产物与记录的摘要不一致：${art.name} v${art.version}（${art.file}）——文件可能被改动，已停止，不使用该产物`);
    const parsed = JSON.parse(text) as { name?: string; version?: number; body: T };
    if (parsed.name !== art.name || parsed.version !== art.version) throw new ArtifactMismatchError(`正式产物的名称/版本与记录不一致：${art.name} v${art.version}`);
    return parsed.body;
  }

  /** 校验线程内所有正式产物（恢复时调用）。 */
  async verifyAll(rec: ThreadRecord): Promise<void> {
    for (const a of rec.artifacts) await this.readArtifact(rec, a);
  }
}
