import { useState } from 'react';
import { extractContentFromWebview } from './webBridge.js';

interface ChatGPTViewProps {
  currentProjectName?: string;
  onImportPlanToTask: (content: string) => void;
  onBackToProject: () => void;
}

/**
 * ChatGPT 官方视界（UI v2.1 极简风格）
 * 100% 官方网页内嵌，直通个人订阅；支持一键提炼方案并转为当前项目的任务工单。
 */
const CHATGPT_URL = ['https:', '', 'chatgpt.com'].join('/');

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

      {/* 原生内嵌 Webview 容器 */}
      <div style={{ flex: 1, width: '100%', height: '100%', position: 'relative' }}>
        {/* @ts-ignore */}
        <webview
          id="chatgpt-webview"
          src={CHATGPT_URL}
          partition="persist:ai_solo_chatgpt"
          allowpopups
          useragent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
        />
      </div>
    </div>
  );
}
