# Val3ntino – Freigabecheck vor dem Livegang

Stand: Entwicklungsbranch `val3ntino-paypal-hardening`. **Keine** echten Zahlungen ausführen, bevor die Punkte unten bestätigt sind.

## Automatisch geprüft

- [x] Worker-Syntax via `npm run check`
- [x] Isolierte PayPal-Validierung via `npm run test:paypal`
- [x] Gemockte Worker-Integration via `npm test`
- [x] Portal-Markup und Firebase-Admin-Claim via `npm run test:portal`
- [x] CI-Workflow in GitHub Actions eingerichtet

Diese Tests verwenden Mocks. Sie bestätigen weder die Live-Umgebung noch die korrekte Bereitstellung externer Dienste.

## Cloudflare Worker und Firebase – manuell

- [ ] In `worker/wrangler.toml` den Platzhalter `ERSETZEN_NACH_KV_NAMESPACE_CREATE` durch eine echte KV-Namespace-ID ersetzen (nicht erfinden)
- [ ] Cloudflare Worker Secrets `GOOGLE_SERVICE_ACCOUNT`, `PAYPAL_CLIENT_SECRET` und gegebenenfalls `DOWNLOAD_TOKEN_SECRET` sicher konfigurieren (nie in Git committen)
- [ ] Firestore-Regeln aus `worker/firebase/firestore.rules` im richtigen Firebase-Projekt veröffentlichen und mit Testkonten prüfen (Support-Chat-Felder sind jetzt eingeschränkt; die Regeländerung ist ohne Firebase-Deployment noch nicht aktiv)
- [ ] Inhaber-Konto erhält serverseitig den Firebase Custom Claim `admin=true`; danach neu anmelden bzw. Token aktualisieren
- [ ] Ein normales Kundenkonto sieht **keinen** Admin-Reiter und kann keine Admin-API-Aktion ausführen
- [ ] Admin kann Bestellungen/Produkte sehen und ändern; Kunde sieht nur eigene Daten
- [ ] CORS, Worker-URL, Domain und `/health` gegen die tatsächliche Bereitstellung prüfen

## Kaufablauf – zunächst PayPal Sandbox

- [ ] Sandbox-Konfiguration konsistent auf Worker **und** PayPal JavaScript SDK setzen; keine Sandbox/Live-Mischung
- [ ] Erfolgreiche Testbestellung: exakt einmal buchen, korrekter Betrag und korrekte Auslieferung
- [ ] Abgebrochene/fehlgeschlagene Zahlung: keine Auslieferung, keine Gutschrift
- [ ] Doppelte Capture-Anfrage: keine doppelte Gutschrift
- [ ] Falscher Betrag, falsche Währung und falsche Bestellreferenz: keine Auslieferung
- [ ] Erst nach erfolgreichem Sandbox-Test auf Produktionsdaten wechseln und kleine echte Transaktion kontrolliert durchführen
- [ ] Solana-Zahlungen gesondert mit korrekter Netzwerk-, Betrag- und Replay-Prüfung testen

## Kundenportal, Admin-Panel und Mobilgeräte

- [ ] Registrierung, Login, Logout und Passwort-Reset im Browser testen
- [ ] Kundenportal: Guthaben, Bestellhistorie, Profil und Auslieferung mit echtem Testkonto prüfen
- [ ] Admin-Panel: Claim-Berechtigung, Produktpflege, Bestellstatus, Gutscheine und Statistiken prüfen
- [ ] Handy (iOS/Android), Tablet und Desktop visuell prüfen; Warenkorb, Checkout und Dashboard-Navigation
- [ ] Tastatur, Fokus, Scroll-Lock, Kontrast und reduzierte Animationen prüfen
- [ ] Bestellbestätigungen/Support und E-Mail-Versand separat einrichten und testen; `SMTP_ENABLED=false` bedeutet nicht automatisch funktionierenden Versand

## Freigabe

- [ ] Neuester GitHub-Actions-Lauf grün
- [ ] Browser- und Sandbox-Tests bestanden
- [ ] Keine echten Secrets im Repository
- [ ] Backup und Rollback-Möglichkeit vorhanden
- [ ] Erst dann PR #8 prüfen und bewusst mergen
- [ ] Cloudflare Worker **separat** bereitstellen; ein GitHub-PR-Merge deployt den Worker nicht automatisch

**Wichtig:** Der separate PR #7 für die Konfigurationsprüfung ist ebenfalls ein Entwurf. Der Livegang erfordert echte Cloudflare-/Firebase-/PayPal-Zugänge und kann nicht allein durch Codeänderungen abgeschlossen werden.
