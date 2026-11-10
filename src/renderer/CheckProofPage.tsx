import { useState } from 'react';
import { DiffPreview } from './DiffPreview.js';
import type { ProofTab, SingleCheckProof, TaskProofView } from './api.js';
import { COPY } from './copy.js';

const KIND_TEXT: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名', other: '变化' };
const INITIAL_CASES = 5;

function CheckProofCard({ item }: { item: SingleCheckProof }) {
  const [expanded, setExpanded] = useState(false);

  const metaLine = [
    `第 ${item.round} 轮成果`,
    item.ranAtText ? `本应用于 ${item.ranAtText} 运行` : null,
    item.envLabel,
    item.originNote,
  ]
    .filter(Boolean)
    .join(' · ');

  if (item.status === 'not_checked') {
    return (
      <section className="box" data-testid={`proof-card-${item.key}`}>
        <div className="row sb">
          <h2>{item.title}</h2>
          <span className="muted" data-testid="proof-meta">{metaLine}</span>
        </div>
        <div className="item" style={{ marginTop: '8px' }}>
          <span className="tag">未检查</span>
          <span className="grow" data-testid="proof-unchecked-text">{item.summaryText}</span>
        </div>
      </section>
    );
  }

  const visibleCases = expanded ? item.cases : item.cases.slice(0, INITIAL_CASES);
  const restCount = item.cases.length - visibleCases.length;

  return (
    <section className="box" data-testid={`proof-card-${item.key}`}>
      <div className="row sb">
        <h2>
          {item.title} · {item.summaryText}
        </h2>
        <span className="muted" data-testid="proof-meta">{metaLine}</span>
      </div>

      {item.key === 'test' && (
        <div style={{ marginTop: '10px' }} data-testid="proof-cases">
          {item.parsedNames ? (
            <>
              {visibleCases.map((c, idx) => (
                <div className="item" key={`${idx}-${c.name}`} data-case-status={c.status}>
                  <span className={`tag${c.status === 'passed' ? ' ok' : ' warn'}`}>
                    {c.status === 'passed' ? '通过' : '失败'}
                  </span>
                  <span className="grow">{c.name}</span>
                  {c.durationText && <span className="muted">{c.durationText}</span>}
                </div>
              ))}
              {(restCount > 0 || expanded) && item.cases.length > INITIAL_CASES && (
                <div className="item">
                  <span className="tag ok">通过</span>
                  <span className="grow muted">
                    {expanded ? `已展开全部 ${item.cases.length} 项` : `……其余 ${restCount} 项`}
                  </span>
                  <button
                    type="button"
                    className="link"
                    data-testid="proof-expand-cases"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? COPY.proofCollapseCases : COPY.proofExpandCases}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="muted" data-testid="proof-count-fallback">
              {item.passedCount} 项通过 · {item.failedCount} 项失败（脚本未输出可识别的逐项测试名称）
            </p>
          )}
        </div>
      )}

      <details style={{ marginTop: '12px' }} data-testid="proof-details">
        <summary style={{ cursor: 'pointer' }}>{COPY.proofDetailsSummary}</summary>
        <p className="muted" style={{ marginTop: '6px' }}>{COPY.proofDetailsNotice}</p>
        <pre className="snippet" data-testid="proof-details-log">
          {item.filteredDetails || '暂无可展示的输出记录。'}
        </pre>
      </details>
    </section>
  );
}

/**
 * 检查依据页（原型 #08）：按轮次、时间、运行环境与应用核验来源展示检查结果，
 * 自动测试列出测试名或通过/失败数量，「详细记录」默认折叠且只显示过滤后的文本。
 */
export function CheckProofPage({
  proof,
  initialTab,
  onBack,
}: {
  proof: TaskProofView;
  initialTab: ProofTab;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ProofTab>(initialTab);

  return (
    <div className="stack" data-testid="proof-page" data-round={proof.round}>
      <div className="row sb">
        <button type="button" className="link" data-testid="proof-back-button" onClick={onBack}>
          {COPY.proofBack}
        </button>
        <span className="tag" data-testid="proof-round-tag">第 {proof.round} 轮</span>
      </div>

      <div className="tabs" role="tablist" aria-label="检查依据分类">
        {(
          [
            ['test', COPY.proofTabTest],
            ['build', COPY.proofTabBuild],
            ['denied', COPY.proofTabDenied],
            ['changes', COPY.proofTabChanges],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`link${tab === key ? ' tc' : ''}`}
            data-testid={`proof-tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'test' && <CheckProofCard item={proof.test} />}
      {tab === 'build' && <CheckProofCard item={proof.build} />}

      {tab === 'denied' && (
        <section className="box" data-testid="proof-denied-panel">
          <div className="row sb">
            <h2>{COPY.proofTabDenied}</h2>
            <span className="muted" data-testid="proof-meta">第 {proof.round} 轮成果 · 由本应用记录，不是 AI 自报</span>
          </div>
          {proof.denied.length === 0 ? (
            <p className="muted" style={{ marginTop: '8px' }}>这一轮施工中没有被拦下的操作。</p>
          ) : (
            <div style={{ marginTop: '8px' }}>
              {proof.denied.map((d) => (
                <div className="item" key={d.id}>
                  <span className={`tag${d.acked ? ' ok' : ' warn'}`}>{d.acked ? '已知晓' : '待确认'}</span>
                  <div className="grow">
                    <strong>{d.text}</strong>
                    <div className="muted">{d.impact}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'changes' && (
        <section className="box" data-testid="proof-changes-panel">
          <div className="row sb">
            <h2>{COPY.proofTabChanges}</h2>
            <span className="muted" data-testid="proof-meta">第 {proof.round} 轮成果 · 由 Git 实际对比生成，不是 AI 自报</span>
          </div>
          {proof.changes.length === 0 ? (
            <p className="muted" style={{ marginTop: '8px' }}>这一轮没有任何文件被修改。</p>
          ) : (
            <ul className="changes" style={{ marginTop: '8px' }}>
              {proof.changes.map((c) => (
                <li key={c.path} data-kind={c.kind}>
                  <strong>{KIND_TEXT[c.kind] ?? '变化'}</strong>　{c.path}
                  {c.additions !== null && c.deletions !== null && <span className="muted"> （+{c.additions} −{c.deletions}）</span>}
                  {c.preview && <DiffPreview p={c.preview} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
