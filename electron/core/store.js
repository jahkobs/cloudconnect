'use strict';

/**
 * Persistent store for FusionQuery Studio (v2).
 *
 * Holds connection profiles (multiple types + environments), the query library,
 * query history, and settings under the Electron user-data directory as JSON.
 * Secrets (passwords / tokens / wallet passphrases) are NEVER written in clear
 * text: they are encrypted with Electron safeStorage (OS keychain / DPAPI).
 * If encryption is unavailable the secret is not persisted.
 *
 * @typedef {'fusion-bip'|'fusion-rest'|'adw'|'bicc'|'demo'} ConnType
 * @typedef {'DEV'|'TEST'|'UAT'|'PROD'} Environment
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONN_TYPES = ['fusion-bip', 'fusion-rest', 'adw', 'bicc', 'demo'];
const ENVIRONMENTS = ['DEV', 'TEST', 'UAT', 'PROD'];

class Store {
  constructor(app, safeStorage) {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'fusionquery-studio.json');
    this.safeStorage = safeStorage;
    this.data = { connections: [], library: [], history: [], settings: {} };
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { connections: [], library: [], history: [], settings: {}, ...parsed };
    } catch {
      /* first run */
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Store persist failed:', err.message);
    }
  }

  _encrypt(secret) {
    if (!secret) return null;
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return { enc: 'safeStorage', v: this.safeStorage.encryptString(secret).toString('base64') };
    }
    return { enc: 'none' };
  }

  _decrypt(secret) {
    if (secret && secret.enc === 'safeStorage' && this.safeStorage) {
      try {
        return this.safeStorage.decryptString(Buffer.from(secret.v, 'base64'));
      } catch {
        return '';
      }
    }
    return '';
  }

  encryptionAvailable() {
    return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  // ---- Connections -------------------------------------------------------

  /** Public projection — never exposes decrypted secrets to the renderer. */
  listConnections() {
    return this.data.connections.map((c) => this._publicConn(c));
  }

  _publicConn(c) {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      environment: c.environment,
      production: !!c.production,
      disabled: !!c.disabled,
      pod: c.pod,
      biPublisherUrl: c.biPublisherUrl,
      restBaseUrl: c.restBaseUrl,
      username: c.username,
      authMethod: c.authMethod,
      reportPath: c.reportPath,
      catalogFolder: c.catalogFolder,
      dataSource: c.dataSource,
      dynamicMode: !!c.dynamicMode,
      rowLimit: c.rowLimit,
      timeoutSec: c.timeoutSec,
      modules: c.modules || [],
      adw: c.adw ? { tnsAlias: c.adw.tnsAlias, serviceLevel: c.adw.serviceLevel, username: c.adw.username, walletPath: c.adw.walletPath } : null,
      hasSecret: !!(c.secret && c.secret.enc === 'safeStorage'),
    };
  }

  getConnection(id) {
    const c = this.data.connections.find((x) => x.id === id);
    if (!c) return null;
    return { ...c, password: this._decrypt(c.secret) };
  }

  saveConnection(conn) {
    const now = Date.now();
    const existing = conn.id && this.data.connections.find((c) => c.id === conn.id);
    const rec = existing || { id: crypto.randomUUID(), createdAt: now };
    const isNew = !existing;

    rec.name = conn.name || 'Untitled';
    rec.type = CONN_TYPES.includes(conn.type) ? conn.type : 'fusion-bip';
    rec.environment = ENVIRONMENTS.includes(conn.environment) ? conn.environment : 'DEV';
    rec.production = rec.environment === 'PROD' || !!conn.production;
    rec.disabled = !!conn.disabled;
    rec.pod = conn.pod || '';
    rec.biPublisherUrl = conn.biPublisherUrl || '';
    rec.restBaseUrl = conn.restBaseUrl || '';
    rec.username = conn.username || '';
    rec.authMethod = conn.authMethod || 'basic';
    rec.reportPath = conn.reportPath || '/Custom/FusionQueryStudio/SQLRunner.xdo';
    rec.catalogFolder = conn.catalogFolder || '/Custom/FusionQueryStudio';
    rec.dataSource = conn.dataSource || 'ApplicationDB_FSCM';
    rec.dynamicMode = rec.production ? false : !!conn.dynamicMode; // disabled in prod
    rec.rowLimit = clampInt(conn.rowLimit, 1, 1000000, 10000);
    rec.timeoutSec = clampInt(conn.timeoutSec, 60, 1800, 300);
    rec.modules = Array.isArray(conn.modules) ? conn.modules : [];
    rec.demo = rec.type === 'demo';
    if (conn.adw) {
      rec.adw = {
        tnsAlias: conn.adw.tnsAlias || '',
        serviceLevel: conn.adw.serviceLevel || 'Medium',
        username: conn.adw.username || '',
        walletPath: conn.adw.walletPath || '',
      };
    }
    rec.updatedAt = now;
    if (conn.password) rec.secret = this._encrypt(conn.password);

    if (isNew) this.data.connections.push(rec);
    this._save();
    return { id: rec.id, isNew, connection: this._publicConn(rec) };
  }

  deleteConnection(id) {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this._save();
  }

  cloneConnection(id) {
    const c = this.data.connections.find((x) => x.id === id);
    if (!c) return null;
    const copy = { ...c, id: crypto.randomUUID(), name: `${c.name} (copy)`, createdAt: Date.now() };
    this.data.connections.push(copy);
    this._save();
    return this._publicConn(copy);
  }

  // ---- Query library -----------------------------------------------------

  listLibrary() {
    return this.data.library.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  saveLibraryItem(item) {
    const now = Date.now();
    const existing = item.id && this.data.library.find((x) => x.id === item.id);
    const rec = existing || { id: crypto.randomUUID(), createdAt: now, version: 0 };
    rec.name = item.name || 'Untitled query';
    rec.module = item.module || 'General';
    rec.sql = item.sql || '';
    rec.tags = Array.isArray(item.tags) ? item.tags : [];
    rec.status = item.status || 'Draft';
    rec.author = item.author || 'local';
    rec.environment = item.environment || null;
    rec.version = (rec.version || 0) + 1;
    rec.updatedAt = now;
    if (!existing) this.data.library.push(rec);
    this._save();
    return rec;
  }

  deleteLibraryItem(id) {
    this.data.library = this.data.library.filter((x) => x.id !== id);
    this._save();
  }

  // ---- History -----------------------------------------------------------

  addHistory(entry) {
    this.data.history.unshift({
      id: crypto.randomUUID(),
      at: Date.now(),
      ...entry,
    });
    if (this.data.history.length > 1000) this.data.history.length = 1000;
    this._save();
  }

  listHistory(limit = 300) {
    return this.data.history.slice(0, limit);
  }

  clearHistory() {
    this.data.history = [];
    this._save();
  }

  // ---- Settings ----------------------------------------------------------

  getSettings() {
    return { maxRows: 10000, theme: 'dark', inactivityTimeoutMin: 30, role: 'Query Developer', ...this.data.settings };
  }

  saveSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this._save();
    return this.getSettings();
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = { Store, CONN_TYPES, ENVIRONMENTS };
