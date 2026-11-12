import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  ApiProviderPreset,
  ChiefRoleChoice,
  ClaudeKeySaveResult,
  ClaudeKeyStatus,
  DisclosureState,
  GlobalAiSettingsView,
  HealthReport,
  ProviderProfileView,
  ReviewerRoleChoice,
  SaveProviderProfileResult,
  SubscriptionCliView,
  SubscriptionEnableInput,
  SubscriptionEnableResult,
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
  onSaveAndTestProvider,
  onDeleteProviderProfile,
  onSaveDefaultExecutor,
  onFetchProviderModels,
  onEnableSubscriptionCli,
  onDisableSubscriptionCli,
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
  onSaveAndTestProvider?: (input: {
    id?: string;
    presetId: string;
    label?: string;
    endpoint: string;
    model: string;
    secret?: string;
  }) => Promise<SaveProviderProfileResult>;
  onDeleteProviderProfile?: (id: string) => Promise<GlobalAiSettingsView>;
  onSaveDefaultExecutor?: (id: string) => Promise<GlobalAiSettingsView>;
  onFetchProviderModels?: (input: {
    presetId: string;
    endpoint: string;
    secret?: string;
    savedId?: string;
  }) => Promise<{ ok: boolean; models?: string[]; message?: string }>;
  onEnableSubscriptionCli?: (input: SubscriptionEnableInput) => Promise<SubscriptionEnableResult>;
  onDisableSubscriptionCli?: (id: string) => Promise<GlobalAiSettingsView>;
}) {
  const uid = useId();
  const keyInputId = `${uid}-claude-secret`;
  const modelListId = `${uid}-claude-models`;
  const providerModelListId = `${uid}-provider-models`;
  const [secretDraft, setSecretDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  const [chiefDraft, setChiefDraft] = useState<ChiefRoleChoice>(aiSettings?.roles.chief ?? 'codex');
  const [reviewerDraft, setReviewerDraft] = useState<ReviewerRoleChoice>(aiSettings?.roles.reviewer ?? 'none');
  const [modelDraft, setModelDraft] = useState<string>(aiSettings?.roles.claudeModel ?? 'claude-opus-5-5');
  const [executorDraft, setExecutorDraft] = useState<string>(aiSettings?.defaultExecutor ?? 'codex');
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  const rolesDirtyRef = useRef(false);

  const presets: readonly ApiProviderPreset[] = aiSettings?.executorPresets ?? [];
  const [presetId, setPresetId] = useState<string>('deepseek');
  const selectedPreset = presets.find((p) => p.id === presetId) ?? presets[0];
  const [providerEndpoint, setProviderEndpoint] = useState<string>(() => selectedPreset?.defaultEndpoint ?? '');
  const [providerModel, setProviderModel] = useState<string>(() => selectedPreset?.suggestedModels[0] ?? 'deepseek-chat');
  const [providerSecret, setProviderSecret] = useState<string>('');
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [providerBusy, setProviderBusy] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);

  const [subModels, setSubModels] = useState<Record<string, string>>({});
  const [subModalItem, setSubModalItem] = useState<SubscriptionCliView | null>(null);
  const [subRiskChecked, setSubRiskChecked] = useState(false);
  const [subBusyId, setSubBusyId] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);
  const [subNotice, setSubNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!providerEndpoint && selectedPreset?.defaultEndpoint) {
      setProviderEndpoint(selectedPreset.defaultEndpoint);
    }
  }, [providerEndpoint, selectedPreset?.defaultEndpoint]);

  useEffect(() => {
    if (!aiSettings || rolesDirtyRef.current) return;
    setChiefDraft(aiSettings.roles.chief);
    setReviewerDraft(aiSettings.roles.reviewer);
    setModelDraft(aiSettings.roles.claudeModel);
    if (aiSettings.defaultExecutor) setExecutorDraft(aiSettings.defaultExecutor);
  }, [aiSettings?.roles.chief, aiSettings?.roles.reviewer, aiSettings?.roles.claudeModel, aiSettings?.defaultExecutor]);

  const handleSelectPreset = (nextId: string) => {
    setPresetId(nextId);
    const p = presets.find((x) => x.id === nextId);
    if (p) {
      setProviderEndpoint(p.defaultEndpoint);
      setProviderModel(p.suggestedModels[0] ?? '');
      setFetchedModels([]);
      setProviderError(null);
      setProviderNotice(null);
    }
  };

  const handleFetchModels = async () => {
    if (!onFetchProviderModels || modelsBusy) return;
    setModelsBusy(true);
    setProviderError(null);
    setProviderNotice(null);
    try {
      const r = await onFetchProviderModels({
        presetId: selectedPreset?.id ?? presetId,
        endpoint: providerEndpoint,
        ...(providerSecret.trim() ? { secret: providerSecret.trim() } : {}),
      });
      if (r.ok && r.models?.length) {
        setFetchedModels(r.models);
        if (!providerModel.trim()) setProviderModel(r.models[0]!);
        setProviderNotice(`已拉取 ${r.models.length} 个可用模型，可在模型框中选择或手填。`);
      } else if (r.ok) {
        setProviderNotice('服务端未返回模型列表，请手动输入模型 ID。');
      } else {
        setProviderError(r.message ?? '拉取模型列表失败，请检查地址和密钥。');
      }
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : '拉取模型列表失败。');
    } finally {
      setModelsBusy(false);
    }
  };

  const handleSaveAndTestProvider = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSaveAndTestProvider || providerBusy) return;
    setProviderBusy(true);
    setProviderError(null);
    setProviderNotice(null);
    try {
      const res = await onSaveAndTestProvider({
        presetId: selectedPreset?.id ?? presetId,
        endpoint: providerEndpoint,
        model: providerModel,
        ...(providerSecret.trim() ? { secret: providerSecret.trim() } : {}),
      });
      if (res.ok) {
        setProviderSecret('');
        setProviderNotice(res.message);
      } else {
        setProviderError(res.message);
      }
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : '连接测试失败，请重试。');
    } finally {
      setProviderBusy(false);
    }
  };

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
      const verifiedExecs = aiSettings?.verifiedExecutors ?? [];
      if (onSaveDefaultExecutor && verifiedExecs.some((v) => v.id === executorDraft)) {
        await onSaveDefaultExecutor(executorDraft);
      }
      setRoleNotice('默认角色与执行者设置已保存（已开始中的任务不受影响）。');
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
        <div className="settings-grid">
          <section className="box" aria-labelledby="ai-conn-h" data-testid="settings-ai-connections">
            <h2 id="ai-conn-h">已接入的 AI</h2>
            <div className="item" data-testid="ai-status-codex" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ overflow: 'hidden' }}>
                <strong>Codex</strong>
                <div className="muted" style={{ wordBreak: 'break-word', whiteSpace: 'normal' }}>{codex.detail}</div>
              </div>
              <span className={codex.ok ? 'tag ok' : 'tag warn'} style={{ flexShrink: 0 }}>{codex.label}</span>
            </div>
            <div className="item" data-testid="ai-status-claude" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ overflow: 'hidden' }}>
                <strong>Claude</strong>
                <div className="muted" style={{ wordBreak: 'break-word', whiteSpace: 'normal' }} data-testid="claude-key-summary">
                  {!effectiveKey?.configured
                    ? 'Anthropic API Key：未设置'
                    : effectiveKey.available
                      ? `已设置（尾号 ${effectiveKey.last4 ?? '****'}）`
                      : `已设置（尾号 ${effectiveKey.last4 ?? '****'}）· 当前不可用`}
                </div>
                {effectiveKey?.unavailableReason && (
                  <p className="error" style={{ marginTop: '4px' }} role="alert" data-testid="claude-key-unavailable">
                    {effectiveKey.unavailableReason}
                  </p>
                )}
              </div>
              <span className={claudeAvailable ? 'tag ok' : 'tag warn'} style={{ flexShrink: 0 }} data-testid="claude-key-tag">
                {!effectiveKey?.configured ? '未设置' : claudeAvailable ? '可用' : '不可用'}
              </span>
            </div>
            {aiSettings?.standaloneSandbox && (
              <div className="item" data-testid="ai-status-check-runner" style={{ alignItems: 'flex-start' }}>
                <div className="grow" style={{ overflow: 'hidden' }}>
                  <strong>独立受限检查环境</strong>
                  <div className="muted" style={{ wordBreak: 'break-word', whiteSpace: 'normal' }}>{aiSettings.standaloneSandbox.detail}</div>
                </div>
                <span
                  className={aiSettings.standaloneSandbox.available ? 'tag ok' : 'tag warn'}
                  style={{ flexShrink: 0 }}
                  data-testid="check-runner-tag"
                >
                  {aiSettings.standaloneSandbox.label}
                </span>
              </div>
            )}

            <form onSubmit={handleSaveKey} noValidate style={{ marginTop: '12px' }} data-testid="claude-key-form">
              <label htmlFor={keyInputId}>
                <strong>设置或更换 Anthropic API Key</strong>
              </label>
              <p className="muted" style={{ marginTop: '4px' }}>
                仅用于本应用的思考讨论（系统加密存储，绝不明文落盘）。保存前会先发起一次最小请求验证。
              </p>
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
                style={{ marginTop: '8px' }}
              />
              <div className="row" style={{ marginTop: '8px', gap: '8px' }}>
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

              <div className="item" style={{ flexWrap: 'wrap', gap: '8px' }}>
                <div className="grow" style={{ minWidth: '160px' }}>
                  <label htmlFor={`${uid}-executor`}>
                    <strong>执行</strong> <span className="muted">· 动手写代码</span>
                  </label>
                  <div className="muted" style={{ fontSize: '12px' }}>仅可选连接测试通过的执行者</div>
                </div>
                <div className="row" style={{ gap: '8px', alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%', minWidth: 0 }}>
                  <select
                    id={`${uid}-executor`}
                    aria-label="默认执行者"
                    data-testid="global-role-executor"
                    value={executorDraft}
                    style={{ maxWidth: '100%', minWidth: 0 }}
                    onChange={(e) => {
                      rolesDirtyRef.current = true;
                      setExecutorDraft(e.target.value);
                      setRoleError(null);
                      setRoleNotice(null);
                    }}
                  >
                    {executorDraft === 'unset' && (
                      <option value="unset" disabled>
                        未设置（请重新选择）
                      </option>
                    )}
                    {(aiSettings?.verifiedExecutors ?? []).length === 0 && executorDraft === 'codex' && (
                      <option value="codex">Codex（本机）</option>
                    )}
                    {executorDraft !== 'unset' &&
                      (aiSettings?.verifiedExecutors ?? []).length > 0 &&
                      !(aiSettings?.verifiedExecutors ?? []).some((v) => v.id === executorDraft) && (
                        <option value={executorDraft} disabled>
                          {executorDraft === 'codex' ? 'Codex（当前未就绪）' : `${executorDraft}（当前不可用）`}
                        </option>
                      )}
                    {(aiSettings?.verifiedExecutors ?? []).map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {onSaveDefaultExecutor &&
                    executorDraft !== aiSettings?.defaultExecutor &&
                    (aiSettings?.verifiedExecutors ?? []).some((v) => v.id === executorDraft) && (
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={roleBusy}
                        data-testid="global-executor-apply"
                        onClick={async () => {
                          rolesDirtyRef.current = false;
                          setRoleBusy(true);
                          setRoleError(null);
                          setRoleNotice(null);
                          try {
                            await onSaveDefaultExecutor(executorDraft);
                            setRoleNotice('默认执行者已保存（已开始中的任务不受影响）。');
                          } catch (err) {
                            setRoleError(err instanceof Error ? err.message : '保存默认执行者失败。');
                          } finally {
                            setRoleBusy(false);
                          }
                        }}
                      >
                        应用执行者
                      </button>
                    )}
                </div>
              </div>
              {aiSettings?.executorProblem && (
                <p role="alert" className="error" style={{ marginTop: '6px' }} data-testid="global-executor-problem">
                  {aiSettings.executorProblem}
                </p>
              )}

              <div style={{ marginTop: '6px' }}>
                <label htmlFor={`${uid}-model`}>
                  <strong>Claude 模型</strong> <span className="muted">· 默认推荐 claude-opus-5-5</span>
                </label>
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
                  style={{ marginTop: '6px' }}
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

          <section
            className="box settings-span-all"
            aria-labelledby="api-providers-h"
            data-testid="settings-api-providers"
          >
            <h2 id="api-providers-h">常用 AI API 执行者接入</h2>
            <p className="muted" style={{ marginTop: '4px' }}>
              选择服务商与模型并输入密钥，经系统加密存储与两步连接测试（鉴权 + 工具调用能力）通过后，即可担任后台施工执行者。
            </p>

            {presets.length > 0 && (
              <form onSubmit={handleSaveAndTestProvider} noValidate style={{ marginTop: '12px' }} data-testid="provider-connect-form">
                <div className="row" style={{ gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <label htmlFor={`${uid}-preset`} className="muted">服务商</label>
                  <select
                    id={`${uid}-preset`}
                    aria-label="API 服务商"
                    data-testid="provider-preset-select"
                    value={selectedPreset?.id ?? presetId}
                    disabled={providerBusy}
                    onChange={(e) => handleSelectPreset(e.target.value)}
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  {selectedPreset?.regionOptions && selectedPreset.regionOptions.length > 0 && (
                    <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
                      {selectedPreset.regionOptions.map((r) => (
                        <button
                          key={r.endpoint}
                          type="button"
                          className={providerEndpoint === r.endpoint ? 'btn secondary' : 'link'}
                          style={{ fontSize: '12px' }}
                          onClick={() => setProviderEndpoint(r.endpoint)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {selectedPreset?.note && (
                  <p className="muted" style={{ marginTop: '6px', fontSize: '13px' }}>
                    {selectedPreset.note}
                  </p>
                )}

                <div className="row" style={{ marginTop: '10px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="text"
                    aria-label="接口地址"
                    data-testid="provider-endpoint-input"
                    value={providerEndpoint}
                    disabled={providerBusy}
                    placeholder={selectedPreset?.defaultEndpoint || '填写服务商接口地址'}
                    onChange={(e) => {
                      setProviderEndpoint(e.target.value);
                      setProviderError(null);
                    }}
                    style={{ flex: '1 1 240px', minWidth: 0 }}
                  />
                  <input
                    type="text"
                    list={providerModelListId}
                    aria-label="执行模型"
                    data-testid="provider-model-input"
                    value={providerModel}
                    disabled={providerBusy}
                    placeholder="选择或输入模型 ID（如 deepseek-chat）"
                    onChange={(e) => {
                      setProviderModel(e.target.value);
                      setProviderError(null);
                    }}
                    style={{ flex: '1 1 200px', minWidth: 0 }}
                  />
                  <datalist id={providerModelListId}>
                    {[...new Set([...(selectedPreset?.suggestedModels ?? []), ...fetchedModels])].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  {selectedPreset?.supportsModelListing && onFetchProviderModels && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={modelsBusy || providerBusy}
                      data-testid="provider-fetch-models"
                      onClick={handleFetchModels}
                    >
                      {modelsBusy ? '拉取中…' : '拉取模型'}
                    </button>
                  )}
                </div>

                <div className="row" style={{ marginTop: '8px', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="服务商密钥"
                    data-testid="provider-secret-input"
                    value={providerSecret}
                    disabled={providerBusy}
                    placeholder={selectedPreset?.keyPlaceholder ?? '填写密钥'}
                    onChange={(e) => {
                      setProviderSecret(e.target.value);
                      setProviderError(null);
                    }}
                    style={{ flex: '1 1 200px', minWidth: 0 }}
                  />
                  <button
                    type="submit"
                    className="btn pri"
                    disabled={providerBusy}
                    data-testid="provider-save-test"
                  >
                    {providerBusy ? '连接测试中…' : '连接测试并保存'}
                  </button>
                </div>

                {providerError && (
                  <p role="alert" className="error" style={{ marginTop: '8px' }} data-testid="provider-form-error">
                    {providerError}
                  </p>
                )}
                {providerNotice && (
                  <p role="status" className="muted" style={{ marginTop: '8px' }} data-testid="provider-form-notice">
                    {providerNotice}
                  </p>
                )}
              </form>
            )}

            <div style={{ marginTop: '14px' }} data-testid="provider-profiles-list">
              {(aiSettings?.providerProfiles ?? []).length === 0 ? (
                <p className="muted">还没有保存其他 API 服务商配置。</p>
              ) : (
                (aiSettings?.providerProfiles ?? []).map((p: ProviderProfileView) => (
                  <div className="item" key={p.id} data-testid={`provider-profile-${p.id}`}>
                    <div className="grow">
                      <strong>{p.label}</strong>
                      <div className="muted" style={{ fontSize: '13px' }}>
                        {p.endpointOrigin}
                        {p.last4 ? ` · 尾号 ${p.last4}` : p.requiresKey ? '' : ' · 本地免密钥'}
                        {!p.officialEndpoint ? ' · 非官方/自定义地址' : ''}
                      </div>
                      {p.toolWarning && (
                        <div className="muted" style={{ fontSize: '12px', marginTop: '2px' }}>
                          {p.toolWarning}
                        </div>
                      )}
                      {p.unavailableReason && (
                        <div className="error" style={{ fontSize: '12px', marginTop: '2px' }}>
                          {p.unavailableReason}
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
                      <span className={p.executorReady ? 'tag ok' : 'tag warn'}>
                        {p.executorReady ? '可执行者' : !p.toolCallingSupported ? '仅支持对话' : '不可用'}
                      </span>
                      {p.executorReady && onSaveDefaultExecutor && (
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={aiSettings?.defaultExecutor === `api:${p.id}`}
                          data-testid={`provider-use-exec-${p.id}`}
                          onClick={async () => {
                            rolesDirtyRef.current = false;
                            setProviderError(null);
                            try {
                              await onSaveDefaultExecutor(`api:${p.id}`);
                              setProviderNotice(`已将「${p.label}」设为全局默认执行者。`);
                            } catch (err) {
                              setProviderError(err instanceof Error ? err.message : '设置失败');
                            }
                          }}
                        >
                          {aiSettings?.defaultExecutor === `api:${p.id}` ? '当前默认' : '设为默认执行者'}
                        </button>
                      )}
                      {onDeleteProviderProfile && (
                        <button
                          type="button"
                          className="link"
                          data-testid={`provider-delete-${p.id}`}
                          onClick={async () => {
                            rolesDirtyRef.current = false;
                            setProviderError(null);
                            try {
                              await onDeleteProviderProfile(p.id);
                              setProviderNotice(`已删除「${p.label}」。`);
                            } catch (err) {
                              setProviderError(err instanceof Error ? err.message : '删除失败');
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section
            className="box settings-span-all"
            aria-labelledby="sub-cli-h"
            data-testid="settings-subscription-clis"
          >
            <h2 id="sub-cli-h">本机订阅 CLI 执行者（风险自担）</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              默认仅接入 Codex 与上方官方 API Key。如你已有本机订阅工具并了解对应服务条款与隔离边界，可手动阅读并确认风险后接入。
              绝不会自动开启，也不会读取或导出外部工具账号凭证。
            </p>
            <div className="stack" style={{ gap: '10px', marginTop: '10px' }}>
              {(aiSettings?.subscriptionClis ?? []).length === 0 ? (
                <p className="muted">{!aiSettings ? '正在检测本机订阅 CLI 状态…' : '暂未载入本机订阅 CLI 目录。'}</p>
              ) : (
                (aiSettings?.subscriptionClis ?? []).map((s: SubscriptionCliView) => (
                  <div
                    key={s.id}
                    className="box"
                    style={{ padding: '10px 12px' }}
                    data-testid={`sub-cli-card-${s.id}`}
                  >
                    <div className="row sb" style={{ gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div className="row" style={{ gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong>{s.name}</strong>
                        <span className={s.executorReady ? 'tag' : 'tag warn'}>{s.statusLabel}</span>
                        {s.version && <span className="muted">v{s.version.replace(/^v/i, '')}</span>}
                        {s.enabled && s.riskAcknowledgedAt && (
                          <span className="muted">
                            风险确认于 {new Date(s.riskAcknowledgedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="row" style={{ gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        {!s.enabled ? (
                          <button
                            type="button"
                            className="secondary"
                            data-testid={`sub-cli-open-${s.id}`}
                            disabled={subBusyId === s.id || !onEnableSubscriptionCli}
                            onClick={() => {
                              setSubError(null);
                              setSubNotice(null);
                              setSubRiskChecked(false);
                              setSubModalItem(s);
                            }}
                          >
                            阅读风险并启用…
                          </button>
                        ) : (
                          <>
                            {onSaveDefaultExecutor && s.executorReady && (
                              <button
                                type="button"
                                className="secondary"
                                data-testid={`sub-cli-set-default-${s.id}`}
                                disabled={aiSettings?.defaultExecutor === `sub:${s.id}` || roleBusy}
                                onClick={async () => {
                                  rolesDirtyRef.current = false;
                                  setSubError(null);
                                  setRoleError(null);
                                  try {
                                    const updated = await onSaveDefaultExecutor(`sub:${s.id}`);
                                    setExecutorDraft(updated.defaultExecutor ?? `sub:${s.id}`);
                                    setSubNotice(`已将全局默认执行者切换为「${s.displayName}」。`);
                                  } catch (err) {
                                    setSubError(err instanceof Error ? err.message : '设置默认执行者失败');
                                  }
                                }}
                              >
                                {aiSettings?.defaultExecutor === `sub:${s.id}` ? '当前默认' : '设为默认执行者'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              data-testid={`sub-cli-retest-${s.id}`}
                              disabled={subBusyId === s.id || !onEnableSubscriptionCli}
                              onClick={async () => {
                                if (!onEnableSubscriptionCli) return;
                                setSubBusyId(s.id);
                                setSubError(null);
                                setSubNotice(null);
                                try {
                                  const res = await onEnableSubscriptionCli({
                                    cliId: s.id,
                                    riskAck: true,
                                    model: (subModels[s.id] ?? s.model).trim() || undefined,
                                  });
                                  if (!res.ok) setSubError(res.message);
                                  else setSubNotice(res.message);
                                } catch (err) {
                                  setSubError(err instanceof Error ? err.message : '检测失败');
                                } finally {
                                  setSubBusyId(null);
                                }
                              }}
                            >
                              {subBusyId === s.id ? '检测中…' : '重新检测'}
                            </button>
                            <button
                              type="button"
                              className="link"
                              data-testid={`sub-cli-disable-${s.id}`}
                              disabled={subBusyId === s.id || !onDisableSubscriptionCli}
                              onClick={async () => {
                                if (!onDisableSubscriptionCli) return;
                                rolesDirtyRef.current = false;
                                setSubBusyId(s.id);
                                setSubError(null);
                                setSubNotice(null);
                                try {
                                  const updated = await onDisableSubscriptionCli(s.id);
                                  setExecutorDraft(updated.defaultExecutor ?? 'unset');
                                  setSubNotice(`已停用「${s.name}」；若原本选为默认执行者已回退为「未设置」。`);
                                } catch (err) {
                                  setSubError(err instanceof Error ? err.message : '停用失败');
                                } finally {
                                  setSubBusyId(null);
                                }
                              }}
                            >
                              停用
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="muted" style={{ margin: '6px 0 0' }}>
                      {s.detail}
                    </p>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      {s.isolationHonesty}
                    </p>
                    <div className="row" style={{ gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                      <label htmlFor={`${uid}-sub-model-${s.id}`} className="muted">
                        模型（选填）
                      </label>
                      <input
                        id={`${uid}-sub-model-${s.id}`}
                        type="text"
                        data-testid={`sub-cli-model-${s.id}`}
                        style={{ flex: '0 1 280px', minWidth: 0, maxWidth: '100%' }}
                        value={subModels[s.id] ?? s.model}
                        placeholder={s.suggestedModels.length ? s.suggestedModels.join(' / ') : '默认使用本机配置'}
                        onChange={(e) => setSubModels((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      />
                    </div>
                  </div>
                ))
              )}
              {subError && !subModalItem && (
                <p className="error" data-testid="subscription-cli-error">
                  {subError}
                </p>
              )}
              {subNotice && (
                <p className="muted" data-testid="subscription-cli-notice">
                  {subNotice}
                </p>
              )}
            </div>
          </section>

          {subModalItem && (
            <div className="overlay">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="sub-risk-h"
                className="dialog"
                data-testid="subscription-risk-dialog"
              >
                <h2 id="sub-risk-h">{subModalItem.riskTitle}</h2>
                <p className="notice">{subModalItem.officialAlternative}</p>
                <ul>
                  {subModalItem.riskBullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <p className="muted" style={{ marginTop: '8px' }}>
                  <strong>隔离边界：</strong>
                  {subModalItem.isolationHonesty}
                </p>
                <label
                  className="row"
                  style={{ marginTop: '12px', gap: '8px', alignItems: 'flex-start', flexWrap: 'nowrap', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    data-testid="subscription-risk-ack"
                    style={{ width: 'auto', flex: '0 0 auto', marginTop: '4px' }}
                    checked={subRiskChecked}
                    onChange={(e) => setSubRiskChecked(e.target.checked)}
                  />
                  <span>我已阅读并理解上述条款冲突与隔离边界，自愿启用「{subModalItem.name}」并自行承担账号与额度风险</span>
                </label>
                {subError && (
                  <p className="error" style={{ marginTop: '8px' }} data-testid="subscription-risk-error">
                    {subError}
                  </p>
                )}
                <div className="row" style={{ marginTop: '12px', gap: '8px' }}>
                  <button
                    type="button"
                    data-testid="subscription-risk-confirm"
                    disabled={!subRiskChecked || subBusyId === subModalItem.id}
                    onClick={async () => {
                      if (!onEnableSubscriptionCli) return;
                      setSubBusyId(subModalItem.id);
                      setSubError(null);
                      setSubNotice(null);
                      try {
                        const res = await onEnableSubscriptionCli({
                          cliId: subModalItem.id,
                          riskAck: subRiskChecked,
                          model: (subModels[subModalItem.id] ?? subModalItem.model).trim() || undefined,
                        });
                        if (!res.ok) {
                          setSubError(res.message);
                          return;
                        }
                        setSubModalItem(null);
                        setSubRiskChecked(false);
                        setSubNotice(res.message);
                      } catch (err) {
                        setSubError(err instanceof Error ? err.message : '启用失败');
                      } finally {
                        setSubBusyId(null);
                      }
                    }}
                  >
                    {subBusyId === subModalItem.id ? '检测并启用中…' : '确认风险，检测并启用'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    data-testid="subscription-risk-cancel"
                    onClick={() => {
                      setSubModalItem(null);
                      setSubRiskChecked(false);
                      setSubError(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}
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
