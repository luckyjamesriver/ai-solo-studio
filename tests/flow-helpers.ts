import fs from 'node:fs/promises';
import path from 'node:path';
import { FakeThinker, type FakeThinkStep, type ThinkRequest } from '../src/core/thinking/index.js';
import { FlowEngine, type FlowOptions, type FlowUI, type StepName } from '../src/core/thinking/flow/index.js';
import { makeRepo } from './helpers.js';

export const CONTEXT_MD = `# AI Solo Studio — 项目背景卡

## 1. 一句话
面向独立创作者的验收与恢复工作台。

## 2. 核心信念
- AI 自述不是证据。

## 3. 项目是怎么走到今天的
这一节不应出现在必带层（SECRET-SECTION-3）。

## 4. 目标用户
入门创作者。

## 5. 当前架构
不应出现（SECRET-SECTION-5）。
`;

/** 带 docs/PROJECT_CONTEXT.md 与 .gitignore 的临时 git 仓库 */
export async function makeProject(): Promise<string> {
  return makeRepo({ 'docs/PROJECT_CONTEXT.md': CONTEXT_MD, '.gitignore': '.studio/\n', 'docs/ref.md': '# 约束\n\n## 安全\n内容\n' });
}

export const stepOf = (req: ThinkRequest): StepName => {
  const r = req.output.required;
  if (r.includes('items')) return 'requirements';
  if (r.includes('coverage')) return 'draft';
  if (r.includes('requirement_checks')) return 'review';
  return 'revise';
};

export const J = (o: unknown, pre = '') => `${pre}${JSON.stringify(o)}`;

export interface Overrides {
  requirements?: unknown;
  draft?: unknown;
  review?: unknown;
  revise?: unknown;
  draftRawPrefix?: string;
}

export const REQ = { items: [{ text: '加深色模式' }, { text: '记住用户选择' }] };
export const DRAFT = { plan: '## 方案\n加一个主题开关', coverage: [{ id: 'R1', how: '主题开关' }, { id: 'R2', how: 'localStorage' }] };
export const REVIEW = {
  requirement_checks: [{ id: 'R1', covered: true, note: 'ok' }, { id: 'R2', covered: true, note: 'ok' }],
  findings: [{ problem: '没有考虑系统主题', severity: '建议', basis: 'docs/ref.md#安全', impact: '体验', suggestion: '读取 prefers-color-scheme', resolution: '' }],
  missing_evidence: [],
};
export const REVISE = {
  plan: '## 方案(修订)\n主题开关 + 读取系统主题',
  resolutions: [{ index: 1, result: '已解决', reason: '已加入' }],
  item_marks: [{ id: 'R1', mark: '保留' }, { id: 'R2', mark: '保留' }],
  additions: [],
};

/** 剧本化的思考者：按步骤返回对应 JSON；failOnce[step] 指定该步骤第一次返回的非 complete 状态。 */
export function scripted(over: Overrides = {}, failFirst: Partial<Record<StepName, FakeThinkStep>> = {}, identity: { id: string; service: string } = { id: 'fake-planner', service: 'fake-service-a' }) {
  const seen: Partial<Record<StepName, number>> = {};
  const t = new FakeThinker(
    (req) => {
      const step = stepOf(req);
      const n = (seen[step] = (seen[step] ?? 0) + 1);
      if (n === 1 && failFirst[step]) return failFirst[step]!;
      const body = step === 'requirements' ? (over.requirements ?? REQ) : step === 'draft' ? (over.draft ?? DRAFT) : step === 'review' ? (over.review ?? REVIEW) : (over.revise ?? REVISE);
      return { raw: J(body, step === 'draft' ? (over.draftRawPrefix ?? '') : ''), model: 'm-' + identity.id };
    },
    { available: true },
    identity,
  );
  return t;
}

export type UIScript = Partial<{
  [K in keyof FlowUI]: FlowUI[K];
}>;

export function makeUI(over: UIScript = {}): FlowUI & { calls: { adjudicate: string[]; approve: unknown[]; failed: unknown[]; notes: string[] } } {
  const calls = { adjudicate: [] as string[], approve: [] as unknown[], failed: [] as unknown[], notes: [] as string[] };
  return {
    calls,
    notify: (t) => void calls.notes.push(t),
    confirmSend: async () => true,
    confirmRequirements: async (items) => items.map((i) => ({ id: i.id, text: i.text })),
    onAttemptFailed: async (i) => {
      calls.failed.push(i.attempt.status);
      return 'retry';
    },
    adjudicate: async (q) => {
      calls.adjudicate.push(`${q.kind}:${q.key}`);
      return { decision: 'accept', reason: '同意' };
    },
    approve: async (ctx) => {
      calls.approve.push(ctx);
      return 'approve';
    },
    ...over,
  };
}

export async function engineFor(root: string, o: Partial<FlowOptions> & { planner: FlowOptions['planner'] }, ui = makeUI()) {
  const reviewer = o.single ? undefined : (o.reviewer ?? scripted({}, {}, { id: 'fake-reviewer', service: 'fake-service-b' }));
  return new FlowEngine({ projectRoot: root, ui, newId: () => 'T-test', now: () => new Date('2026-11-08T10:00:00Z'), ...(reviewer ? { reviewer } : {}), ...o });
}

export const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'));
export const threadDir = (root: string, id = 'T-test') => path.join(root, '.studio', 'threads', id);
