import { Acceptance } from './Acceptance.js';
import { PlanCard } from './PlanCard.js';
import { RunView } from './RunView.js';
import type { TaskView } from './api.js';

interface TaskPageProps {
  projectId: string;
  projectName: string;
  task: TaskView;
  preferredMode: 'standard' | 'full_trust';
  error: string | null;
  onBackToProject: () => void;
  onStop: () => void;
  onTaskChanged: (t: TaskView) => void;
  onAcceptanceChanged: () => void;
}

/**
 * 任务页外框（UI v2.1 第 2 节，B6）：
 * 面包屑（项目 › 任务）+ 任务名 + 3 步阶段条（1 计划 → 2 施工 → 3 验收；阶段 5 时再把「计划」改为「讨论」）。
 * 现有的 PlanCard / RunView / Acceptance 原样放进外框，不改内部逻辑。
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
  onAcceptanceChanged,
}: TaskPageProps) {
  const stage = task.layer.stage;
  const planDone = stage === 'building' || stage === 'reviewing' || stage === 'ended';
  const planCur = stage === 'planning' || stage === 'discussing';
  const buildDone = stage === 'reviewing' || stage === 'ended';
  const buildCur = stage === 'building';
  const acceptDone = stage === 'ended';
  const acceptCur = stage === 'reviewing';

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
          </div>
          <h1 data-testid="task-title">{task.goal}</h1>
        </div>
        <div className="stages" aria-label="任务阶段" data-testid="stage-bar">
          <span
            className={`st${planDone ? ' done' : planCur ? ' cur' : ''}`}
            data-testid="stage-plan"
            data-status={planDone ? 'done' : planCur ? 'cur' : 'pending'}
          >
            {planDone ? '1 计划 ✓' : '1 计划'}
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

      <div className={`taskpane${task.running || task.state === 'running' || (['draft', 'planned', 'approved'].includes(task.state) && task.layer.runStatus !== '已锁定') ? ' taskpane-bare' : ''}`} data-testid="task-pane">
        {task.running || task.state === 'running' ? (
          <RunView task={task} onStop={onStop} />
        ) : ['draft', 'planned', 'approved'].includes(task.state) && task.layer.runStatus !== '已锁定' ? (
          <PlanCard
            key={task.id}
            projectId={projectId}
            task={task}
            preferredMode={preferredMode}
            onChanged={onTaskChanged}
          />
        ) : (
          <Acceptance
            key={task.id}
            projectId={projectId}
            task={task}
            onChanged={onAcceptanceChanged}
          />
        )}
      </div>
    </main>
  );
}
