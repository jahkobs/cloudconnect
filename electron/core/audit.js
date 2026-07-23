'use strict';

/**
 * Tamper-evident audit log (spec FR-018).
 *
 * Every audited event is chained to the previous one with a SHA-256 hash
 * (event N's `prevHash` = hash of event N-1). Any edit or deletion of an
 * earlier record breaks the chain, which `verifyChain()` detects. Records are
 * append-only JSON lines under the user-data directory. Credentials are never
 * written — callers must pass already-redacted detail.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS = Object.freeze({
  LOGIN: 'user.login',
  LOGOUT: 'user.logout',
  CONNECTION_CREATE: 'connection.create',
  CONNECTION_UPDATE: 'connection.update',
  CONNECTION_DELETE: 'connection.delete',
  CONNECTION_TEST: 'connection.test',
  QUERY_EXECUTE: 'query.execute',
  QUERY_REJECT: 'query.reject',
  QUERY_APPROVE: 'query.approve',
  RESULT_EXPORT: 'result.export',
  ACCESS_DENIED: 'access.denied',
  ADMIN_CHANGE: 'admin.change',
  AI_GENERATE: 'ai.generate',
  BIP_OBJECT_CREATE: 'bip.object.create',
  BIP_OBJECT_DELETE: 'bip.object.delete',
});

class AuditLog {
  constructor(app) {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'audit.log.jsonl');
    this._lastHash = this._computeTailHash();
  }

  _computeTailHash() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length === 0) return 'GENESIS';
      const last = JSON.parse(lines[lines.length - 1]);
      return this._hash(last);
    } catch {
      return 'GENESIS';
    }
  }

  _hash(record) {
    const { hash, ...rest } = record; // hash field excluded from its own hash
    void hash;
    return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  }

  /**
   * Append an audit record.
   * @param {string} event   one of EVENTS
   * @param {object} detail  redacted, non-sensitive context
   * @param {object} [ctx]   { user, connectionId, connectionName, environment }
   */
  record(event, detail = {}, ctx = {}) {
    const rec = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      event,
      user: ctx.user || 'local',
      connectionId: ctx.connectionId || null,
      connectionName: ctx.connectionName || null,
      environment: ctx.environment || null,
      detail: redact(detail),
      prevHash: this._lastHash,
    };
    rec.hash = this._hash(rec);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
      this._lastHash = rec.hash;
    } catch (err) {
      console.error('Audit append failed:', err.message);
    }
    return rec;
  }

  list(limit = 500, filter = {}) {
    let lines;
    try {
      lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
    let recs = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    if (filter.event) recs = recs.filter((r) => r.event === filter.event);
    if (filter.text) {
      const t = String(filter.text).toLowerCase();
      recs = recs.filter((r) => JSON.stringify(r).toLowerCase().includes(t));
    }
    return recs.reverse().slice(0, limit);
  }

  /** Verify the hash chain is intact. Returns { ok, brokenAt? }. */
  verifyChain() {
    let lines;
    try {
      lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return { ok: true, count: 0 };
    }
    let prev = 'GENESIS';
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      if (rec.prevHash !== prev) return { ok: false, brokenAt: i };
      if (this._hash(rec) !== rec.hash) return { ok: false, brokenAt: i };
      prev = rec.hash;
    }
    return { ok: true, count: lines.length };
  }
}

const SENSITIVE = /pass(word)?|secret|token|credential|wallet|bearer|authorization/i;
function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) out[k] = '***redacted***';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

module.exports = { AuditLog, EVENTS, redact };
