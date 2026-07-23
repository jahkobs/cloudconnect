'use strict';

const { app, BrowserWindow, Menu, shell, safeStorage, ipcMain } = require('electron');
const path = require('path');
const { Store } = require('./core/store');
const { AuditLog, EVENTS } = require('./core/audit');
const { AiAssistant } = require('./core/ai');
const { Gateway } = require('./gateway/gateway');
const ipc = require('./ipc');

const isDev = process.argv.includes('--dev');
let mainWindow = null;
let store = null;
let audit = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 660,
    backgroundColor: '#0f1729',
    title: 'FusionQuery Studio',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function emit(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: () => emit('menu:new-tab') },
        { label: 'Export Results…', accelerator: 'CmdOrCtrl+E', click: () => emit('menu:export') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', click: () => emit('menu:format') },
      ],
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run Query', accelerator: 'CmdOrCtrl+Return', click: () => emit('menu:run') },
        { label: 'Run in Background', accelerator: 'CmdOrCtrl+Shift+Return', click: () => emit('menu:run-bg') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Connections', click: () => emit('menu:connections') },
        { label: 'Query History', accelerator: 'CmdOrCtrl+H', click: () => emit('menu:history') },
        { label: 'AI Assistant', click: () => emit('menu:ai') },
        { label: 'Audit Log', click: () => emit('menu:audit') },
        { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Connection',
      submenu: [
        { label: 'Deploy SQL Runner Report…', click: () => emit('menu:deploy') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/jahkobs/cloudconnect#readme') },
        { label: 'About FusionQuery Studio', click: () => emit('menu:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  store = new Store(app, safeStorage);
  audit = new AuditLog(app);
  const gateway = new Gateway(store, audit);
  const ai = new AiAssistant();

  audit.record(EVENTS.LOGIN, { app: 'FusionQuery Studio' }, { user: 'local' });

  ipc.register({ store, gateway, audit, ai }, () => mainWindow);
  ipcMain.handle('app:ping', () => 'pong');

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (audit) audit.record(EVENTS.LOGOUT, {}, { user: 'local' });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
