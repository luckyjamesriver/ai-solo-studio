import { EXTERNAL_DRIVER_MESSAGE } from '../git/git.js';

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
} as const;

export type MessageKey = keyof typeof MESSAGES;
