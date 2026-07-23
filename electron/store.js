'use strict';

/**
 * Persistent storage for connection profiles and query history.
 *
 * Connection metadata (name, pod URL, username, options) is stored as plain
 * JSON under the Electron userData directory. Passwords are never written in
 * clear text: they are encrypted with Electron's safeStorage, which is backed
 * by the OS keychain (Keychain on macOS, libsecret on Linux, DPAPI on Windows).
 * If safeStorage is unavailable the password is not persisted and the user is
 * prompted per session.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(app, safeStorage) {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'cloudconnect.json');
    this.safeStorage = safeStorage;
    this.data = { connections: [], history: [], settings: {} };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { connections: [], history: [], settings: {}, ...parsed };
    } catch {
      /* first run: keep defaults */
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      // Surface but do not crash: storage is best-effort.
      console.error('Failed to persist store:', err.message);
    }
  }

  _encrypt(password) {
    if (!password) return null;
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return { enc: 'safeStorage', v: this.safeStorage.encryptString(password).toString('base64') };
    }
    return { enc: 'none' }; // not persisted
  }

  _decrypt(secret) {
    if (!secret) return '';
    if (secret.enc === 'safeStorage' && this.safeStorage) {
      try {
        return this.safeStorage.decryptString(Buffer.from(secret.v, 'base64'));
      } catch {
        return '';
      }
    }
    return '';
  }

  // ---- Connections -------------------------------------------------------

  listConnections() {
    // Never return raw secrets to the renderer.
    return this.data.connections.map((c) => ({
      id: c.id,
      name: c.name,
      pod: c.pod,
      username: c.username,
      reportPath: c.reportPath,
      dataSource: c.dataSource,
      demo: !!c.demo,
      hasPassword: !!(c.secret && c.secret.enc === 'safeStorage'),
    }));
  }

  getConnection(id) {
    const c = this.data.connections.find((x) => x.id === id);
    if (!c) return null;
    return { ...c, password: this._decrypt(c.secret) };
  }

  saveConnection(conn) {
    const now = Date.now();
    let existing = conn.id && this.data.connections.find((c) => c.id === conn.id);
    const record = existing || { id: crypto.randomUUID(), createdAt: now };
    record.name = conn.name || 'Untitled';
    record.pod = conn.pod || '';
    record.username = conn.username || '';
    record.reportPath = conn.reportPath || '/Custom/CloudConnect/SQLRunner.xdo';
    record.dataSource = conn.dataSource || 'ApplicationDB_FSCM';
    record.demo = !!conn.demo;
    record.updatedAt = now;
    // Only re-encrypt when a new password is supplied.
    if (conn.password !== undefined && conn.password !== null && conn.password !== '') {
      record.secret = this._encrypt(conn.password);
    }
    if (!existing) this.data.connections.push(record);
    this._save();
    return record.id;
  }

  deleteConnection(id) {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this._save();
  }

  // ---- History -----------------------------------------------------------

  addHistory(entry) {
    this.data.history.unshift({
      id: crypto.randomUUID(),
      at: Date.now(),
      sql: entry.sql,
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      rowCount: entry.rowCount,
      elapsedMs: entry.elapsedMs,
      ok: entry.ok,
      error: entry.error || null,
    });
    if (this.data.history.length > 500) this.data.history.length = 500;
    this._save();
  }

  listHistory(limit = 200) {
    return this.data.history.slice(0, limit);
  }

  clearHistory() {
    this.data.history = [];
    this._save();
  }

  // ---- Settings ----------------------------------------------------------

  getSettings() {
    return { maxRows: 100, theme: 'dark', ...this.data.settings };
  }

  saveSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this._save();
    return this.getSettings();
  }
}

module.exports = { Store };
