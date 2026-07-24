'use strict';

/**
 * IPC surface for FusionQuery Studio (v2). Everything the renderer can do goes
 * through here; all network/disk access and all governance (read-only
 * enforcement, row limits, audit) happen in the main process via the Gateway.
 */

const { ipcMain, dialog, Notification } = require('electron');
const exporter = require('./export');
const { detectBindParams } = require('./core/sql-validator');
const { validateReadOnly } = require('./core/sql-validator');
const { EVENTS } = require('./core/audit');

const jobs = new Map();

function register({ store, gateway, audit, ai }, getWindow) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const connName = (id) => {
    const c = store.getConnection(id);
    return c ? { name: c.name, environment: c.environment } : {};
  };

  // ---- app ---------------------------------------------------------------
  ipcMain.handle('app:info', (_e) => ({
    version: require('../package.json').version,
    encryptionAvailable: store.encryptionAvailable(),
    platform: process.platform,
  }));

  // ---- connections -------------------------------------------------------
  ipcMain.handle('connections:list', () => store.listConnections());
  ipcMain.handle('connections:save', (_e, conn) => {
    const res = store.saveConnection(conn);
    audit.record(res.isNew ? EVENTS.CONNECTION_CREATE : EVENTS.CONNECTION_UPDATE, { type: res.connection.type }, {
      connectionId: res.id, connectionName: res.connection.name, environment: res.connection.environment,
    });
    return res;
  });
  ipcMain.handle('connections:delete', (_e, id) => {
    const meta = connName(id);
    store.deleteConnection(id);
    audit.record(EVENTS.CONNECTION_DELETE, {}, { connectionId: id, ...meta });
    return { ok: true };
  });
  ipcMain.handle('connections:clone', (_e, id) => store.cloneConnection(id));
  ipcMain.handle('connections:test', (_e, id) => gateway.test(id));
  ipcMain.handle('connections:diagnose', (_e, id) => gateway.diagnose(id));
  ipcMain.handle('connections:deploy', (_e, id) => gateway.deploy(id));
  ipcMain.handle('connections:capabilities', (_e, id) => gateway.capabilities(id));

  // ---- query -------------------------------------------------------------
  ipcMain.handle('query:validate', (_e, sql) => {
    const v = validateReadOnly(sql);
    return { valid: v.valid, error: v.error, statementType: v.statementType, bindParams: detectBindParams(sql) };
  });

  ipcMain.handle('query:run', async (_e, { connectionId, sql, maxRows, binds }) => {
    const res = await gateway.runQuery(connectionId, sql, { maxRows, binds });
    const meta = connName(connectionId);
    store.addHistory({
      sql, connectionId, connectionName: meta.name, environment: meta.environment,
      rowCount: res.ok ? res.result.rowCount : 0, elapsedMs: res.ok ? res.result.elapsedMs : 0,
      ok: res.ok, error: res.ok ? null : res.error,
    });
    return res;
  });

  ipcMain.handle('query:runBackground', (_e, { connectionId, sql, maxRows, binds, tabId }) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    jobs.set(jobId, controller);
    send('job:started', { jobId, tabId, sql });
    (async () => {
      const res = await gateway.runQuery(connectionId, sql, { maxRows, binds, signal: controller.signal });
      const meta = connName(connectionId);
      store.addHistory({
        sql, connectionId, connectionName: meta.name, environment: meta.environment,
        rowCount: res.ok ? res.result.rowCount : 0, elapsedMs: res.ok ? res.result.elapsedMs : 0,
        ok: res.ok, error: res.ok ? null : res.error,
      });
      if (res.ok) {
        send('job:completed', { jobId, tabId, result: res.result, meta: res.meta });
        notify('Query completed', `${res.result.rowCount} rows returned.`);
      } else {
        send('job:failed', { jobId, tabId, error: res.error });
        notify('Query failed', res.error);
      }
      jobs.delete(jobId);
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

  // ---- metadata ----------------------------------------------------------
  ipcMain.handle('meta:tables', (_e, { connectionId, filter }) => gateway.metadata(connectionId, 'tables', { filter }));
  ipcMain.handle('meta:columns', (_e, { connectionId, owner, table }) => gateway.metadata(connectionId, 'columns', { owner, table }));
  ipcMain.handle('meta:preview', (_e, { connectionId, owner, table, limit }) => gateway.metadata(connectionId, 'preview', { owner, table, limit }));

  // ---- library -----------------------------------------------------------
  ipcMain.handle('library:list', () => store.listLibrary());
  ipcMain.handle('library:save', (_e, item) => store.saveLibraryItem(item));
  ipcMain.handle('library:delete', (_e, id) => {
    store.deleteLibraryItem(id);
    return { ok: true };
  });

  // ---- history -----------------------------------------------------------
  ipcMain.handle('history:list', (_e, limit) => store.listHistory(limit));
  ipcMain.handle('history:clear', () => {
    store.clearHistory();
    return { ok: true };
  });

  // ---- audit -------------------------------------------------------------
  ipcMain.handle('audit:list', (_e, limit, filter) => audit.list(limit, filter));
  ipcMain.handle('audit:verify', () => audit.verifyChain());

  // ---- ai ----------------------------------------------------------------
  ipcMain.handle('ai:generate', async (_e, { connectionId, prompt, schema }) => {
    const res = await ai.generate(prompt, { schema });
    const meta = connName(connectionId);
    audit.record(EVENTS.AI_GENERATE, { promptPreview: String(prompt || '').slice(0, 120), ok: res.ok }, { connectionId, ...meta });
    return res;
  });

  // ---- settings ----------------------------------------------------------
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => store.saveSettings(patch));

  // ---- export ------------------------------------------------------------
  ipcMain.handle('export:save', async (_e, { columns, rows, format, defaultName, meta }) => {
    const extMap = { csv: 'csv', xlsx: 'xlsx', json: 'json', xml: 'xml' };
    const ext = extMap[format] || 'csv';
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Export results',
      defaultPath: `${defaultName || 'fusionquery_export'}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      if (ext === 'xlsx') await exporter.writeXlsx(filePath, columns, rows);
      else if (ext === 'json') await exporter.writeJson(filePath, columns, rows, meta);
      else if (ext === 'xml') await exporter.writeXml(filePath, columns, rows, meta);
      else await exporter.writeCsv(filePath, columns, rows);
      audit.record(EVENTS.RESULT_EXPORT, { format: ext, rowCount: rows.length });
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* best-effort */
  }
}

module.exports = { register };
