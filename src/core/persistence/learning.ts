import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

export interface ProjectLearning {
  id: string;
  timestamp: string;
  taskTitle: string;
  trigger: string;
  rule: string;
  origin?: 'auto_reflection' | 'user_feedback' | 'system';
}

export interface RecordLearningInput {
  taskTitle: string;
  trigger: string;
  rule: string;
  origin?: 'auto_reflection' | 'user_feedback' | 'system';
  /** 兼容历史字段 */
  source?: 'auto_reflection' | 'user_feedback' | 'system';
}

export interface RecordLearningResult {
  success: boolean;
  data?: ProjectLearning;
  error?: string;
}

/**
 * 持久化学习经验存储服务（遵循 ADR 0005 / ADR 0006 分层架构）
 * 存储路径位于 `<项目目录>/.studio/learnings.json`。
 * 所有落盘写入经由原子写原语（writeFileAtomic），避免写入中断导致文件损坏。
 */
export class LearningStore {
  getStoragePath(projectFolder: string): string {
    return path.join(projectFolder, '.studio', 'learnings.json');
  }

  getLearnings(projectFolder: string): ProjectLearning[] {
    const filePath = this.getStoragePath(projectFolder);
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      // 字段校验与兼容性清洗
      const valid: ProjectLearning[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const taskTitle = typeof item.taskTitle === 'string' ? item.taskTitle : '';
        const trigger = typeof item.trigger === 'string' ? item.trigger : '';
        const rule = typeof item.rule === 'string' ? item.rule : '';
        if (!rule) continue;

        const origin = item.origin ?? item.source ?? 'auto_reflection';
        valid.push({
          id: typeof item.id === 'string' ? item.id : `learn-migrated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: typeof item.timestamp === 'string' ? item.timestamp : new Date().toISOString(),
          taskTitle,
          trigger,
          rule,
          origin,
        });
      }
      return valid;
    } catch {
      // 容错处理：面对文件异常或损坏时返回空记录，不向调用方抛出未捕获异常
      return [];
    }
  }

  saveLearnings(projectFolder: string, learnings: ProjectLearning[]): { success: boolean; error?: string } {
    try {
      const studioDir = path.join(projectFolder, '.studio');
      if (!fs.existsSync(studioDir)) {
        fs.mkdirSync(studioDir, { recursive: true });
      }
      const filePath = this.getStoragePath(projectFolder);
      const capped = learnings.slice(0, 50);
      writeFileAtomic.sync(filePath, JSON.stringify(capped, null, 2), { encoding: 'utf8' });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  recordLearning(projectFolder: string, input: RecordLearningInput): RecordLearningResult {
    try {
      const current = this.getLearnings(projectFolder);
      const newEntry: ProjectLearning = {
        id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        taskTitle: input.taskTitle,
        trigger: input.trigger,
        rule: input.rule,
        origin: input.origin ?? input.source ?? 'auto_reflection',
      };
      const updated = [newEntry, ...current];
      const saveRes = this.saveLearnings(projectFolder, updated);
      if (!saveRes.success) {
        return { success: false, error: saveRes.error };
      }
      return { success: true, data: newEntry };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const defaultLearningStore = new LearningStore();
