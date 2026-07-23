'use strict';

/**
 * Secure bridge exposed to the renderer. The renderer has no direct access to
 * Node, the filesystem, or the network — only the whitelisted functions below,
 * which forward to IPC handlers in the main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

// Main-process → renderer events (menu commands, background job lifecycle).
const listeners = new Map();
function on(channel, cb) {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(cb, { channel, wrapped });
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    listeners.delete(cb);
  };
}

contextBridge.exposeInMainWorld('cc', {
  app: {
    info: () => invoke('app:info'),
  },
  connections: {
    list: () => invoke('connections:list'),
    save: (conn) => invoke('connections:save', conn),
    delete: (id) => invoke('connections:delete', id),
    test: (connOrId) => invoke('connections:test', connOrId),
    deploy: (id) => invoke('connections:deploy', id),
  },
  query: {
    run: (args) => invoke('query:run', args),
    runBackground: (args) => invoke('query:runBackground', args),
    cancel: (jobId) => invoke('query:cancel', jobId),
  },
  meta: {
    tables: (args) => invoke('meta:tables', args),
    columns: (args) => invoke('meta:columns', args),
    preview: (args) => invoke('meta:preview', args),
  },
  exportResults: (args) => invoke('export:save', args),
  history: {
    list: (limit) => invoke('history:list', limit),
    clear: () => invoke('history:clear'),
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  // Event subscriptions.
  onJobStarted: (cb) => on('job:started', cb),
  onJobCompleted: (cb) => on('job:completed', cb),
  onJobFailed: (cb) => on('job:failed', cb),
  onMenu: (channel, cb) => on(channel, cb),
});
