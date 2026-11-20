# Autopilot-Backlog: nächste zehn Sprints

Der Autopilot bearbeitet pro wöchentlicher Aktivierung genau den ersten `pending`-Eintrag. Änderungen müssen den Vertrag in [AUTOPILOT_POLICY.md](AUTOPILOT_POLICY.md) einhalten. Ein `completed`-Eintrag wird nicht automatisch wieder geöffnet.

## Sprint 1 — API-Vertrag und Eingabevalidierung

**Ziel:** Publishing-Routen mit Schema-/API-Vertragstests absichern, einschließlich Fehlerantworten, Authentifizierung, Idempotenz, erlaubter Metadaten und Statusantworten.<br>
**Abnahme:** Tests prüfen positive und negative API-Anfragen; unbekannte Felder und ungültige Werte verursachen keine externen Aufrufe.

**Status:** completed — `tests/unit/publishing-api.test.mjs` prüft Feature-Gate, Bearer-Key, Scope-URL, ungültige Modi, geschützte Jobliste, unbekannte Plattformen und Direct-Post-Sperre. `node --test tests/unit/publishing-api.test.mjs` bestanden (2 Tests); keine echten Anbieteraufrufe.

## Sprint 2 — Unveränderliche Medienidentität

**Ziel:** SHA-256-Prüfsumme und Größen-/Metadatensnapshot in Publishing-Jobs speichern, damit Änderungen an der Quelldatei vor Bestätigung und Upload erkannt werden.<br>
**Abnahme:** Dateiänderung nach Preflight blockiert Bestätigung; derselbe Snapshot ist nach Neustart reproduzierbar.

**Status:** completed — `src/publishing/media-identity.mjs` streamt SHA-256 speicherschonend und erkennt Änderungen während der Snapshot-Erfassung; `service.mjs` prüft Identität bei Bestätigung und direkt vor dem Plattformaufruf; `job-store.mjs` persistiert den Snapshot und schützt ihn vor Änderungen. Tests in `tests/unit/publishing-service.test.mjs` prüfen Hash/Größe/Metadaten, Reload-Reproduzierbarkeit, unveränderliche Speicherung und Blockierung bei geänderter Datei oder Metadaten. `npm test`: 36 bestanden, 0 fehlgeschlagen; `git diff --check` und `node --check` erfolgreich. Nur lokale Tests, keine Plattformaufrufe. Restrisiko: eine Dateiänderung nach der letzten Prüfung, während der Upload bereits läuft, ist ohne unveränderliche Uploadkopie nicht ausgeschlossen.

## Sprint 3 — OAuth-Entkopplung und sichere Trennung

**Ziel:** Fehlerpfade bei Tokenwiderruf, Reconnect, abgelaufenen Refresh-Tokens und fehlgeschlagener Kanalermittlung so behandeln, dass lokale Secrets nicht versehentlich erhalten bleiben und der Nutzer den Zustand versteht.<br>
**Abnahme:** Mock-Provider-Tests decken Widerrufserfolg und -fehler ab; keine Zugangsdaten erscheinen in API-Antworten oder Logs.

**Status:** completed — `oauth.mjs` normalisiert Providerfehler ohne Rohantworten; `token-manager.mjs` entfernt lokal abgelehnte Refresh-Tokens, erhält Verbindungen bei transienten Fehlern und löscht lokale Tokens vor dem Remote-Widerruf mit klarer Meldung bei dessen Fehlschlag. `connection-service.mjs` widerruft nicht gespeicherte Grants nach Scope-/Kanal-Lookupfehlern und hält bestehende Konten bei fehlgeschlagenem Reconnect. `token-vault.mjs` speichert Änderungen transaktional. API-Tests prüfen Reconnect, Kanalfehler, lokalen Disconnect, Provider-Widerruf und Secret-Redaktion. `npm test`: 42 bestanden, 0 fehlgeschlagen; `git diff --check` und Syntaxprüfungen erfolgreich. Nur lokale Mock-Provider, keine echten OAuth-Aufrufe. Restrisiko: Live-Providerantworten wurden nicht verifiziert; unbekannte Refresh-Fehlercodes werden sicher als vorübergehender Fehler behandelt und nicht automatisch gelöscht.

## Sprint 4 — Begrenzte Retries und Backoff

**Ziel:** Wiederholbare Netzwerk- und Rate-Limit-Fehler von endgültigen Auth-, Richtlinien- und Inhaltsfehlern unterscheiden. Retries müssen begrenzt, idempotent und pro Plattform beobachtbar sein.<br>
**Abnahme:** deterministische Tests belegen Retry-Limit und Backoff; unklare Uploadannahme wird niemals blind wiederholt.

**Status:** completed — `src/publishing/retry.mjs` implementiert begrenzte Retries mit exponentiellem, injizierbarem Backoff und datensparsamen Retry-Ereignissen. YouTube- und TikTok-Statusabfragen wiederholen nur transient klassifizierte Fehler; YouTube sendet einen Chunk erst erneut, nachdem die Sessionabfrage keinen Fortschritt bestätigt hat. Sessionstarts sowie unklare YouTube-/TikTok-Chunkannahmen werden nicht blind wiederholt und der Publishing-Service markiert unklare Annahmen als `needs_attention`; sichere Retry-Ereignisse werden plattformbezogen am Job gespeichert. Tests in `tests/unit/publishing-retry.test.mjs`, `tests/unit/platform-publishers.test.mjs` und `tests/unit/publishing-service.test.mjs` belegen Limits, Backoff, endgültige Fehler, Beobachtbarkeit und unsichere Uploadpfade. `npm test`: 50 bestanden, 0 fehlgeschlagen; gezielte Tests: 18 bestanden; `git diff --check` und Syntaxprüfungen erfolgreich. Nur lokale Mocks; keine echten Plattformaufrufe. Restrisiko: Live-Providersemantik und Rate-Limit-Header wurden nicht verifiziert; TikTok-Uploads mit unklarem Chunkstatus benötigen weiterhin manuellen Abgleich.

## Sprint 5 — Wiederanlauf und externe Statusabstimmung

**Ziel:** Neustartverhalten für YouTube-Session und Plattformstatus konkretisieren. Wo ein sicherer Abgleich möglich ist, den bestehenden Upload wieder aufnehmen; andernfalls explizit bei `needs_attention` bleiben.<br>
**Abnahme:** Fault-Injection-Tests für Abbruch an Sessionstart, Chunktransfer und Plattformverarbeitung verhindern Duplikate.

**Status:** completed — `youtube.mjs` fragt eine persistierte YouTube-Session vor dem Resume ab, setzt nur ab der bestätigten Byteposition fort und erkennt bereits abgeschlossene Sessions ohne erneuten Chunkupload. `service.mjs` queued nach einem Neustart nur YouTube-Jobs mit entschlüsselbarer gespeicherter Session; unterbrochene Starts ohne Session bleiben in `needs_attention`. Bereits übertragene Jobs in `platform_processing` werden nach Neustart per Statusabfrage abgeglichen; bei fehlgeschlagenem Abgleich ist manuelle Prüfung erforderlich. Fault-Injection-Tests in `tests/unit/platform-publishers.test.mjs` und `tests/unit/publishing-service.test.mjs` decken Sessionresume, abgeschlossene Session, Chunkabbruch und Statusabgleich ab. `npm test`: 56 bestanden, 0 fehlgeschlagen; gezielte Tests: 22 bestanden; `git diff --check` und Syntaxprüfungen erfolgreich. Nur lokale Mocks; keine echten Provideraufrufe. Restrisiko: TikTok-Uploads mit Unterbrechung vor Speicherung der `publish_id` können nicht automatisch fortgesetzt werden und erfordern manuellen Statusabgleich.

## Sprint 6 — TikTok-Kontingente und Statuspolling

**Ziel:** Ausstehende Inbox-Aufträge und Statusabfragen begrenzen, damit App- und Nutzerlimits eingehalten und Rate-Limits nicht durch häufiges Polling verschärft werden.<br>
**Abnahme:** Mock-Tests prüfen Sperrgrenzen, Wartezeiten und verständliche `awaiting_creator_action`-Statusmeldungen.

**Status:** completed — `service.mjs` begrenzt offene TikTok-Inbox-Jobs pro Konto (Standardlimit 5), serialisiert konkurrierende Jobanlagen und erhält Idempotenz auch bei voller Kapazität. Statusabfragen werden pro Konto mit persistiertem Zeitstempel und injizierbarem Cooldown (Standard 60 Sekunden) seriell ausgeführt; vor Ablauf erfolgt kein Plattformaufruf. TikTok-Inbox- und Cooldown-Meldungen bleiben am Job gespeichert und werden durch die API ausgegeben; wiederholtes `awaiting_creator_action` erzeugt keinen ungültigen Statusübergang. Mocktests prüfen gleichzeitige Creates, Cap/Idempotenz, Poll-Lock, Cooldown-Grenze, Inbox-Meldung und API-Ausgabe. Gezielte Tests: 15 bestanden; `npm test`: 59 bestanden, 0 fehlgeschlagen; `git diff --check` und Syntaxprüfungen erfolgreich. Nur lokale Mocks, keine echten TikTok-Aufrufe. Restrisiko: Sperren gelten innerhalb einer Service-Instanz; Multi-Prozess-/Mehrinstanz-Deployment wurde nicht eingeführt oder getestet.

## Sprint 7 — Prüffähiger Audit-Trail

**Ziel:** Lokale, datensparsame Historie für Zielkonto, Quelle, Prüfsumme, Freigabe, Metadatenänderung und Statusübergänge ergänzen. Keine Tokens, Session-URLs oder vollständigen privaten Inhalte protokollieren.<br>
**Abnahme:** Tests prüfen Ereignisreihenfolge, Bereinigung vertraulicher Felder und atomare Persistenz.

**Status:** completed — `job-store.mjs` persistiert `job_created`, sichere `metadata_changed`-Feldnamen, `approval_granted` und Statuswechsel als append-only Historie im selben `publish.json` wie den Jobstatus. Der Audit zeichnet Plattform/Zielkonto, Quelljob-ID und SHA-256 auf, aber keine Metadatenwerte, Token-, Session-, URI- oder URL-Feldnamen; Audit-Ergänzungen aus Mutatoren sind allowlisted. Job- und Idempotency-Index werden erst nach erfolgreicher Persistenz sichtbar. `server.mjs` gibt den lokalen Audit-Trail am authentifizierten Jobendpunkt aus. Tests prüfen Ereignisreihenfolge, Redaktion, Datei-/Reload-Konsistenz und fehlgeschlagene Persistenz bei Update/Anlage. Gezielte Tests: 11 bestanden; `npm test`: 62 bestanden, 0 fehlgeschlagen; `git diff --check` und Syntaxprüfungen erfolgreich. Nur lokale Tests. Restrisiko: ältere Publishing-Jobs enthalten keine rückwirkende Ereignishistorie; Dateisystemzugriff auf lokale Publishing-Daten bleibt durch Betriebssystemberechtigungen zu schützen.

## Sprint 8 — Creator-Vorschau und Freigabeoberfläche

**Ziel:** Eine lokale Bedienoberfläche für Video-Vorschau, Zielkonto, Metadaten, Privatsphäre, Offenlegung und explizite Veröffentlichung entwerfen und implementieren, ohne externe Konten zu verbinden.<br>
**Abnahme:** UI-Tests belegen, dass keine Uploadaktion vor Sichtprüfung und Bestätigung ausgelöst wird. Falls dafür ein separater Hosting-/Frameworkwechsel notwendig wäre, nicht automatisch migrieren.

**Status:** completed — Lokales Publishing Studio unter `/publishing-studio` mit Preview-/Sichtprüfgates, plattformspezifischen Metadaten, flüchtigem API-Key und separater ausdrücklicher Uploadfreigabe; CSP-geschützte lokale Assets werden nur bei aktiviertem Publishing ausgeliefert. Ein schreibgeschützter GET-Statusabgleich verhindert blinde Wiederholungen nach unklarer Freigabeantwort. TikTok-Inbox-Hinweis verweist für Privatsphäre und KI-Offenlegung auf die TikTok-App; README dokumentiert Zugang, Ablauf und Grenzen. Tests in `tests/unit/publishing-api.test.mjs` belegen Gates und Statusabgleich. Gezielte Tests: 6 bestanden; `npm test`: 64 bestanden, 0 fehlgeschlagen; alle `.mjs`-Syntaxprüfungen und `git diff --check` erfolgreich. Nur lokale Mocks; weder echte OAuth-Anmeldung noch Plattformupload oder Browser-Integration wurden ausgeführt.

## Sprint 9 — Betriebsdiagnostik und Datenpflege

**Ziel:** Health-/Readiness-Informationen, Jobbereinigungsvorschläge und verständliche Fehlerdiagnostik ergänzen, ohne geheime Werte preiszugeben oder Daten automatisch zu löschen.<br>
**Abnahme:** API-Tests unterscheiden deaktiviertes Publishing, fehlende OAuth-Konfiguration, Providerstörung und manuelle Aufmerksamkeit.

**Status:** completed — `/api/v1/health` meldet Readiness, Mock-Provider-Ausfall (HTTP 503) und Publishing-/OAuth-Konfigurationsstatus ohne Geheimnisse. Die authentifizierte `/api/v1/publishing/diagnostics` listet `needs_attention`/`awaiting_creator_action` mit sicheren nächsten Schritten und schlägt nur `published`-/`cancelled`-Jobs älter als 30 Tage zur manuellen Bereinigung vor; automatische Löschung ist ausgeschlossen. Fehlende OAuth-Daten führen zu einer verständlichen `OAUTH_NOT_CONFIGURED`-Antwort. README dokumentiert Endpunkte, Grenzen und Aufbewahrungsregel. Gezielte API-Tests: 8 bestanden; `npm test`: 66 bestanden, 0 fehlgeschlagen; alle `.mjs`-Syntaxprüfungen und `git diff --check` erfolgreich. Ausschließlich lokale Testdaten und simulierte Antworten.

## Sprint 10 — Simulierter End-to-End-Abnahmelauf

**Ziel:** Vollständigen Render-zu-Publishing-Ablauf mit lokalen Mock-YouTube-/TikTok-Antworten und Fault-Injection automatisieren. Kein Test darf echte OAuth- oder Plattformzugänge verwenden.<br>
**Abnahme:** Saubere Testausführung, Diffprüfung, dokumentierte Grenzen; danach ist der Autopilot zu deaktivieren und es werden keine weiteren Sprints automatisch erzeugt.

**Status:** completed — `tests/e2e/publishing.test.mjs` simuliert den vollständigen lokalen Render-zu-Publishing-Ablauf mit synthetischem OAuth, YouTube-Upload und Statusabgleich sowie TikTok-Inbox-Upload. Fault Injection deckt YouTube-429-Retry und eine unklare TikTok-Chunkannahme ab; der unsichere TikTok-Upload wird nicht blind wiederholt und bleibt `needs_attention`. `README.md` dokumentiert beide E2E-Abläufe, Mock-Grenzen und dass keine echten Konten/Provider verwendet werden. `npm run test:e2e`: 8 bestanden, 0 fehlgeschlagen; `npm test`: 68 bestanden, 0 fehlgeschlagen; Syntaxprüfungen aller `.mjs`-Dateien und `git diff --check` erfolgreich. Ausschließlich lokale Medien- und injizierte Plattform-Mocks, keine echten OAuth-Zugänge oder erfolgreichen Live-Uploads. Restrisiko: Live-Verhalten und aktuelle Anbieteranforderungen wurden nicht verifiziert. Beim ersten Integrationsversuch wurde wegen fehlender `fetchImpl`-Weitergabe ein synthetisches Token an den echten YouTube-Endpunkt gesendet und mit HTTP 401 abgewiesen; die Injektion wurde behoben, und alle erfolgreichen Wiederholungstests blieben auf lokale Mocks begrenzt.


## Folgepaket: Sprints 11–20 — lokale Betriebsreife

Dieses Paket wurde vom Nutzer am 21. November 2026 freigegeben. Umfang: lokale Einzelbenutzer-Betriebsreife; lokale Mocks; keine echten Anbieterzugriffe, öffentlichen Posts, neuen Publishing-Freigaben, Deployments, Commits oder Pushes. TikTok bleibt beim Inbox-Ablauf; Direct Post und öffentliche Veröffentlichungen bleiben außerhalb des Pakets, solange Produkt- und Plattformfreigaben nicht ausdrücklich geklärt sind. Pro Aktivierung wird nur der erste `pending`-Sprint bearbeitet.

### Sprint 11 — Betriebsmodell und Freigabegrenzen

**Ziel:** Betriebsannahmen und offene Produktentscheidungen für den lokalen Einzelbenutzer-PoC nachvollziehbar dokumentieren; vorhandene Preview-, Bestätigungs- und Plattformgrenzen nicht abschwächen.
**Abnahme:** Dokumentation unterscheidet lokale Einzelbenutzung von Produktions-/Mehrnutzerbetrieb, TikTok Inbox von Direct Post sowie Uploadannahme von tatsächlicher Veröffentlichung. Ungeklärte Produktentscheidungen sind als offen markiert; es werden keine neuen Freigabeschalter aktiviert.

**Status:** completed — `README.md` dokumentiert den lokalen Einzelbenutzer-PoC als Nicht-Produktionsdienst, trennt TikTok-Inbox-Übergabe und `awaiting_creator_action` von einer tatsächlichen Veröffentlichung und erklärt YouTube-Sichtbarkeit/Uploadannahme. Mehrnutzerbetrieb, TikTok-Direct-Post-Produktkonformität, Produktionsbetrieb sowie Rechte-/Offenlegungsregeln für echte Medien sind ausdrücklich als offene Entscheidungen markiert. Es wurden keine Publishing-Freigaben oder Laufzeitfunktionen geändert. `npm test`: 68 bestanden, 0 fehlgeschlagen; `git diff --check` erfolgreich. Dokumentationsänderung; Live-Verhalten und reale Plattformkonten wurden nicht geprüft.

### Sprint 12 — Start- und Konfigurationsschutz

**Ziel:** Publishing-Start und Konfigurationsdiagnostik gegen unsichere Bind-Adressen, unvollständige Schlüssel und widersprüchliche Einstellungen absichern.
**Abnahme:** Deterministische Konfigurationstests belegen, dass Publishing nur mit gültiger Loopback-Konfiguration startet, unsichere Konfiguration verständlich abgelehnt wird und Fehlerantworten keine Schlüsselwerte enthalten. Vorhandene Freigabeschalter bleiben unverändert.

**Status:** completed — `tests/unit/publishing-config.test.mjs` prüft die dokumentierte Loopback-Allowlist, Ablehnung öffentlicher/ungültiger Hosts, fehlende und ungültige API-/Token-Schlüssel ohne Wert-Leaks sowie, dass OAuth- oder TikTok-Gates Publishing ohne `PUBLISHING_ENABLED` nicht aktivieren. `tests/unit/publishing-api.test.mjs` prüft Health-Readiness bei partieller OAuth-Konfiguration und redigierte `OAUTH_NOT_CONFIGURED`-Fehler. Laufzeitcode und bestehende Freigabeschalter blieben unverändert. Gezielte Tests: 15 bestanden, 0 fehlgeschlagen; `npm test`: 72 bestanden, 0 fehlgeschlagen; `git diff --check` erfolgreich. Nur synthetische Werte und lokale Tests; keine echten Providerzugriffe.

### Sprint 13 — API- und Mediagrenzen

**Ziel:** Eingabe-, Request- und Mediengrenzen für Publishing-Endpunkte explizit validieren, bevor Daten persistiert oder Provideradapter aufgerufen werden.
**Abnahme:** Tests decken ungültige/überlange Metadaten, unerlaubte Felder, übergroße oder nicht passende Mediendaten sowie unzulässige lokale Pfade ab; abgelehnte Eingaben erzeugen keine Plattform-Mock-Aufrufe und keine Publishing-Jobs.

**Status:** pending

### Sprint 14 — OAuth-State und Token-Erneuerung härten

**Ziel:** Ablauf- und Konkurrenzfälle bei OAuth-State, Reconnect und Token-Refresh mit kontrollierten Mocks absichern.
**Abnahme:** Tests belegen Ablehnung abgelaufener, wiederverwendeter und falsch gebundener States, Zusammenführung gleichzeitiger Refreshes, sichere Behandlung rotierter Tokens und Redaktion in Antworten/Logs. Es werden keine echten OAuth-Zugänge verwendet.

**Status:** pending

### Sprint 15 — Persistenzfehler und lokale Wiederherstellung

**Ziel:** Fehlerhafte, unvollständige oder nicht lesbare lokale Jobdateien kontrolliert diagnostizieren, ohne gültige Nachbarjobs zu beschädigen.
**Abnahme:** Fault-Injection-Tests für beschädigte JSON-Dateien und fehlgeschlagene atomare Schreibvorgänge belegen, dass der Dienst keine Daten stillschweigend überschreibt oder löscht, den betroffenen Zustand sicher meldet und Geheimnisse nicht ausgibt.

**Status:** pending

### Sprint 16 — Prozessabbruch an Publishing-Grenzen

**Ziel:** Abbrüche um Uploadstart, Chunktransfer und Plattform-Statusabgleich per lokalen Mocks durch den Wiederanlaufpfad prüfen.
**Abnahme:** Neustarttests zeigen, dass sicher fortsetzbare Zustände abgeglichen werden und unklare externe Annahmen auf `needs_attention` bleiben; kein Fault-Injection-Fall löst einen blinden zweiten Upload aus.

**Status:** pending

### Sprint 17 — Speicherübersicht und nichtdestruktive Aufbewahrung

**Ziel:** Lokale Job-/Exportbelegung und Aufbewahrung nachvollziehbar machen und sichere manuelle Bereinigungsvorschläge ergänzen, ohne Daten automatisch zu löschen.
**Abnahme:** Tests prüfen Berechnungen/Filter für terminale und aktive Jobs, die Nichtaufnahme aktiver oder manuell zu prüfender Uploads sowie redigierte Diagnoseausgaben. Es gibt keinen automatischen Löschpfad.

**Status:** pending

### Sprint 18 — Einheitliche Fehlerdiagnostik und Redaktion

**Ziel:** Plattform-, Konfigurations- und Persistenzfehler mit stabilen, nutzerverständlichen Fehlercodes und sicheren Handlungshinweisen darstellen.
**Abnahme:** Tests unterscheiden Auth-, Rate-Limit-, Inhalts-, Provider- und unklare Uploadfehler; keine Antwort oder Diagnose enthält Tokens, Session-URLs, private Metadaten oder rohe Providerantworten.

**Status:** pending

### Sprint 19 — Publishing-Studio-Bedienbarkeit

**Ziel:** Tastaturbedienung sowie Lade-, Leer-, Fehler- und Wiederabgleichszustände im lokalen Publishing Studio verbessern, ohne die Freigabeschritte zu verkürzen.
**Abnahme:** UI-/Flow-Tests belegen zugängliche Beschriftungen und Fokusführung, sichtbare Statusmeldungen, fortbestehende Sichtprüfung und separate Uploadbestätigung sowie sicheren GET-Statusabgleich nach unklarer Antwort. Direct Post bleibt gesperrt.

**Status:** pending

### Sprint 20 — Lokaler Release-Abnahmelauf

**Ziel:** Die lokalen Sicherheits-, Wiederherstellungs- und E2E-Prüfungen des Folgepakets als reproduzierbaren Abnahmelauf dokumentieren.
**Abnahme:** `npm run test:e2e`, `npm test`, Syntaxprüfungen aller `.mjs`-Dateien und `git diff --check` bestehen; Testdokumentation nennt Mock-Grenzen und offene Live-Risiken. Es werden keine echten Konten/Provider, Deployments, Commits oder Pushes verwendet. Nach Abschluss dieses freigegebenen Zehnerpakets wird der zugehörige Wochen-Schedule pausiert; es werden keine weiteren Sprints ohne neue Nutzerfreigabe ergänzt.

**Status:** pending
