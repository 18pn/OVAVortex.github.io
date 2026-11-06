'use strict';
/**
 * Setzt den Custom Claim admin=true für die Inhaber-Adresse (läuft lokal, kein Blaze nötig).
 *   cd admin-scripts && npm install && node set-admin-claim.js l@valentinolopez.de
 * Danach im Shop einmal ab- und wieder anmelden, damit das neue Token gilt.
 */
const admin = require('./init');

const email = (process.argv[2] || 'l@valentinolopez.de').toLowerCase().trim();
if (email !== 'l@valentinolopez.de') {
  console.error('Abgebrochen: Admin-Rechte sind nur für l@valentinolopez.de vorgesehen.');
  process.exit(1);
}
(async () => {
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  console.log(`OK: admin=true gesetzt für ${email} (uid ${user.uid}). Bitte im Shop ab- und wieder anmelden.`);
  process.exit(0);
})().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
