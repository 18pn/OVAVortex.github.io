// Static security-boundary regression tests; no credentials, production calls or payments.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const paypal = readFileSync(new URL('../src/paypal.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

assert.match(auth, /jwtVerify\(m\[1\], JWKS/, 'Firebase tokens must be cryptographically verified');
assert.match(auth, /issuer:\s*`https:\/\/securetoken\.google\.com\/\$\{projectId\}`/, 'Firebase issuer must be project-scoped');
assert.match(auth, /audience:\s*projectId/, 'Firebase audience must match project');
assert.match(auth, /algorithms:\s*\['RS256'\]/, 'JWT algorithms must be restricted');
assert.match(auth, /admin:\s*payload\.admin === true/, 'Admin access must require explicit true claim');

assert.match(worker, /async function assertAdmin\([\s\S]*?if \(!user\.admin\) throw new HttpError\(403/, 'Admin API must reject non-admin users');
assert.match(worker, /const user = await verifyFirebaseToken\(request, env\);[\s\S]*?const result = await routes\[m\[1\]\]\(env, user, body\)/, 'API dispatcher must verify token before invoking route');
assert.match(worker, /async capturePayPalOrder\([\s\S]*?getOwnOrder\(env, user, orderId\)/, 'PayPal capture must be scoped to the authenticated owner');
assert.match(worker, /async capturePayPalOrder\([\s\S]*?paypalCaptureAndVerify\(env, \{ paypalOrderId: o\.paypal\.orderId, expectedCents: o\.totalCents, expectedCustomId: orderId \}\)/, 'PayPal verification must use stored amount and order reference');
assert.match(paypal, /cap\.status === 'COMPLETED'/, 'PayPal capture must be completed');
assert.match(paypal, /amount\.currency_code === 'EUR'/, 'PayPal capture must check currency');
assert.match(paypal, /value === expectedCents/, 'PayPal capture must check amount');
assert.match(config, /^PAYPAL_ENV = "production"/m, 'Live config must explicitly identify production PayPal');

console.log('PASS static authentication, authorization and payment boundary checks');
