import { useEffect, useState } from 'react';
import { Acceptance } from './Acceptance.js';
import { DiscussionPage } from './DiscussionPage.js';
import { ExternalWaitingPage } from './ExternalWaitingPage.js';
import { PlanCard } from './PlanCard.js';
import { RunView } from './RunView.js';
import { StoppedPage } from './StoppedPage.js';
import type { TaskView } from './api.js';
import { COPY } from './copy.js';
import { buildChatGPTFeedbackPacket } from './chatgptFeedback.js';

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
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [maskCredentials, setMaskCredentials] = useState(true);
  const [relativePaths, setRelativePaths] = useState(true);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [manualReviewAck, setManualReviewAck] = useState(false);
  const [editedPacket, setEditedPacket] = useState('');

  useEffect(() => {
    setAckStopToken(null);
  }, [task.id]);

  // 打开反馈包审查模态框
  const handleOpenFeedbackModal = () => {
    const packet = buildChatGPTFeedbackPacket(task, projectName, {
      maskCredentials,
      relativePaths,
      includeDiagnostics,
    });
    setEditedPacket(packet);
    setManualReviewAck(false);
    setShowFeedbackModal(true);
  };

  // 确认并复制反馈包
  const handleConfirmCopyFeedback = async () => {
    try {
      await navigator.clipboard.writeText(editedPacket);
      setCopiedFeedback(true);
      setTimeout(() => {
        setCopiedFeedback(false);
        setShowFeedbackModal(false);
      }, 1200);
    } catch (e) {
      console.warn('Failed to copy feedback packet', e);
    }
  };

  const showRun = task.running || task.state === 'running';
  useEffect(() => {
    if (showRun) setAckStopToken(null);
  }, [showRun]);
  const showDiscuss = !showRun && ['draft', 'clarifying'].includes(task.state) && task.layer.runStatus !== '已锁定';
  const showPlan = !showRun && ['planned', 'approved'].includes(task.state) && task.layer.runStatus !== '已锁定';
  const showExternalWaiting = !showRun && task.state === 'waiting_external' && task.layer.runStatus !== '已锁定';
  const stoppedInfo = !showRun && !showDiscuss && !showPlan && !showExternalWaiting ? task.stoppedInfo : null;
  const showStopped = !!stoppedInfo && ackStopToken !== stoppedInfo.token;

  const stage = task.layer.stage;
  const planDone = showStopped || stage === 'building' || stage === 'reviewing' || stage === 'ended';
  const planCur = !showStopped && (stage === 'planning' || stage === 'discussing');
  const buildDone = !showStopped && (stage === 'reviewing' || stage === 'ended');
  const buildCur = showStopped || stage === 'building';
  const acceptDone = !showStopped && stage === 'ended';
  const acceptCur = !showStopped && stage === 'reviewing';

  const useBare = showRun || showDiscuss || showPlan || showExternalWaiting || showStopped || !error;

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            type="button"
            className="secondary"
            data-testid="copy-chatgpt-feedback"
            onClick={handleOpenFeedbackModal}
            style={{ fontSize: '12px', padding: '4px 10px' }}
            title="审查并复制当前任务的结构化执行结果反馈包，用于粘贴至 ChatGPT 网页继续讨论"
          >
            {copiedFeedback ? '✓ 已复制反馈包' : '📋 审查并复制 ChatGPT 反馈包'}
          </button>
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
        ) : showExternalWaiting ? (
          <ExternalWaitingPage
            key={task.id}
            projectId={projectId}
            task={task}
            onTaskChanged={onTaskChanged}
            onDiscarded={onAcceptanceChanged}
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

      {/* 阶段 P0-2-R2：ChatGPT 反馈包内容审查与脱敏模态框 */}
      {showFeedbackModal && (
        <div
          data-testid="feedback-review-modal"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'var(--color-overlay)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '740px',
              maxHeight: '88vh',
              background: 'var(--color-bg)',
              borderRadius: 'var(--radius-card)',
              border: '1px solid var(--color-border)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 8px 32px var(--color-overlay)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--color-surface-subtle)',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--color-ink)' }}>
                  📋 审查并复制 ChatGPT 任务反馈包
                </h3>
                <span style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
                  模式：Human-in-the-loop transfer · 区分宿主真实事实与 AI 自述 · 复制前可核对与脱敏
                </span>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowFeedbackModal(false)}
                data-testid="close-feedback-modal-button"
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
              <div
                style={{
                  display: 'flex',
                  gap: '16px',
                  flexWrap: 'wrap',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-surface-subtle)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    data-testid="feedback-opt-mask-credentials"
                    checked={maskCredentials}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setMaskCredentials(val);
                      setManualReviewAck(false);
                      setEditedPacket(buildChatGPTFeedbackPacket(task, projectName, { maskCredentials: val, relativePaths, includeDiagnostics }));
                    }}
                  />
                  自动遮蔽敏感凭证 (API Keys, Bearer)
                </label>
                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    data-testid="feedback-opt-relative-paths"
                    checked={relativePaths}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setRelativePaths(val);
                      setManualReviewAck(false);
                      setEditedPacket(buildChatGPTFeedbackPacket(task, projectName, { maskCredentials, relativePaths: val, includeDiagnostics }));
                    }}
                  />
                  绝对路径脱敏为相对路径
                </label>
                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    data-testid="feedback-opt-include-diagnostics"
                    checked={includeDiagnostics}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setIncludeDiagnostics(val);
                      setManualReviewAck(false);
                      setEditedPacket(buildChatGPTFeedbackPacket(task, projectName, { maskCredentials, relativePaths, includeDiagnostics: val }));
                    }}
                  />
                  包含诊断摘要
                </label>
              </div>

              <div
                data-testid="feedback-privacy-disclaimer"
                style={{
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-surface-subtle)',
                  border: '1px solid var(--color-warn)',
                  color: 'var(--color-warn)',
                  fontSize: '11px',
                  lineHeight: 1.5,
                }}
              >
                ⚠️ <b>隐私与凭证安全提示</b>：内置脱敏规则仅基于通用模式匹配，<b>无法保证 100% 覆盖所有私有凭证、内部数据与隐私信息</b>。选项或正文修改后必须重新核对确认方可复制！
              </div>

              <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
                请核对以下即将复制的内容，无证据项已明确标注，你可直接在下方编辑框中微调：
              </div>

              <textarea
                data-testid="feedback-packet-textarea"
                value={editedPacket}
                onChange={(e) => {
                  setEditedPacket(e.target.value);
                  setManualReviewAck(false);
                }}
                rows={13}
                style={{
                  width: '100%',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  padding: '10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg)',
                  color: 'var(--color-ink)',
                  resize: 'vertical',
                }}
              />

              <label
                style={{
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  color: 'var(--color-ink)',
                  fontWeight: 500,
                  marginTop: '2px',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="feedback-manual-review-ack"
                  checked={manualReviewAck}
                  onChange={(e) => setManualReviewAck(e.target.checked)}
                />
                我已逐行人工核验上述反馈包文本，确认无未脱敏的私有密钥与敏感业务信息
              </label>
            </div>

            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--color-border)',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                background: 'var(--color-surface-subtle)',
              }}
            >
              <button
                type="button"
                className="secondary"
                onClick={() => setShowFeedbackModal(false)}
                data-testid="cancel-feedback-modal-button"
                style={{ fontSize: '13px', padding: '6px 14px' }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!manualReviewAck}
                onClick={handleConfirmCopyFeedback}
                data-testid="confirm-copy-feedback-button"
                style={{
                  fontSize: '13px',
                  padding: '6px 16px',
                  fontWeight: 600,
                  opacity: manualReviewAck ? 1 : 0.6,
                  cursor: manualReviewAck ? 'pointer' : 'not-allowed',
                }}
              >
                {copiedFeedback ? '✓ 已复制到剪贴板' : '✅ 确认已核验并复制到剪贴板'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
