#!/bin/sh
# Lädt die drei PDFs in den privaten R2-Bucket. Nicht ins Git committen.
# Einmalig: npx wrangler r2 bucket create valentinolopez-guides
# Danach in wrangler.toml das Binding GUIDES eintragen und den Worker neu deployen.
set -e
cd "$(dirname "$0")/../guides"
npx wrangler r2 object put valentinolopez-guides/val3ntino-krypto-einsteiger-2026.pdf --file val3ntino-krypto-einsteiger-2026.pdf
npx wrangler r2 object put valentinolopez-guides/val3ntino-discord-server-playbook.pdf --file val3ntino-discord-server-playbook.pdf
npx wrangler r2 object put valentinolopez-guides/val3ntino-digitale-produkte-business-guide.pdf --file val3ntino-digitale-produkte-business-guide.pdf
echo "Fertig. Binding GUIDES in wrangler.toml setzen und npx wrangler deploy ausführen."
