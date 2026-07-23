'use strict';

/**
 * Oracle Fusion Cloud Applications client.
 *
 * Oracle Fusion SaaS does not expose the underlying database on a network
 * port, so arbitrary SQL cannot be run over JDBC/OCI. The supported path is
 * Oracle Analytics Publisher (BI Publisher), which is embedded in every Fusion
 * pod. This client executes SQL by invoking a generic "SQL Runner" BI Publisher
 * report whose data model contains a single lexical parameter (`p_sql`). BI
 * Publisher substitutes the lexical parameter into the data-model SQL before
 * execution, which lets an authorized user run arbitrary read queries.
 *
 * Endpoints used:
 *   - REST v2 run:  POST {pod}/xmlpserver/services/rest/v2/reports/{path}/run
 *   - REST v1 run:  POST {pod}/xmlpserver/services/rest/v1/reports/{path}/run
 *   - SOAP catalog: POST {pod}/xmlpserver/services/v2/CatalogService  (deploy)
 *
 * Authentication is HTTP Basic against a Fusion user holding the BI Publisher
 * roles (BIAuthor / BIConsumer) plus data access to the queried schemas.
 */

const { XMLParser } = require('fast-xml-parser');
const { parseCsv } = require('./parser');
const { buildReportArchive } = require('./report');

const DEFAULT_REPORT_PATH = '/Custom/CloudConnect/SQLRunner.xdo';
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // Fusion long queries; matches BIP async ceiling.

class FusionError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'FusionError';
    this.status = status;
    this.detail = detail;
  }
}

function normalizePod(url) {
  if (!url) throw new FusionError('Pod URL is required.');
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

class FusionClient {
  /**
   * @param {object} conn
   * @param {string} conn.pod       Fusion pod base URL, e.g. https://xxx.fa.us2.oraclecloud.com
   * @param {string} conn.username
   * @param {string} conn.password
   * @param {string} [conn.reportPath] Absolute catalog path to the SQL Runner report.
   */
  constructor(conn) {
    this.pod = normalizePod(conn.pod);
    this.username = conn.username;
    this.password = conn.password;
    this.reportPath = conn.reportPath || DEFAULT_REPORT_PATH;
  }

  get authHeader() {
    return basicAuthHeader(this.username, this.password);
  }

  async _fetch(url, options = {}, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Allow an external signal (user cancel) to also abort.
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new FusionError('Request cancelled or timed out.', { detail: url });
      }
      throw new FusionError(`Network error contacting Fusion pod: ${err.message}`, { detail: url });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify credentials and pod reachability by hitting the BI Publisher
   * server info endpoint. Returns { ok, version, serverTime }.
   */
  async testConnection(signal) {
    const url = `${this.pod}/xmlpserver/services/rest/v1/system/version`;
    const res = await this._fetch(
      url,
      { method: 'GET', headers: { Authorization: this.authHeader, Accept: 'application/json' } },
      signal
    );
    if (res.status === 401 || res.status === 403) {
      throw new FusionError('Authentication failed. Check the username and password.', {
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new FusionError(`Unexpected response from pod (HTTP ${res.status}).`, {
        status: res.status,
      });
    }
    let version = 'unknown';
    try {
      const body = await res.json();
      version = body.version || body.productVersion || 'unknown';
    } catch {
      /* version endpoint may return plain text on some pods */
    }
    return { ok: true, version, pod: this.pod };
  }

  /**
   * Run a SQL statement and return { columns, rows, rowCount, truncated, elapsedMs }.
   *
   * @param {string} sql
   * @param {object} [opts]
   * @param {number} [opts.maxRows]   Hard cap enforced client-side after fetch.
   * @param {AbortSignal} [opts.signal]
   */
  async runQuery(sql, opts = {}) {
    const started = Date.now();
    const cleaned = stripTrailingSemicolon(sql);
    const csv = await this._runReportCsv(cleaned, opts.signal);
    let { columns, rows } = parseCsv(csv);
    let truncated = false;
    if (opts.maxRows && rows.length > opts.maxRows) {
      rows = rows.slice(0, opts.maxRows);
      truncated = true;
    }
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - started,
      sql: cleaned,
    };
  }

  async _runReportCsv(sql, signal) {
    // Try REST v2 first (multipart), fall back to v1 (JSON) for older pods.
    try {
      return await this._runV2(sql, signal);
    } catch (err) {
      if (err instanceof FusionError && err.status && err.status !== 404) throw err;
      return await this._runV1(sql, signal);
    }
  }

  async _runV2(sql, signal) {
    const path = encodeReportPath(this.reportPath);
    const url = `${this.pod}/xmlpserver/services/rest/v2/reports/${path}/run`;
    const meta = {
      byPassCache: true,
      flattenXML: false,
      sizeOfDataChunkDownload: -1, // -1 => full dataset, no chunking.
      template: 'CSV',
      attributeFormat: 'csv',
      parameterValues: { p_sql: [sql] },
    };
    const boundary = `----CloudConnect${Date.now().toString(16)}`;
    const body = buildMultipart(boundary, meta);
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          Accept: '*/*',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      signal
    );
    if (res.status === 404) throw new FusionError('Report not found (v2).', { status: 404 });
    if (!res.ok) throw await httpError(res, 'Query execution failed (REST v2)');
    return await res.text();
  }

  async _runV1(sql, signal) {
    const path = encodeReportPath(this.reportPath);
    const url = `${this.pod}/xmlpserver/services/rest/v1/reports/${path}/run`;
    const payload = {
      reportRequest: {
        attributeFormat: 'csv',
        attributeTemplate: 'CSV',
        sizeOfDataChunkDownload: -1,
        byPassCache: true,
        flattenXML: false,
        parameterNameValues: {
          listOfParamNameValues: [
            { item: [{ name: 'p_sql', values: { item: [sql] } }] },
          ],
        },
      },
    };
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      signal
    );
    if (res.status === 404) {
      throw new FusionError(
        'SQL Runner report not found on the pod. Deploy it first (Account → Deploy SQL Runner).',
        { status: 404 }
      );
    }
    if (!res.ok) throw await httpError(res, 'Query execution failed (REST v1)');
    const json = await res.json();
    const b64 = json.reportBytes;
    if (!b64) throw new FusionError('Fusion returned no report data.', { detail: JSON.stringify(json).slice(0, 400) });
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  /**
   * Deploy the generic SQL Runner report to the pod's catalog using the BI
   * Publisher SOAP CatalogService uploadObject operation. Idempotent: an
   * existing object at the path is overwritten.
   */
  async deploySqlRunner(signal) {
    const { folderPath, dataModel, report } = await buildReportArchive(this.reportPath);
    // Upload data model first, then the report that references it.
    await this._uploadObject(`${folderPath}/SQLRunner.xdm`, 'xdmz', dataModel, signal);
    await this._uploadObject(`${folderPath}/SQLRunner.xdo`, 'xdrz', report, signal);
    return { ok: true, reportPath: this.reportPath };
  }

  async _uploadObject(absPath, objectType, base64Zip, signal) {
    const url = `${this.pod}/xmlpserver/services/v2/CatalogService`;
    const envelope = soapUploadEnvelope({
      username: this.username,
      password: this.password,
      objectAbsolutePathURL: absPath,
      objectType,
      objectDataInBytes: base64Zip,
    });
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: 'uploadObject',
        },
        body: envelope,
      },
      signal
    );
    const text = await res.text();
    if (!res.ok || /<(?:\w+:)?Fault>/.test(text)) {
      const fault = extractSoapFault(text);
      throw new FusionError(`Failed to deploy '${absPath}': ${fault || `HTTP ${res.status}`}`, {
        status: res.status,
        detail: text.slice(0, 600),
      });
    }
    return true;
  }
}

function stripTrailingSemicolon(sql) {
  return String(sql || '').trim().replace(/;+\s*$/, '');
}

function encodeReportPath(path) {
  // BIP wants the path with slashes preserved but each segment URL-encoded,
  // and the .xdo suffix dropped for the REST resource id.
  return path
    .replace(/\.xdo$/i, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('%2F');
}

function buildMultipart(boundary, metaObject) {
  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push('Content-Disposition: form-data; name="ReportRequest"\r\n');
  parts.push('Content-Type: application/json\r\n\r\n');
  parts.push(`${JSON.stringify(metaObject)}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

async function httpError(res, prefix) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  const hint = extractSoapFault(detail) || detail.slice(0, 300);
  return new FusionError(`${prefix} (HTTP ${res.status}). ${hint}`.trim(), {
    status: res.status,
    detail,
  });
}

function extractSoapFault(xml) {
  if (!xml) return '';
  const m = xml.match(/<(?:\w+:)?faultstring>([\s\S]*?)<\/(?:\w+:)?faultstring>/i);
  return m ? decodeXml(m[1]).trim() : '';
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function soapUploadEnvelope({ objectAbsolutePathURL, objectType, objectDataInBytes }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:pub="http://xmlns.oracle.com/oxp/service/v2">
  <soap:Body>
    <pub:uploadObject>
      <pub:objectAbsolutePathURL>${escapeXml(objectAbsolutePathURL)}</pub:objectAbsolutePathURL>
      <pub:objectType>${escapeXml(objectType)}</pub:objectType>
      <pub:objectData>${objectDataInBytes}</pub:objectData>
    </pub:uploadObject>
  </soap:Body>
</soap:Envelope>`;
}

module.exports = {
  FusionClient,
  FusionError,
  normalizePod,
  DEFAULT_REPORT_PATH,
  _internals: { encodeReportPath, buildMultipart, extractSoapFault, stripTrailingSemicolon },
};

// XMLParser is retained for callers that request XML output instead of CSV.
module.exports._XMLParser = XMLParser;
