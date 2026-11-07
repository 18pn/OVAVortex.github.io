// TOTP (RFC 6238, 30s, 6 Stellen, SHA-1) ohne Zusatzpaket.
const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomBase32(bytes = 20) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of buf) out += ALPH[b % 32];
  return out;
}

function base32ToBytes(secret) {
  const s = String(secret || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of s) {
    const v = ALPH.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

async function hotp(keyBytes, counter) {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = sig[sig.length - 1] & 15;
  const bin = ((sig[o] & 127) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

export async function verifyTotp(secret, code, now = Date.now()) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const key = base32ToBytes(secret);
  if (key.length < 10) return false;
  const step = Math.floor(now / 30000);
  for (let i = -1; i <= 1; i++) if (await hotp(key, step + i) === token) return true;
  return false;
}
