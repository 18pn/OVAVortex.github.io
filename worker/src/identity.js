// Firebase Auth Admin über das vorhandene Dienstkonto (GOOGLE_SERVICE_ACCOUNT).
// Das Konto braucht in der Google Cloud die Rolle „Firebase Authentication Admin“,
// sonst lehnen lookup und Claim-Änderung ab. Kein zusätzliches Secret.
import { SignJWT, importPKCS8 } from 'jose';
import { HttpError } from './util.js';

let cache = { token: null, exp: 0, email: null };

function account(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new HttpError(503, 'Server ist noch nicht eingerichtet (Dienstkonto fehlt).');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { throw new HttpError(503, 'Dienstkonto-Secret ist kein gültiges JSON.'); }
  if (!sa.client_email || !sa.private_key) throw new HttpError(503, 'Dienstkonto-Secret unvollständig.');
  return sa;
}

async function identityToken(env) {
  const sa = account(env);
  const now = Math.floor(Date.now() / 1000);
  if (cache.token && cache.email === sa.client_email && cache.exp - 120 > now) return cache.token;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/identitytoolkit' })
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
  if (!res.ok) throw new HttpError(503, 'Anmeldung bei Firebase Auth fehlgeschlagen.');
  const j = await res.json();
  cache = { token: j.access_token, exp: now + Number(j.expires_in || 3600), email: sa.client_email };
  return j.access_token;
}

async function authCall(env, method, body) {
  const token = await identityToken(env);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:${method}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = JSON.stringify(j.error || j);
    if (/EMAIL_NOT_FOUND|USER_NOT_FOUND/i.test(msg)) return null;
    throw new HttpError(502, 'Firebase Auth hat abgelehnt. Dem Dienstkonto die Rolle „Firebase Authentication Admin“ geben.');
  }
  return j;
}

export async function lookupUserByEmail(env, email) {
  const j = await authCall(env, 'lookup', { email: [email] });
  if (!j) return null;
  return (j.users || [])[0] || null;
}

export async function setAdminClaim(env, localId, admin, existingJson) {
  let claims = {};
  try { claims = existingJson ? JSON.parse(existingJson) : {}; } catch { claims = {}; }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) claims = {};
  if (admin) claims.admin = true;
  else delete claims.admin;
  const j = await authCall(env, 'update', { localId, customAttributes: JSON.stringify(claims) });
  if (!j) throw new HttpError(404, 'Konto nicht gefunden.');
}
