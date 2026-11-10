import type { ChangePreview } from './api.js';
import { COPY } from './copy.js';

/** 改动的文件逐行片段展示（原来 / 现在），由成果预览与检查依据共用。 */
export function DiffPreview({ p }: { p: ChangePreview }) {
  if (p.kind === 'deleted' || p.kind === 'unavailable') return <p className="muted" data-testid="preview-note">{p.note}</p>;
  if (p.kind === 'new') {
    return (
      <div data-testid="preview-new">
        <p className="muted">{p.note}</p>
        <pre className="snippet">{p.lines.join('\n')}{p.truncated ? '\n…' : ''}</pre>
      </div>
    );
  }
  return (
    <div data-testid="preview-text">
      {p.hunks.map((h, i) => (
        <div className="hunk" key={`${h.line}-${i}`} data-testid="hunk">
          <p className="muted">{COPY.hunkAt(h.line)}</p>
          <div className="cols">
            <div className="col" data-testid="hunk-before"><h5>{COPY.before}</h5><pre className="snippet">{h.before.join('\n') || ' '}</pre></div>
            <div className="col" data-testid="hunk-after"><h5>{COPY.after}</h5><pre className="snippet">{h.after.join('\n') || ' '}</pre></div>
          </div>
          {h.truncated && <p className="muted">{COPY.hunkTruncated}</p>}
        </div>
      ))}
      {p.note && <p className="muted" data-testid="preview-omitted">{p.note}</p>}
    </div>
  );
}
