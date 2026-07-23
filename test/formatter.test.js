'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { format } = require('../renderer/formatter');

test('format: uppercases keywords and breaks major clauses', () => {
  const out = format('select a, b from t where a=1 and b=2 order by a');
  assert.match(out, /^SELECT/);
  assert.match(out, /\nFROM t/);
  assert.match(out, /\nWHERE/);
  assert.match(out, /\n\s+AND/);
  assert.match(out, /\nORDER BY/);
});

test('format: does not mangle string literals', () => {
  const out = format("select 'from where select' as x from dual");
  assert.match(out, /'from where select'/);
});

test('format: preserves line comments', () => {
  const out = format('-- hello\nselect 1 from dual');
  assert.match(out, /-- hello/);
});

test('format: merges GROUP BY / ORDER BY / LEFT JOIN', () => {
  const out = format('select a from x left join y on x.id=y.id group by a order by a');
  assert.match(out, /LEFT JOIN/);
  assert.match(out, /GROUP BY/);
  assert.match(out, /ORDER BY/);
});

test('format: empty input returns input', () => {
  assert.strictEqual(format(''), '');
  assert.strictEqual(format('   '), '   ');
});
