'use strict';
// Gemeinsame Initialisierung: nutzt ./service-account.json (dieser Ordner) oder GOOGLE_APPLICATION_CREDENTIALS.
// Die Schlüsseldatei NIEMALS hochladen, teilen oder ins Git einchecken.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const local = path.join(__dirname, 'service-account.json');
const keyPath = fs.existsSync(local) ? local : process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error('Kein Dienstkonto-Schlüssel gefunden. Lege ihn als admin-scripts/service-account.json ab.');
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id || 'valentinolopezde' });
module.exports = admin;
