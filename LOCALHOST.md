# Lokale Website im Netzwerk starten

Diese Anleitung startet die statische Website aus diesem Projektordner über einen lokalen HTTP-Server. Andere Geräte im gleichen Netzwerk öffnen die Website über die IPv4-Adresse dieses Rechners.

## 1. Projektordner öffnen

PowerShell öffnen und in den Projektordner wechseln:

```powershell
cd "C:\Users\TANNS\OneDrive - BKW\Schachtprotokoll"
```

## 2. Server starten

Server auf allen Netzwerkadressen starten:

```powershell
python -m http.server 8000 --bind 0.0.0.0 --directory .
```

Der Server bleibt aktiv, solange dieses PowerShell-Fenster offen ist.

## 3. Auf diesem Rechner öffnen

Im Browser auf diesem Rechner:

```text
http://127.0.0.1:8000/
```

oder:

```text
http://localhost:8000/
```

## 4. Von anderen Clients öffnen

IPv4-Adresse dieses Rechners anzeigen:

```powershell
ipconfig
```

Bei der letzten Prüfung war die aktive Adresse:

```text
192.168.2.115
```

Andere Geräte im gleichen Netzwerk öffnen:

```text
http://192.168.2.115:8000/
```

Wenn sich das Netzwerk ändert, kann sich diese Adresse ändern. Dann erneut `ipconfig` ausführen und die aktuelle IPv4-Adresse verwenden.

## 5. Firewall prüfen

Falls andere Geräte die Seite nicht erreichen:

1. Windows-Firewall-Meldung für `python.exe` erlauben.
2. Zugriff für private Netzwerke aktivieren.
3. Prüfen, ob Client und Rechner im gleichen Netzwerk sind.
4. Prüfen, ob VPN oder Unternehmensrichtlinien lokale Zugriffe blockieren.

## 6. Server stoppen

Im PowerShell-Fenster mit laufendem Server:

```text
Ctrl + C
```

Falls der Server im Hintergrund läuft, Python-Prozess suchen:

```powershell
Get-Process python -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
```

Dann gezielt stoppen:

```powershell
Stop-Process -Id <PID>
```

`<PID>` durch die angezeigte Prozess-ID ersetzen.

## 7. Anderen Port verwenden

Wenn Port `8000` belegt ist:

```powershell
python -m http.server 8001 --bind 0.0.0.0 --directory .
```

Lokale URL:

```text
http://127.0.0.1:8001/
```

Client-URL:

```text
http://192.168.2.115:8001/
```

## 8. Änderungen nicht sichtbar

Diese Website enthält einen Service Worker. Browser können Dateien zwischenspeichern.

Bei alten Inhalten:

1. Browser hart neu laden.
2. Browser-Cache löschen.
3. In den Entwicklertools den Service Worker aktualisieren oder unregister ausführen.
4. Seite neu öffnen.

## Grundlage

- Projekt ist eine statische Website mit `index.html`, `script.js`, `schacht.css`, `manifest.json` und `serviceworker.js`.
- Python ist lokal als `C:\Python312\python.exe` verfügbar.
- Aktive IPv4-Adresse aus `ipconfig` am 2026-06-22: `192.168.2.115`.
