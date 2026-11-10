import { useCallback, useEffect, useState } from 'react';
import { Tasks } from './Tasks.js';
import { studio, type DisclosureState, type HealthItem, type HealthReport, type LayerKey, type LayerState, type OpenResult, type ProjectStatus, type RecentProject } from './api.js';

// M3-B1：入口与环境——打开项目、分层环境体检、首次外发告知。任务闭环界面在后续子任务实现。
const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'installed', label: '已安装' },
  { key: 'starts', label: '能启动' },
  { key: 'compatible', label: '版本兼容' },
  { key: 'loggedIn', label: '已登录' },
  { key: 'secured', label: '安全配置已核验' },
];
const STATE_TEXT: Record<LayerState, string> = { pass: '✓ 通过', fail: '✗ 不通过', unknown: '？未知', na: '— 不适用' };
const OVERALL_TEXT: Record<HealthItem['overall'], string> = { pass: '可以使用', fail: '需要处理', unknown: '有项目无法确认' };

function Disclosure({ state, onAccept, onClose }: { state: DisclosureState; onAccept?: () => void; onClose: () => void }) {
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
          <button className="secondary" onClick={onClose}>{onAccept ? '暂不同意，先看看' : '关闭'}</button>
        </div>
        {onAccept && <p className="muted">不同意也可以浏览环境检查；涉及发送资料的功能会保持关闭。</p>}
      </div>
    </div>
  );
}

function Health({ item }: { item: HealthItem }) {
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
      {item.foundVia === 'fallback' && <p className="muted" data-testid={`via-${item.id}`}>通过补全路径找到（图形界面启动时系统没有提供这个位置）：{item.location}</p>}
      {item.advice && <p className="advice">怎么办：{item.advice} {item.help && <a href={item.help} target="_blank" rel="noreferrer">官方说明</a>}</p>}
    </li>
  );
}

export function App() {
  const [env, setEnv] = useState<HealthReport | null>(null);
  const [project, setProject] = useState<ProjectStatus | null>(null);
  const [pending, setPending] = useState<{ name: string; path: string } | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disc, setDisc] = useState<DisclosureState | null>(null);
  const [showDisc, setShowDisc] = useState(false);

  const refreshEnv = useCallback(() => {
    setEnv(null);
    studio().detectEnvironment().then(setEnv).catch((e: Error) => setError(e.message));
  }, []);
  const refreshRecent = useCallback(() => {
    studio().recentProjects().then(setRecent).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refreshEnv();
    refreshRecent();
    studio().getDisclosure().then((d) => { setDisc(d); if (!d.accepted) setShowDisc(true); }).catch((e: Error) => setError(e.message));
  }, [refreshEnv, refreshRecent]);

  const handle = (p: Promise<OpenResult>) =>
    p.then((r) => {
      setError(null);
      setNotice(null);
      if (r.kind === 'opened') { setProject(r.status); setPending(null); refreshRecent(); refreshEnv(); }
      else if (r.kind === 'needs_init') setPending({ name: r.name, path: r.path });
      else if (r.kind === 'rejected') setNotice(r.reason);
      else if (r.kind === 'declined') { setPending(null); setNotice('你没有同意创建版本记录，所以没有打开这个文件夹。你的文件没有任何改动。'); }
    }).catch((e: Error) => setError(e.message));

  const accept = () => studio().acceptDisclosure().then((d) => { setDisc(d); setShowDisc(false); }).catch((e: Error) => setError(e.message));

  return (
    <main className="shell">
      <h1>AI Solo Studio</h1>
      <p className="lede">你决定做什么，AI 负责实现，这里负责证明结果、控制风险、随时可撤销。</p>

      {error && <p role="alert" className="error">{error}</p>}

      <section aria-labelledby="env-h">
        <h2 id="env-h">你的电脑准备好了吗</h2>
        {!env ? <p>正在检查…</p> : (
          <>
            <ul className="env">{env.items.map((i) => <Health key={i.id} item={i} />)}</ul>
            {env.limitations.length > 0 && (
              <div className="limits" data-testid="limitations">
                <strong>已知的限制（目前无法关闭）</strong>
                <ul>{env.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            )}
            <details>
              <summary>排查信息（PATH）</summary>
              <p className="muted">应用看到的 PATH：<code>{env.pathInfo.processPath || '（空）'}</code></p>
              <p className="muted">补全的目录（只用于应用启动的子进程，不修改你的电脑设置）：<code>{env.pathInfo.supplementalDirs.join(':') || '无'}</code></p>
            </details>
            <button className="secondary" onClick={refreshEnv}>重新检查</button>
          </>
        )}
      </section>

      <section aria-labelledby="proj-h">
        <h2 id="proj-h">项目</h2>
        {notice && <p role="status" className="notice" data-testid="notice">{notice}</p>}
        {pending ? (
          <div className="consent" data-testid="init-consent">
            <p><strong>{pending.name}</strong> <span className="muted">{pending.path}</span></p>
            <p>这个文件夹还没有版本记录。将在这个文件夹里创建版本记录（.git），不会修改你的文件。有了它，AI 的每次修改都在独立副本中进行，你可以随时撤销或回到任何一个保存点。</p>
            <div className="row">
              <button onClick={() => handle(studio().initProject(true))}>同意，创建版本记录并打开</button>
              <button className="secondary" onClick={() => handle(studio().initProject(false))}>不同意，不打开</button>
            </div>
          </div>
        ) : !project ? (
          <>
            <button onClick={() => handle(studio().chooseProject())}>打开项目文件夹</button>
            {recent.length > 0 && (
              <>
                <h3>最近项目</h3>
                <ul className="recent" data-testid="recent">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <button className="link" disabled={!r.exists} onClick={() => handle(studio().openRecent(r.id))}>{r.name}</button>
                      <span className="muted"> {r.path} · {new Date(r.lastOpened).toLocaleString()}{!r.exists && ' · 文件夹已不存在'}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <div data-testid="project">
            <p><strong>{project.name}</strong> <span className="muted">{project.path}</span></p>
            {project.uncommitted > 0 && (
              <p className="notice" data-testid="dirty">这个项目有 {project.uncommitted} 个文件的改动还没有保存。后续施工会基于已保存的版本，这些未保存的改动不会被带入，应用也不会替你自动保存。</p>
            )}
            <h3>保存点</h3>
            <ol className="saves">
              {project.savePoints.map((s) => (
                <li key={s.sha}>
                  {s.message} <span className="muted">{new Date(s.date).toLocaleString()}</span>
                  {s.checksText && <span className="muted" data-testid="savepoint-check"> · {s.checksText}</span>}
                </li>
              ))}
            </ol>
            <Tasks key={project.id} projectId={project.id} />
            <button className="secondary" onClick={() => { setProject(null); refreshEnv(); }}>换一个项目</button>
          </div>
        )}
      </section>

      <section aria-labelledby="out-h">
        <h2 id="out-h">资料外发</h2>
        <p data-testid="outbound-status">{disc?.accepted ? '已确认外发说明：涉及发送资料的功能可用（每次发送前仍会让你确认清单）。' : '尚未确认外发说明：涉及发送资料的功能已关闭。'}</p>
        <button className="secondary" onClick={() => setShowDisc(true)}>查看外发说明</button>
      </section>

      {showDisc && disc && <Disclosure state={disc} {...(disc.accepted ? {} : { onAccept: accept })} onClose={() => setShowDisc(false)} />}
    </main>
  );
}
