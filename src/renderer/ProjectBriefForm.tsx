import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { PROJECT_BRIEF_OUTBOUND_NOTICE } from './copy.js';
import type { ProjectBriefInput } from './api.js';

export interface ProjectBriefFormProps {
  initial?: ProjectBriefInput | null;
  title?: string;
  submitLabel: string;
  busy?: boolean;
  outboundNotice?: string;
  savedNotice?: string | null;
  serverError?: string | null;
  onSubmit: (brief: ProjectBriefInput) => Promise<void> | void;
  onCancel?: () => void;
}

/**
 * 项目简介表单（3 个问题，对应 .studio/project-brief.md 第 1、2、4 节）。
 * 遵循无障碍与表单交互规范：可见标签、提交/失焦校验、输入即清除错误、提交失败时聚焦到首个无效字段。
 */
export function ProjectBriefForm({
  initial,
  title = '项目简介',
  submitLabel,
  busy = false,
  outboundNotice = PROJECT_BRIEF_OUTBOUND_NOTICE,
  savedNotice = null,
  serverError = null,
  onSubmit,
  onCancel,
}: ProjectBriefFormProps) {
  const uid = useId();
  const [whatItIs, setWhatItIs] = useState(initial?.whatItIs ?? '');
  const [principles, setPrinciples] = useState(initial?.principles ?? '');
  const [targetUsers, setTargetUsers] = useState(initial?.targetUsers ?? '');
  const [whatError, setWhatError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [whatTouched, setWhatTouched] = useState(false);
  const [targetTouched, setTargetTouched] = useState(false);

  const whatRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setWhatItIs(initial?.whatItIs ?? '');
    setPrinciples(initial?.principles ?? '');
    setTargetUsers(initial?.targetUsers ?? '');
    setWhatError(null);
    setTargetError(null);
    setWhatTouched(false);
    setTargetTouched(false);
  }, [initial?.whatItIs, initial?.principles, initial?.targetUsers]);

  const whatId = `${uid}-what`;
  const principlesId = `${uid}-principles`;
  const targetId = `${uid}-target`;
  const whatErrId = `${uid}-what-err`;
  const targetErrId = `${uid}-target-err`;
  const principlesHintId = `${uid}-principles-hint`;
  const outboundId = `${uid}-outbound`;

  const validateWhat = (v: string) => (!v.trim() ? '请先填写「这个项目是什么」' : null);
  const validateTarget = (v: string) => (!v.trim() ? '请先填写「做给谁用」' : null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errWhat = validateWhat(whatItIs);
    const errTarget = validateTarget(targetUsers);
    setWhatTouched(true);
    setTargetTouched(true);
    setWhatError(errWhat);
    setTargetError(errTarget);
    if (errWhat) {
      whatRef.current?.focus();
      return;
    }
    if (errTarget) {
      targetRef.current?.focus();
      return;
    }
    await onSubmit({
      whatItIs: whatItIs.trim(),
      principles: principles.trim(),
      targetUsers: targetUsers.trim(),
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby={`${uid}-h`} data-testid="project-brief-form">
      <h2 id={`${uid}-h`}>{title}</h2>
      <p className="muted" style={{ marginTop: '4px' }}>
        只需要回答这三个问题，帮助参与讨论的 AI 了解项目定位、边界和目标人群。
      </p>

      <div style={{ marginTop: '10px' }}>
        <label htmlFor={whatId}>
          <strong>1. 这个项目是什么？（一两句话）</strong> <span aria-hidden="true">*</span>
        </label>
        <textarea
          ref={whatRef}
          id={whatId}
          name="whatItIs"
          rows={2}
          required
          aria-required="true"
          aria-invalid={whatError ? 'true' : 'false'}
          aria-describedby={whatError ? whatErrId : undefined}
          data-testid="brief-what-input"
          value={whatItIs}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            setWhatItIs(next);
            if (whatError && !validateWhat(next)) setWhatError(null);
          }}
          onBlur={() => {
            if (whatTouched || whatItIs.length > 0) setWhatError(validateWhat(whatItIs));
          }}
          placeholder="例如：一个给独立咖啡店用的在线点单与库存看板。"
        />
        {whatError && (
          <p id={whatErrId} role="alert" className="error" style={{ marginTop: '4px' }}>
            {whatError}
          </p>
        )}
      </div>

      <div style={{ marginTop: '10px' }}>
        <label htmlFor={principlesId}>
          <strong>2. 有什么原则不能违反？（选填，可以留空写「暂无」）</strong>
        </label>
        <span id={principlesHintId} className="muted" style={{ display: 'block', marginTop: '2px' }}>
          留空保存时会自动记录为「暂无」。
        </span>
        <textarea
          id={principlesId}
          name="principles"
          rows={2}
          aria-describedby={principlesHintId}
          data-testid="brief-principles-input"
          value={principles}
          disabled={busy}
          onChange={(e) => setPrinciples(e.target.value)}
          placeholder="例如：不接入第三方支付；不自动覆盖用户手工编辑的配置。"
        />
      </div>

      <div style={{ marginTop: '10px' }}>
        <label htmlFor={targetId}>
          <strong>3. 做给谁用？</strong> <span aria-hidden="true">*</span>
        </label>
        <textarea
          ref={targetRef}
          id={targetId}
          name="targetUsers"
          rows={2}
          required
          aria-required="true"
          aria-invalid={targetError ? 'true' : 'false'}
          aria-describedby={targetError ? targetErrId : undefined}
          data-testid="brief-target-input"
          value={targetUsers}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            setTargetUsers(next);
            if (targetError && !validateTarget(next)) setTargetError(null);
          }}
          onBlur={() => {
            if (targetTouched || targetUsers.length > 0) setTargetError(validateTarget(targetUsers));
          }}
          placeholder="例如：不会写代码的店长和店员，用手机或平板日常操作。"
        />
        {targetError && (
          <p id={targetErrId} role="alert" className="error" style={{ marginTop: '4px' }}>
            {targetError}
          </p>
        )}
      </div>

      <p id={outboundId} className="notice muted" style={{ marginTop: '12px' }} data-testid="brief-outbound-notice">
        {outboundNotice}
      </p>

      {serverError && (
        <p role="alert" className="error" style={{ marginTop: '8px' }} data-testid="brief-error">
          {serverError}
        </p>
      )}
      {savedNotice && (
        <p role="status" className="notice" style={{ marginTop: '8px' }} data-testid="brief-saved-notice">
          {savedNotice}
        </p>
      )}

      <div className="row" style={{ marginTop: '12px', gap: '8px' }}>
        <button type="submit" className="btn pri" disabled={busy} data-testid="brief-submit-button">
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" disabled={busy} data-testid="brief-cancel-button" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
