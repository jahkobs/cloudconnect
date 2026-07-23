'use strict';

/**
 * Oracle Autonomous Database (ADW / ATP) connector.
 *
 * Unlike Fusion, ADW/ATP are customer-controlled databases and DO permit direct
 * read-only SQL over a TLS/wallet connection using the Oracle driver. This
 * connector uses node-oracledb when it is available on the machine; the native
 * driver is intentionally NOT bundled, so in a stock install this connector
 * reports that the Oracle client must be provisioned (matching the spec's
 * requirement for wallet/TNS configuration and read-only DB accounts).
 */

let oracledb = null;
try {
  // Optional dependency — present only where an admin has provisioned it.
  // eslint-disable-next-line global-require, import/no-unresolved
  oracledb = require('oracledb');
} catch {
  oracledb = null;
}

class AdwConnector {
  constructor(conn) {
    this.conn = conn;
    this.adw = conn.adw || {};
  }

  get type() {
    return 'adw';
  }

  get capabilities() {
    // ADW supports direct SQL, explain plan, and result streaming.
    return { readOnly: false, explainPlan: true, metadata: true, deploy: false, streaming: true, driver: !!oracledb };
  }

  _unavailable() {
    return {
      ok: false,
      error:
        'Direct ADW/ATP connectivity requires the Oracle client (node-oracledb) and a wallet, ' +
        'which are provisioned by an administrator and not bundled with the app. ' +
        'Configure the wallet path and TNS alias, install the Oracle client, then retry.',
    };
  }

  async testConnection() {
    if (!oracledb) return this._unavailable();
    try {
      oracledb.initOracleClient({ configDir: this.adw.walletPath });
      const conn = await oracledb.getConnection({
        user: this.adw.username,
        password: this.conn.password,
        connectString: this.adw.tnsAlias,
      });
      const r = await conn.execute('select 1 as ok from dual');
      await conn.close();
      return { ok: true, version: 'ADW', rows: r.rows };
    } catch (err) {
      return { ok: false, error: `ADW connection failed: ${err.message}` };
    }
  }

  async runQuery(sql, opts = {}) {
    if (!oracledb) throw new Error(this._unavailable().error);
    const conn = await oracledb.getConnection({
      user: this.adw.username,
      password: this.conn.password,
      connectString: this.adw.tnsAlias,
    });
    try {
      const maxRows = opts.maxRows || this.conn.rowLimit || 10000;
      const r = await conn.execute(sql, opts.binds || {}, { maxRows, outFormat: oracledb.OUT_FORMAT_ARRAY });
      const columns = (r.metaData || []).map((m) => m.name);
      const rows = (r.rows || []).map((row) => row.map((v) => (v == null ? null : String(v))));
      return { columns, rows, rowCount: rows.length, truncated: rows.length >= maxRows, elapsedMs: 0, sql };
    } finally {
      await conn.close();
    }
  }

  async metadata(kind, args = {}) {
    // Reuse the same data-dictionary queries; ADW exposes ALL_TABLES etc.
    const queries = require('../fusion/queries');
    if (kind === 'tables') return this.runQuery(queries.listTables(args.filter), { maxRows: 500 });
    if (kind === 'columns') return this.runQuery(queries.listColumns(args.owner, args.table), { maxRows: 1000 });
    return this.runQuery(queries.previewTable(args.owner, args.table, args.limit), { maxRows: args.limit || 100 });
  }
}

module.exports = { AdwConnector };
