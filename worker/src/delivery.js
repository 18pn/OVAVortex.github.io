// Auslieferung aus deliveries/{productId} (für Kunden nicht lesbar) -> orders/{id}.delivery
import { fsGet } from './firestore.js';

const DEFAULT_DELIVERY = {
  title: 'Auftragsbestätigung',
  instructions: '[PLATZHALTER] Vielen Dank für deine Bestellung! Nächste Schritte: Wir melden uns innerhalb von 24 Stunden per E-Mail oder Discord zur Terminabsprache. (Text in Firestore unter deliveries/{productId} anpassen.)',
  links: [],
};

// Sofortzugang, falls in Firestore noch kein deliveries/media liegt. Ein vorhandenes Dokument gewinnt.
const MEDIA_FALLBACK = {
  title: 'All-in-One Media Access',
  instructions: 'Dein Zugang ist sofort verfügbar.',
  links: ['https://yarrlist.net/'],
};

const GUIDE_IDS = new Set(['krypto-einsteiger', 'discord-playbook', 'digital-business']);

export async function buildDelivery(env, lines) {
  const out = [];
  for (const l of lines || []) {
    if (GUIDE_IDS.has(l.productId)) {
      out.push({
        productId: l.productId,
        name: l.name,
        title: 'Dein PDF',
        instructions: 'Der Download steht im Kundenportal. Der Link gilt nur kurz und nur für diese bezahlte Bestellung. Die Datei liegt nicht öffentlich auf der Webseite.',
        links: [],
        downloadKey: l.productId,
      });
      continue;
    }
    const doc = await fsGet(env, `deliveries/${l.productId}`);
    const d = doc ? doc.data : (l.productId === 'media' ? MEDIA_FALLBACK : DEFAULT_DELIVERY);
    out.push({
      productId: l.productId,
      name: l.name,
      title: String(d.title || DEFAULT_DELIVERY.title),
      instructions: String(d.instructions || ''),
      links: Array.isArray(d.links) ? d.links.filter(x => typeof x === 'string' && /^https:\/\//.test(x)).slice(0, 10) : [],
    });
  }
  return out;
}
