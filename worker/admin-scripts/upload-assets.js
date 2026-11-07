'use strict';
/**
 * Lädt Cover und PDFs in das KV-Namespace ASSETS.
 * Dateien liegen in worker/assets/ und werden nicht ins Git übernommen.
 * Aufruf aus worker/: node admin-scripts/upload-assets.js
 *
 * Wiederholtes Ausführen ist absichtlich erlaubt: `wrangler kv key put`
 * überschreibt denselben Schlüssel, es entsteht kein zweiter Eintrag.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const workerDir = path.join(__dirname, '..');
const assetsDir = path.join(workerDir, 'assets');
// Unter Windows ist npx eine npx.cmd-Datei und lässt sich ohne Shell nicht starten.
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const spawnBase = {
  cwd: workerDir,
  shell: process.platform === 'win32',
  windowsHide: true,
};

const items = [
  { file: 'val3ntino-krypto-einsteiger-2026-cover.png', key: 'cover:krypto' },
  { file: 'val3ntino-krypto-einsteiger-2026.pdf', key: 'pdf:krypto' },
  { file: 'val3ntino-discord-server-playbook-cover.png', key: 'cover:discord' },
  { file: 'val3ntino-discord-server-playbook.pdf', key: 'pdf:discord' },
  { file: 'val3ntino-digitale-produkte-business-guide-cover.png', key: 'cover:business' },
  { file: 'val3ntino-digitale-produkte-business-guide.pdf', key: 'pdf:business' },
];

function runWrangler(args, inherit) {
  const result = spawnSync(npxBin, args, {
    ...spawnBase,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) {
    console.error('Wrangler konnte nicht gestartet werden: ' + result.error.message);
    process.exit(1);
  }
  return result;
}

function remoteArgs() {
  const help = runWrangler(['wrangler', 'kv', 'key', 'put', '--help'], false);
  const text = `${help.stdout || ''}\n${help.stderr || ''}`;
  if (/\s--remote\b/.test(text)) return ['--remote'];
  console.log('Hinweis: Diese Wrangler-Version kennt --remote nicht. Ohne --local schreibt sie in die echte KV, nicht in den lokalen Speicher.');
  return [];
}

let missing = false;
for (const item of items) {
  const filePath = path.join(assetsDir, item.file);
  if (!fs.existsSync(filePath)) {
    console.error('Fehlt: ' + filePath);
    missing = true;
  }
}
if (missing) {
  console.error('Lege die sechs Dateien nach worker/assets/ und starte das Skript erneut.');
  process.exit(1);
}

const remote = remoteArgs();
let uploaded = 0;
for (const item of items) {
  const filePath = path.join(assetsDir, item.file);
  const kb = Math.round(fs.statSync(filePath).size / 1024);
  console.log('Lade hoch: ' + item.file + ' (' + kb + ' KB) → ' + item.key);
  const result = runWrangler([
    'wrangler', 'kv', 'key', 'put', item.key,
    '--path', filePath,
    '--binding', 'ASSETS',
    ...remote,
  ], true);
  if (result.status !== 0) {
    console.error('Fehlgeschlagen: ' + item.file + ' → ' + item.key);
    process.exit(result.status || 1);
  }
  uploaded += 1;
  console.log('Erfolgreich: ' + item.file + ' → ' + item.key);
}

console.log('Fertig: ' + uploaded + ' Dateien hochgeladen.');
