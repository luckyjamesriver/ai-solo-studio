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
