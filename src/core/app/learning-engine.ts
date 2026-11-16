import fs from 'node:fs';
import path from 'node:path';

export interface ProjectLearning {
  id: string;
  timestamp: string;
  taskTitle: string;
  trigger: string;
  rule: string;
  source: 'auto_reflection' | 'user_feedback' | 'system';
}

/**
 * 经验反思知识库 (RSI Learning Engine)
 * 记录工程避坑经验，并在后续讨论与开工时自动注入上下文。
 */
export class LearningEngine {
  private getStoragePath(projectFolder: string): string {
    const studioDir = path.join(projectFolder, '.studio');
    if (!fs.existsSync(studioDir)) {
      fs.mkdirSync(studioDir, { recursive: true });
    }
    return path.join(studioDir, 'learnings.json');
  }

  getLearnings(projectFolder: string): ProjectLearning[] {
    try {
      const filePath = this.getStoragePath(projectFolder);
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  recordLearning(
    projectFolder: string,
    learning: { trigger: string; taskTitle: string; rule: string; source?: ProjectLearning['source'] }
  ): { success: boolean; data?: ProjectLearning } {
    try {
      const learnings = this.getLearnings(projectFolder);
      const newEntry: ProjectLearning = {
        id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        taskTitle: learning.taskTitle,
        trigger: learning.trigger,
        rule: learning.rule,
        source: learning.source || 'auto_reflection',
      };
      learnings.unshift(newEntry);
      const filePath = this.getStoragePath(projectFolder);
      fs.writeFileSync(filePath, JSON.stringify(learnings.slice(0, 50), null, 2), 'utf8');
      return { success: true, data: newEntry };
    } catch {
      return { success: false };
    }
  }

  formatLearningsForPrompt(projectFolder: string, limit = 5): string {
    const learnings = this.getLearnings(projectFolder).slice(0, limit);
    if (learnings.length === 0) return '';
    const lines = learnings.map((l, i) => `${i + 1}. 【${l.taskTitle}】${l.rule}`);
    return `\n【工程历史避坑经验库 (前车之鉴)】：\n${lines.join('\n')}\n请在规划和实现时严格避开以上踩坑点。\n`;
  }
}

export const learningEngine = new LearningEngine();
