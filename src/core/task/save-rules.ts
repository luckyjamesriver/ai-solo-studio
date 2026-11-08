import type { Task } from './model.js';
import { MESSAGES } from './messages.js';

/**
 * 保存前提（B4-plan 第 3 节）——由核心层按任务记录独立判定，界面不能绕过：
 * 执行体正常结束；检查无失败项（未检查允许）；无隔离异常；被拒绝的操作已逐项确认知晓；
 * 验收标准已逐条确认，标准为空时用户已整体确认；有实际改动；验收内容已冻结。
 * 返回空数组表示没有阻碍。
 */
export function saveBlockers(t: Task): string[] {
  const out: string[] = [];
  const card = t.card;
  if (!card) return ['还没有验收卡。'];
  if (card.items.some((i) => i.key === 'drivers')) out.push(MESSAGES.externalDriver);
  if (!(t.exit?.kind === 'exited' && t.exit.code === 0)) out.push('AI 的执行没有正常结束。');
  for (const key of ['build', 'test'] as const) {
    if (card.items.find((i) => i.key === key)?.status === 'failed') out.push(key === 'build' ? '项目构建没有通过。' : '自动测试没有通过。');
  }
  if (t.isolationWarnings?.length) out.push(`施工环境的隔离出现异常：${t.isolationWarnings.join('；')}`);
  if (!t.denied.every((_, i) => t.deniedAcks[i] === true)) out.push('还有被拒绝的操作没有确认你知晓。');
  if (t.criteria.length === 0) {
    if (t.overallConfirmed !== true) out.push('请先确认“我已看过改动，结果符合我的要求”。');
  } else if (!t.criteria.every((c) => c.decision === 'confirmed')) {
    out.push('验收标准还没有逐条确认。');
  }
  if (card.changes.length === 0) out.push('没有任何文件被修改。');
  if (!t.acceptedTree) out.push('验收内容还没有冻结。');
  return out;
}
