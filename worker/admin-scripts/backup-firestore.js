'use strict';
/**
 * Lokales Backup der Firestore-Sammlungen nach admin-scripts/backups/.
 * Nutzung: cd admin-scripts && npm install && node backup-firestore.js
 * Die Datei service-account.json bleibt lokal (gitignore).
 *
 * Der Worker-Cron (03:00 UTC) kann zusätzlich eine kurze Zusammenfassung an
 * BACKUP_WEBHOOK senden. Ein R2-Bucket ist auf dem Free-Setup nicht gebunden –
 * dieses Skript ist die vollständige Kopie.
 */
const fs = require('fs');
const path = require('path');
const admin = require('./init');

const COLLECTIONS = ['users', 'orders', 'coupons', 'deliveries', 'shopProducts', 'giftCards', 'supportChats', 'adminTotp'];

(async () => {
  const db = admin.firestore();
  const outDir = path.join(__dirname, 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = { exportedAt: new Date().toISOString(), collections: {} };
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    dump.collections[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(name, snap.size);
  }
  const file = path.join(outDir, 'firestore-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify(dump));
  console.log('Geschrieben:', file);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
