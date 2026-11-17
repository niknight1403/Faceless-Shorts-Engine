# Publishing-Ausbau – Abschluss der zehn Umsetzungsschritte

**Projekt:** Faceless-Shorts-Engine<br>
**Stand:** 17. November 2026<br>
**Ergebnis:** Lokaler Publishing-Unterbau für YouTube und TikTok implementiert und mit Mock-Tests abgesichert. OAuth-Logins, Plattformkonten und Live-Uploads wurden nicht ausgeführt.

## Abgeschlossene Umsetzungsschritte

1. **Statusmodell und Preflight:** Publishing-Aufträge besitzen definierte Übergänge von der Vorprüfung bis zum Plattformstatus. YouTube verlangt eine explizite Sichtbarkeit und Entscheidung zur Kennzeichnung synthetischer Medien. TikTok Direct Post prüft aktuelle Creator-Optionen, maximale Laufzeit, Consent und erforderliche Posting-Toggles.

2. **Persistente, idempotente Aufträge:** Publishing-Jobs werden atomar in lokalen JSON-Dateien gespeichert. Ein Idempotency-Key verhindert doppelte lokale Aufträge. Nach einem Prozessabbruch während eines externen Uploads setzt die Wiederherstellung den Job auf `needs_attention`, statt den möglicherweise bereits angenommenen Upload automatisch zu wiederholen.

3. **Verschlüsselter Credential-Speicher:** OAuth-Access- und Refresh-Tokens werden mit AES-256-GCM geschützt. Der 32-Byte-Schlüssel wird ausschließlich aus der lokalen Konfiguration geladen. Verbindungslisten und Publishing-Antworten enthalten keine Tokens.

4. **OAuth-State und Provider-Clients:** OAuth-States sind zufällig, einmalig, zeitlich begrenzt und an Plattform, Redirect-URI und angeforderten Modus gebunden. Die TikTok-Antwort im `data`-Envelope wird verarbeitet. Fehlende erforderliche Scopes verhindern das Speichern einer Verbindung; ein Widerruf wird best-effort versucht.

5. **Token-Erneuerung und Kontoverwaltung:** Abgelaufene Access-Tokens werden erneuert. Parallele Refresh-Anfragen für dasselbe Konto laufen zusammen. Rotierte TikTok-Refresh-Tokens werden gespeichert. Die API kann Verbindungen auflisten und trennen.

6. **YouTube-Adapter:** Videos werden als resumable upload übertragen. `308`-Antworten und Range-Header steuern die Fortsetzung. Statusabfragen unterscheiden Uploadannahme von abgeschlossener Verarbeitung. Upload-Session-URLs werden im lokalen Job verschlüsselt abgelegt und nicht über die API ausgegeben. Grundlage sind YouTubes [resumable-upload-Protokoll][1] und [videos.insert-Referenz][2].

7. **TikTok-Adapter:** Der Adapter unterstützt sequenzielle Chunk-Uploads für den Inbox-Flow, Statusabfragen und einen separaten Direct-Post-Pfad. Inbox-Upload und Direct Post bleiben bis zu ihrer jeweiligen expliziten App-Freigabe gesperrt. Direct Post erfordert Creator-Informationen und muss aktuelle Privacy-Optionen verwenden; die Implementierung orientiert sich an TikToks [Media-Transfer-Regeln][3], [Creator-Info-API][4] und [Direct-Post-Referenz][5].

8. **API und Bestätigung:** Die Publishing-Routen sind hinter `PUBLISHING_ENABLED` standardmäßig verborgen. Bei Aktivierung ist nur eine Loopback-Bindung erlaubt; Schreib- und Kontorouten verlangen zusätzlich einen mindestens 32 Zeichen langen lokalen Bearer-Key. Jobs werden zunächst vorgeprüft. Ein Upload startet erst nach einer ausdrücklichen serverseitigen `confirmed: true`-Bestätigung.

9. **Sicherheits- und Fehlerbehandlung:** TikTok-Modi und OAuth-Scopes sind voneinander abgegrenzt. Unbekannte Publishing-Metadaten werden nicht gespeichert. Tokenwerte und Session-URLs werden aus API-Antworten entfernt. Unklare externe Uploadzustände führen zu manueller Prüfung statt automatischem Neuversand.

10. **Tests und Dokumentation:** README, `.env.example` und diese Abschlussnotiz beschreiben Aktivierung, Endpunkte und Grenzen. Die komplette `npm test`-Suite umfasst den bestehenden End-to-End-Pipeline-Test und Mock-Tests für OAuth, App-Gates, Konfiguration, Tokenverschlüsselung, Adapter, Bestätigung, Sessionverschlüsselung und Wiederanlauf. Letzter Lauf: **34 Tests bestanden, 0 fehlgeschlagen**.

## Lokale Publishing-Routen

Kontoverbindungen lassen sich mit `POST /api/v1/connections/:platform/oauth/start` starten. Der Callback lautet `GET /api/v1/connections/:platform/oauth/callback`. `GET /api/v1/connections` listet verbundene Konten; `DELETE /api/v1/connections?connectionId=...` trennt ein Konto.

`POST /api/v1/shorts-jobs/:id/publish` erstellt einen vorgeprüften Auftrag. `GET /api/v1/publishing-jobs` und `GET /api/v1/publishing-jobs/:id` liefern Statusinformationen. Erst `POST /api/v1/publishing-jobs/:id/confirm` mit `{"confirmed":true}` startet den Upload. `POST /api/v1/publishing-jobs/:id/refresh` fragt den Plattformstatus erneut ab. Für alle diese Routen ist der lokale Publishing-Bearer-Key erforderlich.

## Vor echtem Einsatz weiterhin erforderlich

Die Engine erzeugt derzeit noch Mock-Medien und besitzt keine Creator-orientierte Oberfläche. Vor einer echten Veröffentlichung müssen lokale OAuth-Zugangsdaten und Redirect-URIs eingerichtet werden. TikTok-Funktionen erfordern die jeweilige Plattform-App-Prüfung und Freigabe (`TIKTOK_UPLOAD_APPROVED` oder `TIKTOK_DIRECT_POST_APPROVED`). Direct Post braucht außerdem eine Creator-konforme Veröffentlichungsoberfläche und bleibt standardmäßig aus; TikToks [Content-Sharing-Vorgaben][6] sind gesondert zu erfüllen. Die Token-Refresh-Implementierung folgt TikToks [OAuth-Tokenverwaltung][7].

Kein echter Login oder Upload wurde getestet. Die JSON-Datei-Queue ist ein lokaler Einzelprozess-Prototyp und kein Ersatz für Datenbank, Multi-User-Authentifizierung, Produktions-Queue, Observability oder Betriebsschutz. Änderungen wurden weder committed noch gepusht.

## Referenzen

[1]: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol "YouTube Resumable Upload Protocol"
[2]: https://developers.google.com/youtube/v3/docs/videos/insert "YouTube Data API videos.insert"
[3]: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide "TikTok Media Transfer Guide"
[4]: https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info "TikTok Query Creator Info API Reference"
[5]: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post "TikTok Direct Post API Reference"
[6]: https://developers.tiktok.com/doc/content-sharing-guidelines "TikTok Content Sharing Guidelines"
[7]: https://developers.tiktok.com/doc/oauth-user-access-token-management "TikTok Manage User Access Tokens"
