'use strict';

/**
 * Oracle Fusion REST connector (spec 4.2).
 *
 * Queries supported business objects through Oracle Fusion REST APIs using
 * OAuth 2.0 bearer tokens or (where still permitted) basic auth. This is
 * resource/JSON based rather than SQL; the gateway routes REST connections here
 * for resource discovery and paged fetches. Wired as a capability-complete
 * scaffold — the describe/list calls are implemented; a full REST query
 * designer is Phase 2.
 */

class FusionRestConnector {
  constructor(conn) {
    this.conn = conn;
    this.base = String(conn.restBaseUrl || conn.pod || '').replace(/\/+$/, '');
  }

  get type() {
    return 'fusion-rest';
  }

  get capabilities() {
    return { readOnly: true, explainPlan: false, metadata: true, deploy: false, streaming: false, sql: false };
  }

  _authHeader() {
    if (this.conn.authMethod === 'oauth' && this.conn.password) {
      return `Bearer ${this.conn.password}`; // token stored as the secret
    }
    const token = Buffer.from(`${this.conn.username}:${this.conn.password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
  }

  async testConnection() {
    if (!this.base) return { ok: false, error: 'REST base URL is required.' };
    try {
      const res = await fetch(`${this.base}/hcmRestApi/resources/latest`, {
        headers: { Authorization: this._authHeader(), Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: `Authentication failed (HTTP ${res.status}).` };
      return { ok: res.ok, version: 'REST', status: res.status };
    } catch (err) {
      return { ok: false, error: `Could not reach REST endpoint: ${err.message}` };
    }
  }

  async runQuery() {
    throw new Error('REST connections are resource-based. Use the REST query designer (Phase 2), not SQL.');
  }

  async fetchResource(resource, params = {}) {
    const url = new URL(`${this.base}/${String(resource).replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      headers: { Authorization: this._authHeader(), Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`REST ${res.status}`);
    return res.json();
  }
}

module.exports = { FusionRestConnector };
