# Sichere lokale Staging-Basis

Diese Konfiguration ist eine synthetische, lokale Staging-Umgebung für die bestehende PoC-Pipeline. Sie erzeugt nur deterministische Mock-Medien und lokale MP4-Dateien. Sie ist **kein Live-Deployment** und veröffentlicht nichts auf YouTube, TikTok oder bei externen KI-Anbietern.

## Voraussetzungen

- Node.js 20 oder neuer
- `ffmpeg` und `ffprobe` im `PATH` (mit H.264, AAC und `drawtext`/FreeType)
- Repository unter `/home/ubuntu/faceless-Shorts-engine`

Es werden keine zusätzlichen npm-Pakete benötigt. Für reproduzierbare Läufe bleiben Jobs und Publishing-Daten in lokalen, nicht eingecheckten Verzeichnissen.

## Profile und Umgebungsvariablen

`APP_PROFILE` ist auf `development`, `staging` oder `production-safe` begrenzt. Ohne Angabe gilt `development`.

- `development`: lokaler Entwicklungsbetrieb. Publishing bleibt standardmäßig aus; vorhandene Tests dürfen Publishing mit synthetischen In-Process-Mocks injizieren.
- `staging`: synthetischer Staging-Betrieb. Publishing muss deaktiviert bleiben und `MOCK_MEDIA_URL` muss auf `127.0.0.1`, `::1` oder `localhost` zeigen.
- `production-safe`: dieselben Sicherheitsgrenzen wie Staging; das Profil ist eine Konfigurationsprüfung, kein Produktionsdeployment.

Wichtige Werte:

```bash
export APP_PROFILE=staging
export HOST=127.0.0.1
export PORT=3000
export MOCK_MEDIA_URL=http://127.0.0.1:4010
export JOB_DATA_DIR=./data/staging/jobs
export PUBLISHING_ENABLED=false
```

`PUBLISHING_API_KEY`, `PUBLISHING_TOKEN_KEY` und OAuth-Werte werden nicht benötigt und sollen in Staging nicht gesetzt werden. Keine Secrets in Repository, Job-Payloads, Logs oder URLs eintragen. Bei aktiviertem Publishing gelten weiterhin die bestehenden Loopback-, Bearer-Key-, Preview-/Consent-, Direct-Post- und `needs_attention`-Gates; diese Erweiterung hebt keines davon auf.

## Start und Smoke-Test

Terminal 1:

```bash
APP_PROFILE=staging npm run mock
```

Terminal 2:

```bash
APP_PROFILE=staging npm run dev
```

Readiness ohne Geheimnisse prüfen:

```bash
curl -sS http://127.0.0.1:3000/api/v1/health
```

Die Antwort kennzeichnet `runtimeMode: "synthetic-staging"`, den `mock-http`-Provider und den `local-filesystem`-Adapter. Sie enthält nur Zustände (`ok`/`unavailable`) für Mock-Provider, Dateispeicher, FFmpeg und FFprobe sowie redigierte Publishing-Konfiguration.

## Mock-Grenzen und Sicherheitsgrenzen

Der Medienanbieter liefert ein deterministisches Testbild und einen Testton; er ist keine KI. Es gibt keine echten OAuth-Logins, keine externen Plattformaufrufe und keine öffentlichen URLs. Der lokale Dateispeicher ist ausdrücklich nur ein Staging-Adapter, nicht hochverfügbarer Objektspeicher. Die API bindet standardmäßig an Loopback. Es gibt keine Mehrnutzer-Authentifizierung, Mandantentrennung, externe Datenbank, Produktionsqueue, automatische Löschung oder Live-Monitoring.

## Tests

```bash
npm test
npm run test:e2e
find src scripts tests -name '*.mjs' -print0 | xargs -0 -n1 node --check
git diff --check
```

E2E-Tests verwenden ausschließlich temporäre Verzeichnisse, lokale Ports und injizierte synthetische Provider-Mocks. Ein erfolgreicher Testlauf ist keine Freigabe für Live-Betrieb.

## Produktionsblocker

Für echten Produktionsbetrieb fehlen weiterhin geprüfte externe Provider, Secret-Management, Authentifizierung und Mandantentrennung, Datenbank/Queue, belastbarer Objektspeicher, TLS/öffentliche OAuth-Callbacks, Monitoring/Alerting, Backup- und Löschkonzept sowie Plattform-App-Prüfungen und Creator-UX. Diese Staging-Basis aktiviert keine dieser Funktionen.
