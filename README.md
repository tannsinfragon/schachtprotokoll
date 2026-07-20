# Schachtprotokoll

Web-App zur digitalen Erfassung von Schachtprotokollen im Abwasserbereich.

Die Anwendung läuft vollständig im Browser, speichert erfasste Schächte lokal in IndexedDB und unterstützt Export, Import, PDF-Druck, Fotos, Skizzen und Offline-Nutzung als Progressive Web App.

## Zweck

Das Repository enthält eine statische Browser-Anwendung für die Aufnahme und Dokumentation von Schächten. Sie ist für den Einsatz auf Desktop, Tablet und Smartphone ausgelegt.

Erfasst werden:

- allgemeine Schachtdaten
- Deckelangaben
- Schachtangaben
- Leitungen
- Zustandsangaben
- Koordinaten in LV95
- Skizzen
- Fotos

## Funktionen

- Schachtprotokoll mit strukturierten Formularbereichen
- wählbarer Erfassungsumfang für Deckel, Schacht, Leitungen und Zustand
- lokale Speicherung mehrerer Schächte im Browser
- Schachtliste mit Laden und Löschen gespeicherter Datensätze
- Skizzenfläche mit Stiftfarben, Radierer, Rückgängig und Gittermodus
- Fotoerfassung mit automatischer Komprimierung
- Export als vollständiges JSON, Rohdaten-ZIP mit Originalbildern, Bilder-ZIP und PDF
- Import von JSON
- Einzel-PDF für den aktuellen Schacht
- Sammel-PDF für alle gespeicherten Schächte
- Offline-Unterstützung über Service Worker und Cache
- PWA-Manifest für Installation auf unterstützten Geräten
- Link zu `map.geo.admin.ch` anhand der erfassten LV95-Koordinaten

## Technik

Die App benötigt kein Build-System und keine Server-Komponenten.

Verwendet werden:

- HTML
- CSS
- JavaScript
- IndexedDB
- Service Worker Cache API
- Web App Manifest
- Canvas API für Skizzen
- File API und Blob API für Fotos und Exporte

## Projektstruktur

```text
.
|-- index.html                 # Benutzeroberfläche
|-- schacht.css                # Layout, Design und Druckansicht
|-- script.js                  # App-Logik, Speicherung, Export, Import, Skizzen, Fotos
|-- serviceworker.js           # Offline-Cache
|-- manifest.json              # PWA-Konfiguration
|-- assets/
|   |-- js/
|   |   |-- app-config.js      # Version, Schema, Foto- und Speicheroptionen
|   |-- vendor/
|   |   `-- zip-writer.js      # ZIP-Erzeugung für Bild- und Rohdatenexporte
|   |-- icons/                 # PWA-Icons
|   |-- fonts/                 # Figtree-Schriften
|   `-- logo.png               # Logo
`-- README.md
```

## Lokal starten

Direktes Öffnen von `index.html` ist für einfache Tests möglich. Für Service Worker und PWA-Verhalten muss die App über `localhost` oder HTTPS laufen.

Mit Python:

```powershell
cd "C:\Users\TANNS\OneDrive - BKW\Schachtprotokoll"
python -m http.server 8000
```

Danach öffnen:

```text
http://localhost:8000/
```

## Bedienung

1. App im Browser öffnen.
2. Schachtdaten im Formular erfassen.
3. Bei Bedarf Leitungen über `+ LEITUNG` hinzufügen.
4. Zustand, Skizze und Fotos ergänzen.
5. Automatische lokale Speicherung abwarten.
6. Gespeicherte Schächte über `SCHÄCHTE` öffnen.
7. Daten als JSON, Bilder-ZIP oder PDF exportieren.

## Datenhaltung

Die Datensätze werden lokal im Browser gespeichert:

- Datenbank: `schachtDB`
- Object Store: `schächte`
- Speicherort: IndexedDB des jeweiligen Browsers und Profils

Die Daten liegen nicht automatisch in GitHub, auf einem Server oder in einer Cloud. Für Datensicherung und Weitergabe müssen Exporte verwendet werden.

Die Daten liegen unverschlüsselt im Browserprofil. Die App fordert nach Möglichkeit persistenten Browser-Speicher an und erinnert alle 30 Tage an ein vollständiges JSON-Backup. Browserbereinigung, Profilwechsel und ein defektes Gerät können lokale Daten trotzdem entfernen.

## Export und Import

Unterstützte Exportformate:

- JSON für vollständige strukturierte Backups
- Rohdaten-ZIP mit einem Ordner je Schacht, vollständigem JSON und Originalbildern
- Bilder-ZIP für Fotos und genutzte Skizzen
- PDF separat über die Browser-Druckfunktion im aktuellen Drucklayout

Unterstützte Importformate:

- JSON

JSON-Importe sind auf 150 MB, 500 Datensätze, 20 Fotos pro Datensatz und die in `assets/js/app-config.js` definierten Feld- und Mediengrössen begrenzt. Konflikte mit bestehenden Schächten werden vor dem atomaren Import als Aktualisierung oder Kopie behandelt.

## Offline-Nutzung

Der Service Worker speichert die App-Shell und statische Assets im Browser-Cache. Nach dem ersten erfolgreichen Laden über `localhost` oder HTTPS kann die App auch offline geöffnet werden, sofern der Browser den Cache nicht gelöscht hat.

## Entwicklung

Es gibt keinen Installations- oder Build-Schritt.

Änderungen werden direkt in den statischen Dateien vorgenommen:

- Oberfläche: `index.html`
- Styling und Drucklayout: `schacht.css`
- Verhalten und Datenmodell: `script.js`
- PWA-Version und Icons: `manifest.json`
- Offline-Cache-Liste: `serviceworker.js`

Nach Änderungen an gecachten Dateien muss der Cache-Name in `serviceworker.js` erhöht werden, damit installierte PWA-Versionen die neuen Dateien laden.

## Version

Aktuelle App-Version:

```text
2.8.10
```

Die Version ist in `assets/js/app-config.js`, als Fallback in `script.js` und im Cache-Namen von `serviceworker.js` referenziert.

## Quellen im Repository

- `index.html`: Formularstruktur, Navigation, Import-/Export-Bedienung
- `script.js`: IndexedDB, Auto-Speicherung, Export, Import, PDF-Druck, Fotos, Skizzen
- `serviceworker.js`: Offline-Cache und Service-Worker-Verhalten
- `manifest.json`: PWA-Name, Icons, Theme, Start-URL
- `assets/js/app-config.js`: Version, Schema-Version, Foto- und Speichergrenzen
