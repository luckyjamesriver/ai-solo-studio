import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './store.js';
import type { AttemptRecord, ThreadBudget, ThreadRecord } from './types.js';

export const DEFAULT_BUDGET: ThreadBudget = { maxCalls: 12, stepTimeoutMs: 180_000, maxTotalCallMs: 30 * 60_000 };

/**
 * 预算：发起每一次新调用之前，检查“累计已知消耗”。
 * 如实表达：单次调用的费用无法事前封顶；这不是硬上限，而是“累计到达即不再发起新调用”。
 * Codex 只记调用次数，不虚构金额；ClaudeCli 使用结果事件里的 total_cost_usd。
 */
export function budgetStopReason(rec: ThreadRecord): string | undefined {
  const b = rec.budget;
  const calls = rec.attempts.length;
  if (calls >= b.maxCalls) return `调用次数已达上限（${calls}/${b.maxCalls}）；不再发起新调用`;
  const ms = rec.attempts.reduce((s, a) => s + a.durationMs, 0);
  if (ms >= b.maxTotalCallMs) return `累计调用耗时已达上限（${Math.round(ms / 1000)}s/${Math.round(b.maxTotalCallMs / 1000)}s）；不再发起新调用`;
  if (b.maxCostUsd !== undefined) {
    const cost = rec.attempts.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0);
    if (cost >= b.maxCostUsd) return `累计已知费用已达上限（$${cost.toFixed(4)}/$${b.maxCostUsd}，只统计报告了费用的思考者）；不再发起新调用`;
  }
  return undefined;
}

export const BUDGET_NOTE = '预算说明：单次调用的费用无法事前封顶；预算是“累计到达即不再发起新调用”，不是硬上限。Codex 只统计调用次数，不统计金额。';

/** 取出 PROJECT_CONTEXT 中第 N 节（“## N.” 开头的标题，含 N.x 子节）。 */
export function extractSections(md: string, nums: number[]): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let take = false;
  for (const line of lines) {
    const h = line.match(/^##\s+(\d+)(?:\.\d+)?[.\s]/);
    if (h) take = nums.includes(Number(h[1]));
    else if (/^#{1,2}\s/.test(line) && !/^###/.test(line)) take = false;
    if (take) out.push(line);
  }
  return out.join('\n').trim();
}

/** 必带层：PROJECT_CONTEXT 第 1、2、4 节。读取不到或这几节为空 → 抛错（不带必带层就不发起调用）。 */
export async function loadRequiredContext(projectRoot: string): Promise<{ name: string; text: string }> {
  const file = path.join(projectRoot, 'docs', 'PROJECT_CONTEXT.md');
  let md: string;
  try {
    md = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error('找不到 docs/PROJECT_CONTEXT.md：必带层上下文缺失，不发起任何调用');
  }
  const text = extractSections(md, [1, 2, 4]);
  if (!text) throw new Error('docs/PROJECT_CONTEXT.md 中找不到第 1、2、4 节：必带层上下文缺失，不发起任何调用');
  return { name: 'PROJECT_CONTEXT.md（第 1、2、4 节）', text };
}

/** 按需层：调用方显式指定的文件，限定在项目根目录内。 */
export async function loadOptionalContext(projectRoot: string, files: string[]): Promise<{ name: string; text: string }[]> {
  const root = await fs.realpath(projectRoot);
  const out: { name: string; text: string }[] = [];
  for (const f of files) {
    const abs = path.resolve(root, f);
    const real = await fs.realpath(abs).catch(() => undefined);
    if (!real || !(real === root || real.startsWith(root + path.sep))) throw new Error(`按需资料不存在或不在项目目录内：${f}`);
    const buf = await fs.readFile(real);
    if (buf.length > 300_000) throw new Error(`按需资料过大（>300KB）：${f}`);
    out.push({ name: path.relative(root, real), text: buf.toString('utf8') });
  }
  return out;
}

/** 首次向某服务发送资料前的确认记录，按服务保存在 .studio/consent.json。 */
export class ConsentStore {
  constructor(private readonly projectRoot: string) {}
  private file() {
    return path.join(this.projectRoot, '.studio', 'consent.json');
  }
  private async read(): Promise<Record<string, { confirmedAt: string }>> {
    try {
      return JSON.parse(await fs.readFile(this.file(), 'utf8')) as Record<string, { confirmedAt: string }>;
    } catch {
      return {};
    }
  }
  async has(service: string): Promise<boolean> {
    return service in (await this.read());
  }
  async record(service: string): Promise<void> {
    const cur = await this.read();
    cur[service] = { confirmedAt: new Date().toISOString() };
    await atomicWrite(this.file(), JSON.stringify(cur, null, 2) + '\n');
  }
}

export const lastAttempt = (rec: ThreadRecord, step: AttemptRecord['step']) => rec.attempts.filter((a) => a.step === step).at(-1);
