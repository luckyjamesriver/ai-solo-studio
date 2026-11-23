import { useState } from 'react';
import { extractContentFromWebview } from './webBridge.js';
import { CHATGPT_WEB_URL, validateApprovedExternalUrl } from './externalServices.js';

interface ChatGPTViewProps {
  currentProjectName?: string;
  onImportPlanToTask: (content: string) => void;
  onBackToProject: () => void;
}

/**
 * ChatGPT 官方视界（UI v2.1 极简风格）
 * 经批准的外部服务入口；受控安全隔离基线。
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

  const handleExtractAndTransfer = async () => {
    setExtracting(true);
    setFeedback(null);
    try {
      const res = await extractContentFromWebview('#chatgpt-webview');
      if (res.success && res.text) {
        onImportPlanToTask(res.text);
      } else {
        const manual = prompt('未能自动提取到内容。你可以手动粘贴 ChatGPT 生成的方案文本：', '');
        if (manual && manual.trim().length > 5) {
          onImportPlanToTask(manual.trim());
        } else {
          setFeedback('未能获取有效方案，请在网页中生成回复或选中文字后再试。');
        }
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
      }}
    >
      {/* 顶部控制栏（UI v2.1 风格：克制、雅致） */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px var(--space-gutter)',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface-subtle)',
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
              ChatGPT.com 官方视界
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
          </div>
          <div
            style={{
              fontSize: 'var(--text-muted)',
              color: 'var(--color-muted)',
              marginTop: '2px',
            }}
          >
            免 API 密钥直通个人订阅 · 分区：<code>persist:ai_solo_chatgpt</code>（若 Google 登录遇“通行密钥”，点下方「试试其他方式」选密码或验证码即可）
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

      {/* 受控隔离视界容器（主窗口禁用 webviewTag 时呈现安全基线保护视图） */}
      <div
        id="chatgpt-webview"
        data-testid="chatgpt-webview"
        data-webview-enabled="false"
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: '540px' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔒</div>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            安全隔离保护中
          </h3>
          <p style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: '16px' }}>
            根据项目安全基线（ADR 0006），主渲染窗口默认关闭内嵌 webviewTag。已配置授权目标：{CHATGPT_URL}。
          </p>
          <p style={{ fontSize: '12px', lineHeight: 1.5, opacity: 0.75 }}>
            双向通信与独立伴随视界将在 P0-2 安全专项中通过独立隔离窗口提供。当前可直接点击上方按钮录入或提取方案。
          </p>
        </div>
      </div>
    </div>
  );
}
