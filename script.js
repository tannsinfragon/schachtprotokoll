'use strict';

const APP_VERSION = window.AppConfig?.version || '2.5.0';
const EXPORT_SCHEMA_VERSION = window.AppConfig?.schemaVersion || 2;
const APP_FIRMA = window.AppConfig?.company || '';
const FOTO_MAX_KANTE = window.AppConfig?.photo?.maxEdge || 1600;
const FOTO_JPEG_QUALITAET = window.AppConfig?.photo?.jpegQuality || 0.82;
const QUOTA_WARN_RATIO = window.AppConfig?.storage?.quotaWarnRatio || 0.85;
const CSV = window.CSVTools;

// ============================================================
// DB – IndexedDB Datenbankschicht
// ============================================================
const DB = (() => {
    const DB_NAME = 'schachtDB';
    const DB_VERSION = 1;
    const STORE = 'schächte';
    let _db = null;

    async function open() {
        if (_db) return _db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = e => {
                _db = e.target.result;
                _db.onclose = () => { _db = null; };
                _db.onversionchange = () => { _db.close(); _db = null; };
                resolve(_db);
            };
            req.onerror = e => reject(e.target.error);
        });
    }

    async function speichern(schacht) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const now = new Date().toISOString();
            if (!schacht.erstellt_am) schacht.erstellt_am = now;
            schacht.geaendert_am = now;
            schacht.version = (schacht.version || 0) + 1;
            // id muss entweder eine gültige Zahl sein oder ganz fehlen (für autoIncrement)
            const isNew = !schacht.id;
            if (isNew) delete schacht.id;
            const req = isNew ? store.add(schacht) : store.put(schacht);
            req.onsuccess = e => resolve(e.target.result);
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
            const req = tx.objectStore(STORE).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = e => reject(e.target.error);
        });
    }

    return { open, speichern, laden, alle, loeschen };
})();

// ============================================================
// App – Zentraler Zustand
// ============================================================
const App = {
    state: {
        currentSchachtId: null,
        dirty: false,
        autoSaveTimer: null,
        leitungsnummer: 1,
        storageAvailable: false,
        storageStatus: 'checking',
    },

    toast(msg, typ = 'info') {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = `toast toast--${typ} toast--sichtbar`;
        clearTimeout(App._toastTimer);
        App._toastTimer = setTimeout(() => t.classList.remove('toast--sichtbar'), 3500);
    },

    setStatus(msg) {
        const el = document.getElementById('statusbar-text');
        if (el) el.textContent = msg;
    },

    setStorageStatus(status, msg) {
        App.state.storageStatus = status;
        App.state.storageAvailable = status === 'active' || status === 'warning';
        const statusEl = document.getElementById('speicherstatus');
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
        const banner = document.getElementById('offline-banner');
        if (banner) {
            banner.textContent = msg;
            banner.style.display = status === 'active' ? 'none' : 'block';
        }
    },

    triggerAutoSave() {
        clearTimeout(App.state.autoSaveTimer);
        App.state.dirty = true;
        App.setStatus('Nicht gespeichert');
        App.state.autoSaveTimer = setTimeout(App.autoSpeichern, 800);
    },

    async autoSpeichern() {
        if (!App.state.storageAvailable) {
            App.setStatus('Nicht gespeichert - Speicherung blockiert');
            return;
        }
        try {
            const schacht = Schacht.sammeln();
            const id = await DB.speichern(schacht);
            App.state.currentSchachtId = id;
            App.state.dirty = false;
            const zeit = new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
            App.setStatus(`Gespeichert ${zeit}`);
            speicherplatzPruefen();
        } catch (e) {
            console.error('[DB] Auto-Save Fehler:', e);
            if (e?.name === 'QuotaExceededError') {
                App.setStorageStatus('blocked', 'Speicher voll: JSON-Backup exportieren und Fotos reduzieren.');
            }
            App.toast('Speichern fehlgeschlagen: ' + e.message, 'fehler');
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
        await speicherplatzPruefen();
    } catch (e) {
        console.error('[DB] Öffnen fehlgeschlagen:', e);
        App.setStorageStatus('blocked', 'Datenbank blockiert. Formular nutzbar, Autosave blockiert.');
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
        const size = bereich.clientWidth - 32; // 2 × 1rem container padding
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
        canvasGroesse();
    }

    function leinwand(gitter) {
        ladeToken++;
        stiftZuruecksetzen();
        strokes = [];
        undoStack = [];
        loadedContent = false;
        standardHintergrundSetzen(gitter);
    }

    function getCoords(e) {
        return { x: e.clientX - cachedRect.left, y: e.clientY - cachedRect.top };
    }

    // --- Zeichnen ---

    function start(event) {
        if (!pen.stift) return;
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
        const stroke = autoKorrektur();
        strokes.push(stroke);
        if (undoStack.length >= HISTORY_MAX) undoStack.shift();
        undoStack.push({ type: 'draw', stroke });
        App.triggerAutoSave();
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
        leinwand(gitter);
    }

    function getDataURL() { return canvas.toDataURL('image/png'); }

    function getStrokes() {
        return strokes.map(s => strokeSkalieren(s, 1, 1)).filter(Boolean);
    }

    function hasContent() {
        return loadedContent || strokes.length > 0 || getDataURL() !== defaultDataURL;
    }

    function ladeSkizze(dataURL, genutzt, gespeicherteStrokes = [], gitter = currentMode) {
        const token = ++ladeToken;
        stiftZuruecksetzen();
        strokes = strokesNormalisieren(gespeicherteStrokes);
        undoStack = [];
        loadedContent = false;
        standardHintergrundSetzen(Boolean(gitter));

        if (strokes.length > 0) {
            loadedContent = typeof genutzt === 'boolean' ? genutzt : true;
            redrawAll();
            return;
        }

        if (!dataURL) return;
        const img = new Image();
        img.onload = () => {
            if (token !== ladeToken) return;
            standardHintergrundSetzen(Boolean(gitter));
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            hintergrundSpeichern();
            loadedContent = typeof genutzt === 'boolean' ? genutzt : dataURL !== defaultDataURL;
        };
        img.src = dataURL;
    }

    return { init, leinwand, farbwahl, undo, getDataURL, getStrokes, hasContent, ladeSkizze, setMode, get currentMode() { return currentMode; } };
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

function boolZuText(value) {
    return value ? 'Ja' : 'Nein';
}

function textZuBool(value, fallback) {
    const text = String(value ?? '').trim().toLowerCase();
    if (['ja', 'true', '1', 'x'].includes(text)) return true;
    if (['nein', 'false', '0', '-'].includes(text)) return false;
    return fallback;
}

function zustandsOptionLabel(key) {
    return ZUSTAND_OPTION_LABELS[key] || key;
}

function zustandsOptionKey(label) {
    const text = String(label ?? '').trim();
    return Object.keys(ZUSTAND_OPTION_LABELS).find(key => ZUSTAND_OPTION_LABELS[key] === text) || text;
}

function zustandsOptionenText(zustandsliste, gruppeKey) {
    return (zustandsliste?.[gruppeKey] || []).map(zustandsOptionLabel).join(', ');
}

function zustandsOptionenAusText(text) {
    return String(text ?? '')
        .split(',')
        .map(v => zustandsOptionKey(v))
        .filter(Boolean);
}

function istBlob(value) {
    return typeof Blob !== 'undefined' && value instanceof Blob;
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
    if (istBlob(foto)) return foto;
    if (istDataUrl(foto)) {
        try {
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
        ? fotos.map(fotoNormalisieren).filter(Boolean).slice(0, 3)
        : [];
}

async function fotoAlsDataUrl(foto) {
    if (istBlob(foto)) return blobZuDataUrl(foto);
    return istDataUrl(foto) ? foto : '';
}

async function fotosAlsDataUrls(fotos) {
    const result = await Promise.all((fotos || []).map(fotoAlsDataUrl));
    return result.filter(Boolean).slice(0, 3);
}

async function recordFuerExport(record) {
    return {
        ...record,
        fotos: await fotosAlsDataUrls(record?.fotos)
    };
}

function importRecordNormalisieren(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Datensatz ist kein Objekt');
    }
    const s = { ...raw };
    delete s.id;
    delete s.erstellt_am;
    delete s.geaendert_am;
    delete s.version;
    s.leitungen = Array.isArray(s.leitungen) ? s.leitungen.filter(v => v && typeof v === 'object') : [];
    s.fotos = fotosNormalisieren(s.fotos);
    s.skizze_strokes = Array.isArray(s.skizze_strokes) ? s.skizze_strokes : [];
    if (s.skizze_modus && !['skizze', 'gitter'].includes(s.skizze_modus)) {
        s.skizze_modus = 'skizze';
    }
    if (Object.prototype.hasOwnProperty.call(s, 'skizze_genutzt')) {
        s.skizze_genutzt = s.skizze_genutzt === true || String(s.skizze_genutzt).toLowerCase() === 'true';
    }
    s.formular_umfang = formularUmfangNormalisieren(s.formular_umfang);
    if (!s.zustandsliste || typeof s.zustandsliste !== 'object' || Array.isArray(s.zustandsliste)) {
        s.zustandsliste = {};
    }
    Object.keys(s.zustandsliste).forEach(key => {
        if (!Array.isArray(s.zustandsliste[key])) delete s.zustandsliste[key];
    });
    s.schadenstufe = String(s.schadenstufe || '');
    return s;
}

function jsonImportRecords(daten) {
    if (Array.isArray(daten)) return daten;
    if (daten && Array.isArray(daten.records)) return daten.records;
    if (daten && typeof daten === 'object') return [daten];
    throw new Error('Ungültiges JSON-Format');
}

async function importRecordsSpeichern(records) {
    let importiert = 0;
    let fehler = 0;
    for (const record of records) {
        try {
            await DB.speichern(importRecordNormalisieren(record));
            importiert++;
        } catch (e) {
            console.warn('[Import] Datensatz übersprungen:', e);
            fehler++;
        }
    }
    if (importiert === 0 && fehler > 0) throw new Error('Keine gültigen Datensätze');
    return { importiert, fehler };
}

const Schacht = (() => {
    const PFLICHTFELDER = [];

    // Alle Formularfelder des Schachts (ID → direkt via _val/_set)
    const KOPFDATEN = ['gemeinde', 'strasse', 'nummer', 'parzelle', 'aufnahmedatum', 'visum'];

    const FELDER = [
        ...KOPFDATEN,
        'koordinaten_e', 'koordinaten_n', 'koordinaten_z',
        // Schacht
        'schacht_typ', 'schacht_material', 'schacht_dim', 'schacht_sohle',
        'schacht_einstieg', 'schacht_eigentuemer', 'schacht_baujahr',
        // Deckel
        'deckel_form', 'deckel_dm', 'deckel_material', 'deckel_verschluss',
        'deckel_oberflaechenzulauf', 'deckel_zugaenglichkeit', 'deckel_baujahr',
        // Zustand
        'zustand', 'notiz'
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
        }
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
        App.state.leitungsnummer = 1;
        (data.leitungen || []).forEach(l => _insertLeitungRow(l));
        const skizzenModus = data.skizze_modus === 'gitter' ? true : false;
        Sketch.ladeSkizze(data.skizze, typeof data.skizze_genutzt === 'boolean' ? data.skizze_genutzt : undefined, data.skizze_strokes, skizzenModus);
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
        App.state.leitungsnummer = 1;
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
        App.state.leitungsnummer = 1;
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
            App.state.leitungsnummer = Math.max(App.state.leitungsnummer, nrZahl + 1);
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
        container.classList.toggle('fotos-container--leer', count === 0);
        const zaehler = document.getElementById('fotoZaehler');
        if (zaehler) zaehler.textContent = `${count}/3`;
        const label = document.getElementById('kamera-label');
        if (label) {
            label.classList.toggle('is-disabled', count >= 3);
            label.setAttribute('aria-disabled', count >= 3 ? 'true' : 'false');
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
    navigator.serviceWorker.register('./serviceworker.js')
        .then(() => console.log('[App] Service Worker installiert'))
        .catch(e => console.error('[App] Service Worker Fehler:', e));
}

// ============================================================
// Globale Funktionen
// ============================================================

function dialogOeffnen(id) {
    const dlg = document.getElementById(id);
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') {
        dlg.showModal();
    } else {
        dlg.setAttribute('open', '');
        dlg.classList.add('dialog-fallback-offen');
        document.body.classList.add('dialog-fallback-aktiv');
    }
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
    clearTimeout(App.state.autoSaveTimer);
    App.state.currentSchachtId = null;
    App.state.dirty = false;
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
        ['Typ', 'schacht_typ'], ['Material', 'schacht_material'], ['Dimension', 'schacht_dim'],
        ['Sohle', 'schacht_sohle'], ['Einstieg', 'schacht_einstieg'],
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
    const section = el('section', 'print-summary-section');
    section.appendChild(el('h2', '', 'Medien'));
    const media = el('div', 'print-summary-media');
    if (hatSkizze) {
        const wrap = el('div', 'print-summary-skizze');
        const img = document.createElement('img');
        img.alt = 'Skizze';
        img.src = data.skizze;
        wrap.appendChild(img);
        media.appendChild(wrap);
    }
    if (fotos.length) {
        const wrap = el('div', 'print-summary-fotos');
        fotos.forEach((foto, index) => {
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
        });
        media.appendChild(wrap);
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

function printpdf() {
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
    const data = Schacht.sammeln();
    printSummaryErstellen(data);
    const cleanup = () => {
        printSummaryEntfernen();
        if (titleEl) titleEl.textContent = alterTitel;
        window.removeEventListener('afterprint', cleanup);
        window.removeEventListener('focus', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.addEventListener('focus', cleanup, { once: true });
    App.toast('Tipp: In Chrome → Mehr Einstellungen → «Kopf- und Fusszeilen» deaktivieren', 'info');
    setTimeout(() => {
        if (titleEl) titleEl.textContent = parts.join('_');
        window.print();
        dateInputs.forEach(el => {
            const parts = el.value.split('.');
            el.type = 'date';
            el.value = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : '';
        });
    }, 400);
}

async function exportAllePDF() {
    try {
        clearTimeout(App.state.autoSaveTimer);
        if (App.state.dirty && App.state.storageAvailable) {
            await App.autoSpeichern();
        } else if (App.state.dirty) {
            App.toast('Aktuelle Änderungen sind nicht gespeichert und fehlen im Sammel-PDF.', 'warn');
        }

        const alle = await DB.alle();
        if (!alle.length) {
            App.toast('Keine gespeicherten Schächte vorhanden.', 'warn');
            return;
        }

        alle.sort((a, b) => (b.geaendert_am || '').localeCompare(a.geaendert_am || ''));
        const titleEl = document.querySelector('title');
        const alterTitel = titleEl?.textContent || 'Schachtprotokoll';
        printSummaryAlleErstellen(alle);

        const cleanup = () => {
            printSummaryEntfernen();
            if (titleEl) titleEl.textContent = alterTitel;
            window.removeEventListener('afterprint', cleanup);
            window.removeEventListener('focus', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.addEventListener('focus', cleanup, { once: true });
        App.toast('Alle gespeicherten Schächte werden für den PDF-Druck vorbereitet.', 'info');
        setTimeout(() => {
            if (titleEl) titleEl.textContent = `Schachtprotokolle_alle_${dateiDatum()}`;
            window.print();
        }, 400);
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
    URL.revokeObjectURL(url);
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
        .slice(0, 80) || 'ohne_angabe';
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

async function mediumZuBytes(medium) {
    if (istBlob(medium)) return new Uint8Array(await medium.arrayBuffer());
    if (istDataUrl(medium)) return window.SchachtZip.dataUrlToBytes(medium);
    return new Uint8Array();
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

function skizzeDefaultDataUrl(width, height, gitter = false) {
    return skizzeDefaultCanvas(width, height, gitter).toDataURL('image/png');
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
    const id = dateinameSicher(record.id || index + 1);
    return `schacht_${id}`;
}

async function exportAlleCSV() {
    try {
        const alle = await DB.alle();
        if (!alle.length) { App.toast('Keine gespeicherten Schächte vorhanden.', 'warn'); return; }
        if (!CSV?.stringify) throw new Error('CSV-Modul nicht geladen');

        // ── Blatt 1: Schächte-Übersicht ──
        const kopfFelder = [
            ['ID','id'], ['Datum','datum'], ['Firma','firma'],
            ['Gemeinde','gemeinde'], ['Strasse','strasse'], ['Nr','nummer'],
            ['Parzelle','parzelle'], ['Aufnahmedatum','aufnahmedatum'], ['Visum','visum'],
            ['Koordinaten E','koordinaten_e'], ['Koordinaten N','koordinaten_n'], ['Koordinaten Z','koordinaten_z'],
            ['Schacht Typ','schacht_typ'], ['Schacht Material','schacht_material'],
            ['Schacht Dim','schacht_dim'], ['Sohle','schacht_sohle'],
            ['Einstieg','schacht_einstieg'], ['Eigentümer Schacht','schacht_eigentuemer'],
            ['Baujahr Schacht','schacht_baujahr'],
            ['Deckel Form','deckel_form'], ['Deckel DM','deckel_dm'],
            ['Deckel Material','deckel_material'], ['Verschluss','deckel_verschluss'],
            ['Oberflächenzulauf','deckel_oberflaechenzulauf'],
            ['Zugänglichkeit','deckel_zugaenglichkeit'], ['Baujahr Deckel','deckel_baujahr'],
            ['Zustand','zustand'], ['Notiz','notiz'],
            ...FORMULAR_UMFANG_KEYS.map(key => [
                `Umfang ${FORMULAR_UMFANG_LABELS[key]}`,
                s => boolZuText(formularUmfangNormalisieren(s.formular_umfang)[key])
            ]),
            ['Schadenstufe','schadenstufe'],
            ...ZUSTAND_GRUPPEN.map(gruppe => [
                `Zustand ${gruppe.label}`,
                s => zustandsOptionenText(s.zustandsliste, gruppe.key)
            ]),
            ['Erstellt am','erstellt_am'], ['Geändert am','geaendert_am']
        ];

        const schachtRows = [
            kopfFelder.map(([label]) => label),
            ...alle.map(s => kopfFelder.map(([, key]) => typeof key === 'function' ? key(s) : s[key]))
        ];

        // ── Blatt 2: Leitungen aller Schächte ──
        const ltgHeader = ['Schacht-ID','Gemeinde','Strasse','Nr',
            'Ltg-Nr','Richtung','Tiefe','Profil','Material','NW','Funktion',
            'Art','Betrieb','Hydraulik','Notiz'];
        const ltgRows = [ltgHeader];
        alle.forEach(s => {
            (s.leitungen || []).forEach(l => ltgRows.push([
                s.id, s.gemeinde, s.strasse, s.nummer,
                l.nr, l.ltg_richtung, l.tiefe, l.ltg_profil, l.rmat, l.rdm,
                l.ltg_funktion, l.ltg_art, l.ltg_betrieb, l.ltg_hydraulik,
                l.lnotiz
            ]));
        });

        const toCSV = rows => CSV.stringify(rows);
        const inhalt = [
            'SCHÄCHTE', toCSV(schachtRows),
            '', 'LEITUNGEN', toCSV(ltgRows)
        ].join('\r\n');

        downloadFile('\uFEFF' + inhalt, 'text/csv;charset=utf-8', `schachtprotokoll_alle_${new Date().toLocaleDateString('de-CH').replace(/\./g,'-')}.csv`);
    } catch (e) {
        App.toast('CSV-Export fehlgeschlagen: ' + e.message, 'error');
    }
}

async function exportBilderZIP() {
    try {
        const alle = await DB.alle();
        if (!alle.length) { App.toast('Keine gespeicherten Schächte vorhanden.', 'warn'); return; }
        if (!window.SchachtZip?.ZipWriter) throw new Error('ZIP-Writer nicht geladen');
        const zip = new window.SchachtZip.ZipWriter();
        const manifest = {
            schema_version: 1,
            app_version: APP_VERSION,
            exported_at: new Date().toISOString(),
            files: []
        };

        for (let i = 0; i < alle.length; i++) {
            const s = alle[i];
            const ordner = schachtOrdner(s, i);
            const fotos = (s.fotos || []).filter(Boolean);
            for (let fotoIndex = 0; fotoIndex < fotos.length; fotoIndex++) {
                const foto = fotos[fotoIndex];
                const mime = mediumMime(foto);
                const endung = mediumEndung(foto);
                const dateiname = `${ordner}/foto_${fotoIndex + 1}.${endung}`;
                const bytes = await mediumZuBytes(foto);
                if (!bytes.length) continue;
                zip.file(dateiname, bytes);
                manifest.files.push({
                    schacht_id: s.id,
                    gemeinde: s.gemeinde || '',
                    strasse: s.strasse || '',
                    nummer: s.nummer || '',
                    typ: 'foto',
                    dateiname,
                    mime_type: mime,
                    byte_laenge: bytes.length,
                    speicherformat: istBlob(foto) ? 'blob' : 'data_url'
                });
            }
            if (await recordHatSkizze(s)) {
                const dateiname = `${ordner}/skizze.png`;
                zip.file(dateiname, window.SchachtZip.dataUrlToBytes(s.skizze));
                manifest.files.push({
                    schacht_id: s.id,
                    gemeinde: s.gemeinde || '',
                    strasse: s.strasse || '',
                    nummer: s.nummer || '',
                    typ: 'skizze',
                    dateiname,
                    mime_type: window.SchachtZip.dataUrlMime(s.skizze),
                    data_url_laenge: String(s.skizze || '').length
                });
            }
        }

        if (!manifest.files.length) { App.toast('Keine Fotos oder genutzten Skizzen vorhanden.', 'warn'); return; }
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
        downloadBlob(blob, `schachtprotokoll_bilder_${dateiDatum()}.zip`);
    } catch (e) {
        App.toast('Bilder-ZIP fehlgeschlagen: ' + e.message, 'error');
    }
}

async function exportAlleJSON() {
    try {
        const alle = await DB.alle();
        if (!alle.length) { App.toast('Keine gespeicherten Schächte vorhanden.', 'warn'); return; }
        const records = await Promise.all(alle.map(recordFuerExport));
        const payload = {
            schema_version: EXPORT_SCHEMA_VERSION,
            app_version: APP_VERSION,
            exported_at: new Date().toISOString(),
            records
        };
        downloadFile(JSON.stringify(payload, null, 2), 'application/json', `schachtprotokoll_alle_${new Date().toLocaleDateString('de-CH').replace(/\./g,'-')}.json`);
    } catch (e) {
        App.toast('JSON-Export fehlgeschlagen: ' + e.message, 'error');
    }
}

async function exportAlleXML() {
    try {
        const alle = await DB.alle();
        if (!alle.length) { App.toast('Keine gespeicherten Schächte vorhanden.', 'warn'); return; }
        const exportRecords = await Promise.all(alle.map(recordFuerExport));
        const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const escAttr = v => esc(v).replace(/"/g, '&quot;');
        const tag = (n, v, indent='    ') => `${indent}<${n}>${esc(v)}</${n}>`;

        const schachten = exportRecords.map(s => {
            const leitungenXML = (s.leitungen || []).map(l => [
                '      <leitung>',
                tag('nr', l.nr, '        '), tag('richtung', l.ltg_richtung, '        '),
                tag('tiefe', l.tiefe, '        '), tag('profil', l.ltg_profil, '        '),
                tag('material', l.rmat, '        '), tag('nennweite', l.rdm, '        '),
                tag('funktion', l.ltg_funktion, '        '), tag('art', l.ltg_art, '        '),
                tag('betrieb', l.ltg_betrieb, '        '), tag('hydraulik', l.ltg_hydraulik, '        '),
                tag('notiz', l.lnotiz, '        '),
                '      </leitung>'
            ].join('\n')).join('\n');
            const umfang = formularUmfangNormalisieren(s.formular_umfang);
            const umfangXML = FORMULAR_UMFANG_KEYS.map(key => tag(key, umfang[key] ? 'true' : 'false', '      ')).join('\n');
            const zustandsXML = ZUSTAND_GRUPPEN.map(gruppe => {
                const optionenXML = (s.zustandsliste?.[gruppe.key] || [])
                    .map(option => tag('option', option, '        '))
                    .join('\n');
                return [
                    `      <gruppe name="${escAttr(gruppe.key)}">`,
                    optionenXML,
                    '      </gruppe>'
                ].join('\n');
            }).join('\n');
            const fotosXML = (s.fotos || []).filter(Boolean)
                .map(foto => [
                    '      <foto>',
                    esc(foto),
                    '      </foto>'
                ].join('\n'))
                .join('\n');
            const skizzeStrokes = Array.isArray(s.skizze_strokes) ? JSON.stringify(s.skizze_strokes) : '';
            return [
                `  <schacht id="${escAttr(s.id)}">`,
                tag('datum', s.datum), tag('firma', s.firma),
                tag('gemeinde', s.gemeinde), tag('strasse', s.strasse), tag('nummer', s.nummer),
                tag('parzelle', s.parzelle), tag('aufnahmedatum', s.aufnahmedatum), tag('visum', s.visum),
                tag('koordinaten_e', s.koordinaten_e), tag('koordinaten_n', s.koordinaten_n), tag('koordinaten_z', s.koordinaten_z),
                tag('deckel_form', s.deckel_form), tag('deckel_dm', s.deckel_dm),
                tag('deckel_material', s.deckel_material), tag('deckel_verschluss', s.deckel_verschluss),
                tag('deckel_oberflaechenzulauf', s.deckel_oberflaechenzulauf),
                tag('deckel_zugaenglichkeit', s.deckel_zugaenglichkeit), tag('deckel_baujahr', s.deckel_baujahr),
                tag('schacht_typ', s.schacht_typ), tag('schacht_material', s.schacht_material),
                tag('schacht_dim', s.schacht_dim), tag('schacht_sohle', s.schacht_sohle),
                tag('schacht_einstieg', s.schacht_einstieg), tag('schacht_eigentuemer', s.schacht_eigentuemer),
                tag('schacht_baujahr', s.schacht_baujahr), tag('zustand', s.zustand), tag('notiz', s.notiz),
                '    <formular_umfang>',
                umfangXML,
                '    </formular_umfang>',
                tag('schadenstufe', s.schadenstufe),
                '    <zustandsliste>',
                zustandsXML,
                '    </zustandsliste>',
                tag('skizze', s.skizze),
                tag('skizze_genutzt', typeof s.skizze_genutzt === 'boolean' ? String(s.skizze_genutzt) : ''),
                tag('skizze_modus', s.skizze_modus),
                tag('skizze_strokes', skizzeStrokes),
                '    <fotos>',
                fotosXML,
                '    </fotos>',
                tag('erstellt_am', s.erstellt_am), tag('geaendert_am', s.geaendert_am),
                '    <leitungen>',
                leitungenXML,
                '    </leitungen>',
                '  </schacht>'
            ].join('\n');
        }).join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<schachtprotokoll>\n${schachten}\n</schachtprotokoll>`;
        downloadFile(xml, 'application/xml;charset=utf-8', `schachtprotokoll_alle_${new Date().toLocaleDateString('de-CH').replace(/\./g,'-')}.xml`);
    } catch (e) {
        App.toast('XML-Export fehlgeschlagen: ' + e.message, 'error');
    }
}

async function importJSON(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        const text = await file.text();
        const daten = JSON.parse(text);
        const result = await importRecordsSpeichern(jsonImportRecords(daten));
        const zusatz = result.fehler ? `, ${result.fehler} übersprungen` : '';
        App.toast(`${result.importiert} Schacht${result.importiert !== 1 ? 'e' : ''} importiert${zusatz}.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.toast('Import fehlgeschlagen: ' + e.message, 'error');
    }
}

async function alleSchachteLöschen() {
    if (!await bestaetigen('Alle gespeicherten Schächte unwiderruflich löschen?')) return;
    clearTimeout(App.state.autoSaveTimer);
    try {
        const alle = await DB.alle();
        await Promise.all(alle.map(s => DB.loeschen(s.id)));
        App.state.currentSchachtId = null;
        Schacht.zuruecksetzen();
        App.setStatus('Cache geleert');
        App.toast(`${alle.length} Schacht${alle.length !== 1 ? 'e' : ''} gelöscht.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
    }
}

async function importCSV(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        if (!CSV?.parse) throw new Error('CSV-Modul nicht geladen');
        const text = await file.text();
        const rows = CSV.parse(text).filter(row => row.some(cell => String(cell).trim() !== ''));
        const abschnitt = row => String(row[0] || '').trim().toUpperCase().replace(/Ä/g, 'A');
        const schachtStart = rows.findIndex(row => abschnitt(row) === 'SCHACHTE');
        const ltgStart = rows.findIndex(row => abschnitt(row) === 'LEITUNGEN');
        if (schachtStart === -1) throw new Error('Ungültiges CSV-Format (kein SCHÄCHTE-Abschnitt)');

        const schachtRows = rows.slice(schachtStart + 1, ltgStart !== -1 ? ltgStart : undefined);
        if (schachtRows.length < 2) throw new Error('Keine Datensätze im CSV');
        const headers = schachtRows[0];

        const ltgRows = ltgStart !== -1 ? rows.slice(ltgStart + 1) : [];
        const ltgHeaders = ltgRows.length > 0 ? ltgRows[0] : [];
        const ltgData = ltgRows.slice(1).map(vals => {
            return Object.fromEntries(ltgHeaders.map((h, i) => [h, vals[i] ?? '']));
        });

        // Map German header labels back to field keys
        const labelZuFeld = {
            'ID':'id','Datum':'datum','Firma':'firma','Gemeinde':'gemeinde','Strasse':'strasse',
            'Nr':'nummer','Parzelle':'parzelle',
            'Aufnahmedatum':'aufnahmedatum','Visum':'visum',
            'Koordinaten E':'koordinaten_e','Koordinaten N':'koordinaten_n','Koordinaten Z':'koordinaten_z',
            'Schacht Typ':'schacht_typ','Schacht Material':'schacht_material',
            'Schacht Dim':'schacht_dim','Sohle':'schacht_sohle','Einstieg':'schacht_einstieg',
            'Eigentümer Schacht':'schacht_eigentuemer','Baujahr Schacht':'schacht_baujahr',
            'Deckel Form':'deckel_form','Deckel DM':'deckel_dm','Deckel Material':'deckel_material',
            'Verschluss':'deckel_verschluss','Oberflächenzulauf':'deckel_oberflaechenzulauf',
            'Zugänglichkeit':'deckel_zugaenglichkeit','Baujahr Deckel':'deckel_baujahr',
            'Zustand':'zustand','Notiz':'notiz',
            'Erstellt am':'erstellt_am','Geändert am':'geaendert_am'
        };

        const records = [];
        for (const vals of schachtRows.slice(1)) {
            const s = {};
            const wert = label => {
                const idx = headers.indexOf(label);
                return idx >= 0 ? (vals[idx] ?? '') : '';
            };
            headers.forEach((h, i) => { const k = labelZuFeld[h]; if (k && k !== 'id') s[k] = vals[i] ?? ''; });
            const umfang = {};
            let hatUmfang = false;
            FORMULAR_UMFANG_KEYS.forEach(key => {
                const label = `Umfang ${FORMULAR_UMFANG_LABELS[key]}`;
                if (headers.includes(label)) {
                    hatUmfang = true;
                    umfang[key] = textZuBool(wert(label), DEFAULT_FORMULAR_UMFANG[key]);
                }
            });
            if (hatUmfang) s.formular_umfang = formularUmfangNormalisieren(umfang);
            s.schadenstufe = wert('Schadenstufe') || s.schadenstufe || '';
            const zustandsliste = {};
            ZUSTAND_GRUPPEN.forEach(gruppe => {
                const optionen = zustandsOptionenAusText(wert(`Zustand ${gruppe.label}`));
                if (optionen.length > 0) zustandsliste[gruppe.key] = optionen;
            });
            if (Object.keys(zustandsliste).length > 0) s.zustandsliste = zustandsliste;
            const idIdx = headers.indexOf('ID');
            const csvId = idIdx >= 0 ? vals[idIdx] : '';
            s.leitungen = ltgData
                .filter(l => l['Schacht-ID'] === csvId)
                .map(l => ({
                    nr: l['Ltg-Nr'], ltg_richtung: l['Richtung'], tiefe: l['Tiefe'],
                    ltg_profil: l['Profil'], rmat: l['Material'], rdm: l['NW'],
                    ltg_funktion: l['Funktion'], ltg_art: l['Art'], ltg_betrieb: l['Betrieb'],
                    ltg_hydraulik: l['Hydraulik'], lnotiz: l['Notiz']
                }));
            records.push(s);
        }
        const result = await importRecordsSpeichern(records);
        const zusatz = result.fehler ? `, ${result.fehler} übersprungen` : '';
        App.toast(`${result.importiert} Schacht${result.importiert !== 1 ? 'e' : ''} importiert${zusatz}.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.toast('CSV-Import fehlgeschlagen: ' + e.message, 'error');
    }
}

async function importXML(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        const text = await file.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'application/xml');
        const parseError = doc.querySelector('parsererror');
        if (parseError) throw new Error('Ungültiges XML');

        const txt = el => el ? el.textContent.trim() : '';
        const schachten = doc.querySelectorAll('schacht');
        if (!schachten.length) throw new Error('Keine <schacht>-Elemente gefunden');

        const records = [];
        for (const node of schachten) {
            const g = name => txt(node.querySelector(name));
            const s = {
                datum: g('datum'), firma: g('firma'),
                gemeinde: g('gemeinde'), strasse: g('strasse'), nummer: g('nummer'),
                gis: g('gis'), feld: g('feld'), parzelle: g('parzelle'),
                aufnahmedatum: g('aufnahmedatum'), visum: g('visum'),
                koordinaten_e: g('koordinaten_e'), koordinaten_n: g('koordinaten_n'), koordinaten_z: g('koordinaten_z'),
                schacht_typ: g('schacht_typ') || g('typ'),
                schacht_material: g('schacht_material') || g('material'),
                schacht_dim: g('schacht_dim') || g('dimension'),
                schacht_sohle: g('schacht_sohle') || g('sohle'),
                schacht_einstieg: g('schacht_einstieg') || g('einstieg'),
                schacht_eigentuemer: g('schacht_eigentuemer') || g('eigentuemer'),
                schacht_baujahr: g('schacht_baujahr') || g('baujahr'),
                deckel_form: g('deckel_form'), deckel_dm: g('deckel_dm'),
                deckel_material: g('deckel_material'), deckel_verschluss: g('deckel_verschluss'),
                deckel_oberflaechenzulauf: g('deckel_oberflaechenzulauf'),
                deckel_zugaenglichkeit: g('deckel_zugaenglichkeit'), deckel_baujahr: g('deckel_baujahr'),
                zustand: g('zustand') || g('bewertung'), notiz: g('notiz'),
                system: g('system'), ks_typ: g('ks_typ'), rueckstau: g('rueckstau'),
                versickerung: g('versickerung'), dichtheit_geprueft: g('dichtheit_geprueft'),
                dichtheit_ergebnis: g('dichtheit_ergebnis'), dichtheit_datum: g('dichtheit_datum'),
                skizze: g('skizze'),
                skizze_modus: g('skizze_modus'),
                fotos: Array.from(node.querySelectorAll('fotos > foto')).map(foto => txt(foto)).filter(Boolean),
                leitungen: Array.from(node.querySelectorAll('leitung')).map(l => {
                    const lv = n => txt(l.querySelector(n));
                    return {
                        nr: lv('nr'), ltg_richtung: lv('richtung'), tiefe: lv('tiefe'),
                        ltg_profil: lv('profil'), rmat: lv('material'), rdm: lv('nennweite'),
                        ltg_funktion: lv('funktion'), ltg_art: lv('art'), ltg_betrieb: lv('betrieb'),
                        ltg_hydraulik: lv('hydraulik'), lnotiz: lv('notiz')
                    };
                })
            };
            const skizzeGenutzt = g('skizze_genutzt');
            if (skizzeGenutzt) s.skizze_genutzt = textZuBool(skizzeGenutzt, false);
            const skizzeStrokes = g('skizze_strokes');
            if (skizzeStrokes) {
                try {
                    const parsed = JSON.parse(skizzeStrokes);
                    if (Array.isArray(parsed)) s.skizze_strokes = parsed;
                } catch (e) {
                    console.warn('[Import] Skizzen-Striche im XML ignoriert:', e);
                }
            }
            const umfangNode = node.querySelector('formular_umfang');
            const umfang = {};
            let hatUmfang = false;
            FORMULAR_UMFANG_KEYS.forEach(key => {
                const value = txt(umfangNode?.querySelector(key));
                if (value) {
                    hatUmfang = true;
                    umfang[key] = textZuBool(value, DEFAULT_FORMULAR_UMFANG[key]);
                }
            });
            if (hatUmfang) s.formular_umfang = formularUmfangNormalisieren(umfang);
            s.schadenstufe = g('schadenstufe');
            const zustandsliste = {};
            node.querySelectorAll('zustandsliste > gruppe').forEach(gruppeNode => {
                const key = gruppeNode.getAttribute('name');
                const optionen = Array.from(gruppeNode.querySelectorAll('option')).map(option => txt(option)).filter(Boolean);
                if (key && optionen.length > 0) zustandsliste[key] = optionen;
            });
            if (Object.keys(zustandsliste).length > 0) s.zustandsliste = zustandsliste;
            records.push(s);
        }
        const result = await importRecordsSpeichern(records);
        const zusatz = result.fehler ? `, ${result.fehler} übersprungen` : '';
        App.toast(`${result.importiert} Schacht${result.importiert !== 1 ? 'e' : ''} importiert${zusatz}.`, 'success');
        schachtListeAktualisieren();
    } catch (e) {
        App.toast('XML-Import fehlgeschlagen: ' + e.message, 'error');
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
    if (e && n) {
        el.href = `https://map.geo.admin.ch/?E=${e}&N=${n}&zoom=10`;
    } else {
        el.href = 'https://map.geo.admin.ch/';
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
    const img = await bildElementAusDatei(file);
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
        .filter(Boolean)
        .slice(0, 3);
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
    const file = document.getElementById('input').files[0];
    if (!file) return;
    document.getElementById('input').value = '';
    if (!file.type.match(/image.*/)) { App.toast('Datei nicht unterstützt', 'fehler'); return; }
    if (document.getElementById('fotos').children.length >= 3) {
        App.toast('Maximal 3 Fotos', 'warn'); return;
    }
    try {
        const blob = await fotoDateiKomprimieren(file);
        fotoHinzufuegen(blob);
        App.triggerAutoSave();
        speicherplatzPruefen();
    } catch (e) {
        App.toast('Foto konnte nicht verarbeitet werden: ' + e.message, 'fehler');
    }
}

function farbwahl(el) { Sketch.farbwahl(el); }
function undo() { Sketch.undo(); }

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

function closeDialog() { dialogSchliessen('ltgDialog'); }

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
        case 'close-dialog': return closeDialog();
        case 'undo': return undo();
        case 'export-json': return exportAlleJSON();
        case 'export-csv': return exportAlleCSV();
        case 'export-xml': return exportAlleXML();
        case 'export-bilder': return exportBilderZIP();
        case 'export-alle-pdf': return exportAllePDF();
        case 'import-json': return document.getElementById('importDateiJSON')?.click();
        case 'import-csv': return document.getElementById('importDateiCSV')?.click();
        case 'import-xml': return document.getElementById('importDateiXML')?.click();
        case 'alle-schachte-loeschen': return alleSchachteLöschen();
        default:
            console.warn('[UI] Unbekannte Aktion:', action, element);
    }
}

function zentraleEventListenerInitialisieren() {
    document.addEventListener('click', event => {
        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        event.preventDefault();
        aktionAusfuehren(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const actionEl = event.target.closest('[data-action], [data-stift]');
        if (!actionEl) return;
        event.preventDefault();
        if (actionEl.dataset.stift !== undefined) {
            farbwahl(actionEl);
        } else {
            aktionAusfuehren(actionEl.dataset.action, actionEl);
        }
    });

    document.querySelectorAll('[data-stift]').forEach(el => {
        el.addEventListener('click', () => farbwahl(el));
    });

    document.getElementById('input')?.addEventListener('change', bildAuswahl);
    document.getElementById('importDateiJSON')?.addEventListener('change', event => importJSON(event.target));
    document.getElementById('importDateiCSV')?.addEventListener('change', event => importCSV(event.target));
    document.getElementById('importDateiXML')?.addEventListener('change', event => importXML(event.target));
    document.getElementById('koordinaten_e')?.addEventListener('input', koordinatenAktualisieren);
    document.getElementById('koordinaten_n')?.addEventListener('input', koordinatenAktualisieren);
}

// ============================================================
// Schächte-Liste Panel
// ============================================================
function schachtListeOeffnen() {
    document.getElementById('schachtListe').classList.add('offen');
    document.getElementById('panelOverlay').style.display = 'block';
    schachtListeAktualisieren();
}

function schachtListeSchliessen() {
    document.getElementById('schachtListe').classList.remove('offen');
    document.getElementById('panelOverlay').style.display = 'none';
}

async function schachtListeAktualisieren() {
    const tbody = document.querySelector('#schachtListeTabelle tbody');
    tbody.innerHTML = '';
    try {
        const alle = await DB.alle();
        if (alle.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="liste-leer">Keine gespeicherten Schächte</td></tr>';
            return;
        }
        alle.sort((a, b) => (b.geaendert_am || '').localeCompare(a.geaendert_am || ''));
        alle.forEach(s => {
            const tr = document.createElement('tr');
            ['Datum', 'Gemeinde', 'Strasse', 'Nr', 'Typ'].forEach((label, i) => {
                const v = [s.datum, s.gemeinde, s.strasse, s.nummer, s.schacht_typ || s.typ || ''][i];
                const cell = tr.insertCell(-1);
                cell.textContent = v || '';
                cell.dataset.label = label;
            });
            const aktCell = tr.insertCell(-1);
            aktCell.dataset.label = 'Aktion';
            const btnLaden = document.createElement('button');
            btnLaden.className = 'btn-laden'; btnLaden.textContent = 'Laden';
            btnLaden.addEventListener('click', () => schachtLaden(s.id));
            const btnDel = document.createElement('button');
            btnDel.className = 'btn-loeschen'; btnDel.textContent = 'x';
            btnDel.addEventListener('click', () => schachtLoeschenAusListe(s.id));
            aktCell.append(btnLaden, btnDel);
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error('[DB] Liste Fehler:', e);
        App.toast('Fehler beim Laden der Liste: ' + e.message, 'fehler');
    }
}

async function schachtLaden(id) {
    try {
        const data = await DB.laden(id);
        if (!data) { App.toast('Schacht nicht gefunden', 'fehler'); return; }
        App.state.currentSchachtId = id;
        App.state.dirty = false;
        Schacht.laden(data);
        App.setStatus(`✓ Schacht #${id} geladen`);
        schachtListeSchliessen();
    } catch (e) {
        console.error('[DB] Laden Fehler:', e);
        App.toast('Fehler beim Laden: ' + e.message, 'fehler');
    }
}

async function schachtLoeschenAusListe(id) {
    if (!await bestaetigen('Schacht unwiderruflich löschen?')) return;
    clearTimeout(App.state.autoSaveTimer);
    try {
        await DB.loeschen(id);
        if (App.state.currentSchachtId === id) {
            App.state.currentSchachtId = null;
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
window.addEventListener('beforeunload', () => clearTimeout(App.state.autoSaveTimer));
