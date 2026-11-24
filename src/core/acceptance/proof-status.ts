import type { Task } from '../task/model.js';
import { evidenceIdentityProblem } from '../evidence/validate.js';

/**
 * 读取时复核「当前轮次的宿主证据是否仍与任务记录一致」。
 *
 * 放在核心层（而不是验收视图里）的原因：
 * - 验收视图只应接触已过滤的展示模型，不允许读取原始证据字段（安全基线守住这一点）；
 * - 证据身份复核是纯计算（任务 / 轮次 / 验收版本 / 冻结内容），放在这里便于被视图、保存门禁与反馈包共用。
 */

export interface CheckInvalidation {
  name: 'build' | 'test';
  /** 面向用户的固定一句话原因（已脱敏，不含命令与路径） */
  problem: string;
}

type TaskLike = Pick<Task, 'id' | 'currentRound' | 'acceptanceRev' | 'acceptedTree' | 'currentChecks' | 'evidenceInvalid'>;

/** 证据身份与当前记录不一致的检查项（空数组 = 没有失效项）。 */
export function checkInvalidations(t: TaskLike): CheckInvalidation[] {
  const out: CheckInvalidation[] = [];
  const identity = {
    taskId: t.id,
    round: t.currentRound ?? 1,
    ...(t.acceptanceRev !== undefined ? { acceptanceRev: t.acceptanceRev } : {}),
    ...(t.acceptedTree ? { acceptedTree: t.acceptedTree } : {}),
  };
  for (const proof of t.currentChecks ?? []) {
    const ev = proof.evidence;
    if (!ev) continue;
    const problem = evidenceIdentityProblem(ev, identity);
    if (problem) out.push({ name: proof.name, problem });
  }
  return out;
}

/** 重启深度复核发现的失效原因（脚本/配置/运行器/锁文件在验收后被改动）；没有则为 null。 */
export function deepInvalidReason(t: Pick<Task, 'evidenceInvalid'>): string | null {
  return t.evidenceInvalid?.reason ?? null;
}
