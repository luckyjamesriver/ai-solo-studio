import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutonomousFeedbackLoop } from '../../src/core/app/autonomous-feedback-loop.js';
import { LoopGuard } from '../../src/core/app/loop-guard.js';
import type { Task, StoredCheckProof } from '../../src/core/task/model.js';
import type { Thinker, ThinkRequest, ThinkResult } from '../../src/core/thinking/types.js';

describe('AISS 审计反向验证探针 (Negative & Edge Case Probes)', () => {
  let mockTask: Task;
  let mockTaskController: any;
  let mockThinker: Thinker;
  let guard: LoopGuard;

  beforeEach(() => {
    guard = new LoopGuard(3);
    mockTask = {
      id: 'probe-task-001',
      request: '反向审计探针验证任务',
      state: 'reviewing',
      currentRound: 1,
      criteria: [{ text: '单元测试全部通过' }],
      currentChecks: [],
      denied: [],
      deniedAcks: [],
      previewed: false,
    } as unknown as Task;

    mockTaskController = {
      load: vi.fn().mockResolvedValue(mockTask),
      reworkTask: vi.fn().mockResolvedValue({
        id: 'probe-task-001',
        title: '反向审计探针验证任务',
        state: 'approved',
        currentRound: 2,
      }),
    };

    mockThinker = {
      id: 'probe-thinker',
      displayName: 'Probe Thinker',
      service: 'OpenAI',
      detect: async () => ({ available: true }),
      think: vi.fn().mockResolvedValue({
        status: 'complete',
        content: {
          diagnosis: '测试探针诊断分析',
          instruction: '测试探针修复建议',
          confidence: 'high',
        },
        rawText: '',
        sent: [],
        service: 'OpenAI',
      } as ThinkResult),
    };
  });

  it('探针 1：执行体退出码非 0 即使无 checkProof 也会被捕获为失败，不会误判为 PASS', async () => {
    mockTask.exit = { kind: 'exited', code: 137 };
    mockTask.currentChecks = []; // 无单测日志

    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    const res = await loop.processTaskReview('probe-task-001');
    expect(res.passed).toBe(false);
    expect(res.reworkDispatched).toBe(true);
    expect(mockThinker.think).toHaveBeenCalled();
    const thinkCall = (mockThinker.think as any).mock.calls[0][0] as ThinkRequest;
    expect(thinkCall.task).toContain('退出码: 137');
  });

  it('探针 2：测试未运行 (currentChecks 为空且无退出异常) 时被误判为全部通过 (架构缺失：证据存在性门禁)', async () => {
    mockTask.currentChecks = [];
    mockTask.exit = { kind: 'exited', code: 0 };

    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    const res = await loop.processTaskReview('probe-task-001');
    // 发现漏洞：未执行任何测试却直接判 passed: true
    expect(res.passed).toBe(true);
    expect(res.reworkDispatched).toBe(false);
  });

  it('探针 3：复核服务返回 invalid/failed/auth_error 时降级处理，不产生崩溃', async () => {
    mockTask.currentChecks = [
      { name: 'test', status: 'failed', rawOutput: 'Error: crash', env: 'local' } as StoredCheckProof,
    ];
    vi.spyOn(mockThinker, 'think').mockResolvedValue({
      status: 'auth_error',
      rawText: '',
      sent: [],
      service: 'OpenAI',
      error: 'Token 失效',
    });

    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    const res = await loop.processTaskReview('probe-task-001');
    expect(res.passed).toBe(false);
    // 即使 AI 脑不可用，依然触发了基于 fallback 文本的退回修改，或应阻断
    expect(res.reworkDispatched).toBe(true);
    expect(res.diagnosis).toContain('自动化测试或编译未通过，需修正代码。');
  });

  it('探针 4：跨项目污染防范 - load 与 reworkTask 必须受 TaskController 与存储库隔离约束', async () => {
    mockTaskController.load.mockRejectedValue(new Error('找不到任务 fake-id'));

    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    await expect(loop.processTaskReview('fake-id')).rejects.toThrow('找不到任务 fake-id');
  });
});
