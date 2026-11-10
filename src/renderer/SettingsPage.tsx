import { useId, useState, type FormEvent } from 'react';
import type { ClaudeKeySaveResult, ClaudeKeyStatus, DisclosureState, HealthReport } from './api.js';
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

/**
 * 全局设置（13-settings，UI v2.1 第 2/9 节）：
 * AI 与角色（接入状态与 Anthropic API Key）、资料外发 与 环境体检。
 */
export function SettingsPage({
  tab,
  disc,
  env,
  claudeKey = null,
  error,
  onTabChange,
  onShowDisclosure,
  onRefreshEnv,
  onSaveClaudeKey,
  onDeleteClaudeKey,
}: {
  tab: SettingsTab;
  disc: DisclosureState | null;
  env: HealthReport | null;
  claudeKey?: ClaudeKeyStatus | null;
  error: string | null;
  onTabChange: (tab: SettingsTab) => void;
  onShowDisclosure: () => void;
  onRefreshEnv: () => void;
  onSaveClaudeKey?: (secret: string) => Promise<ClaudeKeySaveResult>;
  onDeleteClaudeKey?: () => Promise<ClaudeKeyStatus>;
}) {
  const uid = useId();
  const keyInputId = `${uid}-claude-secret`;
  const [secretDraft, setSecretDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  const codex = codexSummaryTag(env);

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
    try {
      await onDeleteClaudeKey();
      setSecretDraft('');
      setKeyNotice('已删除 Anthropic API Key；使用 Claude 的角色已回退为「未设置」，将在下次讨论前提示重新配置。');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : '删除失败，请重试。');
    } finally {
      setKeyBusy(false);
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
                  {!claudeKey?.configured
                    ? 'Anthropic API Key：未设置（不读取外部工具凭证）'
                    : claudeKey.available
                      ? `Anthropic API Key：已设置（尾号 ${claudeKey.last4 ?? '****'}）`
                      : `Anthropic API Key：已设置（尾号 ${claudeKey.last4 ?? '****'}）· 当前不可用`}
                </div>
                {claudeKey?.unavailableReason && (
                  <p className="error" style={{ marginTop: '4px' }} role="alert" data-testid="claude-key-unavailable">
                    {claudeKey.unavailableReason}
                  </p>
                )}
              </div>
              <span className={claudeKey?.configured && claudeKey.available ? 'tag ok' : 'tag warn'} data-testid="claude-key-tag">
                {!claudeKey?.configured ? '未设置' : claudeKey.available ? '可用' : '不可用'}
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
                {claudeKey?.configured && (
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
