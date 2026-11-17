# Autopilot-Regeln für autonome Projektentwicklung

Der Autopilot arbeitet ausschließlich im Repository `/home/ubuntu/Faceless-Shorts-Engine` und in dem vorhandenen Sandbox-Arbeitsverzeichnis. Er führt pro Aktivierung höchstens einen Sprint aus. Die Aktivierung erfolgt wöchentlich durch die zugehörige Manus-Aufgabe; das ist kein ständig laufender Prozess.

## Entwicklungsablauf

Zu Beginn jeder Aktivierung liest der Autopilot diese Richtlinie und `AUTOPILOT_BACKLOG.md`, prüft `git status` und bearbeitet den ersten Sprint mit Status `pending`. Er prüft die vorhandenen Änderungen und erhält sie. Er überschreibt, löscht, stash’t oder setzt niemals fremde Änderungen zurück. Bei unklarer Herkunft oder einem Konflikt stoppt er, dokumentiert das Hindernis und setzt nicht mit einem anderen Sprint fort.

Er implementiert nur das Ziel des ausgewählten Sprints. Er darf Projektdateien, Tests und die projektbezogene Dokumentation ändern. Änderungen an dieser Richtlinie, den Automationsrechten oder den Veröffentlichungsfreigaben gelten nicht als normales Sprintziel und erfordern eine neue ausdrückliche Nutzerfreigabe. Er führt anschließend `npm test` und `git diff --check` aus. Nur bei erfolgreichem Ergebnis markiert er den Sprint als `completed`, dokumentiert Dateien, Testresultat und verbleibende Risiken und fährt bei einer späteren Aktivierung mit dem nächsten `pending`-Sprint fort.

## Harte Grenzen

Der Autopilot darf keine Commits erstellen, nichts pushen und keine Deployments ausführen. Er darf keine OAuth-Anmeldung durchführen, keine YouTube- oder TikTok-API mit echten Konten ansprechen und keine Inhalte veröffentlichen. `PUBLISHING_ENABLED`, `TIKTOK_UPLOAD_APPROVED` und `TIKTOK_DIRECT_POST_APPROVED` bleiben unverändert. Er liest oder schreibt keine Secrets und `.env`-Dateien, löscht keine Daten, installiert keine neuen Laufzeitabhängigkeiten und ändert keine Konten oder externen Dienste.

Falls Tests fehlschlagen, stellt er die betroffenen eigenen Änderungen nicht blind zurück. Er hält an, protokolliert den Fehler und den exakten Dateiumfang und wartet auf eine nächste Aktivierung oder Nutzerentscheidung. Er gibt keine Secrets, Tokenwerte oder privaten Inhalte in Logs oder Ausgaben aus.

## Abschluss

Nach Abschluss aller zehn Einträge dokumentiert der Autopilot den Abschluss und deaktiviert die zugehörige Wiederholung. Er erzeugt keine zusätzlichen Sprints ohne neue Nutzerfreigabe. Der bestehende Arbeitsbaum bleibt uncommitted; Änderungen bleiben lokal und überprüfbar.
