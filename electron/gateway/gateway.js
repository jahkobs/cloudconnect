'use strict';

/**
 * Secure Query Gateway (client-side, direct mode).
 *
 * This is the single choke point every query passes through (spec §3). It:
 *   1. resolves the connection and instantiates the correct connector,
 *   2. enforces read-only SQL for Fusion/ADW connections via the parser-based
 *      validator (rejecting DML/DDL/PLSQL) — spec FR-007,
 *   3. applies the connection's row limit and timeout,
 *   4. blocks execution on disabled connections,
 *   5. records a tamper-evident audit event for every execute / reject /
 *      export / test (spec FR-018),
 *   6. returns a uniform result envelope with execution metadata.
 *
 * The class is deliberately transport-agnostic: today it talks to connectors
 * in-process ("direct mode"); the same surface can later proxy to the
 * organisation's ASP.NET Core Secure Gateway without changing callers.
 */

const { validateReadOnly } = require('../core/sql-validator');
const { EVENTS } = require('../core/audit');
const { FusionBipConnector } = require('../connectors/fusion-bip');
const { FusionRestConnector } = require('../connectors/fusion-rest');
const { AdwConnector } = require('../connectors/adw');
const { BiccConnector } = require('../connectors/bicc');
const { DemoConnector } = require('../connectors/demo');

const CONNECTORS = {
  'fusion-bip': FusionBipConnector,
  'fusion-rest': FusionRestConnector,
  adw: AdwConnector,
  bicc: BiccConnector,
  demo: DemoConnector,
};

// Connection types whose SQL must be read-only-validated before execution.
const ENFORCE_READONLY = new Set(['fusion-bip', 'demo', 'adw']);

class Gateway {
  constructor(store, audit) {
    this.store = store;
    this.audit = audit;
  }

  _ctx(conn) {
    return conn
      ? { connectionId: conn.id, connectionName: conn.name, environment: conn.environment }
      : {};
  }

  _connector(conn) {
    const Ctor = CONNECTORS[conn.type] || CONNECTORS['fusion-bip'];
    return new Ctor(conn);
  }

  async test(connectionId) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return { ok: false, error: 'Connection not found.' };
    if (conn.disabled) return { ok: false, error: 'This connection is disabled.' };
    try {
      const res = await this._connector(conn).testConnection();
      this.audit.record(EVENTS.CONNECTION_TEST, { ok: !!res.ok, type: conn.type }, this._ctx(conn));
      return res;
    } catch (err) {
      this.audit.record(EVENTS.CONNECTION_TEST, { ok: false, error: err.message }, this._ctx(conn));
      return { ok: false, error: err.message };
    }
  }

  /**
   * Execute a query with governance.
   * @returns {Promise<{ok, result?, error?, validation?, meta?}>}
   */
  async runQuery(connectionId, sql, opts = {}) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return { ok: false, error: 'Connection not found.' };
    if (conn.disabled) return { ok: false, error: 'This connection is disabled.' };

    // 1. Read-only enforcement for governed connection types.
    if (ENFORCE_READONLY.has(conn.type)) {
      const v = validateReadOnly(sql);
      if (!v.valid) {
        this.audit.record(
          EVENTS.QUERY_REJECT,
          { reason: v.error, sqlPreview: sql.slice(0, 200) },
          this._ctx(conn)
        );
        return { ok: false, error: v.error, validation: v, rejected: true };
      }
    }

    // 2. Apply the connection's row limit as a hard ceiling.
    const requested = opts.maxRows || conn.rowLimit || 10000;
    const maxRows = Math.min(requested, conn.rowLimit || requested);

    const started = Date.now();
    try {
      const result = await this._connector(conn).runQuery(sql, {
        maxRows,
        binds: opts.binds,
        signal: opts.signal,
      });
      const meta = {
        connectionName: conn.name,
        environment: conn.environment,
        production: conn.production,
        user: opts.user || 'local',
        params: opts.binds ? Object.keys(opts.binds) : [],
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        rowLimit: maxRows,
      };
      this.audit.record(
        EVENTS.QUERY_EXECUTE,
        { rowCount: result.rowCount, elapsedMs: result.elapsedMs, truncated: !!result.truncated, params: meta.params },
        this._ctx(conn)
      );
      return { ok: true, result, meta };
    } catch (err) {
      this.audit.record(EVENTS.QUERY_EXECUTE, { error: err.message }, this._ctx(conn));
      return { ok: false, error: err.message, detail: err.detail };
    }
  }

  async metadata(connectionId, kind, args = {}) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return { ok: false, error: 'Connection not found.' };
    const connector = this._connector(conn);
    if (!connector.metadata) return { ok: false, error: `${conn.type} does not expose schema metadata.` };
    try {
      const result = await connector.metadata(kind, args);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async deploy(connectionId) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return { ok: false, error: 'Connection not found.' };
    if (conn.type === 'demo') return { ok: true, demo: true, reportPath: conn.reportPath };
    const connector = this._connector(conn);
    if (!connector.deploy) return { ok: false, error: `${conn.type} has nothing to deploy.` };
    try {
      const res = await connector.deploy();
      this.audit.record(EVENTS.BIP_OBJECT_CREATE, { reportPath: res.reportPath }, this._ctx(conn));
      return res;
    } catch (err) {
      return { ok: false, error: err.message, detail: err.detail };
    }
  }

  capabilities(connectionId) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return null;
    return this._connector(conn).capabilities;
  }

  /**
   * Step-by-step connection diagnostics — pinpoints exactly which stage of the
   * BI Publisher pipeline fails so a user can act (deploy report, fix roles,
   * correct the pod URL). Each step carries a remedy hint.
   * @returns {Promise<{ok, steps: {step, ok, detail, remedy?}[]}>}
   */
  async diagnose(connectionId) {
    const conn = this.store.getConnection(connectionId);
    if (!conn) return { ok: false, steps: [{ step: 'Resolve connection', ok: false, detail: 'Connection not found.' }] };
    const connector = this._connector(conn);
    const steps = [];

    // 1. Reachability + authentication
    try {
      const t = await connector.testConnection();
      steps.push({
        step: 'Reach pod & authenticate',
        ok: !!t.ok,
        detail: t.ok ? (t.warning || `OK${t.version ? ' · ' + t.version : ''}`) : t.error,
        remedy: t.ok ? null : 'Check the pod URL (https://<host>.fa.<dc>.oraclecloud.com) and the username/password. The user needs BI Publisher roles (BIConsumer/BIAuthor).',
      });
    } catch (e) {
      steps.push({ step: 'Reach pod & authenticate', ok: false, detail: e.message, remedy: 'Verify network/VPN/proxy access to the pod.' });
    }

    if (connector.type === 'fusion-rest' || connector.type === 'bicc') {
      return { ok: steps.every((s) => s.ok), steps };
    }

    // 2. Execute SELECT 1 through the SQL Runner report (proves it is deployed + runs)
    try {
      const r = await connector.runQuery('SELECT 1 AS ok FROM DUAL', { maxRows: 1 });
      const got = r && r.rowCount >= 1;
      steps.push({
        step: 'Execute SELECT 1 via SQL Runner report',
        ok: got,
        detail: got ? 'Report executed and returned a row.' : 'Report ran but returned no rows.',
        remedy: got ? null : 'The report exists but produced no data — check the data model data source.',
      });
    } catch (e) {
      const notFound = /not found|404/i.test(e.message || '');
      steps.push({
        step: 'Execute SELECT 1 via SQL Runner report',
        ok: false,
        detail: e.message,
        remedy: notFound
          ? 'The SQL Runner report is not deployed on this pod. Use “Deploy SQL Runner” on the connection (needs BIAuthor to write /Custom).'
          : 'BI Publisher rejected the run — confirm the report path and that the account can run reports. Full detail: ' + (e.detail || '').slice(0, 300),
      });
    }

    // 3. Read the data dictionary (schema browser source)
    try {
      const r = await connector.metadata('tables', {});
      const n = r && r.rowCount;
      steps.push({
        step: 'Read data dictionary (schema browser)',
        ok: n > 0,
        detail: n > 0 ? `${n} objects visible.` : 'No objects visible.',
        remedy: n > 0 ? null : 'The account can run reports but sees no ALL_TABLES rows — grant read access to the reporting schema/data source.',
      });
    } catch (e) {
      steps.push({ step: 'Read data dictionary (schema browser)', ok: false, detail: e.message, remedy: 'Same SQL Runner report is used for the schema browser; fix step 2 first.' });
    }

    return { ok: steps.every((s) => s.ok), steps };
  }
}

module.exports = { Gateway, CONNECTORS };
