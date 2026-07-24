'use strict';

/**
 * Secure bridge for FusionQuery Studio. The renderer gets only the whitelisted
 * `window.fqs` surface — no Node, filesystem, or network access.
 */

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, cb) => {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('fqs', {
  app: { info: () => invoke('app:info') },
  connections: {
    list: () => invoke('connections:list'),
    save: (conn) => invoke('connections:save', conn),
    delete: (id) => invoke('connections:delete', id),
    clone: (id) => invoke('connections:clone', id),
    test: (id) => invoke('connections:test', id),
    diagnose: (id) => invoke('connections:diagnose', id),
    deploy: (id) => invoke('connections:deploy', id),
    capabilities: (id) => invoke('connections:capabilities', id),
  },
  query: {
    validate: (sql) => invoke('query:validate', sql),
    run: (args) => invoke('query:run', args),
    runBackground: (args) => invoke('query:runBackground', args),
    cancel: (jobId) => invoke('query:cancel', jobId),
  },
  meta: {
    tables: (args) => invoke('meta:tables', args),
    columns: (args) => invoke('meta:columns', args),
    preview: (args) => invoke('meta:preview', args),
  },
  library: {
    list: () => invoke('library:list'),
    save: (item) => invoke('library:save', item),
    delete: (id) => invoke('library:delete', id),
  },
  history: {
    list: (limit) => invoke('history:list', limit),
    clear: () => invoke('history:clear'),
  },
  audit: {
    list: (limit, filter) => invoke('audit:list', limit, filter),
    verify: () => invoke('audit:verify'),
  },
  ai: { generate: (args) => invoke('ai:generate', args) },
  settings: { get: () => invoke('settings:get'), save: (patch) => invoke('settings:save', patch) },
  export: (args) => invoke('export:save', args),

  onJobStarted: (cb) => on('job:started', cb),
  onJobCompleted: (cb) => on('job:completed', cb),
  onJobFailed: (cb) => on('job:failed', cb),
  onMenu: (channel, cb) => on(channel, cb),
});
