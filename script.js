'use strict';

const APP_VERSION = window.AppConfig?.version || '2.8.1';
const EXPORT_SCHEMA_VERSION = window.AppConfig?.schemaVersion || 3;
const APP_FIRMA = window.AppConfig?.company || '';
const FOTO_MAX_KANTE = window.AppConfig?.photo?.maxEdge || 1600;
const FOTO_JPEG_QUALITAET = window.AppConfig?.photo?.jpegQuality || 0.82;
const FOTO_MAX_ANZAHL = window.AppConfig?.photo?.maxFilesPerRecord || 20;
const FOTO_MAX_DATEIGROESSE = window.AppConfig?.photo?.maxInputBytes || 25 * 1024 * 1024;
const FOTO_MAX_PIXEL = window.AppConfig?.photo?.maxPixels || 40 * 1000 * 1000;
const QUOTA_WARN_RATIO = window.AppConfig?.storage?.quotaWarnRatio || 0.85;
const IMPORT_MAX_DATEIGROESSE = window.AppConfig?.import?.maxFileBytes || 150 * 1024 * 1024;
const IMPORT_GROSS_WARNUNG = window.AppConfig?.import?.largeFileWarningBytes || 75 * 1024 * 1024;
const IMPORT_MAX_DATENSAETZE = window.AppConfig?.import?.maxRecords || 500;
const IMPORT_MAX_TEXT = window.AppConfig?.import?.maxTextChars || 5000;
const IMPORT_MAX_FOTOS = window.AppConfig?.import?.maxPhotosPerRecord || 20;
const IMPORT_MAX_DATA_URL = window.AppConfig?.import?.maxDataUrlChars || 15 * 1024 * 1024;
const IMPORT_MAX_LEITUNGEN = window.AppConfig?.import?.maxLeitungenPerRecord || 100;
const IMPORT_MAX_STRICHE = window.AppConfig?.import?.maxStrokesPerRecord || 1000;
const BACKUP_ERINNERUNG_TAGE = window.AppConfig?.storage?.backupReminderDays || 30;
const EXPORT_MAX_MEDIEN_BYTES = window.AppConfig?.storage?.maxExportMediaBytes || 250 * 1024 * 1024;
const PRINT_BILD_TIMEOUT_MS = window.AppConfig?.print?.bildWartenTimeoutMs || 20000;
const PRINT_BILD_TIMEOUT_MS_SAMMEL = window.AppConfig?.print?.bildWartenTimeoutMsSammel || 30000;
const PRINT_CLEANUP_TIMEOUT_MS = window.AppConfig?.print?.cleanupTimeoutMs || 60000;
const PRINT_FOTO_WARNSCHWELLE = window.AppConfig?.print?.fotoWarnschwelle || 100;
const EXPORT_DATEINAME_MAX_ZEICHEN = window.AppConfig?.export?.dateinameMaxZeichen || 80;
const RECORD_STATUS = Object.freeze({
    DRAFT: 'draft',
    SAVED: 'saved'
});

function recordStatusNormalisieren(record, fallback = RECORD_STATUS.SAVED) {
    const status = record?.status;
    if (status === RECORD_STATUS.DRAFT || status === RECORD_STATUS.SAVED) return status;
    if (record?._leerentwurf === true) return RECORD_STATUS.DRAFT;
    return fallback;
}

function recordIstEntwurf(record) {
    return recordStatusNormalisieren(record) === RECORD_STATUS.DRAFT;
}

function recordStatusSetzen(record, status = RECORD_STATUS.SAVED) {
    const daten = record || {};
    daten.status = status === RECORD_STATUS.DRAFT ? RECORD_STATUS.DRAFT : RECORD_STATUS.SAVED;
    delete daten._leerentwurf;
    return daten;
}

// ============================================================
// DB – IndexedDB Datenbankschicht
// ============================================================
const DB = (() => {
    const DB_NAME = 'schachtDB';
    const DB_VERSION = 1;
    const STORE = 'schächte';
    let _db = null;

    function openMitVersion(version = DB_VERSION) {
        return new Promise((resolve, reject) => {
            const req = version === null ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = e => {
                _db = e.target.result;
                if (!_db.objectStoreNames.contains(STORE)) {
                    _db.close();
                    _db = null;
                    reject(new Error(`Object Store "${STORE}" fehlt`));
                    return;
                }
                _db.onclose = () => { _db = null; };
                _db.onversionchange = () => { _db.close(); _db = null; };
                resolve(_db);
            };
            req.onerror = e => reject(e.target.error);
            req.onblocked = () => reject(new DOMException('Datenbank wird durch einen anderen Tab blockiert', 'BlockedError'));
        });
    }

    async function open() {
        if (_db) return _db;
        try {
            return await openMitVersion(DB_VERSION);
        } catch (e) {
            // Eine lokal bereits vorhandene Datenbank kann eine höhere Version
            // besitzen. In diesem Fall wird sie ohne Downgrade-Versuch geöffnet.
            if (e?.name === 'VersionError') return openMitVersion(null);
            throw e;
        }
    }

    async function speichern(schacht) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const now = new Date().toISOString();
            recordStatusSetzen(schacht, recordStatusNormalisieren(schacht));
            if (!schacht.erstellt_am) schacht.erstellt_am = now;
            schacht.geaendert_am = now;
            schacht.version = (schacht.version || 0) + 1;
            // id muss entweder eine gültige Zahl sein oder ganz fehlen (für autoIncrement)
            const isNew = !schacht.id;
            if (isNew) delete schacht.id;
            let gespeicherteId = schacht.id;
            tx.oncomplete = () => resolve(gespeicherteId);
            tx.onerror = () => reject(tx.error || new Error('Speichern fehlgeschlagen'));
            tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
            const req = isNew ? store.add(schacht) : store.put(schacht);
            req.onsuccess = e => { gespeicherteId = e.target.result; };
            req.onerror = e => reject(e.target.error);
        });
    }

    async function laden(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function alle() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function loeschen(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Löschen fehlgeschlagen'));
            tx.onabort = () => reject(tx.error || new Error('Löschen abgebrochen'));
            const req = tx.objectStore(STORE).delete(id);
            req.onerror = e => reject(e.target.error);
        });
    }

    async function alleLoeschen() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Löschen fehlgeschlagen'));
            tx.onabort = () => reject(tx.error || new Error('Löschen abgebrochen'));
            tx.objectStore(STORE).clear();
        });
    }

    async function vieleSpeichern(records) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const now = new Date().toISOString();
            tx.oncomplete = () => resolve(records.length);
            tx.onerror = () => reject(tx.error || new Error('Import fehlgeschlagen'));
            tx.onabort = () => reject(tx.error || new Error('Import abgebrochen'));
            records.forEach(record => {
                const daten = {
                    ...record,
                    erstellt_am: record._import_erstellt_am || now,
                    geaendert_am: now,
                    version: record._import_version || 1
                };
                const zielId = Number(record._import_ziel_id) || null;
                delete daten._import_ziel_id;
                delete daten._import_erstellt_am;
                delete daten._import_version;
                recordStatusSetzen(daten, recordStatusNormalisieren(daten, RECORD_STATUS.SAVED));
                if (zielId) {
                    daten.id = zielId;
                    store.put(daten);
                } else {
                    delete daten.id;
                    store.add(daten);
                }
            });
        });
    }

    return { open, speichern, laden, alle, loeschen, alleLoeschen, vieleSpeichern };
})();

// ============================================================
// App – Zentraler Zustand
// ============================================================
const _appElCache = new Map();
function appEl(id) {
    let el = _appElCache.get(id);
    if (el === undefined) {
        el = document.getElementById(id);
        _appElCache.set(id, el);
    }
    return el;
}

const App = {
    state: {
        currentSchachtId: null,
        dirty: false,
        autoSaveTimer: null,
        recordToken: 0,
        leitungsnummer: 1,
        storageAvailable: false,
        storageStatus: 'checking',
        storagePersistent: null,
    },

    _saveChain: Promise.resolve(),

    toast(msg, typ = 'info') {
        const t = appEl('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = `toast toast--${typ} toast--sichtbar`;
        clearTimeout(App._toastTimer);
        App._toastTimer = setTimeout(() => t.classList.remove('toast--sichtbar'), 3500);
    },

    setStatus(msg) {
        const el = appEl('statusbar-text');
        if (el) el.textContent = msg;
    },

    setStorageStatus(status, msg) {
        App.state.storageStatus = status;
        App.state.storageAvailable = status === 'active' || status === 'warning';
        const statusEl = appEl('speicherstatus');
        if (statusEl) {
            const kurztext = {
                checking: 'Speicherprüfung',
                active: 'Speicherung aktiv',
                warning: 'Speicher fast voll',
                blocked: 'Speicherung blockiert'
            };
            statusEl.textContent = kurztext[status] || msg;
            statusEl.className = `speicherstatus speicherstatus--${status}`;
        }
        const banner = appEl('offline-banner');
        if (banner) {
            banner.textContent = msg;
            banner.style.display = status === 'active' ? 'none' : 'block';
        }
        if (status === 'blocked') App.speicherfehlerAnzeigen(msg);
    },

    triggerAutoSave() {
        clearTimeout(App.state.autoSaveTimer);
        App.state.dirty = true;
        App.setStatus('Nicht gespeichert');
        const token = App.state.recordToken;
        App.state.autoSaveTimer = setTimeout(() => App.queueAutoSave(token), 800);
    },

    speicherfehlerAnzeigen(msg) {
        const banner = appEl('speicherfehler-banner');
        const textEl = appEl('speicherfehler-text');
        if (textEl) textEl.textContent = msg;
        if (banner) banner.hidden = false;
    },

    speicherfehlerAusblenden() {
        const banner = appEl('speicherfehler-banner');
        if (banner) banner.hidden = true;
    },

    queueAutoSave(token) {
        App._saveChain = App._saveChain
            .catch(() => {})
            .then(() => App.autoSpeichern(token));
        return App._saveChain;
    },

    async aenderungenSpeichern() {
        clearTimeout(App.state.autoSaveTimer);
        if (!App.state.dirty) return true;
        if (!App.state.storageAvailable) {
            App.setStatus('Nicht gespeichert - Speicherung blockiert');
            App.toast('Aktion abgebrochen: Änderungen sind nicht gespeichert.', 'fehler');
            App.speicherfehlerAnzeigen('Änderungen sind nicht gespeichert: Lokaler Speicher ist blockiert.');
            return false;
        }
        const token = App.state.recordToken;
        await App.queueAutoSave(token);
        return token === App.state.recordToken && !App.state.dirty;
    },

    datensatzWechseln(id = null) {
        clearTimeout(App.state.autoSaveTimer);
        App.state.recordToken++;
        App.state.currentSchachtId = id;
        App.state.dirty = false;
    },

    setCurrentSchachtId(id) {
        App.state.currentSchachtId = id;
    },

    datensatzAlsGespeichertMarkieren(id) {
        App.setCurrentSchachtId(id);
        App.state.dirty = false;
    },

    leitungsnummerZuruecksetzen() {
        App.state.leitungsnummer = 1;
    },

    leitungsnummerSicherstellen(nrZahl) {
        App.state.leitungsnummer = Math.max(App.state.leitungsnummer, nrZahl + 1);
    },

    async autoSpeichern(token = App.state.recordToken) {
        if (token !== App.state.recordToken) return false;
        if (!App.state.storageAvailable) {
            App.setStatus('Nicht gespeichert - Speicherung blockiert');
            return false;
        }
        try {
            await Sketch.ready();
            if (token !== App.state.recordToken) return;
            const schacht = recordStatusSetzen(Schacht.sammeln(), RECORD_STATUS.SAVED);
            const id = await DB.speichern(schacht);
            if (token !== App.state.recordToken) return;
            App.state.currentSchachtId = id;
            App.state.dirty = false;
            const zeit = new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
            const prueffehler = Schacht.validieren(schacht);
            Schacht.validierungsfehlerAnzeigen(prueffehler);
            const istEntwurf = prueffehler.length > 0;
            App.setStatus(`${istEntwurf ? `Entwurf gespeichert (${prueffehler.length} Prüfhinweis${prueffehler.length !== 1 ? 'e' : ''})` : 'Gespeichert'} ${zeit}`);
            App.toast(istEntwurf ? 'Entwurf lokal gespeichert' : 'Schacht gespeichert', 'success');
            App.speicherfehlerAusblenden();
            speicherplatzPruefen();
            const liste = document.getElementById('schachtListe');
            if (liste?.classList.contains('offen') || schachtSeitenleisteAktiv()) schachtListeRecordAktualisieren(id);
            return true;
        } catch (e) {
            console.error('[DB] Auto-Save Fehler:', e);
            if (e?.name === 'QuotaExceededError') {
                App.setStorageStatus('blocked', 'Speicher voll: JSON-Backup exportieren und Fotos reduzieren.');
            }
            App.toast('Speichern fehlgeschlagen: ' + e.message, 'fehler');
            App.setStatus('Nicht gespeichert - Fehler');
            App.speicherfehlerAnzeigen(`Speichern fehlgeschlagen: ${e.message}`);
            return false;
        }
    }
};

async function speicherplatzPruefen() {
    if (!navigator.storage?.estimate || !App.state.storageAvailable) return;
    try {
        const estimate = await navigator.storage.estimate();
        if (!estimate.quota || !estimate.usage) return;
        const ratio = estimate.usage / estimate.quota;
        if (ratio >= QUOTA_WARN_RATIO) {
            App.setStorageStatus('warning', 'Speicher fast voll: JSON-Backup exportieren und Fotos reduzieren.');
        } else if (App.state.storageStatus !== 'active') {
            App.setStorageStatus('active', 'Speicherung aktiv');
        }
    } catch (e) {
        console.warn('[Storage] Speicherplatz konnte nicht geprüft werden:', e);
    }
}

async function speicherInitialisieren() {
    if (!window.indexedDB) {
        App.setStorageStatus('blocked', 'Datenspeicherung nicht verfügbar. Formular nutzbar, Autosave blockiert.');
        return;
    }
    try {
        await DB.open();
        App.setStorageStatus('active', 'Speicherung aktiv');
        if (navigator.storage?.persist) {
            try {
                App.state.storagePersistent = await navigator.storage.persist();
                const statusEl = appEl('speicherstatus');
                if (statusEl) statusEl.title = App.state.storagePersistent
                    ? 'Browser-Speicher ist dauerhaft angefordert.'
                    : 'Browser kann lokale Daten bei Speicherdruck entfernen. JSON-Backups erstellen.';
                if (!App.state.storagePersistent) {
                    App.toast('Browser garantiert keine dauerhafte lokale Speicherung. JSON-Backup erstellen.', 'warn');
                }
            } catch (e) {
                console.warn('[Storage] Persistenter Speicher konnte nicht angefordert werden:', e);
            }
        }
        await speicherplatzPruefen();
        backupErinnerungPruefen();
        await leereEntwuerfeBereinigen();
        await schachtListeAktualisieren();
    } catch (e) {
        console.error('[DB] Öffnen fehlgeschlagen:', e);
        const detail = [e?.name, e?.message].filter(Boolean).join(': ');
        const grund = detail ? ` (${detail})` : '';
        App.setStorageStatus('blocked', `Datenbank blockiert${grund}. Formular nutzbar, Autosave blockiert.`);
    }
}

function backupErinnerungPruefen() {
    try {
        const eintrag = JSON.parse(localStorage.getItem('letztes_json_backup') || 'null');
        const zeit = eintrag?.typ === 'vollstaendig' ? Date.parse(eintrag.zeit) : NaN;
        const alterTage = Number.isFinite(zeit) ? (Date.now() - zeit) / 86400000 : Infinity;
        if (alterTage >= BACKUP_ERINNERUNG_TAGE) {
            setTimeout(() => App.toast(`Letztes vollständiges JSON-Backup ist älter als ${BACKUP_ERINNERUNG_TAGE} Tage oder fehlt.`, 'warn'), 1200);
        }
    } catch (e) {
        console.warn('[Backup] Erinnerung konnte nicht geprüft werden:', e);
    }
}

// ============================================================
// Sketch – Zeichenfläche
// ============================================================
const Sketch = (() => {
    const HISTORY_MAX = 20;
    const LINIE_SCHWELLE = 12;

    let ctx, canvas;
    let currentMode = false;
    let cachedRect = null;
    let backgroundImageData = null;
    let defaultDataURL = '';
    let loadedContent = false;
    let strokes = [];      // [{type, color, width, ...}] – source of truth
    let undoStack = [];    // [{type:'draw', stroke}|{type:'erase', removed:[]}]
    let strokePoints = [];
    let preStrokeImageData = null;  // Canvas-Zustand vor dem aktuellen Strich
    let ladeToken = 0;
    let ladePromise = Promise.resolve();
    let ladeAktiv = false;
    let rasterBasisAktiv = false;
    let korrekturAktiv = true;
    const pen = { farbe: 'black', zeichnen: false, stift: false, breite: 1 };

    // --- Hilfsfunktionen Strich-Rendering ---

    function drawStroke(s) {
        ctx.beginPath();
        ctx.lineWidth = s.width;
        ctx.strokeStyle = s.color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        if (s.type === 'line') {
            ctx.moveTo(s.start.x, s.start.y);
            ctx.lineTo(s.end.x, s.end.y);
        } else if (s.type === 'bezier') {
            ctx.moveTo(s.start.x, s.start.y);
            ctx.quadraticCurveTo(s.cp.x, s.cp.y, s.end.x, s.end.y);
        } else {
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        }
        ctx.stroke();
    }

    function redrawAll() {
        ctx.putImageData(backgroundImageData, 0, 0);
        strokes.forEach(drawStroke);
    }

    function zahl(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function punktSkalieren(p, sx, sy) {
        return { x: zahl(p?.x) * sx, y: zahl(p?.y) * sy };
    }

    function strokeSkalieren(s, sx, sy) {
        if (!s || typeof s !== 'object') return null;
        const width = Math.max(1, zahl(s.width, 1) * ((sx + sy) / 2));
        const basis = {
            type: s.type,
            color: typeof s.color === 'string' ? s.color : 'black',
            width
        };
        if (s.type === 'line') {
            return { ...basis, start: punktSkalieren(s.start, sx, sy), end: punktSkalieren(s.end, sx, sy) };
        }
        if (s.type === 'bezier') {
            return {
                ...basis,
                start: punktSkalieren(s.start, sx, sy),
                end: punktSkalieren(s.end, sx, sy),
                cp: punktSkalieren(s.cp, sx, sy)
            };
        }
        if (s.type === 'freehand' && Array.isArray(s.points) && s.points.length > 0) {
            return { ...basis, points: s.points.map(p => punktSkalieren(p, sx, sy)) };
        }
        return null;
    }

    function strokesNormalisieren(input) {
        return Array.isArray(input)
            ? input.map(s => strokeSkalieren(s, 1, 1)).filter(Boolean)
            : [];
    }

    function undoEintragSkalieren(entry, sx, sy) {
        if (entry?.type === 'draw') {
            const stroke = strokeSkalieren(entry.stroke, sx, sy);
            return stroke ? { type: 'draw', stroke } : null;
        }
        if (entry?.type === 'erase') {
            const removed = (entry.removed || []).map(s => strokeSkalieren(s, sx, sy)).filter(Boolean);
            return { type: 'erase', removed };
        }
        return null;
    }

    function imageDataCanvas(imageData, width, height) {
        const tmp = document.createElement('canvas');
        tmp.width = width;
        tmp.height = height;
        tmp.getContext('2d').putImageData(imageData, 0, 0);
        return tmp;
    }

    // --- Hilfsfunktionen Treffertest ---

    function ptSegDist(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    function bezierSamples(s, n) {
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const t = i / n, mt = 1 - t;
            pts.push({
                x: mt * mt * s.start.x + 2 * mt * t * s.cp.x + t * t * s.end.x,
                y: mt * mt * s.start.y + 2 * mt * t * s.cp.y + t * t * s.end.y
            });
        }
        return pts;
    }

    function hitTestStroke(s, eraserPts, r) {
        if (s.type === 'line') {
            return eraserPts.some(ep => ptSegDist(ep, s.start, s.end) < r);
        } else if (s.type === 'bezier') {
            const samples = bezierSamples(s, 20);
            return eraserPts.some(ep => samples.some(sp => Math.hypot(ep.x - sp.x, ep.y - sp.y) < r));
        } else {
            for (let i = 0; i < s.points.length - 1; i++) {
                if (eraserPts.some(ep => ptSegDist(ep, s.points[i], s.points[i + 1]) < r)) return true;
            }
            return false;
        }
    }

    // --- Canvas-Aufbau ---

    function stiftZuruecksetzen() {
        pen.zeichnen = false;
        pen.stift = false;
        strokePoints = [];
        preStrokeImageData = null;
        canvas.style.cursor = 'default';
        document.querySelectorAll('menu label[data-stift]').forEach(l => l.classList.remove('aktiv'));
    }

    function hintergrundZeichnen(gitter) {
        currentMode = gitter;
        document.getElementById('skizze')?.classList.toggle('aktiv', !gitter);
        document.getElementById('gitter')?.classList.toggle('aktiv', gitter);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'gray';
        ctx.setLineDash([3, 4]);
        if (gitter) {
            const masche = canvas.height / 10;
            for (let i = masche; i < canvas.height; i += masche) {
                ctx.beginPath();
                ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height);
                ctx.moveTo(0, i); ctx.lineTo(canvas.width, i);
                ctx.stroke();
            }
        } else {
            ctx.beginPath();
            ctx.fillStyle = 'rgb(230,230,230)';
            ctx.arc(cx, cy, 50, 0, 2 * Math.PI);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(cx, 30); ctx.lineTo(cx, canvas.height);
            ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy);
            ctx.stroke();
            ctx.fillStyle = 'black';
            ctx.font = '12px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('A u s l a u f', cx, 18);
        }
    }

    function hintergrundSpeichern() {
        backgroundImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function standardHintergrundSetzen(gitter) {
        hintergrundZeichnen(gitter);
        defaultDataURL = canvas.toDataURL('image/png');
        hintergrundSpeichern();
    }

    function canvasGroesse() {
        const bereich = document.getElementById('skizzebereich');
        const breite = bereich.clientWidth - 32; // 2 × 1rem container padding
        const size = Math.floor(breite);
        if (size <= 0) return;

        const oldWidth = canvas.width;
        const oldHeight = canvas.height;
        if (oldWidth === size && oldHeight === size && backgroundImageData) return;

        const inhaltBehalten = oldWidth > 0 && oldHeight > 0 && (loadedContent || strokes.length > 0);
        const alterHintergrund = inhaltBehalten && loadedContent && backgroundImageData
            ? imageDataCanvas(backgroundImageData, oldWidth, oldHeight)
            : null;
        const sx = oldWidth > 0 ? size / oldWidth : 1;
        const sy = oldHeight > 0 ? size / oldHeight : 1;
        const skalierteStrokes = inhaltBehalten ? strokes.map(s => strokeSkalieren(s, sx, sy)).filter(Boolean) : [];
        const skalierterUndoStack = inhaltBehalten ? undoStack.map(e => undoEintragSkalieren(e, sx, sy)).filter(Boolean) : [];

        pen.zeichnen = false;
        canvas.width = size;
        canvas.height = size;
        standardHintergrundSetzen(currentMode);

        if (alterHintergrund) {
            ctx.drawImage(alterHintergrund, 0, 0, oldWidth, oldHeight, 0, 0, size, size);
            hintergrundSpeichern();
        }

        if (inhaltBehalten) {
            strokes = skalierteStrokes;
            undoStack = skalierterUndoStack;
            redrawAll();
        } else {
            strokes = [];
            undoStack = [];
            loadedContent = false;
        }
    }

    function init() {
        canvas = document.getElementById('canvas');
        ctx = canvas.getContext('2d');
        canvas.addEventListener('pointermove', draw);
        canvas.addEventListener('pointerdown', start);
        canvas.addEventListener('pointerup', stop);
        canvas.addEventListener('pointerleave', stop);
        canvas.addEventListener('pointercancel', () => { stop(); pen.stift = false; });
        window.addEventListener('resize', () => { cachedRect = null; canvasGroesse(); });
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
        });
        ['skizze', 'gitter'].forEach(id => {
            document.getElementById(id).addEventListener('click', () => setMode(id === 'gitter'));
        });
        document.getElementById('zeichnen_freihand')?.addEventListener('click', () => setKorrektur(false));
        document.getElementById('zeichnen_korrektur')?.addEventListener('click', () => setKorrektur(true));
        setKorrektur(korrekturAktiv);
        canvasGroesse();
    }

    function leinwand(gitter) {
        ladeToken++;
        ladeAktiv = false;
        ladePromise = Promise.resolve();
        stiftZuruecksetzen();
        strokes = [];
        undoStack = [];
        loadedContent = false;
        rasterBasisAktiv = false;
        standardHintergrundSetzen(gitter);
    }

    function getCoords(e) {
        return { x: e.clientX - cachedRect.left, y: e.clientY - cachedRect.top };
    }

    // --- Zeichnen ---

    function start(event) {
        if (!pen.stift || ladeAktiv) return;
        pen.zeichnen = true;
        cachedRect = canvas.getBoundingClientRect();
        const { x, y } = getCoords(event);
        strokePoints = [{ x, y }];
        if (pen.farbe !== 'white') {
            preStrokeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        }
    }

    function draw(event) {
        if (!pen.zeichnen || !pen.stift) return;
        const { x, y } = getCoords(event);
        strokePoints.push({ x, y });
        if (pen.farbe !== 'white') {
            ctx.putImageData(preStrokeImageData, 0, 0);
            ctx.beginPath();
            ctx.lineWidth = pen.breite;
            ctx.strokeStyle = pen.farbe;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(strokePoints[0].x, strokePoints[0].y);
            for (let i = 1; i < strokePoints.length; i++) ctx.lineTo(strokePoints[i].x, strokePoints[i].y);
            ctx.stroke();
        }
    }

    function stop() {
        if (!pen.zeichnen) return;
        pen.zeichnen = false;

        if (pen.farbe === 'white') {
            // Strich-basiertes Löschen: alle getroffenen Striche entfernen
            const hitRadius = pen.breite + 4;
            const removed = strokes.filter(s => hitTestStroke(s, strokePoints, hitRadius));
            if (removed.length > 0) {
                strokes = strokes.filter(s => !removed.includes(s));
                redrawAll();
                if (undoStack.length >= HISTORY_MAX) undoStack.shift();
                undoStack.push({ type: 'erase', removed });
                App.triggerAutoSave();
            }
            return;
        }

        if (strokePoints.length < 2) return;
        const stroke = korrekturAktiv ? autoKorrektur() : freihandStrich();
        strokes.push(stroke);
        if (undoStack.length >= HISTORY_MAX) undoStack.shift();
        undoStack.push({ type: 'draw', stroke });
        App.triggerAutoSave();
    }

    function freihandStrich() {
        const stroke = { type: 'freehand', points: [...strokePoints], color: pen.farbe, width: pen.breite };
        redrawAll();
        drawStroke(stroke);
        return stroke;
    }

    // Gibt den korrigierten Strich als Objekt zurück und zeichnet ihn
    function autoKorrektur() {
        const s = strokePoints[0];
        const e = strokePoints[strokePoints.length - 1];
        const dx = e.x - s.x, dy = e.y - s.y;
        const len = Math.hypot(dx, dy);

        // Kumulative Längen berechnen für parameter t
        const laengen = [0];
        for (let i = 1; i < strokePoints.length; i++) {
            const prev = strokePoints[i - 1], cur = strokePoints[i];
            laengen.push(laengen[i - 1] + Math.hypot(cur.x - prev.x, cur.y - prev.y));
        }
        const gesamtLen = laengen[laengen.length - 1];

        let stroke;

        if (len < 3) {
            // Zu kurz – als Freihand speichern
            stroke = { type: 'freehand', points: [...strokePoints], color: pen.farbe, width: pen.breite };
        } else {
            // Punkt mit grösster Abweichung von der Geraden s→e
            let maxAbw = 0, maxIdx = 0;
            for (let i = 1; i < strokePoints.length - 1; i++) {
                const p = strokePoints[i];
                const d = Math.abs(dy * p.x - dx * p.y + e.x * s.y - e.y * s.x) / len;
                if (d > maxAbw) { maxAbw = d; maxIdx = i; }
            }

            if (maxAbw < LINIE_SCHWELLE) {
                stroke = { type: 'line', start: s, end: e, color: pen.farbe, width: pen.breite };
            } else {
                // Quadratische Bezier: cp = (P - (1-t)²·S - t²·E) / (2t(1-t))
                const p = strokePoints[maxIdx];
                const t = gesamtLen > 0 ? laengen[maxIdx] / gesamtLen : 0.5;
                const denom = 2 * t * (1 - t);
                const cpx = denom > 0.001 ? (p.x - (1 - t) * (1 - t) * s.x - t * t * e.x) / denom : p.x;
                const cpy = denom > 0.001 ? (p.y - (1 - t) * (1 - t) * s.y - t * t * e.y) / denom : p.y;
                stroke = { type: 'bezier', start: s, end: e, cp: { x: cpx, y: cpy }, color: pen.farbe, width: pen.breite };
            }
        }

        redrawAll();
        drawStroke(stroke);
        return stroke;
    }

    function undo() {
        if (undoStack.length === 0) return;
        const last = undoStack.pop();
        if (last.type === 'draw') {
            strokes.pop();
        } else {
            strokes.push(...last.removed);
        }
        redrawAll();
        App.triggerAutoSave();
    }

    function farbwahl(el) {
        document.querySelectorAll('menu label[data-stift]').forEach(l => l.classList.remove('aktiv'));
        el.classList.add('aktiv');
        pen.farbe = el.id;
        pen.stift = true;
        canvas.style.cursor = 'crosshair';
        pen.breite = pen.farbe === 'white' ? 6 : 1;
    }

    function setMode(gitter) {
        const neuerModus = Boolean(gitter);
        if (neuerModus === currentMode) return;
        if (rasterBasisAktiv) {
            App.toast('Moduswechsel für ältere Raster-Skizzen nicht möglich.', 'warn');
            return;
        }
        currentMode = neuerModus;
        standardHintergrundSetzen(neuerModus);
        redrawAll();
        App.triggerAutoSave();
    }

    function setKorrektur(aktiv) {
        korrekturAktiv = Boolean(aktiv);
        document.getElementById('zeichnen_freihand')?.classList.toggle('aktiv', !korrekturAktiv);
        document.getElementById('zeichnen_korrektur')?.classList.toggle('aktiv', korrekturAktiv);
    }

    function getDataURL() { return canvas.toDataURL('image/png'); }

    function getBasisDataURL() {
        if (!backgroundImageData) return '';
        return imageDataCanvas(backgroundImageData, canvas.width, canvas.height).toDataURL('image/png');
    }

    function ready() { return ladePromise; }

    function getStrokes() {
        return strokes.map(s => strokeSkalieren(s, 1, 1)).filter(Boolean);
    }

    function hasContent() {
        return loadedContent || strokes.length > 0 || getDataURL() !== defaultDataURL;
    }

    function ladeSkizze(dataURL, genutzt, gespeicherteStrokes = [], gitter = currentMode, basisDataURL = '') {
        const token = ++ladeToken;
        stiftZuruecksetzen();
        strokes = strokesNormalisieren(gespeicherteStrokes);
        undoStack = [];
        loadedContent = false;
        standardHintergrundSetzen(Boolean(gitter));

        if (basisDataURL && strokes.length > 0) {
            rasterBasisAktiv = false;
            loadedContent = typeof genutzt === 'boolean' ? genutzt : true;
            ladeAktiv = true;
            ladePromise = new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    if (token === ladeToken) {
                        standardHintergrundSetzen(Boolean(gitter));
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        hintergrundSpeichern();
                        redrawAll();
                    }
                    if (token === ladeToken) ladeAktiv = false;
                    resolve();
                };
                img.onerror = () => { if (token === ladeToken) ladeAktiv = false; resolve(); };
                img.src = basisDataURL;
            });
            return;
        }

        if (!dataURL) {
            if (strokes.length > 0) {
                redrawAll();
                loadedContent = true;
            }
            ladeAktiv = false;
            ladePromise = Promise.resolve();
            return;
        }
        // Alte Datensätze enthalten kein separates Basisbild. Das vollständige
        // Rasterbild wird deshalb als unveränderliche Basis übernommen. So gehen
        // beim nachträglichen Ergänzen keine bestehenden Skizzenteile verloren.
        strokes = [];
        rasterBasisAktiv = true;
        ladeAktiv = true;
        ladePromise = new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                if (token === ladeToken) {
                    standardHintergrundSetzen(Boolean(gitter));
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    hintergrundSpeichern();
                    loadedContent = typeof genutzt === 'boolean' ? genutzt : dataURL !== defaultDataURL;
                }
                if (token === ladeToken) ladeAktiv = false;
                resolve();
            };
            img.onerror = () => { if (token === ladeToken) ladeAktiv = false; resolve(); };
            img.src = dataURL;
        });
    }

    return { init, leinwand, farbwahl, undo, getDataURL, getBasisDataURL, getStrokes, hasContent, ladeSkizze, ready, setMode, get currentMode() { return currentMode; } };
})();

// ============================================================
// Schacht – Geschäftslogik & Datenmodell
// ============================================================
const FORMULAR_UMFANG_KEYS = ['deckel', 'schacht', 'leitungen', 'zustand'];
const DEFAULT_FORMULAR_UMFANG = Object.freeze({
    deckel: true,
    schacht: true,
    leitungen: true,
    zustand: false
});
const FORMULAR_UMFANG_BEREICHE = {
    deckel: 'deckelbereich',
    schacht: 'schachtangaben',
    leitungen: 'leitungsdaten',
    zustand: 'zustandsbereich'
};
const FORMULAR_UMFANG_LABELS = {
    deckel: 'Deckel',
    schacht: 'Schacht',
    leitungen: 'Leitungen',
    zustand: 'Zustand'
};
const ZUSTAND_GRUPPEN = [
    { key: 'schacht', label: 'Schacht' },
    { key: 'schachtdeckel', label: 'Schachtdeckel' },
    { key: 'schachtdeckelrahmen', label: 'Schachtdeckelrahmen' },
    { key: 'schachthals', label: 'Schachthals' },
    { key: 'schachtrohr', label: 'Schachtrohr' },
    { key: 'steigleiter_steigeisen', label: 'Steigleiter / Steigeisen' },
    { key: 'bankett_durchlaufrinne', label: 'Bankett / Durchlaufrinne' },
    { key: 'grundwassereinbruch', label: 'Grundwassereinbruch' },
    { key: 'anschlusse', label: 'Anschlüsse' },
    { key: 'einlauf_hauptleitung', label: 'Einlauf (Hauptleitung)' },
    { key: 'auslauf_hauptleitung', label: 'Auslauf (Hauptleitung)' }
];
const ZUSTAND_OPTION_LABELS = {
    keine_mangel: 'keine Mängel',
    uberdeckt: 'überdeckt',
    kann_nicht_geoffnet_werden: 'kann nicht geöffnet werden',
    verschraubt: 'verschraubt',
    defekt: 'defekt',
    mangelhaft_untermortelt: 'mangelhaft untermörtelt',
    gerissen: 'gerissen',
    lose: 'lose',
    versetzt: 'versetzt',
    schlecht_verputzt: 'schlecht verputzt',
    ausgebrochen: 'ausgebrochen',
    fugen_schlecht_verputzt: 'Fugen schlecht verputzt',
    verrostet: 'verrostet',
    fehlt: 'fehlt',
    ausgewaschen: 'ausgewaschen',
    kein_bankett: 'kein Bankett',
    schlecht_ausgebildet: 'schlecht ausgebildet',
    bankett: 'Bankett',
    sohle: 'Sohle',
    schachtrohr: 'Schachtrohr',
    verkalkt: 'verkalkt',
    schlecht_eingefuhrt: 'schlecht eingeführt',
    nicht_verputzt: 'nicht verputzt',
    wurzeleinwuchs: 'Wurzeleinwuchs',
    undicht: 'undicht'
};

function formularUmfangNormalisieren(umfang) {
    return FORMULAR_UMFANG_KEYS.reduce((acc, key) => {
        acc[key] = Object.prototype.hasOwnProperty.call(umfang || {}, key)
            ? Boolean(umfang[key])
            : DEFAULT_FORMULAR_UMFANG[key];
        return acc;
    }, {});
}

function zustandsOptionLabel(key) {
    return ZUSTAND_OPTION_LABELS[key] || key;
}

function zustandsOptionenText(zustandsliste, gruppeKey) {
    return (zustandsliste?.[gruppeKey] || []).map(zustandsOptionLabel).join(', ');
}

function istBlob(value) {
    if (window.SchachtZip?.isBlob) return window.SchachtZip.isBlob(value);
    // Fallback falls zip-writer.js (noch) nicht geladen ist - Logik synchron zu SchachtZip.isBlob halten (assets/vendor/zip-writer.js)
    return Boolean(value && typeof value === 'object' &&
        ((typeof Blob !== 'undefined' && value instanceof Blob) || Object.prototype.toString.call(value) === '[object Blob]') &&
        typeof value.arrayBuffer === 'function' && typeof value.size === 'number');
}

function istDataUrl(value) {
    return typeof value === 'string' && /^data:[^,]*,/i.test(value);
}

function dataUrlMime(dataUrl) {
    const match = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
    return match ? match[1].toLowerCase() : 'application/octet-stream';
}

function dataUrlZuBlob(dataUrl) {
    if (!istDataUrl(dataUrl)) return null;
    const text = String(dataUrl);
    const comma = text.indexOf(',');
    const meta = text.slice(0, comma).toLowerCase();
    const body = text.slice(comma + 1);
    if (meta.includes(';base64')) {
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: dataUrlMime(text) });
    }
    return new Blob([decodeURIComponent(body)], { type: dataUrlMime(text) });
}

function blobZuDataUrl(blob) {
    return new Promise((resolve, reject) => {
        if (!istBlob(blob)) { resolve(''); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Blob konnte nicht gelesen werden'));
        reader.readAsDataURL(blob);
    });
}

function fotoNormalisieren(foto) {
    const istUnterstuetzt = mime => /^image\/(jpeg|png|webp)$/i.test(String(mime || ''));
    if (istBlob(foto)) return istUnterstuetzt(foto.type) ? foto : null;
    if (istDataUrl(foto)) {
        try {
            if (!istUnterstuetzt(dataUrlMime(foto))) return null;
            return dataUrlZuBlob(foto);
        } catch (e) {
            console.warn('[Fotos] Ungültiges Foto ignoriert:', e);
            return null;
        }
    }
    return null;
}

function fotosNormalisieren(fotos) {
    return Array.isArray(fotos)
        ? fotos.map(fotoNormalisieren).filter(Boolean)
        : [];
}

async function fotoAlsDataUrl(foto) {
    if (istBlob(foto)) return blobZuDataUrl(foto);
    return istDataUrl(foto) ? foto : '';
}

async function fotosAlsDataUrls(fotos) {
    const result = await Promise.all((fotos || []).map(fotoAlsDataUrl));
    return result.filter(Boolean);
}

async function recordFuerExport(record, optionen = {}) {
    const { medien = true } = optionen;
    const { _leerentwurf, status, ...exportRecord } = record || {};
    if (!medien) {
        exportRecord.fotos = [];
        exportRecord.skizze = '';
        exportRecord.skizze_basis = '';
        return exportRecord;
    }
    exportRecord.fotos = await fotosAlsDataUrls(record?.fotos);
    return exportRecord;
}

function importServerFelderEntfernen(s) {
    delete s.id;
    delete s.erstellt_am;
    delete s.geaendert_am;
    delete s.version;
    delete s._leerentwurf;
    delete s.status;
}

function importTextfelderPruefen(s) {
    Object.entries(s).forEach(([feld, value]) => {
        if (typeof value === 'string' && !['skizze', 'skizze_basis'].includes(feld) && value.length > IMPORT_MAX_TEXT) {
            throw new Error(`Textfeld «${feld}» ist länger als ${IMPORT_MAX_TEXT} Zeichen`);
        }
    });
}

function importLeitungenNormalisieren(s) {
    const leitungen = Array.isArray(s.leitungen) ? s.leitungen.filter(v => v && typeof v === 'object') : [];
    if (leitungen.length > IMPORT_MAX_LEITUNGEN) throw new Error(`Mehr als ${IMPORT_MAX_LEITUNGEN} Leitungen`);
    leitungen.forEach((leitung, index) => Object.entries(leitung).forEach(([feld, value]) => {
        if (typeof value === 'string' && value.length > 500) throw new Error(`Leitung ${index + 1}, Feld «${feld}» ist zu lang`);
    }));
    s.leitungen = leitungen;
}

function importFotosNormalisieren(s) {
    const fotos = Array.isArray(s.fotos) ? s.fotos : [];
    if (fotos.length > IMPORT_MAX_FOTOS) throw new Error(`Mehr als ${IMPORT_MAX_FOTOS} Fotos`);
    fotos.forEach(foto => {
        if (typeof foto === 'string' && foto.length > IMPORT_MAX_DATA_URL) {
            throw new Error('Foto im Import ist zu gross');
        }
    });
    s.fotos = fotosNormalisieren(fotos);
}

function importSkizzeNormalisieren(s) {
    const strokes = Array.isArray(s.skizze_strokes) ? s.skizze_strokes : [];
    if (strokes.length > IMPORT_MAX_STRICHE) throw new Error(`Mehr als ${IMPORT_MAX_STRICHE} Skizzenstriche`);
    s.skizze_strokes = strokes;
    if (typeof s.skizze === 'string' && s.skizze.length > IMPORT_MAX_DATA_URL) throw new Error('Skizze ist zu gross');
    if (typeof s.skizze_basis === 'string' && s.skizze_basis.length > IMPORT_MAX_DATA_URL) throw new Error('Skizzenbasis ist zu gross');
    s.skizze = istDataUrl(s.skizze) ? s.skizze : '';
    s.skizze_basis = istDataUrl(s.skizze_basis) ? s.skizze_basis : '';
    if (s.skizze_modus && !['skizze', 'gitter'].includes(s.skizze_modus)) {
        s.skizze_modus = 'skizze';
    }
    if (Object.prototype.hasOwnProperty.call(s, 'skizze_genutzt')) {
        s.skizze_genutzt = s.skizze_genutzt === true || String(s.skizze_genutzt).toLowerCase() === 'true';
    }
}

function importZustandslisteNormalisieren(s) {
    if (!s.zustandsliste || typeof s.zustandsliste !== 'object' || Array.isArray(s.zustandsliste)) {
        s.zustandsliste = {};
    }
    Object.keys(s.zustandsliste).forEach(key => {
        if (!ZUSTAND_GRUPPEN.some(gruppe => gruppe.key === key) || !Array.isArray(s.zustandsliste[key])) {
            delete s.zustandsliste[key];
            return;
        }
        s.zustandsliste[key] = s.zustandsliste[key]
            .map(value => String(value || '').trim())
            .filter(value => Object.prototype.hasOwnProperty.call(ZUSTAND_OPTION_LABELS, value));
    });
}

function importRecordNormalisieren(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Datensatz ist kein Objekt');
    }
    const s = { ...raw };
    importServerFelderEntfernen(s);
    importTextfelderPruefen(s);
    importLeitungenNormalisieren(s);
    importFotosNormalisieren(s);
    importSkizzeNormalisieren(s);
    s.formular_umfang = formularUmfangNormalisieren(s.formular_umfang);
    importZustandslisteNormalisieren(s);
    s.schadenstufe = ['1', '2', '3', '4'].includes(String(s.schadenstufe || ''))
        ? String(s.schadenstufe)
        : '';
    return s;
}

function jsonImportRecords(daten) {
    if (Array.isArray(daten)) return daten;
    if (daten && Array.isArray(daten.records)) return daten.records;
    if (daten && Object.prototype.hasOwnProperty.call(daten, 'records')) {
        throw new Error('JSON-Feld «records» ist keine Liste');
    }
    if (daten && typeof daten === 'object') return [daten];
    throw new Error('Ungültiges JSON-Format');
}

async function importRecordsSpeichern(records, ziele = []) {
    if (!Array.isArray(records) || records.length === 0) throw new Error('Keine Datensätze im Import');
    if (records.length > IMPORT_MAX_DATENSAETZE) throw new Error(`Mehr als ${IMPORT_MAX_DATENSAETZE} Datensätze`);
    const normalisiert = records.map((record, index) => {
        try {
            const daten = importRecordNormalisieren(record);
            const ziel = ziele[index];
            if (ziel) {
                daten._import_ziel_id = ziel.id;
                daten._import_erstellt_am = ziel.erstellt_am;
                daten._import_version = (ziel.version || 0) + 1;
            }
            return daten;
        } catch (e) {
            throw new Error(`Datensatz ${index + 1}: ${e.message}`);
        }
    });
    await DB.vieleSpeichern(normalisiert);
    return { importiert: normalisiert.length, aktualisiert: ziele.filter(Boolean).length, fehler: 0 };
}

function backupZeitMerken(typ = 'vollstaendig') {
    try {
        localStorage.setItem('letztes_json_backup', JSON.stringify({ zeit: new Date().toISOString(), typ }));
    } catch (e) {
        console.warn('[Backup] Zeitpunkt konnte nicht gespeichert werden:', e);
    }
}

async function jsonPayloadErstellen(records, optionen = {}) {
    const medien = optionen.medien !== false;
    const exportRecords = await Promise.all(records.map(record => recordFuerExport(record, { medien })));
    return {
        schema_version: EXPORT_SCHEMA_VERSION,
        app_version: APP_VERSION,
        exported_at: new Date().toISOString(),
        media_included: medien,
        records: exportRecords
    };
}

async function aktuellenEntwurfSichern() {
    try {
        await Sketch.ready();
        const payload = await jsonPayloadErstellen([Schacht.sammeln()]);
        payload.recovery_export = true;
        downloadFile(JSON.stringify(payload, null, 2), 'application/json', `schachtprotokoll_entwurf_${dateiDatum()}.json`);
        backupZeitMerken('entwurf');
        App.toast('Aktuellen Entwurf als JSON gesichert.', 'warn');
    } catch (error) {
        console.error('[Backup] Entwurf konnte nicht gesichert werden:', error);
        App.toast(`Entwurf konnte nicht gesichert werden: ${error.message || 'Unbekannter Fehler'}`, 'fehler');
        throw error;
    }
}

function datensatzSchluessel(record) {
    const teile = [record?.gemeinde, record?.strasse, record?.nummer, record?.aufnahmedatum]
        .map(value => String(value || '').trim().toLocaleLowerCase('de-CH'));
    return teile[2] ? teile.join('|') : '';
}

const Schacht = (() => {
    const PFLICHTFELDER = ['ltg_richtung'];

    // Alle Formularfelder des Schachts (ID → direkt via _val/_set)
    const KOPFDATEN = ['gemeinde', 'strasse', 'nummer', 'parzelle', 'aufnahmedatum', 'visum'];

    const FELDER = [
        ...KOPFDATEN,
        'koordinaten_e', 'koordinaten_n', 'koordinaten_z',
        // Schacht
        'schacht_typ', 'schacht_medium', 'schacht_material', 'schacht_dim', 'schacht_sohle',
        'schacht_einstieg', 'schacht_einstieghilfe', 'schacht_eigentuemer', 'schacht_baujahr',
        // Deckel
        'deckel_form', 'deckel_dm', 'deckel_material', 'deckel_verschluss',
        'deckel_oberflaechenzulauf', 'deckel_zugaenglichkeit', 'deckel_baujahr',
        // Zustand
        'zustand', 'notiz', 'skizze_beschreibung'
    ];

    // Alle Felder im Leitungs-Dialog
    const DIALOG_FELDER = [
        'ltg_richtung', 'tiefe', 'ltg_profil', 'rmat', 'rdm',
        'ltg_funktion', 'ltg_art', 'ltg_betrieb', 'ltg_hydraulik',
        'lnotiz'
    ];

    function _val(id) {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    function _set(id, val) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val || '';
        if (el.tagName === 'SELECT') {
            if (el.value === '') el.selectedIndex = 0;
            el.classList.toggle('wert-gewaehlt', el.value !== '');
        }
    }

    function _kopfdatenMerken() {
        ['gemeinde', 'strasse'].forEach(id => {
            const value = _val(id);
            if (value) {
                localStorage.setItem(id, value);
            } else {
                localStorage.removeItem(id);
            }
        });
    }

    function _leitungenAusTabelle() {
        return Array.from(document.querySelectorAll('#tblleitungen tbody tr')).map(r => {
            const ltg = JSON.parse(r.dataset.ltg || '{}');
            ltg.nr = r.cells[0].textContent;
            return ltg;
        });
    }

    function _formularUmfangSammeln() {
        return FORMULAR_UMFANG_KEYS.reduce((acc, key) => {
            acc[key] = Boolean(document.getElementById(`umfang_${key}`)?.checked);
            return acc;
        }, {});
    }

    function _formularUmfangSetzen(umfang) {
        const normalisiert = formularUmfangNormalisieren(umfang);
        FORMULAR_UMFANG_KEYS.forEach(key => {
            const el = document.getElementById(`umfang_${key}`);
            if (el) el.checked = normalisiert[key];
        });
        formularUmfangAnwenden(normalisiert);
    }

    function _hatZustandsdaten(data) {
        const liste = data?.zustandsliste || {};
        return Boolean(data?.schadenstufe) || Object.values(liste).some(v => Array.isArray(v) && v.length > 0);
    }

    function formularUmfangAnwenden(umfang = _formularUmfangSammeln()) {
        const normalisiert = formularUmfangNormalisieren(umfang);
        FORMULAR_UMFANG_KEYS.forEach(key => {
            const bereich = document.getElementById(FORMULAR_UMFANG_BEREICHE[key]);
            if (bereich) bereich.hidden = !normalisiert[key];
            const input = document.getElementById(`umfang_${key}`);
            const label = input?.closest('.umfang-toggle');
            if (label) label.classList.toggle('umfang-toggle--aktiv', normalisiert[key]);
        });
        if (typeof ErfassungsumfangUI !== 'undefined') ErfassungsumfangUI.aktualisieren();
    }

    function _zustandslisteSammeln() {
        const daten = {};
        document.querySelectorAll('#zustandsbereich tr[data-zustand-gruppe]').forEach(row => {
            const gruppe = row.dataset.zustandGruppe;
            daten[gruppe] = Array.from(row.querySelectorAll('input[type="checkbox"][data-zustand-option]:checked'))
                .map(cb => cb.dataset.zustandOption);
        });
        return daten;
    }

    function _zustandslisteSetzen(zustandsliste = {}) {
        document.querySelectorAll('#zustandsbereich input[type="checkbox"][data-zustand-option]').forEach(cb => {
            const row = cb.closest('tr[data-zustand-gruppe]');
            const gruppe = row?.dataset.zustandGruppe;
            cb.checked = Boolean(gruppe && (zustandsliste[gruppe] || []).includes(cb.dataset.zustandOption));
        });
    }

    function _schadenstufeSammeln() {
        return document.querySelector('#zustandsbereich input[name="schadenstufe"]:checked')?.value || '';
    }

    function _schadenstufeSetzen(value) {
        document.querySelectorAll('#zustandsbereich input[name="schadenstufe"]').forEach(rb => {
            rb.checked = rb.value === value;
        });
    }

    function _zustandZuruecksetzen() {
        _zustandslisteSetzen({});
        _schadenstufeSetzen('');
    }

    function zustandsCheckboxGeaendert(checkbox) {
        const row = checkbox.closest('tr[data-zustand-gruppe]');
        if (!row || !checkbox.checked) return;
        if (checkbox.dataset.exklusiv === 'true') {
            row.querySelectorAll('input[type="checkbox"][data-zustand-option]').forEach(cb => {
                if (cb !== checkbox) cb.checked = false;
            });
        } else {
            const keineMaengel = row.querySelector('input[type="checkbox"][data-exklusiv="true"]');
            if (keineMaengel) keineMaengel.checked = false;
            const gesamtzustand = document.getElementById('zustand');
            if (gesamtzustand?.value === 'Keine Mängel') {
                _set('zustand', '');
                App.toast('Gesamtzustand «Keine Mängel» wurde entfernt.', 'warn');
            }
        }
    }

    function gesamtzustandGeaendert() {
        if (_val('zustand') !== 'Keine Mängel' || !_hatZustandsdaten({
            zustandsliste: _zustandslisteSammeln(),
            schadenstufe: _schadenstufeSammeln()
        })) return;
        _zustandZuruecksetzen();
        App.toast('Detailmängel und Schadenstufe wurden zurückgesetzt.', 'warn');
    }

    function _zahl(value) {
        const text = String(value ?? '').trim().replace(/['\s]/g, '').replace(',', '.');
        if (!text) return null;
        const zahl = Number(text);
        return Number.isFinite(zahl) ? zahl : NaN;
    }

    function validieren(data) {
        const fehler = [];
        const add = (feld, meldung) => fehler.push({ feld, meldung });
        if (!hatWert(data.gemeinde)) add('gemeinde', 'Gemeinde fehlt');
        if (!hatWert(data.nummer)) add('nummer', 'Schacht-Nr. fehlt');
        if (!hatWert(data.aufnahmedatum)) add('aufnahmedatum', 'Aufnahmedatum fehlt');

        const aktuellesJahr = new Date().getFullYear() + 1;
        [['deckel_baujahr', 'Baujahr Deckel'], ['schacht_baujahr', 'Baujahr Schacht']].forEach(([feld, label]) => {
            if (!hatWert(data[feld])) return;
            const jahr = Number(data[feld]);
            if (!/^\d{4}$/.test(data[feld]) || jahr < 1800 || jahr > aktuellesJahr) add(feld, `${label} ist ungültig`);
        });

        const pruefeBereich = (feld, label, min, max) => {
            if (!hatWert(data[feld])) return;
            const zahl = _zahl(data[feld]);
            if (!Number.isFinite(zahl) || zahl < min || zahl > max) add(feld, `${label} muss zwischen ${min} und ${max} liegen`);
        };
        pruefeBereich('koordinaten_z', 'Höhe', -500, 5000);
        pruefeBereich('schacht_sohle', 'Sohlentiefe', 0, 5000);

        const e = _zahl(data.koordinaten_e);
        const n = _zahl(data.koordinaten_n);
        if (e !== null || n !== null) {
            if (!Number.isFinite(e) || e < 2000000 || e > 3000000) add('koordinaten_e', 'LV95-Koordinate E ist ungültig');
            if (!Number.isFinite(n) || n < 1000000 || n > 1400000) add('koordinaten_n', 'LV95-Koordinate N ist ungültig');
        }

        (data.leitungen || []).forEach((leitung, index) => {
            if (!hatWert(leitung.ltg_richtung)) add(null, `Leitung ${index + 1}: Richtung fehlt`);
            const tiefe = _zahl(leitung.tiefe);
            if (tiefe !== null && (!Number.isFinite(tiefe) || tiefe < 0 || tiefe > 30)) add(null, `Leitung ${index + 1}: Tiefe ist ungültig`);
            const nennweite = _zahl(leitung.rdm);
            if (nennweite !== null && (!Number.isFinite(nennweite) || nennweite <= 0 || nennweite > 5000)) add(null, `Leitung ${index + 1}: Nennweite ist ungültig`);
        });
        return fehler;
    }

    function validierungsfehlerAnzeigen(fehler) {
        document.querySelectorAll('[data-fachfehler="true"]').forEach(el => {
            el.classList.remove('fehler');
            el.removeAttribute('data-fachfehler');
            el.setCustomValidity?.('');
        });
        fehler.forEach(({ feld, meldung }) => {
            const el = feld ? document.getElementById(feld) : null;
            if (!el) return;
            el.classList.add('fehler');
            el.dataset.fachfehler = 'true';
            el.setCustomValidity?.(meldung);
            el.title = meldung;
        });
    }

    function sammeln() {
        _kopfdatenMerken();
        const daten = {
            id: App.state.currentSchachtId || undefined,
            datum: new Date().toLocaleDateString('de-CH'),
            firma: APP_FIRMA,
            formular_umfang: _formularUmfangSammeln(),
            leitungen: _leitungenAusTabelle(),
            zustandsliste: _zustandslisteSammeln(),
            schadenstufe: _schadenstufeSammeln(),
            skizze: Sketch.getDataURL(),
            skizze_basis: Sketch.getBasisDataURL(),
            skizze_genutzt: Sketch.hasContent(),
            skizze_strokes: Sketch.getStrokes(),
            skizze_modus: Sketch.currentMode ? 'gitter' : 'skizze',
            fotos: fotosAusFormular()
        };
        FELDER.forEach(id => { daten[id] = _val(id); });
        return daten;
    }

    function laden(data) {
        FELDER.forEach(id => _set(id, data[id]));
        _formularUmfangSetzen(data.formular_umfang || (_hatZustandsdaten(data) ? { ...DEFAULT_FORMULAR_UMFANG, zustand: true } : DEFAULT_FORMULAR_UMFANG));
        _zustandslisteSetzen(data.zustandsliste || {});
        _schadenstufeSetzen(data.schadenstufe || '');
        const tbody = document.querySelector('#tblleitungen tbody');
        tbody.innerHTML = '';
        App.leitungsnummerZuruecksetzen();
        (data.leitungen || []).forEach(l => _insertLeitungRow(l));
        const skizzenModus = data.skizze_modus === 'gitter' ? true : false;
        Sketch.ladeSkizze(data.skizze, typeof data.skizze_genutzt === 'boolean' ? data.skizze_genutzt : undefined, data.skizze_strokes, skizzenModus, data.skizze_basis);
        fotosLeeren();
        (data.fotos || []).filter(Boolean).forEach(foto => fotoHinzufuegen(foto));
        kopfzeile();
        if (typeof UIFeedback !== 'undefined') {
            UIFeedback.leitungenAktualisieren();
            UIFeedback.medienAktualisieren();
        }
    }

    function zuruecksetzen() {
        FELDER.forEach(id => _set(id, ''));
        _formularUmfangSetzen(DEFAULT_FORMULAR_UMFANG);
        _zustandZuruecksetzen();
        fotosLeeren();
        document.querySelector('#tblleitungen tbody').innerHTML = '';
        App.leitungsnummerZuruecksetzen();
        Sketch.leinwand(false);
        kopfzeile();
        if (typeof UIFeedback !== 'undefined') {
            UIFeedback.leitungenAktualisieren();
            UIFeedback.medienAktualisieren();
        }
    }

    function kopfdatenBehalten() {
        const umfang = _formularUmfangSammeln();
        // Nur Nicht-Kopfdaten leeren
        FELDER.filter(id => !KOPFDATEN.includes(id)).forEach(id => _set(id, ''));
        // Notiz ebenfalls leeren
        _set('notiz', '');
        _zustandZuruecksetzen();
        _formularUmfangSetzen(umfang);
        // Schacht-Nr. um 1 erhöhen
        const nr = parseInt(_val('nummer'), 10);
        if (!isNaN(nr)) _set('nummer', nr + 1);
        fotosLeeren();
        document.querySelector('#tblleitungen tbody').innerHTML = '';
        App.leitungsnummerZuruecksetzen();
        Sketch.leinwand(false);
        kopfzeile();
        if (typeof UIFeedback !== 'undefined') {
            UIFeedback.leitungenAktualisieren();
            UIFeedback.medienAktualisieren();
        }
    }

    function _insertLeitungRow(ltg) {
        const tbody = document.querySelector('#tblleitungen tbody');
        const row = tbody.insertRow(-1);
        // Nummer zuweisen (aus gespeichertem nr oder neu vergeben)
        const nr = ltg.nr || App.state.leitungsnummer;
        const nrZahl = Number(nr);
        if (!Number.isNaN(nrZahl)) {
            App.leitungsnummerSicherstellen(nrZahl);
        }
        const normalisiert = {
            nr: String(nr),
            ltg_richtung: ltg.ltg_richtung || ltg.richtung || '',
            tiefe: ltg.tiefe || '',
            ltg_profil: ltg.ltg_profil || ltg.profil || '',
            rmat: ltg.rmat || ltg.material || '',
            rdm: ltg.rdm || ltg.nennweite || '',
            ltg_funktion: ltg.ltg_funktion || ltg.funktion || '',
            ltg_art: ltg.ltg_art || ltg.art || '',
            ltg_betrieb: ltg.ltg_betrieb || ltg.betrieb || '',
            ltg_hydraulik: ltg.ltg_hydraulik || ltg.hydraulik || '',
            lnotiz: ltg.lnotiz || ltg.notiz || ''
        };
        // Volle Daten als JSON im data-Attribut speichern
        row.dataset.ltg = JSON.stringify(normalisiert);
        // Sichtbare Spalten
        const zeilen = [
            normalisiert.nr,
            normalisiert.ltg_richtung,
            normalisiert.tiefe,
            normalisiert.ltg_profil,
            normalisiert.rmat,
            normalisiert.rdm,
            normalisiert.ltg_funktion,
            normalisiert.ltg_art,
            normalisiert.ltg_betrieb,
            normalisiert.ltg_hydraulik,
            normalisiert.lnotiz
        ];
        const labels = ['Nr', 'Richtung', 'D-', 'Profil', 'Material', 'NW', 'Funktion', 'Art', 'Betrieb', 'Hydraulik', 'Notiz'];
        zeilen.forEach((v, i) => {
            const cell = row.insertCell(-1);
            cell.textContent = v;
            cell.dataset.label = labels[i];
        });
        const editCell = row.insertCell(-1);
        editCell.dataset.label = 'Bearbeiten';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn-laden btn-klein';
        edit.textContent = 'Bearbeiten';
        edit.addEventListener('click', () => bearbeitenLeitung(row));
        editCell.appendChild(edit);
        const delCell = row.insertCell(-1);
        delCell.dataset.label = 'Löschen';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-loeschen btn-klein';
        del.textContent = 'Löschen';
        del.addEventListener('click', async () => {
            if (await bestaetigen('Leitung löschen?')) {
                del.closest('tr').remove();
                UIFeedback.leitungenAktualisieren();
                App.triggerAutoSave();
            }
        });
        delCell.appendChild(del);
        if (typeof UIFeedback !== 'undefined') UIFeedback.leitungenAktualisieren();
    }

    return {
        sammeln,
        laden,
        zuruecksetzen,
        kopfdatenBehalten,
        formularUmfangAnwenden,
        zustandsCheckboxGeaendert,
        gesamtzustandGeaendert,
        validieren,
        validierungsfehlerAnzeigen,
        _insertLeitungRow,
        PFLICHTFELDER,
        DIALOG_FELDER
    };
})();

const ErfassungsumfangUI = (() => {
    function aktualisieren() {
        document.querySelectorAll('#erfassungsumfang input[data-umfang]').forEach(input => {
            input.closest('.umfang-toggle')?.classList.toggle('umfang-toggle--aktiv', input.checked);
        });
    }

    function init() {
        aktualisieren();
    }

    return { init, aktualisieren };
})();

const UIFeedback = (() => {
    function leitungenAktualisieren() {
        const tbody = document.querySelector('#tblleitungen tbody');
        const leer = document.getElementById('leitungenLeer');
        const tabelle = document.getElementById('tblleitungen');
        const count = tbody?.querySelectorAll('tr').length || 0;
        if (leer) leer.hidden = count > 0;
        if (tabelle) tabelle.classList.toggle('tabelle-hat-eintraege', count > 0);
    }

    function medienAktualisieren() {
        const container = document.getElementById('fotos');
        if (!container) return;
        const count = container.children.length;
        container.dataset.count = String(count);
        container.classList.toggle('fotos-container--leer', count === 0);
        const zaehler = document.getElementById('fotoZaehler');
        if (zaehler) zaehler.textContent = `${count}`;
        const label = document.getElementById('kamera-label');
        if (label) {
            label.setAttribute('aria-disabled', 'false');
        }
    }

    function leitungsDialogTitelSetzen(bearbeiten) {
        const titel = document.getElementById('ltgDialogTitel');
        if (titel) titel.textContent = bearbeiten ? 'Leitung bearbeiten' : 'Leitung erfassen';
    }

    function init() {
        leitungenAktualisieren();
        medienAktualisieren();
    }

    return { init, leitungenAktualisieren, medienAktualisieren, leitungsDialogTitelSetzen };
})();

// ============================================================
// Service Worker
// ============================================================
function serviceWorkerRegistrieren() {
    if (!('serviceWorker' in navigator)) {
        console.info('[App] Service Worker nicht verfügbar');
        return;
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        console.info('[App] Service Worker benötigt HTTPS oder localhost');
        return;
    }
    let updateAngefordert = false;
    const updateAnzeigen = worker => {
        if (!worker || !navigator.serviceWorker.controller) return;
        const banner = document.getElementById('update-banner');
        const button = document.getElementById('updateNeuLaden');
        if (banner) banner.hidden = false;
        if (button) button.onclick = () => {
            updateAngefordert = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
        };
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (updateAngefordert) window.location.reload();
    });
    navigator.serviceWorker.register('./serviceworker.js')
        .then(registration => {
            updateAnzeigen(registration.waiting);
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed') updateAnzeigen(worker);
                });
            });
        })
        .catch(e => console.error('[App] Service Worker Fehler:', e));
}

// ============================================================
// Globale Funktionen
// ============================================================

function dialogOeffnen(id) {
    const dlg = document.getElementById(id);
    if (!dlg) return;
    dlg._rueckkehrFokus = document.activeElement;
    if (typeof dlg.showModal === 'function') {
        dlg.showModal();
    } else {
        dlg.setAttribute('open', '');
        dlg.classList.add('dialog-fallback-offen');
        document.body.classList.add('dialog-fallback-aktiv');
    }
    requestAnimationFrame(() => dlg.querySelector('input, select, textarea, button, [tabindex="0"]')?.focus());
}

function dialogSchliessen(id) {
    const dlg = document.getElementById(id);
    if (!dlg) return;
    if (typeof dlg.close === 'function') {
        if (dlg.open) dlg.close();
    } else {
        dlg.removeAttribute('open');
        dlg.classList.remove('dialog-fallback-offen');
        document.body.classList.remove('dialog-fallback-aktiv');
    }
    const rueckkehr = dlg._rueckkehrFokus;
    delete dlg._rueckkehrFokus;
    requestAnimationFrame(() => rueckkehr?.focus?.());
}

function bestaetigen(frage) {
    return new Promise(resolve => {
        const dlg  = document.getElementById('confirmDialog');
        document.getElementById('confirmFrage').textContent = frage;
        const ja   = document.getElementById('confirmJa');
        const nein = document.getElementById('confirmNein');
        let erledigt = false;
        const cleanup = antwort => {
            if (erledigt) return;
            erledigt = true;
            ja.onclick = null;
            nein.onclick = null;
            dlg.removeEventListener('cancel', onCancel);
            dlg.removeEventListener('close', onClose);
            dialogSchliessen('confirmDialog');
            resolve(antwort);
        };
        const onCancel = event => {
            event.preventDefault();
            cleanup(false);
        };
        const onClose = () => cleanup(false);
        ja.onclick   = () => cleanup(true);
        nein.onclick = () => cleanup(false);
        dlg.addEventListener('cancel', onCancel);
        dlg.addEventListener('close', onClose);
        dialogOeffnen('confirmDialog');
    });
}

function heutigesDatum() {
    return new Date().toISOString().slice(0, 10);
}

async function neuerSchacht() {
    if (!await App.aenderungenSpeichern()) return;
    await aktuellenLeerenEntwurfEntfernen();
    App.datensatzWechseln();
    App.setStatus('Neuer Schacht');
    if (await bestaetigen('Kopfdaten für nächsten Schacht übernehmen?')) {
        Schacht.kopfdatenBehalten();
    } else {
        localStorage.removeItem('gemeinde');
        localStorage.removeItem('strasse');
        Schacht.zuruecksetzen();
    }
    document.getElementById('aufnahmedatum').value = heutigesDatum();
    ErfassungsumfangUI.aktualisieren();

    if (!App.state.storageAvailable) {
        App.toast('Neuer Schacht wird nicht gespeichert: Lokaler Speicher ist blockiert.', 'fehler');
        return;
    }

    try {
        await Sketch.ready();
        const neuerEntwurf = recordStatusSetzen(Schacht.sammeln(), RECORD_STATUS.DRAFT);
        const id = await DB.speichern(neuerEntwurf);
        App.datensatzAlsGespeichertMarkieren(id);
        App.setStatus('Neuer Entwurf gespeichert');
        await schachtListeAktualisieren();
        App.toast('Neuer Schacht als Entwurf gespeichert', 'success');
    } catch (error) {
        console.error('Neuen Schacht nicht speichern:', error);
        if (error?.name === 'QuotaExceededError') {
            App.setStorageStatus('blocked', 'Speicher voll: JSON-Backup exportieren und Fotos reduzieren.');
        }
        App.speicherfehlerAnzeigen(`Neuer Schacht konnte nicht gespeichert werden: ${error.message || 'Unbekannter Fehler'}`);
        App.toast('Neuer Schacht konnte nicht gespeichert werden.', 'fehler');
    }
}

function kopfzeile() {
    const visum = document.getElementById('visum')?.value || '';
    const datum = new Date().toLocaleDateString('de-CH');
    const firmakopf = document.getElementById('firmakopf');
    if (firmakopf) firmakopf.textContent = `${visum} / ${datum}`;
    geoLocalisation();
}

const PRINT_FELDER = {
    allgemein: [
        ['Firma', 'firma'], ['Gemeinde', 'gemeinde'], ['Strasse', 'strasse'], ['Nr', 'nummer'],
        ['Parzelle', 'parzelle'], ['Aufnahmedatum', 'aufnahmedatum'], ['Visum', 'visum'],
        ['Koordinaten E', 'koordinaten_e'], ['Koordinaten N', 'koordinaten_n'], ['Koordinaten Z', 'koordinaten_z']
    ],
    deckel: [
        ['Form', 'deckel_form'], ['Durchmesser', 'deckel_dm'], ['Material', 'deckel_material'],
        ['Verschluss', 'deckel_verschluss'], ['Oberflächenzulauf', 'deckel_oberflaechenzulauf'],
        ['Zugänglichkeit', 'deckel_zugaenglichkeit'], ['Baujahr', 'deckel_baujahr']
    ],
    schacht: [
        ['Typ', 'schacht_typ'], ['Medium', 'schacht_medium'], ['Material', 'schacht_material'], ['Dimension', 'schacht_dim'],
        ['Sohle', 'schacht_sohle'], ['Einstieg', 'schacht_einstieg'],
        ['Einstieghilfe', 'schacht_einstieghilfe'],
        ['Eigentümer', 'schacht_eigentuemer'], ['Baujahr', 'schacht_baujahr']
    ]
};

const LEITUNG_EXPORT_SPALTEN = [
    ['nr', 'Nr'], ['ltg_richtung', 'Richtung'], ['tiefe', 'Tiefe'], ['ltg_profil', 'Profil'],
    ['rmat', 'Material'], ['rdm', 'NW'], ['ltg_funktion', 'Funktion'], ['ltg_art', 'Art'],
    ['ltg_betrieb', 'Betrieb'], ['ltg_hydraulik', 'Hydraulik'], ['lnotiz', 'Notiz']
];

function wertText(value) {
    return String(value ?? '').trim();
}

function hatWert(value) {
    return wertText(value) !== '';
}

function datumFuerAnzeige(value) {
    const text = wertText(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.split('-').reverse().join('.') : text;
}

function zeilenAusFeldern(data, felder) {
    return felder
        .map(([label, key]) => [label, key === 'aufnahmedatum' ? datumFuerAnzeige(data[key]) : wertText(data[key])])
        .filter(([, value]) => hatWert(value));
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function printSummarySection(parent, titel, rows) {
    if (!rows.length) return false;
    const section = el('section', 'print-summary-section');
    section.appendChild(el('h2', '', titel));
    const grid = el('div', 'print-summary-grid');
    rows.forEach(([label, value]) => {
        const item = el('div', 'print-summary-item');
        item.appendChild(el('span', 'print-summary-label', label));
        item.appendChild(el('span', 'print-summary-value', value));
        grid.appendChild(item);
    });
    section.appendChild(grid);
    parent.appendChild(section);
    return true;
}

function printSummaryTable(parent, titel, headers, rows) {
    if (!rows.length) return false;
    const section = el('section', 'print-summary-section');
    section.appendChild(el('h2', '', titel));
    const table = el('table', 'print-summary-table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach(header => headRow.appendChild(el('th', '', header)));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(value => tr.appendChild(el('td', '', value)));
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    parent.appendChild(section);
    return true;
}

function leitungenFuerDruck(data) {
    const leitungen = (data.leitungen || []).filter(l => LEITUNG_EXPORT_SPALTEN.some(([key]) => hatWert(l[key])));
    if (!leitungen.length) return null;
    const spalten = LEITUNG_EXPORT_SPALTEN.filter(([key]) => leitungen.some(l => hatWert(l[key])));
    return {
        headers: spalten.map(([, label]) => label),
        rows: leitungen.map(l => spalten.map(([key]) => wertText(l[key])))
    };
}

function zustandFuerDruck(data) {
    const rows = [];
    if (hatWert(data.zustand)) rows.push(['Zustand', wertText(data.zustand)]);
    ZUSTAND_GRUPPEN.forEach(gruppe => {
        const text = zustandsOptionenText(data.zustandsliste, gruppe.key);
        if (hatWert(text)) rows.push([gruppe.label, text]);
    });
    if (hatWert(data.schadenstufe)) rows.push(['Schadenstufe', `Stufe ${data.schadenstufe}`]);
    return rows;
}

function printSummaryMedien(parent, data) {
    const fotos = (data.fotos || []).filter(Boolean);
    const hatSkizze = data.skizze_genutzt === true && hatWert(data.skizze);
    if (!hatSkizze && !fotos.length) return false;
    const section = el('section', 'print-summary-section print-summary-section--medien');
    section.appendChild(el('h2', '', 'Fotos und Skizzen'));
    const media = el('div', 'print-summary-media');
    if (hatSkizze) {
        const wrap = el('div', 'print-summary-media-item print-summary-media-item--skizze');
        const img = document.createElement('img');
        img.alt = 'Skizze';
        img.src = data.skizze;
        wrap.appendChild(img);
        media.appendChild(wrap);
    }
    if (fotos.length) {
        const fotosGrid = el('div', 'print-summary-media-fotos');
        fotos.forEach((foto, index) => {
            const wrap = el('div', 'print-summary-media-item');
            const img = document.createElement('img');
            img.alt = `Foto ${index + 1}`;
            const blob = fotoNormalisieren(foto);
            if (blob) {
                const objectUrl = URL.createObjectURL(blob);
                img.src = objectUrl;
                img.dataset.objectUrl = objectUrl;
            } else {
                img.src = String(foto || '');
            }
            wrap.appendChild(img);
            fotosGrid.appendChild(wrap);
        });
        media.appendChild(fotosGrid);
    }
    section.appendChild(media);
    parent.appendChild(section);
    return true;
}

function printSummaryInhalt(parent, data) {
    const umfang = formularUmfangNormalisieren(data.formular_umfang);
    printSummarySection(parent, 'Allgemein', zeilenAusFeldern(data, PRINT_FELDER.allgemein));
    if (umfang.deckel) printSummarySection(parent, 'Deckel', zeilenAusFeldern(data, PRINT_FELDER.deckel));
    if (umfang.schacht) printSummarySection(parent, 'Schacht', zeilenAusFeldern(data, PRINT_FELDER.schacht));
    if (umfang.leitungen) {
        const leitungen = leitungenFuerDruck(data);
        if (leitungen) printSummaryTable(parent, 'Leitungen', leitungen.headers, leitungen.rows);
    }
    if (umfang.zustand) printSummarySection(parent, 'Zustand', zustandFuerDruck(data));
    printSummarySection(parent, 'Notiz', hatWert(data.notiz) ? [['Notiz', wertText(data.notiz)]] : []);
    printSummarySection(parent, 'Skizzenbeschreibung', hatWert(data.skizze_beschreibung) ? [['Beschreibung', wertText(data.skizze_beschreibung)]] : []);
    printSummaryMedien(parent, data);
}

function printSummaryRecordKopf(data, index, total) {
    const kopf = el('header', 'print-summary-record-kopf');
    const logo = document.createElement('img');
    logo.className = 'print-summary-record-logo';
    logo.src = 'assets/logo.png';
    logo.alt = 'Logo';
    const titel = el('div', 'print-summary-record-titel');
    titel.appendChild(el('strong', '', total > 1 ? `Schacht ${index}/${total}` : 'Schachtprotokoll Abwasser'));
    titel.appendChild(el('span', '', [data.gemeinde, data.strasse, data.nummer].filter(hatWert).join(' · ') || 'Ohne Bezeichnung'));
    const meta = el('div', 'print-summary-record-meta');
    meta.appendChild(el('span', '', datumFuerAnzeige(data.aufnahmedatum) || data.datum || ''));
    meta.appendChild(el('span', '', data.visum ? `Visum ${data.visum}` : ''));
    kopf.append(logo, titel, meta);
    return kopf;
}

function printSummaryRecordErstellen(data, index, total) {
    const record = el('article', 'print-summary-record');
    record.appendChild(printSummaryRecordKopf(data, index, total));
    printSummaryInhalt(record, data);
    return record;
}

function printSummaryErstellen(data) {
    printSummaryEntfernen();
    const summary = el('main', 'print-only');
    summary.id = 'printSummary';
    summary.appendChild(printSummaryRecordKopf(data, 1, 1));
    printSummaryInhalt(summary, data);
    document.body.prepend(summary);
    document.body.classList.add('print-summary-active');
}

function printSummaryAlleErstellen(records) {
    printSummaryEntfernen();
    const summary = el('main', 'print-only print-summary-batch');
    summary.id = 'printSummary';
    records.forEach((record, index) => {
        summary.appendChild(printSummaryRecordErstellen(record, index + 1, records.length));
    });
    document.body.prepend(summary);
    document.body.classList.add('print-summary-active');
}

function printSummaryEntfernen() {
    const summary = document.getElementById('printSummary');
    if (summary) {
        objektUrlFreigeben(summary);
        summary.remove();
    }
    document.body.classList.remove('print-summary-active');
}

async function warteAufDruckbilder(root, timeoutMs = PRINT_BILD_TIMEOUT_MS) {
    const bilder = Array.from(root?.querySelectorAll('img') || []);
    const laden = bilder.map(img => {
        if (img.complete) return Promise.resolve(img.naturalWidth > 0);
        return new Promise(resolve => {
            img.addEventListener('load', () => resolve(true), { once: true });
            img.addEventListener('error', () => resolve(false), { once: true });
        });
    });
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([Promise.all(laden), timeout]);
    if (result === null) throw new Error(`Bilder wurden nicht innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden geladen`);
    const fehler = result.filter(ok => !ok).length;
    if (fehler) throw new Error(`${fehler} Bild${fehler !== 1 ? 'er' : ''} konnte${fehler === 1 ? '' : 'n'} nicht geladen werden`);
}

async function printpdf() {
    const liveData = Schacht.sammeln();
    const prueffehler = Schacht.validieren(liveData);
    Schacht.validierungsfehlerAnzeigen(prueffehler);
    if (prueffehler.length && !await bestaetigen(`${prueffehler.length} Prüfhinweis${prueffehler.length !== 1 ? 'e' : ''} vorhanden. PDF trotzdem erstellen?`)) return;
    document.querySelectorAll('select').forEach(sel => sel.classList.toggle('wert-gewaehlt', sel.value !== ''));
    const dateInputs = document.querySelectorAll('input[type="date"]');
    dateInputs.forEach(el => {
        const iso = el.value;
        el.type = 'text';
        el.value = iso ? iso.split('-').reverse().join('.') : '';
    });
    const gemeinde = document.getElementById('gemeinde')?.value;
    const nummer   = document.getElementById('nummer')?.value;
    const parts = ['Schachtprotokoll', gemeinde, nummer].filter(Boolean);
    const titleEl = document.querySelector('title');
    const alterTitel = titleEl?.textContent || 'Schachtprotokoll';
    printSummaryErstellen(liveData);
    try {
        await warteAufDruckbilder(document.getElementById('printSummary'));
    } catch (e) {
        printSummaryEntfernen();
        dateInputs.forEach(el => {
            const datumTeile = el.value.split('.');
            el.type = 'date';
            el.value = datumTeile.length === 3 ? `${datumTeile[2]}-${datumTeile[1]}-${datumTeile[0]}` : '';
        });
        App.toast('PDF-Export abgebrochen: ' + e.message, 'fehler');
        return;
    }
    let bereinigt = false;
    const cleanup = () => {
        if (bereinigt) return;
        bereinigt = true;
        printSummaryEntfernen();
        if (titleEl) titleEl.textContent = alterTitel;
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    App.toast('Tipp: In Chrome → Mehr Einstellungen → «Kopf- und Fusszeilen» deaktivieren', 'info');
    if (titleEl) titleEl.textContent = parts.join('_');
    window.print();
    dateInputs.forEach(el => {
        const datumTeile = el.value.split('.');
        el.type = 'date';
        el.value = datumTeile.length === 3 ? `${datumTeile[2]}-${datumTeile[1]}-${datumTeile[0]}` : '';
    });
    setTimeout(cleanup, PRINT_CLEANUP_TIMEOUT_MS);
}

async function exportRecordsAufloesen(records) {
    const exportRecords = records ?? await schachtExportRecordsErmitteln();
    return exportRecords?.length ? [...exportRecords] : null;
}

async function exportRecordsVorbereiten(records) {
    if (App.state.dirty && !App.state.storageAvailable) {
        await aktuellenEntwurfSichern();
        return null;
    }
    if (!await App.aenderungenSpeichern()) return null;
    return exportRecordsAufloesen(records);
}

async function exportAllePDF(records = null) {
    try {
        if (!await App.aenderungenSpeichern()) return;

        const alle = await exportRecordsAufloesen(records);
        if (!alle) return;

        const fotoAnzahl = alle.reduce((summe, record) => summe + (record.fotos || []).length, 0);
        if (fotoAnzahl > PRINT_FOTO_WARNSCHWELLE && !await bestaetigen(`${fotoAnzahl} Fotos können ein sehr grosses PDF erzeugen. Fortfahren?`)) return;

        alle.sort((a, b) => (b.geaendert_am || '').localeCompare(a.geaendert_am || ''));
        const titleEl = document.querySelector('title');
        const alterTitel = titleEl?.textContent || 'Schachtprotokoll';
        printSummaryAlleErstellen(alle);
        await warteAufDruckbilder(document.getElementById('printSummary'), PRINT_BILD_TIMEOUT_MS_SAMMEL);

        let bereinigt = false;
        const cleanup = () => {
            if (bereinigt) return;
            bereinigt = true;
            printSummaryEntfernen();
            if (titleEl) titleEl.textContent = alterTitel;
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        App.toast(`${alle.length} Schacht${alle.length !== 1 ? 'e' : ''} werden für den PDF-Druck vorbereitet.`, 'info');
        if (titleEl) titleEl.textContent = `Schachtprotokolle_alle_${dateiDatum()}`;
        window.print();
        setTimeout(cleanup, PRINT_CLEANUP_TIMEOUT_MS);
    } catch (e) {
        printSummaryEntfernen();
        App.toast('PDF-Export fehlgeschlagen: ' + e.message, 'fehler');
    }
}

function downloadFile(inhalt, mimeType, dateiname) {
    const blob = new Blob([inhalt], { type: mimeType });
    downloadBlob(blob, dateiname);
}

function downloadBlob(blob, dateiname) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = dateiname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateiDatum() {
    return new Date().toLocaleDateString('de-CH').replace(/\./g, '-');
}

function dateinameSicher(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, EXPORT_DATEINAME_MAX_ZEICHEN) || 'ohne_angabe';
}

function mediumMime(medium) {
    if (istBlob(medium)) return medium.type || 'application/octet-stream';
    if (istDataUrl(medium)) return dataUrlMime(medium);
    return 'application/octet-stream';
}

function mediumEndung(medium) {
    const mime = mediumMime(medium);
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    return 'jpg';
}

async function mediumAlsZipBytes(medium) {
    if (medium && typeof medium.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await medium.arrayBuffer());
        if (bytes.byteLength) return bytes;
    }

    if (istDataUrl(medium)) {
        const bytes = window.SchachtZip.dataUrlToBytes(medium);
        if (bytes.byteLength) return bytes;
    }

    throw new Error('Bild enthält keine lesbaren Binärdaten');
}

async function mediumAlsZipBytesOderNull(medium, kontext = 'Medium') {
    try {
        if (istBlob(medium)) return medium.size > 0 ? medium : null;
        const bytes = await mediumAlsZipBytes(medium);
        return bytes?.byteLength ? bytes : null;
    } catch (error) {
        console.warn(`[Export] ${kontext} übersprungen:`, error);
        return null;
    }
}

function bildAusDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        if (!hatWert(dataUrl)) { resolve(null); return; }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
        img.src = dataUrl;
    });
}

function skizzeDefaultCanvas(width, height, gitter = false) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'gray';
    ctx.setLineDash([3, 4]);
    if (gitter) {
        const masche = canvas.height / 10;
        for (let i = masche; i < canvas.height; i += masche) {
            ctx.beginPath();
            ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height);
            ctx.moveTo(0, i); ctx.lineTo(canvas.width, i);
            ctx.stroke();
        }
    } else {
        ctx.beginPath();
        ctx.fillStyle = 'rgb(230,230,230)';
        ctx.arc(cx, cy, 50, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx, 30); ctx.lineTo(cx, canvas.height);
        ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy);
        ctx.stroke();
        ctx.fillStyle = 'black';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('A u s l a u f', cx, 18);
    }
    return canvas;
}

function canvasPixelgleich(a, b) {
    if (a.width !== b.width || a.height !== b.height) return false;
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    for (let i = 0; i < da.length; i++) {
        if (da[i] !== db[i]) return false;
    }
    return true;
}

async function skizzeDataUrlGenutzt(dataUrl) {
    if (!hatWert(dataUrl)) return false;
    try {
        const img = await bildAusDataUrl(dataUrl);
        if (!img) return false;
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        return !canvasPixelgleich(canvas, skizzeDefaultCanvas(width, height, false)) &&
               !canvasPixelgleich(canvas, skizzeDefaultCanvas(width, height, true));
    } catch (e) {
        console.warn('[Export] Skizze konnte nicht geprüft werden:', e);
        return true;
    }
}

async function recordHatSkizze(record) {
    if (!hatWert(record?.skizze)) return false;
    if (typeof record.skizze_genutzt === 'boolean') return record.skizze_genutzt;
    return skizzeDataUrlGenutzt(record.skizze);
}

function schachtOrdner(record, index) {
    const bezeichnung = [index + 1, record.gemeinde, record.strasse, record.nummer || record.id || 'ohne_nummer']
        .filter(hatWert)
        .join('_');
    return `schacht_${dateinameSicher(bezeichnung)}`;
}

function medienBytesGesamt(records, faktor = 1) {
    return records.reduce((summe, record) => {
        const fotoBytes = (record.fotos || []).reduce((teil, foto) => teil + (istBlob(foto) ? foto.size : Math.ceil(String(foto || '').length * 0.75)), 0);
        const skizzenBytes = hatWert(record.skizze) ? Math.ceil(String(record.skizze || '').length * 0.75) : 0;
        return summe + Math.ceil((fotoBytes + skizzenBytes) * faktor);
    }, 0);
}

function medienGroesenlimitPruefen(records, faktor = 1) {
    const medienBytes = medienBytesGesamt(records, faktor);
    if (medienBytes > EXPORT_MAX_MEDIEN_BYTES) {
        throw new Error(`Medienumfang ${Math.round(medienBytes / 1024 / 1024)} MB überschreitet die Grenze von ${Math.round(EXPORT_MAX_MEDIEN_BYTES / 1024 / 1024)} MB`);
    }
}

async function zipMedienDateienHinzufuegen(zip, record, ordner, manifest) {
    const prefix = `${ordner}/bilder`;
    const fotos = (record.fotos || []).filter(Boolean);
    let exportierteDateien = 0;

    for (let fotoIndex = 0; fotoIndex < fotos.length; fotoIndex++) {
        const foto = fotos[fotoIndex];
        const dateiname = `${prefix}/foto_${fotoIndex + 1}.${mediumEndung(foto)}`;
        const bytes = await mediumAlsZipBytesOderNull(foto, dateiname);
        if (!bytes) continue;
        zip.file(dateiname, bytes);
        manifest.push({ pfad: dateiname, typ: 'foto', schacht_id: record.id ?? null, index: fotoIndex + 1 });
        exportierteDateien++;
    }

    if (await recordHatSkizze(record)) {
        const dateiname = `${prefix}/skizze.png`;
        const bytes = await mediumAlsZipBytesOderNull(record.skizze, dateiname);
        if (bytes) {
            zip.file(dateiname, bytes);
            manifest.push({ pfad: dateiname, typ: 'skizze', schacht_id: record.id ?? null });
            exportierteDateien++;
        }
    }

    return exportierteDateien;
}

async function exportAlleJSON(records = null) {
    try {
        const alle = await exportRecordsVorbereiten(records);
        if (!alle) return;
        medienGroesenlimitPruefen(alle, 1.4);
        const payload = await jsonPayloadErstellen(alle);
        downloadFile(JSON.stringify(payload, null, 2), 'application/json', `schachtprotokoll_alle_${dateiDatum()}.json`);
        backupZeitMerken('vollstaendig');
        App.toast(`${alle.length} Schacht${alle.length !== 1 ? 'e' : ''} als JSON exportiert.`, 'success');
    } catch (e) {
        App.setStatus('JSON-Export fehlgeschlagen');
        App.toast('JSON-Export fehlgeschlagen: ' + e.message, 'fehler');
    }
}

async function exportRohdaten(records = null) {
    try {
        const alle = await exportRecordsVorbereiten(records);
        if (!alle) return;
        if (!window.SchachtZip?.ZipWriter) throw new Error('ZIP-Writer nicht geladen');
        medienGroesenlimitPruefen(alle);

        const zip = new window.SchachtZip.ZipWriter();
        const manifest = [];

        for (let i = 0; i < alle.length; i++) {
            const schacht = alle[i];
            const ordner = schachtOrdner(schacht, i);
            const jsonPfad = `${ordner}/schacht.json`;
            const jsonPayload = await jsonPayloadErstellen([schacht], { medien: false });
            zip.file(jsonPfad, JSON.stringify(jsonPayload, null, 2));
            await zipMedienDateienHinzufuegen(zip, schacht, ordner, manifest);
        }
        zip.file('manifest.json', JSON.stringify({ erstellt_am: new Date().toISOString(), dateien: manifest }, null, 2));

        const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
        downloadBlob(blob, `schachtprotokoll_rohdaten_${dateiDatum()}.zip`);
        App.toast(`${alle.length} Schacht${alle.length !== 1 ? 'e' : ''} als Rohdatenarchiv mit JSON und Originalbildern exportiert.`, 'success');
    } catch (e) {
        App.setStatus('Rohdatenexport fehlgeschlagen');
        App.toast('Rohdatenexport fehlgeschlagen: ' + e.message, 'fehler');
    }
}


async function importJSON(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        if (!await App.aenderungenSpeichern()) return;
        if (file.size > IMPORT_MAX_DATEIGROESSE) throw new Error(`Datei ist grösser als ${Math.round(IMPORT_MAX_DATEIGROESSE / 1024 / 1024)} MB`);
        if (file.size > IMPORT_GROSS_WARNUNG && !await bestaetigen(`Die JSON-Datei ist ${Math.round(file.size / 1024 / 1024)} MB gross und benötigt viel Arbeitsspeicher. Fortfahren?`)) return;
        const text = await file.text();
        const daten = JSON.parse(text);
        if (daten?.schema_version && (!Number.isInteger(Number(daten.schema_version)) || Number(daten.schema_version) < 1)) {
            throw new Error('Ungültige Schema-Version');
        }
        if (daten?.schema_version && Number(daten.schema_version) > EXPORT_SCHEMA_VERSION) {
            throw new Error(`Schema-Version ${daten.schema_version} wird nicht unterstützt`);
        }
        const records = jsonImportRecords(daten);
        const bezeichnung = records.length === 1 ? '1 Datensatz' : `${records.length} Datensätze`;
        const schluessel = records.map(datensatzSchluessel).filter(Boolean);
        if (new Set(schluessel).size !== schluessel.length) throw new Error('Import enthält doppelte Schachtbezeichnungen mit gleichem Aufnahmedatum');
        const bestehend = await DB.alle();
        const bestehendNachSchluessel = new Map(bestehend.map(record => [datensatzSchluessel(record), record]).filter(([key]) => key));
        const konflikte = records.map(record => bestehendNachSchluessel.get(datensatzSchluessel(record)) || null);
        const konfliktAnzahl = konflikte.filter(Boolean).length;
        let ziele = [];
        if (konfliktAnzahl > 0) {
            if (await bestaetigen(`${konfliktAnzahl} bestehende Schächte stimmen in Gemeinde, Strasse, Nummer und Datum überein. Bestehende Datensätze ersetzen?`)) {
                ziele = konflikte;
            } else if (!await bestaetigen(`${bezeichnung} stattdessen als neue Kopien importieren?`)) {
                return;
            }
        } else if (!await bestaetigen(`${bezeichnung} importieren?`)) {
            return;
        }
        const result = await importRecordsSpeichern(records, ziele);
        const aktualisiert = result.aktualisiert ? `, ${result.aktualisiert} aktualisiert` : '';
        App.toast(`${result.importiert} Schacht${result.importiert !== 1 ? 'e' : ''} importiert${aktualisiert}.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.setStatus('JSON-Import fehlgeschlagen');
        App.toast('Import fehlgeschlagen: ' + e.message, 'fehler');
    }
}

async function alleSchachteLöschen() {
    if (!await App.aenderungenSpeichern()) return;
    if (!await bestaetigen('Vor dem Löschen vollständiges JSON-Backup erstellen?')) return;
    try {
        const alle = await DB.alle();
        if (!alle.length) { App.toast('Keine gespeicherten Schächte vorhanden.', 'warn'); return; }
        const payload = await jsonPayloadErstellen(alle);
        downloadFile(JSON.stringify(payload, null, 2), 'application/json', `schachtprotokoll_backup_vor_loeschen_${dateiDatum()}.json`);
        backupZeitMerken('vollstaendig');
        if (!await bestaetigen('Backup wurde heruntergeladen. Alle Schächte jetzt unwiderruflich löschen?')) return;
        await DB.alleLoeschen();
        App.datensatzWechseln();
        Schacht.zuruecksetzen();
        App.setStatus('Datenbank geleert');
        App.toast(`${alle.length} Schacht${alle.length !== 1 ? 'e' : ''} gelöscht.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.toast('Löschen fehlgeschlagen: ' + e.message, 'fehler');
    }
}


function updateAuftrag() {
    ['gemeinde', 'strasse'].forEach(id => {
        const v = localStorage.getItem(id);
        if (v) document.getElementById(id).value = v;
    });
}

function geoLocalisation() {
    const el = document.getElementById('karte');
    if (!el) return;
    const e = document.getElementById('koordinaten_e')?.value.trim();
    const n = document.getElementById('koordinaten_n')?.value.trim();
    if (e && n) {
        koordinatenAktualisieren();
    } else {
        el.href = 'https://map.geo.admin.ch/';
    }
}

function koordinatenAktualisieren() {
    const e = document.getElementById('koordinaten_e')?.value.replace(/['\s]/g, '');
    const n = document.getElementById('koordinaten_n')?.value.replace(/['\s]/g, '');
    const el = document.getElementById('karte');
    if (!el) return;
    const eZahl = Number(e);
    const nZahl = Number(n);
    const gueltig = Number.isFinite(eZahl) && Number.isFinite(nZahl) &&
        eZahl >= 2000000 && eZahl <= 3000000 && nZahl >= 1000000 && nZahl <= 1400000;
    if (gueltig) {
        el.href = `https://map.geo.admin.ch/?E=${encodeURIComponent(e)}&N=${encodeURIComponent(n)}&zoom=10`;
        el.removeAttribute('aria-disabled');
        el.title = 'Koordinaten auf map.geo.admin.ch öffnen';
    } else {
        el.href = 'https://map.geo.admin.ch/';
        el.setAttribute('aria-disabled', 'true');
        el.title = e || n ? 'LV95-Koordinaten sind unvollständig oder ungültig' : 'LV95-Koordinaten erfassen';
    }
}


function fotoFitAktualisieren() {
    UIFeedback.medienAktualisieren();
}

function bildElementAusDatei(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Bild konnte nicht gelesen werden'));
        };
        img.src = url;
    });
}

async function fotoDateiKomprimieren(file) {
    if (file.size > FOTO_MAX_DATEIGROESSE) throw new Error('Foto ist zu gross');
    const img = await bildElementAusDatei(file);
    if (img.naturalWidth * img.naturalHeight > FOTO_MAX_PIXEL) throw new Error('Foto hat zu viele Bildpunkte');
    const ratio = Math.min(1, FOTO_MAX_KANTE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * ratio));
    const height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob !== 'function') {
            const fallback = dataUrlZuBlob(canvas.toDataURL('image/jpeg', FOTO_JPEG_QUALITAET));
            fallback ? resolve(fallback) : reject(new Error('Foto konnte nicht komprimiert werden'));
            return;
        }
        canvas.toBlob(blob => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error('Foto konnte nicht komprimiert werden'));
            }
        }, 'image/jpeg', FOTO_JPEG_QUALITAET);
    });
}

function objektUrlFreigeben(root) {
    root?.querySelectorAll?.('img[data-object-url]').forEach(img => {
        URL.revokeObjectURL(img.dataset.objectUrl);
        delete img.dataset.objectUrl;
    });
}

function fotosLeeren() {
    const container = document.getElementById('fotos');
    if (!container) return;
    objektUrlFreigeben(container);
    container.innerHTML = '';
}

function fotosAusFormular() {
    return Array.from(document.querySelectorAll('#fotos .foto-wrapper img'))
        .map(img => img._fotoBlob || null)
        .filter(Boolean);
}

function fotoHinzufuegen(foto) {
    const blob = fotoNormalisieren(foto);
    if (!blob) return;
    const container = document.getElementById('fotos');
    const wrapper = document.createElement('div');
    wrapper.className = 'foto-wrapper';
    const img = document.createElement('img');
    const objectUrl = URL.createObjectURL(blob);
    img.src = objectUrl;
    img.dataset.objectUrl = objectUrl;
    img._fotoBlob = blob;
    img.alt = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'foto-loeschen';
    btn.textContent = '✕';
    btn.title = 'Foto entfernen';
    btn.addEventListener('click', async () => {
        if (!await bestaetigen('Foto löschen?')) return;
        objektUrlFreigeben(wrapper);
        wrapper.remove();
        fotoFitAktualisieren();
        App.triggerAutoSave();
    });
    wrapper.append(img, btn);
    container.appendChild(wrapper);
    fotoFitAktualisieren();
}

async function bildAuswahl() {
    const input = document.getElementById('input');
    const files = Array.from(input?.files || []);
    if (!files.length) return;
    input.value = '';
    const vorhandeneFotos = document.querySelectorAll('#fotos .foto-wrapper').length;
    const freiePlaetze = Math.max(0, FOTO_MAX_ANZAHL - vorhandeneFotos);
    if (freiePlaetze === 0) {
        App.toast(`Maximal ${FOTO_MAX_ANZAHL} Fotos pro Schacht.`, 'warn');
        return;
    }
    const bildDateien = files.filter(file => /^image\/(jpeg|png|webp)$/i.test(file.type)).slice(0, freiePlaetze);
    if (!bildDateien.length) { App.toast('Datei nicht unterstützt', 'fehler'); return; }
    let hinzugefuegt = 0;
    let fehler = files.length - bildDateien.length;
    const fehlerDetails = [];
    for (const file of bildDateien) {
        try {
            const blob = await fotoDateiKomprimieren(file);
            fotoHinzufuegen(blob);
            hinzugefuegt++;
        } catch (e) {
            fehler++;
            fehlerDetails.push(`${file.name}: ${e.message}`);
            console.warn('[Fotos] Foto konnte nicht verarbeitet werden:', e);
        }
    }
    if (hinzugefuegt > 0) {
        App.triggerAutoSave();
        speicherplatzPruefen();
    }
    if (fehler > 0) {
        const detail = fehlerDetails[0] ? ` (${fehlerDetails[0]})` : '';
        App.toast(`${fehler} Datei${fehler !== 1 ? 'en' : ''} nicht verarbeitet${detail}`, hinzugefuegt > 0 ? 'warn' : 'fehler');
    }
}

// Leitungs-Dialog
let _ltgEditRow = null;

function neueLeitung() {
    _ltgEditRow = null;
    UIFeedback.leitungsDialogTitelSetzen(false);
    Schacht.DIALOG_FELDER.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.tagName === 'SELECT' ? (el.selectedIndex = 0) : (el.value = '');
        if (el.tagName === 'SELECT') el.classList.toggle('wert-gewaehlt', el.value !== '');
    });
    document.querySelectorAll('#ltgDialog .fehler').forEach(el => el.classList.remove('fehler'));
    dialogOeffnen('ltgDialog');
}

function bearbeitenLeitung(row) {
    const ltg = JSON.parse(row.dataset.ltg || '{}');
    _ltgEditRow = row;
    UIFeedback.leitungsDialogTitelSetzen(true);
    const fill = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val || '';
        if (el.tagName === 'SELECT') {
            if (!el.value) el.selectedIndex = 0;
            el.classList.toggle('wert-gewaehlt', el.value !== '');
        }
    };
    fill('ltg_richtung',    ltg.ltg_richtung);
    fill('tiefe',           ltg.tiefe);
    fill('ltg_profil',      ltg.ltg_profil);
    fill('rmat',            ltg.rmat);
    fill('rdm',             ltg.rdm);
    fill('ltg_funktion',    ltg.ltg_funktion);
    fill('ltg_art',         ltg.ltg_art);
    fill('ltg_betrieb',     ltg.ltg_betrieb);
    fill('ltg_hydraulik',   ltg.ltg_hydraulik);
    fill('lnotiz',          ltg.lnotiz);
    document.querySelectorAll('#ltgDialog .fehler').forEach(el => el.classList.remove('fehler'));
    dialogOeffnen('ltgDialog');
}

function speichernLeitung() {
    const felder = Schacht.PFLICHTFELDER.map(id => document.getElementById(id));
    let fehler = false;
    felder.forEach(feld => {
        if (!feld || !feld.value.trim()) { if (feld) feld.classList.add('fehler'); fehler = true; }
    });
    if (fehler) return;

    const ltgDaten = {
        ltg_richtung:    document.getElementById('ltg_richtung').value,
        tiefe:           document.getElementById('tiefe').value,
        ltg_profil:      document.getElementById('ltg_profil').value,
        rmat:            document.getElementById('rmat').value,
        rdm:             document.getElementById('rdm').value,
        ltg_funktion:    document.getElementById('ltg_funktion').value,
        ltg_art:         document.getElementById('ltg_art').value,
        ltg_betrieb:     document.getElementById('ltg_betrieb').value,
        ltg_hydraulik:   document.getElementById('ltg_hydraulik').value,
        lnotiz:          document.getElementById('lnotiz').value
    };

    const hatInhalt = Object.entries(ltgDaten)
        .some(([key, value]) => key !== 'ltg_richtung' && hatWert(value));
    if (!hatInhalt) {
        App.toast('Leere Leitung nicht gespeichert.', 'warn');
        return;
    }

    if (_ltgEditRow) {
        const existing = JSON.parse(_ltgEditRow.dataset.ltg || '{}');
        const updated = { ...existing, ...ltgDaten };
        _ltgEditRow.dataset.ltg = JSON.stringify(updated);
        const zeilen = [
            existing.nr,
            updated.ltg_richtung, updated.tiefe, updated.ltg_profil,
            updated.rmat, updated.rdm, updated.ltg_funktion, updated.ltg_art,
            updated.ltg_betrieb, updated.ltg_hydraulik,
            updated.lnotiz
        ];
        Array.from(_ltgEditRow.cells).slice(0, zeilen.length).forEach((cell, i) => { cell.textContent = zeilen[i]; });
        _ltgEditRow = null;
    } else {
        Schacht._insertLeitungRow(ltgDaten);
    }
    dialogSchliessen('ltgDialog');
    UIFeedback.leitungenAktualisieren();
    App.triggerAutoSave();
}

Schacht.PFLICHTFELDER.forEach(id => {
    document.getElementById(id).addEventListener('input', function () { this.classList.remove('fehler'); });
    document.getElementById(id).addEventListener('change', function () { this.classList.remove('fehler'); });
});

function aktionAusfuehren(action, element) {
    switch (action) {
        case 'neuer-schacht': return neuerSchacht();
        case 'schachtliste-oeffnen': return schachtListeOeffnen();
        case 'schachtliste-schliessen': return schachtListeSchliessen();
        case 'print-pdf': return printpdf();
        case 'neue-leitung': return neueLeitung();
        case 'speichern-leitung': return speichernLeitung();
        case 'close-dialog': return dialogSchliessen('ltgDialog');
        case 'undo': return Sketch.undo();
        case 'export-json': return exportAlleJSON();
        case 'export-rohdaten': return exportRohdaten();
        case 'export-alle-pdf': return exportAllePDF();
        case 'import-json': return document.getElementById('importDateiJSON')?.click();
        case 'alle-schachte-loeschen': return alleSchachteLöschen();
        default:
            console.warn('[UI] Unbekannte Aktion:', action, element);
    }
}

function zentraleKlickDelegation(aktionSicherAusfuehren) {
    document.addEventListener('click', event => {
        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        event.preventDefault();
        aktionSicherAusfuehren(actionEl.dataset.action, actionEl);
    });
}

function schachtListeFokusFalle(event, panel) {
    const fokusElemente = Array.from(panel.querySelectorAll('button, input, select, textarea, [tabindex="0"]'))
        .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
    if (!fokusElemente.length) return;
    const erstes = fokusElemente[0];
    const letztes = fokusElemente[fokusElemente.length - 1];
    if (event.shiftKey && document.activeElement === erstes) {
        event.preventDefault();
        letztes.focus();
    } else if (!event.shiftKey && document.activeElement === letztes) {
        event.preventDefault();
        erstes.focus();
    }
}

function zentraleKeydownDelegation(aktionSicherAusfuehren) {
    document.addEventListener('keydown', event => {
        const panel = document.getElementById('schachtListe');
        if (event.key === 'Escape' && panel?.classList.contains('offen')) {
            event.preventDefault();
            schachtListeSchliessen();
            return;
        }
        if (event.key === 'Tab' && panel?.classList.contains('offen')) {
            schachtListeFokusFalle(event, panel);
        }
        if (!['Enter', ' '].includes(event.key)) return;
        const actionEl = event.target.closest('[data-action], [data-stift]');
        if (!actionEl) return;
        event.preventDefault();
        if (actionEl.dataset.stift !== undefined) {
            Sketch.farbwahl(actionEl);
        } else {
            aktionSicherAusfuehren(actionEl.dataset.action, actionEl);
        }
    });
}

function stiftKlickDelegation() {
    document.querySelectorAll('[data-stift]').forEach(el => {
        el.addEventListener('click', () => Sketch.farbwahl(el));
    });
}

function einzelfeldEventListenerRegistrieren() {
    document.getElementById('input')?.addEventListener('change', bildAuswahl);
    document.getElementById('importDateiJSON')?.addEventListener('change', event => importJSON(event.target));
    document.getElementById('koordinaten_e')?.addEventListener('input', koordinatenAktualisieren);
    document.getElementById('koordinaten_n')?.addEventListener('input', koordinatenAktualisieren);
    document.getElementById('schachtSuche')?.addEventListener('input', schachtListeFiltern);
    document.getElementById('schachtAlleSichtbar')?.addEventListener('change', event => schachtAlleSichtbarenAuswaehlen(event.target.checked));
    document.getElementById('schachtAuswahlLoeschen')?.addEventListener('click', schachtAuswahlLoeschen);
    document.getElementById('speichernWiederholen')?.addEventListener('click', () => App.aenderungenSpeichern());
    document.getElementById('entwurfSichern')?.addEventListener('click', () => {
        aktuellenEntwurfSichern().catch(() => undefined);
    });
}

function zentraleEventListenerInitialisieren() {
    const aktionSicherAusfuehren = (action, element) => {
        Promise.resolve(aktionAusfuehren(action, element)).catch(error => {
            console.error(`[UI] Aktion «${action}» fehlgeschlagen:`, error);
            App.toast(`Aktion fehlgeschlagen: ${error.message || 'Unbekannter Fehler'}`, 'fehler');
        });
    };
    zentraleKlickDelegation(aktionSicherAusfuehren);
    zentraleKeydownDelegation(aktionSicherAusfuehren);
    stiftKlickDelegation();
    einzelfeldEventListenerRegistrieren();
}

// ============================================================
// Schächte-Liste und Exportauswahl
// ============================================================
const schachtAuswahl = new Set();
const schachtSeitenleisteMedia = window.matchMedia('(min-width: 960px)');
let schachtListeRenderToken = 0;

function schachtIdKey(id) {
    return String(id);
}

async function aktuellenLeerenEntwurfEntfernen() {
    const id = App.state.currentSchachtId;
    if (!id || !App.state.storageAvailable || App.state.dirty) return false;

    try {
        const schacht = await DB.laden(id);
        if (!recordIstEntwurf(schacht)) return false;
        await DB.loeschen(id);
        schachtAuswahl.delete(schachtIdKey(id));
        App.datensatzWechseln();
        return true;
    } catch (error) {
        console.warn('Leeren Entwurf nicht entfernt:', error);
        return false;
    }
}

async function leereEntwuerfeBereinigen() {
    if (!App.state.storageAvailable) return;

    try {
        const leereEntwuerfe = (await DB.alle()).filter(recordIstEntwurf);
        if (!leereEntwuerfe.length) return;
        await Promise.all(leereEntwuerfe.map(schacht => DB.loeschen(schacht.id)));
        leereEntwuerfe.forEach(schacht => schachtAuswahl.delete(schachtIdKey(schacht.id)));
    } catch (error) {
        console.warn('Leere Entwürfe nicht bereinigt:', error);
    }
}

function schachtSeitenleisteAktiv() {
    return schachtSeitenleisteMedia.matches;
}

function schachtSuchtext() {
    return document.getElementById('schachtSuche')?.value.trim().toLocaleLowerCase('de-CH') || '';
}

function schachtTypText(schacht) {
    return schacht.schacht_typ || schacht.typ || ((!schacht.gemeinde || !schacht.nummer || !schacht.aufnahmedatum) ? 'Entwurf' : '');
}

function schachtSuchtextFuer(schacht) {
    return [
        schacht.aufnahmedatum,
        schacht.datum,
        schacht.gemeinde,
        schacht.strasse,
        schacht.nummer,
        schachtTypText(schacht)
    ].filter(Boolean).join(' ').toLocaleLowerCase('de-CH');
}

function schachtPasstZumFilter(schacht, suchtext = schachtSuchtext()) {
    return !suchtext || schachtSuchtextFuer(schacht).includes(suchtext);
}

function schachtSichtbareZeilen() {
    return Array.from(document.querySelectorAll('#schachtListeTabelle tbody tr[data-schacht-id]:not([hidden])'));
}

function schachtAuswahlStatusAktualisieren() {
    const alleZeilen = Array.from(document.querySelectorAll('#schachtListeTabelle tbody tr[data-schacht-id]'));
    alleZeilen.forEach(zeile => {
        const ausgewaehlt = schachtAuswahl.has(zeile.dataset.schachtId);
        zeile.classList.toggle('schacht-liste-ausgewaehlt', ausgewaehlt);
        const checkbox = zeile.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = ausgewaehlt;
    });
    const sichtbareZeilen = alleZeilen.filter(zeile => !zeile.hidden);
    const sichtbareAuswahl = sichtbareZeilen.filter(zeile => schachtAuswahl.has(zeile.dataset.schachtId)).length;
    const alleSichtbar = document.getElementById('schachtAlleSichtbar');
    if (alleSichtbar) {
        alleSichtbar.checked = sichtbareZeilen.length > 0 && sichtbareAuswahl === sichtbareZeilen.length;
        alleSichtbar.indeterminate = sichtbareAuswahl > 0 && sichtbareAuswahl < sichtbareZeilen.length;
        alleSichtbar.disabled = sichtbareZeilen.length === 0;
    }
    const anzahl = document.getElementById('schachtAuswahlAnzahl');
    if (anzahl) anzahl.textContent = `${schachtAuswahl.size} ausgewählt`;
    const leeren = document.getElementById('schachtAuswahlLoeschen');
    if (leeren) leeren.hidden = schachtAuswahl.size === 0;
    const exportLabel = document.getElementById('exportModusLabel');
    if (exportLabel) {
        exportLabel.textContent = schachtAuswahl.size
            ? `Export der Auswahl (${schachtAuswahl.size})`
            : 'Export des Filters';
    }
}

function schachtAuswahlAendern(id, ausgewaehlt) {
    const key = schachtIdKey(id);
    if (ausgewaehlt) schachtAuswahl.add(key);
    else schachtAuswahl.delete(key);
    schachtAuswahlStatusAktualisieren();
}

function schachtAlleSichtbarenAuswaehlen(ausgewaehlt) {
    schachtSichtbareZeilen().forEach(zeile => {
        const key = zeile.dataset.schachtId;
        if (ausgewaehlt) schachtAuswahl.add(key);
        else schachtAuswahl.delete(key);
        const checkbox = zeile.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = ausgewaehlt;
    });
    schachtAuswahlStatusAktualisieren();
}

function schachtAuswahlLoeschen() {
    schachtAuswahl.clear();
    schachtAuswahlStatusAktualisieren();
}

function schachtAuswahlBereinigen(alle) {
    const vorhandeneIds = new Set(alle.map(schacht => schachtIdKey(schacht.id)));
    schachtAuswahl.forEach(id => {
        if (!vorhandeneIds.has(id)) schachtAuswahl.delete(id);
    });
}

async function schachtExportRecordsErmitteln() {
    const alle = await DB.alle();
    schachtAuswahlBereinigen(alle);

    const ausgewaehlte = alle.filter(schacht => schachtAuswahl.has(schachtIdKey(schacht.id)));
    const exportRecords = ausgewaehlte.length
        ? ausgewaehlte
        : alle.filter(schacht => schachtPasstZumFilter(schacht));

    schachtAuswahlStatusAktualisieren();
    if (!exportRecords.length) {
        App.toast(schachtSuchtext() ? 'Keine Schächte entsprechen dem Suchfilter.' : 'Keine gespeicherten Schächte vorhanden.', 'warn');
        return null;
    }
    return exportRecords;
}

function schachtListePanelElemente() {
    const panel = document.getElementById('schachtListe');
    const overlay = document.getElementById('panelOverlay');
    if (!panel || !overlay) return null;
    return { panel, overlay, oeffnen: document.querySelector('[data-action="schachtliste-oeffnen"]') };
}

function schachtListenAnsichtAktualisieren() {
    const elemente = schachtListePanelElemente();
    if (!elemente) return;
    const { panel, overlay, oeffnen } = elemente;
    if (schachtSeitenleisteAktiv()) {
        panel.classList.remove('offen');
        panel.removeAttribute('role');
        panel.removeAttribute('aria-modal');
        overlay.style.display = 'none';
        if (oeffnen) oeffnen.setAttribute('aria-expanded', 'true');
    } else {
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        if (oeffnen) oeffnen.setAttribute('aria-expanded', panel.classList.contains('offen') ? 'true' : 'false');
    }
}

function schachtListeOeffnen() {
    const elemente = schachtListePanelElemente();
    if (!elemente) return;
    const { panel, overlay, oeffnen } = elemente;
    if (!schachtSeitenleisteAktiv()) {
        panel._rueckkehrFokus = document.activeElement;
        panel.classList.add('offen');
        overlay.style.display = 'block';
    }
    if (oeffnen) oeffnen.setAttribute('aria-expanded', 'true');
    schachtListeAktualisieren();
    requestAnimationFrame(() => document.getElementById('schachtSuche')?.focus());
}

function schachtListeFiltern() {
    const suchtext = schachtSuchtext();
    const rows = Array.from(document.querySelectorAll('#schachtListeTabelle tbody tr[data-suchtext]'));
    let sichtbar = 0;
    rows.forEach(row => {
        const passt = !suchtext || row.dataset.suchtext.includes(suchtext);
        row.hidden = !passt;
        if (passt) sichtbar++;
    });
    const anzahl = document.getElementById('schachtAnzahl');
    if (anzahl) {
        anzahl.textContent = suchtext
            ? `${sichtbar} von ${rows.length}`
            : `${rows.length} ${rows.length === 1 ? 'Schacht' : 'Schächte'}`;
    }
    schachtAuswahlStatusAktualisieren();
}

function schachtListeSchliessen() {
    if (schachtSeitenleisteAktiv()) return;
    const elemente = schachtListePanelElemente();
    if (!elemente) return;
    const { panel, overlay, oeffnen } = elemente;
    panel.classList.remove('offen');
    overlay.style.display = 'none';
    if (oeffnen) oeffnen.setAttribute('aria-expanded', 'false');
    const rueckkehr = panel._rueckkehrFokus;
    delete panel._rueckkehrFokus;
    requestAnimationFrame(() => rueckkehr?.focus?.());
}

function schachtZeileAuswahlZelle(tr, schacht, bezeichnung, istAusgewaehlt) {
    const auswahlCell = tr.insertCell(-1);
    auswahlCell.className = 'schacht-auswahl-zelle';
    auswahlCell.dataset.label = 'Auswahl';
    const auswahlLabel = document.createElement('label');
    auswahlLabel.className = 'schacht-auswahl-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = istAusgewaehlt;
    checkbox.setAttribute('aria-label', `${bezeichnung} für Export auswählen`);
    checkbox.addEventListener('change', () => schachtAuswahlAendern(schacht.id, checkbox.checked));
    auswahlLabel.appendChild(checkbox);
    auswahlCell.appendChild(auswahlLabel);
}

function schachtZeileSchachtZelle(tr, schacht, bezeichnung, istAktuell) {
    const schachtCell = tr.insertCell(-1);
    schachtCell.dataset.label = 'Schacht';
    const titel = document.createElement('strong');
    titel.textContent = bezeichnung;
    const ort = [schacht.gemeinde, schacht.strasse].filter(Boolean).join(', ');
    schachtCell.appendChild(titel);
    if (istAktuell) {
        const aktuell = document.createElement('span');
        aktuell.className = 'schacht-aktuell-marker';
        aktuell.textContent = 'Aktuell';
        schachtCell.appendChild(aktuell);
    }
    if (ort) {
        const meta = document.createElement('small');
        meta.textContent = ort;
        schachtCell.appendChild(meta);
    }
}

function schachtZeileTypUndDatumZellen(tr, schacht, typText) {
    const typCell = tr.insertCell(-1);
    typCell.className = 'schacht-meta schacht-meta--typ';
    typCell.textContent = typText;
    typCell.dataset.label = 'Typ';
    typCell.classList.toggle('schacht-meta--leer', !typText);

    const datumCell = tr.insertCell(-1);
    const datumText = datumFuerAnzeige(schacht.aufnahmedatum) || schacht.datum || '';
    datumCell.className = 'schacht-meta schacht-meta--datum';
    datumCell.textContent = datumText;
    datumCell.dataset.label = 'Aufnahmedatum';
    datumCell.classList.toggle('schacht-meta--leer', !datumText);
    tr.classList.toggle('schacht-ohne-typ', !typText);
}

function schachtZeileAktionsZelle(tr, schacht) {
    const aktCell = tr.insertCell(-1);
    aktCell.className = 'schacht-aktionszelle';
    aktCell.dataset.label = 'Aktion';
    const btnLaden = document.createElement('button');
    btnLaden.type = 'button';
    btnLaden.className = 'btn-laden';
    btnLaden.textContent = 'Laden';
    btnLaden.addEventListener('click', () => schachtLaden(schacht.id));
    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-loeschen btn-schacht-loeschen';
    btnDel.textContent = 'Löschen';
    btnDel.title = 'Schacht löschen';
    btnDel.setAttribute('aria-label', 'Schacht löschen');
    btnDel.addEventListener('click', () => schachtLoeschenAusListe(schacht.id));
    aktCell.append(btnLaden, btnDel);
}

function schachtListenZeileErstellen(schacht) {
    const tr = document.createElement('tr');
    const typText = schachtTypText(schacht);
    const bezeichnung = schacht.nummer ? `Schacht ${schacht.nummer}` : 'Schacht ohne Nummer';
    const istAktuell = App.state.currentSchachtId === schacht.id;
    const istAusgewaehlt = schachtAuswahl.has(schachtIdKey(schacht.id));
    tr.dataset.schachtId = schachtIdKey(schacht.id);
    tr.dataset.suchtext = schachtSuchtextFuer(schacht);
    tr.dataset.geaendertAm = schacht.geaendert_am || '';
    tr.classList.toggle('schacht-liste-aktuell', istAktuell);
    tr.classList.toggle('schacht-liste-ausgewaehlt', istAusgewaehlt);

    schachtZeileAuswahlZelle(tr, schacht, bezeichnung, istAusgewaehlt);
    schachtZeileSchachtZelle(tr, schacht, bezeichnung, istAktuell);
    schachtZeileTypUndDatumZellen(tr, schacht, typText);
    schachtZeileAktionsZelle(tr, schacht);
    return tr;
}

async function schachtListeRecordAktualisieren(id) {
    const tbody = document.querySelector('#schachtListeTabelle tbody');
    if (!tbody || !id) return schachtListeAktualisieren();
    const renderToken = ++schachtListeRenderToken;
    try {
        const schacht = await DB.laden(id);
        if (renderToken !== schachtListeRenderToken) return;
        if (!schacht) {
            await schachtListeAktualisieren();
            return;
        }
        const key = schachtIdKey(id);
        const neueZeile = schachtListenZeileErstellen(schacht);
        const alteZeile = tbody.querySelector(`tr[data-schacht-id="${key}"]`);
        if (alteZeile) {
            alteZeile.remove();
        } else {
            tbody.querySelector('.liste-leer')?.closest('tr')?.remove();
        }
        // Frisch gespeicherter Datensatz hat den neuesten Zeitstempel - direkt oben einfuegen statt komplett neu zu sortieren
        tbody.insertBefore(neueZeile, tbody.firstChild);
        schachtListeFiltern();
    } catch (e) {
        console.error('[DB] Listenzeile Fehler:', e);
        schachtListeAktualisieren();
    }
}

async function schachtListeAktualisieren() {
    const tbody = document.querySelector('#schachtListeTabelle tbody');
    if (!tbody) return;
    const renderToken = ++schachtListeRenderToken;
    try {
        const alle = await DB.alle();
        if (renderToken !== schachtListeRenderToken) return;
        schachtAuswahlBereinigen(alle);
        if (alle.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="liste-leer">Keine gespeicherten Schächte</td></tr>';
            const anzahl = document.getElementById('schachtAnzahl');
            if (anzahl) anzahl.textContent = '0 Schächte';
            schachtAuswahlStatusAktualisieren();
            return;
        }
        alle.sort((a, b) => (b.geaendert_am || '').localeCompare(a.geaendert_am || ''));
        const fragment = document.createDocumentFragment();
        alle.forEach(schacht => {
            fragment.appendChild(schachtListenZeileErstellen(schacht));
        });
        if (renderToken !== schachtListeRenderToken) return;
        tbody.replaceChildren(fragment);
        schachtListeFiltern();
    } catch (e) {
        console.error('[DB] Liste Fehler:', e);
        App.toast('Fehler beim Laden der Liste: ' + e.message, 'fehler');
    }
}

async function schachtLaden(id) {
    if (!await App.aenderungenSpeichern()) return;
    if (App.state.currentSchachtId !== id) await aktuellenLeerenEntwurfEntfernen();
    App.datensatzWechseln();
    try {
        const data = await DB.laden(id);
        if (!data) { App.toast('Schacht nicht gefunden', 'fehler'); return; }
        App.setCurrentSchachtId(id);
        Schacht.laden(data);
        App.setStatus(`✓ Schacht #${id} geladen`);
        await schachtListeAktualisieren();
        if (!schachtSeitenleisteAktiv()) schachtListeSchliessen();
    } catch (e) {
        console.error('[DB] Laden Fehler:', e);
        App.toast('Fehler beim Laden: ' + e.message, 'fehler');
    }
}

async function schachtLoeschenAusListe(id) {
    if (!await App.aenderungenSpeichern()) return;
    if (!await bestaetigen('Schacht unwiderruflich löschen?')) return;
    const warAktuell = App.state.currentSchachtId === id;
    if (warAktuell) App.datensatzWechseln();
    try {
        await DB.loeschen(id);
        schachtAuswahl.delete(schachtIdKey(id));
        if (warAktuell) {
            Schacht.zuruecksetzen();
            App.setStatus('Schacht gelöscht');
        }
        await schachtListeAktualisieren();
        App.toast('Schacht gelöscht');
    } catch (e) {
        console.error('[DB] Löschen Fehler:', e);
        App.toast('Fehler beim Löschen: ' + e.message, 'fehler');
    }
}

// ============================================================
// Auto-Save bei Formularänderungen
// ============================================================
function formularAutosaveRegistrieren() {
    document.querySelectorAll('.hauptinhalt input[type="text"], .hauptinhalt input[type="date"], .hauptinhalt select, .hauptinhalt textarea').forEach(el => {
        const eventName = el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
        el.addEventListener(eventName, () => {
            App.triggerAutoSave();
            ErfassungsumfangUI.aktualisieren();
        });
    });
}

formularAutosaveRegistrieren();

document.querySelectorAll('#erfassungsumfang input[data-umfang]').forEach(el => {
    el.addEventListener('change', () => {
        Schacht.formularUmfangAnwenden();
        ErfassungsumfangUI.aktualisieren();
        App.triggerAutoSave();
    });
});

document.querySelectorAll('#zustandsbereich input[type="checkbox"][data-zustand-option]').forEach(el => {
    el.addEventListener('change', () => {
        Schacht.zustandsCheckboxGeaendert(el);
        App.triggerAutoSave();
    });
});

document.querySelectorAll('#zustandsbereich input[name="schadenstufe"]')
    .forEach(el => el.addEventListener('change', () => App.triggerAutoSave()));

document.getElementById('zustand')?.addEventListener('change', () => {
    Schacht.gesamtzustandGeaendert();
    App.triggerAutoSave();
});

// ============================================================
// Initialisierung
// ============================================================
function selectPlaceholderInit() {
    document.querySelectorAll('select').forEach(sel => {
        const aktualisieren = () => {
            if (sel.value === '') sel.selectedIndex = 0;
            sel.classList.toggle('wert-gewaehlt', sel.value !== '');
        };
        sel.addEventListener('change', aktualisieren);
        aktualisieren();
    });
}

Sketch.init();
zentraleEventListenerInitialisieren();
schachtListenAnsichtAktualisieren();
if (schachtSeitenleisteMedia.addEventListener) {
    schachtSeitenleisteMedia.addEventListener('change', schachtListenAnsichtAktualisieren);
} else {
    schachtSeitenleisteMedia.addListener(schachtListenAnsichtAktualisieren);
}
serviceWorkerRegistrieren();
speicherInitialisieren();
kopfzeile();
updateAuftrag();
selectPlaceholderInit();
Schacht.formularUmfangAnwenden();
UIFeedback.init();
ErfassungsumfangUI.init();
if (!document.getElementById('aufnahmedatum').value) {
    document.getElementById('aufnahmedatum').value = heutigesDatum();
}
App.setStatus('Bereit');
window.addEventListener('beforeunload', event => {
    if (!App.state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
});
