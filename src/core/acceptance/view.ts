import type { Task } from '../task/model.js';
import type { TaskState } from '../task/state.js';
import { canFire } from '../task/state.js';
import { MESSAGES } from '../task/messages.js';
import { saveBlockerCodes, type BlockerCode } from '../task/save-rules.js';
import type { OpFail } from '../task/runner.js';
import { STATE_TEXT } from '../app/task-view.js';
import { extractIncomplete, type IncompleteReport } from './incomplete.js';
import type { ChangePreview } from './snippets.js';
import { deniedText, exitFailureText, notCheckedText, safeRelPath, scrubAiText } from './texts.js';

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
export interface UserAcceptanceView {
  taskId: string;
  goal: string;
  state: TaskState;
  stateText: string;
  verdict: string;
  items: ViewItem[];
  changes: ViewChange[];
  criteria: { id: string; text: string; confirmed: boolean }[];
  /** 没有验收标准时，用户对“我已看过改动，结果符合我的要求”的整体确认 */
  overall: { needed: boolean; confirmed: boolean; text: string };
  /** 被拦下的操作：只能逐条确认知晓 */
  denied: { id: string; text: string; acked: boolean }[];
  notes: string[];
  /** AI 自己报告没做成的事（只是 AI 的说法，已隐去命令与本机路径） */
  aiReport: IncompleteReport;
  unexpectedRequests: number;
  actions: { save: ActionState; discard: ActionState; recheck: ActionState; undo: ActionState; retryCleanup: ActionState };
  confirmTexts: { discard: string; undo: string; save: string | null };
  /** 项目状态异常：禁止一切写操作，只读 */
  readOnly: boolean;
  /** 启动核对修正过：一句话说明；否则 null */
  reconciled: string | null;
  /** 可复制的诊断摘要：只含任务编号、状态、时间与上面的固定文案 */
  diagnosticSummary: string;
  /** 验收版本：确认、保存等请求必须带上它，不一致一律拒绝 */
  version: string;
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

/** 验收版本：冻结内容的短哈希 + 证据序号（重新检查后序号加一，即使内容没变旧版本也作废） */
export function acceptanceVersion(t: Task): string {
  return t.acceptedTree ? `${t.acceptedTree.slice(0, 12)}-${t.acceptanceRev ?? 0}` : '';
}
export const isVersionFormat = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v);

/** 任务用过额外文件夹或完全信任：AI 可能在任务副本以外做过修改，工作台无法撤销 */
export function hasExternalImpact(t: Task): boolean {
  const caps = t.plan?.capabilities;
  return !!caps && (caps.extraWritableDirs.length > 0 || caps.constructionMode === 'full_trust');
}

const mapStatus = (s: string): ViewItemStatus => (s === 'verified' || s === 'user_confirmed' ? 'verified' : s === 'failed' || s === 'user_rejected' ? 'failed' : s === 'not_checked' ? 'not_checked' : 'pending_user');

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
    case 'abnormal': return withFiles(MESSAGES.abnormal);
    case 'undo_refused': return withFiles(MESSAGES.undoRefused);
    case 'cleanup_pending': return withFiles(f.detail === MESSAGES.saveCleanupPending || f.detail === MESSAGES.discardCleanupPending ? f.detail : VIEW_TEXT.cleanupNeeded);
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
  /** 改动片段（只有验收阶段才有） */
  previews?: Map<string, ChangePreview>;
  /** 保存的只读预判：null = 目前可以保存；undefined = 没有判断 */
  saveCheck?: OpFail | null;
  /** 撤销的只读预判，含义同上 */
  undoCheck?: OpFail | null;
  /** 同项目还有其他已保存、仍可单独撤销的任务 */
  otherUndoableSave?: boolean;
}

const off = (reason: string, extra: Partial<ActionState> = {}): ActionState => ({ enabled: false, reason, ...extra });
const on = (extra: Partial<ActionState> = {}): ActionState => ({ enabled: true, ...extra });

function verdictFor(t: Task, blockers: BlockerCode[], saveFail: { message: string } | null, anyFailed: boolean, anyUnchecked: boolean): string {
  if (t.manualReview) return MESSAGES.abnormal;
  switch (t.state) {
    case 'saved': return MESSAGES.saved;
    case 'saved_cleanup_pending': return `${MESSAGES.saved}${MESSAGES.saveCleanupPending}`;
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

export function toUserView(t: Task, ctx: ViewContext = { busy: false }): UserAcceptanceView {
  const card = t.card;
  const denied = t.denied ?? [];
  const acks = t.deniedAcks ?? [];
  const items: ViewItem[] = [];

  for (const it of card?.items ?? []) {
    if (it.key.startsWith('criterion-') || it.key === 'overall') continue; // 单独呈现
    const label = ITEM_LABEL[it.key];
    if (!label) continue;
    const status = mapStatus(it.status);
    let text: string;
    switch (it.key) {
      case 'exit': text = status === 'verified' ? VIEW_TEXT.exitOk : exitFailureText(t.exit); break;
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

  const blockers = t.state === 'reviewing' || t.state === 'save_failed_unmerged' ? saveBlockerCodes(t) : [];
  const anyFailed = items.some((i) => i.status === 'failed');
  const anyUnchecked = items.some((i) => i.status === 'not_checked' && i.key !== 'preview');
  const saveFail = ctx.saveCheck ? mapFailure(ctx.saveCheck) : null;

  const changes: ViewChange[] = (card?.changes ?? []).map((c) => {
    const preview = ctx.previews?.get(c.path);
    return {
      path: safeRelPath(c.path) ?? '（路径不可显示）',
      kind: c.status,
      additions: c.additions,
      deletions: c.deletions,
      ...(preview ? { preview } : {}),
    };
  });

  const unexpected = denied.filter((d) => d.anomaly).length;
  const notes: string[] = [];
  if (t.customCommitChecks) notes.push(MESSAGES.skippedCommitChecks);
  if (unexpected > 0) notes.push(VIEW_TEXT.unexpected);

  const aiMessages = t.timeline.filter((e) => e.kind === 'message' && e.source !== 'host').map((e) => e.text);
  const incompleteSignals = !!t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0 || denied.length > 0);
  const rawReport = extractIncomplete(aiMessages, { incompleteSignals });
  const aiReport: IncompleteReport =
    rawReport.kind === 'items' ? { kind: 'items', items: rawReport.items.map(scrubAiText) } : rawReport.kind === 'raw' ? { kind: 'raw', text: scrubAiText(rawReport.text) } : rawReport;

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

  const extra = hasExternalImpact(t);
  const verdict = verdictFor(t, blockers, saveFail, anyFailed, anyUnchecked);
  const summary = [
    `任务编号：${t.id}`,
    `状态：${STATE_TEXT[t.state]}`,
    `更新时间：${t.updatedAt}`,
    `说明：${verdict}`,
    ...(readOnly ? [`提示：${MESSAGES.abnormal}`] : []),
  ].join('\n');

  const needsOverall = t.criteria.length === 0;
  return {
    taskId: t.id,
    goal: t.plan?.goal ?? t.request,
    state,
    stateText: STATE_TEXT[state],
    verdict,
    items,
    changes,
    criteria: t.criteria.map((c, i) => ({ id: `c${i}`, text: c.text, confirmed: c.decision === 'confirmed' })),
    overall: { needed: needsOverall && !!card, confirmed: t.overallConfirmed === true, text: '我已看过改动，结果符合我的要求' },
    denied: denied.map((d, i) => ({ id: `d${i}`, text: deniedText(d), acked: acks[i] === true })),
    notes,
    aiReport,
    unexpectedRequests: unexpected,
    actions: { save, discard, recheck, undo, retryCleanup },
    confirmTexts: {
      discard: `${VIEW_TEXT.discardConfirm}${MESSAGES.discardDone}${extra ? MESSAGES.discardExtra : ''}`,
      undo: `${VIEW_TEXT.undoConfirm}${extra ? MESSAGES.undoExtra : ''}`,
      save: ctx.otherUndoableSave ? VIEW_TEXT.saveSupersedes : null,
    },
    readOnly,
    reconciled: t.reconciled ? `已核对：${t.reconciled.note}` : null,
    diagnosticSummary: summary,
    version: acceptanceVersion(t),
  };
}
