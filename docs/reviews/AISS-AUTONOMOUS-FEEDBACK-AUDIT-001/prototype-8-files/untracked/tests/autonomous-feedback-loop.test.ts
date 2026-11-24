import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatGptDevKitThinker, redactDevKitSecret } from '../src/core/thinking/chatgpt-devkit.js';
import { AutonomousFeedbackLoop } from '../src/core/app/autonomous-feedback-loop.js';
import { LoopGuard } from '../src/core/app/loop-guard.js';
import type { Task, StoredCheckProof } from '../src/core/task/model.js';
import type { Thinker, ThinkRequest, ThinkResult } from '../src/core/thinking/types.js';

describe('ChatGptDevKitThinker (DevKit 协议适配器)', () => {
  it('脱敏函数正确隐藏 Token', () => {
    const raw = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123';
    expect(redactDevKitSecret(raw, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123')).not.toContain('token123');
  });

  it('detect: 无 Token 时报告不可用，有 Token 时报告可用', async () => {
    const noTokenThinker = new ChatGptDevKitThinker({
      getAccessToken: async () => null,
    });
    const det1 = await noTokenThinker.detect();
    expect(det1.available).toBe(false);
    expect(det1.note).toContain('尚未通过 "Sign in with ChatGPT" 授权登录');

    const hasTokenThinker = new ChatGptDevKitThinker({
      getAccessToken: async () => 'test-valid-token',
    });
    const det2 = await hasTokenThinker.detect();
    expect(det2.available).toBe(true);
  });

  it('think: 正常返回 JSON 结构并完成结构化解析', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ diagnosis: '缺少空指针保护', instruction: '添加 ?. 校验' }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as any);

    const thinker = new ChatGptDevKitThinker({
      getAccessToken: async () => 'valid-token',
      fetchImpl: mockFetch,
    });

    const res = await thinker.think({
      role: 'reviewer',
      system: 'test system',
      context: { required: [{ name: 'file', text: 'code' }] },
      task: 'test task',
      output: {
        type: 'object',
        properties: {
          diagnosis: { type: 'string' },
          instruction: { type: 'string' },
        },
        required: ['diagnosis', 'instruction'],
      },
    });

    expect(res.status).toBe('complete');
    expect(res.content).toEqual({ diagnosis: '缺少空指针保护', instruction: '添加 ?. 校验' });
    expect(res.usage?.inputTokens).toBe(100);
    expect(res.usage?.outputTokens).toBe(50);
  });

  it('think: 处理 401 认证异常与 429 速率限制', async () => {
    const mock401 = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Invalid authentication token',
    } as any);

    const thinker401 = new ChatGptDevKitThinker({
      getAccessToken: async () => 'expired-token',
      fetchImpl: mock401,
    });

    const res401 = await thinker401.think({
      role: 'reviewer',
      system: '',
      context: { required: [] },
      task: '',
      output: { type: 'object', properties: {}, required: [] },
    });
    expect(res401.status).toBe('auth_error');

    const mock429 = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limit reached',
    } as any);

    const thinker429 = new ChatGptDevKitThinker({
      getAccessToken: async () => 'valid-token',
      fetchImpl: mock429,
    });

    const res429 = await thinker429.think({
      role: 'reviewer',
      system: '',
      context: { required: [] },
      task: '',
      output: { type: 'object', properties: {}, required: [] },
    });
    expect(res429.status).toBe('rate_limited');
  });
});

describe('AutonomousFeedbackLoop (执行结果喂回与自动纠错闭环)', () => {
  let mockTask: Task;
  let mockTaskController: any;
  let mockThinker: Thinker;
  let guard: LoopGuard;

  beforeEach(() => {
    guard = new LoopGuard(3);
    mockTask = {
      id: 'task-101',
      request: '对 email 和 password 字段做规范校验',
      state: 'reviewing',
      currentRound: 1,
      criteria: [{ text: '单元测试全部通过' }],
      currentChecks: [
        {
          name: 'test',
          status: 'failed',
          rawOutput: 'FAIL tests/auth.test.ts > 校验空邮箱报错\nAssertionError: expected false to be true',
          env: 'local',
          ranAt: new Date().toISOString(),
        } as StoredCheckProof,
      ],
      denied: [],
      deniedAcks: [],
      previewed: false,
    } as unknown as Task;

    mockTaskController = {
      load: vi.fn().mockResolvedValue(mockTask),
      reworkTask: vi.fn().mockResolvedValue({
        id: 'task-101',
        title: '优化用户注册输入验证',
        state: 'approved',
        currentRound: 2,
      }),
    };

    mockThinker = {
      id: 'chatgpt-reviewer',
      displayName: 'ChatGPT Reviewer',
      service: 'OpenAI',
      detect: async () => ({ available: true }),
      think: vi.fn().mockResolvedValue({
        status: 'complete',
        content: {
          diagnosis: '断言期待返回 false，但空校验逻辑返回了 undefined。',
          instruction: '请修改 validateEmail 函数，显式处理空字符串并返回 boolean。',
          confidence: 'high',
        },
        rawText: '',
        sent: [],
        service: 'OpenAI',
      } as ThinkResult),
    };
  });

  it('场景 1：检查全绿（Passed）时无需纠错，自动重置重试计数', async () => {
    mockTask.currentChecks = [
      { name: 'build', status: 'passed', env: 'local', at: new Date().toISOString() } as StoredCheckProof,
      { name: 'test', status: 'passed', env: 'local', at: new Date().toISOString() } as StoredCheckProof,
    ];

    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
    });

    const res = await loop.processTaskReview('task-101');
    expect(res.passed).toBe(true);
    expect(res.circuitBroken).toBe(false);
    expect(res.reworkDispatched).toBe(false);
    expect(mockThinker.think).not.toHaveBeenCalled();
    expect(mockTaskController.reworkTask).not.toHaveBeenCalled();
  });

  it('场景 2：单测挂掉（Failed）在无人值守模式下自动把日志喂给 ChatGPT 并触发退回修改', async () => {
    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    const res = await loop.processTaskReview('task-101');

    expect(res.passed).toBe(false);
    expect(res.circuitBroken).toBe(false);
    expect(res.failedCheckNames).toEqual(['test']);
    expect(res.diagnosis).toContain('断言期待返回 false');
    expect(res.reworkDispatched).toBe(true);

    // 验证确实把单测失败日志喂给了 Thinker
    expect(mockThinker.think).toHaveBeenCalled();
    const thinkCall = (mockThinker.think as any).mock.calls[0][0] as ThinkRequest;
    expect(thinkCall.task).toContain('FAIL tests/auth.test.ts');
    expect(thinkCall.role).toBe('reviewer');

    // 验证自动调用了 reworkTask，且带上了 ChatGPT 的纠错指令
    expect(mockTaskController.reworkTask).toHaveBeenCalledTimes(1);
    const reworkArgs = (mockTaskController.reworkTask as any).mock.calls[0];
    expect(reworkArgs[0]).toBe('task-101');
    expect(reworkArgs[1]).toContain('【ChatGPT 诊断】: 断言期待返回 false');
    expect(reworkArgs[1]).toContain('【修复指导】: 请修改 validateEmail 函数');
  });

  it('场景 3：半自动模式（semi-auto）只生成纠错建议供人工确认，不自动启动下一轮', async () => {
    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'semi-auto',
    });

    const res = await loop.processTaskReview('task-101');

    expect(res.passed).toBe(false);
    expect(res.reworkDispatched).toBe(false);
    expect(res.diagnosis).toBeDefined();
    expect(res.recommendedInstruction).toContain('【ChatGPT 诊断】');
    expect(mockTaskController.reworkTask).not.toHaveBeenCalled();
  });

  it('场景 4：连续失败 3 次触发 LoopGuard 熔断，保护代码并不再重试', async () => {
    const loop = new AutonomousFeedbackLoop({
      thinker: mockThinker,
      taskController: mockTaskController,
      guard,
      mode: 'autonomous',
    });

    // 第 1 次失败
    const r1 = await loop.processTaskReview('task-101');
    expect(r1.circuitBroken).toBe(false);

    // 第 2 次失败
    const r2 = await loop.processTaskReview('task-101');
    expect(r2.circuitBroken).toBe(false);

    // 第 3 次失败 -> 触发熔断
    const r3 = await loop.processTaskReview('task-101');
    expect(r3.circuitBroken).toBe(true);
    expect(r3.circuitBrokenReason).toContain('连续 3 次未能产生通过验收的代码产物');
    expect(r3.reworkDispatched).toBe(false);

    // 熔断后，第 3 次不会再调用 Thinker 和 reworkTask
    expect(mockTaskController.reworkTask).toHaveBeenCalledTimes(2);
  });

  it('场景 5：TaskController 实例集成调用 runFeedbackLoop 成功触发闭环', async () => {
    const { TaskController } = await import('../src/core/app/task-controller.js');
    const controller = new TaskController({
      repo: '/tmp/test-repo',
      makeExecutor: () => ({} as any),
      pickDirectory: async () => null,
      prefs: { get: () => undefined, set: () => undefined } as any,
      feedbackLoop: {
        enabled: true,
        thinker: mockThinker,
        mode: 'autonomous',
      },
    });

    // mock controller 内部的 load 与 reworkTask
    vi.spyOn(controller as any, 'ready').mockResolvedValue(undefined);
    vi.spyOn(controller, 'load').mockResolvedValue(mockTask);
    vi.spyOn(controller, 'reworkTask').mockResolvedValue({
      id: 'task-101',
      title: '优化用户注册输入验证',
      state: 'approved',
      currentRound: 2,
    } as any);

    const res = await controller.runFeedbackLoop('task-101');
    expect(res.passed).toBe(false);
    expect(res.reworkDispatched).toBe(true);
    expect(res.diagnosis).toContain('断言期待返回 false');
    expect(controller.reworkTask).toHaveBeenCalledTimes(1);
  });
});
