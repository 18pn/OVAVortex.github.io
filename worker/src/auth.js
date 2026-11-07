// Prüft Firebase-ID-Tokens (Authorization: Bearer <token>) gegen die Google-securetoken-JWKS.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './util.js';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

export async function verifyFirebaseToken(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, 'Bitte melde dich an.');
  const projectId = env.FIREBASE_PROJECT_ID;
  try {
    const { payload } = await jwtVerify(m[1], JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.sub !== 'string') throw new Error('sub');
    if (payload.auth_time && payload.auth_time > now + 60) throw new Error('auth_time');
    return { uid: payload.sub, email: String(payload.email || ''), admin: payload.admin === true };
  } catch (e) {
    throw new HttpError(401, 'Sitzung abgelaufen. Bitte erneut anmelden.');
  }
}
