<!-- tracks: README.md sha256:3861ef6052d0 -->

# 0-CODE

**Version:** v2.0.3

Ein autonomer Entwicklungszyklus für **Claude Code, Codex und OpenCode**, eingebunden in ein bestehendes Projekt. Eine einzige Zyklusanweisung kann Recherche, Umsetzung, Fehlerbehebung, Audits und Veröffentlichung umfassen.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Mit dem Agenten integrieren

Bitten Sie den Agenten in Ihrem Projekt: **„Integriere 0-CODE aus https://github.com/0-SOFT/0-CODE; befolge dessen `INTEGRATE.md`.“** Verwenden Sie die öffentlichen Quellen außerhalb des Zielprojekts, bei Bedarf mit einem gewählten Release-Tag. Dieselbe [kurze Vorlage](INTEGRATE.md) deckt Aktualisierung und Entfernung für alle drei Engines ab.

Der Agent erfasst Dokumente, Werkzeuge, MCP und Prüfkommandos, klärt echte Mehrdeutigkeiten, zeigt den Plan, installiert, führt doctor aus und erstellt einen Commit in einem eigenen Branch. Projektwerkzeuge haben Vorrang. [Manueller Einstieg](QUICKSTART.md).

## Was installiert wird

Frameworkcode, Konfiguration, Schemas, Module und Vorlagen liegen in **`.0-code/`**. Die Engines erhalten nur erforderliche native Hooks, Anweisungen, kompatible Werkzeuge und das OpenCode-Schutzplugin. Bestehender Code und Dokumente bleiben erhalten; Konflikte und veränderte eigene Dateien werden vor dem Schreiben erkannt. Laufzeitdateien und Sicherungen liegen im von git ausgeschlossenen `.0-code/run/`.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) ist die einzige Konfigurationsreferenz. Übernehmen Sie Standarddokumente, ändern Sie einzelne Rollen oder ordnen Sie alle Rollen vorhandenen Projektkonventionen zu. Der Zustand bleibt maschinenlesbar. Menschliche Dokumente verwenden die konfigurierte Sprache; Agentenanweisungen bleiben Englisch.

Modell, Denkaufwand und Anmeldung gehören dem Eigentümer. Die Priorität lautet **explizite Optionen > Umgebung > Projektkonfiguration > native Engine-Einstellungen**. Nicht festgelegtes Modell und Denkaufwand werden übernommen; Authentifizierung wird nie kopiert. Siehe [Engine-Einstellungen](docs/ENGINE_SETTINGS.md).

Der [öffentliche Katalog](toolset/CATALOG.md) enthält **fünf Standard-MCP: context7, playwright, chrome-devtools, sequential-thinking und memory**. Benötigt werden npm-Pakete ab der getesteten SemVer-Mindestversion mit korrektem Namen und Einstiegspunkt; gültige neuere Versionen bleiben erhalten. Externe API-Schlüssel sind nicht nötig; Browserwerkzeuge benötigen zusätzlich einen verfügbaren Browser. Registrierung und erfolgreicher doctor beweisen keine aktive Verbindung. Private Implementierungsdateien für Skills, Agenten, Kommandos und Regeln sind ausgeschlossen. Optionale Beispiele für Kontodienste im MCP-Manifest bleiben bis zur ausdrücklichen Konfiguration und Autorisierung aus.

Standard ist **eine unabhängige Installation pro Benutzer**, gemeinsam für seine Projekte. Dieselbe Auswahl erneut zu installieren ändert nichts. Der Bereich project bindet eine andere Auswahl an ein Projekt. Projektentfernung behält Maschinenwerkzeuge; `uninstall-tools` entfernt sie getrennt und stellt ihre ursprünglichen Einstellungen wieder her. Authentifizierung wird nie kopiert. [Konfiguration und Voraussetzungen](docs/PROJECT_SETTINGS.md).

## Arbeiten und pflegen

Im installierten Projekt:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

Füllen Sie die einzige Vorlage `.0-code/templates/cycle.md` aus. `start` setzt den Zustand atomar und zeigt den Treiberbefehl. Starten Sie Claude neu, damit Hooks geladen werden; Codex und OpenCode verwenden den externen Supervisor. Ein Ordner hat einen aktiven Zyklus. Iterations- und Ausgabenlimits sind optional; ein Geldlimit braucht Kostendaten des Supervisors. Registrieren Sie lange Arbeiten im Zustand statt in sleep-Schleifen zu warten.

Die öffentlichen Quellen unterstützen neue Installationen und Aktualisierungen der Struktur `.0-code/`. **Die automatische Migration alter 1.x-Installationen im Projektstamm ist ohne `config/legacy-installations.json` nicht verfügbar; diese Datei ist vom öffentlichen Baum ausgeschlossen.** Verwenden Sie `migrate --dry-run`, dann `migrate`, nur mit Quellen, die Eigentumsnachweise aus veröffentlichten Versionen enthalten. Nur bytegenau nachgewiesene Frameworkdateien und exakte eigene Blöcke werden entfernt; Dokumente bleiben, Laufzeitdaten werden mit Sicherungen verschoben oder archiviert. Beenden Sie zuerst einen aktiven alten Zyklus; ohne Nachweise behalten Sie alte Dateien und prüfen deren Eigentümerschaft vor Änderungen.

[Engine-Einstellungen](docs/ENGINE_SETTINGS.md), [Claude](CLAUDE_CODE_SETUP.md), [Entwicklung](GUIDELINE.md) und [Sicherheit](SECURITY.md) erläutern Betrieb und Prüfung. In den Quellen: `node tests/run.mjs --coverage-min=80` und `bash tests/smoke.sh`; lokale Ergebnisse sind Nachweise, unabhängig von der CI-Verfügbarkeit.
