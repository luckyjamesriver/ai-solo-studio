export interface ProjectLearning {
  id: string;
  timestamp: string;
  taskTitle: string;
  trigger: string;
  rule: string;
  origin?: 'auto_reflection' | 'user_feedback' | 'system';
}

/**
 * 经验反思知识库 (RSI Learning Engine)
 * 记录工程避坑经验，并在后续讨论与开工时自动注入上下文。
 */
export class LearningEngine {
  private memoryCache = new Map<string, ProjectLearning[]>();

  getLearnings(projectFolder: string): ProjectLearning[] {
    return this.memoryCache.get(projectFolder) ?? [];
  }

  recordLearning(
    projectFolder: string,
    learning: { trigger: string; taskTitle: string; rule: string; origin?: 'auto_reflection' | 'user_feedback' | 'system' }
  ): { success: boolean; data?: ProjectLearning } {
    try {
      const learnings = [...this.getLearnings(projectFolder)];
      const newEntry: ProjectLearning = {
        id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        taskTitle: learning.taskTitle,
        trigger: learning.trigger,
        rule: learning.rule,
        origin: learning.origin ?? 'auto_reflection',
      };
      learnings.unshift(newEntry);
      this.memoryCache.set(projectFolder, learnings.slice(0, 50));
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
