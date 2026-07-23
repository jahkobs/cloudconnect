'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { AuditLog } = require('../electron/core/audit');
const { AiAssistant } = require('../electron/core/ai');

function fakeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqs-'));
  return { getPath: () => dir, _dir: dir };
}

test('audit chain is tamper-evident', () => {
  const app = fakeApp();
  const audit = new AuditLog(app);
  audit.record('user.login', { a: 1 });
  audit.record('query.execute', { rowCount: 5 });
  audit.record('result.export', { format: 'csv' });
  assert.strictEqual(audit.verifyChain().ok, true);

  // Tamper with the middle record on disk.
  const file = path.join(app._dir, 'audit.log.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.detail.rowCount = 999;
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const audit2 = new AuditLog(app);
  assert.strictEqual(audit2.verifyChain().ok, false);
});

test('audit redacts sensitive fields', () => {
  const app = fakeApp();
  const audit = new AuditLog(app);
  const rec = audit.record('connection.create', { username: 'u', password: 'topsecret', token: 'abc' });
  assert.strictEqual(rec.detail.password, '***redacted***');
  assert.strictEqual(rec.detail.token, '***redacted***');
  assert.strictEqual(rec.detail.username, 'u');
});

test('AI assistant returns a read-only draft and never auto-runs', async () => {
  const ai = new AiAssistant();
  const schema = [
    { owner: 'FUSION', table: 'PER_ALL_PEOPLE_F', columns: [{ name: 'PERSON_ID' }, { name: 'FULL_NAME' }, { name: 'EFFECTIVE_START_DATE' }] },
    { owner: 'FUSION', table: 'AP_INVOICES_ALL', columns: [{ name: 'INVOICE_ID' }, { name: 'INVOICE_NUM' }] },
  ];
  const r = await ai.generate('show active employees and their full name', { schema });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.autoRun, false);
  assert.match(r.sql.toUpperCase(), /SELECT/);
  assert.match(r.sql.toUpperCase(), /PER_ALL_PEOPLE_F/);
});

test('AI assistant errors on empty prompt', async () => {
  const ai = new AiAssistant();
  const r = await ai.generate('   ', { schema: [] });
  assert.strictEqual(r.ok, false);
});
