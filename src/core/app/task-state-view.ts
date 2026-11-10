import { scrubAiText } from '../acceptance/texts.js';
import type { Task } from '../task/model.js';
import type { TaskState } from '../task/state.js';

/**
 * UI v2.1 第 3 节三层状态模型：
 * - 阶段（stage）：讨论 / 施工 / 验收 / 已结束（本阶段尚未实现讨论，任务从施工准备开始）
 * - 运行状态（runStatus）：卡片徽章标签
 * - 结局（outcome）：仅「已结束」任务才有（已保存 / 已放弃 / 未完成而终止）
 */
export type TaskStage = 'discussing' | 'building' | 'reviewing' | 'ended';
export type TaskOutcome = 'saved' | 'discarded' | 'terminated';
export type WorkbenchGroup = 'needs_decision' | 'running' | 'recent_ended';

export interface TaskClassification {
  stage: TaskStage;
  stageLabel: '讨论' | '施工' | '验收' | '已结束';
  boardColumn: TaskStage;
  runStatus: string | null;
  outcome: TaskOutcome | null;
  outcomeLabel: '已保存' | '已放弃' | '未完成而终止' | null;
  workbenchGroup: WorkbenchGroup;
  isRunning: boolean;
  needsAttention: boolean;
  isAbnormal: boolean;
  statusTag: string;
  impact: string;
  actionLabel: string;
  actionKind: 'open_task' | 'open_history';
}

const STAGE_LABEL: Record<TaskStage, '讨论' | '施工' | '验收' | '已结束'> = {
  discussing: '讨论',
  building: '施工',
  reviewing: '验收',
  ended: '已结束',
};

const OUTCOME_LABEL: Record<TaskOutcome, '已保存' | '已放弃' | '未完成而终止'> = {
  saved: '已保存',
  discarded: '已放弃',
  terminated: '未完成而终止',
};

function reviewingDetails(t: Task): Pick<TaskClassification, 'runStatus' | 'impact' | 'isAbnormal'> {
  if (t.manualReview) {
    return {
      runStatus: '已锁定',
      isAbnormal: true,
      impact: '写入或恢复结果未确认，该项目已锁定保存与撤销，请先人工核对',
    };
  }
  if (t.exit?.kind === 'stopped') {
    return {
      runStatus: '已停止',
      isAbnormal: false,
      impact: '你已停止执行，已有改动保留在副本中，等你决定去验收或放弃',
    };
  }
  if (t.exit?.kind === 'timed_out' || t.exit?.kind === 'signaled') {
    return {
      runStatus: '已中断',
      isAbnormal: true,
      impact: '上次执行意外中断，已有改动保留在副本里，你的项目没有变化',
    };
  }
  if (t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0)) {
    return {
      runStatus: '失败',
      isAbnormal: true,
      impact: '执行没有正常结束，不会写入项目，请在验收页查看或放弃',
    };
  }
  const items = t.card?.items ?? [];
  if (items.some((i) => (i.key === 'build' || i.key === 'test') && i.status === 'failed')) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: '项目自动检查未通过，当前不能保存，请查看结果后处理或放弃',
    };
  }
  if (t.uncheckedConfirm) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: '未运行自动检查，等你打开预览查看或确认仍然保存',
    };
  }
  if (items.some((i) => (i.key === 'build' || i.key === 'test') && i.status === 'not_checked')) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: 'AI 已完成修改（部分检查未运行），等你在验收页确认',
    };
  }
  return {
    runStatus: '等你验收',
    isAbnormal: false,
    impact: '构建与测试已通过，等你在验收页确认后保存到项目',
  };
}

/** 静态穷举 TaskState 的全部 17 种取值并结合 manualReview / exit 映射到 UI v2.1 三层模型与工作台分组。 */
export function classifyTaskState(t: Task, opts: { isLiveRunning?: boolean } = {}): TaskClassification {
  const mk = (
    stage: TaskStage,
    fields: {
      runStatus: string | null;
      outcome: TaskOutcome | null;
      workbenchGroup: WorkbenchGroup;
      isRunning?: boolean;
      needsAttention?: boolean;
      isAbnormal?: boolean;
      impact: string;
      actionLabel: string;
      actionKind?: 'open_task' | 'open_history';
    },
  ): TaskClassification => {
    const manualLocked = !!t.manualReview;
    const isAbnormal = manualLocked || !!fields.isAbnormal;
    const needsAttention = manualLocked || !!fields.needsAttention;
    const runStatus = manualLocked ? '已锁定' : fields.runStatus;
    const workbenchGroup: WorkbenchGroup = manualLocked ? 'needs_decision' : fields.workbenchGroup;
    const outcomeLabel = fields.outcome ? OUTCOME_LABEL[fields.outcome] : null;
    const statusTag = runStatus ?? outcomeLabel ?? STAGE_LABEL[stage];
    const impact = manualLocked ? '写入或恢复结果未确认，该项目已锁定保存与撤销，请先人工核对' : scrubAiText(fields.impact);
    return {
      stage,
      stageLabel: STAGE_LABEL[stage],
      boardColumn: stage,
      runStatus,
      outcome: fields.outcome,
      outcomeLabel,
      workbenchGroup,
      isRunning: !manualLocked && !!fields.isRunning,
      needsAttention,
      isAbnormal,
      statusTag,
      impact,
      actionLabel: manualLocked ? '去处理异常' : fields.actionLabel,
      actionKind: manualLocked ? 'open_task' : (fields.actionKind ?? 'open_task'),
    };
  };

  const state: TaskState = t.state;
  switch (state) {
    case 'draft':
      return mk('building', {
        runStatus: '待配置计划',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: '任务刚创建，等你确认施工计划并开工，主项目未受影响',
        actionLabel: '去配置计划',
      });
    case 'clarifying':
      return mk('building', {
        runStatus: '等你裁决',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: '需要你澄清需求细节后再开始施工，主项目未受影响',
        actionLabel: '去说明',
      });
    case 'planned':
      return mk('building', {
        runStatus: '待开工确认',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: '施工计划已准备好，等你确认权限并开工，主项目未改动',
        actionLabel: '去开工',
      });
    case 'approved':
      return mk('building', {
        runStatus: opts.isLiveRunning ? '运行中' : '待开工确认',
        outcome: null,
        workbenchGroup: opts.isLiveRunning ? 'running' : 'needs_decision',
        isRunning: !!opts.isLiveRunning,
        needsAttention: !opts.isLiveRunning,
        impact: opts.isLiveRunning
          ? '正在独立副本中准备开工并施工，你的项目当前保持原样'
          : '计划已批准但尚未开始执行，主项目文件未改动',
        actionLabel: opts.isLiveRunning ? '查看' : '去开工',
      });
    case 'running':
      return mk('building', {
        runStatus: '运行中',
        outcome: null,
        workbenchGroup: 'running',
        isRunning: true,
        impact: '正在独立副本中施工，你的项目当前保持原样',
        actionLabel: '查看',
      });
    case 'exec_succeeded':
      return mk('building', {
        runStatus: '运行中',
        outcome: null,
        workbenchGroup: opts.isLiveRunning ? 'running' : 'needs_decision',
        isRunning: !!opts.isLiveRunning,
        needsAttention: !opts.isLiveRunning,
        impact: opts.isLiveRunning ? 'AI 已结束修改，正在生成验收结果' : '执行已结束，等你查看验收结果',
        actionLabel: opts.isLiveRunning ? '查看' : '去验收',
      });
    case 'exec_failed':
      return mk('building', {
        runStatus: '失败',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '执行未能顺利结束，已保留现场在副本中，主项目未改动',
        actionLabel: '去查看',
      });
    case 'stopped':
      return mk('building', {
        runStatus: '已停止',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: '你停止了本次执行，已做部分留在副本里，主项目未改动',
        actionLabel: '查看怎么继续',
      });
    case 'timed_out':
      return mk('building', {
        runStatus: '已中断',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '执行超时停下，已做部分保留在副本里，你的项目未变化',
        actionLabel: '选择怎么继续',
      });
    case 'reviewing': {
      const det = reviewingDetails(t);
      return mk('reviewing', {
        runStatus: det.runStatus,
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: det.isAbnormal,
        impact: det.impact,
        actionLabel: det.isAbnormal ? '查看怎么继续' : '去验收',
      });
    }
    case 'save_failed_unmerged':
      return mk('reviewing', {
        runStatus: '被阻断',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '与项目当前修改有冲突，本次没有保存，AI 的成果仍保留在副本里',
        actionLabel: '去处理冲突',
      });
    case 'saved':
      return mk('ended', {
        runStatus: null,
        outcome: 'saved',
        workbenchGroup: 'recent_ended',
        impact: t.saveRecord?.checked
          ? '已保存到项目（检查通过），需要时可在保存记录里撤销'
          : '已保存到项目（未检查），需要时可在保存记录里撤销',
        actionLabel: '保存记录',
        actionKind: 'open_history',
      });
    case 'saved_cleanup_pending':
      return mk('ended', {
        runStatus: '被阻断',
        outcome: 'saved',
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '修改已保存到项目，但临时文件还没清理干净，需要你点重试清理',
        actionLabel: '去重试清理',
      });
    case 'discarded':
      return mk('ended', {
        runStatus: null,
        outcome: 'discarded',
        workbenchGroup: 'recent_ended',
        impact: '已放弃这次任务，主项目文件未受任何影响',
        actionLabel: '查看任务',
      });
    case 'discard_cleanup_pending':
      return mk('ended', {
        runStatus: '被阻断',
        outcome: 'terminated',
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '已决定放弃任务，但临时文件还没清理干净，请重试清理',
        actionLabel: '去重试清理',
      });
    case 'undone':
      return mk('ended', {
        runStatus: '已撤销保存',
        outcome: 'terminated',
        workbenchGroup: 'recent_ended',
        impact: '已撤销那次保存，项目已恢复到保存之前的样子',
        actionLabel: '查看任务',
      });
    case 'undo_failed':
      return mk('ended', {
        runStatus: '失败',
        outcome: 'saved',
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '撤销上次保存时没成功，请先查看当前状态后再操作',
        actionLabel: '去处理',
      });
    default: {
      const exhaustive: never = state;
      throw new Error(`未知任务状态：${String(exhaustive)}`);
    }
  }
}
