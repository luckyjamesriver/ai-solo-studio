import { scrubAiText } from '../acceptance/texts.js';
import type { Task, TimelineEntry } from '../task/model.js';
import type { TaskState } from '../task/state.js';
import { classifyServiceError } from '../thinking/errors.js';

/**
 * UI v2.1 第 3 节三层状态模型：
 * - 阶段（stage）：计划（阶段 5 改为讨论）/ 施工 / 验收 / 已结束
 * - 运行状态（runStatus）：卡片徽章标签
 * - 结局（outcome）：仅「已结束」任务才有（已保存 / 已放弃 / 已撤销 / 未完成而终止）
 */
export type TaskStage = 'planning' | 'discussing' | 'building' | 'reviewing' | 'ended';
export type TaskOutcome = 'saved' | 'discarded' | 'undone' | 'terminated';
export type WorkbenchGroup = 'needs_decision' | 'running' | 'recent_ended';

export interface TaskClassification {
  stage: TaskStage;
  stageLabel: '计划' | '讨论' | '施工' | '验收' | '已结束';
  boardColumn: TaskStage;
  runStatus: string | null;
  outcome: TaskOutcome | null;
  outcomeLabel: '已保存' | '已放弃' | '已撤销' | '未完成而终止' | null;
  workbenchGroup: WorkbenchGroup;
  isRunning: boolean;
  needsAttention: boolean;
  isAbnormal: boolean;
  statusTag: string;
  impact: string;
  actionLabel: string;
  actionKind: 'open_task' | 'open_history';
}

const STAGE_LABEL: Record<TaskStage, '计划' | '讨论' | '施工' | '验收' | '已结束'> = {
  planning: '计划',
  discussing: '讨论',
  building: '施工',
  reviewing: '验收',
  ended: '已结束',
};

const OUTCOME_LABEL: Record<TaskOutcome, '已保存' | '已放弃' | '已撤销' | '未完成而终止'> = {
  saved: '已保存',
  discarded: '已放弃',
  undone: '已撤销',
  terminated: '未完成而终止',
};

/** 截取最近一次进入 running 之后的执行时间线片段。 */
export function sliceLatestRun(timeline: TimelineEntry[]): TimelineEntry[] {
  let startIdx = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]!;
    if (e.kind === 'state' && e.text.endsWith('→ running')) {
      startIdx = i;
      break;
    }
  }
  return timeline.slice(startIdx);
}

/** 仅当最近一次执行日志里出现执行者或宿主明确的额度用尽报错时才返回 true（不靠猜）。 */
export function hasQuotaExhaustedError(task: Pick<Task, 'timeline'>): boolean {
  const entries = sliceLatestRun(task.timeline);
  return entries.some((e) => {
    const { source: origin } = e;
    return ((e.kind === 'message' && origin === 'host') || e.kind === 'error') && classifyServiceError(e.text) === 'quota_exhausted';
  });
}

function reviewingDetails(t: Task): Pick<TaskClassification, 'runStatus' | 'impact' | 'isAbnormal' | 'actionLabel'> {
  if (t.manualReview) {
    return {
      runStatus: '已锁定',
      isAbnormal: true,
      impact: '写入或恢复结果未确认，该项目已锁定保存与撤销，请先人工核对',
      actionLabel: '去处理异常',
    };
  }
  if (hasQuotaExhaustedError(t) && t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0)) {
    return {
      runStatus: '已中断',
      isAbnormal: true,
      impact: '额度用完已停下，已做的修改保留在任务副本里，你的项目没有变化',
      actionLabel: '选择怎么继续',
    };
  }
  if (t.exit?.kind === 'stopped') {
    return {
      runStatus: '已停止',
      isAbnormal: false,
      impact: '你停止了本次执行，已做的修改保留在任务副本里，可以选择去验收、继续执行或放弃',
      actionLabel: '查看怎么继续',
    };
  }
  if (t.exit?.kind === 'timed_out') {
    return {
      runStatus: '已中断',
      isAbnormal: true,
      impact: '执行超时中断，已做的修改保留在任务副本里，你的项目没有变化',
      actionLabel: '选择怎么继续',
    };
  }
  if (t.exit?.kind === 'signaled') {
    return {
      runStatus: '已中断',
      isAbnormal: true,
      impact: '上次执行意外中断，已做的修改保留在任务副本里，你的项目没有变化',
      actionLabel: '查看怎么继续',
    };
  }
  if (t.exit && (t.exit.kind !== 'exited' || t.exit.code !== 0)) {
    return {
      runStatus: '失败',
      isAbnormal: true,
      impact: 'AI 执行出错停止了，已做的修改保留在任务副本里，你的项目没有变化',
      actionLabel: '去查看',
    };
  }
  const items = t.card?.items ?? [];
  const checkItems = items.filter((i) => i.key === 'build' || i.key === 'test');
  if (checkItems.some((i) => i.status === 'failed')) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: '项目自动检查未通过，当前不能保存，请在验收页查看结果或放弃',
      actionLabel: '去验收',
    };
  }
  if (t.uncheckedConfirm) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: '未运行自动检查，等你打开预览查看或确认仍然保存',
      actionLabel: '去验收',
    };
  }
  if (checkItems.length === 0) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: 'AI 已结束修改（项目未配置自动检查），等你在验收页预览确认后保存',
      actionLabel: '去验收',
    };
  }
  if (checkItems.some((i) => i.status === 'not_checked')) {
    return {
      runStatus: '等你验收',
      isAbnormal: false,
      impact: 'AI 已完成修改（部分检查未运行），等你在验收页确认',
      actionLabel: '去验收',
    };
  }
  const hasBuild = checkItems.some((i) => i.key === 'build');
  const hasTest = checkItems.some((i) => i.key === 'test');
  const passedLabel = hasBuild && hasTest ? '构建与测试已通过' : hasBuild ? '构建检查已通过' : '自动测试已通过';
  return {
    runStatus: '等你验收',
    isAbnormal: false,
    impact: `${passedLabel}，等你在验收页确认后保存到项目`,
    actionLabel: '去验收',
  };
}

/** 讨论线程当前的只读摘要（由 DiscussionService 提供，用于三层映射与工作台实时状态）。 */
export interface DiscussionClassifyHint {
  pauseAt:
    | 'ready'
    | 'send_consent'
    | 'requirements_confirmation'
    | 'attempt_failed'
    | 'adjudication'
    | 'approval'
    | 'approved'
    | 'stopped'
    | 'rejected';
  running: boolean;
  activeStepText: string | null;
  pauseMessage: string | null;
  pendingAdjudicationsCount: number;
}

/** 静态穷举 TaskState 的全部 17 种取值并结合 manualReview / exit 映射到 UI v2.1 三层模型与工作台分组。 */
export function classifyTaskState(
  t: Task,
  opts: { isLiveRunning?: boolean; discussion?: DiscussionClassifyHint } = {},
): TaskClassification {
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
  const discuss = opts.discussion;
  switch (state) {
    case 'draft':
    case 'clarifying': {
      if (discuss?.running) {
        return mk('discussing', {
          runStatus: discuss.activeStepText ? `讨论中 · ${discuss.activeStepText}` : '讨论中',
          outcome: null,
          workbenchGroup: 'running',
          isRunning: true,
          needsAttention: false,
          impact: 'AI 思考者正在讨论分析需求与方案，主项目未受影响',
          actionLabel: '查看讨论',
        });
      }
      if (discuss?.pauseAt === 'requirements_confirmation') {
        return mk('discussing', {
          runStatus: '需求待确认',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          impact: 'AI 已拆解出需求条目，等你确认并冻结后继续起草方案，主项目未改动',
          actionLabel: '去确认需求',
        });
      }
      if (discuss?.pauseAt === 'adjudication') {
        return mk('discussing', {
          runStatus: '意见待裁决',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          impact: `有 ${discuss.pendingAdjudicationsCount || 1} 项评审意见或范围差异等你逐条裁决，主项目未改动`,
          actionLabel: '去裁决',
        });
      }
      if (discuss?.pauseAt === 'approval') {
        return mk('discussing', {
          runStatus: '方案待批准',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          impact: '讨论方案已就绪，等你批准并生成施工计划，主项目未改动',
          actionLabel: '去批准方案',
        });
      }
      if (discuss?.pauseAt === 'attempt_failed') {
        return mk('discussing', {
          runStatus: '尝试失败待选择',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          isAbnormal: true,
          impact: discuss.pauseMessage ?? '讨论步骤未能完成，等你选择重试或停止，主项目未改动',
          actionLabel: '去处理',
        });
      }
      if (discuss?.pauseAt === 'send_consent') {
        return mk('discussing', {
          runStatus: '待同意外发',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          impact: discuss.pauseMessage ?? '首次向外部 AI 发送资料需要你确认，主项目未改动',
          actionLabel: '去确认外发',
        });
      }
      if (discuss?.pauseAt === 'stopped' || discuss?.pauseAt === 'rejected') {
        return mk('discussing', {
          runStatus: discuss.pauseAt === 'stopped' ? '已停止讨论' : '方案未批准',
          outcome: null,
          workbenchGroup: 'needs_decision',
          needsAttention: true,
          impact: discuss.pauseMessage ?? '当前讨论已结束，你可以修改需求重新讨论，或跳过讨论直接写计划',
          actionLabel: '去查看',
        });
      }
      return mk('discussing', {
        runStatus: state === 'clarifying' ? '等你裁决' : '待讨论',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: state === 'clarifying'
          ? '需要你澄清需求细节后再开始施工，主项目未受影响'
          : '任务刚创建，等你进入讨论（或跳过讨论直接写计划），主项目未受影响',
        actionLabel: '去讨论',
      });
    }
    case 'planned':
      return mk('discussing', {
        runStatus: '待开工确认',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: t.reapproveNotice
          ? '你修改了验收标准，需要重新点击「批准并开工」后才能执行，主项目未改动'
          : '施工计划已准备好，等你确认权限并开工，主项目未改动',
        actionLabel: '去开工',
      });
    case 'approved':
      return mk(opts.isLiveRunning ? 'building' : 'discussing', {
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
        runStatus: opts.isLiveRunning ? '运行中' : '待生成验收',
        outcome: null,
        workbenchGroup: opts.isLiveRunning ? 'running' : 'needs_decision',
        isRunning: !!opts.isLiveRunning,
        needsAttention: !opts.isLiveRunning,
        impact: opts.isLiveRunning
          ? 'AI 已结束修改，正在生成验收结果'
          : '施工已结束，正在准备验收；如果一直停在这里，可以重新检查',
        actionLabel: opts.isLiveRunning ? '查看' : '去验收',
      });
    case 'exec_failed': {
      const quota = hasQuotaExhaustedError(t);
      return mk('building', {
        runStatus: quota ? '已中断' : '失败',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: quota
          ? '额度用完已停下，已做的修改保留在任务副本里，你的项目没有变化'
          : 'AI 执行出错停止了，已做的修改保留在任务副本里，你的项目没有变化',
        actionLabel: quota ? '选择怎么继续' : '去查看',
      });
    }
    case 'stopped':
      return mk('building', {
        runStatus: '已停止',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        impact: '你停止了本次执行，已做的修改保留在任务副本里，你的项目没有变化',
        actionLabel: '查看怎么继续',
      });
    case 'timed_out':
      return mk('building', {
        runStatus: '已中断',
        outcome: null,
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '执行超时中断，已做的修改保留在任务副本里，你的项目没有变化',
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
        actionLabel: det.actionLabel,
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
        outcome: 'discarded',
        workbenchGroup: 'needs_decision',
        needsAttention: true,
        isAbnormal: true,
        impact: '已决定放弃任务，但临时文件还没清理干净，请重试清理',
        actionLabel: '去重试清理',
      });
    case 'undone':
      return mk('ended', {
        runStatus: null,
        outcome: 'undone',
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
