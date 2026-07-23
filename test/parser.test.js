'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, parseCsvRecords, parseXmlRowset } = require('../electron/fusion/parser');

test('parseCsv: basic header + rows', () => {
  const { columns, rows } = parseCsv('A,B,C\r\n1,2,3\r\n4,5,6\r\n');
  assert.deepStrictEqual(columns, ['A', 'B', 'C']);
  assert.deepStrictEqual(rows, [
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
});

test('parseCsv: quoted fields with commas, quotes and newlines', () => {
  const csv = 'NAME,NOTE\r\n"Doe, John","He said ""hi""\nnext line"\r\n';
  const { columns, rows } = parseCsv(csv);
  assert.deepStrictEqual(columns, ['NAME', 'NOTE']);
  assert.strictEqual(rows[0][0], 'Doe, John');
  assert.strictEqual(rows[0][1], 'He said "hi"\nnext line');
});

test('parseCsv: empty trailing fields become empty strings, missing become null', () => {
  const { rows } = parseCsv('A,B,C\n1,,\n2');
  assert.deepStrictEqual(rows[0], ['1', '', '']);
  assert.deepStrictEqual(rows[1], ['2', null, null]);
});

test('parseCsv: handles LF-only line endings', () => {
  const { columns, rows } = parseCsv('X\n10\n20');
  assert.deepStrictEqual(columns, ['X']);
  assert.deepStrictEqual(rows, [['10'], ['20']]);
});

test('parseCsvRecords: no trailing newline still flushes last record', () => {
  const recs = parseCsvRecords('a,b\n1,2');
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(recs[1], ['1', '2']);
});

test('parseCsv: empty input yields empty result', () => {
  const { columns, rows } = parseCsv('');
  assert.deepStrictEqual(columns, []);
  assert.deepStrictEqual(rows, []);
});

test('parseXmlRowset: BIP DATA_DS rowset', () => {
  const xml =
    '<?xml version="1.0"?><DATA_DS><G_1><NAME>Ann</NAME><ID>1</ID></G_1>' +
    '<G_1><NAME>Bob</NAME><ID>2</ID></G_1></DATA_DS>';
  const { columns, rows } = parseXmlRowset(xml);
  assert.ok(columns.includes('NAME'));
  assert.ok(columns.includes('ID'));
  assert.strictEqual(rows.length, 2);
});
