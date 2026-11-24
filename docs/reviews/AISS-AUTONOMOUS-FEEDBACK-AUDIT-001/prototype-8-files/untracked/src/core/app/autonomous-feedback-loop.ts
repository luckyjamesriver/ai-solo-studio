import { loopGuard, type LoopGuard } from './loop-guard.js';
import type { Thinker, ThinkRequest, OutputSchema } from '../thinking/types.js';
import type { Task, StoredCheckProof } from '../task/model.js';
import type { TaskView } from './task-view.js';

export type FeedbackLoopMode = 'semi-auto' | 'autonomous';

export interface FeedbackLoopOptions {
  thinker: Thinker;
  taskController: {
    load(id: string): Promise<Task>;
    reworkTask(id: unknown, feedback: unknown): Promise<TaskView>;
  };
  guard?: LoopGuard;
  mode?: FeedbackLoopMode;
  maxRetries?: number;
}

export interface FeedbackDiagnosis {
  passed: boolean;
  circuitBroken: boolean;
  circuitBrokenReason?: string;
  failedCheckNames: string[];
  diagnosis?: string;
  recommendedInstruction?: string;
  reworkDispatched: boolean;
  taskView?: TaskView;
}

const REVIEW_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    diagnosis: {
      type: 'string',
      description: '对执行体失败或报错根本原因的简明技术诊断分析',
    },
    instruction: {
      type: 'string',
      description: '给执行体下一步进行代码修复的具体指令与约束',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: '对该修复方案的置信度',
    },
  },
  required: ['diagnosis', 'instruction'],
};

/**
 * 自动化评估与反馈纠错闭环引擎 (AutonomousFeedbackLoop)
 * 串联：执行体产物检查 -> ChatGPT 评估诊断 -> LoopGuard 熔断防护 -> 自动退回修改
 */
export class AutonomousFeedbackLoop {
  private readonly thinker: Thinker;
  private readonly taskController: FeedbackLoopOptions['taskController'];
  private readonly guard: LoopGuard;
  private readonly mode: FeedbackLoopMode;

  constructor(opts: FeedbackLoopOptions) {
    this.thinker = opts.thinker;
    this.taskController = opts.taskController;
    this.guard = opts.guard ?? loopGuard;
    this.mode = opts.mode ?? 'autonomous';
  }

  /**
   * 提取任务执行后的失败证据（测试挂掉输出、编译报错、退出状态等）
   */
  extractFailureEvidence(task: Task): { failed: boolean; failedChecks: string[]; detail: string } {
    const failedChecks: string[] = [];
    const details: string[] = [];

    // 1. 检查自动检验（build / test）结果
    const checks: StoredCheckProof[] =
      task.currentChecks ??
      task.rounds?.[(task.currentRound ?? 1) - 1]?.checks ??
      [];

    for (const c of checks) {
      if (c.status === 'failed') {
        failedChecks.push(c.name);
        const output = c.rawOutput ? `\n【${c.name} 输出日志】:\n${c.rawOutput.slice(-1500)}` : '';
        const reason = c.unavailableReason ? ` 原因: ${c.unavailableReason}` : '';
        details.push(`检查项「${c.name}」未通过。${reason}${output}`);
      }
    }

    // 2. 检查执行体退出状态
    if (task.exit) {
      if (task.exit.kind === 'exited' && task.exit.code !== 0) {
        details.push(`执行体异常退出，退出码: ${task.exit.code}`);
      } else if (task.exit.kind === 'spawn_error') {
        details.push(`执行体启动异常: ${task.exit.message}`);
      } else if (task.exit.kind === 'timed_out') {
        details.push('执行体执行超时');
      }
    }

    // 3. 检查是否有明确标记不符合的验收标准
    const rejectedCriteria = task.criteria.filter((c) => c.decision === 'rejected');
    if (rejectedCriteria.length > 0) {
      details.push(
        `未通过的验收标准:\n${rejectedCriteria.map((c) => `- ${c.text}${c.note ? `（说明：${c.note}）` : ''}`).join('\n')}`
      );
    }

    const failed = failedChecks.length > 0 || details.length > 0;
    return {
      failed,
      failedChecks,
      detail: details.join('\n\n'),
    };
  }

  /**
   * 运行一次评估与反馈闭环判断
   */
  async processTaskReview(taskId: string): Promise<FeedbackDiagnosis> {
    const task = await this.taskController.load(taskId);
    const taskTitle = task.plan?.goal || task.request || task.id;
    const evidence = this.extractFailureEvidence(task);

    // 场景 A：无失败证据，全部通过
    if (!evidence.failed) {
      this.guard.resetTask(taskId);
      return {
        passed: true,
        circuitBroken: false,
        failedCheckNames: [],
        reworkDispatched: false,
      };
    }

    // 场景 B：存在失败，首先经过 LoopGuard 熔断审查
    const evalResult = this.guard.evaluateTaskStep(taskId, taskTitle, false);
    if (evalResult.circuitBroken) {
      return {
        passed: false,
        circuitBroken: true,
        circuitBrokenReason: evalResult.reason,
        failedCheckNames: evidence.failedChecks,
        reworkDispatched: false,
      };
    }

    // 场景 C：未熔断，调用 ChatGPT Thinker（扮演 Reviewer 纠错脑）做针对性诊断
    const systemPrompt = [
      '你是一位资深架构师与代码纠错专家（Reviewer）。',
      '本地执行体在执行任务时未能通过自动测试或编译，你需要基于其错误日志分析根因，并给出精确的修复指令。',
      '你没有任何执行工具，只负责输出结构化的诊断与指令。要求指令具体、精准、可直接指导执行体修改代码。',
    ].join('\n');

    const taskContext = [
      `【任务标题】: ${taskTitle}`,
      `【任务目标】: ${task.request || '无'}`,
      `【当前轮次】: 第 ${task.currentRound ?? 1} 轮执行`,
      `【失败证据与日志】:\n${evidence.detail}`,
    ].join('\n\n');

    const thinkReq: ThinkRequest = {
      role: 'reviewer',
      system: systemPrompt,
      context: {
        required: [
          { name: 'task_definition', text: taskTitle },
          { name: 'execution_evidence', text: evidence.detail },
        ],
      },
      task: taskContext,
      output: REVIEW_SCHEMA,
    };

    const thinkRes = await this.thinker.think(thinkReq);
    let diagnosisText = '自动化测试或编译未通过，需修正代码。';
    let instructionText = `请修复以下检查项报错：\n${evidence.detail.slice(0, 500)}`;

    if (thinkRes.status === 'complete' && thinkRes.content) {
      if (typeof thinkRes.content.diagnosis === 'string' && thinkRes.content.diagnosis.trim()) {
        diagnosisText = thinkRes.content.diagnosis.trim();
      }
      if (typeof thinkRes.content.instruction === 'string' && thinkRes.content.instruction.trim()) {
        instructionText = thinkRes.content.instruction.trim();
      }
    }

    const combinedFeedback = `【ChatGPT 诊断】: ${diagnosisText}\n\n【修复指导】: ${instructionText}`;

    // 场景 D：根据模式决定是否自动派发
    if (this.mode === 'autonomous') {
      // 无人值守模式：自动调用 reworkTask 派发执行体重新修改
      const updatedView = await this.taskController.reworkTask(taskId, combinedFeedback);
      return {
        passed: false,
        circuitBroken: false,
        failedCheckNames: evidence.failedChecks,
        diagnosis: diagnosisText,
        recommendedInstruction: instructionText,
        reworkDispatched: true,
        taskView: updatedView,
      };
    } else {
      // 半自动模式：保留诊断供用户一键确认
      return {
        passed: false,
        circuitBroken: false,
        failedCheckNames: evidence.failedChecks,
        diagnosis: diagnosisText,
        recommendedInstruction: combinedFeedback,
        reworkDispatched: false,
      };
    }
  }
}
