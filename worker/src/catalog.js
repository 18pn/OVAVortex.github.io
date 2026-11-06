// Serverseitiger Produkt- und Preiskatalog (einzige Quelle der Wahrheit). Preise in Euro-Cent.
// "All-in-One Media Access" ist bewusst NICHT enthalten (keine Krypto-/Guthaben-Zahlung, keine Auslieferung).
import { HttpError } from './util.js';

export const PRODUCTS = Object.freeze({
  basic: { id: 'basic', name: 'Basic PC-Tuning', priceCents: 1500 },
  pro:   { id: 'pro',   name: 'Pro Tuning (0 Delay)', priceCents: 3500 },
  web:   { id: 'web',   name: 'Custom Website Build', priceCents: 2500 },
});

export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 50000;

export function priceItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) throw new HttpError(400, 'Ungültiger Warenkorb.');
  const merged = {};
  for (const it of items) {
    const id = String((it && it.id) || '');
    const qty = Math.floor(Number(it && it.qty));
    if (!PRODUCTS[id]) throw new HttpError(400, 'Ein Produkt im Warenkorb kann mit dieser Zahlungsart nicht gekauft werden.');
    if (!Number.isFinite(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Ungültige Menge.');
    merged[id] = (merged[id] || 0) + qty;
  }
  const lines = Object.entries(merged).map(([id, qty]) => ({
    productId: id, name: PRODUCTS[id].name, qty, unitCents: PRODUCTS[id].priceCents, lineCents: PRODUCTS[id].priceCents * qty,
  }));
  return { lines, subtotalCents: lines.reduce((s, l) => s + l.lineCents, 0) };
}

export function validateTopUpCents(amountEUR) {
  const cents = Math.round(Number(amountEUR) * 100);
  if (!Number.isFinite(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) throw new HttpError(400, 'Ungültiger Aufladebetrag (5–500 €).');
  return cents;
}
