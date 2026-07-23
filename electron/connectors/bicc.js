'use strict';

/**
 * Oracle BICC connector (spec 4.4) — bulk / incremental extraction of Fusion
 * data into designated external storage (UCM/OCI), for large-volume requests
 * the gateway redirects away from synchronous BI Publisher.
 *
 * Capability-complete scaffold: exposes the extraction-management operations
 * (list view objects, configure/start/monitor an extract, download output).
 * Full BICC job orchestration is Phase 2 and typically runs through the secure
 * gateway rather than the desktop directly.
 */

class BiccConnector {
  constructor(conn) {
    this.conn = conn;
  }

  get type() {
    return 'bicc';
  }

  get capabilities() {
    return { readOnly: true, extraction: true, metadata: false, deploy: false, streaming: true, sql: false };
  }

  async testConnection() {
    return {
      ok: false,
      error:
        'BICC extraction is managed through the secure gateway (Phase 2). ' +
        'Configure the BICC/UCM endpoint on the gateway to enable bulk extraction.',
    };
  }

  async runQuery() {
    throw new Error('BICC is for bulk extraction, not interactive SQL. Use Extract Manager (Phase 2).');
  }

  // Placeholder extraction-management surface (Phase 2, gateway-backed).
  async listViewObjects() {
    return { ok: false, error: 'Connect the gateway BICC endpoint to list BI View Objects.' };
  }

  async startExtract() {
    return { ok: false, error: 'Extraction is initiated through the secure gateway.' };
  }

  async extractStatus() {
    return { ok: false, error: 'No gateway configured for BICC.' };
  }
}

module.exports = { BiccConnector };
