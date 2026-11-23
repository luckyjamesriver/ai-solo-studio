import { useState } from 'react';
import { extractContentFromWebview } from './webBridge.js';
import { CHATGPT_WEB_URL, validateApprovedExternalUrl } from './externalServices.js';
import { parsePlanFromText, serializePlanForTask, type ParsedPlan } from './planParser.js';
import { studio } from './api.js';

interface ChatGPTViewProps {
  currentProjectName?: string;
  onImportPlanToTask: (content: string) => void;
  onBackToProject: () => void;
}

/**
 * ChatGPT 官方视界与协同控制台（P0-2-R2）
 * 经批准的外部服务入口；受控安全隔离基线与强受控人机协同交接。
 */
const CHATGPT_URL = CHATGPT_WEB_URL;
const urlValidation = validateApprovedExternalUrl(CHATGPT_URL);
if (!urlValidation.ok) {
  throw new Error(`ChatGPT URL 安全校验失败: ${urlValidation.reason}`);
}

export function ChatGPTView({
  currentProjectName,
  onImportPlanToTask,
  onBackToProject,
}: ChatGPTViewProps) {
  const [extracting, setExtracting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rawPlanText, setRawPlanText] = useState('');
  const [previewPlan, setPreviewPlan] = useState<ParsedPlan | null>(null);
  const [editedGoal, setEditedGoal] = useState('');
  const [editedScope, setEditedScope] = useState<string[]>([]);
  const [editedCriteria, setEditedCriteria] = useState<string[]>([]);
  const [editedConstraints, setEditedConstraints] = useState<string[]>([]);
  const [companionActive, setCompanionActive] = useState(false);
  const [companionLoadError, setCompanionLoadError] = useState<string | null>(null);

  // 1. 打开独立伴侣视界
  const handleOpenCompanion = async () => {
    setFeedback(null);
    setCompanionLoadError(null);
    try {
      const res = await studio().openChatGPTCompanion();
      if (res.ok) {
        setCompanionActive(true);
        setFeedback('已启动 ChatGPT 独立伴侣视界（强沙箱隔离 · 独立会话分区）。');
      }
    } catch (e: any) {
      setFeedback(`启动伴侣视界失败: ${e.message || e}`);
    }
  };

  // 2. 在系统默认浏览器中打开（原生可靠备用方案）
  const handleOpenSystemBrowser = async () => {
    setFeedback(null);
    try {
      await studio().openChatGPTInSystemBrowser();
      setFeedback('已在系统默认浏览器中打开官方网页，可利用你已有的登录会话进行讨论。');
    } catch (e: any) {
      setFeedback(`调用系统浏览器失败: ${e.message || e}`);
    }
  };

  // 辅助：加载方案到预览态（统一受控门禁）
  const loadPlanToPreview = (text: string, sourceLabel: string) => {
    const trimmed = text.trim();
    setRawPlanText(trimmed);
    const parsed = parsePlanFromText(trimmed);
    setPreviewPlan(parsed);
    setEditedGoal(parsed.goal || parsed.title);
    setEditedScope([...parsed.inScope]);
    setEditedCriteria([...parsed.criteria]);
    setEditedConstraints([...parsed.constraints]);
    setFeedback(`${sourceLabel}已成功解析。请在右侧预览卡中核验目标、施工范围与验收标准，确认无误后方可导入。`);
  };

  // 3. 从剪贴板粘贴方案
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().length > 5) {
        loadPlanToPreview(text, '剪贴板内容');
      } else {
        setFeedback('剪贴板中未发现有效文本，请先在 ChatGPT 网页复制方案。');
      }
    } catch {
      setFeedback('读取剪贴板受阻，请直接在下方文本框中手动粘贴。');
    }
  };

  // 4. 解析输入框中的方案
  const handleParseInput = () => {
    if (!rawPlanText.trim()) {
      setFeedback('请先粘贴或输入方案内容。');
      return;
    }
    loadPlanToPreview(rawPlanText, '手动输入内容');
  };

  // 5. 用户主动确认后，才真正导入为 Studio 任务（核心门禁）
  const handleConfirmImport = () => {
    if (!previewPlan) return;
    const finalContent = serializePlanForTask({
      goal: editedGoal.trim() || previewPlan.goal || previewPlan.title,
      inScope: editedScope,
      criteria: editedCriteria,
      constraints: editedConstraints,
      rawText: previewPlan.rawText,
    });
    onImportPlanToTask(finalContent);
    setPreviewPlan(null);
    setFeedback('方案已成功通过确认门禁，已导入为 Studio 任务。');
  };

  // 6. 提炼并转为任务按钮（严格遵循确认门禁：先提炼到预览卡，绝不绕过确认）
  const handleExtractAndTransfer = async () => {
    setExtracting(true);
    setFeedback(null);
    try {
      let candidate = rawPlanText.trim();
      if (!candidate) {
        const res = await extractContentFromWebview('#chatgpt-webview');
        if (res.success && res.text) {
          candidate = res.text.trim();
        }
      }

      if (!candidate) {
        const manual = prompt('未能自动提取到内容。你可以手动粘贴 ChatGPT 生成的方案文本：', '');
        if (manual && manual.trim().length > 5) {
          candidate = manual.trim();
        }
      }

      if (candidate && candidate.length > 5) {
        // 关键安全修复：只装载到预览卡，绝不自动调用 onImportPlanToTask
        loadPlanToPreview(candidate, '提炼内容');
      } else {
        setFeedback('未能获取有效方案，请在网页中生成回复或在文本框中粘贴后再试。');
      }
    } catch (e: any) {
      setFeedback(`提取异常: ${e.message || e}`);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'var(--color-bg)',
        overflowY: 'auto',
      }}
    >
      {/* 顶部控制栏 */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px var(--space-gutter)',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface-subtle)',
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                fontFamily: 'var(--font-serif-heading)',
                fontSize: '18px',
                fontWeight: 600,
                color: 'var(--color-ink)',
              }}
            >
              ChatGPT.com 官方协同视界
            </span>
            {currentProjectName && (
              <span
                data-testid="chatgpt-current-project"
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--color-selected-bg)',
                  color: 'var(--color-primary)',
                  fontWeight: 500,
                }}
              >
                当前项目：{currentProjectName}
              </span>
            )}
            <span
              data-testid="chatgpt-auth-status"
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--color-surface)',
                color: 'var(--color-warn)',
                border: '1px solid var(--color-border)',
                fontWeight: 500,
              }}
            >
              登录状态：未受控验证 (LIVE_LOGIN_NOT_VERIFIED)
            </span>
          </div>
          <div
            style={{
              fontSize: 'var(--text-muted)',
              color: 'var(--color-muted)',
              marginTop: '2px',
            }}
          >
            独立伴侣视界 · 会话沙箱隔离（persist:ai_solo_chatgpt）· 杜绝 User-Agent 伪装与外部静默弹窗
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {feedback && (
            <span data-testid="chatgpt-feedback" style={{ fontSize: '12px', color: 'var(--color-warn)' }}>
              {feedback}
            </span>
          )}

          <button
            type="button"
            onClick={handleExtractAndTransfer}
            disabled={extracting}
            style={{
              fontSize: '13px',
              padding: '6px 14px',
            }}
          >
            {extracting ? '正在提炼...' : '📥 提炼方案并转为任务'}
          </button>

          <button
            type="button"
            className="secondary"
            onClick={onBackToProject}
            style={{
              fontSize: '13px',
              padding: '6px 14px',
            }}
          >
            返回项目看板
          </button>
        </div>
      </header>

      {/* 主工作区 */}
      <main
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1fr)',
          gap: '24px',
          padding: '24px',
          flex: 1,
        }}
      >
        {/* 左侧：网页入口与安全视界控制器 */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-card)',
            padding: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-ink)', margin: 0 }}>
              1. 官方网页交互与安全视界
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>ADR 0006 合规</span>
          </div>

          <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--color-muted)', margin: 0 }}>
            主应用渲染层维持 <code>webviewTag: false</code>，确保远程网页代码绝对无法访问本地项目文件、执行环境或主应用凭证。可通过下方受控通道使用 ChatGPT：
          </p>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="open-companion-button"
              onClick={handleOpenCompanion}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              🖥️ {companionActive ? '聚焦独立伴侣视界' : '打开独立伴侣视界'}
            </button>
            <button
              type="button"
              data-testid="open-system-browser-button"
              className="secondary"
              onClick={handleOpenSystemBrowser}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              🌐 在系统默认浏览器打开
            </button>
          </div>

          {companionLoadError && (
            <div
              data-testid="companion-load-error"
              style={{
                padding: '10px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-diff-del-bg)',
                color: 'var(--color-warn)',
                border: '1px solid var(--color-warn)',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>网页加载受阻（{companionLoadError}），建议使用系统浏览器。</span>
              <button
                type="button"
                onClick={handleOpenSystemBrowser}
                style={{ fontSize: '11px', padding: '2px 8px' }}
              >
                改用系统浏览器
              </button>
            </div>
          )}

          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface-subtle)',
              fontSize: '12px',
              lineHeight: 1.5,
              color: 'var(--color-muted)',
              border: '1px solid var(--color-border)',
            }}
          >
            <div>• <b>安全窗口策略</b>：单独 BrowserWindow、启用沙箱、拦截所有非白名单弹窗与静默跳转。</div>
            <div>• <b>无凭证窃取</b>：不读取系统 Cookie、不注入主应用 Preload、不伪装 User-Agent。</div>
            <div>• <b>登录状态标记</b>：<code>LIVE_LOGIN_NOT_VERIFIED</code>（服务商策略限制时，请在官方页面完成登录或直接使用系统浏览器）。</div>
          </div>

          {/* 兼容旧 E2E 容器与状态标记 */}
          <div
            id="chatgpt-webview"
            data-testid="chatgpt-webview"
            data-webview-enabled="false"
            data-companion-active={companionActive ? 'true' : 'false'}
            style={{
              marginTop: 'auto',
              padding: '12px',
              border: '1px dashed var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '11px',
              color: 'var(--color-muted)',
              textAlign: 'center',
            }}
          >
            受控隔离视界容器已激活 · 授权目标: {CHATGPT_URL}
          </div>
        </section>

        {/* 右侧：方案导入与确认面板 */}
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-card)',
            padding: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-ink)', margin: 0 }}>
              2. 方案提炼与导入（ChatGPT → Studio）
            </h2>
            <button
              type="button"
              className="secondary"
              onClick={handlePasteFromClipboard}
              style={{ fontSize: '12px', padding: '4px 10px' }}
            >
              📋 从剪贴板粘贴
            </button>
          </div>

          <p style={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--color-muted)', margin: 0 }}>
            粘贴在 ChatGPT 网页中商讨确定的方案文本，Studio 会自动解析任务目标、施工范围与验收标准：
          </p>

          <textarea
            data-testid="chatgpt-raw-input"
            value={rawPlanText}
            onChange={(e) => {
              setRawPlanText(e.target.value);
              // 关键安全修复：输入改变后，旧预览与旧确认立即失效！
              setPreviewPlan(null);
              setFeedback(null);
            }}
            placeholder="在此粘贴来自 ChatGPT 的讨论方案、任务草稿或 Markdown 蓝图..."
            rows={5}
            style={{
              width: '100%',
              padding: '10px',
              fontSize: '13px',
              fontFamily: 'monospace',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
              color: 'var(--color-ink)',
              resize: 'vertical',
            }}
          />

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              data-testid="parse-plan-button"
              onClick={handleParseInput}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              🔍 解析方案结构
            </button>
            {previewPlan && (
              <button
                type="button"
                className="secondary"
                onClick={() => setPreviewPlan(null)}
                style={{ fontSize: '13px', padding: '6px 14px' }}
              >
                清空预览
              </button>
            )}
          </div>

          {/* 方案预览与确认卡片（关键门禁：用户确认前绝不自动创建或施工） */}
          {previewPlan && (
            <div
              data-testid="plan-import-preview"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                padding: '14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface-subtle)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-ink)' }}>
                  📋 方案预览与确认门禁
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--color-selected-bg)',
                    color: 'var(--color-primary)',
                  }}
                >
                  目标项目：{currentProjectName || '当前项目'}
                </span>
              </div>

              <div>
                <label style={{ fontSize: '12px', color: 'var(--color-muted)', display: 'block', marginBottom: '4px' }}>
                  任务目标（可微调）：
                </label>
                <input
                  type="text"
                  data-testid="preview-edited-goal"
                  value={editedGoal}
                  onChange={(e) => setEditedGoal(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: '13px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg)',
                    color: 'var(--color-ink)',
                  }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>施工范围（涉及文件）：</span>
                  {!previewPlan.scopeConfirmed && (
                    <span style={{ fontSize: '10px', color: 'var(--color-warn)', background: 'var(--color-surface)', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--color-border)' }}>
                      待确认
                    </span>
                  )}
                </div>
                <div style={{ margin: '4px 0 0 0', fontSize: '12px' }}>
                  {editedScope.map((f, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '2px' }}>
                      <code>{f}</code>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>验收标准：</span>
                  {!previewPlan.criteriaConfirmed && (
                    <span style={{ fontSize: '10px', color: 'var(--color-warn)', background: 'var(--color-surface)', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--color-border)' }}>
                      待确认
                    </span>
                  )}
                </div>
                <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5 }}>
                  {editedCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              {editedConstraints.length > 0 && (
                <div>
                  <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>重要约束：</span>
                  <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5 }}>
                    {editedConstraints.map((ct, i) => (
                      <li key={i}><code>{ct}</code></li>
                    ))}
                  </ul>
                </div>
              )}

              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-warn)',
                  background: 'var(--color-selected-bg)',
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                ⚠️ 安全门禁控制：点击下方确认按钮仅创建受控任务卡片；必须经你再次核准开工计划后，AI 执行体才会开始施工。
              </div>

              <button
                type="button"
                data-testid="confirm-import-plan-button"
                onClick={handleConfirmImport}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  marginTop: '4px',
                }}
              >
                ✅ 确认导入为 Studio 任务
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
