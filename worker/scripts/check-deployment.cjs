#!/usr/bin/env node
// Read-only deployment configuration check. No credentials are printed.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const cfg = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
const html = fs.readFileSync(path.join(root, '..', 'index.html'), 'utf8');
const checks = [
  ['Cloudflare KV namespace ID configured', !/id\s*=\s*["']ERSETZEN_NACH_KV_NAMESPACE_CREATE["']/.test(cfg)],
  ['Production domain allowed by CORS', /ALLOWED_ORIGINS\s*=\s*["'][^"']*https:\/\/valentinolopez\.de/.test(cfg)],
  ['Worker URL is not a placeholder', /const WORKER_URL\s*=\s*['"]https:\/\/[^'"]+\.workers\.dev['"]/.test(html) && !/const WORKER_URL\s*=\s*['"][^'"]*DEIN-SUBDOMAIN/.test(html)],
  ['Firebase project ID configured', /FIREBASE_PROJECT_ID\s*=\s*["'][^"']+["']/.test(cfg)],
  ['PayPal environment explicitly set', /PAYPAL_ENV\s*=\s*["'](?:production|sandbox)["']/.test(cfg)]
];
let failures = 0;
for (const [label, ok] of checks) {
  process.stdout.write((ok ? 'PASS' : 'FAIL') + ' ' + label + '\n');
  if (!ok) failures++;
}
if (failures) {
  console.error('\nFix failed checks before deploying the Cloudflare Worker.');
  process.exitCode = 1;
} else {
  console.log('\nStatic configuration checks passed. This does not verify deployed secrets, live payments, or Firebase rules.');
}
