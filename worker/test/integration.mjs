// Lokaler Integrationstest mit gemocktem Firestore/Google/PayPal/Solana (kein Netz, kein Deploy).
import { generateKeyPair, exportJWK, SignJWT, exportPKCS8 } from 'jose';
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const saKey = await generateKeyPair('RS256', { extractable: true });
const env = {
  FIREBASE_PROJECT_ID: 'valentinolopezde', MERCHANT_WALLET: '5fzfBAiPfJ8y6s9jCBbypsVLNFUd9rLVEQHzewdHcxBD',
  PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec',
  ALLOWED_ORIGINS: 'https://valentinolopez.de,http://localhost:5500',
  GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: await exportPKCS8(saKey.privateKey), private_key_id: 'p1' }),
};
// ---- In-Memory-Firestore ----
const store = new Map(); // name -> fields
const PFX = 'projects/valentinolopezde/databases/(default)/documents/';
let paypalCaptured = false, solanaPaid = false;
function applyWrite(w) {
  if (w.delete) { store.delete(w.delete); return; }
  const name = w.update.name; const exists = store.has(name);
  if (w.currentDocument && w.currentDocument.exists !== exists) { const e = new Error('precondition'); e.code = 'FAILED_PRECONDITION'; throw e; }
  let fields = w.updateMask ? { ...(store.get(name) || {}) } : {};
  if (w.updateMask) for (const p of w.updateMask.fieldPaths) { if (p in w.update.fields) fields[p] = w.update.fields[p]; else delete fields[p]; }
  else fields = { ...w.update.fields };
  for (const t of w.updateTransforms || []) {
    if (t.increment) fields[t.fieldPath] = { integerValue: String(Number(fields[t.fieldPath]?.integerValue || 0) + Number(t.increment.integerValue)) };
    if (t.setToServerValue) fields[t.fieldPath] = { timestampValue: new Date().toISOString() };
  }
  store.set(name, fields);
}
const resp = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url || input); const body = init.body ? (typeof init.body === 'string' ? init.body : String(init.body)) : '';
  if (url.includes('securetoken@system')) return resp({ keys: [jwk] });
  if (url === 'https://oauth2.googleapis.com/token') return resp({ access_token: 'at', expires_in: 3600 });
  if (url.includes('coingecko')) return resp({ solana: { eur: 150 }, 'usd-coin': { eur: 0.92 } });
  if (url.includes('api-m.sandbox.paypal.com')) {
    if (url.endsWith('/v1/oauth2/token')) return resp({ access_token: 'pp' });
    if (url.endsWith('/v2/checkout/orders')) { const b = JSON.parse(body); globalThis.__pp = b; return resp({ id: 'PP123' }); }
    if (url.endsWith('/capture')) { paypalCaptured = true; const pu = globalThis.__pp.purchase_units[0];
      return resp({ status: 'COMPLETED', purchase_units: [{ custom_id: pu.custom_id, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: pu.amount }] } }] }); }
  }
  if (url.includes('mainnet') || url.includes('solana')) {
    const b = JSON.parse(body);
    if (b.method === 'getLatestBlockhash') return resp({ result: { value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1 } } });
    if (b.method === 'getSignaturesForAddress') return resp({ result: solanaPaid ? [{ signature: 'SIG1', err: null, confirmationStatus: 'confirmed', blockTime: Math.floor(Date.now() / 1000) }] : [] });
    if (b.method === 'getTransaction') { const o = [...store.values()].map(f => f).find(f => f.crypto && f.crypto.mapValue.fields.reference.stringValue === globalThis.__ref);
      const lam = Number(String(o.crypto.mapValue.fields.amount.stringValue).replace('.', '')) * 1000;
      return resp({ result: { meta: { err: null, preBalances: [5e9, 0, 0], postBalances: [5e9 - lam, lam, 0], preTokenBalances: [], postTokenBalances: [] },
        transaction: { message: { accountKeys: [{ pubkey: 'buyer' }, { pubkey: env.MERCHANT_WALLET }, { pubkey: globalThis.__ref }] } } } }); }
  }
  if (url.startsWith('https://firestore.googleapis.com/v1/')) {
    const path = url.slice('https://firestore.googleapis.com/v1/'.length);
    if (path.endsWith(':beginTransaction')) return resp({ transaction: 'tx1' });
    if (path.endsWith(':rollback')) return resp({});
    if (path.endsWith(':commit')) { const b = JSON.parse(body); const snap = new Map(store);
      try { for (const w of b.writes) applyWrite(w); } catch (e) { store.clear(); for (const [k, v] of snap) store.set(k, v); return resp({ error: { status: e.code, message: 'x' } }, 400); }
      return resp({ writeResults: [] }); }
    if (path.endsWith(':runQuery')) { const b = JSON.parse(body); const coll = b.structuredQuery.from[0].collectionId;
      const fl = b.structuredQuery.where.compositeFilter ? b.structuredQuery.where.compositeFilter.filters : [b.structuredQuery.where];
      const out = [...store.entries()].filter(([n, f]) => n.startsWith(PFX + coll + '/') && fl.every(x => f[x.fieldFilter.field.fieldPath]?.stringValue === x.fieldFilter.value.stringValue))
        .map(([n, f]) => ({ document: { name: n, fields: f } }));
      return resp(out); }
    if ((init.method || 'GET') === 'GET') { const name = path.split('?')[0]; const f = store.get(name);
      return f ? resp({ name, fields: f, updateTime: 'x' }) : resp({ error: { status: 'NOT_FOUND' } }, 404); }
  }
  throw new Error('unmocked ' + url);
};
// Getestet wird das echte esbuild-Bundle (Worker-Build von jose nutzt fetch -> mockbar)
const mod = await import('../dist/index.js');
const worker = mod.default;
const token = async (claims = {}) => new SignJWT({ email: 'kunde@test.de', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer('https://securetoken.google.com/valentinolopezde').setAudience('valentinolopezde').setSubject(claims.sub || 'uid1')
  .setIssuedAt().setExpirationTime('1h').sign(privateKey);
async function call(name, body, tok, origin = 'https://valentinolopez.de') {
  const h = { 'Content-Type': 'application/json', Origin: origin }; if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await worker.fetch(new Request('https://api.example/api/' + name, { method: 'POST', headers: h, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json(), acao: r.headers.get('Access-Control-Allow-Origin') };
}
let fail = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++; };
const t = await token();  const adminT = await token({ admin: true, sub: 'adminuid', email: 'l@valentinolopez.de' });
const user = (id) => store.get(PFX + 'users/' + id);

ok((await call('quoteCart', {}, null)).status === 401, 'ohne Token -> 401');
ok((await call('quoteCart', {}, 'abc.def.ghi')).status === 401, 'gefälschtes Token -> 401');
const wrongAud = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/other').setAudience('other').setSubject('x').setIssuedAt().setExpirationTime('1h').sign(privateKey);
ok((await call('quoteCart', {}, wrongAud)).status === 401, 'falsches aud/iss -> 401');
ok((await call('quoteCart', { items: [{ id: 'basic', qty: 1 }] }, t, 'https://evil.com')).status === 403, 'fremde Origin -> 403');
const pre = await worker.fetch(new Request('https://api.example/api/quoteCart', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5500' } }), env);
ok(pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === 'http://localhost:5500', 'CORS-Preflight localhost');

// Gutscheine (Admin)
ok((await call('adminSaveCoupon', { code: 'SAVE5', valueCents: 500 }, t)).status === 403, 'Gutschein ohne Admin -> 403');
ok((await call('adminSaveCoupon', { code: 'save5', valueCents: 500 }, adminT)).status === 200, 'Admin legt Gutschein an');
let q = await call('quoteCart', { items: [{ id: 'basic', qty: 2 }], coupon: 'SAVE5' }, t);
ok(q.body.totalCents === 2500 && q.body.discountCents === 500, 'quoteCart mit Gutschein = 25,00 €');
ok((await call('quoteCart', { items: [{ id: 'media', qty: 1 }] }, t)).status === 400, 'Media-Produkt nicht im Server-Katalog -> 400');
ok((await call('quoteCart', { items: [{ id: 'basic', qty: 1, price: 0.01 }] }, t)).body.totalCents === 1500, 'Client-Preis ignoriert');

// Guthaben: zu wenig
ok((await call('payWithBalance', { items: [{ id: 'basic', qty: 1 }] }, t)).status === 402, 'payWithBalance ohne Guthaben -> 402');

// PayPal-Aufladung 20 €
let r = await call('createPayPalOrder', { kind: 'topup', amountEUR: 20 }, t);
ok(r.status === 200 && r.body.paypalOrderId === 'PP123', 'PayPal-Aufladung angelegt');
ok((await call('createPayPalOrder', { kind: 'topup', amountEUR: 1 }, t)).status === 400, 'Aufladung < 5 € abgelehnt');
const ppId = r.body.orderId;
ok((await call('capturePayPalOrder', { orderId: ppId }, adminT)).status === 404, 'fremde Bestellung -> 404');
r = await call('capturePayPalOrder', { orderId: ppId }, t);
ok(r.body.status === 'geliefert' && Number(user('uid1').balanceCents.integerValue) === 2000, 'Capture -> 20 € gutgeschrieben');
r = await call('capturePayPalOrder', { orderId: ppId }, t);
ok(Number(user('uid1').balanceCents.integerValue) === 2000, 'zweites Capture bucht nicht doppelt');

// Mit Guthaben zahlen (15 €)
r = await call('payWithBalance', { items: [{ id: 'basic', qty: 1 }] }, t);
ok(r.status === 200 && Number(user('uid1').balanceCents.integerValue) === 500, 'payWithBalance: 20 € - 15 € = 5 €');
const o1 = store.get(PFX + 'orders/' + r.body.orderId);
ok(o1.status.stringValue === 'geliefert' && o1.delivery.arrayValue.values.length === 1, 'Bestellung geliefert + Lieferinhalt');

// Krypto-Bestellung
r = await call('createCryptoOrder', { items: [{ id: 'pro', qty: 1 }], token: 'SOL' }, t);
ok(r.status === 200 && r.body.amount === '0.233334' && r.body.url.startsWith('solana:5fzf'), 'Krypto-Bestellung: 35 € @150 = 0.233334 SOL');
const cId = r.body.orderId; globalThis.__ref = r.body.reference;
const b = await call('buildCryptoTransaction', { orderId: cId, account: env.MERCHANT_WALLET }, t);
ok(b.body.blockhash && b.body.decimals === 9, 'buildCryptoTransaction liefert Parameter + Blockhash');
r = await call('verifyCryptoOrder', { orderId: cId }, t);
ok(r.body.pending === true && r.body.status === 'offen', 'unbezahlt -> pending (kein Fake-Erfolg)');
solanaPaid = true;
r = await call('verifyCryptoOrder', { orderId: cId }, t);
ok(r.body.status === 'geliefert', 'bezahlt -> geliefert');
ok(store.has(PFX + 'usedSignatures/SIG1'), 'Signatur als verwendet gespeichert');
// gleiche Signatur für andere Bestellung
const r2 = await call('createTopUp', { amountEUR: 10, token: 'SOL' }, t);
globalThis.__ref = r2.body.reference;
const v2 = await call('verifyTopUp', { orderId: r2.body.orderId }, t);
ok(v2.status === 409, 'Wiederverwendete Signatur -> 409');
ok(Number(user('uid1').balanceCents.integerValue) === 500, 'kein Guthaben durch Replay');

// Cron: Ablauf
solanaPaid = false;
const ord = store.get(PFX + 'orders/' + r2.body.orderId); ord.expiresAt = { timestampValue: new Date(Date.now() - 1000).toISOString() };
const { recheckOpenCryptoOrders } = mod;
const cr = await recheckOpenCryptoOrders(env);
ok(cr.expired === 1 && store.get(PFX + 'orders/' + r2.body.orderId).status.stringValue === 'abgelaufen', 'Cron: nach 30 Min. abgelaufen');

// Admin-Status
ok((await call('adminSetOrderStatus', { orderId: cId, status: 'storniert' }, t)).status === 403, 'Status ändern ohne Admin -> 403');
ok((await call('adminSetOrderStatus', { orderId: cId, status: 'storniert' }, adminT)).status === 200 && store.get(PFX + 'orders/' + cId).status.stringValue === 'storniert', 'Admin setzt Status');
ok((await call('adminDeleteCoupon', { code: 'SAVE5' }, adminT)).status === 200 && !store.has(PFX + 'coupons/SAVE5'), 'Admin löscht Gutschein');
process.exit(fail ? 1 : 0);
