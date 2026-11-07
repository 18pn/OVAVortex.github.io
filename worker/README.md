# valentinolopez.de – v4 Server auf Cloudflare Workers (kostenlos, ohne Kreditkarte)

Firebase bleibt im **kostenlosen Spark-Plan** und wird nur noch für **Login (Auth)** und **Datenbank (Firestore)** genutzt.
Alles, was vorher Cloud Functions (Blaze) gemacht haben, macht jetzt ein **Cloudflare Worker** (Free Plan).

## Ordner

| Pfad | Inhalt |
|---|---|
| `wrangler.toml` | Worker-Konfiguration, öffentliche Variablen, Cron (alle 5 Min.) |
| `src/` | Worker-Code: `index.js` (Endpunkte + Cron), `auth.js` (ID-Token-Prüfung), `firestore.js` (REST + Dienstkonto), `solana.js` (JSON-RPC-Verifikation, CoinGecko), `paypal.js`, `catalog.js`, `delivery.js`, `util.js` |
| `firebase/` | `firestore.rules`, `firebase.json`, `.firebaserc` (nur Regeln/Indizes; die Website liegt nicht hier) |
| `admin-scripts/` | `set-admin-claim.js`, `seed-firestore.js` (laufen lokal auf deinem PC) |
| `test/`, `scripts/` | Lokale Tests (Mock-Integrationstest, Solana-Mainnet-Test) |

## Endpunkte (alle `POST https://<worker>/api/<name>`, Header `Authorization: Bearer <Firebase-ID-Token>`)

`quoteCart`, `createCryptoOrder`, `createTopUp`, `buildCryptoTransaction` (liefert Blockhash + Parameter, der Browser baut die Phantom-Transaktion), `verifyCryptoOrder` / `verifyTopUp`, `createPayPalOrder` / `createPayPalTopUp`, `capturePayPalOrder` / `capturePayPalTopUp`, `payWithBalance`, `adminSetOrderStatus`, `adminSaveCoupon`, `adminDeleteCoupon` (Admin = Custom Claim `admin == true`). `GET /health` zum Testen.

## Einrichtung Schritt für Schritt (Anfänger)

Voraussetzung: [Node.js LTS](https://nodejs.org) installiert. Befehle im Terminal (Windows: PowerShell) ausführen.

### 1. Cloudflare-Konto (kostenlos)
1. Auf https://dash.cloudflare.com/sign-up registrieren (nur E-Mail, keine Karte), E-Mail bestätigen.
2. Terminal: `npm i -g wrangler` und dann `wrangler login` (Browser öffnet sich → „Allow“).

### 2. Dienstkonto-Schlüssel von Firebase holen
1. https://console.firebase.google.com → Projekt **valentinolopezde** → Zahnrad → *Projekteinstellungen* → *Dienstkonten* → **Neuen privaten Schlüssel generieren**.
2. Datei als `admin-scripts/service-account.json` speichern. **Niemals hochladen, teilen oder ins Git!** (steht in `.gitignore`).

### 3. Worker-Secrets setzen und deployen
Im Ordner `worker` (Repository-Wurzel, neben `index.html`):
```bash
npm install
# Dienstkonto (kompletter JSON-Inhalt) als Secret:
#   macOS/Linux:
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < admin-scripts/service-account.json
#   Windows PowerShell:
Get-Content admin-scripts/service-account.json -Raw | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT
# PayPal-Secret (siehe Schritt 6; vorerst kann das übersprungen werden):
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler deploy
```
Am Ende zeigt wrangler die Adresse, z. B. `https://valentinolopez-api.DEINNAME.workers.dev`. Test im Browser: `…/health` → `{"ok":true}`.
(Falls „workers.dev-Subdomain fehlt“: im Cloudflare-Dashboard unter *Workers & Pages* einmal eine Subdomain wählen.)

### 4. WORKER_URL in der Website eintragen
In der **Repository-Wurzel** `index.html` (das ist die Datei, die GitHub Pages ausliefert) die Zeile
`const WORKER_URL = 'https://valentinolopez-api.DEIN-SUBDOMAIN.workers.dev';` durch deine Adresse ersetzen (ohne `/` am Ende).

### 5. Firestore-Regeln deployen (geht im Spark-Plan) + Admin + Startdaten
```bash
npm i -g firebase-tools
firebase login
cd firebase
firebase deploy --only firestore:rules
cd ../admin-scripts
npm install
node set-admin-claim.js l@valentinolopez.de   # vorher einmal im Shop mit dieser Adresse registrieren
node seed-firestore.js                        # Gutscheine VAL3NTINO/CENT50 + Auslieferungs-Platzhalter
```
Danach im Shop **ab- und wieder anmelden** (neues Token mit Admin-Claim). Auslieferungstexte änderst du in der Firebase-Konsole unter `deliveries/basic|pro|web`.

### 6. PayPal
1. https://developer.paypal.com → *Apps & Credentials* → App anlegen → **Client ID** + **Secret** (erst *Sandbox* testen, später *Live*).
2. `wrangler.toml`: `PAYPAL_CLIENT_ID = "…"` und `PAYPAL_ENV = "sandbox"` (bzw. `"live"`), dann `npx wrangler secret put PAYPAL_CLIENT_SECRET` und `npx wrangler deploy`.
3. Im HTML im PayPal-Script `client-id=test` durch **dieselbe** Client-ID ersetzen.

### 7. Website hosten
Die Live-Seite ist **GitHub Pages**: ausgeliefert wird die `index.html` in der Repository-Wurzel (`CNAME` = `valentinolopez.de`). Das reicht für das HTML. `firebase/` enthält nur Firestore-Regeln, keine zweite Website.

Die Domain in Firebase unter *Authentication → Einstellungen → Autorisierte Domains* eintragen (`valentinolopez.de`, bei Bedarf auch `www`).

In `wrangler.toml` muss `ALLOWED_ORIGINS` `https://valentinolopez.de` enthalten (ist bereits gesetzt, zusammen mit `https://www.valentinolopez.de` und lokalen Test-Adressen). Jede weitere Adresse (z. B. `*.github.io`) dort ergänzen und den Worker neu deployen, sonst blockiert CORS die Aufrufe aus dem Browser.

### Lokal testen (optional)
`npm test` (Build + Mock-Integrationstest), `npm run test:solana` (echte Mainnet-Abfrage, unbezahlte Referenz → „nicht bezahlt“), `npx wrangler dev` mit `.dev.vars` (Vorlage `.dev.vars.example`).

## Free-Tier-Grenzen
- **Cloudflare Workers Free:** 100.000 Requests/Tag, **10 ms CPU** pro Aufruf, 50 Subrequests pro Aufruf, Cron Triggers inklusive. Darum prüft der Cron max. 15 offene Bestellungen pro Lauf.
- **Firestore Spark:** 50.000 Lesezugriffe, 20.000 Schreib- und 20.000 Löschvorgänge pro Tag, 1 GiB Speicher. Live-Listener (Kundenportal/Admin) zählen als Lesezugriffe.
- **Öffentlicher Solana-RPC** (`api.mainnet-beta.solana.com`) ist rate-limitiert. Besser: kostenloser RPC (z. B. Helius/QuickNode Free) per `npx wrangler secret put SOLANA_RPC_URL`.
- **CoinGecko** (ohne Key) ist rate-limitiert; Kurs wird 60 s zwischengespeichert.

## Sicherheit
- Kein privater Wallet-Schlüssel, keine Passwörter (Login nur über Firebase Auth). Einziges Geheimnis: Dienstkonto-JSON (+ PayPal-Secret) als Worker-Secret.
- Preise nur aus `src/catalog.js`; „All-in-One Media Access“ ist nicht enthalten (kein Krypto/Guthaben/automatische Auslieferung).
- Zahlung gilt nur nach Prüfung: PayPal-Capture (Betrag, Währung, custom_id) bzw. on-chain (Referenz, Empfänger, Betrag ≥ 99,9 %, Mint, confirmed, Signatur nur einmal verwendbar).
- Das Firebase-Admin-Dienstkonto hat Vollzugriff. Optional sicherer: in Google Cloud IAM ein eigenes Dienstkonto nur mit Rolle „Cloud Datastore User“ anlegen und dessen Schlüssel als `GOOGLE_SERVICE_ACCOUNT` nutzen.
