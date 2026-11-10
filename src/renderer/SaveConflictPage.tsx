import { useState } from 'react';
import { studio, type SaveConflictView } from './api.js';
import { DiffPreview } from './DiffPreview.js';

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 保存冲突专页（原型 #11-save-conflict，UI v2.1 第 7 节）。
 * 只展示冲突位置、关联的已保存任务或后来改动、项目原样状态、成果保留说明与两边片段对照，
 * 只渲染核心层下发的两个去向按钮。
 */
export function SaveConflictPage({
  projectId,
  taskId,
  conflict,
  onStartedRedo,
  onDefer,
}: {
  projectId: string;
  taskId: string;
  conflict: SaveConflictView;
  onStartedRedo: () => void;
  onDefer: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redoError, setRedoError] = useState<{ text: string; files?: string[] } | null>(null);

  const handleRedo = async () => {
    if (busy || !conflict.canRedo) return;
    setBusy(true);
    setRedoError(null);
    try {
      const res = await studio().reworkConflictTask(projectId, taskId);
      if (res.ok) {
        onStartedRedo();
      } else {
        setRedoError({
          text: res.message,
          ...(res.files?.length ? { files: res.files } : {}),
        });
      }
    } catch (e) {
      setRedoError({ text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="result stack" data-testid="save-conflict-page" data-state="save_failed_unmerged">
      <section className="box wbox">
        <div className="row sb">
          <div>
            <p className="headline" data-testid="verdict">{conflict.headline}</p>
            <p className="muted" style={{ marginTop: '4px' }} data-testid="conflict-summary">{conflict.summary}</p>
          </div>
          <span className="tag warn">冲突，未写入主项目</span>
        </div>

        <div className="facts" style={{ marginTop: '12px' }}>
          <div className="item">
            <span className="tag">冲突位置</span>
            <span className="grow" data-testid="conflict-files">
              {conflict.files.length ? conflict.files.join('、') : '相关改动文件'}
            </span>
          </div>
          <div className="item">
            <span className="tag">冲突来源</span>
            <span className="grow" data-testid="conflict-other">
              {conflict.otherLabel}
              {conflict.otherSavedAt ? `（保存于 ${formatTime(conflict.otherSavedAt)}）` : ''}
            </span>
          </div>
          <div className="item">
            <span className="tag ok">项目状态</span>
            <span className="grow" data-testid="conflict-project-state">{conflict.projectStateText}</span>
          </div>
          <div className="item">
            <span className="tag ok">任务成果</span>
            <span className="grow" data-testid="conflict-preserved">{conflict.preservedText}</span>
          </div>
        </div>

        {redoError && (
          <div className="box wbox" role="alert" data-testid="conflict-redo-error" style={{ marginTop: '12px' }}>
            <p className="error">{redoError.text}</p>
            {redoError.files && redoError.files.length > 0 && (
              <ul className="muted" style={{ marginTop: '4px' }}>
                {redoError.files.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
          </div>
        )}

        {!conflict.canRedo && conflict.redoBlockedReason && (
          <p className="muted" style={{ marginTop: '8px' }} data-testid="conflict-redo-blocked">{conflict.redoBlockedReason}</p>
        )}

        <div className="row" data-testid="conflict-actions" style={{ marginTop: '12px' }}>
          <button
            type="button"
            data-testid="conflict-redo-button"
            disabled={busy || !conflict.canRedo}
            onClick={handleRedo}
          >
            {conflict.redoLabel}
          </button>
          <button
            type="button"
            className="secondary"
            data-testid="conflict-defer-button"
            disabled={busy}
            onClick={onDefer}
          >
            {conflict.deferLabel}
          </button>
        </div>
      </section>

      <section className="box" data-testid="conflict-diffs-section">
        <div className="row sb">
          <h2>两边对冲突位置的改动对比</h2>
          <button
            type="button"
            className="secondary"
            data-testid="conflict-diff-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起对比' : conflict.diffToggleLabel}
          </button>
        </div>

        {expanded && (
          <div className="stack" style={{ marginTop: '10px' }} data-testid="conflict-diff-body">
            {conflict.diffs.length === 0 ? (
              <p className="muted">暂无法展示文本片段，可使用「{conflict.redoLabel}」让 AI 在最新项目上处理。</p>
            ) : (
              conflict.diffs.map((d) => (
                <div className="box subtle-card" key={d.path} data-testid="conflict-diff-item" data-file={d.path}>
                  <p><strong>{d.path}</strong></p>
                  <div className="conflict-diff-cols" style={{ marginTop: '8px' }}>
                    <div className="conflict-side" data-testid="conflict-diff-left">
                      <p className="muted"><strong>{d.left.title}</strong></p>
                      <DiffPreview p={d.left.preview} />
                    </div>
                    <div className="conflict-side" data-testid="conflict-diff-right">
                      <p className="muted"><strong>{d.right.title}</strong></p>
                      <DiffPreview p={d.right.preview} />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
