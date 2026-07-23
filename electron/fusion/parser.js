'use strict';

/**
 * Result parsing for BI Publisher output.
 *
 * The SQL Runner report emits CSV (fast, compact) by default. This module
 * parses RFC-4180-style CSV (quoted fields, escaped quotes, embedded newlines)
 * without pulling in a heavy dependency, and also offers an XML parser for the
 * rowset shape BI Publisher produces when CSV is unavailable.
 */

const { XMLParser } = require('fast-xml-parser');

/**
 * Parse RFC-4180 CSV text into { columns, rows }.
 * The first record is treated as the header row.
 * Rows are arrays of string|null values aligned to columns.
 */
function parseCsv(text) {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0].map((c) => (c == null ? '' : String(c)));
  const rows = records.slice(1).map((rec) => {
    const row = new Array(columns.length).fill(null);
    for (let i = 0; i < columns.length; i++) {
      const v = rec[i];
      row[i] = v === undefined ? null : v;
    }
    return row;
  });
  return { columns, rows };
}

function parseCsvRecords(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawAny = false;
  const s = String(text || '');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      sawAny = true;
    } else if (ch === '\r') {
      // handled by \n branch; swallow lone CR
      if (s[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      sawAny = false;
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  // Flush the final field/record if the file didn't end with a newline.
  if (sawAny || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop a trailing fully-empty record (common when file ends in newline).
  if (records.length && records[records.length - 1].every((c) => c === '')) {
    records.pop();
  }
  return records;
}

/**
 * Parse BI Publisher XML rowset output into { columns, rows }.
 * Expected shape (namespaces stripped):
 *   <DATA_DS><G_1><COL1>..</COL1><COL2>..</COL2></G_1>...</DATA_DS>
 */
function parseXmlRowset(xml) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
  });
  const doc = parser.parse(xml);
  const root = firstObject(doc);
  if (!root) return { columns: [], rows: [] };
  const groupName = Object.keys(root).find((k) => Array.isArray(root[k]) || isRowLike(root[k]));
  if (!groupName) return { columns: [], rows: [] };
  let groups = root[groupName];
  if (!Array.isArray(groups)) groups = [groups];

  const colSet = [];
  const seen = new Set();
  for (const g of groups) {
    for (const k of Object.keys(g || {})) {
      if (!seen.has(k)) {
        seen.add(k);
        colSet.push(k);
      }
    }
  }
  const rows = groups.map((g) =>
    colSet.map((c) => {
      const v = g == null ? null : g[c];
      if (v === undefined || v === null) return null;
      return typeof v === 'object' ? '' : String(v);
    })
  );
  return { columns: colSet, rows };
}

function firstObject(doc) {
  for (const k of Object.keys(doc || {})) {
    if (k.startsWith('?')) continue;
    if (doc[k] && typeof doc[k] === 'object') return doc[k];
  }
  return null;
}

function isRowLike(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { parseCsv, parseCsvRecords, parseXmlRowset };
