// Discord: Webhook-Hinweise und Interactions (Tickets). Secrets bleiben leer, dann passiert nichts.
import { fsGet, fsCommit, writeDoc } from './firestore.js';

const GUILD_FALLBACK = '1557536531567214672';
const VIEW = 1024;
const SEND = 2048;
const HISTORY = 65536;
const MEMBER_ALLOW = String(VIEW + SEND + HISTORY);

function hexToBytes(hex) {
  if (!hex || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

export async function verifyDiscordRequest(request, rawBody, publicKeyHex) {
  const signature = request.headers.get('x-signature-ed25519') || '';
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  const sig = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex || '');
  if (!sig || !keyBytes || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    const data = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data);
  } catch {
    return false;
  }
}

async function webhookTarget(env) {
  let settings = null;
  try { settings = await fsGet(env, 'siteSettings/main'); } catch { settings = null; }
  if (settings && settings.data && settings.data.discordNotify === false) return '';
  const fromSettings = settings && settings.data && settings.data.discordWebhookUrl;
  let privateUrl = '';
  try {
    const priv = await fsGet(env, 'privateConfig/discord');
    privateUrl = priv && priv.data && priv.data.webhookUrl;
  } catch { privateUrl = ''; }
  const candidates = [env.DISCORD_WEBHOOK_URL, privateUrl, fromSettings];
  for (const value of candidates) {
    const url = String(value || '').trim();
    if (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w.-]+$/.test(url)) return url;
  }
  return '';
}

async function postEmbed(env, embed) {
  const url = await webhookTarget(env);
  if (!url) return false;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Val3ntino', embeds: [embed] }),
  });
  return res.ok;
}

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

export async function notifyPaidOrder(env, orderId, order) {
  try {
    if (!order || order.discordNotified) return;
    const fresh = await fsGet(env, `orders/${orderId}`);
    if (!fresh || fresh.data.discordNotified) return;
    const names = (Array.isArray(order.items) ? order.items : []).map(i => `${i.qty || 1}× ${i.name || i.productId || 'Produkt'}`).join('\n').slice(0, 900) || 'Bestellung';
    const when = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date());
    const ok = await postEmbed(env, {
      title: 'Bezahlte Bestellung',
      color: 0xec4899,
      fields: [
        { name: 'Produkt', value: names },
        { name: 'Betrag', value: money(order.totalCents), inline: true },
        { name: 'Zahlung', value: String(order.methodLabel || order.method || 'Zahlung').slice(0, 80), inline: true },
        { name: 'Zeit', value: when, inline: true },
      ],
      footer: { text: 'valentinolopez.de' },
    });
    if (ok) await fsCommit(env, [writeDoc(env, `orders/${orderId}`, { discordNotified: true }, { merge: true, exists: true })]);
  } catch (e) { console.warn('Discord-Kauf', e && e.message); }
}

export async function notifyRestock(env, name) {
  try {
    await postEmbed(env, {
      title: 'Wieder verfügbar',
      description: String(name || 'Ein Produkt').slice(0, 120) + ' ist wieder auf Lager.',
      color: 0x22c55e,
      footer: { text: 'valentinolopez.de' },
    });
  } catch (e) { console.warn('Discord-Restock', e && e.message); }
}

export async function notifyNewsletter(env) {
  try {
    await postEmbed(env, {
      title: 'Newsletter',
      description: 'Neue Anmeldung. Die Adresse bleibt in Firestore und wird hier nicht genannt.',
      color: 0x71717a,
      footer: { text: 'valentinolopez.de' },
    });
  } catch (e) { console.warn('Discord-Newsletter', e && e.message); }
}

function discordHeaders(env) {
  return { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' };
}

function ticketName(user) {
  const raw = String((user && (user.username || user.global_name)) || 'mitglied').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ('ticket-' + (raw || 'mitglied')).slice(0, 90);
}

async function openTicket(env, user) {
  const guild = env.DISCORD_GUILD_ID || GUILD_FALLBACK;
  const overwrites = [
    { id: guild, type: 0, deny: String(VIEW) },
    { id: user.id, type: 1, allow: MEMBER_ALLOW },
  ];
  if (env.DISCORD_SUPPORT_ROLE_ID) overwrites.push({ id: env.DISCORD_SUPPORT_ROLE_ID, type: 0, allow: MEMBER_ALLOW });
  const body = { name: ticketName(user), type: 0, permission_overwrites: overwrites };
  if (env.DISCORD_TICKET_CATEGORY_ID) body.parent_id = env.DISCORD_TICKET_CATEGORY_ID;
  const created = await fetch('https://discord.com/api/v10/guilds/' + guild + '/channels', {
    method: 'POST', headers: discordHeaders(env), body: JSON.stringify(body),
  });
  if (!created.ok) return null;
  const channel = await created.json();
  await fetch('https://discord.com/api/v10/channels/' + channel.id + '/messages', {
    method: 'POST',
    headers: discordHeaders(env),
    body: JSON.stringify({
      content: 'Hallo <@' + user.id + '>, beschreib kurz dein Anliegen. Nur du und das Support-Team sehen diesen Kanal.',
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Schließen', custom_id: 'ticket_close' }] }],
    }),
  });
  return channel.id;
}

async function closeTicket(env, channelId) {
  await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
    method: 'POST',
    headers: discordHeaders(env),
    body: JSON.stringify({ content: 'Ticket geschlossen.' }),
  }).catch(() => {});
  const del = await fetch('https://discord.com/api/v10/channels/' + channelId, { method: 'DELETE', headers: discordHeaders(env) });
  if (!del.ok) {
    await fetch('https://discord.com/api/v10/channels/' + channelId, {
      method: 'PATCH',
      headers: discordHeaders(env),
      body: JSON.stringify({ archived: true, locked: true }),
    }).catch(() => {});
  }
}

function panelMessage() {
  return {
    type: 4,
    data: {
      content: 'Support von Val3ntino. Mit dem Button öffnest du einen privaten Kanal.',
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Ticket öffnen', custom_id: 'ticket_open' }] }],
    },
  };
}

export async function handleDiscordInteraction(request, env, rawBody) {
  if (!env.DISCORD_PUBLIC_KEY) return new Response('Discord ist nicht eingerichtet.', { status: 401 });
  const ok = await verifyDiscordRequest(request, rawBody, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('Signatur ungültig.', { status: 401 });
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch { return new Response('JSON ungültig.', { status: 400 }); }
  if (body.type === 1) return Response.json({ type: 1 });
  if (body.type === 2 && body.data && (body.data.name === 'ticket' || body.data.name === 'ticket-panel')) return Response.json(panelMessage());
  if (body.type === 3 && body.data && body.data.custom_id === 'ticket_open') {
    if (!env.DISCORD_BOT_TOKEN) return Response.json({ type: 4, data: { content: 'Der Bot-Token fehlt noch.', flags: 64 } });
    const channelId = await openTicket(env, body.member && body.member.user || body.user || {});
    if (!channelId) return Response.json({ type: 4, data: { content: 'Der Ticket-Kanal konnte nicht angelegt werden. Prüfe Bot-Rechte und Kategorie.', flags: 64 } });
    return Response.json({ type: 4, data: { content: 'Dein Ticket ist offen: <#' + channelId + '>', flags: 64 } });
  }
  if (body.type === 3 && body.data && body.data.custom_id === 'ticket_close') {
    if (env.DISCORD_BOT_TOKEN && body.channel_id) await closeTicket(env, body.channel_id);
    return Response.json({ type: 4, data: { content: 'Ticket wird geschlossen.', flags: 64 } });
  }
  return Response.json({ type: 4, data: { content: 'Unbekannte Aktion.', flags: 64 } });
}
