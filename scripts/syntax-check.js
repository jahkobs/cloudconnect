'use strict';

/**
 * Lightweight syntax check: node --check every .js file under electron/ and
 * scripts/, and the browser renderer scripts (parsed as scripts). Fails fast
 * with a non-zero exit code so it can gate CI.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['electron', 'scripts', 'test'];
const rendererFiles = ['renderer/app.js', 'renderer/formatter.js', 'renderer/grid.js', 'renderer/editor-boot.js'];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
}

const files = [];
for (const r of roots) walk(r, files);
for (const f of rendererFiles) if (fs.existsSync(f)) files.push(f);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${f}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check.`);
  process.exit(1);
}
console.log(`✓ ${files.length} files passed syntax check.`);
