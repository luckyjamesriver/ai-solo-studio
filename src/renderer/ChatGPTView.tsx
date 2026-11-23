import { useState } from 'react';
import { extractContentFromWebview } from './webBridge.js';
import { CHATGPT_WEB_URL, validateApprovedExternalUrl } from './externalServices.js';
import { parsePlanFromText, type ParsedPlan } from './planParser.js';
import { studio } from './api.js';

interface ChatGPTViewProps {
  currentProjectName?: string;
  onImportPlanToTask: (content: string) => void;
  onBackToProject: () => void;
}

/**
 * ChatGPT 官方视界与协同控制台（P0-2）
 * 经批准的外部服务入口；受控安全隔离基线与人机协同交接。
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
  const [companionActive, setCompanionActive] = useState(false);

  // 1. 打开独立伴侣视界
  const handleOpenCompanion = async () => {
    setFeedback(null);
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

  // 3. 从剪贴板粘贴方案
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().length > 5) {
        setRawPlanText(text.trim());
        const parsed = parsePlanFromText(text.trim());
        setPreviewPlan(parsed);
        setEditedGoal(parsed.goal || parsed.title);
        setFeedback('已从剪贴板读取方案，请在下方预览并确认。');
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
    const parsed = parsePlanFromText(rawPlanText.trim());
    setPreviewPlan(parsed);
    setEditedGoal(parsed.goal || parsed.title);
    setFeedback('方案已完成解析，请在下方预览并确认。');
  };

  // 5. 用户主动确认后，才真正导入为 Studio 任务
  const handleConfirmImport = () => {
    if (!previewPlan) return;
    const finalContent = editedGoal.trim()
      ? `【来自 ChatGPT 方案】${editedGoal.trim()}\n\n验收标准：\n${previewPlan.criteria.map((c) => `- [ ] ${c}`).join('\n')}`
      : previewPlan.rawText;
    onImportPlanToTask(finalContent);
  };

  // 6. 提炼并转为任务按钮（兼容旧 E2E 阶段 9 交互流程）
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
        setRawPlanText(candidate);
        const parsed = parsePlanFromText(candidate);
        setPreviewPlan(parsed);
        setEditedGoal(parsed.goal || parsed.title);
        // 如果是由 prompt 或已有输入明确触发的提炼，直接完成导入交接
        onImportPlanToTask(candidate);
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
            独立伴侣视界 · 会话沙箱隔离（persist:ai_solo_chatgpt）· 杜绝 User-Agent 伪装与 Cookie 读取
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {feedback && (
            <span style={{ fontSize: '12px', color: 'var(--color-warn)' }}>
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
              onClick={handleOpenCompanion}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              🖥️ {companionActive ? '聚焦独立伴侣视界' : '打开独立伴侣视界'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleOpenSystemBrowser}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              🌐 在系统默认浏览器打开
            </button>
          </div>

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
            <div>• <b>安全窗口策略</b>：单独 BrowserWindow、启用沙箱、严格拦截弹窗与跨域跳转。</div>
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
            粘贴在 ChatGPT 网页中商讨确定的方案文本，Studio 会自动解析任务目标与验收标准供你审查确认：
          </p>

          <textarea
            value={rawPlanText}
            onChange={(e) => setRawPlanText(e.target.value)}
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

          {/* 方案预览与确认卡片（关键门禁：用户确认前不自动施工） */}
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
              <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-ink)' }}>
                📋 方案预览与导入确认
              </div>

              <div>
                <label style={{ fontSize: '12px', color: 'var(--color-muted)', display: 'block', marginBottom: '4px' }}>
                  任务目标：
                </label>
                <input
                  type="text"
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
                <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>解析出的验收标准：</span>
                <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5 }}>
                  {previewPlan.criteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              {previewPlan.inScope.length > 0 && (
                <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
                  识别涉及文件：<code>{previewPlan.inScope.join(', ')}</code>
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
                ⚠️ 安全与控制声明：点击下方确认按钮后仅创建任务卡片，必须经你再次核准开工计划后才会开始施工。
              </div>

              <button
                type="button"
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
