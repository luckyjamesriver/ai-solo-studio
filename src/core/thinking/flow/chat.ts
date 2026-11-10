import fs from 'node:fs/promises';
import path from 'node:path';
import type { ContextItem, OutputSchema, ThinkRequest, ThinkResult, Thinker } from '../types.js';
import { atomicWrite, ThreadStore } from './store.js';
import { formatItems, planBody } from './steps.js';
import { budgetStopReason, ConsentStore, loadOptionalContext, loadRequiredContext } from './support.js';
import type { AttemptRecord, ChatStepName, RequirementItem, ThreadRecord } from './types.js';

export type ChatTarget = 'planner' | 'reviewer';

export interface DiscussionChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** 只要正式 review 产物已生成，复核的对话回复必须标记为“评审后的讨论 · 非独立评审”。 */
  postReview?: boolean;
}

export interface DiscussionChatsView {
  planner: DiscussionChatMessage[];
  reviewer: DiscussionChatMessage[];
}

interface ReqArtifactBody {
  items: RequirementItem[];
  rawRequirement: string;
}

interface PlanArtifactBody {
  plan: string;
  coverage?: { id: string; how: string }[];
}

interface ReviewArtifactBody {
  requirement_checks: { id: string; covered: boolean; note: string }[];
  findings: unknown[];
  missing_evidence: string[];
}

const CHAT_SCHEMA: OutputSchema = {
  type: 'object',
  required: ['reply'],
  properties: {
    reply: { type: 'string', description: '针对用户问题或观点的简明中文回复' },
  },
};

const PLANNER_CHAT_SYSTEM = [
  '你是规划思考者（首席），正在回答用户针对本任务需求的方案疑问。',
  '你只能讨论与解释方案，无权修改文件、无权运行命令，也无权修改已经冻结的需求条目。',
  '如果用户提出变更或增删需求条目，请如实提示用户在界面上使用「修改需求」按钮，不要在对话中擅自变更基准需求。',
  '严格按要求输出 JSON（含 reply 字段）。',
].join('\n');

const REVIEWER_CHAT_SYSTEM = [
  '你是复核思考者，正在单独回答用户关于你所见方案与评审意见的问题。',
  '你只基于已冻结的需求条目、方案正文与你本人的正式评审产物作答，不知道也不臆测规划者的其他内部推理。',
  '你无权修改文件或运行命令，也无权修改已经冻结的需求条目；如果用户想改需求，请提示使用界面上的「修改需求」。',
  '严谨、如实地回答，按要求输出 JSON（含 reply 字段）。',
].join('\n');

function convFile(projectRoot: string, threadId: string, target: ChatTarget): string {
  return path.join(projectRoot, '.studio', 'threads', threadId, 'conversations', `${target}.json`);
}

async function readConversation(projectRoot: string, threadId: string, target: ChatTarget): Promise<DiscussionChatMessage[]> {
  try {
    const raw = await fs.readFile(convFile(projectRoot, threadId, target), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DiscussionChatMessage[]) : [];
  } catch {
    return [];
  }
}

async function writeConversation(
  projectRoot: string,
  threadId: string,
  target: ChatTarget,
  messages: DiscussionChatMessage[],
): Promise<void> {
  await atomicWrite(convFile(projectRoot, threadId, target), JSON.stringify(messages, null, 2));
}

export async function readDiscussionChats(projectRoot: string, threadId: string): Promise<DiscussionChatsView> {
  const [planner, reviewer] = await Promise.all([
    readConversation(projectRoot, threadId, 'planner'),
    readConversation(projectRoot, threadId, 'reviewer'),
  ]);
  return { planner, reviewer };
}

function formatChatTranscript(history: DiscussionChatMessage[], speakerLabel: string): string {
  if (history.length === 0) return '（此前无对话记录）';
  return history
    .map((m) => `${m.role === 'user' ? '用户' : speakerLabel}（${m.at}）：${m.text}`)
    .join('\n\n');
}

function extractReply(res: ThinkResult): string | null {
  if (res.status !== 'complete' || !res.content) return null;
  const r = res.content.reply;
  return typeof r === 'string' && r.trim() ? r.trim() : null;
}

/**
 * 发起一次按思考者隔离的对话：
 * - 与首席（planner）和与复核（reviewer）各自独立存档在 `.studio/threads/<id>/conversations/`。
 * - 发给复核的请求严格只含：必带层 + 冻结需求 + 方案正文（无决议/无标注/无原始推理）+ 复核本人正式 review 产物 + 用户↔复核历史；
 *   绝不传入首席的任何原始输出、推理或用户↔首席对话。
 * - 发给首席的请求绝不传入用户↔复核对话。
 * - 消耗同一个讨论预算与首次资料外发同意；正式 `review.v1` 等产物文件保持只读不变。
 */
export async function sendThreadChat(opts: {
  projectRoot: string;
  threadId: string;
  target: ChatTarget;
  thinker: Thinker;
  message: string;
  consent?: ConsentStore;
}): Promise<{ messages: DiscussionChatMessage[]; thread: ThreadRecord }> {
  const store = new ThreadStore(opts.projectRoot);
  const rec = await store.load(opts.threadId);
  if (rec.state === 'stopped' || rec.state === 'rejected') {
    throw new Error('讨论线程已停止或否决，不能继续对话。');
  }
  if (opts.target === 'reviewer' && rec.single) {
    throw new Error('单思考者模式下没有复核思考者，无法发起复核对话。');
  }

  const userText = opts.message.trim();
  if (!userText) throw new Error('请输入要发送的对话内容。');

  const stop = budgetStopReason(rec);
  if (stop) {
    rec.state = 'stopped';
    rec.stoppedReason = stop;
    rec.log.push({ at: new Date().toISOString(), text: `触发预算停止（对话）：${stop}` });
    await store.save(rec);
    throw new Error(stop);
  }

  const consent = opts.consent ?? new ConsentStore(opts.projectRoot);
  if (!(await consent.has(opts.thinker.service))) {
    throw new Error(`尚未同意向“${opts.thinker.service}”发送资料，请先在「方案摘要」中确认首次外发。`);
  }

  const requiredCtx = await loadRequiredContext(opts.projectRoot);
  const optionalFiles = await loadOptionalContext(opts.projectRoot, rec.optionalFiles);

  const reqFrozenArt = store.latest(rec, 'requirements_confirmed');
  const reqDraftArt = store.latest(rec, 'requirements');
  const reqArt = reqFrozenArt ?? reqDraftArt;
  const reqBody = reqArt ? await store.readArtifact<ReqArtifactBody>(rec, reqArt) : null;

  const reviseArt = store.latest(rec, 'revise');
  const draftArt = store.latest(rec, 'draft');
  const reviseBody = reviseArt ? await store.readArtifact<PlanArtifactBody>(rec, reviseArt) : null;
  const draftBody = draftArt ? await store.readArtifact<PlanArtifactBody>(rec, draftArt) : null;

  const reviewArt = opts.target === 'reviewer' ? store.latest(rec, 'review') : undefined;
  const reviewBody = reviewArt ? await store.readArtifact<ReviewArtifactBody>(rec, reviewArt) : null;

  const history = await readConversation(opts.projectRoot, opts.threadId, opts.target);

  const requiredItems: ContextItem[] = [requiredCtx];
  if (reqBody?.items?.length) {
    requiredItems.push({
      name: reqFrozenArt ? '需求条目（已冻结）' : '需求条目（未冻结草稿）',
      text: formatItems(reqBody.items),
    });
  }
  requiredItems.push({ name: '用户原始需求', text: rec.rawRequirement });

  const optionalItems: ContextItem[] = [...optionalFiles];

  if (opts.target === 'planner') {
    if (reviseBody) {
      optionalItems.push({ name: '当前方案正文（修订版）', text: reviseBody.plan });
    } else if (draftBody) {
      optionalItems.push({
        name: '当前方案正文（初稿）',
        text: planBody({ plan: draftBody.plan, coverage: draftBody.coverage ?? [] }),
      });
    }
    optionalItems.push({
      name: '用户与首席对话历史',
      text: formatChatTranscript(history, '首席'),
    });
  } else {
    // 复核隔离边界：只给方案正文（不含首席的 resolutions/item_marks/additions/原始输出），以及复核本人正式 review 产物、用户↔复核对话历史
    if (reviseBody) {
      optionalItems.push({ name: '最新方案正文（只读）', text: reviseBody.plan });
    } else if (draftBody) {
      optionalItems.push({
        name: '方案正文（只读）',
        text: planBody({ plan: draftBody.plan, coverage: draftBody.coverage ?? [] }),
      });
    }
    if (reviewBody) {
      optionalItems.push({
        name: '你本人的正式独立评审记录',
        text: JSON.stringify(reviewBody, null, 2),
      });
    }
    optionalItems.push({
      name: '用户与复核对话历史',
      text: formatChatTranscript(history, '复核'),
    });
  }

  const req: ThinkRequest = {
    role: opts.target,
    system: opts.target === 'planner' ? PLANNER_CHAT_SYSTEM : REVIEWER_CHAT_SYSTEM,
    context: { required: requiredItems, optional: optionalItems },
    task: `用户当前提问：\n${userText}`,
    output: CHAT_SCHEMA,
    timeoutMs: rec.budget.stepTimeoutMs,
  };

  const step: ChatStepName = opts.target === 'planner' ? 'chat_planner' : 'chat_reviewer';
  const startedAt = new Date();
  let result: ThinkResult;
  try {
    result = await opts.thinker.think(req);
  } catch (e) {
    result = {
      status: 'failed',
      rawText: '',
      sent: [],
      service: opts.thinker.service,
      error: `对话调用异常：${(e as Error).message}`,
    };
  }
  const endedAt = new Date();
  const n = rec.attempts.filter((a) => a.step === step).length + 1;
  const attempt: AttemptRecord = {
    step,
    n,
    thinkerId: opts.thinker.id,
    role: opts.target,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    status: result.status,
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    sent: result.sent,
    service: result.service,
    ...(result.error ? { error: result.error } : {}),
    ...(result.isolationEvidence ? { isolationEvidence: result.isolationEvidence } : {}),
    ...(result.refusedToolRequests?.length ? { refusedToolRequests: result.refusedToolRequests } : {}),
  };

  const reply = extractReply(result);
  if (!reply && attempt.status === 'complete') {
    attempt.status = 'incomplete';
    attempt.error = '思考者未返回有效回复内容';
  }
  rec.attempts.push(attempt);
  rec.log.push({
    at: endedAt.toISOString(),
    text: `${opts.target === 'planner' ? '首席' : '复核'}对话第 ${n} 次（${attempt.status}）`,
  });
  await store.save(rec);

  if (!reply) {
    throw new Error(attempt.error ?? `思考者未能完成回复（${attempt.status}）`);
  }

  const hasFormalReview = Boolean(store.latest(rec, 'review'));
  const nowIso = endedAt.toISOString();
  const updated: DiscussionChatMessage[] = [
    ...history,
    { id: `u-${n}-${Date.now()}`, role: 'user', text: userText, at: startedAt.toISOString() },
    {
      id: `a-${n}-${Date.now()}`,
      role: 'assistant',
      text: reply,
      at: nowIso,
      ...(opts.target === 'reviewer' && hasFormalReview ? { postReview: true } : {}),
    },
  ];
  await writeConversation(opts.projectRoot, opts.threadId, opts.target, updated);

  return { messages: updated, thread: rec };
}
