<!-- tracks: README.md sha256:dc67310727a4 -->

# 0-CODE

**Version:** v2.1.1

Ein autonomer Entwicklungszyklus für **Claude Code, Codex und OpenCode**, eingebunden in ein bestehendes Projekt. Eine einzige Zyklusanweisung kann Recherche, Umsetzung, Fehlerbehebung, Audits und Veröffentlichung umfassen.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Mit dem Agenten integrieren

Bitten Sie den Agenten in Ihrem Projekt: **„Integriere 0-CODE aus https://github.com/0-SOFT/0-CODE; befolge dessen `INTEGRATE.md`.“** Verwenden Sie die öffentlichen Quellen außerhalb des Zielprojekts, bei Bedarf mit einem gewählten Release-Tag. Dieselbe [kurze Vorlage](INTEGRATE.md) deckt Aktualisierung und Entfernung für alle drei Engines ab.

Der Agent erfasst Dokumente, Werkzeuge, MCP und Prüfkommandos, klärt echte Mehrdeutigkeiten, zeigt den Plan, installiert, führt doctor aus und erstellt einen Commit in einem eigenen Branch. Projektwerkzeuge haben Vorrang. [Manueller Einstieg](QUICKSTART.md).

## Was installiert wird

Frameworkcode, Konfiguration, Schemas, Module und integrierte Vorlagen liegen in **`.0-code/`**. Die Zyklusdokumente gehören dem Projekt und liegen in **`.0-code/docs/`**; Laufzeitdateien und Sicherungen liegen im von Git ausgeschlossenen **`.0-code/run/`**. Die normale Integration ergänzt für ausgewählte Engines die nötigen nativen Hooks, Anweisungen, kompatiblen Werkzeuge und das OpenCode-Schutzplugin; die unten beschriebene isolierte Claude-Sitzung hält ihre Integration innerhalb von `.0-code/`. Bestehender Code und Dokumente bleiben erhalten; Konflikte und veränderte eigene Dateien werden vor dem Schreiben gemeldet.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) ist die einzige Konfigurationsreferenz. Übernehmen Sie Standarddokumente, ändern Sie einzelne Rollen oder ordnen Sie alle Rollen vorhandenen Projektkonventionen zu. Der Zustand bleibt maschinenlesbar. Menschliche Dokumente verwenden die konfigurierte Sprache; Agentenanweisungen bleiben Englisch.

Modell, Denkaufwand und Anmeldung gehören dem Eigentümer. Die Priorität lautet **explizite Optionen > Umgebung > Projektkonfiguration > native Engine-Einstellungen**. Nicht festgelegtes Modell und Denkaufwand werden übernommen; Authentifizierung wird nie kopiert. Siehe [Engine-Einstellungen](docs/ENGINE_SETTINGS.md).

Der [öffentliche Katalog](toolset/CATALOG.md) enthält **fünf Standard-MCP: context7, playwright, chrome-devtools, sequential-thinking und memory**. Benötigt werden npm-Pakete ab der getesteten SemVer-Mindestversion mit korrektem Namen und Einstiegspunkt; gültige neuere Versionen bleiben erhalten. Externe API-Schlüssel sind nicht nötig; Browserwerkzeuge benötigen zusätzlich einen verfügbaren Browser. Registrierung und erfolgreicher doctor beweisen keine aktive Verbindung. Private Implementierungsdateien für Skills, Agenten, Kommandos und Regeln sind ausgeschlossen. Optionale Beispiele für Kontodienste im MCP-Manifest bleiben bis zur ausdrücklichen Konfiguration und Autorisierung aus.

Standard ist **eine unabhängige Werkzeuginstallation pro Benutzer**, gemeinsam für seine Projekte. Dieselbe Auswahl erneut zu installieren ändert nichts. Der Bereich project bindet eine andere Auswahl an ein Projekt. Isolierte Claude-Aktionen install/upgrade/migrate installieren Benutzerwerkzeuge nicht automatisch; dafür ist ein separat und ausdrücklich angefordertes `install-tools` nötig. Projektentfernung behält Maschinenwerkzeuge; `uninstall-tools` entfernt sie getrennt und stellt ihre ursprünglichen Einstellungen wieder her. Authentifizierung wird nie kopiert. [Konfiguration und Voraussetzungen](docs/PROJECT_SETTINGS.md).

## Dokumente, Migration und Sitzungsisolation in 2.1.1

Neue Installationen legen alle neun Dokumentrollen unter `.0-code/docs/` ab: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` und `userdocs/`. Dauerhafte Dokumente gehören in Git; Sitzungsprotokolle werden ignoriert. Protokolle dürfen auch `.0-code/run/logs/` nutzen, dauerhafte Rollen keinen Laufzeitpfad. Explizite externe Rollen bleiben unterstützt; normales upgrade behält bestehende Pfade. Dokumente stehen außerhalb des Eigentumsbelegs: doctor akzeptiert sie, upgrade erhält sie, uninstall behält sie samt Verzeichnissen und entfernt Laufzeitdaten und Sicherungen.

Standardrollen aus `docs/*` in 2.0.x werden ausdrücklich mit `upgrade --relocate-documents <files.json>` oder `migrate --relocate-documents <files.json>` verschoben, zuerst mit `--dry-run`. Prüfen Sie die genaue Dateiliste; nicht aufgeführte Produktdokumentation bleibt. Konfiguration, STATE-Verweise und ausgewählte Vorlagen werden angepasst, geänderte Originalbytes archiviert. Individuelle externe Pfade bleiben. Vor Verschiebung oder Übernahme den Zyklus abschließen, Hintergrundarbeiten einsammeln und den Treiber stoppen; aktive Sperren oder geänderte Eingaben führen zur Ablehnung. Änderungen gemeinsam in Git vormerken, damit Umbenennungen erkennbar bleiben.

Eine angepasste `.0-code/`-Installation ohne Beleg wird über `migrate --adopt-manifest <manifest.json>` mit geprüften SHA-256-Werten und `replace`/`preserve` übernommen. Nur genau aufgeführte Projekterweiterungen in `bin/`, `claude/` und `.0-code/README.md` können erhalten bleiben; Frameworkcode wird ersetzt und archiviert. Erweiterungen bleiben bearbeitbar und überstehen upgrade/uninstall. Unbekannte Dateien oder abweichende Hashes führen zur Ablehnung; Übernahme und Verschiebung sind getrennte Vorgänge. Eigene AGENT-Regeln vorher als Dokument sichern und über `instructions.project_rules` referenzieren.

Eine isolierte Claude-Sitzung erfordert sowohl `instructions.claude: session-hook` als auch `instructions.claude_settings: .0-code/claude/settings.json`. Bei ausschließlich Claude und internen Dokumentrollen führen install, upgrade, migrate und Übernahme keine nicht ausgewählten externen Schreib-, Lösch- oder Wiederherstellungsänderungen durch, auch nicht in `.claude/`, `.mcp.json` oder `CLAUDE.md`. Explizite externe Dokumentrollen, andere ausgewählte Engines und ein separat angefordertes `install-tools` erlauben nur ihre jeweiligen Ausnahmen. Alte Eigentumsbelege oder Transaktionsjournale autorisieren keine externe Bereinigung; ein solcher Moduswechsel wird vor dem Schreiben abgelehnt und erfordert eine geprüfte Bereinigung im bisherigen Modus. Die normale Integration mit `project-file` und `session-hook` mit `.claude/settings.json` behält ihre native Bereitstellung.

Starten Sie mit `claude --settings .0-code/claude/settings.json` oder einem geprüften Launcher, der diese Datei übergibt. SessionStart und SubagentStart stellen über `.0-code/AGENT.md` die internen Quellen des Orchestrators und aktivierter Prüfverfahren bereit; native Slash-Befehle werden nicht registriert. Bei `modules.audits: false` fehlen Prüfquellen und Verweise. Sichere Textwerkzeuge können per Verweis bereitstehen; nicht so darstellbare native Ausführungssteuerung und neue MCP-Registrierungen erhalten `unsupported`. Beibehaltene Launcher-, MCP-, system-prompt-Dateien und Einstellungsrichtlinien bleiben erhalten; kompatible Einstellungen erhalten Frameworkeinträge, uninstall stellt Originalwerte wieder her. Normale Sitzungen laden die Datei nicht automatisch. Doctor prüft lokale Hooks, keine Benutzer-, verwalteten oder CLI-Überschreibungen. [Formate, Befehle und Grenzen](docs/PROJECT_SETTINGS.md).

Geprüfte Plattformen, Node-Versionen, Dateisystemgrenzen und Abdeckungsschwellen stehen im [Prüfumfang](docs/PROJECT_SETTINGS.md#validation-scope). Eine konfigurierte CI-Matrix belegt keine Ausführung.

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
