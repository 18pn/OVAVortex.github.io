// Solana ohne schwere SDKs: direkte JSON-RPC-Aufrufe + kleine Base58/BigInt-Helfer.
// Es wird KEIN privater Schlüssel benötigt – nur die öffentliche Händleradresse.
import { HttpError } from './util.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKENS = {
  SOL:  { symbol: 'SOL',  decimals: 9, mint: null,      coingeckoId: 'solana',   roundTo: 6 },
  USDC: { symbol: 'USDC', decimals: 6, mint: USDC_MINT, coingeckoId: 'usd-coin', roundTo: 2 },
};
export const AMOUNT_TOLERANCE_PPM = 1000n; // 0,1 % Toleranz (Rundung)

/* ---------- Base58 ---------- */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === '1') out.unshift(0); else break; }
  return new Uint8Array(out);
}
export function isPubkey(s) {
  try { return typeof s === 'string' && s.length >= 32 && s.length <= 44 && base58Decode(s).length === 32; } catch { return false; }
}
/** Neue, eindeutige Referenz (zufällige 32 Byte; dient nur als Suchschlüssel, kein Schlüsselpaar nötig). */
export function newReference() { return base58Encode(crypto.getRandomValues(new Uint8Array(32))); }

/* ---------- Dezimal <-> Basiseinheiten (BigInt, keine Float-Fehler) ---------- */
export function toBaseUnits(amountStr, decimals) {
  const m = String(amountStr).match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('bad amount');
  const frac = (m[2] || '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error('too many decimals');
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
function formatScaled(n, places) {
  const s = n.toString().padStart(places + 1, '0');
  return places ? s.slice(0, -places) + '.' + s.slice(-places) : s;
}

/* ---------- Kurs (CoinGecko) ---------- */
let rateCache = { ts: 0, data: null };
export async function getEurRates() {
  if (rateCache.data && Date.now() - rateCache.ts < 60_000) return rateCache.data;
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=eur', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(503, 'Kurs momentan nicht verfügbar. Bitte gleich erneut versuchen.');
  const j = await res.json();
  const data = { SOL: Number(j?.solana?.eur), USDC: Number(j?.['usd-coin']?.eur) };
  if (!(data.SOL > 0) || !(data.USDC > 0)) throw new HttpError(503, 'Kurs momentan nicht verfügbar. Bitte gleich erneut versuchen.');
  rateCache = { ts: Date.now(), data };
  return data;
}

/** Euro-Cent -> Token-Betrag (aufgerundet, damit nie zu wenig verlangt wird). */
export function quoteFromRate(totalCents, tokenSymbol, rateEUR) {
  const token = TOKENS[tokenSymbol];
  if (!token) throw new HttpError(400, 'Ungültige Kryptowährung.');
  const rateMicro = BigInt(Math.round(rateEUR * 1e6));              // EUR je Token * 1e6
  const num = BigInt(totalCents) * 10n ** BigInt(token.roundTo) * 1_000_000n;
  const den = rateMicro * 100n;
  const scaled = (num + den - 1n) / den;                             // Aufrunden
  return { amount: formatScaled(scaled, token.roundTo), rateEUR, token };
}
export async function quote(totalCents, tokenSymbol) {
  const rates = await getEurRates();
  if (!TOKENS[tokenSymbol]) throw new HttpError(400, 'Ungültige Kryptowährung.');
  return quoteFromRate(totalCents, tokenSymbol, rates[tokenSymbol]);
}

export function buildSolanaPayURL({ recipient, amount, reference, tokenSymbol, label, message }) {
  const p = new URLSearchParams();
  p.set('amount', amount);
  if (TOKENS[tokenSymbol].mint) p.set('spl-token', TOKENS[tokenSymbol].mint);
  p.set('reference', reference);
  if (label) p.set('label', label);
  if (message) p.set('message', message);
  return `solana:${recipient}?${p.toString().replace(/\+/g, '%20')}`;
}

/* ---------- JSON-RPC ---------- */
export async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

export async function latestBlockhash(rpcUrl) {
  const r = await rpc(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
}

/**
 * Prüft eine einzelne (bereits geladene) Transaktion: Erfolg, Referenz enthalten,
 * Empfänger erhält >= erwarteten Betrag (SOL: Lamport-Delta; USDC: Token-Delta des Mints beim Händler).
 */
export function checkTransaction(tx, { recipient, reference, tokenSymbol, expectedUnits }) {
  if (!tx || !tx.meta || tx.meta.err) return { ok: false, reason: 'failed-or-missing' };
  const keys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
  if (!keys.includes(reference)) return { ok: false, reason: 'reference-missing' };
  const min = expectedUnits - (expectedUnits * AMOUNT_TOLERANCE_PPM) / 1_000_000n;
  const token = TOKENS[tokenSymbol];
  if (!token.mint) {
    const i = keys.indexOf(recipient);
    if (i < 0) return { ok: false, reason: 'recipient-missing' };
    const delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    return delta >= min ? { ok: true, received: delta } : { ok: false, reason: 'amount-too-low', received: delta };
  }
  const sum = (arr) => (arr || [])
    .filter(b => b.mint === token.mint && b.owner === recipient)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  return delta >= min ? { ok: true, received: delta } : { ok: false, reason: 'amount-too-low', received: delta };
}

/** getTransaction (jsonParsed); versucht neueste Tx-Version, fällt bei älteren RPCs auf v0 zurück. */
export async function getParsedTransaction(rpcUrl, signature) {
  const cfg = { encoding: 'jsonParsed', commitment: 'confirmed' };
  try {
    return await rpc(rpcUrl, 'getTransaction', [signature, { ...cfg, maxSupportedTransactionVersion: 1 }]);
  } catch (e) {
    return await rpc(rpcUrl, 'getTransaction', [signature, { ...cfg, maxSupportedTransactionVersion: 0 }]);
  }
}

/**
 * Sucht eine gültige Zahlung zur Referenz.
 * @returns {Promise<{signature:string}|null>} null = (noch) nicht bezahlt
 */
export async function findValidPayment(rpcUrl, { recipient, amount, reference, tokenSymbol, notBeforeSec = 0 }) {
  const token = TOKENS[tokenSymbol];
  if (!token) throw new Error('INVALID_TOKEN');
  const expectedUnits = toBaseUnits(amount, token.decimals);
  const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [reference, { limit: 10, commitment: 'confirmed' }]);
  for (const s of (sigs || []).slice().reverse()) {   // älteste zuerst
    if (s.err) continue;
    if (s.confirmationStatus && !['confirmed', 'finalized'].includes(s.confirmationStatus)) continue;
    if (notBeforeSec && s.blockTime && s.blockTime < notBeforeSec) continue;
    let tx;
    try { tx = await getParsedTransaction(rpcUrl, s.signature); } catch { continue; }
    const r = checkTransaction(tx, { recipient, reference, tokenSymbol, expectedUnits });
    if (r.ok) return { signature: s.signature, received: r.received.toString() };
  }
  return null;
}
