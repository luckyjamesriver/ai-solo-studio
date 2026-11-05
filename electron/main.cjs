const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0e14',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
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

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
