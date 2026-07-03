'use strict';

window.CSVTools = (() => {
    function parse(text, delimiter = ';') {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        const input = String(text ?? '').replace(/^\uFEFF/, '');

        for (let i = 0; i < input.length; i++) {
            const char = input[i];
            const next = input[i + 1];

            if (char === '"') {
                if (inQuotes && next === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }

            if (!inQuotes && char === delimiter) {
                row.push(field);
                field = '';
                continue;
            }

            if (!inQuotes && (char === '\n' || char === '\r')) {
                if (char === '\r' && next === '\n') i++;
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
                continue;
            }

            field += char;
        }

        if (field !== '' || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        return rows;
    }

    function escapeCell(value) {
        const text = String(value ?? '');
        const safeText = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
        return `"${safeText.replace(/"/g, '""')}"`;
    }

    function stringify(rows, delimiter = ';') {
        return rows.map(row => row.map(escapeCell).join(delimiter)).join('\r\n');
    }

    return { parse, stringify };
})();
