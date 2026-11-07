'use strict';
/**
 * Lädt Cover und PDFs in das KV-Namespace ASSETS.
 * Dateien liegen in worker/assets/ und werden nicht ins Git übernommen.
 * Aufruf aus worker/: node admin-scripts/upload-assets.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const items = [
  { file: 'val3ntino-krypto-einsteiger-2026-cover.png', key: 'cover:krypto' },
  { file: 'val3ntino-krypto-einsteiger-2026.pdf', key: 'pdf:krypto' },
  { file: 'val3ntino-discord-server-playbook-cover.png', key: 'cover:discord' },
  { file: 'val3ntino-discord-server-playbook.pdf', key: 'pdf:discord' },
  { file: 'val3ntino-digitale-produkte-business-guide-cover.png', key: 'cover:business' },
  { file: 'val3ntino-digitale-produkte-business-guide.pdf', key: 'pdf:business' },
];

let failed = false;
for (const item of items) {
  const filePath = path.join(assetsDir, item.file);
  if (!fs.existsSync(filePath)) {
    console.error('Fehlt:', filePath);
    failed = true;
  }
}
if (failed) {
  console.error('Lege die sechs Dateien nach worker/assets/ und starte das Skript erneut.');
  process.exit(1);
}

const workerDir = path.join(__dirname, '..');
for (const item of items) {
  const filePath = path.join(assetsDir, item.file);
  const kb = Math.round(fs.statSync(filePath).size / 1024);
  console.log('Lade hoch: ' + item.file + ' (' + kb + ' KB) → ' + item.key);
  execFileSync('npx', ['wrangler', 'kv', 'key', 'put', item.key, '--path', filePath, '--binding', 'ASSETS'], {
    cwd: workerDir,
    stdio: 'inherit',
  });
  console.log('Fertig: ' + item.key);
}
console.log('Alle sechs Dateien sind im KV-Namespace ASSETS.');
