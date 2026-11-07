// Cloudflare Worker – API für valentinolopez.de (ersetzt die Firebase Cloud Functions aus v3)
// Endpunkte: POST /api/<name> mit JSON-Body, Authorization: Bearer <Firebase-ID-Token>
// Cron: alle 5 Min. offene Krypto-Bestellungen prüfen / nach 30 Min. ablaufen lassen.
// Free Plan: max. 50 Subrequests je Aufruf -> Cron prüft max. 15 Bestellungen pro Lauf, RPC max. 10 Signaturen je Referenz.
import { HttpError, corsHeaders, json, randomId, newInvoice, eurString } from './util.js';
import { verifyFirebaseToken } from './auth.js';
import { fsGet, fsQuery, fsCommit, writeDoc, deleteDoc, runTransaction, ts } from './firestore.js';
import { priceItems, validateTopUpCents } from './catalog.js';
import * as sol from './solana.js';
import { paypalCreateOrder, paypalCaptureAndVerify } from './paypal.js';
import { buildDelivery } from './delivery.js';

const CRYPTO_EXPIRY_MS = 30 * 60 * 1000;
const MIN_PAYMENT_CENTS = 50;
const STATUSES = ['offen', 'bezahlt', 'geliefert', 'storniert', 'abgelaufen'];
const rpcUrl = (env) => env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const str = (v, max = 200) => String(v ?? '').slice(0, max);

/* ---------- Geschäftslogik ---------- */
async function applyCoupon(env, code, subtotalCents) {
  const c = str(code, 40).trim().toUpperCase();
  if (!c || !/^[A-Z0-9_-]{2,32}$/.test(c)) return { coupon: '', discountCents: 0 };
  const d = await fsGet(env, `coupons/${c}`);
  if (!d || d.data.active === false) return { coupon: '', discountCents: 0, couponInvalid: true };
  const v = Math.max(0, Math.round(Number(d.data.valueCents) || 0));
  return { coupon: c, discountCents: Math.min(v, subtotalCents) };
}

async function computeCart(env, items, coupon) {
  const { lines, subtotalCents } = priceItems(items);
  const cp = await applyCoupon(env, coupon, subtotalCents);
  return { lines, subtotalCents, discountCents: cp.discountCents, coupon: cp.coupon, couponInvalid: !!cp.couponInvalid, totalCents: Math.max(0, subtotalCents - cp.discountCents) };
}

async function getOwnOrder(env, user, orderId) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(orderId)) throw new HttpError(404, 'Bestellung nicht gefunden.');
  const d = await fsGet(env, `orders/${orderId}`);
  if (!d || d.data.uid !== user.uid) throw new HttpError(404, 'Bestellung nicht gefunden.');
  return d.data;
}

/** Idempotent als bezahlt markieren; Signatur nur einmal verwendbar; Top-up gutschreiben bzw. Bestellung ausliefern. */
async function markPaidAndFulfill(env, orderId, { signature = null, paypalCaptureId = null } = {}) {
  const result = await runTransaction(env, async (tx) => {
    const d = await fsGet(env, `orders/${orderId}`, tx);
    if (!d) throw new HttpError(404, 'Bestellung nicht gefunden.');
    const o = d.data;
    if (o.status !== 'offen' && o.status !== 'abgelaufen') return { writes: [], result: { already: true, order: o } };
    const writes = [];
    if (signature) {
      const s = await fsGet(env, `usedSignatures/${signature}`, tx);
      if (s && s.data.orderId !== orderId) throw new HttpError(409, 'Diese Transaktion wurde bereits verwendet.');
      if (!s) writes.push(writeDoc(env, `usedSignatures/${signature}`, { orderId }, { serverTime: ['usedAt'], exists: false }));
    }
    const upd = { status: 'bezahlt' };
    if (signature) upd.signature = signature;
    if (paypalCaptureId) upd.paypal = { ...(o.paypal || {}), captureId: paypalCaptureId };
    const serverTime = ['paidAt'];
    if (o.kind === 'topup') {
      writes.push(writeDoc(env, `users/${o.uid}`, { email: o.email || '' }, { merge: true, increment: { balanceCents: o.totalCents }, serverTime: ['updatedAt'] }));
      upd.status = 'geliefert';
      upd.delivery = [{ productId: 'topup', name: 'Guthaben-Aufladung', title: 'Guthaben gutgeschrieben', instructions: `${eurString(o.totalCents)} € wurden deinem Konto gutgeschrieben.`, links: [] }];
      serverTime.push('deliveredAt');
    }
    writes.push(writeDoc(env, `orders/${orderId}`, upd, { merge: true, serverTime, exists: true }));
    return { writes, result: { already: false, order: o } };
  });
  if (!result.already && result.order.kind === 'order') await deliverOrder(env, orderId);
  return result;
}

async function deliverOrder(env, orderId) {
  const d = await fsGet(env, `orders/${orderId}`);
  if (!d || d.data.status !== 'bezahlt') return;
  const delivery = await buildDelivery(env, d.data.items || []);
  await fsCommit(env, [writeDoc(env, `orders/${orderId}`, { delivery, status: 'geliefert' }, { merge: true, serverTime: ['deliveredAt'], exists: true })]);
  // E-Mail-Versand: auf Workers ohne SMTP nicht eingebaut (siehe README, optional z. B. über einen Mail-API-Dienst).
}

async function createCryptoRecord(env, { uid, email, kind, cart, totalCents, token, label }) {
  if (totalCents < MIN_PAYMENT_CENTS) throw new HttpError(400, 'Der Betrag ist zu klein für eine Krypto-Zahlung.');
  const tokenSymbol = token === 'USDC' ? 'USDC' : 'SOL';
  const recipient = env.MERCHANT_WALLET;
  if (!sol.isPubkey(recipient)) throw new HttpError(503, 'Händler-Wallet ist nicht konfiguriert.');
  const q = await sol.quote(totalCents, tokenSymbol);
  const reference = sol.newReference();
  const invoice = newInvoice();
  const url = sol.buildSolanaPayURL({ recipient, amount: q.amount, reference, tokenSymbol, label: 'Val3ntino', message: `${label} #${invoice}` });
  const now = Date.now();
  const orderId = randomId();
  const doc = {
    uid, email, kind, invoice,
    items: cart ? cart.lines : [],
    subtotalCents: cart ? cart.subtotalCents : totalCents,
    discountCents: cart ? cart.discountCents : 0,
    coupon: cart ? cart.coupon : '',
    totalCents, method: 'crypto',
    methodLabel: tokenSymbol === 'USDC' ? 'USDC (Solana)' : 'SOL (Solana)',
    status: 'offen',
    crypto: { recipient, reference, token: tokenSymbol, amount: q.amount, mint: q.token.mint, rateEUR: q.rateEUR, url },
    createdAt: ts(now),
    expiresAt: ts(now + CRYPTO_EXPIRY_MS),
  };
  await fsCommit(env, [writeDoc(env, `orders/${orderId}`, doc, { exists: false })]);
  return { orderId, invoice, recipient, amount: q.amount, token: tokenSymbol, mint: q.token.mint, reference, url, totalCents, expiresAt: now + CRYPTO_EXPIRY_MS };
}

async function verifyCrypto(env, orderId, o) {
  const found = await sol.findValidPayment(rpcUrl(env), {
    recipient: o.crypto.recipient, amount: o.crypto.amount, reference: o.crypto.reference, tokenSymbol: o.crypto.token,
    notBeforeSec: o.createdAt ? Math.floor(o.createdAt.ms / 1000) - 120 : 0,
  });
  if (!found) return null;
  await markPaidAndFulfill(env, orderId, { signature: found.signature });
  return found;
}

/* ---------- Endpunkte ---------- */
const routes = {
  async quoteCart(env, user, b) {
    const c = await computeCart(env, b.items, b.coupon);
    return { subtotalCents: c.subtotalCents, discountCents: c.discountCents, totalCents: c.totalCents, coupon: c.coupon, couponInvalid: c.couponInvalid };
  },

  async createCryptoOrder(env, user, b) {
    const cart = await computeCart(env, b.items, b.coupon);
    return createCryptoRecord(env, { uid: user.uid, email: user.email, kind: 'order', cart, totalCents: cart.totalCents, token: b.token, label: 'Bestellung' });
  },

  async createTopUp(env, user, b) {
    const cents = validateTopUpCents(b.amountEUR);
    return createCryptoRecord(env, { uid: user.uid, email: user.email, kind: 'topup', cart: null, totalCents: cents, token: b.token, label: 'Aufladung' });
  },

  /** Liefert die Parameter (inkl. aktuellem Blockhash), mit denen der Browser die Phantom-Transaktion baut. */
  async buildCryptoTransaction(env, user, b) {
    const orderId = str(b.orderId, 40);
    if (!sol.isPubkey(str(b.account, 60))) throw new HttpError(400, 'Ungültige Wallet-Adresse.');
    const o = await getOwnOrder(env, user, orderId);
    if (o.method !== 'crypto' || o.status !== 'offen') throw new HttpError(409, 'Diese Bestellung ist nicht mehr offen.');
    if (o.expiresAt && o.expiresAt.ms < Date.now()) throw new HttpError(410, 'Die Zahlungsfrist ist abgelaufen. Bitte neu bestellen.');
    const { blockhash } = await sol.latestBlockhash(rpcUrl(env));
    const t = sol.TOKENS[o.crypto.token];
    return { blockhash, recipient: o.crypto.recipient, amount: o.crypto.amount, reference: o.crypto.reference, token: o.crypto.token, mint: t.mint, decimals: t.decimals };
  },

  /** Prüft Bestellungen UND Aufladungen (Krypto) on-chain. */
  async verifyCryptoOrder(env, user, b) {
    const orderId = str(b.orderId, 40);
    const o = await getOwnOrder(env, user, orderId);
    if (o.method !== 'crypto') throw new HttpError(400, 'Keine Krypto-Bestellung.');
    if (o.status !== 'offen' && o.status !== 'abgelaufen') return { status: o.status };
    const found = await verifyCrypto(env, orderId, o);
    if (!found) return { status: o.status, pending: true };
    const fresh = await fsGet(env, `orders/${orderId}`);
    return { status: fresh.data.status, signature: found.signature };
  },

  async createPayPalOrder(env, user, b) {
    const kind = b.kind === 'topup' ? 'topup' : 'order';
    let cart = null, totalCents;
    if (kind === 'topup') totalCents = validateTopUpCents(b.amountEUR);
    else { cart = await computeCart(env, b.items, b.coupon); totalCents = cart.totalCents; }
    if (totalCents < MIN_PAYMENT_CENTS) throw new HttpError(400, 'Der Betrag ist zu klein.');
    const invoice = newInvoice();
    const orderId = randomId();
    const paypalOrderId = await paypalCreateOrder(env, { totalCents, customId: orderId, description: (kind === 'topup' ? 'Guthaben' : 'Bestellung') + ' #' + invoice });
    await fsCommit(env, [writeDoc(env, `orders/${orderId}`, {
      uid: user.uid, email: user.email, kind, invoice,
      items: cart ? cart.lines : [],
      subtotalCents: cart ? cart.subtotalCents : totalCents,
      discountCents: cart ? cart.discountCents : 0,
      coupon: cart ? cart.coupon : '',
      totalCents, method: 'paypal', methodLabel: 'PayPal / Karte', status: 'offen',
      paypal: { orderId: paypalOrderId },
      createdAt: ts(Date.now()),
    }, { exists: false })]);
    return { orderId, paypalOrderId, invoice, totalCents };
  },

  async capturePayPalOrder(env, user, b) {
    const orderId = str(b.orderId, 40);
    const o = await getOwnOrder(env, user, orderId);
    if (o.method !== 'paypal') throw new HttpError(400, 'Keine PayPal-Bestellung.');
    if (o.status !== 'offen') return { status: o.status, invoice: o.invoice };
    const v = await paypalCaptureAndVerify(env, { paypalOrderId: o.paypal.orderId, expectedCents: o.totalCents, expectedCustomId: orderId });
    if (!v.ok) throw new HttpError(402, 'Die Zahlung konnte nicht bestätigt werden.');
    await markPaidAndFulfill(env, orderId, { paypalCaptureId: v.captureId });
    const fresh = await fsGet(env, `orders/${orderId}`);
    return { status: fresh.data.status, invoice: fresh.data.invoice };
  },

  async payWithBalance(env, user, b) {
    const cart = await computeCart(env, b.items, b.coupon);
    const orderId = randomId();
    const invoice = newInvoice();
    await runTransaction(env, async (tx) => {
      const u = await fsGet(env, `users/${user.uid}`, tx);
      const bal = u ? Number(u.data.balanceCents) || 0 : 0;
      if (bal < cart.totalCents) throw new HttpError(402, 'Nicht genügend Guthaben.');
      return {
        writes: [
          writeDoc(env, `users/${user.uid}`, { email: user.email }, { merge: true, increment: { balanceCents: -cart.totalCents }, serverTime: ['updatedAt'] }),
          writeDoc(env, `orders/${orderId}`, {
            uid: user.uid, email: user.email, kind: 'order', invoice,
            items: cart.lines, subtotalCents: cart.subtotalCents, discountCents: cart.discountCents, coupon: cart.coupon,
            totalCents: cart.totalCents, method: 'balance', methodLabel: 'Account-Guthaben', status: 'bezahlt',
            createdAt: ts(Date.now()),
          }, { serverTime: ['paidAt'], exists: false }),
        ],
        result: null,
      };
    });
    await deliverOrder(env, orderId);
    return { orderId, invoice, totalCents: cart.totalCents, status: 'geliefert' };
  },

  /* ----- Admin (Custom Claim admin == true) ----- */
  async adminSetOrderStatus(env, user, b) {
    requireAdmin(user);
    const orderId = str(b.orderId, 40);
    const status = str(b.status, 20);
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Ungültiger Status.');
    if (!/^[A-Za-z0-9]{10,40}$/.test(orderId)) throw new HttpError(404, 'Bestellung nicht gefunden.');
    const d = await fsGet(env, `orders/${orderId}`);
    if (!d) throw new HttpError(404, 'Bestellung nicht gefunden.');
    // Statuswechsel durch den Admin bucht kein Guthaben und löst keine Zahlung aus.
    await fsCommit(env, [writeDoc(env, `orders/${orderId}`, { status, statusChangedBy: user.uid }, { merge: true, serverTime: ['statusChangedAt'], exists: true })]);
    if (status === 'bezahlt' && d.data.kind === 'order') await deliverOrder(env, orderId);
    return { ok: true };
  },

  async adminSaveCoupon(env, user, b) {
    requireAdmin(user);
    const code = str(b.code, 40).trim().toUpperCase();
    const valueCents = Math.round(Number(b.valueCents));
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpError(400, 'Ungültiger Gutscheincode.');
    if (!Number.isInteger(valueCents) || valueCents < 0 || valueCents > 100000) throw new HttpError(400, 'Ungültiger Wert (0–1000 €).');
    await fsCommit(env, [writeDoc(env, `coupons/${code}`, { valueCents, active: b.active !== false }, { serverTime: ['updatedAt'] })]);
    return { ok: true, code };
  },

  async adminDeleteCoupon(env, user, b) {
    requireAdmin(user);
    const code = str(b.code, 40).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpError(400, 'Ungültiger Gutscheincode.');
    await fsCommit(env, [deleteDoc(env, `coupons/${code}`)]);
    return { ok: true };
  },

  // Anzeige-Daten (Bestand, Text). Preise für die Zahlung bleiben in catalog.js.
  async adminSaveProduct(env, user, b) {
    requireAdmin(user);
    const id = str(b.id, 40).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(id)) throw new HttpError(400, 'Ungültige Produkt-ID.');
    const stock = Math.max(0, Math.min(9999, Math.round(Number(b.stock))));
    if (!Number.isFinite(stock)) throw new HttpError(400, 'Ungültiger Bestand.');
    await fsCommit(env, [writeDoc(env, `shopProducts/${id}`, {
      name: str(b.name, 80),
      blurb: str(b.blurb, 280),
      stock,
      active: b.active !== false,
    }, { serverTime: ['updatedAt'] })]);
    return { ok: true, id };
  },
};
routes.verifyTopUp = routes.verifyCryptoOrder;            // Alias: Krypto-Aufladung prüfen
routes.createPayPalTopUp = (env, u, b) => routes.createPayPalOrder(env, u, { ...b, kind: 'topup' });
routes.capturePayPalTopUp = routes.capturePayPalOrder;

function requireAdmin(user) {
  if (!user.admin) throw new HttpError(403, 'Kein Admin-Zugriff.');
}

/* ---------- Cron: offene Krypto-Bestellungen ---------- */
export async function recheckOpenCryptoOrders(env) {
  const docs = await fsQuery(env, 'orders', [['status', 'offen'], ['method', 'crypto']], 15);
  const now = Date.now();
  let paid = 0, expired = 0;
  for (const d of docs) {
    try {
      if (await verifyCrypto(env, d.id, d.data)) { paid++; continue; }
      if (d.data.expiresAt && d.data.expiresAt.ms < now) {
        await fsCommit(env, [writeDoc(env, `orders/${d.id}`, { status: 'abgelaufen' }, { merge: true, serverTime: ['expiredAt'], exists: true })]);
        expired++;
      }
    } catch (e) {
      console.warn('Recheck fehlgeschlagen', d.id, e.message);
    }
  }
  return { checked: docs.length, paid, expired };
}

/* ---------- HTTP ---------- */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    const origin = request.headers.get('Origin');
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'Origin nicht erlaubt.' }, 403, cors);
    const m = url.pathname.match(/^\/api\/([A-Za-z]+)$/);
    if (!m || !Object.prototype.hasOwnProperty.call(routes, m[1])) return json({ error: 'Nicht gefunden.' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Nur POST.' }, 405, cors);
    try {
      const user = await verifyFirebaseToken(request, env);
      let body = {};
      const text = await request.text();
      if (text.length > 20000) throw new HttpError(413, 'Anfrage zu groß.');
      if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Ungültiges JSON.'); } }
      if (!body || typeof body !== 'object') body = {};
      const result = await routes[m[1]](env, user, body);
      return json(result ?? { ok: true }, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error('Unerwarteter Fehler', m[1], e && e.stack || e);
      return json({ error: 'Interner Fehler. Bitte später erneut versuchen.' }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(recheckOpenCryptoOrders(env).then(r => console.log('Cron', JSON.stringify(r))));
  },
};
