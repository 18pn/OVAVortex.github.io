// Serverseitiger Produkt- und Preiskatalog (einzige Quelle der Wahrheit). Preise in Euro-Cent.
// Krypto gilt für jedes Produkt, auch „All-in-One Media Access“.
import { HttpError } from './util.js';

export const PRODUCTS = Object.freeze({
  basic: { id: 'basic', name: 'Basic PC-Tuning', priceCents: 1500 },
  pro:   { id: 'pro',   name: 'Pro Tuning (0 Delay)', priceCents: 3500 },
  web:   { id: 'web',   name: 'Custom Website Build', priceCents: 2500 },
  media: { id: 'media', name: 'All-in-One Media Access', priceCents: 50 },
});

export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 50000;

export function priceItems(items, products = PRODUCTS) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) throw new HttpError(400, 'Ungültiger Warenkorb.');
  const merged = {};
  for (const it of items) {
    const id = String((it && it.id) || '');
    const qty = Math.floor(Number(it && it.qty));
    if (!products[id]) throw new HttpError(400, 'Ein Produkt im Warenkorb kann mit dieser Zahlungsart nicht gekauft werden.');
    if (!Number.isFinite(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Ungültige Menge.');
    merged[id] = (merged[id] || 0) + qty;
  }
  const lines = Object.entries(merged).map(([id, qty]) => ({
    productId: id, name: products[id].name, qty, unitCents: products[id].priceCents, lineCents: products[id].priceCents * qty,
    crypto: products[id].crypto !== false,
  }));
  return { lines, subtotalCents: lines.reduce((s, l) => s + l.lineCents, 0), noCrypto: lines.some(l => l.crypto === false) };
}

export function validateTopUpCents(amountEUR) {
  const cents = Math.round(Number(amountEUR) * 100);
  if (!Number.isFinite(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) throw new HttpError(400, 'Ungültiger Aufladebetrag (5–500 €).');
  return cents;
}
