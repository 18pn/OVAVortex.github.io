// Cover und PDF liegen in Cloudflare KV (Binding ASSETS), nicht im öffentlichen Git.
// Schlüssel: cover:krypto / pdf:krypto, cover:discord / pdf:discord, cover:business / pdf:business
export const GUIDES = {
  'krypto-einsteiger-2026': { cover: 'cover:krypto', pdf: 'pdf:krypto', filename: 'Krypto-fuer-Einsteiger-2026.pdf' },
  'discord-server-playbook': { cover: 'cover:discord', pdf: 'pdf:discord', filename: 'Discord-Server-Playbook.pdf' },
  'digitale-produkte-business-guide': { cover: 'cover:business', pdf: 'pdf:business', filename: 'Digitale-Produkte-Business-Guide.pdf' },
};

// Neutrales 48×48-PNG, falls das Cover in KV noch fehlt.
export const PLACEHOLDER_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOUlEQVR42u3OMQ0AAAgDsAnZiX+NuCAcTSqgaeeVCAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQndWQbWPC5f2iSbAAAAAElFTkSuQmCC'), c => c.charCodeAt(0));

export async function readAsset(env, key) {
  if (!env.ASSETS || !key) return null;
  return env.ASSETS.get(key, { type: 'arrayBuffer' });
}
