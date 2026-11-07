import { buildThinkPrompt, parseStructured } from './prompt.js';
import type { ThinkRequest, ThinkResult, Thinker, ThinkerDetect, ThinkStatus } from './types.js';

/** 剧本中的一步：要么直接指定状态，要么给出原始文本（会像真实思考者一样被解析）。 */
export type FakeThinkStep =
  | { raw: string; model?: string; usage?: ThinkResult['usage']; refusedToolRequests?: string[] }
  | { status: Exclude<ThinkStatus, 'complete' | 'incomplete'>; error?: string };

/** 按剧本返回各种结果的思考者，用于测试。每次 think() 取剧本的下一步（用完后重复最后一步）。 */
export class FakeThinker implements Thinker {
  readonly id: string;
  readonly displayName = '模拟思考者（测试用）';
  readonly service: string;
  readonly requests: ThinkRequest[] = [];
  private i = 0;
  constructor(
    private readonly script: FakeThinkStep[] | ((req: ThinkRequest) => FakeThinkStep),
    private readonly detectResult: ThinkerDetect = { available: true },
    identity: { id?: string; service?: string } = {},
  ) {
    this.id = identity.id ?? 'fake';
    this.service = identity.service ?? 'fake-service';
  }

  async detect(): Promise<ThinkerDetect> {
    return this.detectResult;
  }

  async think(req: ThinkRequest): Promise<ThinkResult> {
    this.requests.push(req);
    const { sent } = buildThinkPrompt(req);
    const step = typeof this.script === 'function' ? this.script(req) : this.script[Math.min(this.i++, this.script.length - 1)]!;
    if ('status' in step) return { status: step.status, rawText: '', sent, service: this.service, ...(step.error ? { error: step.error } : {}) };
    const parsed = parseStructured(step.raw, req.output);
    return {
      status: parsed.ok ? 'complete' : 'incomplete',
      ...(parsed.ok ? { content: parsed.content } : { error: parsed.error }),
      rawText: step.raw,
      sent,
      service: this.service,
      model: step.model ?? 'fake-model',
      ...(step.usage ? { usage: step.usage } : {}),
      ...(step.refusedToolRequests ? { refusedToolRequests: step.refusedToolRequests } : {}),
    };
  }
}
