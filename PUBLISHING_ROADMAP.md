# Ausbauplan: automatisiertes Publishing auf YouTube und TikTok

**Stand der Plattformdokumentation:** 17. November 2026<br>
**Projektbezug:** vorhandener lokaler PoC in `Faceless-Shorts-Engine`

Für den nächsten Ausbau empfehle ich, YouTube zuerst mit einem sicheren Upload- und Freigabefluss anzubinden und TikTok zunächst als „Upload in den TikTok-Posteingang“ umzusetzen. TikTok Direct Post sollte ein späteres, eigenständiges Freigabegate sein: Die Plattform verlangt dafür eine Creator-orientierte Veröffentlichungsoberfläche und erklärt ein internes Tool, das nur Konten des eigenen Teams bedient, als ungeeigneten Anwendungsfall. [9] [10]

Der vorhandene PoC erzeugt derzeit ein Testbild und einen Testton. Es gibt weder Benutzeranmeldung noch OAuth-Konten, Publishing-Jobs, Datenbank, Cloudspeicher oder Veröffentlichungsfunktion. [Projektstand: `README.md`, `ARCHITECTURE.md`] Vor einem öffentlichen Betrieb sind daher zuerst Zugriffsschutz, dauerhafte Jobzustände und sichere Tokenablage nötig. Plattformtests sollten bis zur Ablösung des Testmediums auf private oder ausdrücklich dafür vorgesehene Konten beschränkt bleiben.

## Was die Plattformen für die Umsetzung bedeuten

### YouTube

Die YouTube Data API lädt Videos über `videos.insert` hoch. Der Aufruf kann Sichtbarkeit und Veröffentlichungszeitpunkt setzen; die Upload-API erlaubt resumable uploads, damit ein abgebrochener Transfer fortgesetzt werden kann. Für Hintergrundaufgaben braucht die Anwendung eine OAuth-Freigabe mit Offline-Zugriff und eine geschützte Ablage der Refresh-Tokens. [1] [4] [5]

Wichtig für sichere Voreinstellungen: `privacyStatus` muss explizit gesetzt werden. Die aktuelle Dokumentation weist darauf hin, dass nicht gesetzte Sichtbarkeit öffentlich sein kann. Außerdem wurde die frühere Einschränkung für nicht verifizierte API-Projekte am 2. November 2026 geändert; neue Uploads solcher Projekte sind nicht mehr automatisch auf privat begrenzt. [1] [2]

Die Standard-Uploadquote beträgt laut aktueller API-Dokumentation 100 `videos.insert`-Aufrufe pro Tag. YouTube behandelt quadratische oder vertikale Videos bis zu drei Minuten als Shorts; Videos über einer Minute mit aktivem Urheberrechtsanspruch können global blockiert werden. Vor dem Upload sind daher Laufzeit, Format und Rechte-/Musikstatus zu prüfen. [3] [6]

Für realistische KI-generierte oder wesentlich KI-veränderte Inhalte muss der Creator die Offenlegung setzen. Die API bietet dafür `status.containsSyntheticMedia`; die Engine sollte die Offenlegung als bewusste Metadatenentscheidung abbilden und nicht pauschal jedes KI-unterstützte Video gleich behandeln. [7] [8]

### TikTok

TikTok stellt zwei unterschiedliche Wege bereit. Beim **Upload-to-Inbox** wird die Datei in den TikTok-Posteingang des Creators übertragen. Die Person muss dort die Benachrichtigung öffnen, den Inhalt prüfen und den Post in TikTok selbst fertigstellen. Dieser Weg nutzt `video.upload` und ist für die erste Integration geeigneter als ein stiller, automatischer öffentlicher Post. [12] [13]

**Direct Post** veröffentlicht über `video.publish`. Vor der Veröffentlichungsoberfläche muss die Anwendung aktuelle Creator-Informationen abrufen und genau die vom Konto erlaubten Privatsphäre- und Interaktionsoptionen anzeigen. Die Person muss den Beitrag prüfen und dem Senden ausdrücklich zustimmen. Nicht geprüfte Apps sind auf private Sichtbarkeit und weitere Nutzungslimits beschränkt. TikTok verlangt außerdem, dass Direct Post echte Creator beim Veröffentlichen für ein breiteres Publikum unterstützt; ein rein internes Werkzeug für eigene oder Teamkonten ist laut Richtlinie kein zulässiger Anwendungsfall. Deshalb sollte die Produktfrage „nur eigenes Konto oder ein echtes Creator-Produkt?“ vor der Direct-Post-Implementierung geklärt werden. [9] [10] [11] [16]

Für beide TikTok-Wege ist Statusverfolgung wichtig. Der API-Aufruf liefert eine `publish_id`; anschließend kann die Anwendung Status abfragen oder Webhooks nutzen. Ein Upload in den Posteingang ist erst abgeschlossen, wenn der Creator in TikTok handelt. Ein erfolgreicher Datei-Transfer darf deshalb nicht als erfolgreich veröffentlichter Post angezeigt werden. [13]

## Empfohlene Umsetzungsphasen

### Phase 0 – Produkt- und Richtlinienentscheidung

Vor dem ersten TikTok-API-Code festlegen, wer die Engine nutzen soll. Wenn sie nur die privaten oder vom Team verwalteten Konten bedient, den TikTok-Direct-Post-Pfad zunächst aus dem Umfang nehmen. TikTok-Inbox-Upload kann als manuell abschließbarer Weg geprüft werden, ist aber kein Umgehungsweg für App-Freigabe oder Plattformrichtlinien. Falls die Engine als Creator-Produkt für mehrere unabhängige Nutzer gedacht ist, App und Produktablauf für TikToks Überprüfung vorbereiten.

Gleichzeitig die Veröffentlichungsregeln definieren: kein öffentlicher Post ohne sichtbare Vorschau, ausdrückliche Freigabe und festgelegtes Zielkonto. Automatisches Hochladen und öffentliches Veröffentlichen sind getrennte Aktionen. Für die erste Version sollte unbeaufsichtigtes öffentliches Publishing deaktiviert bleiben.

**Abnahme:** TikTok-Modus ist als „Posteingang/Creator schließt in TikTok ab“ oder „Direct Post nach Prüfung“ entschieden; Testkonten, Consent-Regel und Veröffentlichungsstandard sind dokumentiert.

### Phase 1 – Gemeinsamer Publishing-Unterbau

Publishing als eigenen, asynchronen Jobtyp neben der Render-Pipeline modellieren. Der aktuelle `JobRunner` ist eine serielle In-Process-Queue und markiert aktive Jobs beim Prozessabbruch als fehlgeschlagen. Der lokale JSON-`JobStore` ist für mehrere Worker oder parallele Veröffentlichungen keine belastbare Produktionsbasis. Deshalb sollte der Publishing-Unterbau vor Live-Uploads auf persistente, wiederaufnehmbare Jobs und eine Datenbank-/Queue-Architektur wechseln oder zunächst klar auf einen lokalen Einzelbenutzerbetrieb begrenzt bleiben. [Projektstand: `src/jobs/job-runner.mjs`, `src/jobs/job-store.mjs`]

Ein Publishing-Job sollte mindestens Plattform, verbundenes Zielkonto, Quellvideo und Prüfsumme, Metadaten-Snapshot, expliziten Freigabezeitpunkt, aktuellen Zustand, Versuchsnummer sowie externe Plattform-ID speichern. Geheimnisse gehören nur in einen geschützten Token-Speicher, nie in Jobdaten, Repository oder Logs. Ein sinnvoller gemeinsamer Statusfluss ist:

```text
queued → preflight → awaiting_confirmation → uploading → platform_processing
       → awaiting_creator_action → published
       ↘ failed / cancelled / needs_attention
```

`awaiting_creator_action` wird vor allem für TikTok-Inbox-Uploads gebraucht. Ein Zustand `needs_attention` verhindert automatische Wiederholung, wenn unklar ist, ob eine Plattform den Post bereits angenommen hat.

Neue Module können unter `src/publishing/` beginnen: gemeinsamer Adaptervertrag, Plattformadapter, Metadatenvalidierung, OAuth-/Kontoverwaltung und Statusabgleich. Die vorhandene `VideoValidator`-Prüfung kann um plattformbezogene Preflight-Regeln erweitert werden, etwa Dauergrenzen, Inhaltshinweise und Uploadgröße.

**Abnahme:** ein Test-Publisher kann einen fertigen lokalen MP4-Export als Mock-Auftrag annehmen, Freigabezustand, Statusübergänge und Fehlerpfade dauerhaft speichern und nach Neustart fortsetzen, ohne echte Posts auszulösen.

### Phase 2 – YouTube-Adapter mit sicherem Upload

Zuerst die Google-OAuth-Verbindung pro YouTube-Kanal einrichten. Für die erste Version nur benötigte Scopes anfordern, erteilte Scopes prüfen, Refresh-Tokens verschlüsselt speichern und „Konto trennen“ mit Tokenwiderruf vorsehen. Ein Kanal muss eindeutig dem eigenen Publishing-Konto zugeordnet werden.

Der Adapter sollte Datei und Metadaten nach Freigabe als resumable upload senden. Sichtbarkeit immer ausdrücklich setzen, in der Entwicklungsphase standardmäßig `private`. Rückgabe-ID und Upload-Session müssen im Job gespeichert werden. Nach dem Transfer `videos.list` für `status` und `processingDetails` verwenden, bis die Verarbeitung abgeschlossen ist oder ein Fehler feststeht. `videos.insert` allein belegt nicht, dass die Verarbeitung abgeschlossen oder der Beitrag öffentlich ist. [1] [4] [5] [7] [17]

Das Metadatenformular braucht Titel, Beschreibung, Tags/Hashtags, Privatsphäre, optionalen Veröffentlichungszeitpunkt sowie eine bewusste Antwort zur Kennzeichnung synthetischer Inhalte. Eine geplante Veröffentlichung darf erst nach expliziter Freigabe als öffentlich oder geplant an YouTube übergeben werden. Die Upload-Vorschau sollte außerdem zeigen, dass vertikale Videos bis drei Minuten als Shorts infrage kommen und dass aktive Copyright-Claims bei Shorts über einer Minute ein Blockierungsrisiko darstellen. [6] [8]

**Abnahme:** automatisierter OAuth-Test mit eigenem Testkanal; ein Video lässt sich als privat resumable hochladen, der Job verfolgt Verarbeitung und Fehler, und erneutes Zustellen desselben Jobs erzeugt keinen zweiten Upload.

### Phase 3 – TikTok-Upload in den Posteingang

Nach positiver Prüfung der TikTok-App und des `video.upload`-Scopes zunächst den Upload-to-Inbox-Adapter bauen. Für den PoC ist `FILE_UPLOAD` der einfachste Weg, weil die vorhandene Datei lokal vorliegt. Große Dateien werden gemäß TikToks Chunk-Regeln sequenziell übertragen; die zurückgegebene `upload_url` ist nur eine Stunde gültig. `PULL_FROM_URL` sollte erst ergänzt werden, wenn ein eigener HTTPS-Speicher mit verifizierter Domain bereitsteht und die Datei ohne Redirect erreichbar ist. [12] [14]

Die Oberfläche muss nach dem Upload klar mitteilen, dass der Creator die TikTok-Inbox öffnen und den Beitrag dort selbst fertigstellen muss. Den `publish_id` speichern und den Status als `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE` oder `FAILED` darstellen. Statuspolling begrenzen; Webhooks können später die Zustellung und den Abschluss zuverlässiger melden. TikTok erlaubt höchstens fünf ausstehende Shares innerhalb eines beliebigen 24-Stunden-Zeitraums pro Nutzer. [12] [13]

**Abnahme:** ein Upload erscheint im vorgesehenen Testkonto, die App zeigt „In TikTok fertigstellen“ statt „veröffentlicht“, und Status-/Fehlermeldungen stimmen mit TikToks Antwort überein.

### Phase 4 – TikTok Direct Post, nur nach Freigabegate

Diese Phase erst starten, wenn TikToks Anforderungen an Produkt, Zielgruppe und App-Audit erfüllt sind. Der Freigabedialog darf kein versteckter Hintergrundschritt sein. Vor jeder Veröffentlichung Creator-Informationen frisch abrufen und Creator-Name, Video-Vorschau, bearbeitbare Caption/Hashtags, erlaubte Privatsphäreoptionen, zulässige Interaktionen und maximale Dauer anzeigen. Privatsphäre nicht vorauswählen; Interaktionen standardmäßig ausgeschaltet lassen, sofern TikToks Vorgaben dies verlangen. Erst nach ausdrücklicher Bestätigung senden. KI- und kommerzielle Inhaltskennzeichnungen sind in diesen Dialog einzubeziehen. [9] [10] [11]

Bei Erstellung des Direct-Post-Auftrags den Creator-Status und die erlaubte Maximaldauer prüfen. Danach Transfer und Verarbeitungsstatus über `publish_id` verfolgen. Eine erfolgreiche Annahme oder ein laufender Moderationsprozess ist noch keine öffentliche Verfügbarkeit; die Oberfläche muss diese Zustände auseinanderhalten. TikTok-Access-Tokens laufen laut Dokumentation nach 24 Stunden ab, Refresh-Tokens nach 365 Tagen. Da ein Refresh-Token rotiert werden kann, muss die Anwendung den neuen Wert atomar speichern. [11] [13] [15]

**Abnahme:** TikTok-App ist auditfähig und freigegeben; der Composer erfüllt Creator-UX-Vorgaben; ein erfolgreicher öffentlicher Test wird nur für ein ausdrücklich freigegebenes Konto durchgeführt und bis zur finalen Verfügbarkeit nachverfolgt.

### Phase 5 – Zeitplanung, Betrieb und Schutz vor Duplikaten

Erst nach stabilen Upload-Adaptern eine planbare Publishing-Queue hinzufügen. YouTube kann einen Veröffentlichungszeitpunkt erhalten. Für TikTok darf die Engine keine unbeaufsichtigte Veröffentlichung zu einer festen Uhrzeit versprechen, solange der gewählte API-Fluss eine ausdrückliche Zustimmung oder das manuelle Fertigstellen in TikTok verlangt. [1] [9] [12]

Für beide Plattformen Fehlerklassen unterscheiden: Netzwerkabbrüche und `429`/ausgewählte `5xx` können mit begrenztem exponentiellem Backoff wiederholt werden. Authentifizierungs-, Richtlinien-, Inhalts- und Rechtefehler benötigen eine Korrektur statt automatischer Wiederholung. Bei einem Timeout nach dem Senden zuerst externen Status abgleichen; nicht blind neu hochladen. Audit-Logs sollen Zielkonto, Video-Prüfsumme, Freigabe, Metadatenänderungen, externe IDs und Statusverlauf enthalten, aber keine Tokens.

**Abnahme:** Last-/Fehlertests mit simulierten Plattformantworten, Retry-Limits, Duplikatschutz, Wiederanlauf nach Neustart und verständliche Statusmeldungen sind automatisiert getestet. Live-Tests bleiben ein separater, manuell freigegebener Schritt.

## Geplanter Bedienablauf für die erste nutzbare Version

1. Ein Render-Job endet mit `completed`; Nutzer sieht Vorschau und Download.
2. Nutzer wählt Zielkonto und Plattform und bearbeitet Titel/Beschreibung sowie Offenlegungsfelder.
3. Die Engine prüft Laufzeit, Videoeigenschaften, Rechte- und Kennzeichnungsfelder.
4. Nutzer bestätigt das Ziel und die Sichtbarkeit.
5. YouTube lädt in der ersten Version privat hoch; öffentliche oder geplante Sichtbarkeit erfordert eine weitere explizite Aktion.
6. TikTok überträgt zunächst nur in den Posteingang; die Person veröffentlicht anschließend selbst in TikTok.
7. Status und externe IDs bleiben beim Publishing-Job nachvollziehbar.

## Vorschlag für API-Erweiterungen

Als schmale erste Oberfläche eignen sich `POST /api/v1/connections/:platform/oauth/start`, `GET /api/v1/connections`, `POST /api/v1/shorts-jobs/:id/publish`, `GET /api/v1/publishing-jobs/:id` und `POST /api/v1/publishing-jobs/:id/confirm`. OAuth-Callbacks müssen serverseitig verarbeitet und mit CSRF-/State-Prüfung geschützt werden. Die konkreten Pfade sind Vorschläge; wichtiger ist die Trennung zwischen Videogenerierung, Upload-Job und finaler Plattformfreigabe.

## Noch offene Entscheidungen vor der Implementierung

- Bleibt die Engine ein lokales Einzelbenutzerwerkzeug oder wird sie ein Mehrnutzerprodukt? Das beeinflusst Authentifizierung, Datenbank, Token-Speicherung und TikTok-Eignung.
- Soll TikTok zunächst nur Videos in den Creator-Posteingang übertragen, oder ist eine TikTok-konforme Direct-Post-Anwendung samt Review das Produktziel?
- Wo läuft der OAuth-Callback dauerhaft über HTTPS? Eine eigene verifizierbare Domain ist zusätzlich nötig, falls TikTok-Dateien per `PULL_FROM_URL` beziehen soll. [14]
- Welche Inhalte sind tatsächlich KI-generiert, realistisch verändert oder mit Drittmaterial vertont? Diese Angaben bestimmen Offenlegungs- und Rechteprüfungen; der derzeitige Mock-Export reicht für diese fachliche Prüfung nicht aus. [6] [8]

## References

[1]: https://developers.google.com/youtube/v3/docs/videos/insert "YouTube Data API videos.insert"
[2]: https://developers.google.com/youtube/data/revision_history "YouTube Data API Revision History"
[3]: https://developers.google.com/youtube/v3/determine_quota_cost "YouTube Data API Quota Costs"
[4]: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps "YouTube OAuth 2.0 for Server-Side Web Applications"
[5]: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol "YouTube Resumable Upload Protocol"
[6]: https://support.google.com/youtube/answer/15424877?hl=en "Understand Three-Minute YouTube Shorts"
[7]: https://developers.google.com/youtube/v3/docs/videos "YouTube Data API Video Resource"
[8]: https://support.google.com/youtube/answer/14328491?hl=en "Disclosing Use of GenAI Content"
[9]: https://developers.tiktok.com/doc/content-sharing-guidelines "TikTok Content Sharing Guidelines"
[10]: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post "TikTok Direct Post API Reference"
[11]: https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info "TikTok Query Creator Info API Reference"
[12]: https://developers.tiktok.com/doc/content-posting-api-reference-upload-video "TikTok Upload API Reference"
[13]: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status "TikTok Get Post Status API Reference"
[14]: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide "TikTok Media Transfer Guide"
[15]: https://developers.tiktok.com/doc/oauth-user-access-token-management "TikTok Manage User Access Tokens"
[16]: https://developers.tiktok.com/doc/content-posting-api-get-started "TikTok Content Posting API Get Started"
[17]: https://developers.google.com/youtube/v3/docs/videos/list "YouTube Data API videos.list"
