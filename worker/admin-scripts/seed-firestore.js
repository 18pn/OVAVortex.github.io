'use strict';
/**
 * Legt Start-Daten an: Gutscheine und Auslieferungs-Platzhalter für die Service-Produkte.
 * Nutzung: cd admin-scripts && npm install && node seed-firestore.js
 * Bestehende Dokumente werden NICHT überschrieben.
 */
const admin = require('./init');
const db = admin.firestore();

const coupons = { VAL3NTINO: { valueCents: 500, active: true }, CENT50: { valueCents: 50, active: true } };
const placeholder = (name) => ({
  title: `Auftragsbestätigung: ${name}`,
  instructions: '[PLATZHALTER] Vielen Dank! Nächste Schritte: Wir melden uns innerhalb von 24 Stunden per E-Mail oder Discord (https://discord.gg/YE2jHSwM7) zur Terminabsprache. Bitte halte deine Rechnungsnummer bereit.',
  links: [],
});
// Hinweis: "All-in-One Media Access" ist bewusst NICHT enthalten.
const deliveries = {
  basic: placeholder('Basic PC-Tuning'),
  pro: placeholder('Pro Tuning (0 Delay)'),
  web: placeholder('Custom Website Build'),
};

(async () => {
  for (const [id, data] of Object.entries(coupons)) {
    const ref = db.collection('coupons').doc(id);
    if (!(await ref.get()).exists) { await ref.set(data); console.log('Gutschein angelegt:', id); }
  }
  for (const [id, data] of Object.entries(deliveries)) {
    const ref = db.collection('deliveries').doc(id);
    if (!(await ref.get()).exists) { await ref.set(data); console.log('Auslieferung angelegt:', id); }
  }
  console.log('Fertig.');
  process.exit(0);
})().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
