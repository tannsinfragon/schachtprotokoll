'use strict';

window.AppConfig = Object.freeze({
    version: '2.8.9',
    schemaVersion: 3,
    company: '',
    photo: Object.freeze({
        maxEdge: 1600,
        jpegQuality: 0.82,
        maxFilesPerRecord: 20,
        maxInputBytes: 25 * 1024 * 1024,
        maxPixels: 40 * 1000 * 1000
    }),
    import: Object.freeze({
        maxFileBytes: 150 * 1024 * 1024,
        largeFileWarningBytes: 75 * 1024 * 1024,
        maxRecords: 500,
        maxTextChars: 5000,
        maxPhotosPerRecord: 20,
        maxDataUrlChars: 15 * 1024 * 1024,
        maxLeitungenPerRecord: 100,
        maxStrokesPerRecord: 1000
    }),
    storage: Object.freeze({
        quotaWarnRatio: 0.85,
        backupReminderDays: 30,
        maxExportMediaBytes: 250 * 1024 * 1024
    })
});
