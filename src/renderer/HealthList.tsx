import type { HealthItem, HealthReport, LayerKey, LayerState } from './api.js';

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'installed', label: '已安装' },
  { key: 'starts', label: '能启动' },
  { key: 'compatible', label: '版本兼容' },
  { key: 'loggedIn', label: '已登录' },
  { key: 'secured', label: '安全配置已核验' },
];
const STATE_TEXT: Record<LayerState, string> = { pass: '✓ 通过', fail: '✗ 不通过', unknown: '？未知', na: '— 不适用' };
const OVERALL_TEXT: Record<HealthItem['overall'], string> = { pass: '可以使用', fail: '需要处理', unknown: '有项目无法确认' };

function HealthItemRow({ item }: { item: HealthItem }) {
  return (
    <li data-id={item.id} data-overall={item.overall}>
      <div className="head">
        <strong>{item.label}</strong>
        <span className="overall" data-overall={item.overall}>{OVERALL_TEXT[item.overall]}</span>
        {item.version && <span className="muted">{item.version}</span>}
      </div>
      <dl className="layers">
        {LAYERS.map((l) => {
          const layer = item.layers[l.key];
          return (
            <div key={l.key} data-layer={l.key} data-state={layer.state}>
              <dt>{l.label}</dt>
              <dd>{STATE_TEXT[layer.state]}{layer.note && <span className="muted"> {layer.note}</span>}</dd>
            </div>
          );
        })}
      </dl>
      {item.foundVia === 'fallback' && (
        <p className="muted" data-testid={`via-${item.id}`}>
          通过补全路径找到（图形界面启动时系统没有提供这个位置）：{item.location}
        </p>
      )}
      {item.advice && (
        <p className="advice">
          怎么办：{item.advice} {item.help && <a href={item.help} target="_blank" rel="noreferrer">官方说明</a>}
        </p>
      )}
    </li>
  );
}

/** 复用的 5 层环境体检明细展示（首次引导与设置页共用）。 */
export function HealthList({
  env,
  primaryRefresh,
  onRefresh,
}: {
  env: HealthReport | null;
  primaryRefresh: boolean;
  onRefresh: () => void;
}) {
  if (!env) return <p>正在检查…</p>;
  return (
    <>
      <ul className="env">{env.items.map((i) => <HealthItemRow key={i.id} item={i} />)}</ul>
      {env.limitations.length > 0 && (
        <div className="limits" data-testid="limitations">
          <strong>已知的限制（目前无法关闭）</strong>
          <ul>{env.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
      <details>
        <summary>排查信息（PATH）</summary>
        <p className="muted">应用看到的 PATH：<code>{env.pathInfo.processPath || '（空）'}</code></p>
        <p className="muted">
          补全的目录（只用于应用启动的子进程，不修改你的电脑设置）：
          <code>{env.pathInfo.supplementalDirs.join(':') || '无'}</code>
        </p>
      </details>
      <div className="row" style={{ marginTop: '10px' }}>
        <button type="button" className={primaryRefresh ? '' : 'secondary'} onClick={onRefresh}>
          重新检查
        </button>
      </div>
    </>
  );
}
