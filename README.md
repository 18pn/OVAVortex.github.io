# valentinolopez.de

Shop von Val3ntino: Windows-PC-Tuning, Websites und Skripte. Login läuft über Firebase. Bezahlen kann man mit PayPal, Karte, Krypto (Solana) oder Guthaben.

**GitHub Pages** liefert die Datei `index.html` im Repository-Stamm aus (Domain über `CNAME`: `valentinolopez.de`). Diese Datei ist die Website. Eine zweite Kopie unter `worker/firebase/public/` gibt es nicht.

Krypto, PayPal und Guthaben funktionieren erst, wenn der Cloudflare Worker deployed ist und `WORKER_URL` in `index.html` auf die Worker-Adresse zeigt (ohne `/` am Ende). Die Platzhalter-Adresse `https://valentinolopez-api.DEIN-SUBDOMAIN.workers.dev` reicht dafür nicht.

Einrichtung des Workers: [worker/README.md](worker/README.md).

In `worker/wrangler.toml` muss `ALLOWED_ORIGINS` die Live-Domain enthalten. Eingetragen sind bereits `https://valentinolopez.de` und `https://www.valentinolopez.de`. Nach einer Änderung an den Origins den Worker neu deployen.

Dienstkonto-JSON, PayPal-Secret, `.dev.vars` und `.env` gehören nicht ins Repository (siehe `.gitignore`). Nur die öffentliche Firebase-Web-Konfiguration steht in `index.html`.
