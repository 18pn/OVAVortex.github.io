// Cover und PDF liegen in Cloudflare KV (Binding ASSETS), nicht im öffentlichen Git.
// Schlüssel: cover:krypto / pdf:krypto, cover:discord / pdf:discord, cover:business / pdf:business
export const GUIDES = {
  'krypto-einsteiger-2026': { cover: 'cover:krypto', pdf: 'pdf:krypto', filename: 'Krypto-fuer-Einsteiger-2026.pdf' },
  'discord-server-playbook': { cover: 'cover:discord', pdf: 'pdf:discord', filename: 'Discord-Server-Playbook.pdf' },
  'digitale-produkte-business-guide': { cover: 'cover:business', pdf: 'pdf:business', filename: 'Digitale-Produkte-Business-Guide.pdf' },
};

// Neutrales 48×48-PNG, falls das Cover in KV noch fehlt.
export const PLACEHOLDER_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOUlEQVR42u3OMQ0AAAgDsAnZiX+NuCAcTSqgaeeVCAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQndWQbWPC5f2iSbAAAAAElFTkSuQmCC'), c => c.charCodeAt(0));

export function coverKey(productId) {
  return (GUIDES[productId] && GUIDES[productId].cover) || 'cover:' + productId;
}

export function pdfKey(productId) {
  return (GUIDES[productId] && GUIDES[productId].pdf) || 'pdf:' + productId;
}

export function pdfFilename(productId) {
  return (GUIDES[productId] && GUIDES[productId].filename) || (productId + '.pdf');
}

export async function readAsset(env, key) {
  if (!env.ASSETS || !key) return null;
  return env.ASSETS.get(key, { type: 'arrayBuffer' });
}

export async function readAssetMeta(env, key) {
  if (!env.ASSETS || !key) return null;
  const got = await env.ASSETS.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!got || got.value == null) return null;
  return { bytes: got.value, contentType: (got.metadata && got.metadata.contentType) || 'image/png' };
}
