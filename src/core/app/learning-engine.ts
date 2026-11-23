import {
  defaultLearningStore,
  LearningStore,
  type ProjectLearning,
  type RecordLearningInput,
  type RecordLearningResult,
} from '../persistence/learning.js';

export type { ProjectLearning, RecordLearningInput, RecordLearningResult };

/**
 * 交付状态标记（维护者审查约定）：
 * 本能力底层已完成符合 ADR 0005/0006 规范的磁盘持久化、崩溃隔离与重启恢复支持；
 * 但目前尚未正式接入 App 业务主闭环（如自动反馈注入与开工编排），在此明确标记为实验性/未交付状态，
 * 不夸大为已完成的生产知识库。
 */
export const LEARNING_ENGINE_DELIVERY_STATUS = 'experimental_unintegrated' as const;

/**
 * 经验反思知识库 (RSI Learning Engine)
 * 记录工程避坑经验，支持跨进程重启的真实持久化。
 */
export class LearningEngine {
  constructor(private readonly store: LearningStore = defaultLearningStore) {}

  getLearnings(projectFolder: string): ProjectLearning[] {
    return this.store.getLearnings(projectFolder);
  }

  recordLearning(projectFolder: string, learning: RecordLearningInput): RecordLearningResult {
    return this.store.recordLearning(projectFolder, learning);
  }

  formatLearningsForPrompt(projectFolder: string, limit = 5): string {
    const learnings = this.getLearnings(projectFolder).slice(0, limit);
    if (learnings.length === 0) return '';
    const lines = learnings.map((l, i) => `${i + 1}. 【${l.taskTitle}】${l.rule}`);
    return `\n【工程历史避坑经验库 (前车之鉴)】：\n${lines.join('\n')}\n请在规划和实现时严格避开以上踩坑点。\n`;
  }
}

export const learningEngine = new LearningEngine();
