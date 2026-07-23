'use strict';

const { app, BrowserWindow, Menu, shell, safeStorage, ipcMain } = require('electron');
const path = require('path');
const { Store } = require('./store');
const ipc = require('./ipc');

const isDev = process.argv.includes('--dev');
let mainWindow = null;
let store = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1729',
    title: 'CloudConnect',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the IPC bridge
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

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: () => emit('menu:new-tab') },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: () => emit('menu:open-file') },
        { label: 'Save SQL…', accelerator: 'CmdOrCtrl+S', click: () => emit('menu:save-file') },
        { type: 'separator' },
        { label: 'Export Results…', accelerator: 'CmdOrCtrl+E', click: () => emit('menu:export') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', click: () => emit('menu:format') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => emit('menu:find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle DB Browser', accelerator: 'CmdOrCtrl+B', click: () => emit('menu:toggle-browser') },
        { label: 'Toggle Minimap', click: () => emit('menu:toggle-minimap') },
        { label: 'Query History', accelerator: 'CmdOrCtrl+H', click: () => emit('menu:history') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run Query', accelerator: 'CmdOrCtrl+Return', click: () => emit('menu:run') },
        { label: 'Run in Background', accelerator: 'CmdOrCtrl+Shift+Return', click: () => emit('menu:run-bg') },
        { label: 'Cancel', accelerator: 'CmdOrCtrl+.', click: () => emit('menu:cancel') },
      ],
    },
    {
      label: 'Account',
      submenu: [
        { label: 'Manage Connections…', click: () => emit('menu:connections') },
        { label: 'Deploy SQL Runner Report…', click: () => emit('menu:deploy') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => emit('menu:settings') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/jahkobs/cloudconnect#readme') },
        { label: 'About CloudConnect', click: () => emit('menu:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function emit(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

app.whenReady().then(() => {
  store = new Store(app, safeStorage);
  ipc.register(store, () => mainWindow);

  // Renderer asks whether OS-backed encryption is available.
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    platform: process.platform,
  }));

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
