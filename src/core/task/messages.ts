import { EXTERNAL_DRIVER_MESSAGE } from '../git/git.js';
import type { UnavailableReason, UncheckedKind } from '../checks/scripts.js';

/**
 * 保存 / 放弃 / 撤销给用户看的文案（B4-plan 第 1、3、4、5、6 节原文）。
 * 放在核心层的常量里，界面（B4-2）直接使用，不自己改写。
 */
export const MESSAGES = {
  /** 外部驱动检测命中（与 git.ts 的 EXTERNAL_DRIVER_MESSAGE 相同；保存、撤销、开工、验收都用它） */
  externalDriver: EXTERNAL_DRIVER_MESSAGE,
  /** 项目有自定义提交检查（hooksPath 或 .git/hooks 下有可执行钩子）时，验收卡显示 */
  skippedCommitChecks: '为保证安全，保存时没有运行项目自定义的提交检查。',
  branchChanged: '项目当前所在的版本线和开工时不同，工作台不会自动保存',
  repoChanged: '项目的位置和开工时不同，工作台不会自动保存',
  dirtyMain: '项目中还有其他未保存的修改，请先处理后再保存',
  conflict: 'AI 的修改与项目当前版本有冲突，工作台无法安全自动合并。本次没有保存，AI 的成果仍保留。',
  checksFailed: '合并后自动检查未通过，本次没有保存，你的项目保持原样。',
  projectChanged: '保存检查期间项目发生了新的变化，本次没有保存，你的项目保持原样，请重新保存。',
  uncheckedNeedsConfirm: '合并结果尚未经过自动检查，请先查看预览或确认仍然保存。',
  failedRestored: '写入项目时出错，已安全恢复并核对与保存前一致。本次没有保存，任务成果仍保留。',
  projectLocked: '项目中有其他任务处于异常状态（恢复未确认），请先处理那个任务后再保存或撤销。',
  abnormal: '项目状态异常，请不要继续操作',
  acceptanceInvalid: '你确认之后，任务副本里的内容又发生了变化，原来的验收已失效，请重新检查后再保存。',
  checksModified: '检查改动了文件，检查结果已作废。',
  discardDone: '这次任务的代码改动不会进入项目。',
  discardExtra: 'AI 在任务副本以外做过的修改（如额外文件夹、联网操作）工作台无法撤销。',
  undoRefused: '这次保存之后项目还有其他修改，暂时不能只撤销这一项',
  saveCleanupPending: '已保存，临时文件还没清理干净',
  discardCleanupPending: '已放弃，临时文件还没清理干净',
  saved: '已保存到项目。',
  undone: '已撤销这次保存，项目回到保存之前的样子。',
  busy: '这个任务正在进行另一项操作，请稍候。',
  notReady: '还有检查未通过或验收标准未确认。',
  noChecks: '没有自动检查',
  /** B4-2：撤销确认框与撤销成功提示（任务用过额外文件夹或完全信任时追加） */
  undoExtra: '项目代码已恢复；AI 在任务副本以外做过的修改工作台无法撤销。',
  /** 持久化层：这个任务的记录刚刚在别处被更新（修订号对不上）或这次运行已过期，操作被拒绝，没有覆盖任何东西 */
  stateConflict: '这个任务的记录刚刚被别处更新了，这次操作没有生效，请刷新后再试。',
  /** 持久化层：数据目录被另一个写入者占用 */
  writerLocked: '这个项目的数据正被另一个窗口或进程使用，为避免互相覆盖，这次操作没有执行。',
  /** B4-2-fix：重试清理前无法确认执行体已停止（或归属对不上）时，不删除，显示这一句 */
  cleanupBusy: 'AI 可能还在使用这个任务的临时文件，暂时不能清理，请稍后再试。',
  /** B4-2：核心层返回“操作没有成功、项目保持原样”时，界面统一显示这一句（不展示 Git 原文） */
  opFailed: '这次操作没有成功，项目保持原样。你可以稍后重试。',
  /** B4-2：未知错误的固定文案（原始内容只写入受保护的诊断记录） */
  unknownError: '出了点问题，这次操作没有完成。请先不要继续操作，可以复制诊断摘要发给维护者。',
} as const;

export type MessageKey = keyof typeof MESSAGES;

/**
 * 「未检查」时的统一固定文案：核心层保存拒绝、Task 持久记录与验收视图共用同一套文案，
 * 不透传内部路径/命令/原始错误，且「检查脚本变化」明确告知检查方式被改动。
 */
export function uncheckedReasonText(kind: UncheckedKind, unavailableReason?: UnavailableReason): string {
  if (kind === 'none') {
    return '项目没有配置可用的自动检查脚本，合并后无法自动验证，请先预览确认后再决定是否仍然保存。';
  }
  switch (unavailableReason) {
    case 'scripts_changed_reauth':
      return '这次合并改动了项目的检查方式，所以没法自动检查。';
    case 'sandbox_unavailable':
      return '当前没有可用的受限运行环境，检查未能运行，所以没法自动检查。';
    default:
      return '合并后的自动检查未能运行，所以没法自动检查。';
  }
}
