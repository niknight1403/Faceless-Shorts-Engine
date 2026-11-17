# Faceless-Shorts-Engine

Lokaler Proof of Concept für eine asynchrone, vertikale Kurzvideo-Pipeline. Der PoC führt einen Auftrag über den vorhandenen Mock-Medienanbieter, rendert ein MP4 mit FFmpeg und prüft den Export mit FFprobe.

> **PoC-Hinweis:** Der Mock liefert ein einfarbiges Testbild und einen kurzen 440-Hz-Testton. Er erzeugt weder echte Bilder noch gesprochene Sprache. Das Thema wird als Textoverlay eingeblendet. Publishing-Code ist vorhanden, bleibt aber standardmäßig deaktiviert und ist ohne Kontoverbindung, Plattformfreigabe und ausdrückliche Jobbestätigung nicht aktiv.

## Voraussetzungen

- Node.js 20 oder neuer
- FFmpeg und FFprobe im `PATH`
- FFmpeg-Build mit `libx264`, AAC und `drawtext`/FreeType

Das Projekt verwendet im PoC keine zusätzlichen npm-Pakete.

## Lokal starten

Terminal 1 – Test-Medienanbieter:

```bash
npm run mock
```

Terminal 2 – API und Job-Worker:

```bash
npm run dev
```

Die API bindet standardmäßig nur an `127.0.0.1:3000`. Lokale Jobdaten und Exporte werden in `data/jobs/` abgelegt; dieser Ordner ist in Git ignoriert.

Für eine abweichende Konfiguration können Prozessumgebungsvariablen gesetzt werden. `.env.example` dokumentiert die verfügbaren Standardwerte; `.env` wird vom PoC derzeit nicht automatisch eingelesen.

```bash
PORT=3001 MOCK_MEDIA_URL=http://127.0.0.1:4010 npm run dev
```

## Einen Test-Short erzeugen

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/shorts-jobs \
  -H 'content-type: application/json' \
  -H 'idempotency-key: beispiel-job-001' \
  -d '{"topic":"Warum der Himmel blau ist","durationSeconds":5}'
```

Die Antwort enthält eine Job-ID. Status und Fortschritt lassen sich anschließend abfragen:

```bash
curl -sS http://127.0.0.1:3000/api/v1/shorts-jobs/JOB_ID
```

Bei `status: "completed"` liefert `output.downloadUrl` den Download-Endpunkt:

```bash
curl -L http://127.0.0.1:3000/api/v1/shorts-jobs/JOB_ID/download \
  -o faceless-short.mp4
```

Ein fehlgeschlagener Auftrag kann erneut gestartet werden:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/shorts-jobs/JOB_ID/retry
```

### API-Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/v1/health` | API-/Mock-Provider-Readiness und Publishing-Konfigurationsstatus ohne Geheimnisse |
| `GET` | `/api/v1/shorts-jobs` | lokale Auftragsliste |
| `POST` | `/api/v1/shorts-jobs` | Auftrag anlegen; optional `Idempotency-Key` |
| `GET` | `/api/v1/shorts-jobs/:id` | Status, Verarbeitungsschritte und Ergebnis |
| `POST` | `/api/v1/shorts-jobs/:id/retry` | fehlgeschlagenen Auftrag erneut ausführen |
| `GET` | `/api/v1/shorts-jobs/:id/download` | fertiges MP4 herunterladen |

## YouTube-/TikTok-Publishing (Opt-in, lokal)

Die Publishing-Routen sind standardmäßig nicht verfügbar. Für die Aktivierung müssen `PUBLISHING_ENABLED=true`, ein zufälliger `PUBLISHING_API_KEY` mit mindestens 32 Zeichen und ein base64url-kodierter 32-Byte-`PUBLISHING_TOKEN_KEY` gesetzt werden. Das Beispiel `.env.example` enthält die dazugehörigen OAuth-Variablen und einen Befehl zum Generieren eines Datenschlüssels. Sobald Publishing aktiviert ist, lehnt die Konfiguration jede Bindung außerhalb von `127.0.0.1`, `::1` oder `localhost` ab. Die Anwendung lädt `.env` nicht selbst; Werte müssen vor dem Start exportiert oder in der Shell eingelesen werden. OAuth-Client-Secrets gehören ausschließlich in eine lokale, nicht eingecheckte Datei.

Publishing-Endpunkte verlangen `Authorization: Bearer <PUBLISHING_API_KEY>`. Der OAuth-Callback ist davon ausgenommen, wird aber durch einen zufälligen, einmaligen State-Wert geschützt. Verfügbare Routen sind `POST /api/v1/connections/:platform/oauth/start`, `GET /api/v1/connections/:platform/oauth/callback`, `GET` und `DELETE /api/v1/connections`, `POST /api/v1/shorts-jobs/:id/publish`, `GET /api/v1/publishing-jobs`, `GET /api/v1/publishing-jobs/:id`, `GET /api/v1/publishing/diagnostics`, `POST /api/v1/publishing-jobs/:id/confirm` sowie `POST /api/v1/publishing-jobs/:id/refresh`. Für OAuth-Start und Callback müssen die jeweilige Redirect-URI und die Credentials in der Plattform-App exakt übereinstimmen. Fehlende OAuth-Variablen werden als `OAUTH_NOT_CONFIGURED` gemeldet; `/api/v1/health` weist Publishing als deaktiviert, unvollständig oder bereit aus und liefert bei Providerstörung HTTP 503.

Die authentifizierte Diagnostik listet Jobs mit `needs_attention` oder `awaiting_creator_action` samt nächstem manuellen Schritt. Ausschließlich `published`- oder `cancelled`-Jobs älter als 30 Tage erscheinen als Bereinigungsvorschlag; die API löscht niemals automatisch. Diagnoseantworten enthalten keine Metadaten, Fehlerdetails, Tokens oder Session-URLs.

Ein Publishing-Auftrag wird zunächst nur vorgeprüft und in `awaiting_confirmation` gespeichert. Erst `POST .../confirm` mit `{"confirmed":true}` startet den Upload. YouTube benötigt explizite Sichtbarkeit und eine bewusste KI-Offenlegungsangabe. TikTok-Inbox-Upload bleibt bis zur App-Freigabe durch `TIKTOK_UPLOAD_APPROVED=true` gesperrt und endet mit „In TikTok fertigstellen“, nicht mit „veröffentlicht“. Direct Post hat ein separates Gate (`TIKTOK_DIRECT_POST_APPROVED=true`) und verlangt frische Creator-Informationen, ausgewählte Datenschutzoptionen und eine erneute Bestätigung. Diese Schalter ersetzen keine TikTok-Prüfung oder erforderliche Produkt-UX.

### Lokales Publishing Studio

Wenn Publishing lokal aktiviert und mindestens ein Konto verbunden ist, öffne `http://127.0.0.1:3000/publishing-studio` (bei abweichendem `PORT` den entsprechenden Port). Gib dort den bereits konfigurierten `PUBLISHING_API_KEY` ein; er bleibt nur im Arbeitsspeicher der Browser-Sitzung und wird nicht in `localStorage` oder URLs gespeichert. Das Studio verbindet keine Konten und bietet nur YouTube-Upload sowie TikTok-Inbox (kein Direct Post). Wähle einen fertigen Short und ein bestehendes Zielkonto, lade die Vorschau und starte die Wiedergabe, bestätige die Sichtprüfung und erstelle dann den lokalen Preflight. Dieser Preflight lädt nichts hoch. Der Upload beginnt erst nach der separaten Checkbox und Schaltfläche „Jetzt veröffentlichen“. Änderungen an Metadaten setzen die Sichtprüfung zurück. Im TikTok-Inbox-Modus werden Privatsphäre und KI-Offenlegung beim Fertigstellen in der TikTok-App geprüft und ausgewählt. Bei einer unklaren Antwort auf die finale Freigabe keinen zweiten Upload starten; zuerst den Jobstatus abgleichen.

OAuth-Tokens werden mit AES-256-GCM verschlüsselt gespeichert; YouTube-Upload-Session-URLs sind ebenfalls verschlüsselt und werden nie von Publishing-API-Antworten ausgegeben. Bei einem Prozessabbruch während eines externen Uploads wird ein Auftrag auf `needs_attention` gesetzt, damit ein unsicherer automatischer Doppelupload verhindert wird. Die Implementierung wurde ausschließlich mit Mock-Antworten getestet: OAuth-Login, echte Plattformkonten und Live-Uploads wurden nicht ausgeführt.

Ein Auftrag akzeptiert `topic` (1–240 Zeichen) sowie optional `durationSeconds` (1–60, Standard: 5). Bei identischem `Idempotency-Key` wird kein zweiter Auftrag angelegt.

Typischer Statusablauf:

```text
queued → generating_assets → rendering → validating → completed
                                              ↘ failed
```

## Tests

```bash
npm test          # Unit- und E2E-Tests
npm run test:e2e  # Render-Pipeline und simuliertes YouTube-/TikTok-Publishing
```

`npm run test:e2e` führt beide End-to-End-Tests unter `tests/e2e/` aus. Der Pipeline-Test startet den lokalen Mock-Medienanbieter und die API mit temporären Verzeichnissen und zufälligen lokalen Ports; er prüft Validierung, Idempotenz, Jobstatus, Fehler-/Retry-Pfad, FFmpeg-Ausgabe, FFprobe-Metadaten und Download. Der Publishing-Test rendert ebenfalls lokal ein MP4 und führt den Ablauf über simuliertes OAuth, YouTube-Upload/Statusabgleich und TikTok-Inbox-Upload aus. Fault Injection prüft unter anderem einen temporären YouTube-Rate-Limit-Fehler sowie eine unklare TikTok-Chunkannahme, die nicht blind wiederholt wird.

Alle OAuth- und Plattformantworten des Publishing-E2E-Tests kommen aus einem injizierten In-Process-Mock; ein Allowlist-Check lässt keine nicht gemockten Provideraufrufe zu. Zugangsdaten sind synthetische Testwerte. Die Tests verwenden weder echte Konten noch echte OAuth-Zugänge oder Uploads und prüfen daher nicht das Live-Verhalten der Plattformen. Erforderlich sind lokal verfügbares Node.js sowie FFmpeg/FFprobe; externe KI-Dienste oder Plattformzugangsschlüssel sind nicht nötig.

## Implementierte Komponenten

- `src/api/server.mjs` – versionierte lokale HTTP-API und standardmäßig deaktivierte Publishing-Routen mit Loopback- und Bearer-Key-Gate.
- `src/jobs/job-store.mjs` – atomare JSON-Persistenz pro Auftrag und Idempotenzschlüssel.
- `src/jobs/job-runner.mjs` – serielle Pipeline, Status-/Schrittfortschritt, Wiederholung und Behandlung unterbrochener lokaler Prozesse.
- `src/providers/mock-media-provider.mjs` – isolierter HTTP-Adapter zum bestehenden Mock-Server mit Timeouts sowie MIME-/Größenprüfungen.
- `src/render/render-short.mjs` – vertikaler 1080×1920-Export mit H.264/AAC und Textoverlay.
- `src/render/validate-video.mjs` – FFprobe-Prüfung von MP4, Codecs, Abmessungen, Bildrate und Laufzeit.
- `src/publishing/` – OAuth-State, verschlüsselter Token-Vault, Publishing-Aufträge, Plattformadapter, Preflight und Statusabgleich für YouTube/TikTok.
- `scripts/mock-media-provider.mjs` – deterministischer Testbild-/Testton-Server.
- `ARCHITECTURE.md` – vollständiger Zielarchitekturentwurf und Ausbauplan.

## Grenzen und Sicherheit

Dies ist **kein Produktionsdienst**: Es gibt keine Anmeldung, Mandantentrennung, externe Datenbank oder Cloudspeicherung. Die Jobqueue läuft im API-Prozess und verarbeitet lokal seriell. Der Publishing-Bearer-Key ist ein lokaler Schutz, kein Ersatz für ein Mehrnutzer-Authentifizierungssystem. Die API darf nicht öffentlich bereitgestellt werden. Unterbrochene aktive Renderjobs werden beim Neustart als fehlgeschlagen markiert; externe Uploads werden vorsichtshalber auf `needs_attention` gesetzt und müssen vor einer Wiederholung abgeglichen werden.

Echte Text-, Sprach-, Bild- und Musikprovider, Skript-/Szenenplanung, Löschrichtlinien, Produktions-Queue und Monitoring sind nicht implementiert. Das Publishing Studio ist ausschließlich eine lokale Freigabeoberfläche, kein Produktionsdienst. Echte Kontoverbindungen und Uploads erfordern eigene Plattformzugänge, korrekte App-Registrierung, erforderliche Prüfungen und eine separate manuelle Freigabe. Der Architekturentwurf beschreibt, wie die verbleibenden Komponenten später ergänzt werden können.
