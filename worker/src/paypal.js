// PayPal REST (Orders v2) – Client-Secret nur aus Worker-Secret PAYPAL_CLIENT_SECRET.
import { HttpError } from './util.js';

const base = (env) => env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function token(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new HttpError(503, 'PayPal ist noch nicht eingerichtet.');
  const res = await fetch(base(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new HttpError(502, 'PayPal-Anmeldung fehlgeschlagen.');
  return (await res.json()).access_token;
}

export async function paypalCreateOrder(env, { totalCents, customId, description }) {
  const t = await token(env);
  const res = await fetch(base(env) + '/v2/checkout/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'PayPal-Request-Id': customId },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: customId, description: String(description || '').slice(0, 120), amount: { currency_code: 'EUR', value: (totalCents / 100).toFixed(2) } }],
    }),
  });
  if (!res.ok) throw new HttpError(502, 'PayPal-Bestellung konnte nicht angelegt werden.');
  return (await res.json()).id;
}

export async function paypalCaptureAndVerify(env, { paypalOrderId, expectedCents, expectedCustomId }) {
  const t = await token(env);
  const url = base(env) + '/v2/checkout/orders/' + encodeURIComponent(paypalOrderId);
  const res = await fetch(url + '/capture', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'PayPal-Request-Id': 'cap-' + expectedCustomId },
  });
  let j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const already = Array.isArray(j.details) && j.details.some(d => d.issue === 'ORDER_ALREADY_CAPTURED');
    if (!already) throw new HttpError(402, 'Die PayPal-Zahlung konnte nicht abgeschlossen werden.');
    j = await (await fetch(url, { headers: { Authorization: 'Bearer ' + t } })).json();
  }
  const pu = (j.purchase_units || [])[0] || {};
  const cap = ((pu.payments || {}).captures || [])[0] || {};
  const value = Math.round(Number(cap.amount && cap.amount.value) * 100);
  const ok = j.status === 'COMPLETED' && cap.status === 'COMPLETED'
    && cap.amount && cap.amount.currency_code === 'EUR' && value === expectedCents
    && (pu.custom_id === expectedCustomId || cap.custom_id === expectedCustomId);
  return { ok, captureId: cap.id || null };
}
