import { useEffect, useState } from 'react';
import { Acceptance } from './Acceptance.js';
import { DiscussionPage } from './DiscussionPage.js';
import { PlanCard } from './PlanCard.js';
import { RunView } from './RunView.js';
import { StoppedPage } from './StoppedPage.js';
import type { TaskView } from './api.js';
import { COPY } from './copy.js';

interface TaskPageProps {
  projectId: string;
  projectName: string;
  task: TaskView;
  preferredMode: 'standard' | 'full_trust';
  error: string | null;
  onBackToProject: () => void;
  onStop: () => void;
  onTaskChanged: (t: TaskView) => void;
  onTaskReplaced?: (t: TaskView) => void;
  onAcceptanceChanged: () => void;
  onOpenAiSettings?: () => void;
  onOpenHistory?: () => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * 任务页外框（UI v2.1 第 2 节，B6）：
 * 面包屑（项目 › 任务）+ 任务名 + 3 步阶段条（1 计划 → 2 施工 → 3 验收；阶段 5 时再把「计划」改为「讨论」）。
 * 在停下/中断/出错态优先展示 StoppedPage（#06-stopped），点击「去验收已有成果」后才进入 Acceptance。
 */
export function TaskPage({
  projectId,
  projectName,
  task,
  preferredMode,
  error,
  onBackToProject,
  onStop,
  onTaskChanged,
  onTaskReplaced,
  onAcceptanceChanged,
  onOpenAiSettings,
  onOpenHistory,
  onOpenTask,
}: TaskPageProps) {
  const [ackStopToken, setAckStopToken] = useState<string | null>(null);
  useEffect(() => {
    setAckStopToken(null);
  }, [task.id]);

  const showRun = task.running || task.state === 'running';
  useEffect(() => {
    if (showRun) setAckStopToken(null);
  }, [showRun]);
  const showDiscuss = !showRun && ['draft', 'clarifying'].includes(task.state) && task.layer.runStatus !== '已锁定';
  const showPlan = !showRun && ['planned', 'approved'].includes(task.state) && task.layer.runStatus !== '已锁定';
  const stoppedInfo = !showRun && !showDiscuss && !showPlan ? task.stoppedInfo : null;
  const showStopped = !!stoppedInfo && ackStopToken !== stoppedInfo.token;

  const stage = task.layer.stage;
  const planDone = showStopped || stage === 'building' || stage === 'reviewing' || stage === 'ended';
  const planCur = !showStopped && (stage === 'planning' || stage === 'discussing');
  const buildDone = !showStopped && (stage === 'reviewing' || stage === 'ended');
  const buildCur = showStopped || stage === 'building';
  const acceptDone = !showStopped && stage === 'ended';
  const acceptCur = !showStopped && stage === 'reviewing';

  const useBare = showRun || showDiscuss || showPlan || showStopped || !error;

  return (
    <main className="main" data-testid="task-page" aria-label={task.goal}>
      <div className="row sb">
        <div>
          <div className="crumb">
            <button type="button" className="link" data-testid="breadcrumb-project" onClick={onBackToProject}>
              {projectName}
            </button>
            <span aria-hidden="true">›</span>
            <span>任务</span>
            {task.round >= 2 && <span className="tag" data-testid="task-page-round">{COPY.roundBadge(task.round)}</span>}
          </div>
          <h1 data-testid="task-title">{task.goal}</h1>
        </div>
        <div className="stages" aria-label="任务阶段" data-testid="stage-bar">
          <span
            className={`st${planDone ? ' done' : planCur ? ' cur' : ''}`}
            data-testid="stage-plan"
            data-status={planDone ? 'done' : planCur ? 'cur' : 'pending'}
          >
            {planDone ? '1 讨论 ✓' : '1 讨论'}
          </span>
          <span
            className={`st${buildDone ? ' done' : buildCur ? ' cur' : ''}`}
            data-testid="stage-build"
            data-status={buildDone ? 'done' : buildCur ? 'cur' : 'pending'}
          >
            {buildDone ? '2 施工 ✓' : '2 施工'}
          </span>
          <span
            className={`st${acceptDone ? ' done' : acceptCur ? ' cur' : ''}`}
            data-testid="stage-accept"
            data-status={acceptDone ? 'done' : acceptCur ? 'cur' : 'pending'}
          >
            {acceptDone ? '3 验收 ✓' : '3 验收'}
          </span>
        </div>
      </div>

      {error && <p role="alert" className="error" data-testid="task-error">{error}</p>}

      <div className={`taskpane${useBare ? ' taskpane-bare' : ''}`} data-testid="task-pane">
        {showRun ? (
          <RunView task={task} onStop={onStop} />
        ) : showDiscuss ? (
          <DiscussionPage
            key={task.id}
            projectId={projectId}
            task={task}
            onTaskUpdated={onTaskChanged}
            onTaskReplaced={onTaskReplaced ?? onTaskChanged}
            {...(onOpenAiSettings ? { onOpenAiSettings } : {})}
          />
        ) : showPlan ? (
          <PlanCard
            key={task.id}
            projectId={projectId}
            task={task}
            preferredMode={preferredMode}
            onChanged={onTaskChanged}
          />
        ) : showStopped && stoppedInfo ? (
          <StoppedPage
            key={stoppedInfo.token}
            projectId={projectId}
            task={task}
            info={stoppedInfo}
            onGoAcceptance={() => setAckStopToken(stoppedInfo.token)}
            onContinued={onTaskChanged}
            onDiscarded={onAcceptanceChanged}
          />
        ) : (
          <Acceptance
            key={task.id}
            projectId={projectId}
            task={task}
            onChanged={onAcceptanceChanged}
            onBackToProject={onBackToProject}
            {...(onOpenHistory ? { onOpenHistory } : {})}
            {...(onOpenTask ? { onOpenTask } : {})}
          />
        )}
      </div>
    </main>
  );
}
