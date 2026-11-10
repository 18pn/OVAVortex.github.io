// Cloudflare Worker – API für valentinolopez.de (ersetzt die Firebase Cloud Functions aus v3)
// Endpunkte: POST /api/<name> mit JSON-Body, Authorization: Bearer <Firebase-ID-Token>
// Cron: alle 5 Min. offene Krypto-Bestellungen prüfen / nach 30 Min. ablaufen lassen.
// Free Plan: max. 50 Subrequests je Aufruf -> Cron prüft max. 15 Bestellungen pro Lauf, RPC max. 10 Signaturen je Referenz.
import { HttpError, corsHeaders, json, randomId, newInvoice, eurString } from './util.js';
import { verifyFirebaseToken } from './auth.js';
import { fsGet, fsQuery, fsList, fsCommit, writeDoc, deleteDoc, runTransaction, ts } from './firestore.js';
import { priceItems, validateTopUpCents, PRODUCTS } from './catalog.js';
import * as sol from './solana.js';
import { paypalCreateOrder, paypalCaptureAndVerify } from './paypal.js';
import { buildDelivery } from './delivery.js';
import { randomBase32, verifyTotp } from './totp.js';
import { GUIDES, PLACEHOLDER_PNG, coverKey, pdfKey, pdfFilename, readAsset, readAssetMeta } from './guides.js';
import { lookupUserByEmail, setAdminClaim } from './identity.js';
import { notifyPaidOrder, notifyRestock, notifyNewsletter, handleDiscordInteraction } from './discord.js';

const CRYPTO_EXPIRY_MS = 30 * 60 * 1000;
const MIN_PAYMENT_CENTS = 50;
const STATUSES = ['offen', 'bezahlt', 'geliefert', 'storniert', 'abgelaufen'];
const OWNER_EMAIL = 'l@valentinolopez.de';
const CMS_COLLECTIONS = new Set(['siteSettings', 'catalog', 'reviews', 'posts', 'faqs', 'partners', 'bundles']);
const isOwner = (user) => !!(user && user.admin && String(user.email || '').toLowerCase() === OWNER_EMAIL);
function cleanRef(v) {
  const c = str(v, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,16}$/.test(c) ? c : '';
}
function mailOk(v) {
  const email = str(v, 120).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function sanitizeCms(data) {
  const clean = {};
  if (!data || typeof data !== 'object') return clean;
  for (const [k, v] of Object.entries(data)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,32}$/.test(k)) continue;
    if (typeof v === 'string') clean[k] = v.slice(0, /legal|impressum|privacy|terms|widerruf|^body$/i.test(k) ? 8000 : 2000);
    else if (typeof v === 'boolean') clean[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    else if (Array.isArray(v)) clean[k] = v.filter(x => typeof x === 'string').slice(0, 8).map(s => s.slice(0, 400));
  }
  return clean;
}
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

async function liveProducts(env) {
  const map = {};
  for (const [id, p] of Object.entries(PRODUCTS)) map[id] = { ...p, crypto: true };
  try {
    for (const d of await fsList(env, 'catalog', 40)) {
      const price = Math.round(Number(d.data && d.data.priceCents));
      if (!d.id || !Number.isFinite(price) || price < 1) continue;
      if (d.data.active === false) { delete map[d.id]; continue; }
      map[d.id] = {
        id: d.id,
        name: String(d.data.name || (map[d.id] && map[d.id].name) || d.id).slice(0, 120),
        priceCents: price,
        crypto: true,
        deliveryType: d.data.deliveryType || (GUIDES[d.id] ? 'pdf' : ''),
      };
    }
  } catch { /* Fallback: fest eingebaute Produkte */ }
  return map;
}

async function bundleDiscount(env, lines) {
  let off = 0;
  try {
    for (const b of await fsList(env, 'bundles', 30)) {
      const line = lines.find(l => l.productId === b.data.productId);
      const minQty = Number(b.data.minQty) || 0;
      const percent = Math.min(80, Math.max(0, Number(b.data.percent) || 0));
      if (line && minQty > 1 && line.qty >= minQty) off += Math.round(line.lineCents * percent / 100);
    }
  } catch { /* keine Bundles */ }
  return off;
}

async function assertGuidesReady(env, lines) {
  const products = await liveProducts(env);
  for (const line of lines || []) {
    const product = products[line.productId];
    const needsPdf = !!(GUIDES[line.productId] || (product && product.deliveryType === 'pdf'));
    if (!needsPdf) continue;
    const bytes = await readAsset(env, pdfKey(line.productId));
    if (!bytes) throw new HttpError(503, 'Die PDF-Datei liegt noch nicht im Speicher. Bitte upload-assets.js ausführen oder die Datei im Admin hochladen.');
  }
}

async function computeCart(env, items, coupon) {
  const products = await liveProducts(env);
  const priced = priceItems(items, products);
  const bundleCents = await bundleDiscount(env, priced.lines);
  const subtotalCents = Math.max(0, priced.subtotalCents - bundleCents);
  const cp = await applyCoupon(env, coupon, subtotalCents);
  return { lines: priced.lines, subtotalCents, discountCents: cp.discountCents, coupon: cp.coupon, couponInvalid: !!cp.couponInvalid, totalCents: Math.max(0, subtotalCents - cp.discountCents), noCrypto: priced.noCrypto };
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
    } else if (o.kind === 'giftcard') {
      const code = giftCode();
      writes.push(writeDoc(env, `giftCards/${code}`, { valueCents: o.totalCents, redeemed: false, orderId }, { serverTime: ['createdAt'], exists: false }));
      upd.status = 'geliefert';
      upd.giftCode = code;
      upd.delivery = [{ productId: 'giftcard', name: 'Geschenkkarte', title: 'Dein Gutscheincode', instructions: `Code ${code} über ${eurString(o.totalCents)} €. Einlösen im Kundenportal unter Guthaben. Der Code wird einmalig zum Guthaben.`, links: [] }];
      serverTime.push('deliveredAt');
    }
    writes.push(writeDoc(env, `orders/${orderId}`, upd, { merge: true, serverTime, exists: true }));
    return { writes, result: { already: false, order: o } };
  });
  if (!result.already && result.order.kind === 'order') {
    await deliverOrder(env, orderId);
    await countReferralOrder(env, result.order.refCode, result.order.uid);
    await notifyPaidOrder(env, orderId, result.order);
  }
  return result;
}

async function countReferralOrder(env, refCode, buyerUid) {
  const code = cleanRef(refCode);
  if (!code) return;
  try {
    const row = await fsGet(env, `referrals/${code}`);
    if (!row || row.data.uid === buyerUid) return;
    await fsCommit(env, [writeDoc(env, `referrals/${code}`, {}, { merge: true, increment: { orders: 1 } })]);
  } catch (e) { console.warn('Referral', e.message); }
}

async function deliverOrder(env, orderId) {
  const d = await fsGet(env, `orders/${orderId}`);
  if (!d || d.data.status !== 'bezahlt') return;
  const delivery = await buildDelivery(env, d.data.items || []);
  await fsCommit(env, [writeDoc(env, `orders/${orderId}`, { delivery, status: 'geliefert' }, { merge: true, serverTime: ['deliveredAt'], exists: true })]);
  // SMTP: hier Zugangslink oder Lizenzschlüssel mailen. Auf dem Worker ist kein SMTP eingebaut (README).
}

async function createCryptoRecord(env, { uid, email, kind, cart, totalCents, token, label, billing = null, refCode = '' }) {
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
    billing: billing || null,
    crypto: { recipient, reference, token: tokenSymbol, amount: q.amount, mint: q.token.mint, rateEUR: q.rateEUR, url },
    refCode: cleanRef(refCode),
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

function b64url(text) {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(text) {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  return atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
}
async function downloadKey(env) {
  if (!env.DOWNLOAD_TOKEN_SECRET) throw new HttpError(503, 'DOWNLOAD_TOKEN_SECRET fehlt. Bitte als Worker-Secret setzen.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.DOWNLOAD_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signDownload(env, payload) {
  const body = b64url(JSON.stringify(payload));
  const key = await downloadKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let raw = '';
  for (const b of sig) raw += String.fromCharCode(b);
  return body + '.' + b64url(raw);
}
async function verifyDownload(env, token, orderId, productId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const key = await downloadKey(env);
  const sig = Uint8Array.from(b64urlDecode(parts[1]), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(parts[0]));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[0])); } catch { return null; }
  if (!payload || payload.orderId !== orderId || payload.productId !== productId || payload.exp < Date.now()) return null;
  return payload;
}

function giftCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

function sanitizeBilling(raw) {
  if (!raw || typeof raw !== 'object' || !raw.business) return null;
  const vat = str(raw.vatId, 20).toUpperCase().replace(/\s/g, '');
  if (vat && !/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vat)) throw new HttpError(400, 'USt-IdNr. ist ungültig.');
  return {
    business: true,
    company: str(raw.company, 80),
    street: str(raw.street, 120),
    zip: str(raw.zip, 12),
    city: str(raw.city, 80),
    country: str(raw.country, 2).toUpperCase() || 'DE',
    vatId: vat,
  };
}

// ETH/BTC: keine automatische On-Chain-Prüfung. Anschlussstelle: hier eine Quittung (Tx-Hash)
// gegen einen ETH- oder BTC-RPC prüfen (Betrag, Empfänger, Bestätigungen) und danach markPaidAndFulfill.
async function createManualCoinOrder(env, { uid, email, kind, cart, totalCents, asset, billing, refCode = '' }) {
  const address = asset === 'ETH' ? str(env.ETH_ADDRESS, 80) : str(env.BTC_ADDRESS, 80);
  if (!address) throw new HttpError(503, asset + '-Adresse ist noch nicht hinterlegt (wrangler.toml).');
  if (totalCents < MIN_PAYMENT_CENTS) throw new HttpError(400, 'Der Betrag ist zu klein.');
  const invoice = newInvoice();
  const orderId = randomId();
  await fsCommit(env, [writeDoc(env, `orders/${orderId}`, {
    uid, email, kind, invoice,
    items: cart ? cart.lines : [],
    subtotalCents: cart ? cart.subtotalCents : totalCents,
    discountCents: cart ? cart.discountCents : 0,
    coupon: cart ? cart.coupon : '',
    totalCents, method: 'manual-crypto', methodLabel: asset + ' (manuell)', status: 'offen',
    billing: billing || null,
    manualCrypto: { asset, address },
    refCode: cleanRef(refCode),
    createdAt: ts(Date.now()),
  }, { exists: false })]);
  return { orderId, invoice, totalCents, asset, address, manual: true };
}

const rateBuckets = new Map();
function rateLimit(ip, key, limit, windowMs) {
  const now = Date.now();
  const id = ip + ':' + key;
  const prev = (rateBuckets.get(id) || []).filter(t => now - t < windowMs);
  if (prev.length >= limit) { rateBuckets.set(id, prev); return false; }
  prev.push(now);
  rateBuckets.set(id, prev);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return true;
}

// Cron-Sicherung: ohne R2 nur Zähler, optional POST an BACKUP_WEBHOOK. Vollbackup: admin-scripts/backup-firestore.js
async function backupTick(env) {
  let activeCoupons = 0;
  try { activeCoupons = (await fsQuery(env, 'coupons', [['active', true]], 50)).length; } catch { activeCoupons = -1; }
  const summary = { at: new Date().toISOString(), activeCoupons, note: 'Vollbackup: node admin-scripts/backup-firestore.js (R2 ist nicht gebunden).' };
  if (env.BACKUP_WEBHOOK) {
    await fetch(env.BACKUP_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) }).catch(() => {});
  }
  console.log('Backup-Tick', JSON.stringify(summary));
  return summary;
}

/* ---------- Endpunkte ---------- */
const routes = {
  async quoteCart(env, user, b) {
    const c = await computeCart(env, b.items, b.coupon);
    return { subtotalCents: c.subtotalCents, discountCents: c.discountCents, totalCents: c.totalCents, coupon: c.coupon, couponInvalid: c.couponInvalid };
  },

  async createCryptoOrder(env, user, b) {
    const billing = sanitizeBilling(b.billing);
    const cart = await computeCart(env, b.items, b.coupon);
    await assertGuidesReady(env, cart.lines);
    if (cart.noCrypto) throw new HttpError(400, 'Für mindestens ein Produkt ist Krypto ausgeschaltet.');
    if (b.token === 'ETH' || b.token === 'BTC') {
      return createManualCoinOrder(env, { uid: user.uid, email: user.email, kind: 'order', cart, totalCents: cart.totalCents, asset: b.token, billing, refCode: b.refCode });
    }
    return createCryptoRecord(env, { uid: user.uid, email: user.email, kind: 'order', cart, totalCents: cart.totalCents, token: b.token, billing, label: 'Bestellung', refCode: b.refCode });
  },

  async createTopUp(env, user, b) {
    const cents = validateTopUpCents(b.amountEUR);
    const kind = b.kind === 'giftcard' ? 'giftcard' : 'topup';
    if (b.token === 'ETH' || b.token === 'BTC') {
      return createManualCoinOrder(env, { uid: user.uid, email: user.email, kind, cart: null, totalCents: cents, asset: b.token, billing: null });
    }
    return createCryptoRecord(env, { uid: user.uid, email: user.email, kind, cart: null, totalCents: cents, token: b.token, billing: null, label: kind === 'giftcard' ? 'Geschenkkarte' : 'Aufladung' });
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
    const kind = b.kind === 'topup' ? 'topup' : b.kind === 'giftcard' ? 'giftcard' : 'order';
    let cart = null, totalCents;
    if (kind === 'topup' || kind === 'giftcard') totalCents = validateTopUpCents(b.amountEUR);
    else { cart = await computeCart(env, b.items, b.coupon); totalCents = cart.totalCents; await assertGuidesReady(env, cart.lines); }
    const billing = kind === 'order' ? sanitizeBilling(b.billing) : null;
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
      billing,
      refCode: cleanRef(b.refCode),
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
    await assertGuidesReady(env, cart.lines);
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
            billing: sanitizeBilling(b.billing),
            refCode: cleanRef(b.refCode),
            createdAt: ts(Date.now()),
          }, { serverTime: ['paidAt'], exists: false }),
        ],
        result: null,
      };
    });
    await deliverOrder(env, orderId);
    await countReferralOrder(env, b.refCode, user.uid);
    return { orderId, invoice, totalCents: cart.totalCents, status: 'geliefert' };
  },

  /* ----- Admin (Custom Claim admin == true) ----- */
  async adminSetOrderStatus(env, user, b) {
    await assertAdmin(env, user, b);
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
    await assertAdmin(env, user, b);
    const code = str(b.code, 40).trim().toUpperCase();
    const valueCents = Math.round(Number(b.valueCents));
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpError(400, 'Ungültiger Gutscheincode.');
    if (!Number.isInteger(valueCents) || valueCents < 0 || valueCents > 100000) throw new HttpError(400, 'Ungültiger Wert (0–1000 €).');
    await fsCommit(env, [writeDoc(env, `coupons/${code}`, { valueCents, active: b.active !== false }, { serverTime: ['updatedAt'] })]);
    return { ok: true, code };
  },

  async adminDeleteCoupon(env, user, b) {
    await assertAdmin(env, user, b);
    const code = str(b.code, 40).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpError(400, 'Ungültiger Gutscheincode.');
    await fsCommit(env, [deleteDoc(env, `coupons/${code}`)]);
    return { ok: true };
  },

  // Anzeige-Daten (Bestand, Text). Preise für die Zahlung bleiben in catalog.js.
  async adminSaveProduct(env, user, b) {
    await assertAdmin(env, user, b);
    const id = str(b.id, 48).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,48}$/.test(id)) throw new HttpError(400, 'Ungültige Produkt-ID.');
    const stock = Math.max(0, Math.min(9999, Math.round(Number(b.stock))));
    if (!Number.isFinite(stock)) throw new HttpError(400, 'Ungültiger Bestand.');
    const name = str(b.name, 120);
    const blurb = str(b.blurb, 600);
    const active = b.active !== false;
    const prevShop = await fsGet(env, `shopProducts/${id}`);
    const prevCat = await fsGet(env, `catalog/${id}`);
    const prevStock = prevShop && Number.isFinite(Number(prevShop.data.stock)) ? Number(prevShop.data.stock) : (prevCat && Number.isFinite(Number(prevCat.data.stock)) ? Number(prevCat.data.stock) : null);
    const prevActive = prevShop ? prevShop.data.active !== false : (prevCat ? prevCat.data.active !== false : true);
    const writes = [writeDoc(env, `shopProducts/${id}`, { name, blurb, stock, active }, { serverTime: ['updatedAt'] })];
    if (b.priceCents != null && b.priceCents !== '') {
      const priceCents = Math.round(Number(b.priceCents));
      if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 500000) throw new HttpError(400, 'Ungültiger Preis.');
      const deliveryType = ['pdf', 'link', 'termin'].includes(str(b.deliveryType, 20)) ? str(b.deliveryType, 20) : (GUIDES[id] ? 'pdf' : 'termin');
      const sort = Math.max(0, Math.min(999, Math.round(Number(b.sort) || 0)));
      writes.push(writeDoc(env, `catalog/${id}`, {
        name, blurb, priceCents, stock, active, crypto: true, sort,
        category: str(b.category, 24) || 'guides',
        deliveryType,
        downloadKey: deliveryType === 'pdf' ? id : '',
        image: str(b.image, 300),
      }, { serverTime: ['updatedAt'] }));
    }
    await fsCommit(env, writes);
    if (prevStock !== null && (prevStock === 0 || prevActive === false) && stock > 0 && active) await notifyRestock(env, name || id);
    return { ok: true, id };
  },

  async adminDeleteProduct(env, user, b) {
    await assertAdmin(env, user, b);
    const id = str(b.id, 48).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,48}$/.test(id)) throw new HttpError(400, 'Ungültige Produkt-ID.');
    if (PRODUCTS[id]) {
      await fsCommit(env, [
        writeDoc(env, `catalog/${id}`, { active: false }, { merge: true, serverTime: ['updatedAt'] }),
        writeDoc(env, `shopProducts/${id}`, { active: false }, { merge: true, serverTime: ['updatedAt'] }),
      ]);
      return { ok: true, hidden: true };
    }
    await fsCommit(env, [deleteDoc(env, `catalog/${id}`), deleteDoc(env, `shopProducts/${id}`)]);
    return { ok: true, hidden: false };
  },

  async redeemGiftCard(env, user, b) {
    const code = str(b.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 8) throw new HttpError(400, 'Code ungültig.');
    return runTransaction(env, async (tx) => {
      const g = await fsGet(env, `giftCards/${code}`, tx);
      if (!g) throw new HttpError(404, 'Geschenkkarte nicht gefunden.');
      if (g.data.redeemed) throw new HttpError(409, 'Diese Karte wurde schon eingelöst.');
      const cents = Number(g.data.valueCents) || 0;
      return {
        writes: [
          writeDoc(env, `giftCards/${code}`, { redeemed: true, redeemedBy: user.uid }, { merge: true, serverTime: ['redeemedAt'], exists: true }),
          writeDoc(env, `users/${user.uid}`, { email: user.email || '' }, { merge: true, increment: { balanceCents: cents }, serverTime: ['updatedAt'] }),
        ],
        result: { valueCents: cents },
      };
    });
  },

  async subscribePush(env, user, b) {
    // Web Push braucht VAPID. Schlüssel: `npx web-push generate-vapid-keys`
    // Öffentlicher Schlüssel in index.html PUSH_VAPID_PUBLIC_KEY, privater Schlüssel:
    // npx wrangler secret put VAPID_PRIVATE_KEY
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'Push ist noch nicht eingerichtet.');
    const endpoint = str(b.endpoint, 500);
    if (!endpoint.startsWith('https://')) throw new HttpError(400, 'Abo ungültig.');
    await fsCommit(env, [writeDoc(env, `pushSubs/${user.uid}`, { endpoint, uid: user.uid }, { serverTime: ['updatedAt'] })]);
    return { ok: true };
  },

  async adminTotpSetup(env, user, b) {
    await assertAdmin(env, user, b, { allowWithoutCode: true });
    const existing = await fsGet(env, `adminTotp/${user.uid}`);
    if (existing && existing.data.enabled) throw new HttpError(409, 'Zwei-Faktor ist schon aktiv.');
    const secret = randomBase32(20);
    await fsCommit(env, [writeDoc(env, `adminTotp/${user.uid}`, { secret, enabled: false }, { serverTime: ['updatedAt'] })]);
    const label = encodeURIComponent('Val3ntino:' + (user.email || user.uid));
    return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Val3ntino&digits=6&period=30` };
  },

  async adminTotpConfirm(env, user, b) {
    if (!user.admin) throw new HttpError(403, 'Kein Admin-Zugriff.');
    const sec = await fsGet(env, `adminTotp/${user.uid}`);
    if (!sec) throw new HttpError(400, 'Bitte zuerst einrichten.');
    if (!(await verifyTotp(sec.data.secret, b.totp))) throw new HttpError(401, 'Code stimmt nicht.');
    await fsCommit(env, [writeDoc(env, `adminTotp/${user.uid}`, { enabled: true }, { merge: true, serverTime: ['enabledAt'] })]);
    return { ok: true };
  },

  async adminUpsert(env, user, b) {
    await assertAdmin(env, user, b);
    const col = str(b.collection, 40);
    if (!CMS_COLLECTIONS.has(col)) throw new HttpError(400, 'Diese Sammlung ist nicht freigegeben.');
    const id = str(b.id, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Ungültige ID.');
    const data = sanitizeCms(b.data);
    await fsCommit(env, [writeDoc(env, `${col}/${id}`, data, { merge: true, serverTime: ['updatedAt'] })]);
    return { ok: true, id };
  },

  async adminDeleteContent(env, user, b) {
    await assertAdmin(env, user, b);
    const col = str(b.collection, 40);
    if (!CMS_COLLECTIONS.has(col) || col === 'siteSettings') throw new HttpError(400, 'Löschen hier nicht erlaubt.');
    const id = str(b.id, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Ungültige ID.');
    await fsCommit(env, [deleteDoc(env, `${col}/${id}`)]);
    return { ok: true };
  },

  async adminSetRole(env, user, b) {
    if (!isOwner(user)) throw new HttpError(403, 'Nur das Inhaber-Konto vergibt Rollen.');
    await assertAdmin(env, user, b);
    const uid = str(b.uid, 128);
    const role = str(b.role, 20);
    if (!uid || !['editor', 'support', 'owner'].includes(role)) throw new HttpError(400, 'Rolle ungültig.');
    await fsCommit(env, [writeDoc(env, `admins/${uid}`, { email: str(b.email, 120), role }, { serverTime: ['updatedAt'] })]);
    return { ok: true };
  },

  async myReferral(env, user) {
    const existing = await fsGet(env, `users/${user.uid}`);
    const current = cleanRef(existing && existing.data.refCode);
    if (current) return { code: current };
    const code = cleanRef('V' + user.uid.replace(/[^A-Za-z0-9]/g, '').slice(0, 6) + randomId().slice(0, 4));
    await fsCommit(env, [
      writeDoc(env, `users/${user.uid}`, { email: user.email || '', refCode: code }, { merge: true }),
      writeDoc(env, `referrals/${code}`, { uid: user.uid, email: user.email || '', clicks: 0, orders: 0 }, { exists: false }),
    ]);
    return { code };
  },

  async adminListAdmins(env, user, b) {
    await assertAdmin(env, user, b);
    const rows = await fsList(env, 'admins', 50);
    const admins = rows.filter(r => r.data.active !== false).map(r => ({ uid: r.id, email: r.data.email || '', role: r.data.role || 'admin' }));
    if (!admins.some(a => String(a.email).toLowerCase() === OWNER_EMAIL)) admins.unshift({ uid: 'owner', email: OWNER_EMAIL, role: 'owner' });
    return { admins, owner: isOwner(user) };
  },

  async adminGrantAdmin(env, user, b) {
    await assertAdmin(env, user, b);
    const email = mailOk(b.email);
    if (!email) throw new HttpError(400, 'Ungültige E-Mail.');
    if (email === OWNER_EMAIL) return { ok: true, owner: true };
    const found = await lookupUserByEmail(env, email);
    if (!found || !found.localId) throw new HttpError(404, 'Kein Konto mit dieser E-Mail. Die Person muss sich einmal im Shop registrieren.');
    await setAdminClaim(env, found.localId, true, found.customAttributes);
    await fsCommit(env, [
      writeDoc(env, `admins/${found.localId}`, { email, role: 'admin', active: true }, { serverTime: ['updatedAt'] }),
      writeDoc(env, `adminAudit/${randomId()}`, { actorUid: user.uid, actorEmail: user.email || '', targetUid: found.localId, targetEmail: email, action: 'grant' }, { serverTime: ['at'], exists: false }),
    ]);
    return { ok: true };
  },

  async adminRevokeAdmin(env, user, b) {
    if (!isOwner(user)) throw new HttpError(403, 'Nur der Inhaber darf Admins entfernen.');
    await assertAdmin(env, user, b);
    const email = mailOk(b.email);
    if (!email) throw new HttpError(400, 'Ungültige E-Mail.');
    if (email === OWNER_EMAIL) throw new HttpError(400, 'Das Inhaber-Konto bleibt Admin.');
    const found = await lookupUserByEmail(env, email);
    if (!found || !found.localId) throw new HttpError(404, 'Kein Konto mit dieser E-Mail.');
    await setAdminClaim(env, found.localId, false, found.customAttributes);
    await fsCommit(env, [
      writeDoc(env, `admins/${found.localId}`, { email, active: false }, { merge: true, serverTime: ['updatedAt'] }),
      writeDoc(env, `adminAudit/${randomId()}`, { actorUid: user.uid, actorEmail: user.email || '', targetUid: found.localId, targetEmail: email, action: 'revoke' }, { serverTime: ['at'], exists: false }),
    ]);
    return { ok: true };
  },

  async adminListSubscribers(env, user, b) {
    await assertAdmin(env, user, b);
    const rows = await fsList(env, 'subscribers', 200);
    return { subscribers: rows.map(r => ({ email: r.data.email || r.id })) };
  },

  async adminSetDiscordWebhook(env, user, b) {
    if (!isOwner(user)) throw new HttpError(403, 'Nur der Inhaber speichert die Webhook-Adresse.');
    await assertAdmin(env, user, b);
    const url = str(b.webhookUrl, 300).trim();
    if (url && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w.-]+$/.test(url)) throw new HttpError(400, 'Das ist keine Discord-Webhook-Adresse.');
    await fsCommit(env, [writeDoc(env, 'privateConfig/discord', { webhookUrl: url }, { merge: true })]);
    return { ok: true, stored: !!url };
  },

  async adminListReferrals(env, user, b) {
    await assertAdmin(env, user, b);
    const rows = await fsList(env, 'referrals', 100);
    return { referrals: rows.map(r => ({ code: r.id, email: r.data.email || '', clicks: Number(r.data.clicks) || 0, orders: Number(r.data.orders) || 0 })) };
  },

  async postChat(env, user, b) {
    const text = str(b.text, 800).trim();
    if (!text) throw new HttpError(400, 'Nachricht ist leer.');
    const id = user.uid;
    const cur = await fsGet(env, `liveThreads/${id}`);
    const messages = Array.isArray(cur && cur.data.messages) ? cur.data.messages.slice(-40) : [];
    messages.push({ from: 'customer', text, at: Date.now() });
    await fsCommit(env, [writeDoc(env, `liveThreads/${id}`, { email: user.email || '', messages })]);
    return { ok: true };
  },

  async adminReplyChat(env, user, b) {
    await assertAdmin(env, user, b);
    const id = str(b.uid, 128);
    const text = str(b.text, 800).trim();
    if (!id || !text) throw new HttpError(400, 'Empfänger oder Text fehlt.');
    const cur = await fsGet(env, `liveThreads/${id}`);
    if (!cur) throw new HttpError(404, 'Kein Gespräch.');
    const messages = Array.isArray(cur.data.messages) ? cur.data.messages.slice(-40) : [];
    messages.push({ from: 'admin', text, at: Date.now() });
    await fsCommit(env, [writeDoc(env, `liveThreads/${id}`, { messages }, { merge: true })]);
    return { ok: true };
  },

  async adminListThreads(env, user, b) {
    await assertAdmin(env, user, b);
    const rows = await fsList(env, 'liveThreads', 30);
    return { threads: rows.map(r => ({ id: r.id, email: r.data.email || '', updated: r.data.messages && r.data.messages.length })) };
  },

  async createTicket(env, user, b) {
    const subject = str(b.subject, 120).trim();
    const text = str(b.text, 2000).trim();
    if (!subject || !text) throw new HttpError(400, 'Betreff und Text braucht es.');
    const id = randomId();
    await fsCommit(env, [writeDoc(env, `tickets/${id}`, { uid: user.uid, email: user.email || '', subject, status: 'offen', messages: [{ from: 'customer', text, at: Date.now() }] }, { exists: false })]);
    return { id };
  },

  async myTickets(env, user) {
    const rows = await fsList(env, 'tickets', 40);
    return { tickets: rows.filter(r => r.data.uid === user.uid).map(r => ({ id: r.id, subject: r.data.subject, status: r.data.status, messages: r.data.messages || [] })) };
  },

  async adminReplyTicket(env, user, b) {
    await assertAdmin(env, user, b);
    const id = str(b.id, 40);
    const text = str(b.text, 2000).trim();
    const cur = await fsGet(env, `tickets/${id}`);
    if (!cur) throw new HttpError(404, 'Ticket nicht gefunden.');
    const messages = Array.isArray(cur.data.messages) ? cur.data.messages.slice(-30) : [];
    messages.push({ from: 'admin', text, at: Date.now() });
    await fsCommit(env, [writeDoc(env, `tickets/${id}`, { messages, status: str(b.status, 20) || 'beantwortet' }, { merge: true })]);
    return { ok: true };
  },

  async startMembership(env, user) {
    const settings = await fsGet(env, 'siteSettings/main');
    const plan = settings && settings.data && settings.data.paypalPlanId;
    // PayPal-Abo braucht eine Plan-ID aus dem PayPal-Dashboard. Krypto kann nicht zuverlässig wiederkehrend eingezogen werden.
    if (!plan) throw new HttpError(503, 'PayPal-Abo-Plan ist in den Einstellungen noch leer.');
    await fsCommit(env, [writeDoc(env, `memberships/${user.uid}`, { email: user.email || '', planId: String(plan), status: 'vorgemerkt' }, { serverTime: ['updatedAt'] })]);
    return { ok: true, planId: String(plan), note: 'Der eigentliche Einzug läuft über PayPal Subscriptions. Krypto-Abos sind nicht automatisch.' };
  },

  async joinStockAlert(env, user, b) {
    const productId = str(b.productId, 40);
    if (!/^[a-z0-9_-]{2,32}$/.test(productId)) throw new HttpError(400, 'Produkt unbekannt.');
    await fsCommit(env, [writeDoc(env, `stockAlerts/${user.uid}_${productId}`, { uid: user.uid, email: user.email || '', productId, active: true })]);
    // SMTP: hier eine Mail schicken, sobald der Bestand von 0 auf >0 wechselt. Der Worker hat keinen Mailversand.
    return { ok: true };
  },

  async exportMyData(env, user) {
    const orders = await fsQuery(env, 'orders', [['uid', user.uid]], 50);
    const tickets = (await fsList(env, 'tickets', 40)).filter(r => r.data.uid === user.uid);
    const chat = await fsGet(env, `liveThreads/${user.uid}`);
    const help = await fsGet(env, `supportChats/${user.uid}`);
    return {
      email: user.email,
      orders: orders.map(r => ({ id: r.id, invoice: r.data.invoice, totalCents: r.data.totalCents, status: r.data.status })),
      tickets: tickets.map(r => ({ id: r.id, subject: r.data.subject, status: r.data.status })),
      chat: chat ? chat.data.messages || [] : [],
      help: help ? help.data.messages || [] : [],
    };
  },

  async deleteMyAccount(env, user) {
    const orders = await fsQuery(env, 'orders', [['uid', user.uid]], 50);
    const writes = [
      deleteDoc(env, `liveThreads/${user.uid}`),
      deleteDoc(env, `supportChats/${user.uid}`),
      deleteDoc(env, `memberships/${user.uid}`),
    ];
    for (const o of orders) {
      writes.push(writeDoc(env, `orders/${o.id}`, { email: 'gelöscht@invalid', uid: user.uid }, { merge: true }));
    }
    await fsCommit(env, writes);
    // Rechnungen bleiben anonymisiert (steuerliche Aufbewahrung). Auth-Konto löscht der Browser über Firebase.
    return { ok: true, kept: 'Bestellungen bleiben ohne E-Mail gespeichert.' };
  },

  async issueDownload(env, user, b) {
    const orderId = str(b.orderId, 40);
    const productId = str(b.productId, 48);
    const order = await getOwnOrder(env, user, orderId);
    if (order.status !== 'bezahlt' && order.status !== 'geliefert') throw new HttpError(402, 'Die Bestellung ist noch nicht bezahlt.');
    const owns = (order.items || []).some(l => l.productId === productId) || (order.delivery || []).some(d => d.downloadKey === productId || d.productId === productId);
    if (!owns) throw new HttpError(404, 'Kein PDF für diese Bestellung.');
    if (!(await readAsset(env, pdfKey(productId)))) throw new HttpError(503, 'Die PDF-Datei liegt noch nicht im Speicher.');
    const token = await signDownload(env, { orderId, productId, uid: user.uid, exp: Date.now() + 15 * 60 * 1000 });
    return { token, productId, orderId };
  },
};
routes.createGiftCardPayPal = (env, u, b) => routes.createPayPalOrder(env, u, { ...b, kind: 'giftcard' });
routes.createGiftCardCrypto = (env, u, b) => routes.createTopUp(env, u, { ...b, kind: 'giftcard' });
routes.verifyTopUp = routes.verifyCryptoOrder;            // Alias: Krypto-Aufladung prüfen
routes.createPayPalTopUp = (env, u, b) => routes.createPayPalOrder(env, u, { ...b, kind: 'topup' });
routes.capturePayPalTopUp = routes.capturePayPalOrder;

async function assertAdmin(env, user, b, opts = {}) {
  if (!user.admin) throw new HttpError(403, 'Kein Admin-Zugriff.');
  if (opts.allowWithoutCode) return;
  const sec = await fsGet(env, `adminTotp/${user.uid}`);
  if (sec && sec.data && sec.data.enabled) {
    if (!(await verifyTotp(sec.data.secret, b && b.totp))) throw new HttpError(401, 'Zwei-Faktor-Code fehlt oder ist ungültig.');
  }
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

async function publicShop(name, request, env, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!rateLimit(ip, name, name === 'recentSales' ? 30 : 8, 60_000)) return json({ error: 'Zu viele Anfragen.' }, 429, cors);
  let body = {};
  const text = await request.text();
  if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Ungültiges JSON.'); } }
  if (name === 'subscribeNewsletter') {
    if (body.company) return json({ ok: true }, 200, cors);
    const email = mailOk(body.email);
    if (!email) throw new HttpError(400, 'Bitte eine gültige E-Mail angeben.');
    const id = email.replace(/\//g, '');
    const cur = await fsGet(env, `subscribers/${id}`);
    if (cur) return json({ ok: true, duplicate: true }, 200, cors);
    await fsCommit(env, [writeDoc(env, `subscribers/${id}`, { email }, { serverTime: ['createdAt'], exists: false })]);
    await notifyNewsletter(env);
    return json({ ok: true, duplicate: false }, 200, cors);
  }
  if (name === 'trackReferral') {
    const code = cleanRef(body.code);
    if (!code) throw new HttpError(400, 'Code ungültig.');
    const cur = await fsGet(env, `referrals/${code}`);
    if (!cur) return json({ ok: true, known: false }, 200, cors);
    await fsCommit(env, [writeDoc(env, `referrals/${code}`, {}, { merge: true, increment: { clicks: 1 } })]);
    return json({ ok: true, known: true }, 200, cors);
  }
  const rows = await fsList(env, 'orders', 40);
  const sales = [];
  for (const row of rows) {
    const o = row.data || {};
    if (o.kind === 'topup' || o.kind === 'giftcard') continue;
    if (o.status !== 'bezahlt' && o.status !== 'geliefert') continue;
    const item = Array.isArray(o.items) ? o.items[0] : null;
    sales.push({ product: String((item && item.name) || 'ein Produkt').slice(0, 80) });
    if (sales.length >= 8) break;
  }
  return json({ sales }, 200, cors);
}

async function handleAdminAsset(request, env, cors) {
  const user = await verifyFirebaseToken(request, env);
  const url = new URL(request.url);
  await assertAdmin(env, user, { totp: url.searchParams.get('totp') || '' });
  if (!user.admin) throw new HttpError(403, 'Nur ein Admin darf Dateien hochladen.');
  if (!env.ASSETS) throw new HttpError(503, 'KV-Namespace ASSETS ist nicht gebunden.');
  const key = str(url.searchParams.get('key'), 64);
  if (!/^(cover|pdf):[a-z0-9-]{2,48}$/.test(key)) throw new HttpError(400, 'Ungültiger Dateischlüssel.');
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (key.startsWith('pdf:') && type !== 'application/pdf') throw new HttpError(400, 'PDF braucht Content-Type application/pdf.');
  if (key.startsWith('cover:') && !['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new HttpError(400, 'Cover braucht PNG, JPEG oder WebP.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 8000000) throw new HttpError(413, 'Datei fehlt oder ist größer als 8 MB.');
  await env.ASSETS.put(key, bytes, { metadata: { contentType: type } });
  return json({ ok: true, key, bytes: bytes.byteLength }, 200, cors);
}

async function servePaidPdf(request, env, orderId, url, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!rateLimit(ip, 'download', 30, 60_000)) return json({ error: 'Zu viele Downloads.' }, 429, cors);
  const productId = url.searchParams.get('product') || '';
  try {
    const payload = await verifyDownload(env, url.searchParams.get('token'), orderId, productId);
    if (!payload) return json({ error: 'Download-Link ungültig oder abgelaufen.' }, 401, cors);
    const order = await fsGet(env, `orders/${orderId}`);
    if (!order || order.data.uid !== payload.uid) return json({ error: 'Bestellung nicht gefunden.' }, 404, cors);
    if (order.data.status !== 'bezahlt' && order.data.status !== 'geliefert') return json({ error: 'Bestellung ist nicht bezahlt.' }, 402, cors);
    const owns = (order.data.items || []).some(l => l.productId === productId);
    const bytes = await readAsset(env, pdfKey(productId));
    if (!owns || !bytes) return json({ error: 'Keine passende Datei.' }, 404, cors);
    return new Response(bytes, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdfFilename(productId)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
    return json({ error: 'Download fehlgeschlagen.' }, 500, cors);
  }
}

/* ---------- HTTP ---------- */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, manual: { ETH: env.ETH_ADDRESS || '', BTC: env.BTC_ADDRESS || '' }, push: !!env.VAPID_PUBLIC_KEY, discord: !!env.DISCORD_PUBLIC_KEY }, 200, cors);
    // Staging safety lock: never process payments, orders, Firestore writes or Discord actions.
    // Only the read-only health endpoint is enabled until isolated test credentials exist.
    if (env.TEST_MODE === 'true') return json({ error: 'Testmodus: API-Aktionen deaktiviert.' }, 503, cors);
    if (url.pathname === '/discord/interactions' && request.method === 'POST') {
      const rawBody = await request.text();
      return handleDiscordInteraction(request, env, rawBody);
    }
    const coverMatch = url.pathname.match(/^\/asset\/cover\/([a-z0-9_-]+)$/);
    if (coverMatch && request.method === 'GET') {
      const asset = await readAssetMeta(env, coverKey(coverMatch[1]));
      return new Response((asset && asset.bytes) || PLACEHOLDER_PNG, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': (asset && asset.contentType) || 'image/png',
          'Cache-Control': asset ? 'public, max-age=3600' : 'no-store',
        },
      });
    }
    if (url.pathname === '/api/admin-asset' && request.method === 'POST') {
      try { return await handleAdminAsset(request, env, cors); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
        return json({ error: 'Upload fehlgeschlagen.' }, 500, cors);
      }
    }
    const downloadMatch = url.pathname.match(/^\/api\/download\/([A-Za-z0-9]{10,40})$/);
    if (downloadMatch && request.method === 'GET') return servePaidPdf(request, env, downloadMatch[1], url, cors);
    const origin = request.headers.get('Origin');
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'Origin nicht erlaubt.' }, 403, cors);
    const m = url.pathname.match(/^\/api\/([A-Za-z]+)$/);
    if (m && (m[1] === 'subscribeNewsletter' || m[1] === 'trackReferral' || m[1] === 'recentSales')) {
      if (request.method !== 'POST') return json({ error: 'Nur POST.' }, 405, cors);
      try { return await publicShop(m[1], request, env, cors); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
        return json({ error: 'Anfrage fehlgeschlagen.' }, 500, cors);
      }
    }
    if (!m || (m[1] !== 'trackVisit' && !Object.prototype.hasOwnProperty.call(routes, m[1]))) return json({ error: 'Nicht gefunden.' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Nur POST.' }, 405, cors);
    try {
      if (m[1] === 'trackVisit') {
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        if (!rateLimit(ip, 'trackVisit', 5, 60_000)) return json({ ok: true }, 200, cors);
        const day = new Date().toISOString().slice(0, 10);
        const cur = await fsGet(env, `analytics/${day}`);
        const n = (cur && Number(cur.data.visits)) || 0;
        await fsCommit(env, [writeDoc(env, `analytics/${day}`, { visits: n + 1 })]);
        return json({ ok: true }, 200, cors);
      }
      const user = await verifyFirebaseToken(request, env);
      let body = {};
      const text = await request.text();
      if (text.length > 20000) throw new HttpError(413, 'Anfrage zu groß.');
      if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Ungültiges JSON.'); } }
      if (!body || typeof body !== 'object') body = {};
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      // Drossel gilt nur im jeweiligen Worker-Isolate. Für harte Limits: Cloudflare Rate Limiting oder KV.
      if (/^(create|capture|pay|verify|redeem|admin|subscribe|export|delete|join)/.test(m[1]) && !rateLimit(ip, m[1], 20, 60_000)) {
        return json({ error: 'Zu viele Anfragen. Bitte eine Minute warten.' }, 429, cors);
      }
      const result = await routes[m[1]](env, user, body);
      return json(result ?? { ok: true }, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error('Unerwarteter Fehler', m[1], e && e.stack || e);
      return json({ error: 'Interner Fehler. Bitte später erneut versuchen.' }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    // Never let staging cron jobs read or mutate production Firestore data.
    if (env.TEST_MODE === 'true') return;
    if (event.cron === '0 3 * * *') ctx.waitUntil(backupTick(env));
    else ctx.waitUntil(recheckOpenCryptoOrders(env).then(r => console.log('Cron', JSON.stringify(r))));
  },
};
