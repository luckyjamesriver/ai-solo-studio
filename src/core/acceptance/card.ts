import type { ExitOutcome, DeniedOperation } from '../executor/types.js';
import type { CheckResult } from '../checks/scripts.js';
import type { FileChange } from '../git/git.js';
import { adjudicateCheckResult, type CheckAdjudication, type EvidenceIdentityContextForAdjudication } from '../evidence/adjudicate.js';

/**
 * 验收卡（AISS-A1 语义修正）：
 * 必须严格区分——
 *  - 执行命令正常结束（process evidence，exit 0）；
 *  - 自动测试真实执行（structured report 证明有测试跑过）；
 *  - 自动测试真实通过（structured report 证明全部通过且范围未被削弱）；
 *  - 未执行（not_checked：没有脚本 / 没有受限环境 / 未授权）；
 *  - 缺乏有效证据（unverified：跑过命令，但拿不到可信测试证据）；
 *  - 证据失效（invalidated：身份/版本/配置/范围变化导致原证据作废）；
 *  - 用户明确接受未检查风险（user_confirmed，仅来自用户操作，绝不自动发生）。
 */
export type ItemStatus = 'verified' | 'failed' | 'not_checked' | 'unverified' | 'invalidated' | 'user_confirmed' | 'user_rejected' | 'pending_user';

/** 报告绑定的 Git 状态：任务开始与结束时的主线 HEAD、工作树路径与其 HEAD（需求 v1.5 第 7 节） */
export interface GitBinding {
  mainHeadAtStart: string;
  mainHeadAtEnd: string;
  worktreePath: string;
  worktreeHeadAtStart: string;
  worktreeHeadAtEnd: string;
}

/** 状态的来源：决定这一项到底证明了什么。 */
export type EvidenceSource = 'process' | 'structured_test' | 'user' | 'none';

export interface AcceptanceItem {
  key: string;
  label: string;
  status: ItemStatus;
  evidence: string;
  /** 该状态由什么性质的证据支持（process = 进程事实；structured_test = 结构化测试报告；user = 用户操作；none = 无证据） */
  source?: EvidenceSource;
  /** 测试数量的真实事实；无法取得时为 null —— 绝不默认生成通过数量 */
  testCounts?: { passed: number; failed: number; skipped: number; total: number } | null;
  /** 缺乏证据 / 失效 / 未执行的结构化原因 */
  unknownReason?: string;
  /** 用户是否明确接受未检查风险（仅当 status 为 not_checked/unverified 且确有用户确认时为 true） */
  riskAccepted?: boolean;
}

export interface AcceptanceCard {
  items: AcceptanceItem[];
  changes: FileChange[];
  /** AI 生成的摘要（若有），必须带免责标注展示 */
  aiSummary?: string;
  /** 只有全部自动检查都有可信通过证据或未提供、且所有验收标准都由用户确认后才为 true */
  readyToSave: boolean;
  /** 本次验收对应的 Git 状态 */
  git?: GitBinding;
  /** 本次验收绑定的内容（冻结的 tree） */
  acceptedTree?: string;
  /** 给用户的一句话总结 */
  headline: string;
  /** 需要如实告诉用户的说明（例如保存时没有运行项目自定义的提交检查） */
  notes?: string[];
}

export interface CriterionState {
  text: string;
  decision?: 'confirmed' | 'rejected';
  /** 用户判为“不符合”时附带的一句话说明（选填） */
  note?: string;
}

function exitItem(o: ExitOutcome): AcceptanceItem {
  const base = { key: 'exit', label: 'AI 执行过程正常结束', source: 'process' as const };
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

/**
 * 把一次真实检查结果映射成验收卡条目。
 * R1-03：验收卡不再自行解释 `passed` —— 结论一律来自 `src/core/evidence/adjudicate.ts` 的统一裁决入口。
 */
function checkItem(c: CheckResult, ctx?: EvidenceIdentityContextForAdjudication): AcceptanceItem {
  const label = c.name === 'build' ? '项目能成功构建' : '自动测试通过';
  // 未提供身份上下文（纯单元/历史路径）时按“历史证据”裁决：仍要求有结构化证据，但不做跨版本身份绑定
  const adjudicated = adjudicateCheckResult(
    c,
    ctx ?? { taskId: c.evidence?.identity.taskId ?? '', round: c.evidence?.identity.round ?? 1, historical: true },
  );
  const status: ItemStatus = adjudicated.status === 'verified'
    ? 'verified'
    : adjudicated.status === 'failed'
      ? 'failed'
      : adjudicated.status === 'not_checked'
        ? 'not_checked'
        : adjudicated.status === 'invalidated'
          ? 'invalidated'
          : 'unverified';
  const source: EvidenceSource = adjudicated.status === 'not_checked' ? 'none' : c.name === 'test' ? 'structured_test' : 'process';
  return {
    key: c.name,
    label,
    status,
    evidence: adjudicated.detail,
    source,
    ...(c.name === 'test' ? { testCounts: adjudicated.counts ?? null } : {}),
    ...(adjudicated.reason ? { unknownReason: adjudicated.reason } : {}),
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
  acceptedTree?: string;
  /** 检查脚本改动了文件 → 检查结果作废（原因文字） */
  checksVoid?: string;
  /** 证据失效（身份/版本/配置变化；原因文字） */
  evidenceInvalid?: string;
  /** 验收标准为空时，用户的整体确认 */
  overallConfirmed?: boolean;
  notes?: string[];
  /** 证据身份上下文（任务/轮次/验收版本/内容/项目/工作树），用于统一裁决 */
  evidenceContext?: EvidenceIdentityContextForAdjudication;
}): AcceptanceCard {
  const items: AcceptanceItem[] = [exitItem(input.exit)];
  items.push(
    input.changes.length > 0
      ? { key: 'changes', label: '有实际文件改动', status: 'verified', evidence: `${input.changes.length} 个文件发生变化`, source: 'process' }
      : { key: 'changes', label: '有实际文件改动', status: 'failed', evidence: '没有任何文件被修改', source: 'process' },
  );
  for (const c of input.checks) items.push(checkItem(c, input.evidenceContext));
  if (input.checksVoid) {
    items.push({ key: 'checks_modified', label: '检查是否改动了文件', status: 'invalidated', evidence: input.checksVoid, source: 'none', unknownReason: 'source_changed_during_check' });
  }
  if (input.evidenceInvalid) {
    items.push({ key: 'checks_evidence', label: '检查证据是否有效', status: 'invalidated', evidence: input.evidenceInvalid, source: 'none', unknownReason: 'evidence_invalidated' });
  }
  const denied = input.denied ?? [];
  const acks = input.deniedAcks ?? [];
  const deniedAllAcked = denied.every((_, i) => acks[i] === true);
  if (denied.length === 0) {
    items.push({ key: 'denied', label: 'AI 请求的操作是否都已执行', status: 'verified', evidence: '没有被拒绝的操作', source: 'process' });
  } else {
    const list = denied.map((d) => `${d.command?.join(' ') ?? d.paths?.join('、') ?? d.description}（${d.kind}，风险：${d.risk}）`).join('；');
    items.push({
      key: 'denied',
      label: 'AI 请求的操作是否都已执行',
      status: deniedAllAcked ? 'user_confirmed' : 'pending_user',
      evidence: `有 ${denied.length} 项操作被你拒绝，任务可能不完整：${list}`,
      source: deniedAllAcked ? 'user' : 'none',
    });
  }
  items.push({
    key: 'preview',
    label: '你已经试用过效果',
    status: input.previewed ? 'user_confirmed' : 'pending_user',
    evidence: input.previewed ? '你打开过预览' : '尚未试用',
    source: input.previewed ? 'user' : 'none',
  });
  input.criteria.forEach((c, i) =>
    items.push({
      key: `criterion-${i}`,
      label: c.text,
      status: c.decision === 'confirmed' ? 'user_confirmed' : c.decision === 'rejected' ? 'user_rejected' : 'pending_user',
      evidence: c.decision ? '由你确认' : '等待你确认',
      source: c.decision ? 'user' : 'none',
    }),
  );

  // 验收标准为空时，必须由用户整体确认“我已看过改动，结果符合我的要求”
  if (input.criteria.length === 0) {
    items.push({
      key: 'overall',
      label: '我已看过改动，结果符合我的要求',
      status: input.overallConfirmed ? 'user_confirmed' : 'pending_user',
      evidence: input.overallConfirmed ? '由你确认' : '等待你确认',
      source: input.overallConfirmed ? 'user' : 'none',
    });
  }

  const anyFailed = items.some((i) => i.status === 'failed' || i.status === 'user_rejected');
  const anyInvalidated = items.some((i) => i.status === 'invalidated');
  const anyUnverified = items.some((i) => i.status === 'unverified');
  const anyNotChecked = items.some((i) => i.status === 'not_checked');
  const criteriaDone = input.criteria.length === 0 ? input.overallConfirmed === true : input.criteria.every((c) => c.decision === 'confirmed');
  // 证据失效必须阻断；未执行 / 缺乏证据走「用户明确接受未检查风险」的既有流程，绝不显示为通过
  const readyToSave = !anyFailed && !anyInvalidated && criteriaDone && deniedAllAcked && input.changes.length > 0;

  const headline = anyFailed
    ? '有检查未通过，建议修复或撤销。'
    : anyInvalidated
      ? '检查证据已失效，请重新检查后再保存。'
      : !deniedAllAcked
        ? `有 ${denied.length} 项操作被你拒绝，任务可能不完整，请逐项确认你知晓。`
        : !criteriaDone
          ? '自动检查没有发现问题，请你逐条确认验收标准。'
          : anyUnverified
            ? '有自动检查没有取得可信证据，不能算通过。可以重新检查，或明确接受未检查风险后保存。'
            : anyNotChecked
              ? '可以保存。注意：部分项目未能自动检查。'
              : '所有检查都取得了可信通过证据，可以保存。';

  const card: AcceptanceCard = { items, changes: input.changes, readyToSave, headline };
  if (input.aiSummary) card.aiSummary = input.aiSummary;
  if (input.git) card.git = input.git;
  if (input.acceptedTree) card.acceptedTree = input.acceptedTree;
  if (input.notes?.length) card.notes = input.notes;
  return card;
}

/** 项目使用了外部驱动：不读取任何内容、不运行任何检查，只给出不能自动保存的说明（副本保留，可放弃）。 */
export function blockedCard(reason: string, drivers: string[], git?: GitBinding): AcceptanceCard {
  const card: AcceptanceCard = {
    items: [{ key: 'drivers', label: '项目文件类型受工作台支持', status: 'failed', evidence: `${reason}：${drivers.join('；')}`, source: 'process' }],
    changes: [],
    readyToSave: false,
    headline: `${reason}。AI 的成果仍保留在任务副本中，你可以放弃它。`,
  };
  if (git) card.git = git;
  return card;
}

/** 证据失效 / 缺乏证据时给用户看的固定文案（核心层统一，界面不改写）。 */
export function evidenceStatusText(status: ItemStatus, unknownReason?: string): string {
  if (status === 'invalidated') return '检查证据已失效（任务内容、验收版本或检查配置发生了变化），不能算通过，请重新检查。';
  if (status === 'unverified') {
    switch (unknownReason) {
      case 'test_scope_weakened':
        return '相对任务基线，测试范围被削弱或验证基础设施被修改，自动通过已被阻断。请查看变化并明确重新确认，或恢复测试覆盖。';
      case 'tests_not_executed':
        return '没有执行任何测试用例，不能算通过。';
      case 'all_tests_skipped':
        return '测试全部被跳过，没有真实执行，不能算通过。';
      case 'report_missing':
      case 'report_invalid':
      case 'report_inconsistent':
      case 'report_reused':
        return '结构化测试报告缺失、损坏、不可信或被复用，不能据此判定测试通过。';
      case 'unsupported_test_runner':
        return '这个项目使用的测试运行器尚未适配可信结构化证据采集，只能记录命令结果，不能算通过。';
      default:
        return '命令执行了，但没有取得可信的自动测试证据，不能算通过。';
    }
  }
  if (status === 'not_checked') return '没有执行自动检查（项目没有对应脚本、没有受限运行环境或未授权），因此未检查。';
  return '';
}
