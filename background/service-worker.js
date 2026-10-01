import {
  QaApiClient,
  QaApiError,
  publicConfig,
  rebaseStorageUrl,
  sanitizeConfig,
  uploadToSignedUrl,
  verifyClientAccessPassword,
} from '../shared/api-client.js';
import {
  STORAGE_KEYS,
  makeRecorderState,
  validateDraft,
} from '../shared/contracts.js';
import {
  blobToRecording,
  dataUrlToRecording,
  deleteRecording,
  getRecording,
  pruneExpiredRecordings,
} from '../shared/media-store.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const BACKGROUND_PROTOCOL_VERSION = 7;
// Chaves deixadas pelo ditado por voz, que foi removido da extensão.
const REMOVED_AUDIO_STORAGE_KEYS = ['wiqaTranscriptionState', 'wiqaVoiceConsent'];
// Capturas em telas HiDPI passam de 5000px de largura; 2560px no maior lado
// mantém texto legível e deixa o WebP na casa das centenas de KB.
const IMAGE_MAX_DIMENSION = 2560;
const IMAGE_WEBP_QUALITY = 0.82;
const VIEWPORT_STORAGE_KEY = 'wiqaViewports';
const VIEWPORT_PRESETS = Object.freeze({
  full: { label: 'Tela inteira' },
  desktop: { label: 'Desktop', width: 1440, height: 900 },
  tablet: { label: 'Tablet', width: 820, height: 1180 },
  mobile: { label: 'Mobile', width: 390, height: 844 },
  // Tamanho do design carregado no Fiscal do Pixel; largura e altura vêm da imagem.
  design: { label: 'Design' },
});
const DESIGN_VIEWPORT_LIMITS = Object.freeze({ minWidth: 240, maxWidth: 2560, minHeight: 200, maxHeight: 2560 });
const diagnosticQueues = new Map();
const diagnosticDraftIds = new Map();
const networkRequests = new Map();
const uploadTasks = new Map();
let creatingOffscreen = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  void storeTabViewport(tabId, 'full');
});

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (details.tabId < 0) return;
    networkRequests.set(details.requestId, {
      tabId: details.tabId,
      draftId: diagnosticDraftIds.get(details.tabId) || '',
      startedAt: details.timeStamp,
      method: details.method,
      url: sanitizeDiagnosticUrl(details.url),
      resource_type: details.type,
    });
  }, { urls: ['http://*/*', 'https://*/*'] });

  chrome.webRequest.onCompleted.addListener((details) => {
    void finishBrowserRequest(details, null);
  }, { urls: ['http://*/*', 'https://*/*'] });

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    void finishBrowserRequest(details, details.error || 'Falha de rede');
  }, { urls: ['http://*/*', 'https://*/*'] });
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  dispatchMessage(message, sender)
    .then((result) => sendResponse(result ?? { success: true }))
    .catch(async (error) => {
      error = await handleAuthFailure(error).catch(() => error);
      console.error('WiControl QA:', safeErrorForLog(error));
      const payload = errorPayload(error);
      void broadcast('WI_QA_ERROR', payload);
      sendResponse({ success: false, error: payload });
    });

  return true;
});

async function initializeExtension() {
  try {
    await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('WiControl QA: não foi possível configurar o Side Panel.', safeErrorForLog(error));
  }

  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (error) {
    console.warn('WiControl QA: não foi possível restringir storage.local.', safeErrorForLog(error));
  }

  try {
    const removedIds = await pruneExpiredRecordings();
    if (removedIds.length) await removeMediaMetadata(removedIds);
    await removeLeftoverAudio();
  } catch (error) {
    console.warn('WiControl QA: limpeza de mídia pendente falhou.', safeErrorForLog(error));
  }

  await reconcileRecorderState();
}

// Ditados gravados antes da remoção do áudio não podem mais ser enviados.
async function removeLeftoverAudio() {
  await chrome.storage.local.remove(REMOVED_AUDIO_STORAGE_KEYS);
  const audio = (await getMediaMetadata()).filter((entry) => entry.kind === 'audio');
  if (!audio.length) return;
  await Promise.all(audio.map((entry) => deleteRecording(entry.recordingId).catch(() => undefined)));
  await removeMediaMetadata(audio.map((entry) => entry.recordingId));
}

async function dispatchMessage(message, sender) {
  switch (message.type) {
    case 'WI_QA_GET_CONTEXT':
      return getContext();
    case 'WI_QA_VALIDATE_CONFIG':
      return validateAndSaveConfig(message.payload?.config || message.config || message.payload || {});
    case 'WI_QA_DISCONNECT':
      return disconnectProject();
    case 'WI_QA_SAVE_DRAFT':
      return saveDraft(message.payload?.draft || message.draft || message.payload || {});
    case 'WI_QA_DIAGNOSTIC_EVENT':
      return appendDiagnosticEvent(sender.tab?.id, message.payload?.event || message.event, {
        draftId: message.payload?.draftId || message.draftId || '',
      });
    case 'WI_QA_SELECT_ELEMENT':
      return selectPageElement(message.payload?.draftId || message.draftId || '');
    case 'WI_QA_START_DIAGNOSTICS':
      return startActiveDiagnostics(message.payload?.draftId || message.draftId || '');
    case 'WI_QA_CLEAR_DIAGNOSTICS':
      return clearActiveDiagnostics(message.payload?.draftId || message.draftId || '');
    case 'WI_QA_CAPTURE_SCREENSHOT':
    case 'takeScreenshot':
      return takeScreenshot();
    case 'WI_QA_SAVE_SCREENSHOT':
    case 'saveCropResult':
      return saveScreenshot(message.dataUrl || message.payload?.dataUrl, sender);
    case 'WI_QA_VIDEO_START':
    case 'startRecording':
      return startVideoRecording(message);
    case 'WI_QA_VIDEO_STOP':
    case 'stopRecording':
      return stopRecorder(message.sessionId || message.payload?.sessionId, 'user');
    case 'WI_QA_VIDEO_PAUSE':
      return controlRecorder('PAUSE_RECORDING', message);
    case 'WI_QA_VIDEO_RESUME':
      return controlRecorder('RESUME_RECORDING', message);
    case 'WI_QA_VIDEO_CANCEL':
      return cancelRecorder(message.sessionId || message.payload?.sessionId);
    case 'WI_QA_MEDIA_REMOVE':
      return removeMedia(message.payload?.recordingId || message.recordingId || message.payload?.id);
    case 'WI_QA_DRAFT_RESET':
      return resetDraft(message.payload || message);
    case 'WI_QA_CREATE_ITEM':
      return createQaItem(message.payload?.draft || message.draft || message.payload || {});
    case 'WI_QA_LIST_ITEMS':
      return listQaItems();
    case 'WI_QA_SET_VIEWPORT':
      return setViewportPreset(
        message.payload?.preset || message.preset,
        message.payload?.tabId ?? message.tabId ?? sender.tab?.id,
        message.payload?.size || message.size,
      );
    case 'WI_QA_VIEWPORT_CLOSED':
      return closeViewportFromContent(sender.tab?.id);
    case 'WI_QA_VIEWPORT_FRAME_READY':
      return ensureFrameDiagnostics(sender.tab?.id);
    case 'WI_QA_PIXEL_INSPECTOR_START':
      return startPixelInspector();
    case 'WI_QA_PIXEL_INSPECTOR_STOP':
      return stopPixelInspector();
    case 'WI_QA_PIXEL_INSPECTOR_CLOSED':
      await broadcast('WI_QA_PIXEL_INSPECTOR_STATE', { tabId: sender.tab?.id ?? null, active: false });
      return { success: true };
    case 'WI_QA_PIXEL_CAPTURE':
      return capturePixelEvidence(sender);
    case 'RECORDER_STARTED':
      return onRecorderStarted(message);
    case 'RECORDER_PROGRESS':
      return onRecorderProgress(message);
    case 'RECORDER_PAUSED':
      return onRecorderPaused(message, true);
    case 'RECORDER_RESUMED':
      return onRecorderPaused(message, false);
    case 'RECORDER_STOPPED':
      return onRecorderStopped(message);
    case 'RECORDER_CANCELLED':
      return onRecorderCancelled(message);
    case 'RECORDER_ERROR':
      return onRecorderError(message);
    case 'saveRecording':
      return saveLegacyRecording(message.dataUrl, sender);
    default:
      throw new QaApiError(`Operação desconhecida: ${String(message.type || '')}`, {
        code: 'UNKNOWN_MESSAGE',
        status: 400,
        retryable: false,
      });
  }
}

async function getContext() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.CONFIG,
    STORAGE_KEYS.PROJECT,
    STORAGE_KEYS.DRAFT,
    STORAGE_KEYS.MEDIA,
    STORAGE_KEYS.RECORDER,
    STORAGE_KEYS.LAST_ITEM,
    STORAGE_KEYS.CAPTURED_MEDIA_LEGACY,
  ]);
  const tab = await getActiveTab().catch(() => null);
  if (tab?.id && /^https?:\/\//i.test(tab.url || '')) {
    await ensureContentScript(tab.id).catch(() => undefined);
  }
  const diagnostics = tab?.id ? await getDiagnosticBundle(tab.id, false) : null;
  const config = stored[STORAGE_KEYS.CONFIG] || null;
  const activeDraftId = stored[STORAGE_KEYS.DRAFT]?.draftId || stored[STORAGE_KEYS.DRAFT]?.id || '';
  const visibleDiagnostics = diagnostics && (!diagnostics.draftId || diagnostics.draftId === activeDraftId)
    ? diagnostics
    : null;

  return {
    success: true,
    context: {
      protocolVersion: BACKGROUND_PROTOCOL_VERSION,
      config: config ? publicConfig(config) : null,
      sessionExpired: isClientSessionExpired(config),
      viewport: tab?.id ? await getTabViewport(tab.id) : 'full',
      viewportMode: tab?.id ? await getTabViewportMode(tab.id) : 'full',
      viewportActual: tab?.id ? viewportSize(await getTabViewportConfig(tab.id)) : null,
      project: stored[STORAGE_KEYS.PROJECT] || null,
      draft: stored[STORAGE_KEYS.DRAFT] || null,
      media: stored[STORAGE_KEYS.MEDIA] || [],
      recorder: stored[STORAGE_KEYS.RECORDER] || makeRecorderState(),
      lastItem: stored[STORAGE_KEYS.LAST_ITEM] || null,
      capturedMedia: stored[STORAGE_KEYS.CAPTURED_MEDIA_LEGACY] || null,
      tab: tab ? tabSummary(tab) : null,
      diagnostics: visibleDiagnostics ? diagnosticView(visibleDiagnostics) : null,
    },
  };
}

async function validateAndSaveConfig(rawConfig) {
  const config = sanitizeConfig(rawConfig);
  
  if (config.authMode === 'client' && rawConfig.clientPassword) {
    // Tenta gerar o token de sessão do convidado
    const session = await verifyClientAccessPassword(config.supabaseUrl, config.supabaseKey, rawConfig.clientPassword);
    config.clientAccessToken = session.token;
    config.clientAccessExpiresAt = session.expiresAt;
  } else if (config.authMode === 'client') {
    const previous = (await chrome.storage.local.get(STORAGE_KEYS.CONFIG))[STORAGE_KEYS.CONFIG];
    if (previous?.clientAccessToken === config.clientAccessToken) {
      config.clientAccessExpiresAt = previous.clientAccessExpiresAt || '';
    }
  }

  const client = new QaApiClient(config);
  const snapshot = await client.getSnapshot();
  if (!snapshot?.project?.id) {
    throw new QaApiError('A API não retornou um projeto válido.', {
      code: 'PROJECT_INVALID_RESPONSE',
      retryable: false,
    });
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.CONFIG]: config,
    [STORAGE_KEYS.PROJECT]: snapshot.project,
  });

  const context = await getContext();
  await broadcast('WI_QA_CONTEXT_UPDATED', context.context);
  return context;
}

async function disconnectProject() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.CONFIG,
    STORAGE_KEYS.PROJECT,
    STORAGE_KEYS.DRAFT,
  ]);
  await broadcast('WI_QA_CONTEXT_UPDATED', { config: null, project: null });
  return { success: true };
}

async function saveDraft(draft) {
  const normalized = normalizeDraft(draft);
  await chrome.storage.local.set({ [STORAGE_KEYS.DRAFT]: normalized });
  return { success: true, draft: normalized };
}

async function resetDraft(payload = {}) {
  const media = await getMediaMetadata();
  await Promise.all(media.map((entry) => deleteRecording(entry.recordingId).catch(() => undefined)));
  await chrome.storage.local.remove([
    STORAGE_KEYS.DRAFT,
    STORAGE_KEYS.MEDIA,
    STORAGE_KEYS.CAPTURED_MEDIA_LEGACY,
  ]);
  const nextDraftId = String(payload.nextDraftId || '');
  if (!nextDraftId) return { success: true, diagnostics: null };
  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) return { success: true, diagnostics: null };
  return startDiagnostics(tab.id, nextDraftId, { force: true });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new QaApiError('Nenhuma aba ativa foi encontrada.', {
      code: 'ACTIVE_TAB_NOT_FOUND',
      retryable: true,
    });
  }
  return tab;
}

async function getRequestedPageTab(tabId) {
  if (!Number.isInteger(tabId)) return getActiveTab();
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new QaApiError('A página vinculada ao QA não está mais aberta. Volte para a página e atualize o contexto.', {
      code: 'SOURCE_TAB_NOT_FOUND',
      retryable: true,
    });
  }
}

function tabSummary(tab) {
  return {
    id: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
  };
}

// Cliques no painel lateral não concedem activeTab. captureVisibleTab só aceita
// <all_urls> (acesso por site não basta) e tabCapture só funciona depois que a
// extensão é acionada na aba (ícone da barra). Traduz os erros crus do Chrome.
function pageAccessError(error) {
  const message = String(error?.message || error || '');
  if (/<all_urls>|Cannot access contents of|must request permission to access/i.test(message)) {
    return new QaApiError('A extensão ainda não tem acesso às páginas. Libere o acesso para capturar e selecionar elementos.', {
      code: 'PAGE_ACCESS_REQUIRED',
      retryable: false,
    });
  }
  if (/has not been invoked for the current page/i.test(message)) {
    return new QaApiError('Para gravar esta aba, clique no ícone do WiControl QA na barra do Chrome (com esta aba aberta) e depois em Gravar tela.', {
      code: 'TAB_CAPTURE_NOT_INVOKED',
      retryable: false,
    });
  }
  return error;
}

function assertInjectableTab(tab) {
  const url = String(tab.url || '');
  if (!/^https?:\/\//i.test(url)) {
    throw new QaApiError('Abra uma página HTTP ou HTTPS para usar a captura.', {
      code: 'TAB_NOT_INJECTABLE',
      retryable: false,
    });
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/observer.js'],
    world: 'MAIN',
  }).catch(() => undefined);

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'WI_QA_PING',
    });
    if (response?.success) return;
  } catch {
    // A injeção abaixo cobre abas que ainda não possuem o content script.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/injected.js'],
  }).catch((error) => { throw pageAccessError(error); });
}

async function takeScreenshot() {
  const tab = await getActiveTab();
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);
  const dataUrl = await captureTabImage(tab).catch((error) => { throw pageAccessError(error); });
  await chrome.tabs.sendMessage(tab.id, {
    target: 'content',
    type: 'initCrop',
    image: dataUrl,
  });
  return { success: true, tab: tabSummary(tab) };
}

async function saveScreenshot(dataUrl, sender, { filePrefix = 'screenshot' } = {}) {
  if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
    throw new QaApiError('A captura recebida é inválida.', {
      code: 'SCREENSHOT_INVALID',
      status: 400,
      retryable: false,
    });
  }

  const sourceTabId = sender?.tab?.id ?? (await getActiveTab()).id;
  const blob = await optimizeImage(dataUrl);
  const extension = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const record = await blobToRecording(blob, {
    kind: 'image',
    mode: 'screenshot',
    sourceTabId,
    fileName: `${filePrefix}-${Date.now()}.${extension}`,
  });
  const metadata = recordingMetadata(record, { status: 'uploading' });
  await upsertMediaMetadata(metadata);

  await chrome.storage.local.set({
    [STORAGE_KEYS.CAPTURED_MEDIA_LEGACY]: {
      type: 'image',
      dataUrl: await blobToDataUrl(blob),
      name: record.fileName,
      recordingId: record.recordingId,
    },
  });

  await broadcast('WI_QA_MEDIA_UPDATED', { media: await getMediaMetadata(), latest: metadata });
  void preuploadMedia(record.recordingId);
  return { success: true, media: metadata };
}

// Converte a captura para WebP e limita a resolução antes de qualquer upload.
// Se o encoder WebP não estiver disponível, mantém o arquivo original.
async function optimizeImage(dataUrl) {
  const source = await (await fetch(dataUrl)).blob();
  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: IMAGE_WEBP_QUALITY });
    return webp.type === 'image/webp' ? webp : source;
  } catch (error) {
    console.warn('WiControl QA: otimização da imagem falhou; enviando original.', safeErrorForLog(error));
    return source;
  } finally {
    bitmap?.close?.();
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// Sobe a imagem assim que ela é capturada, para que "Criar item" só precise
// vincular o anexo. Falhas aqui não são fatais: o envio tenta de novo.
async function preuploadMedia(recordingId) {
  try {
    const entry = (await getMediaMetadata()).find((item) => item.recordingId === recordingId);
    if (!entry || entry.remoteMediaId) return;
    const config = await requireConfig();
    await ensureMediaUploaded(entry, new QaApiClient(config), config);
  } catch (error) {
    await patchMediaIfPresent(recordingId, { status: 'local' });
    if (error?.status === 401) await handleAuthFailure(error).catch(() => undefined);
  }
}

async function startVideoRecording(message) {
  await assertNoActiveRecorder();
  const tab = await getActiveTab();
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);

  const sessionId = message.sessionId || message.payload?.sessionId || crypto.randomUUID();
  const recordingId = message.recordingId || message.payload?.recordingId || crypto.randomUUID();
  await setRecorderState(makeRecorderState({
    status: 'countdown',
    sessionId,
    recordingId,
    mode: 'tab_video',
    sourceTabId: tab.id,
    sourcePageUrl: tab.url || '',
  }));

  // Confere a permissão antes da contagem regressiva (sem activeTab a gravação
  // falharia só depois dela). O id expira em segundos, então este é descartado
  // e outro é pedido após a contagem.
  try {
    await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    await setRecorderState(makeRecorderState({ status: 'idle' }));
    throw pageAccessError(error);
  }
  await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'showCountdown' });
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const recorderResponse = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_TAB_RECORDING',
    sessionId,
    recordingId,
    streamId,
    sourceTabId: tab.id,
    sourcePageUrl: tab.url || '',
  });
  assertRecorderResponse(recorderResponse);

  return { success: true, sessionId, recordingId };
}

async function assertNoActiveRecorder() {
  const state = await currentRecorderState();
  if (state && !['idle', 'done', 'cancelled', 'error'].includes(state.status)) {
    throw new QaApiError('Já existe uma gravação em andamento.', {
      code: 'RECORDER_BUSY',
      status: 409,
      retryable: false,
    });
  }
}

async function controlRecorder(type, message) {
  const state = await currentRecorderState();
  const sessionId = message.sessionId || message.payload?.sessionId || state.sessionId;
  if (!sessionId || sessionId !== state.sessionId) {
    throw new QaApiError('A sessão de gravação não corresponde à sessão ativa.', {
      code: 'RECORDER_SESSION_MISMATCH',
      status: 409,
      retryable: false,
    });
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type, sessionId });
  return { success: true, sessionId };
}

async function stopRecorder(sessionId, reason = 'user') {
  const state = await currentRecorderState();
  const activeSessionId = sessionId || state.sessionId;
  if (!activeSessionId || !state.sessionId) return { success: true, alreadyStopped: true };
  if (activeSessionId !== state.sessionId) {
    throw new QaApiError('A sessão de gravação não corresponde à sessão ativa.', {
      code: 'RECORDER_SESSION_MISMATCH',
      status: 409,
      retryable: false,
    });
  }

  await setRecorderState({ ...state, status: 'stopping' });
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'STOP_RECORDING',
    sessionId: activeSessionId,
    reason,
  });
  return { success: true, sessionId: activeSessionId };
}

async function cancelRecorder(sessionId) {
  const state = await currentRecorderState();
  const activeSessionId = sessionId || state.sessionId;
  if (state.sourceTabId) {
    await chrome.tabs.sendMessage(state.sourceTabId, {
      target: 'content',
      type: 'hideRecordingBar',
    }).catch(() => undefined);
  }
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'CANCEL_RECORDING',
    sessionId: activeSessionId,
  }).catch(() => undefined);
  await setRecorderState(makeRecorderState({ status: 'cancelled' }));
  return { success: true };
}

async function onRecorderStarted(message) {
  const current = await currentRecorderState();
  if (current.sessionId && message.sessionId !== current.sessionId) return { success: false, stale: true };
  const state = makeRecorderState({
    ...current,
    status: 'recording',
    sessionId: message.sessionId,
    recordingId: message.recordingId || current.recordingId,
    mode: message.mode || current.mode,
    startedAt: message.startedAt || Date.now(),
    paused: false,
    error: null,
  });
  await setRecorderState(state);
  if (state.sourceTabId && state.mode === 'tab_video') {
    await chrome.tabs.sendMessage(state.sourceTabId, {
      target: 'content',
      type: 'showRecordingBar',
      startedAt: state.startedAt,
      sessionId: state.sessionId,
      mode: state.mode,
    }).catch(() => undefined);
  }
  return { success: true };
}

async function onRecorderProgress(message) {
  const current = await currentRecorderState();
  if (message.sessionId !== current.sessionId) return { success: false, stale: true };
  await setRecorderState({
    ...current,
    durationMs: Number(message.durationMs ?? message.duration ?? current.durationMs),
    sizeBytes: Number(message.sizeBytes ?? current.sizeBytes),
  }, false);
  return { success: true };
}

async function onRecorderPaused(message, paused) {
  const current = await currentRecorderState();
  if (message.sessionId !== current.sessionId) return { success: false, stale: true };
  await setRecorderState({ ...current, status: paused ? 'paused' : 'recording', paused });
  return { success: true };
}

async function onRecorderStopped(message) {
  const current = await currentRecorderState();
  if (current.sessionId && message.sessionId !== current.sessionId) return { success: false, stale: true };

  const record = await getRecording(message.recordingId || current.recordingId);
  if (!record?.blob || !record.sizeBytes) {
    throw new QaApiError('A gravação terminou sem gerar mídia válida.', {
      code: 'EMPTY_RECORDING',
      retryable: true,
    });
  }

  const metadata = recordingMetadata(record, { status: 'ready' });
  await upsertMediaMetadata(metadata);
  if (record.sourceTabId) {
    await chrome.tabs.sendMessage(record.sourceTabId, {
      target: 'content',
      type: 'hideRecordingBar',
    }).catch(() => undefined);
  }

  await setRecorderState(makeRecorderState({ status: 'done' }));
  await broadcast('WI_QA_MEDIA_UPDATED', { media: await getMediaMetadata(), latest: metadata });
  return { success: true, media: metadata };
}

async function onRecorderCancelled(message) {
  const current = await currentRecorderState();
  if (current.sessionId && message.sessionId !== current.sessionId) return { success: false, stale: true };
  if (message.recordingId) await deleteRecording(message.recordingId).catch(() => undefined);
  await setRecorderState(makeRecorderState({ status: 'cancelled' }));
  return { success: true };
}

async function onRecorderError(message) {
  const current = await currentRecorderState();
  if (current.sessionId && message.sessionId && message.sessionId !== current.sessionId) {
    return { success: false, stale: true };
  }
  const error = {
    code: message.code || message.error?.code || 'RECORDER_ERROR',
    message: message.message || message.error?.message || 'Não foi possível concluir a gravação.',
    retryable: message.retryable ?? true,
  };
  await setRecorderState({ ...current, status: 'error', error });
  await broadcast('WI_QA_ERROR', error);
  return { success: true };
}

async function saveLegacyRecording(dataUrl, sender) {
  if (!dataUrl) throw new QaApiError('A gravação legada está vazia.', { code: 'EMPTY_RECORDING' });
  const record = await dataUrlToRecording(dataUrl, {
    kind: 'video',
    mode: 'tab_video',
    sourceTabId: sender?.tab?.id ?? null,
    fileName: `recording-${Date.now()}.webm`,
  });
  const metadata = recordingMetadata(record, { status: 'ready' });
  await upsertMediaMetadata(metadata);
  await chrome.storage.local.remove(STORAGE_KEYS.CAPTURED_MEDIA_LEGACY);
  await broadcast('WI_QA_MEDIA_UPDATED', { media: await getMediaMetadata(), latest: metadata });
  return { success: true, media: metadata };
}

async function createQaItem(rawDraft) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.DRAFT, STORAGE_KEYS.MEDIA]);
  const draft = normalizeDraft({ ...(stored[STORAGE_KEYS.DRAFT] || {}), ...rawDraft });
  const media = stored[STORAGE_KEYS.MEDIA] || [];
  const tab = await getActiveTab().catch(() => null);
  const activeDiagnostics = tab?.id ? await getDiagnosticBundle(tab.id, false) : null;
  const diagnostics = activeDiagnostics?.draftId === draft.clientRequestId ? activeDiagnostics : null;
  draft.hasImage = media.some((entry) => entry.kind === 'image');
  draft.hasDiagnostic = hasDiagnosticEvidence(diagnostics);
  draft.hasSelectedElement = Boolean(diagnostics?.elements?.length);
  const validationErrors = validateDraft(draft, { requireImage: false, requireElement: true });
  if (Object.keys(validationErrors).length) {
    throw new QaApiError('Revise os campos obrigatórios.', {
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
      details: validationErrors,
    });
  }

  const config = await requireConfig();
  const client = new QaApiClient(config);
  const uploaded = [];
  for (const entry of media) uploaded.push(await ensureMediaUploaded(entry, client, config));

  // As imagens entram só como anexos (qa_item_attachments). O read_url é uma
  // URL assinada de 10 minutos; gravá-la em image_urls deixaria links mortos no
  // item. O snapshot já assina os anexos de novo a cada leitura.
  draft.attachmentIds = uploaded.map((entry) => entry.remoteMediaId).filter(Boolean);
  if (draft.hasDiagnostic) {
    const diagnosticRequestId = diagnostics.clientRequestId || crypto.randomUUID();
    const viewport = await getTabViewportConfig(tab.id);
    const diagnosticResponse = await client.createDiagnostic(diagnosticPayload(diagnostics, tab, viewport), diagnosticRequestId);
    const diagnosticId = diagnosticResponse?.diagnostic?.id || diagnosticResponse?.id;
    if (!diagnosticId) {
      throw new QaApiError('A API não retornou o diagnóstico criado.', {
        code: 'DIAGNOSTIC_INVALID_RESPONSE',
        retryable: true,
      });
    }
    draft.diagnosticSessionIds = [diagnosticId];
  }

  const requestId = draft.clientRequestId || crypto.randomUUID();
  const response = await client.createItem(draft, requestId);
  if (!response?.item?.id) {
    throw new QaApiError('A API não retornou o item criado.', {
      code: 'ITEM_INVALID_RESPONSE',
      retryable: true,
    });
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ITEM]: response.item });
  await Promise.all(media.map((entry) => deleteRecording(entry.recordingId).catch(() => undefined)));
  await chrome.storage.local.remove([
    STORAGE_KEYS.DRAFT,
    STORAGE_KEYS.MEDIA,
    STORAGE_KEYS.CAPTURED_MEDIA_LEGACY,
  ]);
  if (tab?.id) await clearDiagnostics(tab.id);
  await broadcast('WI_QA_ITEM_CREATED', { item: response.item });
  return { success: true, item: response.item };
}

// A mesma imagem pode estar subindo em segundo plano (preuploadMedia) quando o
// usuário clica em enviar; as duas chamadas compartilham o mesmo upload.
function ensureMediaUploaded(entry, client, config) {
  if (entry.remoteMediaId) return Promise.resolve(entry);
  const pending = uploadTasks.get(entry.recordingId);
  if (pending) return pending;
  const task = uploadMedia(entry, client, config)
    .catch(async (error) => {
      await patchMediaIfPresent(entry.recordingId, { status: 'local', uploadError: errorPayload(error).message });
      throw error;
    })
    .finally(() => uploadTasks.delete(entry.recordingId));
  uploadTasks.set(entry.recordingId, task);
  return task;
}

async function uploadMedia(entry, client, config) {
  await patchMediaIfPresent(entry.recordingId, { status: 'uploading', uploadError: null });
  const record = await getRecording(entry.recordingId);
  if (!record?.blob) {
    throw new QaApiError(`A mídia ${entry.fileName || entry.recordingId} não está mais disponível.`, {
      code: 'LOCAL_MEDIA_NOT_FOUND',
      retryable: false,
    });
  }
  const init = await client.initMedia(recordingMetadata(record), entry.uploadRequestId || crypto.randomUUID());
  await uploadToSignedUrl(init, record.blob, config.supabaseUrl);
  const complete = await client.completeMedia(init.media_id);
  const patch = {
    status: complete.status || 'ready',
    remoteMediaId: init.media_id,
    mediaId: init.media_id,
    attachmentId: init.media_id,
    objectPath: init.path,
    uploadError: null,
  };
  await patchMediaIfPresent(entry.recordingId, patch);
  return { ...entry, ...patch };
}

// Não recria metadados de uma mídia que o usuário removeu (ou que já foi
// enviada com o item) enquanto o upload estava em andamento.
async function patchMediaIfPresent(recordingId, patch) {
  const media = await getMediaMetadata();
  const index = media.findIndex((item) => item.recordingId === recordingId);
  if (index < 0) return null;
  media[index] = { ...media[index], ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.MEDIA]: media });
  return media[index];
}

async function removeMedia(recordingId) {
  if (!recordingId) return { success: true };
  await deleteRecording(recordingId).catch(() => undefined);
  await removeMediaMetadata([recordingId]);
  const legacy = await chrome.storage.local.get(STORAGE_KEYS.CAPTURED_MEDIA_LEGACY);
  if (legacy[STORAGE_KEYS.CAPTURED_MEDIA_LEGACY]?.recordingId === recordingId) {
    await chrome.storage.local.remove(STORAGE_KEYS.CAPTURED_MEDIA_LEGACY);
  }
  const media = await getMediaMetadata();
  await broadcast('WI_QA_MEDIA_UPDATED', { media });
  return { success: true, media };
}

function sessionExpiredError() {
  return new QaApiError('Sua sessão expirou. Informe a senha novamente para continuar.', {
    status: 401,
    code: 'SESSION_EXPIRED',
    retryable: false,
  });
}

function isClientSessionExpired(config) {
  if (!config || config.authMode === 'wiflow') return false;
  if (!config.clientAccessToken) return true;
  const expiresAt = Date.parse(config.clientAccessExpiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

// O token do convidado (client_access_sessions) expira em 12h no servidor, mas
// fica salvo em storage.local. Qualquer 401 da API descarta o token e avisa o
// painel, que volta para a tela de conexão.
async function handleAuthFailure(error) {
  // Senha errada na tela de conexão também volta 401, mas não é sessão vencida.
  if (error?.status !== 401 || ['CONFIG_REQUIRED', 'INVALID_PASSWORD'].includes(error?.code)) return error;

  const stored = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  const config = stored[STORAGE_KEYS.CONFIG];
  if (!config) return error;

  if (config.authMode !== 'wiflow' && config.clientAccessToken) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CONFIG]: { ...config, clientAccessToken: '', clientAccessExpiresAt: '' },
    });
  }
  const expired = error.code === 'SESSION_EXPIRED' ? error : sessionExpiredError();
  await broadcast('WI_QA_SESSION_EXPIRED', errorPayload(expired));
  return expired;
}

async function requireConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  const config = stored[STORAGE_KEYS.CONFIG];
  if (!config) {
    throw new QaApiError('Conecte a extensão a um projeto antes de continuar.', {
      code: 'CONFIG_REQUIRED',
      status: 401,
      retryable: false,
    });
  }
  if (isClientSessionExpired(config)) throw sessionExpiredError();
  return sanitizeConfig(config);
}

function normalizeDraft(raw = {}) {
  const item = raw.item && typeof raw.item === 'object' ? raw.item : raw;
  const author = raw.author && typeof raw.author === 'object' ? raw.author : {};
  return {
    device: item.device || 'Desktop',
    location: String(item.location || item.itemLocation || 'Outra').trim(),
    pageUrl: String(item.pageUrl || item.page_url || raw.sourcePageUrl || '').trim(),
    description: String(item.description || '').trimStart(),
    priority: item.priority || 'Média',
    status: item.status || 'Pendente',
    responsibleId: item.responsibleId || item.responsible_id || null,
    responsibleName: item.responsibleName || item.responsible_name || null,
    authorName: raw.authorName || author.name || '',
    authorEmail: raw.authorEmail || author.email || '',
    imageUrls: Array.isArray(item.imageUrls) ? item.imageUrls : (Array.isArray(item.image_urls) ? item.image_urls : []),
    clientRequestId: raw.clientRequestId || raw.client_request_id || raw.draftId || raw.id || crypto.randomUUID(),
  };
}

function recordingMetadata(record, overrides = {}) {
  return {
    recordingId: record.recordingId,
    sessionId: record.sessionId,
    kind: record.kind,
    mode: record.mode,
    mimeType: record.mimeType || record.blob?.type || 'application/octet-stream',
    sizeBytes: Number(record.sizeBytes ?? record.blob?.size ?? 0),
    durationMs: Number(record.durationMs || 0),
    createdAt: record.createdAt || Date.now(),
    expiresAt: record.expiresAt || Date.now() + 24 * 60 * 60 * 1000,
    fileName: record.fileName || `${record.kind}-${Date.now()}`,
    sourceTabId: record.sourceTabId ?? null,
    status: 'ready',
    ...overrides,
  };
}

async function getMediaMetadata() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.MEDIA);
  return stored[STORAGE_KEYS.MEDIA] || [];
}

async function upsertMediaMetadata(entry) {
  const media = await getMediaMetadata();
  const index = media.findIndex((item) => item.recordingId === entry.recordingId);
  if (index >= 0) media[index] = { ...media[index], ...entry };
  else media.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEYS.MEDIA]: media });
  return entry;
}

async function updateMediaMetadata(recordingId, patch) {
  const media = await getMediaMetadata();
  const existing = media.find((item) => item.recordingId === recordingId) || {};
  return upsertMediaMetadata({ ...existing, recordingId, ...patch });
}

async function removeMediaMetadata(recordingIds) {
  const remove = new Set(recordingIds);
  const media = (await getMediaMetadata()).filter((entry) => !remove.has(entry.recordingId));
  await chrome.storage.local.set({ [STORAGE_KEYS.MEDIA]: media });
}

async function finishBrowserRequest(details, error) {
  const pending = networkRequests.get(details.requestId);
  networkRequests.delete(details.requestId);
  if (!pending || ['xmlhttprequest'].includes(details.type)) return;
  await appendDiagnosticEvent(pending.tabId, {
    kind: 'network',
    at: Date.now(),
    request_id: details.requestId,
    transport: 'browser',
    method: pending.method,
    url: pending.url,
    resource_type: pending.resource_type,
    status: Number(details.statusCode || 0),
    ok: !error && Number(details.statusCode || 0) < 400,
    duration_ms: Math.max(0, Math.round(details.timeStamp - pending.startedAt)),
    error: error || '',
  }, { create: false, draftId: pending.draftId });
}

function sanitizeDiagnosticUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credit|card|cvv|cpf|email|phone|telefone/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString().slice(0, 2048);
  } catch {
    return String(value || '').slice(0, 2048);
  }
}

async function diagnosticStore() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.DIAGNOSTICS);
  return stored[STORAGE_KEYS.DIAGNOSTICS] || {};
}

function newDiagnosticBundle(tabId, draftId = '') {
  return {
    tabId,
    draftId: String(draftId || ''),
    clientRequestId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    environment: {},
    console: [],
    network: [],
    steps: [],
    elements: [],
    dropped: { console: 0, network: 0, steps: 0 },
  };
}

async function getDiagnosticBundle(tabId, create = true, draftId = '') {
  if (!Number.isInteger(tabId)) return null;
  const store = await diagnosticStore();
  const key = String(tabId);
  if (!store[key] && create) {
    store[key] = newDiagnosticBundle(tabId, draftId);
    await chrome.storage.session.set({ [STORAGE_KEYS.DIAGNOSTICS]: store });
  }
  return store[key] || null;
}

async function appendDiagnosticEvent(tabId, event, options = {}) {
  if (!Number.isInteger(tabId) || !event || typeof event !== 'object') return { success: true };
  const previous = diagnosticQueues.get(tabId) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const store = await diagnosticStore();
    const key = String(tabId);
    let bundle = store[key];
    const eventDraftId = String(options.draftId || '');
    if (eventDraftId && bundle?.draftId && eventDraftId !== bundle.draftId) return null;
    if (!bundle) {
      if (options.create === false) return null;
      bundle = newDiagnosticBundle(tabId, eventDraftId);
    }
    if (event.kind === 'environment') {
      bundle.environment = event.environment || {};
    } else if (event.kind === 'console') {
      bundle.console.push(event);
      if (bundle.console.length > 500) {
        bundle.console.splice(0, bundle.console.length - 500);
        bundle.dropped.console += 1;
      }
    } else if (event.kind === 'network') {
      bundle.network.push(event);
      if (bundle.network.length > 300) {
        bundle.network.splice(0, bundle.network.length - 300);
        bundle.dropped.network += 1;
      }
    } else if (event.kind === 'step') {
      bundle.steps.push(event);
      if (bundle.steps.length > 200) {
        bundle.steps.splice(0, bundle.steps.length - 200);
        bundle.dropped.steps += 1;
      }
    } else if (event.kind === 'element') {
      bundle.elements = [event.element, ...bundle.elements.filter((entry) => entry.selector !== event.element?.selector)].slice(0, 10);
      // Só para exibir no painel: diagnosticPayload não inclui este campo.
      bundle.elementPreview = event.preview || null;
    }
    bundle.updatedAt = new Date().toISOString();
    store[key] = bundle;
    await chrome.storage.session.set({ [STORAGE_KEYS.DIAGNOSTICS]: store });
    await broadcast('WI_QA_DIAGNOSTICS_UPDATED', diagnosticView(bundle));
    return bundle;
  });
  diagnosticQueues.set(tabId, task);
  try {
    const bundle = await task;
    return { success: true, diagnostics: bundle ? diagnosticView(bundle) : null };
  } finally {
    if (diagnosticQueues.get(tabId) === task) diagnosticQueues.delete(tabId);
  }
}

function diagnosticView(bundle) {
  const consoleErrors = bundle.console.filter((entry) => ['error', 'uncaught', 'unhandledrejection'].includes(entry.level)).length;
  const consoleWarnings = bundle.console.filter((entry) => entry.level === 'warn').length;
  const networkFailures = bundle.network.filter((entry) => Number(entry.status || 0) >= 400 || entry.error).length;
  return {
    active: true,
    draftId: bundle.draftId || '',
    consoleCount: bundle.console.length,
    consoleErrors,
    consoleWarnings,
    networkCount: bundle.network.length,
    networkFailures,
    stepsCount: bundle.steps.length,
    element: bundle.elements[0] || null,
    elementPreview: bundle.elementPreview || null,
    environment: bundle.environment || {},
    dropped: bundle.dropped,
    startedAt: bundle.startedAt,
    updatedAt: bundle.updatedAt,
  };
}

function hasDiagnosticEvidence(bundle) {
  return Boolean(bundle && (
    bundle.elements.length || bundle.console.length || bundle.network.length || bundle.steps.length
  ));
}

function diagnosticPayload(bundle, tab, viewport = VIEWPORT_PRESETS.full) {
  const emulated = Boolean(viewport.width);
  const payload = {
    schema_version: 1,
    session: {
      id: bundle.clientRequestId,
      started_at: bundle.startedAt,
      ended_at: new Date().toISOString(),
      page_url: sanitizeDiagnosticUrl(tab?.url || bundle.environment?.url || ''),
    },
    environment: bundle.environment || {},
    device_context: {
      classification: emulated
        ? viewport.label
        : Number(bundle.environment?.viewport?.width || 0) <= 767 ? 'Mobile' : 'Desktop',
      source: emulated ? 'extension_viewport' : 'auto',
      is_emulated: emulated,
      emulated_viewport: emulated
        ? { width: viewport.width, height: viewport.height, device_scale_factor: viewport.deviceScaleFactor }
        : null,
      viewport: bundle.environment?.viewport || null,
      screen: bundle.environment?.screen || null,
      device_pixel_ratio: bundle.environment?.device_pixel_ratio || null,
      orientation: bundle.environment?.orientation || null,
      touch_capable: Boolean(bundle.environment?.touch_capable),
    },
    elements: bundle.elements || [],
    console: bundle.console || [],
    network: bundle.network || [],
    steps: bundle.steps || [],
    redaction: { policy_version: 1, dropped: bundle.dropped || {} },
  };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(payload)).byteLength > 900000) {
    if (payload.console.length) payload.console.shift();
    else if (payload.network.length) payload.network.shift();
    else if (payload.steps.length) payload.steps.shift();
    else break;
  }
  return payload;
}

async function startActiveDiagnostics(draftId) {
  const tab = await getActiveTab();
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);
  return startDiagnostics(tab.id, draftId);
}

async function startDiagnostics(tabId, draftId, options = {}) {
  if (!Number.isInteger(tabId) || !draftId) return { success: true, diagnostics: null };
  const previous = diagnosticQueues.get(tabId) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const store = await diagnosticStore();
    const key = String(tabId);
    let bundle = store[key];
    if (options.force || !bundle || bundle.draftId !== draftId) {
      bundle = newDiagnosticBundle(tabId, draftId);
      store[key] = bundle;
      await chrome.storage.session.set({ [STORAGE_KEYS.DIAGNOSTICS]: store });
    }
    diagnosticDraftIds.set(tabId, draftId);
    await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'WI_QA_SET_DIAGNOSTIC_SESSION',
      draftId,
    }).catch(() => undefined);
    return bundle;
  });
  diagnosticQueues.set(tabId, task);
  try {
    const bundle = await task;
    return { success: true, diagnostics: diagnosticView(bundle) };
  } finally {
    if (diagnosticQueues.get(tabId) === task) diagnosticQueues.delete(tabId);
  }
}

async function selectPageElement(draftId) {
  const tab = await getActiveTab();
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);
  if (draftId) await startDiagnostics(tab.id, draftId);
  const response = await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'WI_QA_SELECT_ELEMENT' });
  if (!response?.success || !response.element) {
    throw new QaApiError(response?.error || 'Não foi possível selecionar o elemento.', {
      code: 'ELEMENT_SELECTION_FAILED',
      retryable: false,
    });
  }
  const preview = await captureElementPreview(tab, response.element).catch((error) => {
    // A prévia é um extra: sem ela a seleção continua valendo.
    console.warn('WiControl QA: prévia do elemento indisponível.', safeErrorForLog(error));
    return null;
  });
  await appendDiagnosticEvent(tab.id, { kind: 'element', at: Date.now(), element: response.element, preview }, { draftId });
  return { success: true, element: response.element, diagnostics: diagnosticView(await getDiagnosticBundle(tab.id, true, draftId)) };
}

const ELEMENT_PREVIEW_PADDING = 8;
const ELEMENT_PREVIEW_MAX_DIMENSION = 900;

// Captura a aba e recorta o retângulo do elemento (com uma folga), já em WebP.
// O retângulo vem em pixels CSS do viewport; a captura está em pixels do
// dispositivo (ou do viewport emulado), daí a escala pela largura do viewport.
async function captureElementPreview(tab, element) {
  const rect = element?.capture_rect || element?.rect;
  if (!rect || !rect.width || !rect.height) return null;
  // O overlay de seleção acabou de ser removido; espera a página repintar.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const source = await (await fetch(await captureTabImage(tab))).blob();
  const bitmap = await createImageBitmap(source);
  try {
    const viewportWidth = Number(element.viewport?.width) || Number(tab.width) || bitmap.width;
    const scale = bitmap.width / viewportWidth;
    const pad = ELEMENT_PREVIEW_PADDING;
    const left = Math.max(0, Math.floor((rect.x - pad) * scale));
    const top = Math.max(0, Math.floor((rect.y - pad) * scale));
    const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width + pad) * scale));
    const bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height + pad) * scale));
    // Elemento fora da área visível: não há o que mostrar.
    if (right - left < 2 || bottom - top < 2) return null;

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    const fit = Math.min(1, ELEMENT_PREVIEW_MAX_DIMENSION / Math.max(cropWidth, cropHeight));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(cropWidth * fit)), Math.max(1, Math.round(cropHeight * fit)));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, left, top, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: IMAGE_WEBP_QUALITY });
    if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/png' });
    return {
      dataUrl: await blobToDataUrl(blob),
      selector: element.selector || element.tag || '',
      clipped: rect.y < 0 || rect.x < 0 || (rect.y + rect.height) * scale > bitmap.height || (rect.x + rect.width) * scale > bitmap.width,
    };
  } finally {
    bitmap.close?.();
  }
}

async function listQaItems() {
  const config = await requireConfig();
  const snapshot = await new QaApiClient(config).getSnapshot({ includeMembers: false });
  const commentsByItem = new Map();
  for (const comment of snapshot.comments || []) {
    const list = commentsByItem.get(comment.qa_item_id) || [];
    list.push({
      id: comment.id,
      body: comment.body,
      author_name: comment.author_name,
      created_at: comment.created_at,
    });
    commentsByItem.set(comment.qa_item_id, list);
  }
  const items = (snapshot.items || []).map((item) => ({
    id: item.id,
    device: item.device,
    location: item.location,
    page_url: item.page_url,
    description: item.description,
    status: item.status,
    priority: item.priority,
    responsible_name: item.responsible_name,
    created_by_name: item.created_by_name,
    created_at: item.created_at,
    image_urls: (Array.isArray(item.image_urls) ? item.image_urls : [])
      .map((url) => rebaseStorageUrl(url, config.supabaseUrl)),
    comments: commentsByItem.get(item.id) || [],
  }));
  return { success: true, items, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Visualização responsiva em uma única moldura interativa por vez.

async function getTabViewport(tabId) {
  const stored = await chrome.storage.session.get(VIEWPORT_STORAGE_KEY);
  const entry = stored[VIEWPORT_STORAGE_KEY]?.[String(tabId)];
  const preset = typeof entry === 'string' ? entry : entry?.preset;
  return VIEWPORT_PRESETS[preset] ? preset : 'full';
}

async function getTabViewportMode(tabId) {
  const stored = await chrome.storage.session.get(VIEWPORT_STORAGE_KEY);
  const entry = stored[VIEWPORT_STORAGE_KEY]?.[String(tabId)];
  if (typeof entry === 'string') return entry === 'full' ? 'full' : 'viewer';
  return entry?.mode || 'full';
}

async function storeTabViewport(tabId, preset, mode = 'viewer', size = null) {
  const stored = await chrome.storage.session.get(VIEWPORT_STORAGE_KEY);
  const viewports = stored[VIEWPORT_STORAGE_KEY] || {};
  if (preset === 'full') delete viewports[String(tabId)];
  else viewports[String(tabId)] = { preset, mode, ...(size ? { width: size.width, height: size.height } : {}) };
  await chrome.storage.session.set({ [VIEWPORT_STORAGE_KEY]: viewports });
}

// Preset com largura/altura efetivas da aba (o "design" guarda as suas).
async function getTabViewportConfig(tabId) {
  const preset = await getTabViewport(tabId);
  if (preset !== 'design') return VIEWPORT_PRESETS[preset] || VIEWPORT_PRESETS.full;
  const stored = await chrome.storage.session.get(VIEWPORT_STORAGE_KEY);
  return designViewportConfig(stored[VIEWPORT_STORAGE_KEY]?.[String(tabId)]);
}

function designViewportConfig(size = {}) {
  const limits = DESIGN_VIEWPORT_LIMITS;
  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Math.round(Number(value) || fallback)));
  const width = clamp(size?.width, limits.minWidth, limits.maxWidth, 1440);
  const height = clamp(size?.height, limits.minHeight, limits.maxHeight, 900);
  // O diagnóstico classifica o dispositivo pelo rótulo do viewport emulado.
  const label = width <= 767 ? 'Mobile' : width <= 1180 ? 'Tablet' : 'Desktop';
  return { label, width, height, design: true };
}

function viewportSize(config) {
  return config?.width ? { width: config.width, height: config.height } : null;
}

async function setViewportPreset(rawPreset, requestedTabId, size = null) {
  const preset = VIEWPORT_PRESETS[rawPreset] ? rawPreset : 'full';
  const tab = await getRequestedPageTab(requestedTabId);
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);

  if (preset === 'full') {
    await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'WI_QA_VIEWPORT_HIDE' }).catch(() => undefined);
    await storeTabViewport(tab.id, 'full');
    await broadcast('WI_QA_VIEWPORT_STATE', { tabId: tab.id, preset, mode: 'full' });
    return { success: true, preset, mode: 'full', reloaded: false };
  }

  const config = preset === 'design' ? designViewportConfig(size) : VIEWPORT_PRESETS[preset];
  const response = await chrome.tabs.sendMessage(tab.id, {
    target: 'content',
    type: 'WI_QA_VIEWPORT_SHOW',
    payload: {
      preset,
      label: config.design ? 'Tamanho do design · Fiscal do Pixel' : config.label,
      width: config.width,
      height: config.height,
    },
  });
  if (!response?.success) {
    throw new QaApiError(response?.error || 'Não foi possível abrir a visualização responsiva.', {
      code: 'VIEWPORT_FAILED',
      retryable: true,
    });
  }
  await ensureFrameDiagnostics(tab.id);
  const actualViewport = viewportSize(config);
  await storeTabViewport(tab.id, preset, 'viewer', config.design ? actualViewport : null);
  await broadcast('WI_QA_VIEWPORT_STATE', { tabId: tab.id, preset, mode: 'viewer', actualViewport });
  return {
    success: true,
    preset,
    mode: 'viewer',
    actualViewport,
    reloaded: false,
  };
}

async function ensureFrameDiagnostics(tabId) {
  if (!Number.isInteger(tabId)) return { success: true };
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/observer.js'],
    world: 'MAIN',
  }).catch(() => undefined);
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/frame-relay.js'],
  }).catch(() => undefined);
  return { success: true };
}

async function closeViewportFromContent(tabId) {
  if (!Number.isInteger(tabId)) return { success: true };
  await storeTabViewport(tabId, 'full');
  await broadcast('WI_QA_VIEWPORT_STATE', { tabId, preset: 'full', mode: 'full' });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Fiscal do Pixel: inspeção visual e sobreposição do design na própria aba.

async function startPixelInspector() {
  const tab = await getActiveTab();
  assertInjectableTab(tab);
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    target: 'content',
    type: 'WI_QA_PIXEL_INSPECTOR_SHOW',
  }).catch(() => null);
  if (!response?.success) {
    throw new QaApiError(response?.error || 'Não foi possível abrir o Fiscal do Pixel. Recarregue a página e tente novamente.', {
      code: 'PIXEL_INSPECTOR_FAILED',
      retryable: true,
    });
  }
  await broadcast('WI_QA_PIXEL_INSPECTOR_STATE', { tabId: tab.id, active: true });
  return { success: true, active: true, tabId: tab.id };
}

async function stopPixelInspector() {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, {
    target: 'content',
    type: 'WI_QA_PIXEL_INSPECTOR_HIDE',
  }).catch(() => undefined);
  await broadcast('WI_QA_PIXEL_INSPECTOR_STATE', { tabId: tab.id, active: false });
  return { success: true, active: false, tabId: tab.id };
}

// A página esconde a barra do Fiscal antes de pedir a captura; o design
// sobreposto e o elemento fixado entram na imagem como evidência.
async function capturePixelEvidence(sender) {
  const tab = sender?.tab;
  if (!tab?.id) {
    throw new QaApiError('A captura precisa partir da página inspecionada.', {
      code: 'PIXEL_CAPTURE_INVALID',
      status: 400,
      retryable: false,
    });
  }
  const dataUrl = await captureTabImage(tab).catch((error) => { throw pageAccessError(error); });
  const result = await saveScreenshot(dataUrl, sender, { filePrefix: 'pixel-perfect' });
  await broadcast('WI_QA_PIXEL_EVIDENCE_ADDED', { tabId: tab.id, media: result.media });
  return result;
}

async function captureTabImage(tab) {
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

async function clearDiagnostics(tabId, options = {}) {
  if (!Number.isInteger(tabId)) return null;
  const previous = diagnosticQueues.get(tabId) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const store = await diagnosticStore();
    const key = String(tabId);
    const current = store[key] || null;
    const draftId = String(options.draftId || current?.draftId || '');
    let next = null;
    const belongsToDraft = !draftId || current?.draftId === draftId;
    if (options.preserveElement && belongsToDraft && current?.elements?.length) {
      next = newDiagnosticBundle(tabId, draftId);
      next.environment = current.environment || {};
      next.elements = current.elements.slice(0, 1);
      next.elementPreview = current.elementPreview || null;
      store[key] = next;
    } else {
      delete store[key];
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.DIAGNOSTICS]: store });
    if (next) diagnosticDraftIds.set(tabId, draftId);
    else diagnosticDraftIds.delete(tabId);
    return next;
  });
  diagnosticQueues.set(tabId, task);
  try {
    return await task;
  } finally {
    if (diagnosticQueues.get(tabId) === task) diagnosticQueues.delete(tabId);
  }
}

async function clearActiveDiagnostics(draftId) {
  const tab = await getActiveTab();
  const diagnostics = tab?.id
    ? await clearDiagnostics(tab.id, { preserveElement: true, draftId })
    : null;
  const view = diagnostics ? diagnosticView(diagnostics) : null;
  await broadcast('WI_QA_DIAGNOSTICS_UPDATED', view);
  return { success: true, diagnostics: view };
}

async function currentRecorderState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RECORDER);
  return stored[STORAGE_KEYS.RECORDER] || makeRecorderState();
}

async function setRecorderState(state, broadcastState = true) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.RECORDER]: state,
    isRecording: ['starting', 'countdown', 'recording', 'paused', 'stopping'].includes(state.status),
    recordingStart: state.startedAt || null,
  });
  if (broadcastState) await broadcast('WI_QA_RECORDER_STATE', state);
  return state;
}

async function reconcileRecorderState() {
  const state = await currentRecorderState();
  if (!['starting', 'countdown', 'recording', 'paused', 'stopping'].includes(state.status)) return;
  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_RECORDER_STATE' });
    const offscreenState = response?.recording || response;
    if (!response?.active || offscreenState?.sessionId !== state.sessionId) {
      await setRecorderState(makeRecorderState({
        status: 'error',
        error: { code: 'RECORDER_CONTEXT_LOST', message: 'A gravação anterior foi interrompida.', retryable: true },
      }));
    }
  } catch {
    await setRecorderState(makeRecorderState({
      status: 'error',
      error: { code: 'RECORDER_CONTEXT_LOST', message: 'A gravação anterior foi interrompida.', retryable: true },
    }));
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === chrome.runtime.getURL(OFFSCREEN_PATH));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
    justification: 'Gravar vídeo da aba como evidência de QA e persistir o Blob temporariamente.',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function broadcast(type, payload) {
  try {
    await chrome.runtime.sendMessage({ target: 'ui', source: 'background', type, payload });
  } catch {
    // É esperado quando nenhuma superfície da extensão está aberta.
  }
}

function errorPayload(error) {
  if (error instanceof QaApiError) {
    return {
      message: error.message,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      requestId: error.requestId,
      details: error.details,
    };
  }
  return {
    message: error?.message || 'Ocorreu um erro inesperado.',
    code: error?.code || 'UNEXPECTED_ERROR',
    status: 0,
    retryable: true,
    requestId: null,
  };
}

function safeErrorForLog(error) {
  return {
    name: error?.name,
    code: error?.code,
    status: error?.status,
    message: error?.message,
  };
}

function assertRecorderResponse(response) {
  if (response?.success !== false) return;
  throw new QaApiError(response.error?.message || 'Não foi possível iniciar a gravação.', {
    code: response.error?.code || 'RECORDER_START_FAILED',
    status: 0,
    retryable: response.error?.retryable ?? true,
    details: response.error?.details || null,
  });
}
