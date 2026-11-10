// Isolated PayPal validation tests. Uses mocked fetch; no real payments or credentials.
import assert from 'node:assert/strict';
import { paypalCaptureAndVerify } from '../src/paypal.js';

const env = { PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret' };
const expected = { paypalOrderId: 'ORDER-123', expectedCents: 2500, expectedCustomId: 'ORDER-REF' };
const valid = () => ({
  status: 'COMPLETED',
  purchase_units: [{
    custom_id: 'ORDER-REF',
    payments: { captures: [{ id: 'CAPTURE-123', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '25.00' } }] }
  }]
});
const cases = [
  ['valid completed capture', valid(), true],
  ['incorrect amount', (() => { const v = valid(); v.purchase_units[0].payments.captures[0].amount.value = '24.99'; return v; })(), false],
  ['wrong currency', (() => { const v = valid(); v.purchase_units[0].payments.captures[0].amount.currency_code = 'USD'; return v; })(), false],
  ['wrong reference', (() => { const v = valid(); v.purchase_units[0].custom_id = 'OTHER'; return v; })(), false],
  ['missing capture ID', (() => { const v = valid(); delete v.purchase_units[0].payments.captures[0].id; return v; })(), false],
  ['pending capture', (() => { const v = valid(); v.purchase_units[0].payments.captures[0].status = 'PENDING'; return v; })(), false],
  ['multiple captures', (() => { const v = valid(); v.purchase_units[0].payments.captures.push(v.purchase_units[0].payments.captures[0]); return v; })(), false],
  ['multiple purchase units', (() => { const v = valid(); v.purchase_units.push(v.purchase_units[0]); return v; })(), false],
  ['malformed amount', (() => { const v = valid(); v.purchase_units[0].payments.captures[0].amount.value = '25.0'; return v; })(), false],
  ['missing purchase units', { status: 'COMPLETED' }, false]
];
for (const [label, payload, expectedOk] of cases) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (String(url).endsWith('/capture')) return new Response(JSON.stringify(payload), { status: 200 });
    throw new Error('Unexpected fetch: ' + url);
  };
  const result = await paypalCaptureAndVerify(env, expected);
  assert.equal(result.ok, expectedOk, label);
  assert.equal(result.captureId, expectedOk ? 'CAPTURE-123' : null, label + ' capture ID');
  console.log('PASS ' + label);
}
console.log('All PayPal validation tests passed.');
