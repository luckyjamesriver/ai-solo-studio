import type { ExitOutcome, DeniedOperation } from '../executor/types.js';
import type { CheckResult } from '../checks/scripts.js';
import type { FileChange } from '../git/git.js';

/** 每个检查项的状态都必须来自真实信号。 */
export type ItemStatus = 'verified' | 'failed' | 'not_checked' | 'user_confirmed' | 'user_rejected' | 'pending_user';

/** 报告绑定的 Git 状态：任务开始与结束时的主线 HEAD、工作树路径与其 HEAD（需求 v1.5 第 7 节） */
export interface GitBinding {
  mainHeadAtStart: string;
  mainHeadAtEnd: string;
  worktreePath: string;
  worktreeHeadAtStart: string;
  worktreeHeadAtEnd: string;
}

export interface AcceptanceItem {
  key: string;
  label: string;
  status: ItemStatus;
  evidence: string;
}

export interface AcceptanceCard {
  items: AcceptanceItem[];
  changes: FileChange[];
  /** AI 生成的摘要（若有），必须带免责标注展示 */
  aiSummary?: string;
  /** 只有全部自动检查通过或未提供、且所有验收标准都由用户确认后才为 true */
  readyToSave: boolean;
  /** 本次验收对应的 Git 状态 */
  git?: GitBinding;
  /** 给用户的一句话总结 */
  headline: string;
}

export interface CriterionState {
  text: string;
  decision?: 'confirmed' | 'rejected';
}

function exitItem(o: ExitOutcome): AcceptanceItem {
  const base = { key: 'exit', label: 'AI 执行过程正常结束' };
  switch (o.kind) {
    case 'exited':
      return o.code === 0
        ? { ...base, status: 'verified', evidence: '执行体进程退出码 0' }
        : { ...base, status: 'failed', evidence: `执行体进程退出码 ${o.code}` };
    case 'stopped':
      return { ...base, status: 'failed', evidence: '你停止了本次执行' };
    case 'timed_out':
      return { ...base, status: 'failed', evidence: '执行超时，已被终止' };
    case 'signaled':
      return { ...base, status: 'failed', evidence: `执行体进程被信号 ${o.signal} 终止` };
    case 'spawn_error':
      return { ...base, status: 'failed', evidence: `无法启动执行体：${o.message}` };
  }
}

function checkItem(c: CheckResult): AcceptanceItem {
  const label = c.name === 'build' ? '项目能成功构建' : '自动测试通过';
  if (c.status === 'not_available') return { key: c.name, label, status: 'not_checked', evidence: c.reason };
  return {
    key: c.name,
    label,
    status: c.status === 'passed' ? 'verified' : 'failed',
    evidence: c.status === 'passed' ? `npm run ${c.name} 成功（${Math.round(c.durationMs / 1000)} 秒）` : `npm run ${c.name} 失败`,
  };
}

export function buildCard(input: {
  exit: ExitOutcome;
  changes: FileChange[];
  checks: CheckResult[];
  criteria: CriterionState[];
  previewed: boolean;
  aiSummary?: string;
  denied?: DeniedOperation[];
  deniedAcks?: boolean[];
  git?: GitBinding;
}): AcceptanceCard {
  const items: AcceptanceItem[] = [exitItem(input.exit)];
  items.push(
    input.changes.length > 0
      ? { key: 'changes', label: '有实际文件改动', status: 'verified', evidence: `${input.changes.length} 个文件发生变化` }
      : { key: 'changes', label: '有实际文件改动', status: 'failed', evidence: '没有任何文件被修改' },
  );
  for (const c of input.checks) items.push(checkItem(c));
  const denied = input.denied ?? [];
  const acks = input.deniedAcks ?? [];
  const deniedAllAcked = denied.every((_, i) => acks[i] === true);
  if (denied.length === 0) {
    items.push({ key: 'denied', label: 'AI 请求的操作是否都已执行', status: 'verified', evidence: '没有被拒绝的操作' });
  } else {
    const list = denied.map((d) => `${d.command?.join(' ') ?? d.paths?.join('、') ?? d.description}（${d.kind}，风险：${d.risk}）`).join('；');
    items.push({
      key: 'denied',
      label: 'AI 请求的操作是否都已执行',
      status: deniedAllAcked ? 'user_confirmed' : 'pending_user',
      evidence: `有 ${denied.length} 项操作被你拒绝，任务可能不完整：${list}`,
    });
  }
  items.push({
    key: 'preview',
    label: '你已经试用过效果',
    status: input.previewed ? 'user_confirmed' : 'pending_user',
    evidence: input.previewed ? '你打开过预览' : '尚未试用',
  });
  input.criteria.forEach((c, i) =>
    items.push({
      key: `criterion-${i}`,
      label: c.text,
      status: c.decision === 'confirmed' ? 'user_confirmed' : c.decision === 'rejected' ? 'user_rejected' : 'pending_user',
      evidence: c.decision ? '由你确认' : '等待你确认',
    }),
  );

  const anyFailed = items.some((i) => i.status === 'failed' || i.status === 'user_rejected');
  const criteriaDone = input.criteria.every((c) => c.decision === 'confirmed');
  const readyToSave = !anyFailed && criteriaDone && deniedAllAcked && input.changes.length > 0;

  const headline = anyFailed
    ? '有检查未通过，建议修复或撤销。'
    : !deniedAllAcked
      ? `有 ${denied.length} 项操作被你拒绝，任务可能不完整，请逐项确认你知晓。`
      : !criteriaDone
      ? '自动检查没有发现问题，请你逐条确认验收标准。'
      : items.some((i) => i.status === 'not_checked')
        ? '可以保存。注意：部分项目未能自动检查。'
        : '所有检查都已通过，可以保存。';

  const card: AcceptanceCard = { items, changes: input.changes, readyToSave, headline };
  if (input.aiSummary) card.aiSummary = input.aiSummary;
  if (input.git) card.git = input.git;
  return card;
}
