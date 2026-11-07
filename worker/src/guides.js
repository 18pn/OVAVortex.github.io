// Die PDFs liegen nicht im Git, weil das Repository öffentlich über GitHub Pages ausgeliefert wird.
// Privater Speicher: Cloudflare R2, Binding GUIDES (Free-Tarif reicht).
// Objektnamen müssen exakt so heißen:
//   val3ntino-krypto-einsteiger-2026.pdf
//   val3ntino-discord-server-playbook.pdf
//   val3ntino-digitale-produkte-business-guide.pdf
export const GUIDE_OBJECT = {
  'krypto-einsteiger': 'val3ntino-krypto-einsteiger-2026.pdf',
  'discord-playbook': 'val3ntino-discord-server-playbook.pdf',
  'digital-business': 'val3ntino-digitale-produkte-business-guide.pdf',
};

export const GUIDE_NAMES = {
  'krypto-einsteiger': 'Krypto-fuer-Einsteiger-2026.pdf',
  'discord-playbook': 'Discord-Server-Playbook.pdf',
  'digital-business': 'Digitale-Produkte-Business-Guide.pdf',
};

export async function loadGuide(env, id) {
  const key = GUIDE_OBJECT[id];
  if (!key || !env.GUIDES) return null;
  const obj = await env.GUIDES.get(key);
  return obj ? await obj.arrayBuffer() : null;
}
