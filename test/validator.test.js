'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateReadOnly, detectBindParams } = require('../electron/core/sql-validator');

test('allows a simple SELECT', () => {
  const r = validateReadOnly('SELECT * FROM per_all_people_f');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.statementType, 'SELECT');
});

test('allows WITH ... SELECT (CTE)', () => {
  const r = validateReadOnly('WITH x AS (SELECT 1 c FROM dual) SELECT c FROM x');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.statementType, 'WITH');
});

test('blocks INSERT / UPDATE / DELETE / DDL', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a=1',
    'DELETE FROM t',
    'DROP TABLE t',
    'ALTER TABLE t ADD c NUMBER',
    'TRUNCATE TABLE t',
    'MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a=1',
    'GRANT SELECT ON t TO u',
  ]) {
    assert.strictEqual(validateReadOnly(sql).valid, false, `should block: ${sql}`);
  }
});

test('blocks PL/SQL anonymous blocks', () => {
  assert.strictEqual(validateReadOnly('BEGIN NULL; END;').valid, false);
  assert.strictEqual(validateReadOnly('DECLARE x NUMBER; BEGIN NULL; END;').valid, false);
});

test('blocks stacked statements', () => {
  assert.strictEqual(validateReadOnly('SELECT 1 FROM dual; DELETE FROM t').valid, false);
});

test('tolerates a single trailing semicolon', () => {
  assert.strictEqual(validateReadOnly('SELECT 1 FROM dual;').valid, true);
});

test('blocks database links', () => {
  assert.strictEqual(validateReadOnly('SELECT * FROM t@remote').valid, false);
});

test('is not fooled by keywords inside string literals', () => {
  const r = validateReadOnly("SELECT 'DROP TABLE users' AS note FROM dual");
  assert.strictEqual(r.valid, true);
});

test('is not fooled by keywords inside comments', () => {
  const r = validateReadOnly('SELECT 1 FROM dual -- delete update drop');
  assert.strictEqual(r.valid, true);
});

test('detects distinct bind parameters', () => {
  const params = detectBindParams(
    'SELECT * FROM t WHERE bu = :P_BUSINESS_UNIT AND d BETWEEN :P_START_DATE AND :P_END_DATE AND bu = :P_BUSINESS_UNIT'
  );
  assert.deepStrictEqual(params, [':P_BUSINESS_UNIT', ':P_START_DATE', ':P_END_DATE']);
});

test('rejects empty statement', () => {
  assert.strictEqual(validateReadOnly('   ').valid, false);
});
