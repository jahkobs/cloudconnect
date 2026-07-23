'use strict';

/**
 * Demo provider. When a connection is marked `demo: true`, queries are answered
 * from an in-memory synthetic Oracle Fusion schema instead of a live pod. This
 * lets the application be explored, screenshotted, and tested end-to-end with
 * no credentials. The generated data mimics common Fusion HCM/Financials tables
 * (PER_ALL_PEOPLE_F, AP_INVOICES_ALL, GL_JE_HEADERS, ...).
 */

const SCHEMA = {
  FUSION: {
    PER_ALL_PEOPLE_F: {
      cols: ['PERSON_ID', 'PERSON_NUMBER', 'FULL_NAME', 'EMAIL_ADDRESS', 'EFFECTIVE_START_DATE'],
      types: ['NUMBER', 'VARCHAR2', 'VARCHAR2', 'VARCHAR2', 'DATE'],
    },
    AP_INVOICES_ALL: {
      cols: ['INVOICE_ID', 'INVOICE_NUM', 'VENDOR_ID', 'INVOICE_AMOUNT', 'INVOICE_CURRENCY_CODE', 'INVOICE_DATE'],
      types: ['NUMBER', 'VARCHAR2', 'NUMBER', 'NUMBER', 'VARCHAR2', 'DATE'],
    },
    GL_JE_HEADERS: {
      cols: ['JE_HEADER_ID', 'NAME', 'LEDGER_ID', 'PERIOD_NAME', 'STATUS', 'RUNNING_TOTAL_DR'],
      types: ['NUMBER', 'VARCHAR2', 'NUMBER', 'VARCHAR2', 'VARCHAR2', 'NUMBER'],
    },
    HZ_PARTIES: {
      cols: ['PARTY_ID', 'PARTY_NAME', 'PARTY_TYPE', 'COUNTRY', 'STATUS'],
      types: ['NUMBER', 'VARCHAR2', 'VARCHAR2', 'VARCHAR2', 'VARCHAR2'],
    },
    POZ_SUPPLIERS: {
      cols: ['SUPPLIER_ID', 'SUPPLIER_NAME', 'SEGMENT1', 'VENDOR_TYPE_LOOKUP_CODE', 'ENABLED_FLAG'],
      types: ['NUMBER', 'VARCHAR2', 'VARCHAR2', 'VARCHAR2', 'VARCHAR2'],
    },
  },
};

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mia', 'Lucas', 'Ethan', 'Sofia', 'Aria'];
const LAST = ['Smith', 'Johnson', 'Patel', 'Garcia', 'Chen', 'Kumar', 'Nguyen', 'Brown', 'Rossi', 'Kim'];
const CURR = ['USD', 'EUR', 'GBP', 'INR', 'JPY'];
const STATUS = ['A', 'P', 'C', 'R'];

function seeded(n) {
  let x = (n * 2654435761) % 2147483647;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

function genTableRows(name, def, limit) {
  const rows = [];
  const rand = seeded(name.length * 31 + def.cols.length);
  for (let i = 0; i < limit; i++) {
    const r = def.cols.map((c, ci) => {
      const t = def.types[ci];
      if (/PERSON_ID|_ID$|LEDGER_ID/.test(c)) return String(100000 + i);
      if (c === 'PERSON_NUMBER' || c === 'SEGMENT1') return String(6000 + i);
      if (c === 'FULL_NAME' || c === 'PARTY_NAME' || c === 'SUPPLIER_NAME' || c === 'NAME')
        return `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
      if (c === 'EMAIL_ADDRESS')
        return `${FIRST[i % FIRST.length].toLowerCase()}.${LAST[(i * 3) % LAST.length].toLowerCase()}@example.com`;
      if (c === 'INVOICE_NUM') return `INV-${2024000 + i}`;
      if (c === 'INVOICE_CURRENCY_CODE') return CURR[i % CURR.length];
      if (/AMOUNT|TOTAL/.test(c)) return (Math.floor(rand() * 1000000) / 100).toFixed(2);
      if (c === 'STATUS' || /FLAG$/.test(c)) return STATUS[i % STATUS.length];
      if (c === 'PARTY_TYPE') return i % 2 ? 'ORGANIZATION' : 'PERSON';
      if (c === 'VENDOR_TYPE_LOOKUP_CODE') return i % 2 ? 'SUPPLIER' : 'EMPLOYEE';
      if (c === 'COUNTRY') return ['US', 'GB', 'IN', 'DE', 'JP'][i % 5];
      if (c === 'PERIOD_NAME') return `${['JAN', 'FEB', 'MAR', 'APR'][i % 4]}-24`;
      if (/DATE/.test(t)) {
        const d = new Date(2024, i % 12, (i % 27) + 1);
        return d.toISOString().slice(0, 10);
      }
      return `val_${i}`;
    });
    rows.push(r);
  }
  return rows;
}

function runDemo(sql, maxRows = 100) {
  const q = String(sql || '').trim();
  const upper = q.toUpperCase();

  // Data-dictionary: table listing.
  if (/FROM\s+ALL_TABLES|FROM\s+ALL_VIEWS/.test(upper)) {
    const columns = ['OWNER', 'TABLE_NAME', 'OBJECT_TYPE'];
    const rows = [];
    for (const [owner, tables] of Object.entries(SCHEMA)) {
      for (const t of Object.keys(tables)) rows.push([owner, t, 'TABLE']);
    }
    return finalize(columns, rows, maxRows);
  }
  // Data-dictionary: column listing.
  if (/FROM\s+ALL_TAB_COLUMNS/.test(upper)) {
    const m = upper.match(/TABLE_NAME\s*=\s*'([^']+)'/);
    const ownerM = upper.match(/OWNER\s*=\s*'([^']+)'/);
    const owner = ownerM ? ownerM[1] : 'FUSION';
    const table = m ? m[1] : null;
    const def = SCHEMA[owner] && table ? SCHEMA[owner][table] : null;
    const columns = ['COLUMN_ID', 'COLUMN_NAME', 'DATA_TYPE', 'DATA_LENGTH', 'NULLABLE'];
    const rows = def
      ? def.cols.map((c, i) => [String(i + 1), c, def.types[i], def.types[i] === 'NUMBER' ? '22' : '255', i === 0 ? 'N' : 'Y'])
      : [];
    return finalize(columns, rows, maxRows);
  }
  // SELECT * FROM owner.table
  const tblM = upper.match(/FROM\s+([A-Z0-9_$#]+)\.([A-Z0-9_$#]+)/);
  const tblM2 = tblM || upper.match(/FROM\s+([A-Z0-9_$#]+)/);
  if (tblM2) {
    const owner = tblM ? tblM[1] : 'FUSION';
    const table = tblM ? tblM[2] : tblM2[1];
    const def = SCHEMA[owner] && SCHEMA[owner][table];
    if (def) {
      // Simulate a table larger than the row limit so truncation behaves
      // realistically: generate a pool, then let finalize() apply maxRows.
      const pool = Math.min(5000, Math.max(500, (maxRows || 100) * 2));
      const rows = genTableRows(table, def, pool);
      return finalize(def.cols, rows, maxRows);
    }
  }
  // dual / literal selects
  if (/FROM\s+DUAL/.test(upper) || /^SELECT\s+\d/.test(upper)) {
    return finalize(['RESULT'], [['1']], maxRows);
  }
  // Fallback: echo a small informational rowset.
  return finalize(
    ['MESSAGE'],
    [['Demo mode: table not in synthetic schema. Try PER_ALL_PEOPLE_F, AP_INVOICES_ALL, GL_JE_HEADERS.']],
    maxRows
  );
}

function finalize(columns, rows, maxRows) {
  let truncated = false;
  let out = rows;
  if (maxRows && rows.length > maxRows) {
    out = rows.slice(0, maxRows);
    truncated = true;
  }
  return { columns, rows: out, rowCount: out.length, truncated, elapsedMs: 40 + Math.floor(Math.random() * 120) };
}

module.exports = { runDemo, SCHEMA };
