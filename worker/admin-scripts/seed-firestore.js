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
  instructions: '[PLATZHALTER] Vielen Dank! Nächste Schritte: Wir melden uns innerhalb von 24 Stunden per E-Mail oder Discord (https://discord.gg/KZgBuDzRx7) zur Terminabsprache. Bitte halte deine Rechnungsnummer bereit.',
  links: [],
});
const deliveries = {
  basic: placeholder('Basic PC-Tuning'),
  pro: placeholder('Pro Tuning (0 Delay)'),
  web: placeholder('Custom Website Build'),
  media: {
    title: 'All-in-One Media Access',
    instructions: 'Dein Zugang ist sofort verfügbar.',
    links: ['https://yarrlist.net/'],
  },
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
  const defaults = {
    siteSettings: { main: { heroTitle: 'Val3ntino', heroText: 'Windows-PC-Tuning für minimale Latenz, saubere Webentwicklung und individuelle Skripte.', promoText: 'Mit dem Code VAL3NTINO sparst du 5,00 € an der Kasse!', accent: '#ec4899', accent2: '#d946ef', brandName: 'Val3ntino', linktree: 'https://linktr.ee/val3nt1no', discord: 'https://discord.gg/KZgBuDzRx7', showSalesPop: true, unitsSold: 0, payments: 'paypal,balance,crypto', paypalPlanId: '', legalName: 'Valentino Lopez', legalStreet: 'Europa-Allee 2', legalZipCity: '60327 Frankfurt am Main', legalEmail: 'L@valentinolopez.de', seoTitle: 'Val3ntino | Official Store & Services', seoDescription: 'PC-Tuning, Websites und digitale Ratgeber. Bezahlen mit PayPal oder Solana.', ogImage: 'https://valentinolopez.de/icon.svg' } },
    catalog: {
      basic: { name: 'Basic PC-Tuning', blurb: 'Bereinigung der Windows-Dienste, Hintergrund-Debloat und stabilere FPS.', priceCents: 1500, stock: 99, crypto: true, active: true, deliveryType: 'termin' },
      pro: { name: 'Pro Tuning (0 Delay)', blurb: 'Ultra-Low-Latency-Setup mit BIOS- und Registry-Optimierung.', priceCents: 3500, stock: 99, crypto: true, active: true, deliveryType: 'termin' },
      web: { name: 'Custom Website Build', blurb: 'Moderne One-Page-Website oder Portfolio.', priceCents: 2500, stock: 99, crypto: true, active: true, deliveryType: 'termin' },
      media: { name: 'All-in-One Media Access', blurb: 'Sofort-Link nach bestätigter Zahlung.', priceCents: 50, stock: 99, crypto: true, active: true, deliveryType: 'link' },
      'krypto-einsteiger-2026': { name: 'Krypto für Einsteiger 2026: Wallet, Sicherheit & erste Schritte', blurb: 'Verstehe Wallets, Solana und Phantom, ohne blind ins Risiko zu gehen. Mit sicheren Transferabläufen, Betrugswarnungen, Glossar und Zahlungs-Checkliste.', priceCents: 1990, stock: 999, crypto: true, active: true, deliveryType: 'pdf', downloadKey: 'krypto-einsteiger-2026', image: 'https://valentinolopez-api.valentinolopez.workers.dev/asset/cover/krypto-einsteiger-2026' },
      'discord-server-playbook': { name: 'Discord-Server aufbauen & monetarisieren', blurb: 'Baue eine strukturierte Community mit sicheren Rollen, hilfreichen Formaten und nachvollziehbarem Bezahlmodell. Inklusive Textvorlagen, 30-Tage-Startplan und Launch-Checkliste.', priceCents: 2490, stock: 999, crypto: true, active: true, deliveryType: 'pdf', downloadKey: 'discord-server-playbook', image: 'https://valentinolopez-api.valentinolopez.workers.dev/asset/cover/discord-server-playbook' },
      'digitale-produkte-business-guide': { name: 'Mit digitalen Produkten Geld verdienen: Von der Nische zum ersten Verkauf', blurb: 'Entwickle ein nützliches Downloadprodukt statt eines leeren Einkommensversprechens. Mit Nachfracheprüfung, Produktion, Preisrechnung, Marketing sowie Zahlung und Lieferung per PayPal oder Krypto.', priceCents: 2490, stock: 999, crypto: true, active: true, deliveryType: 'pdf', downloadKey: 'digitale-produkte-business-guide', image: 'https://valentinolopez-api.valentinolopez.workers.dev/asset/cover/digitale-produkte-business-guide' }
    },
    reviews: {
      lena: { name: 'Lena · Pro Tuning', quote: 'Das Pro-Tuning hat die Eingabe spürbar ruhiger gemacht.' },
      jonas: { name: 'Jonas · Website', quote: 'Die Zahlung mit PayPal war unkompliziert.' }
    },
    posts: { krypto: { title: 'Krypto für jedes Produkt', date: 'November 2026', body: 'SOL und USDC bleiben on-chain. ETH und BTC bestätigt der Shop manuell.', published: true } },
    faqs: { krypto: { productId: 'pro', q: 'Wann ist die Krypto-Zahlung fertig?', a: 'SOL und USDC nach der Blockchain-Bestätigung. ETH und BTC nach manueller Prüfung.' } },
    partners: { discord: { label: 'Discord', href: 'https://discord.gg/KZgBuDzRx7' }, links: { label: 'Linktree', href: 'https://linktr.ee/val3nt1no' } },
    bundles: { pro3: { name: 'Pro ab 2 Stück', productId: 'pro', minQty: 2, percent: 10 } }
  };
  for (const [col, docs] of Object.entries(defaults)) {
    for (const [id, data] of Object.entries(docs)) {
      const ref = db.collection(col).doc(id);
      if (!(await ref.get()).exists) { await ref.set(data); console.log(col, id); }
    }
  }
  console.log('Fertig.');
  process.exit(0);
})().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
