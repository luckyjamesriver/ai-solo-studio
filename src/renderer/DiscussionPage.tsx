import { useCallback, useEffect, useState } from 'react';
import {
  studio,
  type DiscussionPreset,
  type DiscussionView,
  type PendingAdjudicationItem,
  type RequirementEditInput,
  type TaskView,
} from './api.js';
import { COPY } from './copy.js';

export type DiscussionTab = 'summary' | 'planner-chat' | 'reviewer-chat' | 'record';

export interface DiscussionPageProps {
  projectId: string;
  task: TaskView;
  onTaskUpdated: (t: TaskView) => void;
  onTaskReplaced: (nextTask: TaskView) => void;
}

export interface DiscussionBodyProps {
  view: DiscussionView;
  taskState: TaskView['state'];
  busy: boolean;
  actionError: string | null;
  activeTab: DiscussionTab;
  onTabChange: (tab: DiscussionTab) => void;
  selectedPreset: DiscussionPreset;
  onSelectPreset: (preset: DiscussionPreset) => void;
  reqEdits: RequirementEditInput[];
  onChangeReqEdits: (edits: RequirementEditInput[]) => void;
  retryNote: string;
  onChangeRetryNote: (text: string) => void;
  rejectDrafts: Record<string, { open: boolean; reason: string }>;
  onChangeRejectDraft: (key: string, next: { open: boolean; reason: string }) => void;
  showFullPlan: boolean;
  onToggleFullPlan: () => void;
  modifyOpen: boolean;
  modifyText: string;
  onToggleModify: (open: boolean) => void;
  onChangeModifyText: (text: string) => void;
  onStart: () => void;
  onSkip: () => void;
  onConsent: (allow: boolean) => void;
  onConfirmReqs: () => void;
  onResolveFailure: (choice: 'retry' | 'retryWith' | 'stop') => void;
  onAdjudicate: (item: PendingAdjudicationItem, decision: 'accept' | 'reject') => void;
  onApproveDecision: (decision: 'approve' | 'reject' | 'stop') => void;
  onModifyRequirements: () => void;
}

function stepMarker(status: DiscussionView['steps'][number]['status']): string {
  if (status === 'done') return '✓';
  if (status === 'current') return '●';
  if (status === 'failed') return '✗';
  return '○';
}

export function DiscussionViewBody({
  view,
  taskState,
  busy,
  actionError,
  activeTab,
  onTabChange,
  selectedPreset,
  onSelectPreset,
  reqEdits,
  onChangeReqEdits,
  retryNote,
  onChangeRetryNote,
  rejectDrafts,
  onChangeRejectDraft,
  showFullPlan,
  onToggleFullPlan,
  modifyOpen,
  modifyText,
  onToggleModify,
  onChangeModifyText,
  onStart,
  onSkip,
  onConsent,
  onConfirmReqs,
  onResolveFailure,
  onAdjudicate,
  onApproveDecision,
  onModifyRequirements,
}: DiscussionBodyProps) {
  const effectiveTab: DiscussionTab =
    !view.independentReview && activeTab === 'reviewer-chat' ? 'summary' : activeTab;

  const canModifyReqs =
    view.requirementsFrozen &&
    !view.running &&
    ['draft', 'clarifying'].includes(taskState) &&
    view.pauseAt !== 'approved' &&
    view.pauseAt !== 'stopped' &&
    view.pauseAt !== 'rejected';

  const canClickApprove =
    !busy && !view.running && view.pauseAt === 'approval' && view.canApprove;

  const approvalHint = (() => {
    if (view.blockedBecause.length > 0) return view.blockedBecause.join('；');
    if (view.pendingAdjudications.length > 0) {
      return `先裁决上面 ${view.pendingAdjudications.length} 条意见`;
    }
    if (view.pauseAt === 'ready') return '请先开始讨论并完成前期步骤';
    if (view.pauseAt === 'send_consent') return '请先在左侧确认是否同意资料外发';
    if (view.pauseAt === 'requirements_confirmation') return '请先确认并冻结需求条目';
    if (view.pauseAt === 'attempt_failed') return '请先处理失败的尝试';
    if (view.running) return '思考者正在运行，完成后才可批准';
    if (view.pauseAt === 'stopped' || view.pauseAt === 'rejected') {
      return view.stoppedReason || view.pauseMessage || '讨论已结束';
    }
    return null;
  })();

  const displayedError = actionError || view.error;

  return (
    <div data-testid="discussion-page">
      <section className="box" style={{ marginBottom: '14px' }}>
        <div className="row sb">
          <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
            <strong data-testid="discussion-preset-label">{view.presetLabel}</strong>
            {view.unreviewed && (
              <span className="tag warn" data-testid="discussion-unreviewed-badge">
                {COPY.discussUnreviewedBadge}
              </span>
            )}
            {view.preset === 'dev-personal' && (
              <span className="tag" data-testid="discussion-dev-preset-badge">
                {COPY.discussDevPresetBadge}
              </span>
            )}
            {view.running && (
              <span className="tag" data-testid="discussion-running-status">
                {view.activeStepText || '正在思考…'}
              </span>
            )}
          </div>
          <span className="muted">线程 {view.threadId}</span>
        </div>

        {view.canSwitchPreset && view.canUseDevPersonal && (
          <div className="row" style={{ marginTop: '10px', gap: '14px', flexWrap: 'wrap' }}>
            <span className="muted">讨论模式</span>
            <label className="row" style={{ gap: '6px' }}>
              <input
                type="radio"
                name="discuss-preset"
                value="codex-single"
                checked={selectedPreset === 'codex-single'}
                onChange={() => onSelectPreset('codex-single')}
              />
              <span>Codex 单思考者（{COPY.discussUnreviewedBadge}）</span>
            </label>
            <label className="row" style={{ gap: '6px' }}>
              <input
                type="radio"
                name="discuss-preset"
                value="dev-personal"
                checked={selectedPreset === 'dev-personal'}
                onChange={() => onSelectPreset('dev-personal')}
              />
              <span>{COPY.discussDevPresetBadge}（Claude 规划 + Codex 复核）</span>
            </label>
          </div>
        )}
      </section>

      {displayedError && (
        <p role="alert" className="error" data-testid="discussion-error" style={{ marginBottom: '12px' }}>
          {displayedError}
        </p>
      )}

      <div className="tabs" role="tablist" style={{ marginBottom: '14px' }}>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'summary'}
          className={effectiveTab === 'summary' ? 'tc' : undefined}
          data-testid="discussion-tab-summary"
          onClick={() => onTabChange('summary')}
        >
          {COPY.discussTabSummary}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'planner-chat'}
          className={effectiveTab === 'planner-chat' ? 'tc' : undefined}
          data-testid="discussion-tab-planner-chat"
          onClick={() => onTabChange('planner-chat')}
        >
          {COPY.discussTabPlannerChat}
        </button>
        {view.independentReview && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === 'reviewer-chat'}
            className={effectiveTab === 'reviewer-chat' ? 'tc' : undefined}
            data-testid="discussion-tab-reviewer-chat"
            onClick={() => onTabChange('reviewer-chat')}
          >
            {COPY.discussTabReviewerChat}
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'record'}
          className={effectiveTab === 'record' ? 'tc' : undefined}
          data-testid="discussion-tab-record"
          onClick={() => onTabChange('record')}
        >
          {COPY.discussTabRecord}
        </button>
      </div>

      <div className="g2">
        <div className="stack">
          {view.pauseAt === 'send_consent' && view.pendingConsentService && (
            <section className="box wbox" data-testid="discussion-consent-card">
              <h2>首次资料外发确认</h2>
              <p style={{ marginTop: '6px' }}>
                首次向「<strong>{view.pendingConsentService}</strong>」发送当前需求与项目上下文，资料将离开本机。是否同意？
              </p>
              <div className="row" style={{ marginTop: '12px', gap: '8px' }}>
                <button
                  type="button"
                  className="btn pri"
                  disabled={busy}
                  data-testid="discussion-consent-allow"
                  onClick={() => onConsent(true)}
                >
                  同意并继续发送
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  data-testid="discussion-consent-deny"
                  onClick={() => onConsent(false)}
                >
                  拒绝外发并停止
                </button>
              </div>
            </section>
          )}

          {view.pauseAt === 'attempt_failed' && view.lastFailure && (
            <section className="box wbox" data-testid="discussion-failure-card">
              <div className="row sb">
                <h2>讨论步骤失败 · 需要你选择处理方式</h2>
                <span className="tag warn">{view.lastFailure.status}</span>
              </div>
              <p style={{ marginTop: '6px' }}>
                步骤「{view.lastFailure.step}」（{view.lastFailure.at}）尝试未能完成
                {view.lastFailure.error ? `：${view.lastFailure.error}` : ''}。
              </p>
              <div style={{ marginTop: '10px' }}>
                <label htmlFor="retry-note-input" className="muted">
                  如需补充说明后再重试，请填在下方（直接重试可留空）：
                </label>
                <textarea
                  id="retry-note-input"
                  rows={2}
                  value={retryNote}
                  data-testid="discussion-failure-note"
                  onChange={(e) => onChangeRetryNote(e.target.value)}
                  placeholder="补充背景或约束要求…"
                  style={{ width: '100%', marginTop: '6px' }}
                />
              </div>
              <div className="row" style={{ marginTop: '10px', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn pri"
                  disabled={busy}
                  data-testid="discussion-failure-retry"
                  onClick={() => onResolveFailure('retry')}
                >
                  直接重试
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || !retryNote.trim()}
                  data-testid="discussion-failure-retry-with"
                  onClick={() => onResolveFailure('retryWith')}
                >
                  补充说明后重试
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  data-testid="discussion-failure-stop"
                  onClick={() => onResolveFailure('stop')}
                >
                  停止讨论
                </button>
              </div>
            </section>
          )}

          {(view.pauseAt === 'stopped' || view.pauseAt === 'rejected') && (
            <section className="box wbox" data-testid="discussion-ended-card">
              <h2>{view.pauseAt === 'stopped' ? '讨论已停止' : '方案已否决'}</h2>
              <p style={{ marginTop: '6px' }}>{view.stoppedReason || view.pauseMessage || '当前讨论线程已结束。'}</p>
            </section>
          )}

          {effectiveTab === 'summary' && (
            <>
              {view.pendingAdjudications.length > 0 && (
                <section className="box wbox" data-testid="discussion-adjudication-list">
                  <h2>需要你裁决（{view.pendingAdjudications.length}）</h2>
                  <div className="stack" style={{ marginTop: '10px', gap: '12px' }}>
                    {view.pendingAdjudications.map((item) => {
                      const draft = rejectDrafts[item.key] ?? { open: false, reason: '' };
                      return (
                        <div
                          key={`${item.kind}:${item.key}`}
                          className="discuss-finding-card"
                          data-testid={`adjudication-card-${item.key}`}
                        >
                          <div className="row sb">
                            <strong>{item.summary}</strong>
                            <span className="tag warn">{item.severityLabel}</span>
                          </div>
                          <p className="muted">
                            {item.sourceLabel} · 首席处理结果：{item.chiefResolution}
                            {item.chiefReason ? `（${item.chiefReason}）` : ''}
                          </p>
                          <div className="kv" style={{ marginTop: '4px', fontSize: '14px' }}>
                            <span className="muted">影响</span>
                            <span>{item.impactText}</span>
                            <span className="muted">建议</span>
                            <span>{item.suggestionText}</span>
                            <span className="muted">依据原文</span>
                            <span>{item.basisText}</span>
                            <span className="muted">依据核验</span>
                            <span data-testid={`finding-basis-${item.key}`}>
                              <strong>{item.basisStatus}</strong> · {item.basisDetail}
                            </span>
                            <span className="muted">如果接受</span>
                            <span>{item.acceptConsequence}</span>
                            <span className="muted">如果驳回</span>
                            <span>{item.rejectConsequence}</span>
                          </div>

                          <div className="row" style={{ marginTop: '8px', gap: '8px', flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              data-testid={`adjudicate-accept-${item.key}`}
                              onClick={() => onAdjudicate(item, 'accept')}
                            >
                              接受
                            </button>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              data-testid={`adjudicate-open-reject-${item.key}`}
                              onClick={() =>
                                onChangeRejectDraft(item.key, { open: !draft.open, reason: draft.reason })
                              }
                            >
                              驳回并说明理由
                            </button>
                          </div>

                          {draft.open && (
                            <div style={{ marginTop: '8px' }}>
                              <label htmlFor={`reject-reason-${item.key}`} className="muted">
                                请写一句驳回理由（必填，批准后将记录在验收页风险中）：
                              </label>
                              <div className="row" style={{ marginTop: '6px', gap: '8px' }}>
                                <input
                                  id={`reject-reason-${item.key}`}
                                  type="text"
                                  className="grow"
                                  value={draft.reason}
                                  data-testid={`adjudicate-reason-${item.key}`}
                                  onChange={(e) =>
                                    onChangeRejectDraft(item.key, { open: true, reason: e.target.value })
                                  }
                                  placeholder="例如：首版保持简单，已接受该风险"
                                />
                                <button
                                  type="button"
                                  className="btn secondary"
                                  disabled={busy || !draft.reason.trim()}
                                  data-testid={`adjudicate-reject-${item.key}`}
                                  onClick={() => onAdjudicate(item, 'reject')}
                                >
                                  确认驳回
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {view.safetyIssues.length > 0 && (
                <section className="box wbox" data-testid="discussion-safety-issues">
                  <h2>安全检查未通过</h2>
                  <p className="muted" style={{ marginTop: '4px' }}>
                    存在隔离预期被打破的安全问题，当前不能批准本方案。
                  </p>
                  <ul style={{ margin: '8px 0 0', paddingLeft: '18px' }}>
                    {view.safetyIssues.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </section>
              )}

              {view.pauseAt === 'requirements_confirmation' && (
                <section className="box hl" data-testid="discussion-reqs-confirm-card">
                  <h2>确认需求条目（确认后冻结）</h2>
                  <p className="muted" style={{ marginTop: '4px' }}>
                    你可以修改、删除或添加需求条目；确认冻结后将作为方案与评审的唯一基准。
                  </p>
                  <div className="stack" style={{ marginTop: '10px', gap: '8px' }}>
                    {reqEdits.map((row, idx) => (
                      <div key={row.id ?? `new-${idx}`} className="row" style={{ gap: '8px' }}>
                        <span className="muted" style={{ minWidth: '34px' }}>
                          {row.id ?? '新'}
                        </span>
                        <input
                          type="text"
                          className="grow"
                          value={row.text}
                          data-testid={`req-edit-input-${idx}`}
                          onChange={(e) => {
                            const copy = reqEdits.slice();
                            copy[idx] = { ...row, text: e.target.value };
                            onChangeReqEdits(copy);
                          }}
                        />
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={busy || reqEdits.length <= 1}
                          data-testid={`req-edit-delete-${idx}`}
                          onClick={() => onChangeReqEdits(reqEdits.filter((_, i) => i !== idx))}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="row sb" style={{ marginTop: '12px', flexWrap: 'wrap', gap: '8px' }}>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      data-testid="req-edit-add"
                      onClick={() => onChangeReqEdits([...reqEdits, { text: '' }])}
                    >
                      ＋ 添加一条
                    </button>
                    <button
                      type="button"
                      className="btn pri"
                      disabled={busy || reqEdits.every((r) => !r.text.trim())}
                      data-testid="discussion-confirm-reqs"
                      onClick={onConfirmReqs}
                    >
                      确认并冻结需求
                    </button>
                  </div>
                </section>
              )}

              {view.pauseAt === 'ready' && !view.running && (
                <section className="box hl" data-testid="discussion-ready-card">
                  <h2>需求草稿</h2>
                  <p style={{ marginTop: '6px' }}>{view.rawRequirement}</p>
                  <p className="muted" style={{ marginTop: '8px' }}>
                    点击「开始讨论」由首席整理需求并起草方案；如果需求已经很明确，也可以跳过讨论直接填写施工计划。
                  </p>
                  <div className="row" style={{ marginTop: '12px', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn pri"
                      disabled={busy}
                      data-testid="start-discussion-button"
                      onClick={onStart}
                    >
                      {COPY.discussStartButton}
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      data-testid="skip-discussion-button"
                      onClick={onSkip}
                    >
                      {COPY.discussSkipButton}
                    </button>
                  </div>
                </section>
              )}

              {view.requirements.length > 0 && view.pauseAt !== 'requirements_confirmation' && (
                <section className="box" data-testid="discussion-requirements-card">
                  <div className="row sb">
                    <h2>
                      需求
                      {view.requirementsFrozen
                        ? `（第 ${view.requirementsVersion ?? 1} 版，已冻结）`
                        : '（待冻结）'}
                    </h2>
                    {canModifyReqs && (
                      <button
                        type="button"
                        className="link"
                        data-testid="modify-requirements-button"
                        onClick={() => onToggleModify(!modifyOpen)}
                      >
                        {COPY.discussModifyReqButton}
                      </button>
                    )}
                  </div>
                  {view.requirements.map((item) => (
                    <div key={item.id} className="item">
                      <strong>{item.id}</strong>
                      <span className="grow">{item.text}</span>
                    </div>
                  ))}
                  <p className="muted" style={{ marginTop: '8px' }}>
                    {COPY.discussModifyReqHint}
                  </p>
                  {modifyOpen && canModifyReqs && (
                    <div
                      className="box"
                      style={{ marginTop: '10px', background: 'var(--color-surface-subtle)' }}
                      data-testid="modify-requirements-panel"
                    >
                      <label htmlFor="modify-req-textarea">
                        <strong>输入修改后的需求</strong>
                      </label>
                      <textarea
                        id="modify-req-textarea"
                        rows={3}
                        value={modifyText}
                        data-testid="modify-requirements-input"
                        onChange={(e) => onChangeModifyText(e.target.value)}
                        style={{ width: '100%', marginTop: '6px' }}
                      />
                      <div className="row" style={{ marginTop: '8px', gap: '8px' }}>
                        <button
                          type="button"
                          className="btn pri"
                          disabled={busy || !modifyText.trim()}
                          data-testid="modify-requirements-submit"
                          onClick={onModifyRequirements}
                        >
                          重新开始讨论
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={busy}
                          onClick={() => onToggleModify(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {view.planVersion !== null && (
                <section className="box" data-testid="discussion-plan-card">
                  <div className="row sb">
                    <h2>方案（第 {view.planVersion} 版）</h2>
                    {view.planFullText && (
                      <button
                        type="button"
                        className="link"
                        data-testid="toggle-full-plan"
                        onClick={onToggleFullPlan}
                      >
                        {showFullPlan ? '收起全文' : '看全文'}
                      </button>
                    )}
                  </div>
                  <p style={{ marginTop: '6px' }} data-testid="discussion-plan-summary">
                    {view.planSummary}
                  </p>
                  {showFullPlan && view.planFullText && (
                    <pre className="plan-full-text" data-testid="full-plan-text">
                      {view.planFullText}
                    </pre>
                  )}
                </section>
              )}
            </>
          )}

          {effectiveTab === 'planner-chat' && (
            <section className="box" data-testid="discussion-planner-chat-panel">
              <h2>{COPY.discussTabPlannerChat}</h2>
              <p className="muted" style={{ marginTop: '6px' }}>
                {view.plannerLabel} 独立会话区域；与首席的讨论不会传给复核者。
              </p>
              <p className="muted" style={{ marginTop: '8px' }} data-testid="chat-modify-hint">
                {COPY.discussChatReqHint}
              </p>
            </section>
          )}

          {effectiveTab === 'reviewer-chat' && view.independentReview && (
            <section className="box" data-testid="discussion-reviewer-chat-panel">
              <h2>{COPY.discussTabReviewerChat}</h2>
              <p className="muted" style={{ marginTop: '6px' }}>
                {view.reviewerLabel} 独立会话区域（仅基于冻结需求、方案正文与其本人正式评审产物；不共享首席对话或原始推理）。
              </p>
              <p className="muted" style={{ marginTop: '8px' }} data-testid="chat-modify-hint">
                {COPY.discussChatReqHint}
              </p>
            </section>
          )}

          {effectiveTab === 'record' && (
            <section className="box" data-testid="discussion-record-panel">
              <div className="row sb">
                <h2>{COPY.discussTabRecord}（只读）</h2>
                {view.reviewRecord && (
                  <span className="muted">记录于 {view.reviewRecord.createdAt}</span>
                )}
              </div>
              {!view.reviewRecord ? (
                <p className="muted" style={{ marginTop: '8px' }} data-testid="discussion-record-empty">
                  {view.unreviewed
                    ? '当前为单思考者模式，已跳过独立评审，因此没有独立评审记录。'
                    : '尚未生成独立评审记录。'}
                </p>
              ) : (
                <div className="stack" style={{ marginTop: '12px' }}>
                  <div>
                    <strong>逐条需求检查</strong>
                    {view.reviewRecord.requirementChecks.map((rc) => (
                      <div key={rc.id} className="item">
                        <strong>{rc.id}</strong>
                        <span className={`tag${rc.covered ? ' ok' : ' warn'}`}>
                          {rc.covered ? '已覆盖' : '未覆盖'}
                        </span>
                        <span className="grow">{rc.text}</span>
                        {rc.note && <span className="muted">{rc.note}</span>}
                      </div>
                    ))}
                  </div>

                  <div>
                    <strong>评审意见与依据核验（{view.reviewRecord.findings.length}）</strong>
                    {view.reviewRecord.findings.length === 0 ? (
                      <p className="muted" style={{ marginTop: '6px' }}>复核未提出问题条目。</p>
                    ) : (
                      <div className="stack" style={{ marginTop: '8px', gap: '10px' }}>
                        {view.reviewRecord.findings.map((f) => (
                          <div
                            key={f.index}
                            className="discuss-finding-card"
                            data-testid={`record-finding-${f.index}`}
                          >
                            <div className="row sb">
                              <strong>#{f.index} {f.problem}</strong>
                              <span className="tag warn">{f.severity}</span>
                            </div>
                            <div className="kv" style={{ fontSize: '14px' }}>
                              <span className="muted">依据</span>
                              <span>{f.basis}</span>
                              <span className="muted">依据核验</span>
                              <span data-testid={`record-finding-basis-${f.index}`}>
                                <strong>{f.basisStatus}</strong> · {f.basisDetail}
                              </span>
                              <span className="muted">影响</span>
                              <span>{f.impact}</span>
                              <span className="muted">建议</span>
                              <span>{f.suggestion}</span>
                              <span className="muted">首席处理结果</span>
                              <span>
                                {f.chiefResolution}
                                {f.chiefReason ? `（${f.chiefReason}）` : ''}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {view.reviewRecord.neededMaterials.length > 0 && (
                    <div data-testid="record-needed-materials">
                      <strong>复核指出的缺口资料</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                        {view.reviewRecord.neededMaterials.map((m, idx) => (
                          <li key={idx}>{m}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {view.reviewRecord.itemMarks.length > 0 && (
                    <div>
                      <strong>首席对冻结条目的修订标注</strong>
                      {view.reviewRecord.itemMarks.map((m) => (
                        <div key={m.id} className="item">
                          <strong>{m.id}</strong>
                          <span className="tag">{m.mark}</span>
                          {m.note && <span className="muted">{m.note}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {view.reviewRecord.additions.length > 0 && (
                    <div>
                      <strong>相对冻结条目新增内容</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                        {view.reviewRecord.additions.map((a, idx) => (
                          <li key={idx}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="stack">
          <section className="box" data-testid="discussion-progress-card">
            <h2>进度</h2>
            <p className="muted" style={{ marginTop: '4px' }}>
              首席：{view.plannerLabel}
              {view.reviewerLabel ? ` · 复核：${view.reviewerLabel}` : ` · ${COPY.discussUnreviewedBadge}`}
            </p>
            <div className="discuss-step-list" style={{ marginTop: '10px' }}>
              {view.steps.map((st) => (
                <div
                  key={st.key}
                  className="discuss-step-item"
                  data-status={st.status}
                  data-testid={`discuss-step-${st.key}`}
                >
                  <span>{stepMarker(st.status)}</span>
                  <span>{st.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="box" data-testid="discussion-actions-card">
            <button
              type="button"
              className="btn pri"
              style={{ width: '100%' }}
              disabled={!canClickApprove}
              data-testid="approve-discussion-button"
              onClick={() => onApproveDecision('approve')}
            >
              {COPY.discussApproveButton}
            </button>
            {!canClickApprove && approvalHint && (
              <p className="muted" style={{ marginTop: '6px' }} data-testid="approve-blocked-reason">
                {approvalHint}
              </p>
            )}

            {view.pauseAt === 'approval' && !view.running && (
              <div className="row" style={{ marginTop: '10px', gap: '8px' }}>
                <button
                  type="button"
                  className="btn secondary grow"
                  disabled={busy}
                  data-testid="reject-discussion-button"
                  onClick={() => onApproveDecision('reject')}
                >
                  不批准方案
                </button>
                <button
                  type="button"
                  className="btn secondary grow"
                  disabled={busy}
                  data-testid="stop-discussion-button"
                  onClick={() => onApproveDecision('stop')}
                >
                  终止讨论
                </button>
              </div>
            )}

            {view.pauseAt !== 'ready' && !view.running && ['draft', 'clarifying'].includes(taskState) && (
              <button
                type="button"
                className="btn secondary"
                style={{ width: '100%', marginTop: '10px' }}
                disabled={busy}
                data-testid="skip-discussion-button"
                onClick={onSkip}
              >
                {COPY.discussSkipButton}
              </button>
            )}
          </section>

          <section className="box" data-testid="discussion-budget-card">
            <h2>用量与预算</h2>
            <div className="kv" style={{ marginTop: '8px', fontSize: '14px' }}>
              <span className="muted">已调用</span>
              <span data-testid="budget-calls">
                {view.budget.callsUsed} / {view.budget.callsMax} 次
              </span>
              <span className="muted">耗时</span>
              <span data-testid="budget-duration">{view.budget.durationSec} 秒</span>
              <span className="muted">费用</span>
              <span data-testid="budget-cost">
                {view.budget.knownCostUsd !== null
                  ? `$${view.budget.knownCostUsd.toFixed(4)}`
                  : '仅按次数与时长统计'}
              </span>
            </div>
            <p className="muted" style={{ marginTop: '8px' }}>
              {view.budgetNote}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function DiscussionPage({
  projectId,
  task,
  onTaskUpdated,
  onTaskReplaced,
}: DiscussionPageProps) {
  const [view, setView] = useState<DiscussionView | null>(null);
  const [activeTab, setActiveTab] = useState<DiscussionTab>('summary');
  const [selectedPreset, setSelectedPreset] = useState<DiscussionPreset>('codex-single');
  const [reqEdits, setReqEdits] = useState<RequirementEditInput[]>([]);
  const [retryNote, setRetryNote] = useState('');
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, { open: boolean; reason: string }>>({});
  const [showFullPlan, setShowFullPlan] = useState(false);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyText, setModifyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const syncFromView = useCallback((next: DiscussionView) => {
    setView(next);
    setSelectedPreset(next.preset);
    if (next.pauseAt === 'requirements_confirmation') {
      setReqEdits((prev) =>
        prev.length > 0 ? prev : next.requirements.map((r) => ({ id: r.id, text: r.text })),
      );
    } else {
      setReqEdits([]);
    }
    setModifyText((prev) => prev || next.rawRequirement);
  }, []);

  const refreshView = useCallback(async () => {
    const next = await studio().getDiscussionView(projectId, task.id);
    syncFromView(next);
    return next;
  }, [projectId, task.id, syncFromView]);

  useEffect(() => {
    setView(null);
    setReqEdits([]);
    setRejectDrafts({});
    setShowFullPlan(false);
    setModifyOpen(false);
    setModifyText(task.request);
    setActionError(null);
    void refreshView().catch((e) => setActionError(e instanceof Error ? e.message : String(e)));
  }, [projectId, task.id, task.request, refreshView]);

  useEffect(() => {
    if (!view?.running) return;
    const timer = setInterval(() => {
      void refreshView()
        .then((next) => {
          if (!next.running) {
            void studio().getTask(projectId, task.id).then(onTaskUpdated).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 250);
    return () => clearInterval(timer);
  }, [view?.running, projectId, task.id, refreshView, onTaskUpdated]);

  const runAction = async (fn: () => Promise<DiscussionView>) => {
    setActionError(null);
    setBusy(true);
    try {
      const next = await fn();
      syncFromView(next);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section className="box" data-testid="discussion-loading">
        {actionError ? <p className="error">{actionError}</p> : <p className="muted">正在加载讨论工作区…</p>}
      </section>
    );
  }

  return (
    <DiscussionViewBody
      view={view}
      taskState={task.state}
      busy={busy}
      actionError={actionError}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      selectedPreset={selectedPreset}
      onSelectPreset={setSelectedPreset}
      reqEdits={reqEdits}
      onChangeReqEdits={setReqEdits}
      retryNote={retryNote}
      onChangeRetryNote={setRetryNote}
      rejectDrafts={rejectDrafts}
      onChangeRejectDraft={(key, next) =>
        setRejectDrafts((prev) => ({ ...prev, [key]: next }))
      }
      showFullPlan={showFullPlan}
      onToggleFullPlan={() => setShowFullPlan((s) => !s)}
      modifyOpen={modifyOpen}
      modifyText={modifyText}
      onToggleModify={setModifyOpen}
      onChangeModifyText={setModifyText}
      onStart={() => void runAction(() => studio().startDiscussion(projectId, task.id, selectedPreset))}
      onSkip={() => {
        setActionError(null);
        setBusy(true);
        void studio()
          .skipDiscussion(projectId, task.id)
          .then(onTaskUpdated)
          .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
      onConsent={(allow) => {
        const svc = view.pendingConsentService;
        if (!svc) return;
        void runAction(() => studio().confirmDiscussionSend(projectId, task.id, svc, allow));
      }}
      onConfirmReqs={() =>
        void runAction(() => studio().confirmDiscussionRequirements(projectId, task.id, reqEdits))
      }
      onResolveFailure={(choice) =>
        void runAction(() =>
          studio().resolveDiscussionFailure(projectId, task.id, choice, retryNote),
        )
      }
      onAdjudicate={(item, decision) => {
        const reason = decision === 'reject' ? (rejectDrafts[item.key]?.reason ?? '') : '确认接受';
        void runAction(() =>
          studio().adjudicateDiscussion(projectId, task.id, item.kind, item.key, decision, reason),
        );
      }}
      onApproveDecision={(decision) => {
        setActionError(null);
        setBusy(true);
        void studio()
          .decideDiscussionApproval(projectId, task.id, decision)
          .then((res) => {
            syncFromView(res.view);
            onTaskUpdated(res.task);
          })
          .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
      onModifyRequirements={() => {
        setActionError(null);
        setBusy(true);
        void studio()
          .modifyDiscussionRequirements(projectId, task.id, modifyText)
          .then((nextTask) => {
            setModifyOpen(false);
            onTaskReplaced(nextTask);
          })
          .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    />
  );
}
