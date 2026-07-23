'use strict';

/**
 * Oracle Fusion BI Publisher connector.
 *
 * Executes read-only SQL against Fusion reporting data through the approved BI
 * Publisher report services (ExternalReportWSSService / ReportService runReport
 * over the protected endpoints), and manages the generic SQL Runner report via
 * CatalogService. Wraps the existing FusionClient implementation and adapts it
 * to the connector interface used by the gateway.
 *
 * Connector interface: { type, capabilities, testConnection, runQuery,
 *                        metadata, deploy? }
 */

const { FusionClient } = require('../fusion/client');
const queries = require('../fusion/queries');

class FusionBipConnector {
  constructor(conn) {
    this.conn = conn;
    this.client = new FusionClient({
      pod: conn.biPublisherUrl || conn.pod,
      username: conn.username,
      password: conn.password,
      reportPath: conn.reportPath,
    });
  }

  get type() {
    return 'fusion-bip';
  }

  get capabilities() {
    // Fusion BIP is read-only reporting; no explain plan, no direct DDL.
    return { readOnly: true, explainPlan: false, metadata: true, deploy: true, streaming: false };
  }

  async testConnection(signal) {
    return this.client.testConnection(signal);
  }

  async runQuery(sql, opts = {}) {
    const maxRows = opts.maxRows || this.conn.rowLimit || 10000;
    return this.client.runQuery(sql, { maxRows, signal: opts.signal });
  }

  async metadata(kind, args = {}, signal) {
    let sql;
    if (kind === 'tables') sql = queries.listTables(args.filter);
    else if (kind === 'columns') sql = queries.listColumns(args.owner, args.table);
    else if (kind === 'preview') sql = queries.previewTable(args.owner, args.table, args.limit);
    else throw new Error(`Unknown metadata kind: ${kind}`);
    return this.client.runQuery(sql, { maxRows: args.limit || 1000, signal });
  }

  async deploy(signal) {
    return this.client.deploySqlRunner(signal);
  }
}

module.exports = { FusionBipConnector };
