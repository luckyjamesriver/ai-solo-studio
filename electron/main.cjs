const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let loginWindow = null;

// Persistent partitions for user subscriptions
const CLAUDE_PARTITION = 'persist:ai_solo_claude';
const CHATGPT_PARTITION = 'persist:ai_solo_chatgpt';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f0f4f9',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true, // Enable native embedded official webviews
    },
  });

  const devUrl = 'http://localhost:5173';
  const prodHtml = path.join(__dirname, '../dist/index.html');

  if (fs.existsSync(prodHtml) && process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(prodHtml);
  } else {
    mainWindow.loadURL(devUrl).catch(() => {
      if (fs.existsSync(prodHtml)) {
        mainWindow.loadFile(prodHtml);
      } else {
        setTimeout(() => mainWindow.loadURL(devUrl), 1000);
      }
    });
  }

  // Handle external links (open in system default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://claude.ai') || url.startsWith('https://chatgpt.com')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// IPC: Open Login Window for Claude or ChatGPT using persistent partition
ipcMain.handle('open-login-window', async (event, provider) => {
  const isClaude = provider === 'claude';
  const partitionName = isClaude ? CLAUDE_PARTITION : CHATGPT_PARTITION;
  const userSession = session.fromPartition(partitionName);

  const targetUrl = isClaude 
    ? 'https://claude.ai/login' 
    : 'https://chatgpt.com/auth/login';

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    loginWindow.loadURL(targetUrl);
    return;
  }

  loginWindow = new BrowserWindow({
    width: 900,
    height: 750,
    title: isClaude ? '登录 Claude.ai 官方账号 (Pro 订阅)' : '登录 ChatGPT 官方账号 (Plus 订阅)',
    backgroundColor: '#ffffff',
    webPreferences: {
      session: userSession,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  loginWindow.loadURL(targetUrl);

  // Monitor navigation to detect login success
  loginWindow.webContents.on('did-navigate', async (e, url) => {
    console.log(`[AccountBridge] Navigated to: ${url}`);
    
    // Detection logic
    if (isClaude && url.includes('claude.ai') && !url.includes('/login')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-status-change', { provider: 'claude', connected: true });
      }
    }

    if (!isClaude && url.includes('chatgpt.com') && !url.includes('/auth') && !url.includes('/login')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-status-change', { provider: 'chatgpt', connected: true });
      }
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
    // Re-check cookies upon window close
    checkAccountStatus();
  });
});

// IPC: Open local project folder in Finder
ipcMain.handle('open-project-folder', async (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
    return { success: true };
  }
  return { success: false, error: 'Path not found' };
});

// IPC: Check current login status based on stored cookies
async function checkAccountStatus() {
  try {
    const claudeSess = session.fromPartition(CLAUDE_PARTITION);
    const chatgptSess = session.fromPartition(CHATGPT_PARTITION);

    const claudeCookies = await claudeSess.cookies.get({ domain: 'claude.ai' });
    const chatgptCookies = await chatgptSess.cookies.get({ domain: 'chatgpt.com' });

    const isClaudeLoggedIn = claudeCookies.some(c => 
      c.name.includes('sessionKey') || c.name.includes('token') || c.name.includes('routing')
    );

    const isChatGptLoggedIn = chatgptCookies.some(c => 
      c.name.includes('session') || c.name.includes('auth') || c.name.includes('token')
    );

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('initial-account-status', {
        claude: isClaudeLoggedIn,
        chatgpt: isChatGptLoggedIn,
      });
    }

    return { claude: isClaudeLoggedIn, chatgpt: isChatGptLoggedIn };
  } catch (err) {
    console.error('[AccountBridge] Error checking cookies:', err);
    return { claude: false, chatgpt: false };
  }
}

ipcMain.handle('check-account-status', async () => {
  return await checkAccountStatus();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
