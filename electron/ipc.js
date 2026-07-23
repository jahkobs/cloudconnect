'use strict';

/**
 * IPC surface between the renderer and main process. All network access to
 * Oracle Fusion and all disk I/O happen here in the main process; the renderer
 * only ever sees sanitized data through these channels.
 */

const { ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const { FusionClient, FusionError } = require('./fusion/client');
const { runDemo } = require('./fusion/demo');
const queries = require('./fusion/queries');
const exporter = require('./export');

// Track in-flight background jobs so they can be cancelled.
const jobs = new Map();

function clientFor(store, connectionId) {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new FusionError('Connection not found.');
  return { conn, client: conn.demo ? null : new FusionClient(conn) };
}

async function execute(store, connectionId, sql, maxRows, signal) {
  const { conn, client } = clientFor(store, connectionId);
  if (conn.demo) {
    // Simulate a little latency so background/foreground UX is visible.
    await new Promise((r) => setTimeout(r, 150));
    if (signal && signal.aborted) throw new FusionError('Cancelled.');
    return { ...runDemo(sql, maxRows), sql };
  }
  return client.runQuery(sql, { maxRows, signal });
}

function register(store, getWindow) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- Connections -------------------------------------------------------
  ipcMain.handle('connections:list', () => store.listConnections());
  ipcMain.handle('connections:save', (_e, conn) => store.saveConnection(conn));
  ipcMain.handle('connections:delete', (_e, id) => store.deleteConnection(id));

  ipcMain.handle('connections:test', async (_e, connOrId) => {
    try {
      let conn = typeof connOrId === 'string' ? store.getConnection(connOrId) : connOrId;
      if (!conn) return { ok: false, error: 'Connection not found.' };
      if (conn.demo) return { ok: true, version: 'demo', pod: 'demo://synthetic-fusion' };
      const info = await new FusionClient(conn).testConnection();
      return info;
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    }
  });

  ipcMain.handle('connections:deploy', async (_e, connectionId) => {
    try {
      const conn = store.getConnection(connectionId);
      if (!conn) return { ok: false, error: 'Connection not found.' };
      if (conn.demo) return { ok: true, reportPath: conn.reportPath, demo: true };
      const res = await new FusionClient(conn).deploySqlRunner();
      return res;
    } catch (err) {
      return { ok: false, error: err.message, detail: err.detail };
    }
  });

  // ---- Query execution (foreground) --------------------------------------
  ipcMain.handle('query:run', async (_e, { connectionId, sql, maxRows }) => {
    try {
      const result = await execute(store, connectionId, sql, maxRows);
      const conn = store.getConnection(connectionId);
      store.addHistory({
        sql,
        connectionId,
        connectionName: conn && conn.name,
        rowCount: result.rowCount,
        elapsedMs: result.elapsedMs,
        ok: true,
      });
      return { ok: true, result };
    } catch (err) {
      store.addHistory({ sql, connectionId, ok: false, error: err.message });
      return { ok: false, error: err.message, detail: err.detail, status: err.status };
    }
  });

  // ---- Query execution (background) --------------------------------------
  ipcMain.handle('query:runBackground', (_e, { connectionId, sql, maxRows, tabId }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    jobs.set(jobId, controller);
    send('job:started', { jobId, tabId, sql });

    (async () => {
      try {
        const result = await execute(store, connectionId, sql, maxRows, controller.signal);
        const conn = store.getConnection(connectionId);
        store.addHistory({
          sql,
          connectionId,
          connectionName: conn && conn.name,
          rowCount: result.rowCount,
          elapsedMs: result.elapsedMs,
          ok: true,
        });
        send('job:completed', { jobId, tabId, result });
        notify('Background query completed', `Job ${jobId} returned ${result.rowCount} rows.`);
      } catch (err) {
        store.addHistory({ sql, connectionId, ok: false, error: err.message });
        send('job:failed', { jobId, tabId, error: err.message, detail: err.detail });
        notify('Background query failed', err.message);
      } finally {
        jobs.delete(jobId);
      }
    })();

    return { jobId };
  });

  ipcMain.handle('query:cancel', (_e, jobId) => {
    const c = jobs.get(jobId);
    if (c) {
      c.abort();
      jobs.delete(jobId);
      return { ok: true };
    }
    return { ok: false };
  });

  // ---- Database browser --------------------------------------------------
  ipcMain.handle('meta:tables', async (_e, { connectionId, filter }) => {
    try {
      const result = await execute(store, connectionId, queries.listTables(filter), 500);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('meta:columns', async (_e, { connectionId, owner, table }) => {
    try {
      const result = await execute(store, connectionId, queries.listColumns(owner, table), 1000);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('meta:preview', async (_e, { connectionId, owner, table, limit }) => {
    try {
      const result = await execute(store, connectionId, queries.previewTable(owner, table, limit), limit || 100);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Export ------------------------------------------------------------
  ipcMain.handle('export:save', async (_e, { columns, rows, format, defaultName }) => {
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Export results',
      defaultPath: `${defaultName || 'cloudconnect_export'}.${ext}`,
      filters:
        ext === 'xlsx'
          ? [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      if (ext === 'xlsx') await exporter.writeXlsx(filePath, columns, rows, path.basename(filePath, '.xlsx'));
      else await exporter.writeCsv(filePath, columns, rows);
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- History & settings ------------------------------------------------
  ipcMain.handle('history:list', (_e, limit) => store.listHistory(limit));
  ipcMain.handle('history:clear', () => store.clearHistory());
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => store.saveSettings(patch));
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* notifications are best-effort */
  }
}

module.exports = { register };
