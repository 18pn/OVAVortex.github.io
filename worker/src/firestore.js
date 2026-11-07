// Firestore-REST-Client mit Google-Dienstkonto (JWT RS256 über WebCrypto -> OAuth-Access-Token).
// Das Dienstkonto umgeht die Sicherheitsregeln – deshalb liegt der Schlüssel NUR als Worker-Secret vor.
import { SignJWT, importPKCS8 } from 'jose';
import { HttpError } from './util.js';

let tokenCache = { token: null, exp: 0, email: null };

function serviceAccount(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new HttpError(503, 'Server ist noch nicht eingerichtet (Dienstkonto fehlt).');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { throw new HttpError(503, 'Dienstkonto-Secret ist kein gültiges JSON.'); }
  if (!sa.client_email || !sa.private_key) throw new HttpError(503, 'Dienstkonto-Secret unvollständig.');
  return sa;
}

async function accessToken(env) {
  const sa = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.email === sa.client_email && tokenCache.exp - 120 > now) return tokenCache.token;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/datastore' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })
    .setIssuer(sa.client_email).setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new HttpError(503, 'Anmeldung des Servers bei Google fehlgeschlagen.');
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: now + Number(j.expires_in || 3600), email: sa.client_email };
  return j.access_token;
}

const dbRoot = (env) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
const docName = (env, path) => `${dbRoot(env)}/documents/${path}`;
const API = 'https://firestore.googleapis.com/v1/';

async function call(env, method, url, body) {
  const t = await accessToken(env);
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const status = j?.error?.status || res.status;
    const e = new Error(`Firestore ${status}: ${j?.error?.message || ''}`);
    e.fsStatus = status;
    throw e;
  }
  return j;
}

/* ---------- Wert-Konvertierung ---------- */
export class Timestamp { constructor(ms) { this.ms = ms; } }
export const ts = (ms) => new Timestamp(ms);

export function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Timestamp) return { timestampValue: new Date(v.ms).toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error('Nicht unterstützter Typ');
}
export function encodeFields(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) f[k] = encode(v);
  return f;
}
export function decode(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Timestamp(Date.parse(v.timestampValue));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
export function decodeFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = decode(v);
  return o;
}
const idOf = (name) => name.split('/').pop();

/* ---------- Lesen ---------- */
export async function fsGet(env, path, transaction) {
  const q = transaction ? `?transaction=${encodeURIComponent(transaction)}` : '';
  const j = await call(env, 'GET', `${docName(env, path)}${q}`);
  if (!j) return null;
  return { id: idOf(j.name), data: decodeFields(j.fields), updateTime: j.updateTime };
}

export async function fsQuery(env, collection, filters, limit = 50) {
  const where = filters.length === 1 ? fieldFilter(filters[0]) : { compositeFilter: { op: 'AND', filters: filters.map(fieldFilter) } };
  const j = await call(env, 'POST', `${dbRoot(env)}/documents:runQuery`, {
    structuredQuery: { from: [{ collectionId: collection }], where, limit },
  });
  return (j || []).filter(r => r.document).map(r => ({ id: idOf(r.document.name), data: decodeFields(r.document.fields) }));
}
function fieldFilter([field, value]) {
  return { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encode(value) } };
}

/* ---------- Schreiben ---------- */
/**
 * Baut ein Write-Objekt. opts.merge = nur angegebene Felder setzen (updateMask);
 * opts.increment = {feld: delta}; opts.serverTime = ['feld'];
 * opts.exists = true/false als Vorbedingung.
 */
export function writeDoc(env, path, data, opts = {}) {
  const w = { update: { name: docName(env, path), fields: encodeFields(data) } };
  if (opts.merge) w.updateMask = { fieldPaths: Object.keys(data) };
  const transforms = [];
  for (const [f, d] of Object.entries(opts.increment || {})) transforms.push({ fieldPath: f, increment: { integerValue: String(d) } });
  for (const f of opts.serverTime || []) transforms.push({ fieldPath: f, setToServerValue: 'REQUEST_TIME' });
  if (transforms.length) w.updateTransforms = transforms;
  if (opts.exists !== undefined) w.currentDocument = { exists: opts.exists };
  return w;
}
export function deleteDoc(env, path) { return { delete: docName(env, path) }; }

export async function fsCommit(env, writes, transaction) {
  const body = { writes };
  if (transaction) body.transaction = transaction;
  return call(env, 'POST', `${dbRoot(env)}/documents:commit`, body);
}

/** Transaktion mit automatischer Wiederholung bei Konflikten (ABORTED). fn(txId) gibt {writes, result} zurück. */
export async function runTransaction(env, fn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const { transaction } = await call(env, 'POST', `${dbRoot(env)}/documents:beginTransaction`, { options: { readWrite: {} } });
    let out;
    try {
      out = await fn(transaction);
    } catch (e) {
      await call(env, 'POST', `${dbRoot(env)}/documents:rollback`, { transaction }).catch(() => {});
      throw e;
    }
    if (!out.writes || !out.writes.length) {
      await call(env, 'POST', `${dbRoot(env)}/documents:rollback`, { transaction }).catch(() => {});
      return out.result;
    }
    try {
      await fsCommit(env, out.writes, transaction);
      return out.result;
    } catch (e) {
      if (e.fsStatus === 'ABORTED' && i < attempts - 1) continue;
      throw e;
    }
  }
}
