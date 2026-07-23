'use strict';

/**
 * postinstall: copy the Monaco editor AMD distribution from node_modules into
 * renderer/vendor/monaco so the packaged app can load it from a local, relative
 * path with no network access. No-ops cleanly if Monaco isn't installed yet.
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(__dirname, '..', 'renderer', 'vendor', 'monaco', 'vs');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

try {
  if (!fs.existsSync(src)) {
    console.log('[fetch-monaco] monaco-editor not found; skipping (run npm install first).');
    process.exit(0);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(src, dest);
  console.log('[fetch-monaco] Monaco copied to renderer/vendor/monaco/vs');
} catch (err) {
  console.error('[fetch-monaco] failed:', err.message);
  // Don't fail install; the app degrades to a plain textarea editor.
  process.exit(0);
}
