const DB_NAME = 'wicontrol-qa-media';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falha no IndexedDB.'));
  });
}

export function openMediaDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'recordingId' });
        store.createIndex('expiresAt', 'expiresAt');
        store.createIndex('sessionId', 'sessionId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento de mídia.'));
  });
}

async function withStore(mode, callback) {
  const database = await openMediaDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Falha na transação de mídia.'));
      transaction.onabort = () => reject(transaction.error || new Error('Transação de mídia cancelada.'));
    });
    const result = await callback(transaction.objectStore(STORE_NAME));
    await completed;
    return result;
  } finally {
    database.close();
  }
}

export function getRecording(recordingId) {
  return withStore('readonly', (store) => requestAsPromise(store.get(recordingId)));
}

export function putRecording(record) {
  return withStore('readwrite', (store) => requestAsPromise(store.put(record)));
}

export function deleteRecording(recordingId) {
  return withStore('readwrite', (store) => requestAsPromise(store.delete(recordingId)));
}

export function listRecordings() {
  return withStore('readonly', (store) => requestAsPromise(store.getAll()));
}

export async function pruneExpiredRecordings(now = Date.now()) {
  const all = await listRecordings();
  const expired = all.filter((record) => Number(record.expiresAt || 0) > 0 && record.expiresAt <= now);
  await Promise.all(expired.map((record) => deleteRecording(record.recordingId)));
  return expired.map((record) => record.recordingId);
}

export async function dataUrlToRecording(dataUrl, metadata = {}) {
  const response = await fetch(dataUrl);
  return blobToRecording(await response.blob(), metadata);
}

export async function blobToRecording(blob, metadata = {}) {
  const recordingId = metadata.recordingId || crypto.randomUUID();
  const now = Date.now();
  const record = {
    recordingId,
    sessionId: metadata.sessionId || recordingId,
    kind: metadata.kind || 'image',
    mode: metadata.mode || 'screenshot',
    blob,
    mimeType: blob.type || metadata.mimeType || 'image/png',
    sizeBytes: blob.size,
    durationMs: metadata.durationMs || 0,
    createdAt: now,
    expiresAt: metadata.expiresAt || now + 24 * 60 * 60 * 1000,
    stopReason: metadata.stopReason || 'captured',
    fileName: metadata.fileName || `screenshot-${now}.png`,
    sourceTabId: metadata.sourceTabId ?? null,
  };
  await putRecording(record);
  return record;
}
