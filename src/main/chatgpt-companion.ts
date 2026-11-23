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
  lastLoadError: string | null;
  lastBlockedUrl: string | null;
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
 * ChatGPT 独立伴侣视界管理器（P0-2-R2 安全加固版）
 * 
 * 安全架构：
 * 1. 独立 BrowserWindow：与主应用窗口完全隔离，主应用保持 webviewTag: false。
 * 2. 强沙箱与零特权：启用 contextIsolation: true、nodeIntegration: false、sandbox: true，绝不注入主应用 preload。
 * 3. 独立持久化分区：使用 persist:ai_solo_chatgpt，Cookie 与本地存储同主窗口严格隔离。
 * 4. 受控导航与弹窗（R2 关键加固）：
 *    - 远程网页绝对无法通过 window.open 或页面重定向静默启动宿主系统浏览器（全面移除静默 shell.openExternal）。
 *    - 允许白名单内的官方页面与 OAuth 页面在伴侣窗口内加载。
 *    - 白名单外弹窗与跳转一律拦截拒绝并记录审计日志。
 * 5. 权限请求全拒绝：默认拦截并拒绝任何敏感系统权限请求（摄像头、麦克风、地理位置等）。
 * 6. 诚实身份与合规：绝不伪装 User-Agent、不篡改 Cookie，真实网页登录状态如实标记为 LIVE_LOGIN_NOT_VERIFIED。
 * 7. 页面加载错误感知：监听 did-fail-load，感知网络阻断或服务商屏蔽，为用户提供诚实反馈与系统浏览器安全兜底。
 */
export class ChatGPTCompanionManager {
  private companionWindow: BrowserWindow | null = null;
  private lastLoadError: string | null = null;
  private lastBlockedUrl: string | null = null;

  public openCompanion(): { ok: boolean; status: ChatGPTCompanionStatus } {
    if (this.companionWindow && !this.companionWindow.isDestroyed()) {
      if (this.companionWindow.isMinimized()) {
        this.companionWindow.restore();
      }
      this.companionWindow.focus();
      return { ok: true, status: this.getStatus() };
    }

    this.lastLoadError = null;
    this.lastBlockedUrl = null;

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

    this.setupWebContentsSecurity(win.webContents, win);

    win.on('closed', () => {
      this.companionWindow = null;
    });

    void win.loadURL(CHATGPT_COMPANION_URL);

    return { ok: true, status: this.getStatus() };
  }

  /**
   * 为伴侣视界 WebContents 注入严格的安全拦截与状态监听规则（P0-2-R3 加固版）。
   * 包含：弹窗拦截、主框架跳转拦截、服务端重定向拦截、子框架导航拦截、加载失败感知及系统权限拒绝。
   */
  public setupWebContentsSecurity(
    webContents: Electron.WebContents | any,
    win: BrowserWindow | any
  ): void {
    // 弹窗拦截（R2 加固）：白名单内在当前窗口载入，非白名单一律拒绝；绝不自动唤起外部应用！
    webContents.setWindowOpenHandler(({ url }: { url: string }) => {
      if (isAllowedChatGPTUrl(url)) {
        if (typeof win?.loadURL === 'function') {
          void win.loadURL(url);
        }
      } else {
        this.lastBlockedUrl = url;
      }
      return { action: 'deny' };
    });

    // 页面跳转拦截（R2 加固）：禁止跳出白名单域名；绝不自动唤起外部应用！
    webContents.on('will-navigate', (event: any, navigationUrl: string) => {
      if (!isAllowedChatGPTUrl(navigationUrl)) {
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        this.lastBlockedUrl = navigationUrl;
      }
    });

    // HTTP 服务端重定向拦截（P0-2-R3 加固）：拦截 301/302 重定向到非白名单域名
    webContents.on('will-redirect', (event: any, redirectUrl: string) => {
      if (!isAllowedChatGPTUrl(redirectUrl)) {
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        this.lastBlockedUrl = redirectUrl;
      }
    });

    // 子框架导航拦截（P0-2-R3 加固）：防止 iframe 逃逸到未授权外部域名
    webContents.on('will-frame-navigate', (event: any) => {
      const targetUrl = event?.url || '';
      if (!isAllowedChatGPTUrl(targetUrl)) {
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        this.lastBlockedUrl = targetUrl;
      }
    });

    // 页面加载失败感知：诚实记录错误并向 UI 报告
    webContents.on('did-fail-load', (_event: any, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
      if (isMainFrame) {
        this.lastLoadError = `${errorDescription} (${errorCode}) @ ${validatedURL}`;
      }
    });

    // 系统权限拦截：默认拒绝所有系统级权限请求与同步权限查询
    webContents.session?.setPermissionRequestHandler((_webContents: any, _permission: any, callback: (grant: boolean) => void) => {
      callback(false);
    });
    webContents.session?.setPermissionCheckHandler(() => false);
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
      lastLoadError: this.lastLoadError,
      lastBlockedUrl: this.lastBlockedUrl,
    };
  }

  public async openSystemBrowser(): Promise<{ ok: boolean }> {
    await shell.openExternal(CHATGPT_COMPANION_URL);
    return { ok: true };
  }

  public getCompanionWindow(): BrowserWindow | null {
    return this.companionWindow;
  }

  public getLastBlockedUrl(): string | null {
    return this.lastBlockedUrl;
  }

  public getLastLoadError(): string | null {
    return this.lastLoadError;
  }
}

export const chatgptCompanion = new ChatGPTCompanionManager();
