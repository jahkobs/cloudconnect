'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../electron/fusion/client');
const { parseCsv, parseXmlRowset } = require('../electron/fusion/parser');

test('looksLikeXml detects XML vs CSV', () => {
  assert.strictEqual(_internals.looksLikeXml('<?xml version="1.0"?><DATA_DS/>'), true);
  assert.strictEqual(_internals.looksLikeXml('<DATA_DS><G_1><A>1</A></G_1></DATA_DS>'), true);
  assert.strictEqual(_internals.looksLikeXml('A,B\n1,2'), false);
  assert.strictEqual(_internals.looksLikeXml('   '), false);
});

test('soapRunReportEnvelope embeds report path and escaped SQL', () => {
  const env = _internals.soapRunReportEnvelope({ reportPath: '/Custom/FusionQueryStudio/SQLRunner.xdo', sql: "SELECT 1 FROM dual WHERE x < 2 AND y = 'a'" });
  assert.match(env, /<pub:runReport>/);
  assert.match(env, /reportAbsolutePath>\/Custom\/FusionQueryStudio\/SQLRunner\.xdo</);
  assert.match(env, /&lt;/); // '<' escaped
  assert.match(env, /&apos;/); // quote escaped
  assert.match(env, /<pub:name>p_sql<\/pub:name>/);
});

test('result parsing: CSV path', () => {
  const { columns, rows } = parseCsv('PERSON_NUMBER,FULL_NAME\r\n6455,Ava Smith\r\n');
  assert.deepStrictEqual(columns, ['PERSON_NUMBER', 'FULL_NAME']);
  assert.deepStrictEqual(rows[0], ['6455', 'Ava Smith']);
});

test('result parsing: XML rowset path (BIP DATA_DS)', () => {
  const xml = '<DATA_DS><G_1><PERSON_NUMBER>6455</PERSON_NUMBER><FULL_NAME>Ava</FULL_NAME></G_1></DATA_DS>';
  const { columns, rows } = parseXmlRowset(xml);
  assert.ok(columns.includes('PERSON_NUMBER'));
  assert.strictEqual(rows[0][columns.indexOf('FULL_NAME')], 'Ava');
});
