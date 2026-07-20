# CLAUDE.md

Anleitung für Claude Code in diesem Repository. Für Endnutzer-Doku (Funktionen, Bedienung, Datenhaltung) siehe [README.md](README.md) — hier geht es um Architektur, Konventionen und Fallstricke für Änderungen am Code.

## Projekt

Schachtprotokoll: statische Progressive-Web-App zur digitalen Erfassung von Schachtprotokollen im Abwasserbereich (Deckel-, Schacht-, Leitungs- und Zustandsdaten, LV95-Koordinaten, Skizzen, Fotos). Läuft vollständig im Browser, Speicherung lokal in IndexedDB, Export als JSON/ZIP/PDF.

## Tech-Stack — kein Build-Schritt

HTML, CSS, Vanilla JavaScript, IndexedDB, Service Worker Cache API, Web App Manifest, Canvas API, File/Blob API.

**Harte Regel: keinen Bundler, kein npm, kein Build-System einführen.** Das Projekt läuft absichtlich ohne Installations-/Build-Schritt (`index.html` direkt öffnen bzw. über `python -m http.server` bedienen). Änderungen erfolgen direkt in den statischen Dateien.

## Dateikarte

| Datei | Verantwortung |
|---|---|
| `index.html` | UI/Formularstruktur (674 Zeilen), sauber in kommentierte Abschnitte gegliedert: Allgemein, Deckel, Schacht, Leitungen, Zustand, Skizze/Fotos, Schächte-Liste (Sidebar), Dialoge. Keine inline `onclick`-Handler. |
| `schacht.css` | Layout, Design, Drucklayout (2620 Zeilen). `:root`-Custom-Properties für Farben/Radien/Schatten. Enthält 43× `!important` (vorwiegend Print-Overrides, nicht auditiert). |
| `script.js` | Gesamte App-Logik (3259 Zeilen) — siehe Architektur unten. |
| `serviceworker.js` | Offline-Cache. Hartcodierte Asset-Liste, siehe Stolperfalle unten. |
| `manifest.json` | PWA-Manifest. |
| `assets/js/app-config.js` | `window.AppConfig`: App-Version, Schema-Version, Foto-/Import-/Storage-Limits. |
| `assets/vendor/zip-writer.js` | Vendorierter ZIP-Writer (`window.SchachtZip`) für ZIP-Exporte. |
| `assets/fonts/`, `assets/icons/`, `assets/logo.png` | Statische Assets. |
| `tests/`, `.agents/` | Aktuell leer — kein Test-Runner, kein `package.json` im Repo. |

## script.js-Architektur

Sechs IIFE-Module in einem gemeinsamen globalen Scope (kein ES-Modul-System, keine echte Kapselung):

- `DB` (~Z.48) — IndexedDB-Wrapper (`schachtDB`, Object Store `schächte`)
- `App` (~Z.196) — zentrales Objekt mit `App.state` (currentSchachtId, dirty, autoSaveTimer, recordToken, leitungsnummer, storageAvailable, storageStatus, storagePersistent) — de-facto globaler Anwendungszustand, wird aus vielen Funktionen direkt gelesen/geschrieben
- `Sketch` (~Z.398) — Canvas-Zeichenfläche
- `Schacht` (~Z.1209) — Kern-CRUD für Schacht-Datensätze, Feldlisten (`FELDER`, `KOPFDATEN`, `DIALOG_FELDER`)
- `ErfassungsumfangUI` (~Z.1587) — Toggle-UI für wählbaren Erfassungsumfang
- `UIFeedback` (~Z.1601) — kleine DOM-Sync-Hilfe

Ab ca. Z.1640 bis Z.3259 folgen ~90 freistehende Funktionen ohne Modul-Wrapper: Export (JSON/ZIP/PDF), Import, Fotoerfassung/-komprimierung, Geolocation, Schächte-Sidebar (Liste/Suche/Filter/Auswahl), Autosave, zentrale Event-Delegation.

**Event-Pattern:** keine inline Handler — zentrale Delegation über `data-action`-Attribute, ausgewertet in `aktionAusfuehren()` (script.js:2702), registriert via `zentraleEventListenerInitialisieren()`. Dialoge einheitlich über `dialogOeffnen()`/`dialogSchliessen()` (script.js:1681/1695).

## Datenmodell & Storage

- IndexedDB: Datenbank `schachtDB`, Object Store `schächte`. Datensatz-Status (`draft`/`saved`) über `RECORD_STATUS`/`recordStatusNormalisieren()`/`recordIstEntwurf()` (script.js:~10-31).
- Limits (Foto-Grössen, Import-Grenzen, Speicher-Schwellwerte) zentral in `assets/js/app-config.js` — neue Limits dort ergänzen, nicht als verstreute Magic Numbers in `script.js`.
- Export-Formate: vollständiges JSON, Rohdaten-ZIP (ein Ordner je Schacht inkl. Originalbildern + `manifest.json`), Sammel-/Einzel-PDF über Browser-Druck. Import: JSON.

## Kritische Stolperfallen

1. **Versionsnummer an drei Stellen synchron halten:** `assets/js/app-config.js` (`version`), Fallback in `script.js`, und `CACHE_NAME`/`?v=`-Query-Strings in `serviceworker.js`. Aktuell: `2.8.9` in `app-config.js`/`serviceworker.js` — README nennt noch `2.8.1` (Doku-Drift, beim nächsten Versionswechsel mit korrigieren).
2. **Service-Worker-Cache-Liste ist manuell gepflegt** (`CORE_ASSETS`/`OPTIONAL_ASSETS` in `serviceworker.js`). Bei jeder Änderung an gecachten Dateien: `CACHE_NAME` erhöhen, sonst laden installierte PWA-Instanzen alte Versionen aus dem Cache.
3. **`assets/vendor/sqlite-wasm/`** ist ein leerer, nicht von git getrackter Verzeichnisbaum ohne jede Code-Referenz — nicht als aktive Abhängigkeit missverstehen, ist reine Altlast.

## Konventionen

- Bezeichner sind überwiegend deutsche Domänenbegriffe (`recordStatusNormalisieren`, `schachtListeAktualisieren`), vereinzelt englische Utility-Namen (`downloadFile`, `downloadBlob`) — historisch gewachsen, kein pauschaler Umbenennungsbedarf.
- Toast-Feedback-Typ ist uneinheitlich: überwiegend `'fehler'`, an einigen Stellen `'error'` (CSS aliast beides in `schacht.css`) — bei neuem Code `'fehler'` verwenden.
- Bevorzugt kleine, einzeln überprüfbare Commits statt grosser Rewrites — insbesondere bei Aufräum-/Vereinfachungsarbeiten.

## Bekanntes Aufräum-Backlog

Nicht dringend, aber als nächste Schritte vorgemerkt (siehe Plan-Historie für Details):
- Mojibake-String `Ã¼bersprungen` statt `übersprungen` (script.js, `mediumAlsZipBytesOderNull`)
- Duplizierte Guard-Präambel in `exportAlleJSON`/`exportRohdaten`
- Magic Numbers (Timeouts, Foto-/Zeichen-Schwellwerte) als benannte Konstanten, wo sinnvoll in `app-config.js`
- Häufige `document.getElementById`-Aufrufe in heissen Pfaden (Autosave, Toast) bündeln
- `App.state`-Schreibzugriffe hinter klare Accessor-Funktionen legen
- `!important`-Nutzung in `schacht.css` auditieren
- Längste Funktionen (`schachtListenZeileErstellen`, `zentraleEventListenerInitialisieren`, `importRecordNormalisieren`) in kleinere Teile zerlegen

Entscheidung: script.js bleibt eine Datei (keine ES-Module-Aufteilung), keine automatisierten Tests werden ergänzt.

## Lokal ausführen & verifizieren

```powershell
python -m http.server 8000
```
Danach `http://localhost:8000/` öffnen. Für Service-Worker-/PWA-Verhalten ist `localhost` oder HTTPS nötig.

Kein Test-Runner vorhanden — Verifikation manuell im Browser: neuen Schacht anlegen, alle Formularabschnitte befüllen, Autosave abwarten, aus Schächte-Liste laden/bearbeiten, Export (JSON/Rohdaten-ZIP/Sammel-PDF/Einzel-PDF), Skizze zeichnen, Foto aufnehmen, nach Service-Worker-Änderungen Offline-Reload prüfen.
