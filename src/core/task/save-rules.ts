import type { Task } from './model.js';
import { MESSAGES } from './messages.js';

/** 保存前提不满足的原因（代码形式；界面按代码生成固定文案，不使用核心层拼接的文字） */
export type BlockerCode =
  | 'no_card'
  | 'external_driver'
  | 'exec_not_ok'
  | 'build_failed'
  | 'test_failed'
  | 'isolation'
  | 'denied_unacked'
  | 'overall_unconfirmed'
  | 'criteria_unconfirmed'
  | 'no_changes'
  | 'not_frozen';

/**
 * 保存前提（B4-plan 第 3 节）——由核心层按任务记录独立判定，界面不能绕过：
 * 执行体正常结束；检查无失败项（未检查允许）；无隔离异常；被拒绝的操作已逐项确认知晓；
 * 验收标准已逐条确认，标准为空时用户已整体确认；有实际改动；验收内容已冻结。
 * 返回空数组表示没有阻碍。
 */
export function saveBlockerCodes(t: Task): BlockerCode[] {
  const card = t.card;
  if (!card) return ['no_card'];
  const out: BlockerCode[] = [];
  if (card.items.some((i) => i.key === 'drivers')) out.push('external_driver');
  if (!(t.exit?.kind === 'exited' && t.exit.code === 0)) out.push('exec_not_ok');
  if (card.items.find((i) => i.key === 'build')?.status === 'failed') out.push('build_failed');
  if (card.items.find((i) => i.key === 'test')?.status === 'failed') out.push('test_failed');
  if (t.isolationWarnings?.length) out.push('isolation');
  if (!t.denied.every((_, i) => t.deniedAcks[i] === true)) out.push('denied_unacked');
  if (t.criteria.length === 0) {
    if (t.overallConfirmed !== true) out.push('overall_unconfirmed');
  } else if (!t.criteria.every((c) => c.decision === 'confirmed')) {
    out.push('criteria_unconfirmed');
  }
  if (card.changes.length === 0) out.push('no_changes');
  if (!t.acceptedTree) out.push('not_frozen');
  return out;
}

export function saveBlockers(t: Task): string[] {
  return saveBlockerCodes(t).map((c) => {
    switch (c) {
      case 'no_card': return '还没有验收卡。';
      case 'external_driver': return MESSAGES.externalDriver;
      case 'exec_not_ok': return 'AI 的执行没有正常结束。';
      case 'build_failed': return '项目构建没有通过。';
      case 'test_failed': return '自动测试没有通过。';
      case 'isolation': return `施工环境的隔离出现异常：${(t.isolationWarnings ?? []).join('；')}`;
      case 'denied_unacked': return '还有被拒绝的操作没有确认你知晓。';
      case 'overall_unconfirmed': return '请先确认“我已看过改动，结果符合我的要求”。';
      case 'criteria_unconfirmed': return '验收标准还没有逐条确认。';
      case 'no_changes': return '没有任何文件被修改。';
      case 'not_frozen': return '验收内容还没有冻结。';
    }
  });
}
