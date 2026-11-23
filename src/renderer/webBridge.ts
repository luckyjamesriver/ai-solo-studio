/**
 * WebCodex 提取辅助模块
 * 从嵌入的 ChatGPT / 官方网页中安全提取方案文本与代码块
 */

export interface WebExtractionResult {
  success: boolean;
  text: string;
  codeBlocks: string[];
  isSelection: boolean;
  error?: string;
}

export function extractMarkdownCodeBlocks(raw: string): string[] {
  const codeRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  for (const match of raw.matchAll(codeRegex)) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks;
}

export async function extractContentFromWebview(webviewSelector = '#chatgpt-webview'): Promise<WebExtractionResult> {
  const webview = document.querySelector(webviewSelector) as any;
  if (webview && typeof webview.executeJavaScript === 'function') {
    try {
      const script = `
        (() => {
          // 1. 优先提取用户在网页中主动划选的文本
          const selection = window.getSelection()?.toString();
          if (selection && selection.trim().length > 10) {
            return { text: selection.trim(), isSelection: true };
          }

          // 2. ChatGPT 官方 DOM 结构捕获
          const chatgptArticles = document.querySelectorAll('article[data-testid^="conversation-turn-"]');
          if (chatgptArticles && chatgptArticles.length > 0) {
            const lastArticle = chatgptArticles[chatgptArticles.length - 1];
            const assistantElem = lastArticle.querySelector('[data-message-author-role="assistant"]') || lastArticle;
            const text = assistantElem.innerText.trim();
            if (text.length > 5) return { text, isSelection: false };
          }

          // 3. 备用 assistant 节点选择器
          const assistantNodes = document.querySelectorAll('[data-message-author-role="assistant"]');
          if (assistantNodes && assistantNodes.length > 0) {
            const last = assistantNodes[assistantNodes.length - 1];
            const text = last.innerText.trim();
            if (text.length > 5) return { text, isSelection: false };
          }

          // 4. 提取 pre/code 代码块
          const preBlocks = Array.from(document.querySelectorAll('pre code, pre'))
            .map(p => p.innerText.trim())
            .filter(Boolean);
          if (preBlocks.length > 0) {
            return { text: preBlocks.join('\\n\\n'), isSelection: false };
          }

          return { text: '', isSelection: false };
        })()
      `;

      const res = await webview.executeJavaScript(script);
      if (res && res.text && res.text.trim().length > 5) {
        const cleanText = res.text.trim();
        return {
          success: true,
          text: cleanText,
          codeBlocks: extractMarkdownCodeBlocks(cleanText),
          isSelection: !!res.isSelection,
        };
      }
    } catch (err) {
      console.warn('[WebBridge] executeJavaScript error:', err);
    }
  }

  return {
    success: false,
    text: '',
    codeBlocks: [],
    isSelection: false,
    error: '未能在网页中捕获到回答。请确保网页已完成输出，或使用剪贴板与手动输入方案！',
  };
}
