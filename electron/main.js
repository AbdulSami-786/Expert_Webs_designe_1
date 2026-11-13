// Electron main process — wraps the Vite build in a desktop window.
//
// Development: loads the Vite dev server (npm run electron:dev).
// Production:  loads dist/index.html from inside the packaged program.

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Its own port, so electron:dev never opens another project that happens to be
// running on Vite's default 5173. Matches the electron:dev script.
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5199';
const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Expert Webs Designs',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    show: false,
    // The packaged .exe already carries build/icon.png; this covers dev runs.
    ...(isDev ? { icon: path.join(__dirname, '..', 'build', 'icon.png') } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Printing opens a blank popup and writes the bill into it
  // (src/lib/exporters.js), so those stay inside the program. Any real web
  // link — WhatsApp, a shared ledger URL — goes to the user's normal browser
  // instead of a bare window with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:|^mailto:|^tel:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Never let the main window navigate away from the dashboard itself.
  win.webContents.on('will-navigate', (event, url) => {
    const own = isDev ? url.startsWith(DEV_URL) : url.startsWith('file:');
    if (!own) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// One copy of the program at a time: a second launch focuses the existing
// window, so two windows cannot race each other writing to the same Sheet.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
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
}
