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
const { parseCsv, parseXmlRowset } = require('./parser');
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
   * Verify credentials and pod reachability.
   *
   * Primary probe is the BI Publisher server-version endpoint. Some pods return
   * 500/404 there even when BI Publisher is reachable and the credentials are
   * valid, so on a non-auth failure we fall back to probing the BI Publisher
   * home path to distinguish "pod reachable, keep going" from "pod unreachable"
   * and surface the server's own response text to aid diagnosis.
   */
  async testConnection(signal) {
    const versionUrl = `${this.pod}/xmlpserver/services/rest/v1/system/version`;
    let res;
    try {
      res = await this._fetch(
        versionUrl,
        { method: 'GET', headers: { Authorization: this.authHeader, Accept: 'application/json' } },
        signal
      );
    } catch (err) {
      throw new FusionError(
        `Could not reach the pod. Check the Pod URL (expected https://<host>.fa.<dc>.oraclecloud.com). ${err.message}`,
        { detail: versionUrl }
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new FusionError(
        'Authentication failed (HTTP ' +
          res.status +
          '). Check the username and password, and that the user holds the BI Publisher roles (BIConsumer/BIAuthor).',
        { status: res.status }
      );
    }

    if (res.ok) {
      let version = 'unknown';
      try {
        const body = await res.json();
        version = body.version || body.productVersion || 'unknown';
      } catch {
        /* version endpoint may return plain text on some pods */
      }
      return { ok: true, version, pod: this.pod };
    }

    // Non-auth error on the version endpoint: fall back to a reachability probe.
    const bodySnippet = (await safeText(res)).slice(0, 240);
    const reachable = await this._probeReachable(signal);
    if (reachable) {
      // BI Publisher answered elsewhere — credentials likely OK, this endpoint
      // is just unavailable. Let the user proceed (queries use a different API).
      return {
        ok: true,
        version: 'unknown',
        pod: this.pod,
        warning:
          `The version endpoint returned HTTP ${res.status}, but BI Publisher is reachable. ` +
          'Credentials appear accepted — deploy the SQL Runner report (if not done) and try a query.',
      };
    }

    throw new FusionError(
      `Unexpected response from pod (HTTP ${res.status}). ` +
        'Verify the Pod URL is the base Fusion host with no extra path, that BI Publisher ' +
        '(/xmlpserver) is enabled, and that the pod is reachable from your network' +
        (bodySnippet ? `. Server said: ${bodySnippet}` : '.'),
      { status: res.status, detail: bodySnippet }
    );
  }

  /**
   * Lightweight reachability check for the embedded BI Publisher app. Any
   * HTTP answer (200/302/401/403) means the host and /xmlpserver path respond.
   */
  async _probeReachable(signal) {
    try {
      const res = await this._fetch(
        `${this.pod}/xmlpserver/servlet/home`,
        { method: 'GET', headers: { Authorization: this.authHeader, Accept: '*/*' }, redirect: 'manual' },
        signal
      );
      return res.status > 0 && res.status < 500;
    } catch {
      return false;
    }
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
    const text = await this._runReport(cleaned, opts.signal);

    // BI Publisher may return CSV or an XML rowset depending on how the report
    // template resolves on a given pod — detect and parse whichever came back.
    let parsed;
    if (looksLikeXml(text)) parsed = parseXmlRowset(text);
    else parsed = parseCsv(text);
    let { columns, rows } = parsed;

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

  /**
   * Run the SQL Runner report and return its decoded text output. Tries the
   * transports most-to-least modern, so a pod that has any one of them enabled
   * will work: REST v2 → REST v1 → SOAP ExternalReportWSSService (the protected
   * service Oracle recommends for synchronous report calls). The first
   * transport that returns data wins; a 404 (report missing) short-circuits with
   * a clear message rather than trying every transport.
   */
  async _runReport(sql, signal) {
    const attempts = [
      ['REST v2', () => this._runV2(sql, signal)],
      ['REST v1', () => this._runV1(sql, signal)],
      ['SOAP', () => this._runSoap(sql, signal)],
    ];
    let notFound = false;
    let lastErr = null;
    for (const [, fn] of attempts) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof FusionError && err.status === 404) notFound = true;
        // Auth failures won't improve on another transport — surface immediately.
        if (err instanceof FusionError && (err.status === 401 || err.status === 403)) throw err;
      }
    }
    if (notFound) {
      throw new FusionError(
        'SQL Runner report not found on the pod. Deploy it first (🩺 Diagnose → Deploy SQL Runner).',
        { status: 404, detail: lastErr && lastErr.detail }
      );
    }
    throw lastErr || new FusionError('Query execution failed on all transports.');
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
   * Run via the SOAP ExternalReportWSSService.runReport operation — the
   * protected synchronous report service Oracle recommends. Works on pods where
   * the BI Publisher REST API is disabled. The report bytes come back
   * base64-encoded inside <reportBytes>.
   */
  async _runSoap(sql, signal) {
    const url = `${this.pod}/xmlpserver/services/ExternalReportWSSService`;
    const envelope = soapRunReportEnvelope({ reportPath: this.reportPath, sql });
    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: 'runReport',
        },
        body: envelope,
      },
      signal
    );
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new FusionError('Authentication failed (SOAP).', { status: res.status });
    if (res.status === 404) throw new FusionError('Report not found (SOAP).', { status: 404 });
    if (!res.ok || /<(?:\w+:)?Fault>/.test(text)) {
      const fault = extractSoapFault(text);
      if (/not found|no such|does not exist/i.test(fault)) throw new FusionError('Report not found (SOAP).', { status: 404, detail: fault });
      throw new FusionError(`Query execution failed (SOAP): ${fault || 'HTTP ' + res.status}`, { status: res.status, detail: text.slice(0, 500) });
    }
    const m = text.match(/<(?:\w+:)?reportBytes>([\s\S]*?)<\/(?:\w+:)?reportBytes>/i);
    if (!m) throw new FusionError('SOAP response contained no reportBytes.', { detail: text.slice(0, 400) });
    return Buffer.from(m[1].trim(), 'base64').toString('utf8');
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

function looksLikeXml(text) {
  const t = String(text || '').trimStart();
  return t.startsWith('<?xml') || (t.startsWith('<') && /<\/?\w/.test(t.slice(0, 200)));
}

function soapRunReportEnvelope({ reportPath, sql }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:pub="http://xmlns.oracle.com/oxp/service/PublicReportService">
  <soap:Body>
    <pub:runReport>
      <pub:reportRequest>
        <pub:attributeFormat>csv</pub:attributeFormat>
        <pub:attributeLocale>en-US</pub:attributeLocale>
        <pub:byPassCache>true</pub:byPassCache>
        <pub:flattenXML>false</pub:flattenXML>
        <pub:reportAbsolutePath>${escapeXml(reportPath)}</pub:reportAbsolutePath>
        <pub:sizeOfDataChunkDownload>-1</pub:sizeOfDataChunkDownload>
        <pub:parameterNameValues>
          <pub:listOfParamNameValues>
            <pub:item>
              <pub:name>p_sql</pub:name>
              <pub:values><pub:item>${escapeXml(sql)}</pub:item></pub:values>
            </pub:item>
          </pub:listOfParamNameValues>
        </pub:parameterNameValues>
      </pub:reportRequest>
    </pub:runReport>
  </soap:Body>
</soap:Envelope>`;
}

async function safeText(res) {
  try {
    return (await res.text()) || '';
  } catch {
    return '';
  }
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
  _internals: { encodeReportPath, buildMultipart, extractSoapFault, stripTrailingSemicolon, looksLikeXml, soapRunReportEnvelope },
};

// XMLParser is retained for callers that request XML output instead of CSV.
module.exports._XMLParser = XMLParser;
