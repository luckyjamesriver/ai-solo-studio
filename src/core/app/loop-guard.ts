/**
 * 长程任务防死循环熔断机制 (LoopGuard)
 * 监控每个任务步骤的连续失败次数，达到阈值时自动熔断并向老板发起裁决请求，防止 Token 消耗与代码污染。
 */

export interface LoopGuardEvaluation {
  taskId: string;
  retries: number;
  circuitBroken: boolean;
  reason?: string;
}

export class LoopGuard {
  private taskRetries = new Map<string, number>();
  private readonly maxRetries: number;

  constructor(maxRetries = 3) {
    this.maxRetries = maxRetries;
  }

  evaluateTaskStep(taskId: string, taskTitle: string, passed: boolean): LoopGuardEvaluation {
    if (passed) {
      this.taskRetries.delete(taskId);
      return { taskId, retries: 0, circuitBroken: false };
    }

    const current = (this.taskRetries.get(taskId) ?? 0) + 1;
    this.taskRetries.set(taskId, current);

    if (current >= this.maxRetries) {
      return {
        taskId,
        retries: current,
        circuitBroken: true,
        reason: `任务「${taskTitle}」连续 ${current} 次未能产生通过验收的代码产物。为保护工程质量并避免无效重试，防死循环熔断已触发。`,
      };
    }

    return {
      taskId,
      retries: current,
      circuitBroken: false,
    };
  }

  resetTask(taskId: string) {
    this.taskRetries.delete(taskId);
  }
}

export const loopGuard = new LoopGuard();
