/* =============================================================
   WiControl QA - Offscreen media recorder

   The offscreen document owns the MediaStream/MediaRecorder. Final
   blobs are persisted in IndexedDB because chrome.runtime messages do
   not transport Blob instances reliably and Base64 is unnecessarily
   expensive. The background receives only an ID and safe metadata.
   ============================================================= */

'use strict';

const MEDIA_DB_NAME = 'wicontrol-qa-media';
const MEDIA_DB_VERSION = 1;
const RECORDINGS_STORE = 'recordings';
const RECORDING_TTL_MS = 24 * 60 * 60 * 1000;

const DATA_SLICE_MS = 1_000;
const PROGRESS_INTERVAL_MS = 1_000;
const RECORDER_EVENT_TIMEOUT_MS = 5_000;

const VIDEO_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm'
];

let activeRecording = null;
let databasePromise = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  const type = normalizeMessageType(message.type);
  const supportedTypes = new Set([
    'START_TAB_RECORDING',
    'PAUSE_RECORDING',
    'RESUME_RECORDING',
    'STOP_RECORDING',
    'CANCEL_RECORDING',
    'GET_RECORDER_STATE',
    'DELETE_RECORDING'
  ]);

  if (!supportedTypes.has(type)) return false;

  dispatchMessage(type, message)
    .then(sendResponse)
    .catch((error) => {
      const serializedError = serializeError(error);
      emitToBackground('RECORDER_ERROR', {
        recordingId: message.recordingId || activeRecording?.recordingId || null,
        sessionId: message.sessionId || activeRecording?.sessionId || null,
        error: serializedError
      });
      sendResponse({ success: false, error: serializedError });
    });

  return true;
});

// Expired blobs are best-effort cleanup. A failure here must never prevent capture.
void deleteExpiredRecordings().catch(() => undefined);

function normalizeMessageType(type) {
  // Temporary compatibility with the original background implementation.
  if (type === 'startRecording') return 'START_TAB_RECORDING';
  if (type === 'stopRecording') return 'STOP_RECORDING';
  return type;
}

async function dispatchMessage(type, message) {
  switch (type) {
    case 'START_TAB_RECORDING':
      return startRecording('tab_video', message);
    case 'PAUSE_RECORDING':
      return pauseRecording(message);
    case 'RESUME_RECORDING':
      return resumeRecording(message);
    case 'STOP_RECORDING':
      return stopRecording(message);
    case 'CANCEL_RECORDING':
      return cancelRecording(message);
    case 'GET_RECORDER_STATE':
      return { success: true, ...getRecorderState() };
    case 'DELETE_RECORDING':
      return deleteRecording(message);
    default:
      throw createRecorderError('UNSUPPORTED_MESSAGE', 'Comando de gravação não suportado.');
  }
}

async function startRecording(mode, message) {
  if (activeRecording) {
    throw createRecorderError(
      'RECORDER_BUSY',
      'Já existe uma gravação em andamento.',
      { activeRecordingId: activeRecording.recordingId }
    );
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw createRecorderError(
      'MEDIA_RECORDER_UNAVAILABLE',
      'A captura de mídia não está disponível neste navegador.'
    );
  }

  if (!message.streamId || typeof message.streamId !== 'string') {
    throw createRecorderError('STREAM_ID_REQUIRED', 'O streamId da aba é obrigatório.');
  }

  const session = createSession(mode, message);
  activeRecording = session;

  // Do not await housekeeping before consuming a short-lived tab streamId.
  void deleteExpiredRecordings().catch(() => undefined);

  try {
    session.stream = await getTabStream(
      message.streamId,
      message.includeAudio === true || message.captureAudio === true
    );

    if (activeRecording !== session || session.cancelRequested) {
      stopTracks(session.stream);
      throw createRecorderError('RECORDING_CANCELLED', 'A gravação foi cancelada antes de iniciar.');
    }

    session.recorder = createMediaRecorder(session.stream, mode, message);
    session.mimeType = session.recorder.mimeType || '';
    bindRecorderEvents(session);
    bindTrackEvents(session);

    session.recorder.start(DATA_SLICE_MS);

    const startedState = await withTimeout(
      session.started.promise,
      RECORDER_EVENT_TIMEOUT_MS,
      () => createRecorderError('START_TIMEOUT', 'O gravador não confirmou a inicialização.')
    );

    if (session.stopRequested && session.recorder.state !== 'inactive') {
      requestRecorderStop(session, session.stopReason || 'user');
    }

    return { success: true, recording: startedState };
  } catch (error) {
    const wasCancelled = session.cancelRequested || error?.code === 'RECORDING_CANCELLED';
    if (!session.startedAt) await discardSession(session);

    if (wasCancelled) {
      const result = {
        success: true,
        state: 'cancelled',
        cancelled: true,
        ...sessionIdentity(session)
      };
      emitToBackground('RECORDER_CANCELLED', result);
      session.finalized.resolve(result);
      return result;
    }

    throw normalizeCaptureError(error, mode);
  }
}

async function getTabStream(streamId, includeAudio) {
  // A streamId is short-lived and single-use, so this is deliberately the first
  // awaited capture operation in START_TAB_RECORDING.
  const videoSource = {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId
    }
  };
  const audioSource = includeAudio
    ? {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    : false;

  return navigator.mediaDevices.getUserMedia({
    audio: audioSource,
    video: videoSource
  });
}

function createSession(mode, message) {
  return {
    recordingId: validIdentifier(message.recordingId) || crypto.randomUUID(),
    sessionId: validIdentifier(message.sessionId) || crypto.randomUUID(),
    mode,
    kind: 'video',
    sourceTabId: Number.isInteger(message.sourceTabId) ? message.sourceTabId : null,
    sourcePageUrl: safeString(message.sourcePageUrl, 2_048),
    stream: null,
    recorder: null,
    mimeType: '',
    chunks: [],
    sizeBytes: 0,
    startedAt: null,
    startedMonotonic: null,
    pausedStartedMonotonic: null,
    pausedDurationMs: 0,
    state: 'starting',
    stopReason: null,
    stopRequested: false,
    cancelRequested: false,
    limitReached: false,
    terminalError: null,
    finalizing: false,
    cleaningTracks: false,
    progressTimer: null,
    started: deferred(),
    paused: null,
    resumed: null,
    finalized: deferred()
  };
}

function createRecorderOptions(preferredMimeType, message) {
  const options = {};
  if (preferredMimeType) options.mimeType = preferredMimeType;

  const requestedVideoBitrate = Number(message.videoBitsPerSecond);
  if (Number.isFinite(requestedVideoBitrate) && requestedVideoBitrate > 0) {
    options.videoBitsPerSecond = Math.round(requestedVideoBitrate);
  }

  return options;
}

function createMediaRecorder(stream, mode, message) {
  const candidates = videoMimeTypesForStream(stream);
  const supportedTypes = typeof MediaRecorder.isTypeSupported === 'function'
    ? candidates.filter((type) => MediaRecorder.isTypeSupported(type))
    : [];
  let lastError = null;

  // Even after isTypeSupported(), a particular stream/codec combination can
  // fail in the constructor. Try every supported option, then browser default.
  for (const mimeType of [...supportedTypes, '']) {
    try {
      return new MediaRecorder(stream, createRecorderOptions(mimeType, message));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || createRecorderError(
    'MEDIA_TYPE_NOT_SUPPORTED',
    'Nenhum formato de gravação compatível foi encontrado.'
  );
}

function videoMimeTypesForStream(stream) {
  const hasAudio = (stream.getAudioTracks?.() || stream.getTracks()).some(
    (track) => track.kind === 'audio'
  );
  if (hasAudio) return VIDEO_MIME_TYPES;
  return VIDEO_MIME_TYPES.filter((type) => !type.includes(',opus'));
}

function bindRecorderEvents(session) {
  const recorder = session.recorder;

  recorder.addEventListener('start', () => {
    session.startedAt = Date.now();
    session.startedMonotonic = performance.now();
    session.state = session.cancelRequested ? 'stopping' : 'recording';

    const state = snapshotSession(session);
    session.started.resolve(state);

    if (session.cancelRequested) {
      requestRecorderStop(session, 'cancelled');
      return;
    }

    startProgressTimers(session);
    emitToBackground('RECORDER_STARTED', state);
  }, { once: true });

  recorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size === 0 || session.cancelRequested) return;

    session.chunks.push(event.data);
    session.sizeBytes += event.data.size;
  });

  recorder.addEventListener('pause', () => {
    if (session.state === 'stopping') return;
    session.pausedStartedMonotonic ??= performance.now();
    session.state = 'paused';
    const state = snapshotSession(session);
    session.paused?.resolve(state);
    session.paused = null;
    emitToBackground('RECORDER_PAUSED', state);
  });

  recorder.addEventListener('resume', () => {
    if (session.state === 'stopping') return;
    finishPauseWindow(session);
    session.state = 'recording';
    const state = snapshotSession(session);
    session.resumed?.resolve(state);
    session.resumed = null;
    emitToBackground('RECORDER_RESUMED', state);
  });

  recorder.addEventListener('error', (event) => {
    session.terminalError = normalizeCaptureError(
      event.error || createRecorderError('MEDIA_RECORDER_ERROR', 'Falha durante a gravação.'),
      session.mode
    );
    session.started.reject(session.terminalError);
    emitToBackground('RECORDER_ERROR', {
      ...sessionIdentity(session),
      error: serializeError(session.terminalError)
    });
    requestRecorderStop(session, 'error');
  });

  recorder.addEventListener('stop', () => {
    void finalizeSession(session);
  }, { once: true });
}

function bindTrackEvents(session) {
  for (const track of session.stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (session.cleaningTracks || session.finalizing || session.cancelRequested) return;
      if (activeRecording !== session || session.recorder?.state === 'inactive') return;
      if (
        session.mode === 'tab_video' &&
        track.kind === 'audio' &&
        session.stream.getVideoTracks().some((videoTrack) => videoTrack.readyState === 'live')
      ) {
        return;
      }
      requestRecorderStop(session, 'track_ended');
    });
  }
}

function startProgressTimers(session) {
  session.progressTimer = setInterval(() => {
    if (activeRecording !== session || session.finalizing) return;
    emitToBackground('RECORDER_PROGRESS', snapshotSession(session));
  }, PROGRESS_INTERVAL_MS);
}

async function pauseRecording(message) {
  const session = requireMatchingSession(message);

  if (session.state === 'paused' || session.recorder?.state === 'paused') {
    return { success: true, recording: snapshotSession(session), alreadyPaused: true };
  }
  if (session.state !== 'recording' || session.recorder?.state !== 'recording') {
    throw createRecorderError('INVALID_RECORDER_STATE', 'A gravação não pode ser pausada agora.');
  }

  session.paused = deferred();
  session.pausedStartedMonotonic = performance.now();
  session.recorder.pause();

  const state = await withTimeout(
    session.paused.promise,
    RECORDER_EVENT_TIMEOUT_MS,
    () => createRecorderError('PAUSE_TIMEOUT', 'O gravador não confirmou a pausa.')
  );
  return { success: true, recording: state };
}

async function resumeRecording(message) {
  const session = requireMatchingSession(message);

  if (session.state === 'recording' || session.recorder?.state === 'recording') {
    return { success: true, recording: snapshotSession(session), alreadyRecording: true };
  }
  if (session.state !== 'paused' || session.recorder?.state !== 'paused') {
    throw createRecorderError('INVALID_RECORDER_STATE', 'A gravação não pode ser retomada agora.');
  }

  session.resumed = deferred();
  session.recorder.resume();

  const state = await withTimeout(
    session.resumed.promise,
    RECORDER_EVENT_TIMEOUT_MS,
    () => createRecorderError('RESUME_TIMEOUT', 'O gravador não confirmou a retomada.')
  );
  return { success: true, recording: state };
}

async function stopRecording(message) {
  if (!activeRecording) {
    return { success: true, state: 'idle', alreadyStopped: true };
  }

  const session = requireMatchingSession(message);
  if (session.finalizing || session.recorder?.state === 'inactive') {
    return session.finalized.promise;
  }

  session.stopRequested = true;
  session.stopReason = validIdentifier(message.reason) || 'user';

  if (!session.recorder) {
    // getUserMedia cannot be aborted. Mark the session and dispose of the stream
    // as soon as the permission request settles.
    session.cancelRequested = true;
    return { success: true, ...snapshotSession(session), pendingCaptureCancellation: true };
  }

  requestRecorderStop(session, session.stopReason);
  return session.finalized.promise;
}

async function cancelRecording(message) {
  if (!activeRecording) {
    if (validIdentifier(message.recordingId)) {
      await deleteRecordingById(message.recordingId);
    }
    return { success: true, state: 'idle', alreadyCancelled: true };
  }

  const session = requireMatchingSession(message);
  session.cancelRequested = true;
  session.stopReason = 'cancelled';

  if (!session.recorder) {
    return { success: true, ...snapshotSession(session), pendingCaptureCancellation: true };
  }

  if (session.recorder.state !== 'inactive') {
    requestRecorderStop(session, 'cancelled');
    return session.finalized.promise;
  }

  await discardSession(session);
  return { success: true, state: 'idle', cancelled: true };
}

function requestRecorderStop(session, reason) {
  if (session.finalizing || !session.recorder || session.recorder.state === 'inactive') return;

  session.stopReason ||= reason;
  session.stopRequested = true;
  session.state = 'stopping';
  clearSessionTimers(session);

  try {
    session.recorder.stop();
  } catch (error) {
    session.terminalError = normalizeCaptureError(error, session.mode);
    void finalizeSession(session);
  }
}

async function finalizeSession(session) {
  if (session.finalizing) return session.finalized.promise;
  session.finalizing = true;
  clearSessionTimers(session);
  finishPauseWindow(session);

  const durationMs = getActiveDurationMs(session);
  let result;

  try {
    if (session.cancelRequested) {
      await deleteRecordingById(session.recordingId);
      result = {
        success: true,
        ...finalMetadata(session, durationMs, 0),
        state: 'cancelled',
        cancelled: true
      };
    } else if (session.terminalError) {
      throw session.terminalError;
    } else {
      const blob = new Blob(session.chunks, {
        type: session.mimeType || session.chunks[0]?.type || 'application/octet-stream'
      });

      if (blob.size === 0) {
        throw createRecorderError('EMPTY_RECORDING', 'Nenhum dado de mídia foi gravado.');
      }

      const metadata = finalMetadata(session, durationMs, blob.size);
      const now = Date.now();
      const record = {
        ...metadata,
        blob,
        createdAt: now,
        expiresAt: now + RECORDING_TTL_MS
      };
      await putRecording(record);

      result = {
        success: true,
        state: 'stopped',
        storage: { database: MEDIA_DB_NAME, store: RECORDINGS_STORE, key: session.recordingId },
        recording: metadata
      };
    }
  } catch (error) {
    const normalizedError = normalizeCaptureError(error, session.mode);
    await deleteRecordingById(session.recordingId).catch(() => undefined);
    emitToBackground('RECORDER_ERROR', {
      ...sessionIdentity(session),
      error: serializeError(normalizedError)
    });
    result = {
      success: false,
      state: 'error',
      recordingId: session.recordingId,
      sessionId: session.sessionId,
      error: serializeError(normalizedError)
    };
  } finally {
    session.cleaningTracks = true;
    stopTracks(session.stream);
    session.chunks.length = 0;
    session.sizeBytes = 0;
    if (activeRecording === session) activeRecording = null;
  }

  if (result.cancelled) {
    emitToBackground('RECORDER_CANCELLED', result);
  } else if (result.success && result.recording) {
    emitToBackground('RECORDER_STOPPED', {
      success: true,
      ...result.recording,
      state: result.state,
      storage: result.storage
    });
  }
  session.finalized.resolve(result);
  return result;
}

async function discardSession(session) {
  clearSessionTimers(session);
  session.cleaningTracks = true;

  if (session.recorder && session.recorder.state !== 'inactive') {
    try {
      session.recorder.stop();
    } catch (_) {
      // Recorder may already be transitioning to inactive.
    }
  }

  stopTracks(session.stream);
  session.chunks.length = 0;
  session.sizeBytes = 0;
  await deleteRecordingById(session.recordingId).catch(() => undefined);
  if (activeRecording === session) activeRecording = null;
}

function requireMatchingSession(message) {
  const session = activeRecording;
  if (!session) throw createRecorderError('NO_ACTIVE_RECORDING', 'Não há gravação em andamento.');

  if (message.recordingId && message.recordingId !== session.recordingId) {
    throw createRecorderError('STALE_RECORDING', 'A mensagem pertence a outra gravação.');
  }
  if (message.sessionId && message.sessionId !== session.sessionId) {
    throw createRecorderError('STALE_SESSION', 'A mensagem pertence a outra sessão.');
  }
  return session;
}

function getRecorderState() {
  if (!activeRecording) return { state: 'idle', active: false, recording: null };
  return { state: activeRecording.state, active: true, recording: snapshotSession(activeRecording) };
}

function snapshotSession(session) {
  const durationMs = getActiveDurationMs(session);
  return {
    ...sessionIdentity(session),
    state: session.state,
    mimeType: session.mimeType,
    startedAt: session.startedAt,
    durationMs,
    sizeBytes: session.sizeBytes,
    sourceTabId: session.sourceTabId,
    sourcePageUrl: session.sourcePageUrl,
    paused: session.state === 'paused',
    limits: null
  };
}

function finalMetadata(session, durationMs, sizeBytes) {
  const mimeType = session.mimeType || 'application/octet-stream';
  return {
    ...sessionIdentity(session),
    sourceTabId: session.sourceTabId,
    sourcePageUrl: session.sourcePageUrl,
    mimeType,
    sizeBytes,
    durationMs,
    startedAt: session.startedAt,
    stoppedAt: Date.now(),
    stopReason: session.stopReason || 'user',
    limitReached: session.limitReached,
    fileName: `${session.recordingId}.${extensionForMimeType(mimeType, session.kind)}`
  };
}

function sessionIdentity(session) {
  return {
    recordingId: session.recordingId,
    sessionId: session.sessionId,
    mode: session.mode,
    kind: session.kind
  };
}

function getActiveDurationMs(session) {
  if (session.startedMonotonic === null) return 0;
  const now = performance.now();
  const currentPauseMs = session.pausedStartedMonotonic === null
    ? 0
    : now - session.pausedStartedMonotonic;
  return Math.max(0, Math.round(
    now - session.startedMonotonic - session.pausedDurationMs - currentPauseMs
  ));
}

function finishPauseWindow(session) {
  if (session.pausedStartedMonotonic === null) return;
  session.pausedDurationMs += performance.now() - session.pausedStartedMonotonic;
  session.pausedStartedMonotonic = null;
}

function clearSessionTimers(session) {
  if (session.progressTimer !== null) clearInterval(session.progressTimer);
  session.progressTimer = null;
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try {
      track.stop();
    } catch (_) {
      // A track can already be ended.
    }
  }
}

function emitToBackground(type, payload = {}) {
  try {
    chrome.runtime.sendMessage({ target: 'background', type, ...payload }, () => {
      // Reading lastError prevents noisy console errors when the service worker
      // is not listening yet; recorder state remains available via GET_STATE.
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // The document may be shutting down. The persisted recording remains in IDB.
  }
}

function normalizeCaptureError(error, mode) {
  if (error?.code) return error;

  const name = error?.name || 'Error';
  const errorCodes = {
    NotAllowedError: 'TAB_CAPTURE_PERMISSION_DENIED',
    NotFoundError: 'TAB_CAPTURE_NOT_FOUND',
    NotReadableError: 'MEDIA_DEVICE_BUSY',
    AbortError: 'MEDIA_CAPTURE_ABORTED',
    OverconstrainedError: 'MEDIA_CONSTRAINT_UNAVAILABLE',
    NotSupportedError: 'MEDIA_TYPE_NOT_SUPPORTED',
    SecurityError: 'MEDIA_CAPTURE_BLOCKED'
  };

  return createRecorderError(
    errorCodes[name] || 'RECORDER_FAILURE',
    safeErrorMessage(error, 'Não foi possível concluir a gravação.'),
    { name }
  );
}

function createRecorderError(code, message, details) {
  const error = new Error(message);
  error.name = 'RecorderError';
  error.code = code;
  if (details) error.details = details;
  return error;
}

function serializeError(error) {
  return {
    code: error?.code || 'RECORDER_FAILURE',
    name: error?.name || 'Error',
    message: safeErrorMessage(error, 'Falha desconhecida no gravador.'),
    ...(error?.details ? { details: error.details } : {})
  };
}

function safeErrorMessage(error, fallback) {
  return typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : fallback;
}

function validIdentifier(value) {
  return safeString(value, 128) || null;
}

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function extensionForMimeType(mimeType, kind) {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, createTimeoutError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(createTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function openMediaDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
        const store = database.createObjectStore(RECORDINGS_STORE, { keyPath: 'recordingId' });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    });
    request.addEventListener('success', () => {
      const database = request.result;
      database.addEventListener('versionchange', () => {
        database.close();
        databasePromise = null;
      });
      resolve(database);
    });
    request.addEventListener('error', () => {
      databasePromise = null;
      reject(createRecorderError(
        'MEDIA_STORE_UNAVAILABLE',
        'Não foi possível abrir o armazenamento temporário de mídia.'
      ));
    });
    request.addEventListener('blocked', () => {
      databasePromise = null;
      reject(createRecorderError(
        'MEDIA_STORE_BLOCKED',
        'O armazenamento temporário de mídia está bloqueado por outra versão da extensão.'
      ));
    });
  });

  return databasePromise;
}

async function putRecording(record) {
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');
    transaction.objectStore(RECORDINGS_STORE).put(record);
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(createRecorderError(
      'MEDIA_STORE_WRITE_FAILED',
      'Não foi possível salvar a gravação temporária.'
    )));
    transaction.addEventListener('error', () => reject(createRecorderError(
      'MEDIA_STORE_WRITE_FAILED',
      'Não foi possível salvar a gravação temporária.'
    )));
  });
}

async function deleteRecording(message) {
  const recordingId = validIdentifier(message.recordingId);
  if (!recordingId) {
    throw createRecorderError('RECORDING_ID_REQUIRED', 'O recordingId é obrigatório.');
  }
  if (activeRecording?.recordingId === recordingId) {
    throw createRecorderError('RECORDING_ACTIVE', 'Cancele a gravação antes de removê-la.');
  }
  await deleteRecordingById(recordingId);
  return { success: true, recordingId, deleted: true };
}

async function deleteRecordingById(recordingId) {
  if (!recordingId) return;
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');
    transaction.objectStore(RECORDINGS_STORE).delete(recordingId);
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
}

async function deleteExpiredRecordings() {
  const database = await openMediaDatabase();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');
    const request = transaction.objectStore(RECORDINGS_STORE).openCursor();

    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) return;
      if (Number(cursor.value?.expiresAt) <= now) cursor.delete();
      cursor.continue();
    });
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
}
