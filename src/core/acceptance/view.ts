import {
  acceptanceVersion,
  type LastSaveSnapshot,
  type SaveProgressStep,
  type Task,
  type TaskRound,
} from '../task/model.js';
import type { TaskState } from '../task/state.js';
import { canFire } from '../task/state.js';
import { MESSAGES, uncheckedReasonText } from '../task/messages.js';
import type { UnavailableReason, UncheckedKind } from '../checks/scripts.js';
import { saveBlockerCodes, type BlockerCode } from '../task/save-rules.js';
import type { OpFail } from '../task/runner.js';
import { summarizeCapabilities } from '../app/permission-text.js';
import { STATE_TEXT } from '../app/task-view.js';
import type { DeniedOperation, ExitOutcome } from '../executor/types.js';
import type { FileChange } from '../git/git.js';
import type { AcceptanceCard } from './card.js';
import { extractIncomplete, type IncompleteReport } from './incomplete.js';
import { buildRoundProof, buildTaskProof, buildTaskProofFromParts, type ProofChangeEntry, type ProofDeniedEntry, type ProofTab, type SingleCheckProof, type TaskProofView, type TestCaseProof } from './proof.js';
import type { ChangePreview } from './snippets.js';
import { deniedImpactText, deniedText, exitFailureText, notCheckedText, safeRelPath, scrubAiText } from './texts.js';

export { acceptanceVersion };
export type { ProofChangeEntry, ProofDeniedEntry, ProofTab, SingleCheckProof, TaskProofView, TestCaseProof };

/**
 * 用户验收视图模型（B4-2 第 1 节，评审 R02）。
 * 渲染层只拿到 UserAcceptanceView：不含底层验收卡、证据原文、命令、Git 错误文本和绝对路径。
 * 所有文案由本文件按状态生成，或取自 messages.ts；原始内容只存在于受保护的诊断记录（.studio/）里。
 */
export type ViewItemStatus = 'verified' | 'not_checked' | 'failed' | 'pending_user';

export interface ViewItem {
  key: string;
  label: string;
  status: ViewItemStatus;
  text: string;
}
export interface ViewChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
  additions: number | null;
  deletions: number | null;
  preview?: ChangePreview;
}
export interface ActionState {
  enabled: boolean;
  reason?: string;
  /** 需要用户先处理的项目文件（相对路径） */
  files?: string[];
  /** 界面突出显示这个按钮 */
  highlight?: boolean;
}
export interface SaveRecordView {
  checked: boolean;
  /** 保存记录界面的检查结论：只显示“检查通过”或“未检查”，不显示命令 */
  checksText: '检查通过' | '未检查';
  uncheckedKind?: UncheckedKind;
  uncheckedConfirmedAt?: string;
  passedCount: number;
  failedCount: number;
  checkedAt?: string;
  savedAt: string;
}

export interface UncheckedConfirmView {
  kind: UncheckedKind;
  unavailableReason?: UnavailableReason;
  reason: string;
  previewButtonText: string;
  confirmButtonText: string;
}

export type AcceptanceStatusKind = 'passed' | 'incomplete' | 'failed';

export interface AcceptanceStatusView {
  kind: AcceptanceStatusKind;
  label: '验收通过' | '验收未完成' | '验收未通过';
  reason: string;
  showSaveButton: boolean;
}

export interface AcceptedRiskView {
  title: string;
  reason: string;
}

export interface RoundSnapshotView {
  round: number;
  isCurrent: boolean;
  startedAtText: string;
  endedAtText: string | null;
  feedback?: string;
  items: ViewItem[];
  changes: ViewChange[];
  criteria: { id: string; text: string; confirmed: boolean; rejected: boolean; note?: string }[];
  overall: { needed: boolean; confirmed: boolean; rejected: boolean; note?: string; text: string };
  denied: { id: string; text: string; impact: string; acked: boolean }[];
  acceptanceStatus: AcceptanceStatusView;
  aiReport: IncompleteReport;
  proof: TaskProofView;
}

export interface ReworkContextView {
  nextRound: number;
  executorText: string;
  permissionSummary: string;
  hasMultipleExecutors: boolean;
}

export type SaveOutcomeKind =
  | 'saved'
  | 'unchecked_needs_confirm'
  | 'checks_failed'
  | 'conflict'
  | 'project_changed'
  | 'failed_restored'
  | 'manual_review'
  | 'project_locked'
  | 'blocked';

export type SaveOutcomeButtonAction =
  | 'done'
  | 'view_history'
  | 'open_preview'
  | 'save_unchecked'
  | 'rework'
  | 'open_proof'
  | 'open_conflict'
  | 'retry_save'
  | 'reveal_project'
  | 'copy_summary'
  | 'open_blocking_task'
  | 'recheck';

export interface SaveOutcomeButton {
  action: SaveOutcomeButtonAction;
  label: string;
  primary?: boolean;
  proofTab?: ProofTab;
  targetTaskId?: string;
}

export interface SaveFailedCheckSummary {
  key: 'build' | 'test';
  label: string;
  summary: string;
}

export interface SaveOutcomeView {
  reason: string;
  kind: SaveOutcomeKind;
  tag: string;
  warn: boolean;
  headline: string;
  files?: string[];
  failedChecks?: SaveFailedCheckSummary[];
  saveSteps: SaveProgressStep[];
  buttons: SaveOutcomeButton[];
  extraNote?: string;
  blockingTaskId?: string;
  blockingTaskGoal?: string;
}

export interface UserAcceptanceView {
  taskId: string;
  goal: string;
  state: TaskState;
  stateText: string;
  verdict: string;
  acceptanceStatus: AcceptanceStatusView;
  items: ViewItem[];
  changes: ViewChange[];
  criteria: { id: string; text: string; confirmed: boolean; rejected: boolean; note?: string }[];
  /** 没有验收标准时，用户对“我已看过改动，结果符合我的要求”的整体确认 */
  overall: { needed: boolean; confirmed: boolean; rejected: boolean; note?: string; text: string };
  /** 被拦下的操作：只能逐条确认知晓 */
  denied: { id: string; text: string; impact: string; acked: boolean }[];
  notes: string[];
  /** 阶段 5 预留：用户确认并驳回评审意见后保留下来的已知风险 */
  acceptedRisks: AcceptedRiskView[];
  /** AI 自己报告没做成的事（只是 AI 的说法，已隐去命令与本机路径） */
  aiReport: IncompleteReport;
  unexpectedRequests: number;
  actions: { save: ActionState; discard: ActionState; recheck: ActionState; undo: ActionState; retryCleanup: ActionState };
  reworkAction: ActionState;
  confirmTexts: { discard: string; undo: string; save: string | null };
  /** 项目状态异常：禁止一切写操作，只读 */
  readOnly: boolean;
  /** 同一任务有操作进行中（含刚结束、记录还在收尾）：界面稍后会重新取一次视图 */
  busy: boolean;
  /** 启动核对修正过：一句话说明；否则 null */
  reconciled: string | null;
  /** 可复制的诊断摘要：只含任务编号、状态、时间与上面的固定文案 */
  diagnosticSummary: string;
  /** 验收版本：确认、保存等请求必须带上它，不一致一律拒绝 */
  version: string;
  /** 保存记录里的检查信息（不含任何命令或底层哈希） */
  saveRecord: SaveRecordView | null;
  /** 最近一次保存返回“未检查待确认”且验收版本一致时的界面确认信息与按钮文案 */
  uncheckedConfirm: UncheckedConfirmView | null;
  /** 检查依据详情页数据（按当前轮次绑定，已做命令行/环境变量/密钥/~路径过滤） */
  proof: TaskProofView;
  /** 最近一次保存尝试失败时的试检查依据（供 #10-save-result 查看失败项跳转到 #08-evidence） */
  trialProof: TaskProofView | null;
  /** 最近一次保存尝试的结果视图（#10-save-result：含四步进度与单结果状态与按钮） */
  saveOutcome: SaveOutcomeView | null;
  /** 当前轮次编号与各轮独立记录（多轮可切换对照） */
  currentRound: number;
  rounds: RoundSnapshotView[];
  rework: ReworkContextView;
  /** 成果预览信息（步骤 ①） */
  preview: {
    kind: 'web' | 'finder' | null;
    buttonText: string;
    completed: boolean;
    skipped?: boolean;
  };
}

/** view.ts 新增文案（待规划会话审定）。其余文案取自 messages.ts。 */
export const VIEW_TEXT = {
  verdictReady: '所有检查都已通过，可以保存。',
  verdictReadyUnchecked: '可以保存。注意：部分项目没有自动检查。',
  verdictChecksFailed: '有检查未通过，还不能保存。',
  verdictNotReady: (reason: string) => `还不能保存：${reason}`,
  previewNone: '尚未提供预览，保存后自己打开看看，不满意可以撤销。',
  deniedSome: (n: number) => `有 ${n} 项操作被拦下，任务可能不完整，请逐条确认你知晓。`,
  deniedAcked: (n: number) => `有 ${n} 项操作被拦下，你都已确认知晓。`,
  deniedNone: '没有被拦下的操作。',
  changesSome: (n: number) => `${n} 个文件发生变化`,
  changesNone: '没有任何文件被修改',
  exitOk: '正常结束',
  checkPassed: (name: string, sec: number | null) => `项目自带的${name}全部通过${sec === null ? '' : `（${sec} 秒）`}`,
  checkFailed: (name: string) => `项目自带的${name}没有通过`,
  checkVoid: '检查改动了文件，检查结果已作废，请重新检查。',
  unexpected: '出现了意外的权限请求，已自动拦下。',
  saveSupersedes: '保存后，上一次保存就不能单独撤销了。',
  undoNeedsCleanup: '临时文件还没清理干净，请先重试清理。',
  noUndo: '这个任务没有可以撤销的保存。',
  noDiscard: '这个任务现在不能放弃。',
  noSave: '现在没有可保存的内容。',
  noRecheck: '现在不需要重新检查。',
  rechecked: '已重新检查。之前的确认已清空，请重新确认。',
  invalidArgument: '无效的参数。',
  noCleanup: '没有需要清理的临时文件。',
  discardConfirm: '确定要放弃吗？',
  undoConfirm: '确定要撤销这次保存吗？项目会回到保存之前的样子。',
  cleanupNeeded: '临时文件需要处理，请点“重试清理”。',
  isolation: '施工环境的隔离出现异常，工作台不允许保存。',
  uncheckedOpenPreview: '打开预览',
  uncheckedSaveAnyway: '仍然保存',
  blockers: {
    no_card: '验收内容还没有准备好，请点“重新检查”。',
    external_driver: MESSAGES.externalDriver,
    exec_not_ok: 'AI 的执行没有正常结束。',
    build_failed: '项目构建没有通过。',
    test_failed: '自动测试没有通过。',
    isolation: '施工环境的隔离出现异常，工作台不允许保存。',
    denied_unacked: '有被拦下的操作，请逐条确认你知晓。',
    overall_unconfirmed: '请先确认“我已看过改动，结果符合我的要求”。',
    criteria_unconfirmed: '请逐条确认验收标准。',
    no_changes: '没有任何文件被修改，没有可保存的内容。',
    not_frozen: '验收内容还没有准备好，请点“重新检查”。',
  } satisfies Record<BlockerCode, string>,
} as const;

const ITEM_LABEL: Record<string, string> = {
  exit: 'AI 执行过程正常结束',
  changes: '有实际文件改动',
  build: '项目能成功构建',
  test: '自动测试通过',
  checks_modified: '检查是否改动了文件',
  denied: 'AI 请求的操作是否都已执行',
  preview: '你已经试用过效果',
  drivers: '项目文件类型受工作台支持',
};

const CHECK_NAME = { build: '构建', test: '测试' } as const;
const VERSION_RE = /^[0-9a-f]{12}-\d{1,6}$/;

export const isVersionFormat = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v);

/** 任务用过额外文件夹或完全信任：AI 可能在任务副本以外做过修改，工作台无法撤销 */
export function hasExternalImpact(t: Task): boolean {
  const caps = t.plan?.capabilities;
  return !!caps && (caps.extraWritableDirs.length > 0 || caps.constructionMode === 'full_trust');
}

const mapStatus = (s: string): ViewItemStatus => (s === 'verified' || s === 'user_confirmed' ? 'verified' : s === 'failed' || s === 'user_rejected' ? 'failed' : s === 'not_checked' ? 'not_checked' : 'pending_user');

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 核心层返回给界面的失败信息 → 固定文案。未知原因一律用 messages 里的固定文案，不透传核心层的文字。 */
export function mapFailure(f: OpFail): { message: string; files?: string[] } {
  const files = f.files?.map(safeRelPath).filter((x): x is string => !!x);
  const withFiles = (message: string) => ({ message, ...(files?.length ? { files } : {}) });
  switch (f.reason) {
    case 'busy': return withFiles(MESSAGES.busy);
    case 'not_ready': return withFiles(MESSAGES.notReady);
    case 'not_allowed': return withFiles(VIEW_TEXT.noDiscard);
    case 'repo_changed': return withFiles(MESSAGES.repoChanged);
    case 'branch_changed': return withFiles(MESSAGES.branchChanged);
    case 'dirty_main': return withFiles(MESSAGES.dirtyMain);
    case 'external_driver': return withFiles(MESSAGES.externalDriver);
    case 'acceptance_invalid': return withFiles(MESSAGES.acceptanceInvalid);
    case 'conflict': return withFiles(MESSAGES.conflict);
    case 'checks_failed': {
      const names = (f.failedChecks ?? []).map((k) => CHECK_NAME[k]).filter(Boolean);
      return withFiles(names.length ? `合并后自动检查未通过（${names.join('、')}），本次没有保存，你的项目保持原样。` : MESSAGES.checksFailed);
    }
    case 'unchecked_needs_confirm':
      return withFiles(
        f.uncheckedKind ? uncheckedReasonText(f.uncheckedKind, f.unavailableReason) : MESSAGES.uncheckedNeedsConfirm,
      );
    case 'project_changed': return withFiles(MESSAGES.projectChanged);
    case 'failed_restored': return withFiles(MESSAGES.failedRestored);
    case 'project_locked': {
      const name = f.blockingTask ? scrubAiText(f.blockingTask) : '';
      return withFiles(
        name
          ? `项目中有任务「${name}」处于异常状态（恢复未确认），请先处理那个任务后再保存或撤销。`
          : MESSAGES.projectLocked,
      );
    }
    case 'abnormal': return withFiles(MESSAGES.abnormal);
    case 'undo_refused':
      if (f.blockingSaves?.length) {
        const items = f.blockingSaves
          .map((b) => `「${scrubAiText(b.goal)}」（${formatShortTime(b.savedAt)}）`)
          .join('、');
        return withFiles(`在这次保存之后，还有后来的保存挡住了它，暂时不能只撤销这一项：${items}。`);
      }
      return withFiles(MESSAGES.undoRefused);
    case 'cleanup_pending': return withFiles(f.detail === MESSAGES.saveCleanupPending || f.detail === MESSAGES.discardCleanupPending || f.detail === MESSAGES.cleanupBusy ? f.detail : VIEW_TEXT.cleanupNeeded);
    case 'failed': return withFiles(MESSAGES.opFailed);
    default: return withFiles(MESSAGES.unknownError);
  }
}

/** 操作成功后给用户的提示（按任务的新状态生成；用过额外文件夹或完全信任时追加无法撤销的说明） */
export function okMessage(t: Task): string {
  const extra = hasExternalImpact(t);
  switch (t.state) {
    case 'saved': return MESSAGES.saved;
    case 'saved_cleanup_pending': return `${MESSAGES.saved}${MESSAGES.saveCleanupPending}`;
    case 'discarded': return extra ? `${MESSAGES.discardDone}${MESSAGES.discardExtra}` : MESSAGES.discardDone;
    case 'discard_cleanup_pending': return MESSAGES.discardCleanupPending;
    case 'undone': return extra ? `${MESSAGES.undone}${MESSAGES.undoExtra}` : MESSAGES.undone;
    default: return '';
  }
}

export interface ViewContext {
  /** 同一任务有操作进行中 */
  busy: boolean;
  /** 项目根目录（供过滤检查输出中的绝对路径，不会直接传到渲染层） */
  repoPath?: string;
  /** 改动片段（只有验收阶段才有） */
  previews?: Map<string, ChangePreview>;
  /** 历史各轮的改动片段（按轮次索引） */
  roundPreviews?: Map<number, Map<string, ChangePreview>>;
  /** 保存的只读预判：null = 目前可以保存；undefined = 没有判断 */
  saveCheck?: OpFail | null;
  /** 撤销的只读预判，含义同上 */
  undoCheck?: OpFail | null;
  /** 同项目还有其他已保存、仍可单独撤销的任务 */
  otherUndoableSave?: boolean;
  /** 成果预览类型（web 或 finder） */
  previewKind?: 'web' | 'finder' | null;
  /** 成果预览按钮文案 */
  previewButtonText?: string;
}

const off = (reason: string, extra: Partial<ActionState> = {}): ActionState => ({ enabled: false, reason, ...extra });
const on = (extra: Partial<ActionState> = {}): ActionState => ({ enabled: true, ...extra });

function verdictFor(t: Task, blockers: BlockerCode[], saveFail: { message: string } | null, anyFailed: boolean, anyUnchecked: boolean): string {
  if (t.manualReview) return MESSAGES.abnormal;
  switch (t.state) {
    case 'saved':
      return t.saveRecord?.checked === true ? `${MESSAGES.saved}检查通过。` : `${MESSAGES.saved}未检查。`;
    case 'saved_cleanup_pending': {
      const checkLabel = t.saveRecord?.checked === true ? '检查通过' : '未检查';
      return `${MESSAGES.saved}${MESSAGES.saveCleanupPending}（${checkLabel}）`;
    }
    case 'discarded': return MESSAGES.discardDone;
    case 'discard_cleanup_pending': return MESSAGES.discardCleanupPending;
    case 'undone': return MESSAGES.undone;
    case 'undo_failed': return MESSAGES.opFailed;
    case 'save_failed_unmerged': return MESSAGES.conflict;
    case 'reviewing': {
      if (blockers.includes('external_driver')) return VIEW_TEXT.blockers.external_driver;
      if (anyFailed) return VIEW_TEXT.verdictChecksFailed;
      if (blockers.length) return VIEW_TEXT.verdictNotReady(VIEW_TEXT.blockers[blockers[0]!]);
      if (saveFail) return VIEW_TEXT.verdictNotReady(saveFail.message);
      return anyUnchecked ? VIEW_TEXT.verdictReadyUnchecked : VIEW_TEXT.verdictReady;
    }
    default: return STATE_TEXT[t.state];
  }
}

/** 核心层计算验收状态：验收通过 / 验收未完成 / 验收未通过（v1.0 不做部分通过） */
export function computeAcceptanceStatus(
  t: Pick<Task, 'state' | 'manualReview' | 'criteria' | 'overallConfirmed' | 'overallDecision'>,
  opts: { save: ActionState; deniedAllAcked: boolean; anyUnchecked: boolean; verdict: string; showSaveWhenOpen?: boolean },
): AcceptanceStatusView {
  if (t.manualReview) {
    return { kind: 'incomplete', label: '验收未完成', reason: MESSAGES.abnormal, showSaveButton: false };
  }
  const hasCriteria = t.criteria.length > 0;
  const anyRejected = hasCriteria ? t.criteria.some((c) => c.decision === 'rejected') : t.overallDecision === 'rejected';
  if (anyRejected) {
    return {
      kind: 'failed',
      label: '验收未通过',
      reason: '有验收标准被判为「不符合」，请退回修改或放弃；必须全部符合后才能保存。',
      showSaveButton: false,
    };
  }
  const remaining = hasCriteria ? t.criteria.filter((c) => c.decision !== 'confirmed').length : t.overallConfirmed === true ? 0 : 1;
  if (remaining > 0) {
    return {
      kind: 'incomplete',
      label: '验收未完成',
      reason: hasCriteria ? `还有 ${remaining} 条验收标准没确认` : VIEW_TEXT.blockers.overall_unconfirmed,
      showSaveButton: opts.showSaveWhenOpen ?? true,
    };
  }
  if (!opts.deniedAllAcked) {
    return {
      kind: 'incomplete',
      label: '验收未完成',
      reason: VIEW_TEXT.blockers.denied_unacked,
      showSaveButton: opts.showSaveWhenOpen ?? true,
    };
  }
  if (t.state === 'reviewing' && opts.save.enabled) {
    return {
      kind: 'passed',
      label: '验收通过',
      reason: opts.anyUnchecked ? '每条验收标准已确认「符合」（注意：部分自动检查未运行）。' : '每条验收标准已确认「符合」，可以保存到项目。',
      showSaveButton: opts.showSaveWhenOpen ?? true,
    };
  }
  return {
    kind: 'incomplete',
    label: '验收未完成',
    reason: opts.save.reason ?? opts.verdict,
    showSaveButton: opts.showSaveWhenOpen ?? t.state === 'reviewing',
  };
}

function mapCardItems(
  card: AcceptanceCard | undefined,
  exit: ExitOutcome | undefined,
  denied: DeniedOperation[],
  acks: boolean[],
): ViewItem[] {
  const items: ViewItem[] = [];
  for (const it of card?.items ?? []) {
    if (it.key.startsWith('criterion-') || it.key === 'overall') continue; // 单独呈现
    const label = ITEM_LABEL[it.key];
    if (!label) continue;
    const status = mapStatus(it.status);
    let text: string;
    switch (it.key) {
      case 'exit': text = status === 'verified' ? VIEW_TEXT.exitOk : exitFailureText(exit); break;
      case 'changes': text = status === 'verified' ? VIEW_TEXT.changesSome(card!.changes.length) : VIEW_TEXT.changesNone; break;
      case 'build':
      case 'test': {
        const name = CHECK_NAME[it.key];
        if (status === 'verified') {
          const m = it.evidence.match(/（(\d{1,6}) 秒）/); // 只取数字
          text = VIEW_TEXT.checkPassed(name, m ? Number(m[1]) : null);
        } else if (status === 'failed') text = VIEW_TEXT.checkFailed(name);
        else text = notCheckedText(it.key, it.evidence);
        break;
      }
      case 'checks_modified': text = MESSAGES.checksModified; break;
      case 'denied':
        text = denied.length === 0 ? VIEW_TEXT.deniedNone : status === 'verified' ? VIEW_TEXT.deniedAcked(denied.length) : VIEW_TEXT.deniedSome(denied.length);
        break;
      case 'preview': text = VIEW_TEXT.previewNone; break;
      case 'drivers': text = MESSAGES.externalDriver; break;
      default: text = '';
    }
    // 预览从未提供：不能标成“等你确认”，如实写“未检查”
    items.push({ key: it.key, label, status: it.key === 'preview' ? 'not_checked' : status, text });
  }
  return items;
}

function mapChanges(changes: FileChange[] | undefined, previews: Map<string, ChangePreview> | undefined): ViewChange[] {
  return (changes ?? []).map((c) => {
    const preview = previews?.get(c.path);
    return {
      path: safeRelPath(c.path) ?? '（路径不可显示）',
      kind: c.status,
      additions: c.additions,
      deletions: c.deletions,
      ...(preview ? { preview } : {}),
    };
  });
}

function mapAiReport(aiMessages: string[], exit: ExitOutcome | undefined, denied: DeniedOperation[]): IncompleteReport {
  const incompleteSignals = !!exit && (exit.kind !== 'exited' || exit.code !== 0 || denied.length > 0);
  const rawReport = extractIncomplete(aiMessages, { incompleteSignals });
  if (rawReport.kind === 'items') return { kind: 'items', items: rawReport.items.map(scrubAiText) };
  if (rawReport.kind === 'raw') return { kind: 'raw', text: scrubAiText(rawReport.text) };
  return rawReport;
}

function formatExecutorLabel(t: Pick<Task, 'executorName' | 'executorId' | 'model' | 'timeline'>): string {
  const name = t.executorName ?? (t.executorId === 'fake' ? '模拟执行体（测试用）' : 'Codex');
  const modelFromTimeline = t.timeline.find((e) => e.kind === 'isolation' && e.text.includes('模型='))
    ?.text.match(/模型=([^，；\s]+)/)?.[1];
  const model = t.model ?? (modelFromTimeline && modelFromTimeline !== '未知' ? modelFromTimeline : undefined);
  return model ? `${name} · ${model}` : name;
}

function buildRoundSnapshot(
  t: Task,
  r: TaskRound,
  ctx: ViewContext,
): RoundSnapshotView {
  const roundDenied = r.denied ?? [];
  const roundAcks = r.deniedAcks ?? [];
  const items = mapCardItems(r.card, r.exit, roundDenied, roundAcks);
  const anyUnchecked = items.some((i) => i.status === 'not_checked' && i.key !== 'preview');
  const deniedAllAcked = roundDenied.every((_, i) => roundAcks[i] === true);
  const acceptanceStatus = computeAcceptanceStatus(
    {
      state: t.state,
      manualReview: t.manualReview,
      criteria: r.criteria.map((c) => ({ text: c.text, ...(c.decision ? { decision: c.decision } : {}), ...(c.note ? { note: c.note } : {}) })),
      overallConfirmed: r.overallConfirmed,
      overallDecision: r.overallDecision,
    },
    {
      save: r.card?.items.some((i) => i.status === 'failed') ? off(VIEW_TEXT.verdictChecksFailed) : on(),
      deniedAllAcked,
      anyUnchecked,
      verdict: r.card?.headline ?? '',
      showSaveWhenOpen: false,
    },
  );
  return {
    round: r.round,
    isCurrent: false,
    startedAtText: formatShortTime(r.startedAt),
    endedAtText: r.endedAt ? formatShortTime(r.endedAt) : null,
    ...(r.feedback ? { feedback: scrubAiText(r.feedback) } : {}),
    items,
    changes: mapChanges(r.card?.changes, ctx.roundPreviews?.get(r.round)),
    criteria: r.criteria.map((c, i) => ({
      id: `c${i}`,
      text: c.text,
      confirmed: c.decision === 'confirmed',
      rejected: c.decision === 'rejected',
      ...(c.note ? { note: scrubAiText(c.note) } : {}),
    })),
    overall: {
      needed: r.criteria.length === 0 && !!r.card,
      confirmed: r.overallConfirmed === true,
      rejected: r.overallDecision === 'rejected',
      ...(r.overallNote ? { note: scrubAiText(r.overallNote) } : {}),
      text: '我已看过改动，结果符合我的要求',
    },
    denied: roundDenied.map((d, i) => ({ id: `d${i}`, text: deniedText(d), impact: deniedImpactText(d), acked: roundAcks[i] === true })),
    acceptanceStatus: { ...acceptanceStatus, showSaveButton: false },
    aiReport: mapAiReport(r.aiMessages ?? [], r.exit, roundDenied),
    proof: buildRoundProof(t, r, {
      ...(ctx.roundPreviews?.get(r.round) ? { previews: ctx.roundPreviews.get(r.round) } : {}),
      ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
    }),
  };
}

export function toUserView(t: Task, ctx: ViewContext = { busy: false }): UserAcceptanceView {
  const card = t.card;
  const denied = t.denied ?? [];
  const acks = t.deniedAcks ?? [];
  const items = mapCardItems(card, t.exit, denied, acks);

  const blockers = t.state === 'reviewing' || t.state === 'save_failed_unmerged' ? saveBlockerCodes(t) : [];
  const anyFailed = items.some((i) => i.status === 'failed');
  const anyUnchecked = items.some((i) => i.status === 'not_checked' && i.key !== 'preview');
  const saveFail = ctx.saveCheck ? mapFailure(ctx.saveCheck) : null;

  const changes = mapChanges(card?.changes, ctx.previews);

  const unexpected = denied.filter((d) => d.anomaly).length;
  const notes: string[] = [];
  if (t.customCommitChecks) notes.push(MESSAGES.skippedCommitChecks);
  if (unexpected > 0) notes.push(VIEW_TEXT.unexpected);

  const currentRound = t.currentRound ?? (t.rounds?.length ? Math.max(...t.rounds.map((r) => r.round)) : 1);
  const currentStoredRound = t.rounds?.find((r) => r.round === currentRound);
  const aiMessages = currentStoredRound?.aiMessages?.length
    ? currentStoredRound.aiMessages
    : t.timeline.filter((e) => e.kind === 'message' && e.source !== 'host').map((e) => e.text);
  const aiReport = mapAiReport(aiMessages, t.exit, denied);

  // ───── 操作按钮 ─────
  const readOnly = !!t.manualReview;
  const lock = readOnly ? MESSAGES.abnormal : ctx.busy ? MESSAGES.busy : null;
  const state = t.state;
  const reviewing = state === 'reviewing';

  let save: ActionState;
  if (lock) save = off(lock);
  else if (reviewing) {
    if (blockers.length) save = off(VIEW_TEXT.blockers[blockers[0]!]);
    else if (saveFail) save = off(saveFail.message, { ...(saveFail.files ? { files: saveFail.files } : {}) });
    else save = on();
  } else if (state === 'save_failed_unmerged') save = off(MESSAGES.conflict);
  else save = off(VIEW_TEXT.noSave);

  const discard: ActionState = lock ? off(lock) : canFire(state, 'discard') ? on() : off(VIEW_TEXT.noDiscard);

  const acceptanceInvalid = ctx.saveCheck?.reason === 'acceptance_invalid';
  const recheck: ActionState = lock ? off(lock) : reviewing ? on(acceptanceInvalid || !!t.checksVoid ? { highlight: true } : {}) : off(VIEW_TEXT.noRecheck);

  let undo: ActionState;
  if (lock) undo = off(lock);
  else if (state === 'saved_cleanup_pending') undo = off(VIEW_TEXT.undoNeedsCleanup);
  else if (state === 'saved' || state === 'undo_failed') {
    if (ctx.undoCheck) {
      const m = mapFailure(ctx.undoCheck);
      undo = off(m.message, { ...(m.files ? { files: m.files } : {}) });
    } else undo = on();
  } else undo = off(VIEW_TEXT.noUndo);

  const retryCleanup: ActionState = lock ? off(lock) : state === 'saved_cleanup_pending' || state === 'discard_cleanup_pending' ? on() : off(VIEW_TEXT.noCleanup);
  const hasDrivers = !!card?.items.some((i) => i.key === 'drivers');
  const reworkAction: ActionState = lock
    ? off(lock)
    : !reviewing
      ? off(VIEW_TEXT.noSave)
      : hasDrivers
        ? off(MESSAGES.externalDriver)
        : !t.worktree?.path
          ? off('任务副本不存在，不能退回修改。')
          : on();

  const extra = hasExternalImpact(t);
  const verdict = verdictFor(t, blockers, saveFail, anyFailed, anyUnchecked);
  const deniedAllAcked = denied.every((_, i) => acks[i] === true);
  const acceptanceStatus = computeAcceptanceStatus(t, { save, deniedAllAcked, anyUnchecked, verdict });
  const acceptedRisks: AcceptedRiskView[] = (t.acceptedRisks ?? [])
    .filter((r) => typeof r?.title === 'string' && r.title.trim())
    .map((r) => ({ title: scrubAiText(r.title), reason: scrubAiText(r.reason ?? '') }));
  const summary = [
    `任务编号：${t.id}`,
    `状态：${STATE_TEXT[t.state]}`,
    `更新时间：${t.updatedAt}`,
    `说明：${verdict}`,
    ...(readOnly ? [`提示：${MESSAGES.abnormal}`] : []),
  ].join('\n');

  const currentVersion = acceptanceVersion(t);
  const uncheckedConfirm: UncheckedConfirmView | null =
    !readOnly &&
    reviewing &&
    blockers.length === 0 &&
    !saveFail &&
    t.uncheckedConfirm &&
    t.uncheckedConfirm.version === currentVersion
      ? {
          kind: t.uncheckedConfirm.kind,
          ...(t.uncheckedConfirm.unavailableReason ? { unavailableReason: t.uncheckedConfirm.unavailableReason } : {}),
          reason: uncheckedReasonText(t.uncheckedConfirm.kind, t.uncheckedConfirm.unavailableReason),
          previewButtonText: VIEW_TEXT.uncheckedOpenPreview,
          confirmButtonText: VIEW_TEXT.uncheckedSaveAnyway,
        }
      : null;

  const proof = buildTaskProof(t, {
    ...(ctx.previews ? { previews: ctx.previews } : {}),
    ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
  });
  const trialProof =
    t.trialChecks?.length && t.lastSave?.reason === 'checks_failed'
      ? buildTaskProofFromParts({
          round: currentRound,
          checks: t.trialChecks,
          denied,
          deniedAcks: acks,
          changes: card?.changes ?? [],
          previews: ctx.previews,
          constructionMode: t.plan?.capabilities.constructionMode,
          fallbackTime: t.lastSave.at,
          filterOpts: {
            ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
            ...(t.worktree?.path ? { worktreePath: t.worktree.path } : {}),
          },
        })
      : null;

  let effectiveLastSave: LastSaveSnapshot | null = t.lastSave ?? null;
  if (effectiveLastSave?.reason === 'unchecked_needs_confirm' && !uncheckedConfirm) {
    effectiveLastSave = null;
  } else if (!effectiveLastSave && uncheckedConfirm && t.uncheckedConfirm) {
    effectiveLastSave = {
      reason: 'unchecked_needs_confirm',
      at: t.uncheckedConfirm.at,
      saveSteps: defaultSaveSteps(),
      uncheckedKind: uncheckedConfirm.kind,
      ...(uncheckedConfirm.unavailableReason ? { unavailableReason: uncheckedConfirm.unavailableReason } : {}),
    };
  } else if (effectiveLastSave?.reason === 'project_locked' && ctx.saveCheck?.reason !== 'project_locked') {
    effectiveLastSave = null;
  } else if (['undone', 'discarded', 'discard_cleanup_pending'].includes(state)) {
    effectiveLastSave = null;
  }
  const saveOutcome =
    t.manualReview && (!effectiveLastSave || effectiveLastSave.reason !== 'abnormal')
      ? buildSaveOutcomeView({
          reason: 'abnormal',
          at: t.manualReview.at,
          saveSteps: effectiveLastSave?.saveSteps ?? defaultSaveSteps(),
          ...(t.manualReview.files ? { files: t.manualReview.files } : {}),
        })
      : ctx.saveCheck?.reason === 'project_locked' && (!effectiveLastSave || effectiveLastSave.reason === 'project_locked')
        ? buildSaveOutcomeFromFail(ctx.saveCheck)
        : effectiveLastSave
          ? buildSaveOutcomeView(effectiveLastSave)
          : null;

  const needsOverall = t.criteria.length === 0;
  const criteriaViews = t.criteria.map((c, i) => ({
    id: `c${i}`,
    text: c.text,
    confirmed: c.decision === 'confirmed',
    rejected: c.decision === 'rejected',
    ...(c.note ? { note: scrubAiText(c.note) } : {}),
  }));
  const overallView = {
    needed: needsOverall && !!card,
    confirmed: t.overallConfirmed === true,
    rejected: t.overallDecision === 'rejected',
    ...(t.overallNote ? { note: scrubAiText(t.overallNote) } : {}),
    text: '我已看过改动，结果符合我的要求',
  };
  const deniedViews = denied.map((d, i) => ({ id: `d${i}`, text: deniedText(d), impact: deniedImpactText(d), acked: acks[i] === true }));
  const currentSnapshot: RoundSnapshotView = {
    round: currentRound,
    isCurrent: true,
    startedAtText: formatShortTime(currentStoredRound?.startedAt ?? t.roundStartedAt ?? t.createdAt),
    endedAtText: (currentStoredRound?.endedAt ?? t.roundEndedAt) ? formatShortTime((currentStoredRound?.endedAt ?? t.roundEndedAt)!) : null,
    ...(currentStoredRound?.feedback ? { feedback: scrubAiText(currentStoredRound.feedback) } : {}),
    items,
    changes,
    criteria: criteriaViews,
    overall: overallView,
    denied: deniedViews,
    acceptanceStatus,
    aiReport,
    proof,
  };
  const historicalSnapshots = (t.rounds ?? [])
    .filter((r) => r.round !== currentRound)
    .sort((a, b) => a.round - b.round)
    .map((r) => buildRoundSnapshot(t, r, ctx));
  const rounds = [...historicalSnapshots, currentSnapshot].sort((a, b) => a.round - b.round);

  return {
    taskId: t.id,
    goal: t.plan?.goal ?? t.request,
    state,
    stateText: STATE_TEXT[state],
    verdict,
    acceptanceStatus,
    items,
    changes,
    criteria: criteriaViews,
    overall: overallView,
    denied: deniedViews,
    notes,
    acceptedRisks,
    aiReport,
    unexpectedRequests: unexpected,
    actions: { save, discard, recheck, undo, retryCleanup },
    reworkAction,
    confirmTexts: {
      discard: `${VIEW_TEXT.discardConfirm}${MESSAGES.discardDone}${extra ? MESSAGES.discardExtra : ''}`,
      undo: `${VIEW_TEXT.undoConfirm}${extra ? MESSAGES.undoExtra : ''}`,
      save: ctx.otherUndoableSave ? VIEW_TEXT.saveSupersedes : null,
    },
    readOnly,
    busy: ctx.busy,
    reconciled: t.reconciled ? `已核对：${t.reconciled.note}` : null,
    diagnosticSummary: summary,
    version: currentVersion,
    saveRecord: t.saveRecord
      ? {
          checked: t.saveRecord.checked === true,
          checksText: t.saveRecord.checked === true ? '检查通过' : '未检查',
          ...(t.saveRecord.checked !== true && t.saveRecord.uncheckedKind ? { uncheckedKind: t.saveRecord.uncheckedKind } : {}),
          ...(t.saveRecord.checked !== true && t.saveRecord.uncheckedConfirmedAt ? { uncheckedConfirmedAt: t.saveRecord.uncheckedConfirmedAt } : {}),
          passedCount: t.saveRecord.checksSummary?.passed ?? 0,
          failedCount: t.saveRecord.checksSummary?.failed ?? 0,
          ...(t.saveRecord.checkedAt ? { checkedAt: t.saveRecord.checkedAt } : {}),
          savedAt: t.saveRecord.savedAt,
        }
      : null,
    uncheckedConfirm,
    proof,
    trialProof,
    saveOutcome,
    currentRound,
    rounds,
    rework: {
      nextRound: currentRound + 1,
      executorText: formatExecutorLabel(t),
      permissionSummary: summarizeCapabilities(t.plan?.capabilities),
      hasMultipleExecutors: false,
    },
    preview: {
      kind: ctx.previewKind !== undefined ? ctx.previewKind : (t.worktree?.path ? 'finder' : null),
      buttonText: ctx.previewButtonText ?? ((ctx.previewKind ?? (t.worktree?.path ? 'finder' : null)) === 'web' ? '在浏览器中打开预览' : '在访达中显示'),
      completed: !!t.previewed || !!t.previewSkipped,
      skipped: !t.previewed && !!t.previewSkipped,
    },
  };
}

export function defaultSaveSteps(): SaveProgressStep[] {
  return [
    { key: 'check_changes', label: '检查项目在验收期间是否有变化', status: 'pending' },
    { key: 'trial_merge', label: '合并两边的改动', status: 'pending' },
    { key: 'trial_checks', label: '合并后重新运行检查', status: 'pending' },
    { key: 'final_verify', label: '写入前再确认一次', status: 'pending' },
  ];
}

/** 把保存 / 撤销核心快照转换成 #10-save-result 视图（所有文案、按钮和出现条件均由核心层下发）。 */
export function buildSaveOutcomeView(
  snap: LastSaveSnapshot,
  opts: { isUndo?: boolean; failOverride?: OpFail } = {},
): SaveOutcomeView {
  const saveSteps = snap.saveSteps?.length ? snap.saveSteps : defaultSaveSteps();
  switch (snap.reason) {
    case 'saved':
      return {
        reason: 'saved',
        kind: 'saved',
        tag: '已保存',
        warn: false,
        headline: snap.cleanupPending
          ? '已保存。可以在保存记录里撤销；临时文件还没清理干净，请点「重试清理」。'
          : '已保存。可以在保存记录里撤销',
        saveSteps,
        buttons: [
          { action: 'done', label: '完成', primary: true },
          { action: 'view_history', label: '查看保存记录' },
        ],
      };
    case 'unchecked_needs_confirm':
      return {
        reason: 'unchecked_needs_confirm',
        kind: 'unchecked_needs_confirm',
        tag: '未检查',
        warn: false,
        headline: snap.uncheckedKind
          ? uncheckedReasonText(snap.uncheckedKind, snap.unavailableReason)
          : MESSAGES.uncheckedNeedsConfirm,
        saveSteps,
        buttons: [
          { action: 'open_preview', label: VIEW_TEXT.uncheckedOpenPreview, primary: true },
          { action: 'save_unchecked', label: VIEW_TEXT.uncheckedSaveAnyway },
        ],
      };
    case 'checks_failed': {
      const checks = snap.failedChecks ?? ['test'];
      const totalN = snap.totalFailedItems ?? Math.max(1, checks.length);
      const failedChecks: SaveFailedCheckSummary[] = checks.map((k) => {
        const cnt = k === 'test' ? snap.failedCheckCounts?.test : snap.failedCheckCounts?.build;
        return {
          key: k,
          label: k === 'build' ? '构建检查' : '自动测试',
          summary: k === 'build' ? '构建未通过' : cnt && cnt > 0 ? `${cnt} 项测试未通过` : '测试未通过',
        };
      });
      return {
        reason: 'checks_failed',
        kind: 'checks_failed',
        tag: '检查失败',
        warn: true,
        headline: `合并后有 ${totalN} 项检查没通过，没有保存，你的项目没有变化`,
        failedChecks,
        saveSteps,
        buttons: [
          { action: 'rework', label: '退回修改', primary: true },
          ...failedChecks.map((fc) => ({ action: 'open_proof' as const, label: `查看${fc.label}依据`, proofTab: fc.key as ProofTab })),
        ],
      };
    }
    case 'conflict':
      return {
        reason: 'conflict',
        kind: 'conflict',
        tag: '冲突',
        warn: true,
        headline: '两个任务改了同一处，无法自动合并，没有保存',
        saveSteps,
        buttons: [{ action: 'open_conflict', label: '看看怎么处理', primary: true }],
      };
    case 'project_changed':
      return {
        reason: 'project_changed',
        kind: 'project_changed',
        tag: '项目有变化',
        warn: true,
        headline: '检查期间项目又有新的改动，没有保存',
        saveSteps,
        buttons: [{ action: 'retry_save', label: '重新保存', primary: true }],
      };
    case 'failed_restored':
      return {
        reason: 'failed_restored',
        kind: 'failed_restored',
        tag: '保存失败 · 已安全恢复',
        warn: true,
        headline: '写入时出错，已把项目恢复并核对过与保存前一致；成果仍在任务副本里',
        saveSteps,
        buttons: [{ action: 'retry_save', label: '重试', primary: true }],
      };
    case 'abnormal':
      return {
        reason: 'abnormal',
        kind: 'manual_review',
        tag: opts.isUndo ? '撤销失败 · 恢复未确认' : '保存失败 · 恢复未确认',
        warn: true,
        headline: '写入中途出错，无法确认项目是否完好。已停止一切写入。',
        ...(snap.files?.length ? { files: snap.files } : {}),
        extraNote: '处理完之前，这个项目的所有任务都不能保存或撤销',
        saveSteps,
        buttons: [
          { action: 'reveal_project', label: '在访达中显示项目' },
          { action: 'copy_summary', label: '复制诊断摘要' },
        ],
      };
    case 'project_locked': {
      const blockingGoal = snap.blockingTaskGoal ? scrubAiText(snap.blockingTaskGoal) : '另一个任务';
      return {
        reason: 'project_locked',
        kind: 'project_locked',
        tag: '项目已锁定',
        warn: true,
        headline: `${blockingGoal} 的保存出了问题还没处理，这个项目暂时不能保存`,
        ...(snap.blockingTaskId ? { blockingTaskId: snap.blockingTaskId } : {}),
        blockingTaskGoal: blockingGoal,
        saveSteps,
        buttons: snap.blockingTaskId
          ? [{ action: 'open_blocking_task', label: '去处理', primary: true, targetTaskId: snap.blockingTaskId }]
          : [],
      };
    }
    default: {
      const fail: OpFail = opts.failOverride ?? {
        ok: false,
        reason: (snap.reason as OpFail['reason']) || 'failed',
        detail: '',
        ...(snap.files ? { files: snap.files } : {}),
      };
      const mapped = mapFailure(fail);
      const isUndoRefused = fail.reason === 'undo_refused';
      const headline =
        isUndoRefused && !mapped.message.includes('没有改动任何文件')
          ? `${mapped.message}（没有改动任何文件）`
          : mapped.message;
      const buttons: SaveOutcomeButton[] =
        fail.reason === 'acceptance_invalid'
          ? [{ action: 'recheck', label: '重新检查', primary: true }]
          : fail.reason === 'failed'
            ? [{ action: 'retry_save', label: '重试', primary: true }]
            : [];
      return {
        reason: fail.reason,
        kind: 'blocked',
        tag: isUndoRefused ? '无法撤销' : opts.isUndo ? '撤销未完成' : '没有保存',
        warn: true,
        headline,
        ...(mapped.files?.length ? { files: mapped.files } : snap.files?.length ? { files: snap.files } : {}),
        saveSteps,
        buttons,
      };
    }
  }
}

export function buildSaveOutcomeFromFail(fail: OpFail, opts: { isUndo?: boolean; saveSteps?: SaveProgressStep[] } = {}): SaveOutcomeView {
  return buildSaveOutcomeView(
    {
      reason: fail.reason,
      at: new Date().toISOString(),
      saveSteps: opts.saveSteps ?? defaultSaveSteps(),
      ...(fail.files ? { files: fail.files.map(safeRelPath).filter((x): x is string => !!x) } : {}),
      ...(fail.failedChecks ? { failedChecks: fail.failedChecks } : {}),
      ...(fail.failedCheckCounts ? { failedCheckCounts: fail.failedCheckCounts } : {}),
      ...(fail.totalFailedItems !== undefined ? { totalFailedItems: fail.totalFailedItems } : {}),
      ...(fail.uncheckedKind ? { uncheckedKind: fail.uncheckedKind } : {}),
      ...(fail.unavailableReason ? { unavailableReason: fail.unavailableReason } : {}),
      ...(fail.blockingTaskId ? { blockingTaskId: fail.blockingTaskId } : {}),
      ...(fail.blockingTask ? { blockingTaskGoal: fail.blockingTask } : {}),
    },
    { isUndo: opts.isUndo, failOverride: fail },
  );
}
