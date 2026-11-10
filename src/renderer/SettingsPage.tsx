import type { DisclosureState, HealthReport } from './api.js';
import { HealthList } from './HealthList.js';
import { COPY } from './copy.js';

export type SettingsTab = 'disclosure' | 'health';

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

/**
 * 全局设置壳（13-settings，UI v2.1 第 2/9 节，B7）：
 * 仅展示已有后台的内容：资料外发 与 环境体检。
 */
export function SettingsPage({
  tab,
  disc,
  env,
  error,
  onTabChange,
  onShowDisclosure,
  onRefreshEnv,
}: {
  tab: SettingsTab;
  disc: DisclosureState | null;
  env: HealthReport | null;
  error: string | null;
  onTabChange: (tab: SettingsTab) => void;
  onShowDisclosure: () => void;
  onRefreshEnv: () => void;
}) {
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

      {tab === 'disclosure' ? (
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
