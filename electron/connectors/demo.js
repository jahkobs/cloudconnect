'use strict';

/**
 * Demo connector — answers queries and metadata from a synthetic Fusion schema
 * so the whole application can be explored without a live pod or credentials.
 * Wraps the in-memory demo provider.
 */

const { runDemo, SCHEMA } = require('../fusion/demo');

class DemoConnector {
  constructor(conn) {
    this.conn = conn;
  }

  get type() {
    return 'demo';
  }

  get capabilities() {
    return { readOnly: true, explainPlan: false, metadata: true, deploy: false, streaming: false };
  }

  async testConnection() {
    await delay(120);
    return { ok: true, version: 'demo', pod: 'demo://synthetic-fusion' };
  }

  async runQuery(sql, opts = {}) {
    await delay(120);
    if (opts.signal && opts.signal.aborted) throw new Error('Cancelled.');
    return { ...runDemo(sql, opts.maxRows || 10000), sql };
  }

  async metadata(kind, args = {}) {
    await delay(60);
    if (kind === 'tables') {
      const columns = ['OWNER', 'TABLE_NAME', 'OBJECT_TYPE'];
      const rows = [];
      for (const [owner, tables] of Object.entries(SCHEMA)) {
        for (const t of Object.keys(tables)) {
          if (!args.filter || `${owner}.${t}`.toLowerCase().includes(String(args.filter).toLowerCase())) {
            rows.push([owner, t, 'TABLE']);
          }
        }
      }
      return { columns, rows, rowCount: rows.length, truncated: false, elapsedMs: 40 };
    }
    if (kind === 'columns') {
      return runDemo(
        `SELECT column_name FROM all_tab_columns WHERE owner='${args.owner}' AND table_name='${args.table}'`,
        1000
      );
    }
    return runDemo(`SELECT * FROM ${args.owner}.${args.table}`, args.limit || 100);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { DemoConnector };
