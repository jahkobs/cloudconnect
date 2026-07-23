'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizePod, _internals } = require('../electron/fusion/client');
const { buildReportArchive, dataModelXml } = require('../electron/fusion/report');
const { runDemo } = require('../electron/fusion/demo');

test('normalizePod: adds https and strips trailing slash', () => {
  assert.strictEqual(normalizePod('example.oraclecloud.com/'), 'https://example.oraclecloud.com');
  assert.strictEqual(normalizePod('https://x.com//'), 'https://x.com');
});

test('normalizePod: throws without url', () => {
  assert.throws(() => normalizePod(''));
});

test('encodeReportPath: encodes segments and drops .xdo', () => {
  const enc = _internals.encodeReportPath('/Custom/CloudConnect/SQLRunner.xdo');
  assert.strictEqual(enc, 'Custom%2FCloudConnect%2FSQLRunner');
});

test('stripTrailingSemicolon', () => {
  assert.strictEqual(_internals.stripTrailingSemicolon('select 1 from dual;  '), 'select 1 from dual');
});

test('extractSoapFault: pulls faultstring', () => {
  const xml = '<soap:Fault><faultstring>Access denied</faultstring></soap:Fault>';
  assert.strictEqual(_internals.extractSoapFault(xml), 'Access denied');
});

test('dataModelXml: contains lexical p_sql parameter and CDATA reference', () => {
  const xml = dataModelXml('ApplicationDB_FSCM');
  assert.match(xml, /name="p_sql"/);
  assert.match(xml, /<!\[CDATA\[&p_sql\]\]>/);
  assert.match(xml, /ApplicationDB_FSCM/);
});

test('buildReportArchive: produces base64 zips and folder split', async () => {
  const a = await buildReportArchive('/Custom/CloudConnect/SQLRunner.xdo');
  assert.strictEqual(a.folderPath, '/Custom/CloudConnect');
  assert.strictEqual(a.name, 'SQLRunner');
  assert.match(a.dataModel, /^[A-Za-z0-9+/=]+$/);
  assert.match(a.report, /^[A-Za-z0-9+/=]+$/);
  // base64 decodes to a PK zip header
  assert.strictEqual(Buffer.from(a.dataModel, 'base64').slice(0, 2).toString(), 'PK');
});

test('runDemo: table listing returns owner/table columns', () => {
  const r = runDemo('SELECT owner, table_name FROM all_tables', 500);
  assert.deepStrictEqual(r.columns, ['OWNER', 'TABLE_NAME', 'OBJECT_TYPE']);
  assert.ok(r.rows.length > 0);
});

test('runDemo: select from known table returns rows and respects maxRows', () => {
  const r = runDemo('SELECT * FROM FUSION.PER_ALL_PEOPLE_F', 5);
  assert.ok(r.columns.includes('PERSON_NUMBER'));
  assert.strictEqual(r.rows.length, 5);
  assert.strictEqual(r.truncated, true);
});

test('runDemo: column listing for a table', () => {
  const r = runDemo("SELECT column_name FROM all_tab_columns WHERE owner='FUSION' AND table_name='AP_INVOICES_ALL'", 100);
  assert.ok(r.rows.some((row) => row[1] === 'INVOICE_NUM'));
});
