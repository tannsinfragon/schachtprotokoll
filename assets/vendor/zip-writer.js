(function (global) {
    'use strict';

    const crcTable = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
            c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    }

    function utf8(text) {
        return new TextEncoder().encode(String(text ?? ''));
    }

    function isBlob(data) {
        return Boolean(data && typeof data === 'object' &&
            ((typeof Blob !== 'undefined' && data instanceof Blob) || Object.prototype.toString.call(data) === '[object Blob]') &&
            typeof data.arrayBuffer === 'function' && typeof data.size === 'number');
    }

    function normalizePath(path) {
        return String(path || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/\/{2,}/g, '/');
    }

    async function toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (isBlob(data)) return new Uint8Array(await data.arrayBuffer());
        return utf8(data);
    }

    function dataUrlToBytes(dataUrl) {
        const text = String(dataUrl || '');
        const comma = text.indexOf(',');
        if (comma === -1) return new Uint8Array();
        const meta = text.slice(0, comma).toLowerCase();
        const body = text.slice(comma + 1);
        if (meta.includes(';base64')) {
            const binary = atob(body);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        return utf8(decodeURIComponent(body));
    }

    function dataUrlMime(dataUrl) {
        const match = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
        return match ? match[1].toLowerCase() : 'application/octet-stream';
    }

    function writeU16(target, offset, value) {
        target[offset] = value & 0xff;
        target[offset + 1] = (value >>> 8) & 0xff;
    }

    function writeU32(target, offset, value) {
        target[offset] = value & 0xff;
        target[offset + 1] = (value >>> 8) & 0xff;
        target[offset + 2] = (value >>> 16) & 0xff;
        target[offset + 3] = (value >>> 24) & 0xff;
    }

    function dosDateTime(date = new Date()) {
        const year = Math.max(1980, date.getFullYear());
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
        };
    }

    function concat(chunks, totalLength) {
        const result = new Uint8Array(totalLength);
        let offset = 0;
        chunks.forEach(chunk => {
            result.set(chunk, offset);
            offset += chunk.length;
        });
        return result;
    }

    class ZipWriter {
        constructor(prefix = '', files = []) {
            this.prefix = normalizePath(prefix);
            this.files = files;
        }

        folder(path) {
            const name = normalizePath(path).replace(/\/?$/, '/');
            return new ZipWriter(this.prefix + name, this.files);
        }

        file(path, data) {
            const name = normalizePath(this.prefix + path);
            if (!name || name.endsWith('/')) return this;
            this.files.push({ name, data });
            return this;
        }

        async generateAsync(options = {}) {
            const now = dosDateTime();
            const localParts = [];
            const centralParts = [];
            let offset = 0;

            for (const file of this.files) {
                const nameBytes = utf8(file.name);
                const originalData = await file.data;
                const dataBytes = await toBytes(originalData);
                const crc = crc32(dataBytes);

                const local = new Uint8Array(30 + nameBytes.length);
                writeU32(local, 0, 0x04034b50);
                writeU16(local, 4, 20);
                writeU16(local, 6, 0x0800);
                writeU16(local, 8, 0);
                writeU16(local, 10, now.time);
                writeU16(local, 12, now.date);
                writeU32(local, 14, crc);
                writeU32(local, 18, dataBytes.length);
                writeU32(local, 22, dataBytes.length);
                writeU16(local, 26, nameBytes.length);
                local.set(nameBytes, 30);
                localParts.push(local, isBlob(originalData) ? originalData : dataBytes);

                const central = new Uint8Array(46 + nameBytes.length);
                writeU32(central, 0, 0x02014b50);
                writeU16(central, 4, 20);
                writeU16(central, 6, 20);
                writeU16(central, 8, 0x0800);
                writeU16(central, 10, 0);
                writeU16(central, 12, now.time);
                writeU16(central, 14, now.date);
                writeU32(central, 16, crc);
                writeU32(central, 20, dataBytes.length);
                writeU32(central, 24, dataBytes.length);
                writeU16(central, 28, nameBytes.length);
                writeU32(central, 42, offset);
                central.set(nameBytes, 46);
                centralParts.push(central);

                offset += local.length + dataBytes.length;
            }

            const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
            const end = new Uint8Array(22);
            writeU32(end, 0, 0x06054b50);
            writeU16(end, 8, this.files.length);
            writeU16(end, 10, this.files.length);
            writeU32(end, 12, centralSize);
            writeU32(end, 16, offset);

            const all = [...localParts, ...centralParts, end];
            if (options.type === 'uint8array') return concat(all.map(toBytesResult => {
                if (isBlob(toBytesResult)) throw new Error('Uint8Array-Ausgabe unterstützt keine Blob-Dateien');
                return toBytesResult;
            }), offset + centralSize + end.length);
            return new Blob(all, { type: options.mimeType || 'application/zip' });
        }
    }

    global.SchachtZip = { ZipWriter, dataUrlToBytes, dataUrlMime, isBlob };
})(window);
