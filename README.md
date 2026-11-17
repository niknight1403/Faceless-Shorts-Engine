# Faceless-Shorts-Engine

Lokaler Proof of Concept für eine asynchrone, vertikale Kurzvideo-Pipeline. Der PoC führt einen Auftrag über den vorhandenen Mock-Medienanbieter, rendert ein MP4 mit FFmpeg und prüft den Export mit FFprobe.

> **PoC-Hinweis:** Der Mock liefert ein einfarbiges Testbild und einen kurzen 440-Hz-Testton. Er erzeugt weder echte Bilder noch gesprochene Sprache. Das Thema wird als Textoverlay eingeblendet. Es gibt noch keine echte KI-Inhaltserstellung und keine Veröffentlichungsfunktion.

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
| `GET` | `/api/v1/health` | API- und Mock-Provider-Gesundheit |
| `GET` | `/api/v1/shorts-jobs` | lokale Auftragsliste |
| `POST` | `/api/v1/shorts-jobs` | Auftrag anlegen; optional `Idempotency-Key` |
| `GET` | `/api/v1/shorts-jobs/:id` | Status, Verarbeitungsschritte und Ergebnis |
| `POST` | `/api/v1/shorts-jobs/:id/retry` | fehlgeschlagenen Auftrag erneut ausführen |
| `GET` | `/api/v1/shorts-jobs/:id/download` | fertiges MP4 herunterladen |

Ein Auftrag akzeptiert `topic` (1–240 Zeichen) sowie optional `durationSeconds` (1–60, Standard: 5). Bei identischem `Idempotency-Key` wird kein zweiter Auftrag angelegt.

Typischer Statusablauf:

```text
queued → generating_assets → rendering → validating → completed
                                              ↘ failed
```

## Tests

```bash
npm test          # Unit- und E2E-Tests
npm run test:e2e  # vollständiger API-/Mock-/FFmpeg-Ablauf
```

Der E2E-Test startet den Mock-Server und die API mit temporären Verzeichnissen und zufälligen lokalen Ports. Er prüft Validierung, Idempotenz, Jobstatus, Fehler-/Retry-Pfad, FFmpeg-Ausgabe, FFprobe-Metadaten und Download. Es sind keine externen KI-Dienste oder Zugangsschlüssel erforderlich.

## Implementierte Komponenten

- `src/api/server.mjs` – versionierte lokale HTTP-API.
- `src/jobs/job-store.mjs` – atomare JSON-Persistenz pro Auftrag und Idempotenzschlüssel.
- `src/jobs/job-runner.mjs` – serielle Pipeline, Status-/Schrittfortschritt, Wiederholung und Behandlung unterbrochener lokaler Prozesse.
- `src/providers/mock-media-provider.mjs` – isolierter HTTP-Adapter zum bestehenden Mock-Server mit Timeouts sowie MIME-/Größenprüfungen.
- `src/render/render-short.mjs` – vertikaler 1080×1920-Export mit H.264/AAC und Textoverlay.
- `src/render/validate-video.mjs` – FFprobe-Prüfung von MP4, Codecs, Abmessungen, Bildrate und Laufzeit.
- `scripts/mock-media-provider.mjs` – deterministischer Testbild-/Testton-Server.
- `ARCHITECTURE.md` – vollständiger Zielarchitekturentwurf und Ausbauplan.

## Grenzen und Sicherheit

Dies ist **kein Produktionsdienst**: Es gibt keine Anmeldung, Mandantentrennung, externe Datenbank oder Cloudspeicherung. Die Jobqueue läuft im API-Prozess und verarbeitet lokal seriell. Die API sollte nicht ohne Authentifizierung und zusätzliche Schutzmaßnahmen öffentlich bereitgestellt werden. Unterbrochene aktive Jobs werden beim Neustart als fehlgeschlagen markiert und können manuell erneut gestartet werden.

Echte Text-, Sprach-, Bild- und Musikprovider, Skript-/Szenenplanung, Nutzeroberfläche, Löschrichtlinien, Produktions-Queue, Monitoring und Social-Media-Veröffentlichung sind nicht implementiert. Der Architekturentwurf beschreibt, wie diese Komponenten später hinter klaren Schnittstellen ergänzt werden können.
