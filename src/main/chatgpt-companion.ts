import { BrowserWindow, shell } from 'electron';

export const CHATGPT_COMPANION_URL = 'https://chatgpt.com';
export const CHATGPT_PARTITION = 'persist:ai_solo_chatgpt';

export const ALLOWED_CHATGPT_ORIGINS = [
  'https://chatgpt.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://login.live.com',
  'https://appleid.apple.com',
  'https://accounts.google.com',
] as const;

export interface ChatGPTCompanionStatus {
  isOpen: boolean;
  url: string;
  authStatus: 'LIVE_LOGIN_NOT_VERIFIED';
}

/**
 * 校验指定 URL 是否属于 ChatGPT 官方网页或经批准的第三方联合登录来源。
 * 拒绝非 https 协议以及未授权的外域，保障伴侣窗口网络边界。
 */
export function isAllowedChatGPTUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const origin = parsed.origin.toLowerCase();
    return ALLOWED_CHATGPT_ORIGINS.some((allowed) => allowed.toLowerCase() === origin);
  } catch {
    return false;
  }
}

/**
 * ChatGPT 独立伴侣视界管理器（P0-2）
 * 
 * 安全架构：
 * 1. 独立 BrowserWindow：与主应用窗口完全隔离，主应用保持 webviewTag: false。
 * 2. 强沙箱与零特权：启用 contextIsolation: true、nodeIntegration: false、sandbox: true，绝不注入主应用 preload。
 * 3. 独立持久化分区：使用 persist:ai_solo_chatgpt，Cookie 与本地存储同主窗口严格隔离。
 * 4. 受控导航与弹窗：所有弹窗一律 deny，白名单内同窗加载，白名单外一律委托系统默认浏览器（shell.openExternal）。
 * 5. 权限请求全拒绝：默认拦截并拒绝任何敏感系统权限请求（摄像头、麦克风、地理位置等）。
 * 6. 诚实身份与合规：绝不伪装 User-Agent、不篡改 Cookie，真实网页登录状态如实标记为 LIVE_LOGIN_NOT_VERIFIED。
 */
export class ChatGPTCompanionManager {
  private companionWindow: BrowserWindow | null = null;

  public openCompanion(): { ok: boolean; status: ChatGPTCompanionStatus } {
    if (this.companionWindow && !this.companionWindow.isDestroyed()) {
      if (this.companionWindow.isMinimized()) {
        this.companionWindow.restore();
      }
      this.companionWindow.focus();
      return { ok: true, status: this.getStatus() };
    }

    const win = new BrowserWindow({
      width: 1080,
      height: 840,
      minWidth: 500,
      minHeight: 400,
      title: 'ChatGPT · 独立伴侣视界',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        partition: CHATGPT_PARTITION,
      },
    });

    this.companionWindow = win;

    // 弹窗拦截：禁止任意新弹窗，受信任域在伴侣窗口内打开，外部链接交由系统默认浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedChatGPTUrl(url)) {
        void win.loadURL(url);
      } else if (url.startsWith('https://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // 页面跳转拦截：禁止跳向未受信任的第三方站点
    win.webContents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedChatGPTUrl(navigationUrl)) {
        event.preventDefault();
        if (navigationUrl.startsWith('https://')) {
          void shell.openExternal(navigationUrl);
        }
      }
    });

    // 系统权限拦截：默认拒绝所有权限请求
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    win.on('closed', () => {
      this.companionWindow = null;
    });

    void win.loadURL(CHATGPT_COMPANION_URL);

    return { ok: true, status: this.getStatus() };
  }

  public closeCompanion(): { ok: boolean } {
    if (this.companionWindow && !this.companionWindow.isDestroyed()) {
      this.companionWindow.close();
      this.companionWindow = null;
    }
    return { ok: true };
  }

  public getStatus(): ChatGPTCompanionStatus {
    const isOpen = Boolean(this.companionWindow && !this.companionWindow.isDestroyed());
    return {
      isOpen,
      url: CHATGPT_COMPANION_URL,
      authStatus: 'LIVE_LOGIN_NOT_VERIFIED',
    };
  }

  public async openSystemBrowser(): Promise<{ ok: boolean }> {
    await shell.openExternal(CHATGPT_COMPANION_URL);
    return { ok: true };
  }

  public getCompanionWindow(): BrowserWindow | null {
    return this.companionWindow;
  }
}

export const chatgptCompanion = new ChatGPTCompanionManager();
