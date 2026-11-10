import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  ChiefRoleChoice,
  ClaudeKeySaveResult,
  ClaudeKeyStatus,
  DisclosureState,
  GlobalAiSettingsView,
  HealthReport,
  ReviewerRoleChoice,
} from './api.js';
import { HealthList } from './HealthList.js';
import { COPY } from './copy.js';

export type SettingsTab = 'ai' | 'disclosure' | 'health';

export function Disclosure({ state, onAccept, onClose }: { state: DisclosureState; onAccept?: () => void; onClose: () => void }) {
  const c = state.content;
  return (
    <div className="overlay">
      <div role="dialog" aria-modal="true" aria-labelledby="disc-h" className="dialog" data-testid="disclosure">
        <h2 id="disc-h">使用前请了解：资料会发给谁</h2>
        <h3>会发送给这些 AI 服务</h3>
        {c.services.length ? (
          <ul>{c.services.map((s) => <li key={s.name}><strong>{s.name}</strong>：{s.role}</li>)}</ul>
        ) : <p className="muted">目前没有检测到可用的 AI 服务。安装并登录后，这里会列出它们的名字。</p>}
        <h3>什么时候发送</h3>
        <ul>{c.when.map((w) => <li key={w}>{w}</li>)}</ul>
        <h3>不会发送什么</h3>
        <ul>{c.never.map((w) => <li key={w}>{w}</li>)}</ul>
        {state.accepted && <p className="muted">你已于 {new Date(state.accepted.acceptedAt).toLocaleString()} 确认。</p>}
        <div className="row">
          {onAccept && <button onClick={onAccept}>我了解了，同意</button>}
          <button className={onAccept ? 'secondary' : ''} onClick={onClose}>{onAccept ? '暂不同意，先看看' : '关闭'}</button>
        </div>
        {onAccept && <p className="muted">不同意也可以浏览环境检查；涉及发送资料的功能会保持关闭。</p>}
      </div>
    </div>
  );
}

function codexSummaryTag(env: HealthReport | null): { ok: boolean; label: string; detail: string } {
  const item = env?.items.find((i) => i.id === 'codex');
  if (!item) {
    return { ok: false, label: '未知', detail: '正在读取本机 Codex 登录与环境状态' };
  }
  if (item.overall === 'pass') {
    return { ok: true, label: '可用', detail: '本机 ChatGPT 登录 / Codex CLI 就绪' };
  }
  if (item.layers.installed.state === 'fail') {
    return { ok: false, label: '未安装', detail: item.layers.installed.note ?? '本机尚未检测到 Codex' };
  }
  if (item.layers.loggedIn.state === 'fail') {
    return { ok: false, label: '未登录', detail: item.layers.loggedIn.note ?? '请在终端完成 Codex 登录' };
  }
  return {
    ok: false,
    label: item.overall === 'unknown' ? '未知' : '不可用',
    detail: item.advice ?? item.layers.loggedIn.note ?? '请前往「环境体检」查看详情',
  };
}

function roleChoiceDisplay(choice: ChiefRoleChoice | ReviewerRoleChoice): string {
  if (choice === 'codex') return 'Codex';
  if (choice === 'claude') return 'Claude';
  if (choice === 'none') return '不复核';
  return '未设置';
}

function unconnectedWarningForRoles(
  chief: ChiefRoleChoice,
  reviewer: ReviewerRoleChoice,
  codexAvailable: boolean,
  claudeAvailable: boolean,
): string | null {
  if (chief === 'unset' || reviewer === 'unset') {
    return '存在「未设置」的角色（可能因删掉了 Key），请重新选择已接入的 AI（复核可选「不复核」）后再保存。';
  }
  const needClaude = chief === 'claude' || reviewer === 'claude';
  if (needClaude && !claudeAvailable) {
    return '已选角色用到了未接入的 Claude，请先在左侧保存并验证 Anthropic API Key 后再保存。';
  }
  const needCodex = chief === 'codex' || reviewer === 'codex';
  if (needCodex && !codexAvailable) {
    return '已选角色用到了尚未接入的 Codex，请先在终端登录 Codex 后再保存。';
  }
  return null;
}

/**
 * 全局设置（13-settings，UI v2.1 第 2/9 节）：
 * AI 与角色（接入状态、Anthropic API Key、默认角色与执行者说明）、资料外发 与 环境体检。
 */
export function SettingsPage({
  tab,
  disc,
  env,
  claudeKey = null,
  aiSettings = null,
  error,
  onTabChange,
  onShowDisclosure,
  onRefreshEnv,
  onSaveClaudeKey,
  onDeleteClaudeKey,
  onSaveAiRoles,
}: {
  tab: SettingsTab;
  disc: DisclosureState | null;
  env: HealthReport | null;
  claudeKey?: ClaudeKeyStatus | null;
  aiSettings?: GlobalAiSettingsView | null;
  error: string | null;
  onTabChange: (tab: SettingsTab) => void;
  onShowDisclosure: () => void;
  onRefreshEnv: () => void;
  onSaveClaudeKey?: (secret: string) => Promise<ClaudeKeySaveResult>;
  onDeleteClaudeKey?: () => Promise<ClaudeKeyStatus>;
  onSaveAiRoles?: (chief: string, reviewer: string, model: string) => Promise<GlobalAiSettingsView>;
}) {
  const uid = useId();
  const keyInputId = `${uid}-claude-secret`;
  const modelListId = `${uid}-claude-models`;
  const [secretDraft, setSecretDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  const [chiefDraft, setChiefDraft] = useState<ChiefRoleChoice>(aiSettings?.roles.chief ?? 'codex');
  const [reviewerDraft, setReviewerDraft] = useState<ReviewerRoleChoice>(aiSettings?.roles.reviewer ?? 'none');
  const [modelDraft, setModelDraft] = useState<string>(aiSettings?.roles.claudeModel ?? 'claude-opus-5-5');
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  const rolesDirtyRef = useRef(false);

  useEffect(() => {
    if (!aiSettings || rolesDirtyRef.current) return;
    setChiefDraft(aiSettings.roles.chief);
    setReviewerDraft(aiSettings.roles.reviewer);
    setModelDraft(aiSettings.roles.claudeModel);
  }, [aiSettings?.roles.chief, aiSettings?.roles.reviewer, aiSettings?.roles.claudeModel]);

  const effectiveKey = aiSettings?.claudeKey ?? claudeKey;
  const codexFromEnv = codexSummaryTag(env);
  const codex = aiSettings
    ? { ok: aiSettings.codex.available, label: aiSettings.codex.statusLabel, detail: aiSettings.codex.detail }
    : codexFromEnv;
  const claudeAvailable = !!(effectiveKey?.configured && effectiveKey.available);
  const sameAiNotice =
    (chiefDraft === 'codex' || chiefDraft === 'claude') && chiefDraft === reviewerDraft
      ? `「首席」与「复核」都选择了 ${roleChoiceDisplay(chiefDraft)}：由于不是两个独立的 AI，讨论将按单思考者模式运行，并标记「未经独立评审」。`
      : null;
  const unconnectedWarn = unconnectedWarningForRoles(chiefDraft, reviewerDraft, codex.ok, claudeAvailable);

  const handleSaveKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSaveClaudeKey || keyBusy) return;
    if (!secretDraft.trim()) {
      setKeyError('Key 无效：请先输入 Anthropic API Key。');
      setKeyNotice(null);
      return;
    }
    setKeyBusy(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const res = await onSaveClaudeKey(secretDraft);
      if (res.ok) {
        setSecretDraft('');
        setKeyNotice(`已完成最小请求验证并加密保存（尾号 ${res.status.last4 ?? '****'}）。`);
      } else {
        setKeyError(res.message);
      }
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : '保存失败，请重试。');
    } finally {
      setKeyBusy(false);
    }
  };

  const handleDeleteKey = async () => {
    if (!onDeleteClaudeKey || keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    setKeyNotice(null);
    setRoleNotice(null);
    try {
      rolesDirtyRef.current = false;
      await onDeleteClaudeKey();
      setSecretDraft('');
      setKeyNotice('已删除 Anthropic API Key；使用 Claude 的角色已自动回退为「未设置」，将在下次讨论前提示重新配置。');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : '删除失败，请重试。');
    } finally {
      setKeyBusy(false);
    }
  };

  const handleSaveRoles = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSaveAiRoles || roleBusy || unconnectedWarn) return;
    setRoleBusy(true);
    setRoleError(null);
    setRoleNotice(null);
    try {
      rolesDirtyRef.current = false;
      await onSaveAiRoles(chiefDraft, reviewerDraft, modelDraft);
      setRoleNotice('默认角色设置已保存（已开始中的讨论线程不受影响）。');
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : '保存失败，请重试。');
    } finally {
      setRoleBusy(false);
    }
  };

  return (
    <main className="main" data-testid="settings-page" aria-label={COPY.settingsTitle}>
      <div>
        <h1>{COPY.settingsTitle}</h1>
        <p className="lede">{COPY.settingsSubtitle}</p>
      </div>
      {error && <p role="alert" className="error" data-testid="app-error">{error}</p>}

      <div className="tabs" role="tablist" aria-label={COPY.settingsTitle}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ai'}
          className={tab === 'ai' ? 'tc' : ''}
          data-testid="tab-settings-ai"
          onClick={() => onTabChange('ai')}
        >
          {COPY.settingsTabAi}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'disclosure'}
          className={tab === 'disclosure' ? 'tc' : ''}
          data-testid="tab-settings-disclosure"
          onClick={() => onTabChange('disclosure')}
        >
          {COPY.settingsTabDisclosure}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'health'}
          className={tab === 'health' ? 'tc' : ''}
          data-testid="tab-settings-health"
          onClick={() => onTabChange('health')}
        >
          {COPY.settingsTabHealth}
        </button>
      </div>

      {tab === 'ai' ? (
        <div className="grid">
          <section className="box" aria-labelledby="ai-conn-h" data-testid="settings-ai-connections">
            <h2 id="ai-conn-h">已接入的 AI</h2>
            <div className="item" data-testid="ai-status-codex">
              <div className="grow">
                <strong>Codex</strong>
                <div className="muted">{codex.detail}</div>
              </div>
              <span className={codex.ok ? 'tag ok' : 'tag warn'}>{codex.label}</span>
            </div>
            <div className="item" data-testid="ai-status-claude">
              <div className="grow">
                <strong>Claude</strong>
                <div className="muted" data-testid="claude-key-summary">
                  {!effectiveKey?.configured
                    ? 'Anthropic API Key：未设置（不读取外部工具凭证）'
                    : effectiveKey.available
                      ? `Anthropic API Key：已设置（尾号 ${effectiveKey.last4 ?? '****'}）`
                      : `Anthropic API Key：已设置（尾号 ${effectiveKey.last4 ?? '****'}）· 当前不可用`}
                </div>
                {effectiveKey?.unavailableReason && (
                  <p className="error" style={{ marginTop: '4px' }} role="alert" data-testid="claude-key-unavailable">
                    {effectiveKey.unavailableReason}
                  </p>
                )}
              </div>
              <span className={claudeAvailable ? 'tag ok' : 'tag warn'} data-testid="claude-key-tag">
                {!effectiveKey?.configured ? '未设置' : claudeAvailable ? '可用' : '不可用'}
              </span>
            </div>

            <form onSubmit={handleSaveKey} noValidate style={{ marginTop: '12px' }} data-testid="claude-key-form">
              <label htmlFor={keyInputId}>
                <strong>设置或更换 Anthropic API Key</strong>
              </label>
              <p className="muted" style={{ marginTop: '4px' }}>
                仅用于本应用的思考讨论（使用系统加密存储保存在本机，绝不明文落盘，也不传回界面展示）。保存前会先发起一次最小请求验证。
              </p>
              <div className="row" style={{ marginTop: '8px', gap: '8px', alignItems: 'center' }}>
                <input
                  id={keyInputId}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secretDraft}
                  disabled={keyBusy}
                  data-testid="claude-key-input"
                  placeholder="sk-ant-..."
                  aria-label="Anthropic API Key"
                  onChange={(e) => {
                    setSecretDraft(e.target.value);
                    if (keyError) setKeyError(null);
                  }}
                  style={{ flex: 1, minWidth: '220px' }}
                />
                <button type="submit" className="btn pri" disabled={keyBusy} data-testid="claude-key-save">
                  {keyBusy ? '验证中…' : '验证并保存'}
                </button>
                {effectiveKey?.configured && (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={keyBusy}
                    data-testid="claude-key-delete"
                    onClick={handleDeleteKey}
                  >
                    删除 Key
                  </button>
                )}
              </div>
              {keyError && (
                <p role="alert" className="error" style={{ marginTop: '8px' }} data-testid="claude-key-error">
                  {keyError}
                </p>
              )}
              {keyNotice && (
                <p role="status" className="muted" style={{ marginTop: '8px' }} data-testid="claude-key-notice">
                  {keyNotice}
                </p>
              )}
            </form>
          </section>

          <section className="box" aria-labelledby="ai-roles-h" data-testid="settings-default-roles">
            <h2 id="ai-roles-h">默认角色</h2>
            <p className="muted" style={{ marginTop: '4px' }}>
              新建讨论默认按此分配（单个项目可在「项目设置」覆盖；修改设置只影响尚未开始的讨论）。
            </p>
            <form onSubmit={handleSaveRoles} noValidate style={{ marginTop: '8px' }}>
              <div className="item">
                <div className="grow">
                  <label htmlFor={`${uid}-chief`}>
                    <strong>首席</strong> <span className="muted">· 写方案</span>
                  </label>
                </div>
                <select
                  id={`${uid}-chief`}
                  aria-label="首席"
                  data-testid="global-role-chief"
                  value={chiefDraft}
                  onChange={(e) => {
                    rolesDirtyRef.current = true;
                    setChiefDraft(e.target.value as ChiefRoleChoice);
                    setRoleError(null);
                    setRoleNotice(null);
                  }}
                >
                  {chiefDraft === 'unset' && (
                    <option value="unset" disabled>
                      未设置（请重新选择）
                    </option>
                  )}
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </div>

              <div className="item">
                <div className="grow">
                  <label htmlFor={`${uid}-reviewer`}>
                    <strong>复核</strong> <span className="muted">· 独立找错</span>
                  </label>
                </div>
                <select
                  id={`${uid}-reviewer`}
                  aria-label="复核"
                  data-testid="global-role-reviewer"
                  value={reviewerDraft}
                  onChange={(e) => {
                    rolesDirtyRef.current = true;
                    setReviewerDraft(e.target.value as ReviewerRoleChoice);
                    setRoleError(null);
                    setRoleNotice(null);
                  }}
                >
                  {reviewerDraft === 'unset' && (
                    <option value="unset" disabled>
                      未设置（请重新选择）
                    </option>
                  )}
                  <option value="none">不复核</option>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </div>

              <div className="item">
                <div className="grow">
                  <strong>执行</strong> <span className="muted">· 每个任务一个（目前仅支持 Codex）</span>
                </div>
                <span data-testid="global-role-executor" className="tag">
                  Codex（固定）
                </span>
              </div>

              <div className="item">
                <div className="grow">
                  <label htmlFor={`${uid}-model`}>
                    <strong>Claude 模型</strong> <span className="muted">· 默认推荐 claude-opus-5-5</span>
                  </label>
                </div>
                <input
                  id={`${uid}-model`}
                  type="text"
                  list={modelListId}
                  aria-label="Claude 模型"
                  data-testid="global-claude-model"
                  value={modelDraft}
                  onChange={(e) => {
                    rolesDirtyRef.current = true;
                    setModelDraft(e.target.value);
                    setRoleError(null);
                    setRoleNotice(null);
                  }}
                  style={{ minWidth: '180px' }}
                />
                <datalist id={modelListId}>
                  {(aiSettings?.availableClaudeModels ?? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              {sameAiNotice && (
                <p className="notice" style={{ marginTop: '10px' }} data-testid="global-same-ai-notice">
                  {sameAiNotice}
                </p>
              )}

              {unconnectedWarn && (
                <p role="alert" className="error" style={{ marginTop: '10px' }} data-testid="global-role-unconnected-warn">
                  {unconnectedWarn}
                </p>
              )}

              {roleError && (
                <p role="alert" className="error" style={{ marginTop: '10px' }} data-testid="global-roles-error">
                  {roleError}
                </p>
              )}

              {roleNotice && (
                <p role="status" className="muted" style={{ marginTop: '10px' }} data-testid="global-roles-notice">
                  {roleNotice}
                </p>
              )}

              <div className="row" style={{ marginTop: '12px' }}>
                <button
                  type="submit"
                  className="btn pri"
                  disabled={roleBusy || !!unconnectedWarn}
                  data-testid="global-roles-save"
                >
                  {roleBusy ? '保存中…' : '保存默认角色'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : tab === 'disclosure' ? (
        <section className="box" aria-labelledby="out-h">
          <h2 id="out-h">{COPY.settingsTabDisclosure}</h2>
          <p data-testid="outbound-status">
            {disc?.accepted ? '已确认外发说明：涉及发送资料的功能可用（每次发送前仍会让你确认清单）。' : '尚未确认外发说明：涉及发送资料的功能已关闭。'}
          </p>
          <div className="row" style={{ marginTop: '10px' }}>
            <button type="button" className={disc?.accepted ? 'secondary' : ''} onClick={onShowDisclosure}>
              查看外发说明
            </button>
          </div>
        </section>
      ) : (
        <section className="box" aria-labelledby="env-h">
          <h2 id="env-h">{COPY.onboardingTitle}</h2>
          <HealthList env={env} primaryRefresh={true} onRefresh={onRefreshEnv} />
        </section>
      )}
    </main>
  );
}
