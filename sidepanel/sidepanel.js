/*
 * WiControl QA — protocolo entre a interface e o service worker
 *
 * Toda solicitação usa o envelope:
 *   { target: 'background', source: 'sidepanel', type, requestId, payload }
 * Campos de payload também são espelhados no nível superior durante a migração.
 * Sessões de gravação sempre carregam sessionId para descartar eventos atrasados.
 *
 * Solicitações:
 *   WI_QA_GET_CONTEXT
 *   WI_QA_VALIDATE_CONFIG       payload: { config }
 *   WI_QA_REQUEST_LOGIN_CODE    payload: { email }
 *   WI_QA_CAPTURE_SCREENSHOT    payload: { draftId, sessionId }
 *   WI_QA_VIDEO_START|PAUSE|RESUME|STOP|CANCEL
 *   WI_QA_MEDIA_REMOVE          payload: { mediaId, recordingId }
 *   WI_QA_CREATE_ITEM           payload: { draft }
 *   WI_QA_DRAFT_RESET           payload: { draftId }
 *
 * Eventos aceitos:
 *   WI_QA_CONTEXT_UPDATED, WI_QA_MEDIA_UPDATED, WI_QA_RECORDER_STATE,
 *   WI_QA_ITEM_CREATED e WI_QA_ERROR.
 * A interface também entende RECORDER_* emitidos pelo documento offscreen e
 * observa as chaves de storage para sobreviver ao fechamento/reabertura.
 */

(() => {
  'use strict';

  const REQUIRED_BACKGROUND_PROTOCOL = 8;
  const MESSAGE = Object.freeze({
    GET_CONTEXT: 'WI_QA_GET_CONTEXT',
    VALIDATE_CONFIG: 'WI_QA_VALIDATE_CONFIG',
    REQUEST_LOGIN_CODE: 'WI_QA_REQUEST_LOGIN_CODE',
    SCREENSHOT: 'WI_QA_CAPTURE_SCREENSHOT',
    VIDEO_START: 'WI_QA_VIDEO_START',
    VIDEO_STOP: 'WI_QA_VIDEO_STOP',
    VIDEO_CANCEL: 'WI_QA_VIDEO_CANCEL',
    VIDEO_PAUSE: 'WI_QA_VIDEO_PAUSE',
    VIDEO_RESUME: 'WI_QA_VIDEO_RESUME',
    MEDIA_REMOVE: 'WI_QA_MEDIA_REMOVE',
    SELECT_ELEMENT: 'WI_QA_SELECT_ELEMENT',
    START_DIAGNOSTICS: 'WI_QA_START_DIAGNOSTICS',
    CLEAR_DIAGNOSTICS: 'WI_QA_CLEAR_DIAGNOSTICS',
    CREATE_ITEM: 'WI_QA_CREATE_ITEM',
    DRAFT_RESET: 'WI_QA_DRAFT_RESET',
    LIST_ITEMS: 'WI_QA_LIST_ITEMS',
    SET_VIEWPORT: 'WI_QA_SET_VIEWPORT',
    PIXEL_START: 'WI_QA_PIXEL_INSPECTOR_START',
    PIXEL_STOP: 'WI_QA_PIXEL_INSPECTOR_STOP'
  });

  const VIEWPORT_HINTS = Object.freeze({
    full: 'Tamanho real da aba',
    desktop: '1440 × 900',
    tablet: '820 × 1180 · touch',
    mobile: '390 × 844 · touch'
  });
  // Tablet não tem valor próprio no campo Dispositivo; mantém a escolha manual.
  const VIEWPORT_DEVICE = Object.freeze({ desktop: 'Desktop', mobile: 'Mobile' });
  const CLOSED_STATUSES = Object.freeze(['Concluído', 'Cancelado']);
  // As URLs das imagens na listagem são assinadas por 10 minutos.
  const ITEMS_STALE_MS = 5 * 60 * 1000;

  const STORAGE = Object.freeze({
    DRAFT: 'wiqaDraft',
    MEDIA: 'wiqaMedia',
    RECORDER: 'wiqaRecorderState',
    PROJECT: 'wiqaProject',
    LEGACY_MEDIA: 'capturedMedia',
    LEGACY_RECORDING: 'isRecording',
    LEGACY_RECORDING_START: 'recordingStart',
    PROTOCOL_RELOAD_AT: 'wiqaProtocolReloadAt'
  });

  const MEDIA_DATABASE = Object.freeze({
    NAME: 'wicontrol-qa-media',
    VERSION: 1,
    STORE: 'recordings'
  });

  const ENUMS = Object.freeze({
    device: ['Mobile', 'Desktop', 'Mob&Desk'],
    priority: ['Baixa', 'Média', 'Alta'],
    status: [
      'Pendente', 'Em andamento', 'Validação', 'Concluído', 'Cancelado',
      'Info', 'Layout', 'Gestão', 'Cadastro', 'Plataforma'
    ]
  });

  // Mesmo valor do placeholder em sidepanel.html.
  const GUEST_CREDENTIAL_EXAMPLE = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  const dom = {};
  const state = {
    initialized: false,
    connected: false,
    config: null,
    project: null,
    members: null,
    tab: null,
    draftId: makeId('draft'),
    media: [],
    recorder: { status: 'idle' },
    diagnostics: null,
    submitting: false,
    setupBusy: false,
    // Login por e-mail: 'email' até o código ser enviado, depois 'code'.
    loginStep: 'email',
    loginCodeEmail: '',
    // Imagem do elemento anexada sozinha na seleção atual.
    autoPreviewRecordingId: '',
    draftSaveTimer: null,
    timerInterval: null,
    objectUrls: new Map(),
    lastCreatedItemId: '',
    reloadingExtension: false,
    sessionExpired: false,
    sessionPromptShown: false,
    sessionTimer: null,
    activeTab: 'compose',
    items: [],
    itemsFetchedAt: 0,
    itemsLoading: false,
    itemsError: '',
    expandedItems: new Set(),
    viewport: 'full',
    viewportMode: 'full',
    viewportActual: null,
    viewportBusy: false,
    viewer: null,
    pixelInspector: false
  };

  document.addEventListener('DOMContentLoaded', initialize);

  async function initialize() {
    cacheDom();
    bindEvents();
    setConnectionState('busy', 'Carregando');

    const localState = await storageGet([
      STORAGE.DRAFT,
      STORAGE.MEDIA,
      STORAGE.RECORDER,
      STORAGE.PROJECT,
      STORAGE.LEGACY_MEDIA,
      STORAGE.LEGACY_RECORDING,
      STORAGE.LEGACY_RECORDING_START
    ]);

    state.project = localState[STORAGE.PROJECT] || null;
    state.media = normalizeMediaCollection(
      localState[STORAGE.MEDIA],
      localState[STORAGE.LEGACY_MEDIA]
    );
    state.recorder = normalizeRecorderState(
      localState[STORAGE.RECORDER] || legacyRecorderState(localState)
    );

    let contextResponse = null;
    try {
      contextResponse = await sendCommand(MESSAGE.GET_CONTEXT, {}, { timeoutMs: 8000 });
    } catch (error) {
      // A interface continua utilizável como fallback; a configuração mostrará
      // uma mensagem acionável quando o usuário tentar conectar.
    }

    if (isSuccess(contextResponse) && !(await ensureBackgroundProtocol(contextResponse))) {
      return;
    }

    if (isSuccess(contextResponse)) {
      applyContext(contextResponse.context || contextResponse.data || contextResponse.payload || {});
    } else {
      state.connected = Boolean(state.project && (state.project.id || state.project.name));
      await loadActiveTabFallback();
    }

    populateSetupForm(state.config);
    populateResponsibleOptions(state.members);
    restoreDraft((contextResponse && contextResponse.context && contextResponse.context.draft) || localState[STORAGE.DRAFT]);
    await startDiagnosticSession();
    applyPageContext(state.tab);
    renderAll();
    state.initialized = true;
    updateDraftStatus('saved');

    if (state.sessionExpired) {
      handleSessionExpired();
    } else if (state.connected) {
      showWorkspace();
      scheduleSessionExpiry();
    } else {
      showSetup(false);
    }
  }

  function cacheDom() {
    const ids = [
      'connectionBadge', 'connectionLabel', 'btnSettings', 'setupView', 'setupForm',
      'setupTitle', 'setupIntroText', 'projectToken', 'projectTokenField',
      'guestCredential', 'guestCredentialHint', 'loginEmail', 'loginCodeField', 'loginCode',
      'loginCodeHint', 'btnResendCode',
      'clientAuthFields', 'wiflowAuthFields', 'clientPassword', 'wiflowSessionToken',
      'wiflowUserId', 'setupError', 'btnCancelSetup', 'btnConnect', 'connectButtonLabel',
      'connectSpinner', 'workspaceView', 'projectName', 'btnRefreshContext', 'pageDomain',
      'pageContextTitle', 'pageUrlDisplay', 'btnCopyUrl', 'btnSelectElement', 'selectElementButtonLabel',
      'btnScreenshot', 'btnVideo', 'btnPixelInspector', 'pixelInspectorLabel', 'selectedElementSection', 'btnChangeElement',
      'recorderPanel', 'recordingDot', 'recorderTitle',
      'diagnosticsSection', 'diagnosticsStatus', 'consoleCount', 'networkCount', 'stepsCount',
      'elementCount', 'selectedElementLabel', 'diagnosticsAlert', 'btnClearDiagnostics',
      'recorderSubtitle', 'recorderTimer', 'btnCancelRecording', 'btnPauseRecording',
      'pauseIconUse', 'pauseButtonLabel', 'btnStopRecording', 'evidenceSection', 'evidenceCount',
      'evidenceList', 'evidenceTemplate', 'qaForm', 'description', 'descriptionCount', 'device',
      'location', 'btnUseLocationSuggestion', 'priority', 'status', 'responsible',
      'responsibleHint', 'pageUrl', 'authorName', 'authorEmail', 'submitBar',
      'draftStatus', 'validationHint', 'btnSubmit', 'submitButtonLabel', 'submitSpinner',
      'toastRegion', 'composeView', 'listView', 'itemsCountBadge', 'btnRefreshItems', 'itemsSearch',
      'itemsStatusFilter', 'itemsSummary', 'itemsList', 'itemsState', 'viewportControl',
      'viewportHint', 'btnPermissions', 'btnPermissionsHelp', 'elementPreview', 'btnElementPreview',
      'elementPreviewImage', 'elementPreviewNote', 'btnAttachElement', 'mediaViewer', 'mediaViewerTitle',
      'mediaViewerBody', 'btnViewerZoom', 'btnViewerOpen', 'btnViewerClose'
    ];

    ids.forEach((id) => {
      dom[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    dom.setupForm.addEventListener('submit', handleConnect);
    dom.btnCancelSetup.addEventListener('click', showWorkspace);
    dom.btnSettings.addEventListener('click', () => showSetup(true));
    dom.btnPermissions.addEventListener('click', () => openPermissionsPage());
    dom.btnPermissionsHelp.addEventListener('click', () => openPermissionsPage('site'));
    dom.btnRefreshContext.addEventListener('click', refreshContext);
    dom.btnCopyUrl.addEventListener('click', () => copyText(dom.pageUrl.value, 'URL copiada.'));

    document.querySelectorAll('input[name="authMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        clearSetupError();
        updateAuthModeFields();
      });
    });
    dom.guestCredential.addEventListener('input', applyGuestCredential);
    // O botão "Copiar token" do WiControl copia token$senha; no login por
    // e-mail só o token interessa.
    dom.projectToken.addEventListener('input', () => {
      if (selectedAuthMode() !== 'wiflow' || !dom.projectToken.value.includes('$')) return;
      dom.projectToken.value = tokenBeforeSeparator(dom.projectToken.value);
    });
    dom.loginEmail.addEventListener('input', () => {
      // Trocar o e-mail invalida o código já pedido.
      if (state.loginStep === 'code' && normalizeEmail(dom.loginEmail.value) !== state.loginCodeEmail) {
        setLoginStep('email');
      }
      updateConnectButtonLabel();
    });
    dom.btnResendCode.addEventListener('click', () => requestLoginCode());

    document.querySelectorAll('[data-toggle-password]').forEach((button) => {
      button.addEventListener('click', () => togglePassword(button));
    });

    dom.btnScreenshot.addEventListener('click', captureScreenshot);
    dom.btnPixelInspector.addEventListener('click', togglePixelInspector);
    dom.btnSelectElement.addEventListener('click', selectElement);
    dom.btnChangeElement.addEventListener('click', selectElement);
    dom.btnClearDiagnostics.addEventListener('click', clearDiagnostics);
    dom.btnElementPreview.addEventListener('click', () => {
      const preview = state.diagnostics && state.diagnostics.elementPreview;
      if (preview) openViewer({ src: preview.dataUrl, kind: 'image', title: `Elemento: ${preview.selector || 'selecionado'}` });
    });
    dom.btnAttachElement.addEventListener('click', attachElementPreview);

    dom.btnViewerClose.addEventListener('click', closeViewer);
    dom.mediaViewer.addEventListener('close', clearViewer);
    dom.btnViewerZoom.addEventListener('click', toggleViewerZoom);
    dom.btnViewerOpen.addEventListener('click', openViewerInTab);
    // Clique fora da imagem (no fundo do <dialog>) fecha.
    dom.mediaViewer.addEventListener('click', (event) => {
      if (event.target === dom.mediaViewer) closeViewer();
    });
    dom.mediaViewerBody.addEventListener('click', (event) => {
      if (event.target.tagName === 'IMG') toggleViewerZoom();
      else if (event.target === dom.mediaViewerBody) closeViewer();
    });
    dom.btnVideo.addEventListener('click', startRecording);
    dom.btnPauseRecording.addEventListener('click', togglePauseRecording);
    dom.btnStopRecording.addEventListener('click', stopRecording);
    dom.btnCancelRecording.addEventListener('click', cancelRecording);

    dom.btnUseLocationSuggestion.addEventListener('click', () => {
      dom.location.value = dom.btnUseLocationSuggestion.dataset.value || '';
      dom.btnUseLocationSuggestion.classList.add('hidden');
      fieldChanged();
      dom.location.focus();
    });

    dom.qaForm.addEventListener('input', fieldChanged);
    dom.qaForm.addEventListener('change', fieldChanged);
    dom.description.addEventListener('input', updateDescriptionCount);
    dom.responsible.addEventListener('change', fieldChanged);
    dom.btnSubmit.addEventListener('click', submitDraft);

    document.querySelectorAll('input[name="workspaceTab"]').forEach((radio) => {
      radio.addEventListener('change', () => setActiveTab(radio.value));
    });
    document.querySelectorAll('input[name="viewportPreset"]').forEach((radio) => {
      radio.addEventListener('change', () => changeViewport(radio.value));
    });
    dom.btnRefreshItems.addEventListener('click', () => loadItems({ force: true }));
    dom.itemsSearch.addEventListener('input', renderItems);
    dom.itemsStatusFilter.addEventListener('change', renderItems);

    // A simulação de tela e o contexto da página são por aba.
    chrome.tabs.onActivated.addListener(() => {
      setPixelInspectorActive(false);
      if (state.connected) refreshContext({ quiet: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkSessionExpiry();
    });

    chrome.storage.onChanged.addListener(handleStorageChanges);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    window.addEventListener('beforeunload', revokeAllObjectUrls);
  }

  async function handleConnect(event) {
    event.preventDefault();
    if (state.setupBusy) return;

    clearSetupError();
    const config = readSetupConfig();
    const validationError = validateSetupConfig(config);
    if (validationError) {
      showSetupError(validationError);
      return;
    }

    // Primeiro envio no modo e-mail só pede o código; o segundo conecta.
    if (config.authMode === 'wiflow' && needsLoginCode(config)) {
      await requestLoginCode();
      return;
    }

    setSetupBusy(true);
    setConnectionState('busy', 'Validando');

    try {
      const response = await sendCommand(MESSAGE.VALIDATE_CONFIG, { config }, { timeoutMs: 25000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível validar a conexão.');

      const context = response.context || response.data || response.payload || response;
      state.config = mergeConfig(config, context.config);
      delete state.config.loginCode;
      dom.guestCredential.value = '';
      dom.loginCode.value = '';
      setLoginStep('email');
      state.project = context.project || (context.snapshot && context.snapshot.project) || response.project || null;
      state.members = context.memberDirectory || (context.snapshot && context.snapshot.memberDirectory) || response.memberDirectory || null;
      state.connected = Boolean(state.project);

      if (!state.connected) {
        throw new Error('A API respondeu, mas não retornou o projeto informado.');
      }

      state.sessionExpired = false;
      state.sessionPromptShown = false;
      state.itemsFetchedAt = 0;
      scheduleSessionExpiry();
      populateResponsibleOptions(state.members);
      state.project && (dom.projectName.textContent = state.project.name || 'Projeto conectado');
      showWorkspace();
      setConnectionState('online', state.project.name || 'Conectado');
      showToast('Projeto conectado com sucesso.', 'success');
      await refreshContext({ quiet: true });
      scheduleDraftSave();
    } catch (error) {
      const online = state.connected && !state.sessionExpired;
      setConnectionState(online ? 'online' : 'offline', online
        ? (state.project.name || 'Conectado')
        : state.sessionExpired ? 'Sessão expirada' : 'Não conectado');
      showSetupError(readableError(error));
    } finally {
      setSetupBusy(false);
    }
  }

  // URL e chave do Supabase são fixas (shared/config.js) e aplicadas pelo
  // background; o painel só coleta token do projeto e credenciais de acesso.
  function readSetupConfig() {
    const mode = selectedAuthMode();
    const previous = state.config || {};
    if (mode === 'client') applyGuestCredential();
    const clientInput = dom.clientPassword ? dom.clientPassword.value.trim() : '';
    const loginEmail = normalizeEmail(dom.loginEmail.value);
    const loginCode = mode === 'wiflow' && state.loginStep === 'code' ? dom.loginCode.value.trim() : '';
    // A sessão WiFlow salva só vale para o mesmo e-mail e enquanto não venceu.
    const reuseWiflowSession = mode === 'wiflow'
      && state.loginStep !== 'code'
      && !state.sessionExpired
      && Boolean(loginEmail)
      && loginEmail === normalizeEmail(previous.wiflowEmail);

    const config = {
      projectToken: tokenBeforeSeparator(dom.projectToken.value) || unmaskedValue(previous.projectToken || previous.token),
      authMode: mode,
      clientPassword: mode === 'client' ? clientInput : '',
      // Reaproveita o token salvo, exceto quando ele já venceu.
      clientAccessToken: state.sessionExpired ? '' : (previous.clientAccessToken || ''),
      loginEmail: mode === 'wiflow' ? loginEmail : '',
      loginCode,
      wiflowSessionToken: reuseWiflowSession
        ? (dom.wiflowSessionToken.value.trim() || unmaskedValue(previous.wiflowSessionToken || previous.sessionToken))
        : '',
      wiflowUserId: reuseWiflowSession
        ? (dom.wiflowUserId.value.trim() || unmaskedValue(previous.wiflowUserId || previous.userId))
        : ''
    };

    // Aliases explícitos ajudam a migração do cliente sem alterar o contrato HTTP.
    config.token = config.projectToken;
    config.sessionToken = config.wiflowSessionToken;
    config.userId = config.wiflowUserId;
    return config;
  }

  function validateSetupConfig(config) {
    if (config.authMode === 'client') {
      if (!config.projectToken) return 'Informe o token e a senha no formato token$senha.';
      if (!config.clientPassword && !config.clientAccessToken) {
        return 'Informe a senha depois do $, no formato token$senha.';
      }
      return '';
    }

    if (!config.projectToken) return 'Informe o token do projeto.';
    if (!isValidEmail(config.loginEmail)) return 'Informe um e-mail válido.';
    if (state.loginStep === 'code' && !config.loginCode) return 'Informe o código enviado para o seu e-mail.';
    return '';
  }

  function needsLoginCode(config) {
    return !config.loginCode && !(config.wiflowSessionToken && config.wiflowUserId);
  }

  async function requestLoginCode() {
    if (state.setupBusy) return;
    const email = normalizeEmail(dom.loginEmail.value);
    if (!isValidEmail(email)) {
      showSetupError('Informe um e-mail válido.');
      dom.loginEmail.focus();
      return;
    }

    clearSetupError();
    setSetupBusy(true);
    dom.btnResendCode.disabled = true;
    try {
      const response = await sendCommand(MESSAGE.REQUEST_LOGIN_CODE, { email }, { timeoutMs: 35000 });
      if (!isSuccess(response)) throw responseError(response, 'Falha ao solicitar código de acesso.');
      state.loginCodeEmail = email;
      setLoginStep('code');
      dom.loginCodeHint.textContent = response.message || 'Código enviado. Verifique seu e-mail.';
      showToast('Código enviado para o seu e-mail.', 'success');
      requestAnimationFrame(() => dom.loginCode.focus());
    } catch (error) {
      showSetupError(readableError(error));
    } finally {
      dom.btnResendCode.disabled = false;
      setSetupBusy(false);
    }
  }

  function setLoginStep(step) {
    state.loginStep = step === 'code' ? 'code' : 'email';
    if (state.loginStep === 'email') {
      state.loginCodeEmail = '';
      dom.loginCode.value = '';
    }
    dom.loginCodeField.classList.toggle('hidden', state.loginStep !== 'code');
    updateConnectButtonLabel();
  }

  // Convidado: "token$senha" num único campo. Divide no primeiro $ (a senha
  // pode conter $) e preenche os campos ocultos projectToken e clientPassword.
  // Sem $, com um token já salvo, o valor inteiro é tratado como a senha.
  function applyGuestCredential() {
    const savedToken = unmaskedValue(state.config && (state.config.projectToken || state.config.token));
    const parsed = parseGuestCredential(dom.guestCredential.value, savedToken);
    if (parsed.token) dom.projectToken.value = parsed.token;
    dom.clientPassword.value = parsed.password;

    // A dica é opcional no HTML.
    if (!dom.guestCredentialHint) return;
    const raw = dom.guestCredential.value.trim();
    let hint = 'Separe o token e a senha com $.';
    let isError = false;
    if (raw && parsed.token && parsed.password) {
      hint = raw.includes('$')
        ? `Token ${maskToken(parsed.token)} e senha identificados.`
        : `Usando o token salvo ${maskToken(parsed.token)} com esta senha.`;
    } else if (raw && hasGuestSession()) {
      hint = `Token ${maskToken(parsed.token)} identificado; usando a sessão de convidado atual.`;
    } else if (raw) {
      hint = 'Falta a senha: use o formato token$senha.';
      isError = true;
    }
    dom.guestCredentialHint.textContent = hint;
    dom.guestCredentialHint.classList.toggle('is-error', isError);
  }

  function hasGuestSession() {
    const config = state.config || {};
    return Boolean(config.clientAccessToken || config.hasClientAccessToken) && !state.sessionExpired;
  }

  // Sem $: valor com formato de token (mesma regra do isValidToken da
  // client-project-qa) é o token; senão, com token salvo, é a senha.
  function parseGuestCredential(raw, savedToken) {
    const value = String(raw || '').trim();
    if (!value) return { token: '', password: '' };
    const separator = value.indexOf('$');
    let token = '';
    let password = '';
    
    if (separator === -1) {
      if (looksLikeProjectToken(value) || !savedToken) {
        token = value;
        password = '';
      } else {
        token = savedToken;
        password = value;
      }
    } else {
      token = value.slice(0, separator).trim();
      password = value.slice(separator + 1).trim();
    }
    
    if (token && !password) {
      password = 'Wicomm@2026';
    }
    
    return { token, password };
  }

  function looksLikeProjectToken(value) {
    return value.length >= 32 && value.length <= 128 && /^[a-f0-9-]+$/i.test(value);
  }

  function tokenBeforeSeparator(value) {
    return String(value || '').split('$')[0].trim();
  }

  function maskToken(token) {
    return token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : token;
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
  }

  function populateSetupForm(config) {
    if (!config) {
      updateAuthModeFields();
      return;
    }

    dom.projectToken.value = displayableValue(config.projectToken || config.token);

    const authMode = config.authMode === 'wiflow' ? 'wiflow' : 'client';
    const authRadio = document.querySelector(`input[name="authMode"][value="${authMode}"]`);
    if (authRadio) authRadio.checked = true;

    dom.wiflowUserId.value = displayableValue(config.wiflowUserId || config.userId);
    dom.loginEmail.value = config.wiflowEmail || dom.loginEmail.value || '';
    setSecretPlaceholder(dom.wiflowSessionToken, config.wiflowSessionToken || config.sessionToken, config.hasWiflowSessionToken || config.hasSessionToken);

    // O token salvo permite digitar só a senha quando a sessão de convidado vence.
    dom.clientPassword.value = '';
    dom.guestCredential.value = '';
    dom.guestCredential.placeholder = !config.projectToken
      ? GUEST_CREDENTIAL_EXAMPLE
      : hasGuestSession()
        ?'Configurado — deixe vazio para manter'
        : 'senha (token salvo) ou token$senha';
    applyGuestCredential();
    updateAuthModeFields();
  }

  function setSecretPlaceholder(input, value, configuredFlag) {
    if (value && !isMasked(value)) {
      input.value = value;
      return;
    }
    input.value = '';
    input.placeholder = configuredFlag || isMasked(value) ? 'Configurado — deixe vazio para manter' : '';
  }

  function updateAuthModeFields() {
    const wiflow = selectedAuthMode() === 'wiflow';
    dom.clientAuthFields.classList.toggle('hidden', wiflow);
    dom.wiflowAuthFields.classList.toggle('hidden', !wiflow);
    // No modo convidado o token vem do campo token$senha.
    dom.projectTokenField.classList.toggle('hidden', !wiflow);
    dom.setupIntroText.innerHTML = wiflow
      ? 'Informe o token do projeto e entre com o e-mail que tem acesso ao WiControl.'
      : 'Cole o token do projeto e a senha de convidado no formato <code>token$senha</code>.';
    updateConnectButtonLabel();
  }

  function updateConnectButtonLabel() {
    if (state.setupBusy) return;
    const waitingCode = selectedAuthMode() === 'wiflow'
      && state.loginStep !== 'code'
      && needsLoginCode(readWiflowSessionPreview());
    dom.connectButtonLabel.textContent = waitingCode ? 'Enviar código' : 'Validar e conectar';
  }

  // Versão leve de readSetupConfig só para decidir o rótulo do botão.
  function readWiflowSessionPreview() {
    const previous = state.config || {};
    const sameEmail = normalizeEmail(dom.loginEmail.value) === normalizeEmail(previous.wiflowEmail);
    const canReuse = sameEmail && !state.sessionExpired && Boolean(normalizeEmail(dom.loginEmail.value));
    return {
      loginCode: '',
      wiflowSessionToken: canReuse ? unmaskedValue(previous.wiflowSessionToken || previous.sessionToken) : '',
      wiflowUserId: canReuse ? unmaskedValue(previous.wiflowUserId || previous.userId) : ''
    };
  }

  function selectedAuthMode() {
    return document.querySelector('input[name="authMode"]:checked')?.value || 'client';
  }

  function togglePassword(button) {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-label', show ? 'Ocultar valor' : 'Mostrar valor');
  }

  async function refreshContext(options = {}) {
    dom.btnRefreshContext.disabled = true;
    try {
      const response = await sendCommand(MESSAGE.GET_CONTEXT, {}, { timeoutMs: 10000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível atualizar o contexto.');
      applyContext(response.context || response.data || response.payload || {});
      await startDiagnosticSession();
      renderAll();
      if (!options.quiet) showToast('Contexto atualizado.', 'success');
    } catch (error) {
      await loadActiveTabFallback();
      applyPageContext(state.tab);
      if (!options.quiet) showToast(readableError(error), 'error');
    } finally {
      dom.btnRefreshContext.disabled = false;
    }
  }

  async function startDiagnosticSession() {
    try {
      const response = await sendCommand(MESSAGE.START_DIAGNOSTICS, {
        draftId: state.draftId,
        tabId: state.tab && state.tab.id
      }, { timeoutMs: 8000 });
      if (isSuccess(response)) state.diagnostics = response.diagnostics || null;
    } catch (error) {
      // O formulário continua utilizável; uma nova tentativa acontece ao
      // selecionar o elemento obrigatório.
    }
  }

  function applyContext(context) {
    if (!context || typeof context !== 'object') return;

    state.config = mergeConfig(state.config, context.config);
    state.project = context.project || state.project;
    state.members = context.memberDirectory || context.members || state.members;
    state.tab = normalizeTab(context.tab || context.page || state.tab);
    state.connected = Boolean(state.project || context.connected === true);

    if (context.draft && !state.initialized) restoreDraft(context.draft);
    if (context.media) state.media = normalizeMediaCollection(context.media);
    if (context.recorder) state.recorder = normalizeRecorderState(context.recorder);
    if (Object.prototype.hasOwnProperty.call(context, 'diagnostics')) {
      const diagnostics = context.diagnostics;
      if (!diagnostics || !diagnostics.draftId || diagnostics.draftId === state.draftId) {
        state.diagnostics = diagnostics;
      }
    }
    if (context.viewport) {
      state.viewport = context.viewport;
      state.viewportMode = context.viewportMode || (context.viewport === 'full' ? 'full' : 'viewer');
      state.viewportActual = context.viewportActual || null;
      renderViewport();
    }

    populateResponsibleOptions(state.members);
    applyPageContext(state.tab);

    if (context.sessionExpired === true && !state.sessionExpired) {
      state.sessionExpired = true;
      if (state.initialized) handleSessionExpired();
    }
  }

  async function loadActiveTabFallback() {
    try {
      const tabs = await tabsQuery({ active: true, currentWindow: true });
      state.tab = normalizeTab(tabs && tabs[0]);
    } catch (error) {
      state.tab = state.tab || null;
    }
  }

  function applyPageContext(tab) {
    const normalized = normalizeTab(tab);
    state.tab = normalized;
    const pageUrl = normalized.url || '';
    const title = normalized.title || 'Página atual';
    let domain = 'Aba atual';

    try {
      domain = new URL(pageUrl).hostname.replace(/^www\./, '') || domain;
    } catch (error) {
      // URLs internas do Chrome não são válidas para criação de QA, mas ainda
      // podem ser apresentadas como contexto para orientar o usuário.
    }

    dom.pageDomain.textContent = domain;
    dom.pageContextTitle.textContent = title;
    dom.pageUrlDisplay.textContent = pageUrl || 'URL indisponível';
    dom.pageUrlDisplay.title = pageUrl;

    if (!dom.pageUrl.value || !state.initialized) dom.pageUrl.value = pageUrl;
    updateLocationSuggestion(pageUrl, title);
  }

  function updateLocationSuggestion(pageUrl, title) {
    if (dom.location.value.trim()) {
      dom.btnUseLocationSuggestion.classList.add('hidden');
      return;
    }

    const suggestion = suggestLocation(`${pageUrl || ''} ${title || ''}`);
    if (!suggestion || suggestion === 'Outra') {
      dom.btnUseLocationSuggestion.classList.add('hidden');
      return;
    }

    dom.btnUseLocationSuggestion.dataset.value = suggestion;
    dom.btnUseLocationSuggestion.textContent = `Usar sugestão: ${suggestion}`;
    dom.btnUseLocationSuggestion.classList.remove('hidden');
  }

  function suggestLocation(rawContext) {
    const text = normalizeSearchText(rawContext);
    const rules = [
      ['Checkout', /checkout|pagamento|finalizar-compra/],
      ['Minicart', /minicart|mini-cart|carrinho/],
      ['Produto', /produto|product|\/p\//],
      ['Categoria', /categoria|category|departamento|collection/],
      ['Busca', /busca|search|pesquisa/],
      ['Minha Conta', /minha-conta|my-account|account/],
      ['Login', /login|entrar|sign-in/],
      ['Cadastro', /cadastro|registro|sign-up/],
      ['Institucional', /institucional|sobre|contato|politica|termos/]
    ];
    return (rules.find(([, pattern]) => pattern.test(text)) || [null, null])[0];
  }

  // captureVisibleTab exige <all_urls>: um clique no painel lateral não concede
  // activeTab. O pedido sai aqui, dentro do gesto do clique, e só aparece uma vez.
  async function ensurePageAccess() {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (error) {
      granted = false;
    }
    if (!granted) {
      openPermissionsPage('pages');
      showToast('Para capturar a página, libere o acesso às páginas. O passo a passo abriu numa nova aba.', 'error');
    }
    return granted;
  }

  async function captureScreenshot() {
    if (!ensureConnected() || !(await ensurePageAccess())) return;
    setCaptureButtonsDisabled(true);
    const sessionId = makeId('capture');

    try {
      const response = await sendCommand(
        MESSAGE.SCREENSHOT,
        { draftId: state.draftId, sessionId },
        { legacyType: 'takeScreenshot', timeoutMs: 12000 }
      );
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível capturar a tela.');
      showToast('Selecione a área da captura na página.');
    } catch (error) {
      if (!handlePermissionError(error)) showToast(readableError(error), 'error');
    } finally {
      setCaptureButtonsDisabled(false);
    }
  }

  // O Fiscal do Pixel roda na própria página; a barra dele tem os controles do
  // design sobreposto e a captura, que entra como imagem no rascunho.
  async function togglePixelInspector() {
    if (!ensureConnected()) return;
    const closing = state.pixelInspector;
    if (!closing && !(await ensurePageAccess())) return;
    dom.btnPixelInspector.disabled = true;
    try {
      const response = await sendCommand(closing ? MESSAGE.PIXEL_STOP : MESSAGE.PIXEL_START, {}, { timeoutMs: 12000 });
      if (isUnsupportedMessageResponse(response)) {
        await recoverOutdatedBackground();
        return;
      }
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível abrir o Fiscal do Pixel.');
      setPixelInspectorActive(response.active);
      if (response.active) {
        showToast('Fiscal do Pixel aberto (só visualização). Ao carregar um design, a tela assume o tamanho dele.');
      }
    } catch (error) {
      if (!handlePermissionError(error)) showToast(readableError(error), 'error');
    } finally {
      dom.btnPixelInspector.disabled = false;
    }
  }

  function setPixelInspectorActive(active) {
    state.pixelInspector = Boolean(active);
    dom.btnPixelInspector.classList.toggle('is-active', state.pixelInspector);
    dom.btnPixelInspector.setAttribute('aria-pressed', String(state.pixelInspector));
    dom.pixelInspectorLabel.textContent = state.pixelInspector ? 'Encerrar Fiscal do Pixel' : 'Fiscal do Pixel';
  }

  function openPermissionsPage(focus = '', extraParams = {}) {
    const params = new URLSearchParams({ ...(focus ? { focus } : {}), ...extraParams });
    const query = params.toString();
    chrome.tabs.create({ url: chrome.runtime.getURL(`permissions/permissions.html${query ? `?${query}` : ''}`) });
  }

  // Erros de permissão abrem o guia no card certo em vez de só mostrar um aviso.
  // O mesmo erro de gravação chega por até três caminhos (resposta do comando,
  // RECORDER_ERROR do offscreen e WI_QA_ERROR do background); abre o guia uma vez.
  let lastPermissionGuideAt = 0;
  function handlePermissionError(error) {
    const code = String((error && (error.code || (error.error && error.error.code))) || '');
    const guides = {
      PAGE_ACCESS_REQUIRED: ['pages', 'Para capturar a página, libere o acesso às páginas. O passo a passo abriu numa nova aba.'],
      TAB_CAPTURE_NOT_INVOKED: ['pages', '']
    };
    const guide = guides[code];
    if (!guide) return false;
    if (Date.now() - lastPermissionGuideAt < 3000) return true;
    lastPermissionGuideAt = Date.now();
    openPermissionsPage(guide[0]);
    showToast(guide[1] || (error && error.message) || 'Veja na aba que abrimos como liberar o acesso.', 'error');
    return true;
  }

  async function startRecording() {
    if (!ensureConnected() || isRecorderActive()) return;

    const sessionId = makeId('video');
    state.recorder = {
      status: 'starting_video',
      kind: 'video',
      mode: 'tab_video',
      sessionId,
      startedAt: Date.now()
    };
    renderRecorder();
    setCaptureButtonsDisabled(true);

    try {
      const response = await sendCommand(
        MESSAGE.VIDEO_START,
        { sessionId, draftId: state.draftId, sourceTabId: state.tab && state.tab.id },
        { legacyType: 'startRecording', timeoutMs: 15000 }
      );
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível iniciar a gravação de vídeo.');

      const recording = response.recording || (response.data && response.data.recording) || {};
      state.recorder = normalizeRecorderState({
        ...state.recorder,
        ...recording,
        status: recording.status || recording.state || 'recording_video',
        startedAt: recording.startedAt || state.recorder.startedAt
      });
      renderRecorder();
    } catch (error) {
      state.recorder = { status: 'idle' };
      renderRecorder();
      setCaptureButtonsDisabled(false);
      if (!handlePermissionError(error)) showToast(readableError(error), 'error');
    }
  }

  async function togglePauseRecording() {
    const paused = isRecorderPaused();
    const kind = recorderKind();
    const type = paused ? MESSAGE.VIDEO_RESUME : MESSAGE.VIDEO_PAUSE;

    dom.btnPauseRecording.disabled = true;
    try {
      const response = await sendCommand(type, recorderPayload(), { timeoutMs: 10000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível alterar a gravação.');
      state.recorder.status = paused ? `recording_${kind}` : `paused_${kind}`;
      if (paused) {
        state.recorder.startedAt = Date.now() - (Number(state.recorder.elapsedMs) || 0);
      } else {
        state.recorder.elapsedMs = currentRecorderElapsed();
      }
      renderRecorder();
    } catch (error) {
      showToast(readableError(error), 'error');
    } finally {
      dom.btnPauseRecording.disabled = false;
    }
  }

  async function stopRecording() {
    const kind = recorderKind();
    if (!kind) return;
    state.recorder.status = `stopping_${kind}`;
    renderRecorder();

    try {
      const response = await sendCommand(
        MESSAGE.VIDEO_STOP,
        recorderPayload(),
        { legacyType: 'stopRecording', timeoutMs: 20000 }
      );
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível finalizar a gravação.');

      if (response.recording || response.storage) {
        ingestStoppedRecording(response.recording || response);
      }
      state.recorder = { status: 'idle' };
      renderAll();
    } catch (error) {
      state.recorder.status = `recording_${kind}`;
      renderRecorder();
      showToast(readableError(error), 'error');
    }
  }

  async function cancelRecording() {
    const kind = recorderKind();
    if (!kind) return;
    dom.btnCancelRecording.disabled = true;
    try {
      const response = await sendCommand(
        MESSAGE.VIDEO_CANCEL,
        recorderPayload(),
        { timeoutMs: 10000 }
      );
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível cancelar a gravação.');
      state.recorder = { status: 'idle' };
      renderRecorder();
      showToast('Gravação cancelada.');
    } catch (error) {
      showToast(readableError(error), 'error');
    } finally {
      dom.btnCancelRecording.disabled = false;
    }
  }

  function recorderPayload() {
    return {
      sessionId: state.recorder.sessionId,
      recordingId: state.recorder.recordingId,
      mode: state.recorder.mode,
      kind: recorderKind()
    };
  }

  function ingestStoppedRecording(recording) {
    if (!recording) return;
    const media = normalizeMediaItem({
      ...recording,
      status: recording.status === 'error' ? 'error' : 'local',
      storage: recording.storage,
      recordingId: recording.recordingId || (recording.storage && recording.storage.key)
    });
    if (!media) return;
    upsertMedia(media);
  }

  function renderAll() {
    renderConnection();
    renderRecorder();
    renderEvidence();
    renderDiagnostics();
    updateDescriptionCount();
    updateSubmitState();
  }

  function renderConnection() {
    if (state.connected) {
      const projectName = (state.project && state.project.name) || 'Conectado';
      dom.projectName.textContent = projectName;
      setConnectionState('online', projectName);
    } else {
      setConnectionState('offline', 'Não conectado');
    }
  }

  function renderRecorder() {
    const status = String(state.recorder.status || state.recorder.state || 'idle');
    const active = isRecorderActive();
    dom.recorderPanel.classList.toggle('hidden', !active);
    setCaptureButtonsDisabled(active);

    if (!active) {
      stopRecorderTimer();
      return;
    }

    const paused = isRecorderPaused();
    const busy = /starting|stopping|requesting|processing/.test(status);
    dom.recorderPanel.classList.toggle('is-paused', paused);
    dom.recorderPanel.classList.toggle('is-busy', busy);
    dom.recordingDot.classList.toggle('hidden', busy && /stopping|processing/.test(status));

    if (/starting|requesting/.test(status)) {
      dom.recorderTitle.textContent = 'Preparando gravação';
      dom.recorderSubtitle.textContent = 'A captura começará em instantes.';
    } else if (/stopping|processing/.test(status)) {
      dom.recorderTitle.textContent = 'Finalizando gravação';
      dom.recorderSubtitle.textContent = 'Salvando o arquivo com segurança…';
    } else if (paused) {
      dom.recorderTitle.textContent = 'Gravação pausada';
      dom.recorderSubtitle.textContent = 'Retome quando estiver pronto.';
    } else {
      dom.recorderTitle.textContent = 'Gravando a aba';
      dom.recorderSubtitle.textContent = 'As ações desta aba estão sendo registradas.';
    }

    dom.pauseButtonLabel.textContent = paused ? 'Retomar' : 'Pausar';
    dom.pauseIconUse.setAttribute('href', paused ? '#icon-play' : '#icon-pause');
    dom.btnPauseRecording.disabled = busy;
    dom.btnStopRecording.disabled = busy;
    startRecorderTimer();
    updateRecorderTimer();
  }

  function renderEvidence() {
    revokeUnusedObjectUrls();
    dom.evidenceList.replaceChildren();
    dom.evidenceSection.classList.toggle('hidden', state.media.length === 0);
    dom.evidenceCount.textContent = String(state.media.length);

    state.media.forEach((media) => {
      const fragment = dom.evidenceTemplate.content.cloneNode(true);
      const card = fragment.querySelector('.evidence-card');
      const preview = fragment.querySelector('.evidence-preview');
      const name = fragment.querySelector('.evidence-name');
      const meta = fragment.querySelector('.evidence-meta');
      const mediaState = fragment.querySelector('.evidence-state');
      const remove = fragment.querySelector('.evidence-remove');

      card.dataset.mediaId = media.id;
      name.textContent = media.name || defaultMediaName(media.kind);
      meta.textContent = [friendlyMediaKind(media.kind), formatBytes(media.sizeBytes), formatDuration(media.durationMs)]
        .filter(Boolean)
        .join(' · ');
      mediaState.textContent = friendlyMediaStatus(media);
      mediaState.title = media.uploadError || '';
      mediaState.classList.toggle('is-error', media.status === 'error');
      mediaState.classList.toggle('is-ready', Boolean(media.remoteMediaId) || ['ready', 'uploaded'].includes(media.status));
      remove.addEventListener('click', () => removeMedia(media));

      renderMediaIcon(preview, media.kind);
      dom.evidenceList.appendChild(fragment);
      hydrateMediaPreview(media, card, preview);
    });

    updateSubmitState();
  }

  function renderMediaIcon(container, kind) {
    // Mantido logo depois do resumo de diagnóstico para preservar a ordem visual.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'image' ? '#icon-camera' : '#icon-video');
    svg.appendChild(use);
    container.replaceChildren(svg);
  }

  function renderDiagnostics() {
    const diagnostics = state.diagnostics || {};
    const consoleCount = Number(diagnostics.consoleCount || 0);
    const networkCount = Number(diagnostics.networkCount || 0);
    const stepsCount = Number(diagnostics.stepsCount || 0);
    const failureCount = Number(diagnostics.consoleErrors || 0) + Number(diagnostics.networkFailures || 0);
    dom.consoleCount.textContent = String(consoleCount);
    dom.networkCount.textContent = String(networkCount);
    dom.stepsCount.textContent = String(stepsCount);
    dom.elementCount.textContent = diagnostics.element ? '1' : '0';
    dom.diagnosticsStatus.textContent = diagnostics.active === false ? 'Pausado' : 'Monitorando';
    dom.diagnosticsStatus.classList.toggle('is-paused', diagnostics.active === false);
    dom.diagnosticsAlert.textContent = failureCount
      ? `${failureCount} falha${failureCount === 1 ? '' : 's'} detectada${failureCount === 1 ? '' : 's'}`
      : 'Sem falhas detectadas';
    dom.diagnosticsAlert.classList.toggle('has-errors', failureCount > 0);
    const selected = diagnostics.element;
    dom.selectedElementSection.classList.toggle('hidden', !selected);
    dom.btnSelectElement.classList.toggle('is-selected', Boolean(selected));
    dom.selectElementButtonLabel.textContent = selected ? 'Elemento selecionado' : 'Selecionar elemento';
    dom.selectedElementLabel.textContent = selected
      ? `Elemento: ${selected.accessible_name && selected.accessible_name !== '[REDACTED]' ? `${selected.accessible_name} · ` : ''}${selected.selector || selected.tag}`
      : '';
    renderElementPreview(selected ? diagnostics.elementPreview : null);
    updateSubmitState();
  }

  function renderElementPreview(preview) {
    const dataUrl = preview && safePreviewUrl(preview.dataUrl);
    dom.elementPreview.classList.toggle('hidden', !dataUrl);
    if (!dataUrl) {
      dom.elementPreviewImage.removeAttribute('src');
      return;
    }
    if (dom.elementPreviewImage.getAttribute('src') !== dataUrl) {
      dom.elementPreviewImage.src = dataUrl;
      dom.btnAttachElement.disabled = false;
    }
    dom.elementPreviewNote.textContent = preview.clipped
      ? 'Prévia da parte visível do elemento'
      : 'Prévia do elemento';
  }

  // Ao selecionar, a prévia é anexada sozinha ({ auto: true }); trocar de
  // elemento substitui a imagem anexada automaticamente da seleção anterior.
  async function attachElementPreview({ auto = false } = {}) {
    const preview = state.diagnostics && state.diagnostics.elementPreview;
    if (!preview || !preview.dataUrl) return false;
    dom.btnAttachElement.disabled = true;
    try {
      if (auto) await removeAutoAttachedPreview();
      const response = await sendCommand('WI_QA_SAVE_SCREENSHOT', {
        dataUrl: preview.dataUrl,
        filePrefix: 'elemento'
      }, { timeoutMs: 20000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível anexar a prévia.');
      if (auto) state.autoPreviewRecordingId = (response.media && response.media.recordingId) || '';
      else showToast('Prévia do elemento anexada como imagem.', 'success');
      return true;
    } catch (error) {
      dom.btnAttachElement.disabled = false;
      showToast(readableError(error), 'error');
      return false;
    }
  }

  async function removeAutoAttachedPreview() {
    const recordingId = state.autoPreviewRecordingId;
    state.autoPreviewRecordingId = '';
    if (!recordingId || !state.media.some((entry) => entry.recordingId === recordingId)) return;
    await sendCommand(MESSAGE.MEDIA_REMOVE, { recordingId }, { timeoutMs: 8000 }).catch(() => undefined);
  }

  // --- Visualizador ampliado -------------------------------------------------

  function openViewer({ src, kind = 'image', title = '' }) {
    const url = safePreviewUrl(src);
    if (!url) return;
    state.viewer = { src: url, kind };
    dom.mediaViewerTitle.textContent = title || (kind === 'video' ? 'Vídeo' : 'Imagem');
    dom.mediaViewerBody.classList.remove('is-actual-size');
    dom.btnViewerZoom.textContent = 'Tamanho real';
    dom.btnViewerZoom.classList.toggle('hidden', kind === 'video');

    let media;
    if (kind === 'video') {
      media = document.createElement('video');
      media.controls = true;
      media.autoplay = true;
    } else {
      media = document.createElement('img');
      media.alt = title || 'Imagem ampliada';
      media.title = 'Clique para alternar entre ajustar à tela e tamanho real';
    }
    media.src = url;
    dom.mediaViewerBody.replaceChildren(media);
    if (typeof dom.mediaViewer.showModal === 'function') dom.mediaViewer.showModal();
    else dom.mediaViewer.setAttribute('open', '');
  }

  function closeViewer() {
    if (typeof dom.mediaViewer.close === 'function') dom.mediaViewer.close();
    else dom.mediaViewer.removeAttribute('open');
    clearViewer();
  }

  // Também roda quando o Esc fecha o <dialog> nativamente; sem isso um vídeo
  // continuaria tocando escondido.
  function clearViewer() {
    dom.mediaViewerBody.replaceChildren();
    state.viewer = null;
  }

  function toggleViewerZoom() {
    if (!state.viewer || state.viewer.kind === 'video') return;
    const actual = dom.mediaViewerBody.classList.toggle('is-actual-size');
    dom.btnViewerZoom.textContent = actual ? 'Ajustar à tela' : 'Tamanho real';
  }

  // Data URLs não podem ser abertas numa aba nova (o Chrome bloqueia a
  // navegação); viram blob: da própria extensão.
  async function openViewerInTab() {
    if (!state.viewer) return;
    let url = state.viewer.src;
    if (url.startsWith('data:')) {
      url = URL.createObjectURL(await (await fetch(url)).blob());
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    chrome.tabs.create({ url });
  }

  // Torna a miniatura um botão que abre o visualizador.
  function makeZoomable(target, open) {
    target.classList.add('is-zoomable');
    target.setAttribute('role', 'button');
    target.tabIndex = 0;
    target.title = 'Ampliar';
    target.addEventListener('click', open);
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }

  async function selectElement() {
    if (!ensureConnected() || !(await ensurePageAccess())) return;
    dom.btnSelectElement.disabled = true;
    dom.btnChangeElement.disabled = true;
    try {
      const response = await sendCommand(MESSAGE.SELECT_ELEMENT, { draftId: state.draftId }, { timeoutMs: 120000 });
      if (isUnsupportedMessageResponse(response)) {
        await recoverOutdatedBackground();
        return;
      }
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível selecionar o elemento.');
      state.diagnostics = response.diagnostics || state.diagnostics;
      renderDiagnostics();
      const attached = await attachElementPreview({ auto: true });
      showToast(attached ? 'Elemento associado ao relato, com imagem anexada.' : 'Elemento associado ao relato.', 'success');
    } catch (error) {
      if (!/cancelad/i.test(String(error?.message || error)) && !handlePermissionError(error)) {
        showToast(readableError(error), 'error');
      }
    } finally {
      dom.btnSelectElement.disabled = false;
      dom.btnChangeElement.disabled = false;
    }
  }

  async function clearDiagnostics() {
    try {
      const response = await sendCommand(MESSAGE.CLEAR_DIAGNOSTICS, { draftId: state.draftId });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível limpar o contexto.');
      state.diagnostics = response.diagnostics || null;
      renderDiagnostics();
      showToast('Diagnóstico técnico limpo. O elemento foi mantido.', 'success');
    } catch (error) {
      showToast(readableError(error), 'error');
    }
  }

  async function hydrateMediaPreview(media, card, preview) {
    let url = safePreviewUrl(media.previewUrl || media.dataUrl || media.url);
    if (!url && media.recordingId) {
      const record = await readMediaRecord(media.recordingId);
      if (record && record.blob instanceof Blob) {
        url = URL.createObjectURL(record.blob);
        state.objectUrls.set(media.id, url);
      }
    }
    if (!url || !card.isConnected) return;

    if (media.kind === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = `Prévia de ${media.name || 'captura'}`;
      preview.replaceChildren(image);
    } else if (media.kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.preload = 'metadata';
      video.setAttribute('aria-label', `Prévia de ${media.name || 'vídeo'}`);
      preview.replaceChildren(video);
    } else {
      return;
    }
    makeZoomable(preview, () => openViewer({ src: url, kind: media.kind, title: media.name }));
  }

  async function removeMedia(media) {
    const card = dom.evidenceList.querySelector(`[data-media-id="${escapeAttribute(media.id)}"]`);
    const button = card && card.querySelector('.evidence-remove');
    if (button) button.disabled = true;

    try {
      const response = await sendCommand(MESSAGE.MEDIA_REMOVE, {
        mediaId: media.mediaId || media.id,
        recordingId: media.recordingId,
        draftId: state.draftId
      }, { timeoutMs: 10000 });

      if (response && !isSuccess(response)) throw responseError(response, 'Não foi possível remover o arquivo.');
      state.media = state.media.filter((item) => item.id !== media.id);
      await storageSet({ [STORAGE.MEDIA]: state.media.map(stripUiMediaFields) });
      if (media.dataUrl) await storageRemove(STORAGE.LEGACY_MEDIA);
      revokeMediaObjectUrl(media.id);
      renderEvidence();
      scheduleDraftSave();
    } catch (error) {
      if (button) button.disabled = false;
      showToast(readableError(error), 'error');
    }
  }

  function restoreDraft(draft) {
    if (!draft || typeof draft !== 'object') {
      if (!dom.location.value) updateLocationSuggestion(state.tab && state.tab.url, state.tab && state.tab.title);
      return;
    }

    if (state.project && draft.projectId && draft.projectId !== state.project.id) return;
    const item = draft.item || draft;
    state.draftId = draft.id || draft.draftId || state.draftId;

    setValueIfPresent(dom.description, item.description);
    setSelectValue(dom.device, item.device, ENUMS.device);
    setValueIfPresent(dom.location, item.location);
    setSelectValue(dom.priority, item.priority, ENUMS.priority);
    setSelectValue(dom.status, item.status, ENUMS.status);
    setValueIfPresent(dom.pageUrl, item.page_url || item.pageUrl);
    setValueIfPresent(dom.authorName, draft.author && draft.author.name);
    setValueIfPresent(dom.authorEmail, draft.author && draft.author.email);

    const responsibleId = item.responsible_id || item.responsibleId;
    if (responsibleId) ensureResponsibleOption(responsibleId, item.responsible_name || item.responsibleName);
    if (responsibleId) dom.responsible.value = responsibleId;

    if (!state.media.length && draft.media) state.media = normalizeMediaCollection(draft.media);
    updateDescriptionCount();
  }

  function serializeDraft() {
    const responsibleOption = dom.responsible.selectedOptions && dom.responsible.selectedOptions[0];
    const responsibleId = dom.responsible.value || null;
    const responsibleName = responsibleId
      ? (responsibleOption?.dataset.name || responsibleOption?.textContent || null)
      : null;
    const imageUrls = state.media
      .filter((media) => media.kind === 'image')
      .map((media) => media.remoteUrl || media.publicUrl || (isHttpUrl(media.url) ? media.url : ''))
      .filter(Boolean);
    const attachmentIds = state.media.map((media) => media.attachmentId || media.mediaId).filter(Boolean);

    return {
      id: state.draftId,
      draftId: state.draftId,
      version: 1,
      projectId: state.project && state.project.id,
      sourceTabId: state.tab && state.tab.id,
      sourcePageUrl: dom.pageUrl.value.trim(),
      updatedAt: new Date().toISOString(),
      item: {
        device: dom.device.value,
        location: dom.location.value.trim(),
        page_url: dom.pageUrl.value.trim(),
        description: dom.description.value.trim(),
        image_url: imageUrls[0] || null,
        image_urls: imageUrls,
        status: dom.status.value,
        priority: dom.priority.value,
        responsible_id: responsibleId,
        responsible_name: responsibleName
      },
      author: {
        name: dom.authorName.value.trim() || undefined,
        email: dom.authorEmail.value.trim() || undefined
      },
      media: state.media.map(stripUiMediaFields),
      attachment_ids: attachmentIds,
      client_request_id: state.draftId
    };
  }

  function fieldChanged() {
    scheduleDraftSave();
    updateSubmitState();
    if (dom.location.value.trim()) dom.btnUseLocationSuggestion.classList.add('hidden');
  }

  function scheduleDraftSave() {
    if (!state.initialized) return;
    clearTimeout(state.draftSaveTimer);
    updateDraftStatus('saving');
    state.draftSaveTimer = setTimeout(saveDraftNow, 350);
  }

  async function saveDraftNow() {
    clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
    try {
      await storageSet({ [STORAGE.DRAFT]: serializeDraft() });
      updateDraftStatus('saved');
    } catch (error) {
      updateDraftStatus('error');
    }
  }

  function updateDraftStatus(status) {
    dom.draftStatus.classList.toggle('is-saving', status !== 'saved');
    dom.draftStatus.textContent = status === 'saving'
      ? 'Salvando rascunho…'
      : status === 'error'
        ? 'Rascunho não salvo'
        : 'Rascunho salvo';
  }

  function validateDraft(options = {}) {
    const draft = serializeDraft();
    const item = draft.item;
    let message = '';
    let field = null;

    if (!state.connected) message = 'Conecte um projeto antes de enviar.';
    else if (!(state.diagnostics && state.diagnostics.element)) message = 'Selecione o elemento onde o problema acontece.';
    else if (!item.description) { message = 'Descreva o problema encontrado.'; field = dom.description; }
    else if (!ENUMS.device.includes(item.device)) { message = 'Selecione um dispositivo válido.'; field = dom.device; }
    else if (!item.location) { message = 'Informe onde o problema aparece.'; field = dom.location; }
    else if (!isHttpUrl(item.page_url)) { message = 'Informe uma URL de página válida (HTTP ou HTTPS).'; field = dom.pageUrl; }
    else if (!ENUMS.priority.includes(item.priority)) { message = 'Selecione uma prioridade válida.'; field = dom.priority; }
    else if (!ENUMS.status.includes(item.status)) { message = 'Selecione um status válido.'; field = dom.status; }
    else if (draft.author.email && !dom.authorEmail.validity.valid) { message = 'Revise o e-mail do autor.'; field = dom.authorEmail; }

    if (options.focus && field) {
      field.focus();
      field.reportValidity?.();
    }
    return { valid: !message, message, draft };
  }

  function updateSubmitState() {
    const validation = validateDraft();
    dom.validationHint.textContent = validation.valid ? 'Tudo pronto para enviar.' : validation.message;
    dom.btnSubmit.disabled = state.submitting || isRecorderActive() || !validation.valid;
  }

  async function submitDraft() {
    if (state.submitting) return;
    const validation = validateDraft({ focus: true });
    if (!validation.valid) {
      showToast(validation.message, 'error');
      return;
    }

    state.submitting = true;
    setSubmitBusy(true);
    await saveDraftNow();

    try {
      const response = await sendCommand(MESSAGE.CREATE_ITEM, {
        draft: validation.draft,
        clientRequestId: state.draftId
      }, { timeoutMs: 60000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível criar o item de QA.');
      handleItemCreated(response.item || (response.data && response.data.item) || response.payload || response);
    } catch (error) {
      showToast(readableError(error), 'error');
    } finally {
      state.submitting = false;
      setSubmitBusy(false);
      updateSubmitState();
    }
  }

  // O item chega duas vezes (resposta do comando e broadcast WI_QA_ITEM_CREATED);
  // o id evita resetar o formulário do próximo relato.
  function handleItemCreated(item) {
    const id = item && String(item.id || item.itemId || item.qa_item_id || '');
    if (!item || (id && id === state.lastCreatedItemId)) return;
    state.lastCreatedItemId = id || makeId('item');
    showToast('QA criado com sucesso.', 'success');
    state.itemsFetchedAt = 0;
    void resetComposer();
  }

  async function resetComposer() {
    const previousDraftId = state.draftId;
    const author = { name: dom.authorName.value, email: dom.authorEmail.value };
    state.draftId = makeId('draft');
    state.media = [];
    state.diagnostics = null;
    state.autoPreviewRecordingId = '';

    dom.qaForm.reset();
    dom.device.value = VIEWPORT_DEVICE[state.viewport] || 'Desktop';
    dom.priority.value = 'Média';
    dom.status.value = 'Pendente';
    dom.pageUrl.value = (state.tab && state.tab.url) || '';
    dom.authorName.value = author.name;
    dom.authorEmail.value = author.email;

    try {
      const response = await sendCommand(MESSAGE.DRAFT_RESET, {
        draftId: previousDraftId,
        nextDraftId: state.draftId,
        tabId: state.tab && state.tab.id
      }, { timeoutMs: 8000 });
      if (isSuccess(response)) state.diagnostics = response.diagnostics || null;
    } catch (error) {
      // O reset local mantém a ação utilizável em versões antigas do background.
    }
    await storageRemove([STORAGE.DRAFT, STORAGE.MEDIA, STORAGE.LEGACY_MEDIA]);
    renderAll();
    updateLocationSuggestion(state.tab && state.tab.url, state.tab && state.tab.title);
    scheduleDraftSave();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function populateResponsibleOptions(directory) {
    const selected = dom.responsible.value;
    dom.responsible.replaceChildren(new Option('Sem responsável', ''));

    const groups = normalizeMemberGroups(directory);
    groups.forEach(({ label, members }) => {
      if (!members.length) return;
      const optionGroup = document.createElement('optgroup');
      optionGroup.label = label;
      members.forEach((member) => {
        const option = new Option(member.name || member.id, member.id);
        option.dataset.name = member.name || member.id;
        optionGroup.appendChild(option);
      });
      dom.responsible.appendChild(optionGroup);
    });

    if (selected) dom.responsible.value = selected;
    const isWiflow = (state.config && state.config.authMode === 'wiflow') || selectedAuthMode() === 'wiflow';
    dom.responsible.disabled = !isWiflow;
    dom.responsibleHint.textContent = isWiflow
      ? 'Selecione um membro retornado pelo projeto.'
      : 'Atribuição está disponível apenas em sessões internas do WiFlow.';
  }

  function normalizeMemberGroups(directory) {
    if (!directory || typeof directory !== 'object') return [];
    const labels = { dev: 'Desenvolvimento', design: 'Design', manager: 'Gestão' };
    return Object.entries(directory).map(([key, list]) => ({
      label: labels[key] || key,
      members: Array.isArray(list)
        ? list.filter((member) => member && member.id).map((member) => ({ id: String(member.id), name: String(member.name || member.id) }))
        : []
    }));
  }

  function ensureResponsibleOption(id, name) {
    if (Array.from(dom.responsible.options).some((option) => option.value === String(id))) return;
    const option = new Option(name || id, id);
    option.dataset.name = name || id;
    dom.responsible.appendChild(option);
  }

  function handleStorageChanges(changes, areaName) {
    if (areaName !== 'local') return;
    let mediaChanged = false;

    if (changes[STORAGE.MEDIA]) {
      state.media = normalizeMediaCollection(changes[STORAGE.MEDIA].newValue);
      mediaChanged = true;
    }
    if (changes[STORAGE.LEGACY_MEDIA] && !changes[STORAGE.MEDIA]) {
      state.media = normalizeMediaCollection(state.media, changes[STORAGE.LEGACY_MEDIA].newValue);
      mediaChanged = true;
    }
    if (changes[STORAGE.RECORDER]) {
      state.recorder = normalizeRecorderState(changes[STORAGE.RECORDER].newValue);
      renderRecorder();
    }
    if (changes[STORAGE.PROJECT] && changes[STORAGE.PROJECT].newValue) {
      state.project = changes[STORAGE.PROJECT].newValue;
      state.connected = true;
      renderConnection();
    }
    if (changes[STORAGE.LEGACY_RECORDING]) {
      if (changes[STORAGE.LEGACY_RECORDING].newValue) {
        state.recorder = normalizeRecorderState({
          status: 'recording_video',
          kind: 'video',
          startedAt: changes[STORAGE.LEGACY_RECORDING_START]?.newValue || Date.now()
        });
      } else if (recorderKind() === 'video') {
        state.recorder = { status: 'idle' };
      }
      renderRecorder();
    }
    if (mediaChanged) {
      renderEvidence();
      scheduleDraftSave();
    }
  }

  function handleRuntimeMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const payload = message.payload || message.data || message;

    switch (message.type) {
      case 'WI_QA_CONTEXT_UPDATED':
        applyContext(payload.context || payload);
        renderAll();
        break;
      case 'WI_QA_MEDIA_UPDATED':
        state.media = normalizeMediaCollection(payload.media || payload.items || payload);
        renderEvidence();
        scheduleDraftSave();
        break;
      case 'WI_QA_RECORDER_STATE':
        acceptRecorderEvent(payload);
        break;
      case 'WI_QA_DIAGNOSTICS_UPDATED':
        if (payload && payload.draftId && payload.draftId !== state.draftId) break;
        // Eventos de outras abas (e de iframes, que chegam sem draftId) não
        // podem substituir o diagnóstico — e o elemento — da aba em uso.
        if (payload && Number.isInteger(payload.tabId) && state.tab && payload.tabId !== state.tab.id) break;
        state.diagnostics = payload && payload.active ? payload : null;
        renderDiagnostics();
        break;
      case 'WI_QA_ITEM_CREATED':
        handleItemCreated(payload.item || payload);
        break;
      case 'WI_QA_SESSION_EXPIRED':
        handleSessionExpired(payload && payload.message);
        break;
      case 'WI_QA_VIEWPORT_STATE':
        if (!state.tab || payload.tabId === state.tab.id) {
          state.viewport = payload.preset || 'full';
          state.viewportMode = payload.mode || (state.viewport === 'full' ? 'full' : 'viewer');
          state.viewportActual = payload.actualViewport || null;
          renderViewport();
        }
        break;
      case 'WI_QA_PIXEL_INSPECTOR_STATE':
        if (!state.tab || payload.tabId === state.tab.id) setPixelInspectorActive(payload.active);
        break;
      case 'WI_QA_PIXEL_EVIDENCE_ADDED':
        showToast('Evidência do Fiscal do Pixel anexada ao rascunho.', 'success');
        break;
      case 'WI_QA_ERROR':
        if (isUnsupportedMessagePayload(payload)) {
          void recoverOutdatedBackground();
        } else if (matchesCurrentSession(payload) && !handlePermissionError(payload.error || payload)) {
          showToast(readableError(payload.error || payload), 'error');
        }
        break;
      case 'RECORDER_STARTED':
      case 'RECORDER_PROGRESS':
      case 'RECORDER_PAUSED':
      case 'RECORDER_RESUMED':
      case 'RECORDER_STOPPED':
      case 'RECORDER_CANCELLED':
      case 'RECORDER_ERROR':
        acceptRecorderEvent({ ...payload, eventType: message.type });
        break;
      default:
        break;
    }
    return false;
  }

  function acceptRecorderEvent(event) {
    if (!event || !matchesCurrentSession(event)) return;
    const eventType = event.eventType || event.type || '';
    const inferred = eventType === 'RECORDER_STARTED'
      ? `recording_${event.kind || modeToKind(event.mode)}`
      : eventType === 'RECORDER_PAUSED'
        ? `paused_${event.kind || modeToKind(event.mode)}`
        : eventType === 'RECORDER_RESUMED'
          ? `recording_${event.kind || modeToKind(event.mode)}`
          : eventType === 'RECORDER_STOPPED'
            ? 'stopped'
            : eventType === 'RECORDER_CANCELLED'
              ? 'cancelled'
            : eventType === 'RECORDER_ERROR'
              ? 'error'
              : event.status || event.state || state.recorder.status;

    if (eventType === 'RECORDER_ERROR') {
      if (!handlePermissionError(event.error || event)) showToast(readableError(event.error || event), 'error');
      state.recorder = { status: 'idle' };
    } else if (eventType === 'RECORDER_STOPPED') {
      ingestStoppedRecording(event.recording || event);
      state.recorder = { status: 'idle' };
    } else if (eventType === 'RECORDER_CANCELLED') {
      state.recorder = { status: 'idle' };
    } else {
      state.recorder = normalizeRecorderState({ ...state.recorder, ...event, status: inferred });
    }
    renderAll();
  }

  function matchesCurrentSession(payload) {
    const current = state.recorder.sessionId;
    return !payload.sessionId || !current || payload.sessionId === current;
  }

  function normalizeMediaCollection(value, legacyMedia) {
    let list = [];
    if (Array.isArray(value)) list = value;
    else if (value && Array.isArray(value.items)) list = value.items;
    else if (value && (value.kind || value.type || value.recordingId || value.mediaId)) list = [value];

    if (legacyMedia) list = list.concat([legacyMedia]);
    const byId = new Map();
    list.map(normalizeMediaItem).filter(Boolean).forEach((item) => {
      const duplicateKey = item.recordingId || item.mediaId || item.id;
      byId.set(duplicateKey, item);
    });
    return Array.from(byId.values());
  }

  function normalizeMediaItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = normalizeMediaKind(raw.kind || raw.type || modeToKind(raw.mode) || raw.mimeType);
    if (!kind) return null;
    const recordingId = raw.recordingId || raw.storage?.key || '';
    const mediaId = raw.mediaId || raw.attachmentId || raw.attachment_id || '';
    return {
      ...raw,
      id: String(raw.id || mediaId || recordingId || makeId('media')),
      mediaId: mediaId ? String(mediaId) : '',
      attachmentId: String(raw.attachmentId || raw.attachment_id || mediaId || ''),
      recordingId: recordingId ? String(recordingId) : '',
      kind,
      name: raw.name || raw.fileName || defaultMediaName(kind),
      mimeType: raw.mimeType || raw.mime_type || '',
      sizeBytes: Number(raw.sizeBytes || raw.size_bytes || raw.size || 0),
      durationMs: Number(raw.durationMs || raw.duration_ms || 0),
      status: normalizeMediaStatus(raw.status || raw.uploadStatus || (raw.dataUrl ? 'local' : 'local')),
      dataUrl: raw.dataUrl || '',
      previewUrl: raw.previewUrl || raw.objectUrl || '',
      remoteUrl: raw.remoteUrl || raw.publicUrl || raw.image_url || '',
      url: raw.url || ''
    };
  }

  function normalizeRecorderState(raw) {
    if (!raw || typeof raw !== 'object') return { status: 'idle' };
    const kind = 'video';
    let status = String(raw.status || raw.state || 'idle').toLowerCase();
    const aliases = {
      recording: `recording_${kind}`,
      paused: `paused_${kind}`,
      starting: `starting_${kind}`,
      stopping: `stopping_${kind}`,
      inactive: 'idle',
      stopped: 'idle'
    };
    status = aliases[status] || status;
    return { ...raw, kind, status };
  }

  function legacyRecorderState(localState) {
    return localState[STORAGE.LEGACY_RECORDING]
      ? { status: 'recording_video', kind: 'video', startedAt: localState[STORAGE.LEGACY_RECORDING_START] || Date.now() }
      : { status: 'idle' };
  }

  function upsertMedia(media) {
    const index = state.media.findIndex((item) => item.id === media.id || (media.recordingId && item.recordingId === media.recordingId));
    if (index >= 0) state.media[index] = { ...state.media[index], ...media };
    else state.media.push(media);
    renderEvidence();
    scheduleDraftSave();
  }

  function isRecorderActive() {
    return !['idle', 'none', 'stopped', 'cancelled', 'error'].includes(String(state.recorder.status || 'idle'));
  }

  function isRecorderPaused() {
    return String(state.recorder.status || '').includes('paused');
  }

  function recorderKind() {
    return normalizeMediaKind(state.recorder.kind || modeToKind(state.recorder.mode) || state.recorder.status);
  }

  function startRecorderTimer() {
    if (state.timerInterval) return;
    state.timerInterval = setInterval(updateRecorderTimer, 500);
  }

  function stopRecorderTimer() {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  function updateRecorderTimer() {
    const elapsed = currentRecorderElapsed();
    dom.recorderTimer.textContent = formatClock(elapsed);
    dom.recorderTimer.dateTime = toDurationString(elapsed);
  }

  function currentRecorderElapsed() {
    const stored = Number(state.recorder.elapsedMs || state.recorder.durationMs || 0);
    if (isRecorderPaused()) return stored;
    const startedAt = normalizeTimestamp(state.recorder.startedAt);
    return startedAt ? Math.max(stored, Date.now() - startedAt) : stored;
  }

  function showSetup(allowCancel) {
    populateSetupForm(state.config);
    dom.setupView.classList.remove('hidden');
    dom.workspaceView.classList.add('hidden');
    dom.submitBar.classList.add('hidden');
    dom.btnCancelSetup.classList.toggle('hidden', !allowCancel || !state.connected);
    dom.setupTitle.textContent = state.connected ? 'Configurações da conexão' : 'Conecte seu projeto';
    clearSetupError();
    requestAnimationFrame(() => setupFocusTarget().focus());
  }

  function setupFocusTarget() {
    if (selectedAuthMode() !== 'wiflow') return dom.guestCredential;
    if (!dom.projectToken.value) return dom.projectToken;
    return state.loginStep === 'code' ? dom.loginCode : dom.loginEmail;
  }

  function showWorkspace() {
    if (!state.connected || state.sessionExpired) return showSetup(false);
    dom.setupView.classList.add('hidden');
    dom.workspaceView.classList.remove('hidden');
    setActiveTab(state.activeTab);
    renderAll();
  }

  function setActiveTab(tab) {
    state.activeTab = tab === 'list' ? 'list' : 'compose';
    const radio = document.querySelector(`input[name="workspaceTab"][value="${state.activeTab}"]`);
    if (radio) radio.checked = true;
    const listing = state.activeTab === 'list';
    dom.composeView.classList.toggle('hidden', listing);
    dom.listView.classList.toggle('hidden', !listing);
    dom.submitBar.classList.toggle('hidden', listing || dom.workspaceView.classList.contains('hidden'));
    if (listing) loadItems();
  }

  // --- Sessão -------------------------------------------------------------

  // Volta para a tela de conexão assim que o token de convidado vence, em vez
  // de esperar o próximo envio falhar com "Acesso não autorizado".
  function handleSessionExpired(message) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
    state.sessionExpired = true;
    if (state.config) {
      state.config = { ...state.config, clientAccessToken: '', wiflowSessionToken: '', sessionToken: '' };
    }
    const fallback = state.config && state.config.authMode === 'wiflow'
      ? 'Sua sessão expirou. Entre novamente com seu e-mail para continuar.'
      : 'Sua sessão expirou. Informe a senha novamente para continuar.';
    // Resposta e broadcast chegam juntos; reabrir a tela limparia a senha que
    // a pessoa já pode estar digitando.
    if (state.sessionPromptShown) {
      showSetupError(message || fallback);
      return;
    }
    state.sessionPromptShown = true;
    setLoginStep('email');
    showSetup(false);
    showSetupError(message || fallback);
    setConnectionState('offline', 'Sessão expirada');
  }

  function sessionExpiresAt() {
    const config = state.config || {};
    if (config.authMode === 'wiflow') return 0;
    const value = Date.parse(config.clientAccessExpiresAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function scheduleSessionExpiry() {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
    const expiresAt = sessionExpiresAt();
    if (!expiresAt) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      handleSessionExpired();
      return;
    }
    // setTimeout estoura acima de ~24,8 dias; o token dura 12h.
    state.sessionTimer = setTimeout(checkSessionExpiry, Math.min(delay + 500, 2 ** 31 - 1));
  }

  // Timers atrasam com o painel em segundo plano; confere ao voltar a ficar visível.
  function checkSessionExpiry() {
    if (!state.connected || state.sessionExpired) return;
    const expiresAt = sessionExpiresAt();
    if (expiresAt && expiresAt <= Date.now()) handleSessionExpired();
    else scheduleSessionExpiry();
  }

  // --- Listagem de itens ----------------------------------------------------

  async function loadItems(options = {}) {
    if (state.itemsLoading || !state.connected) return;
    const fresh = state.itemsFetchedAt && Date.now() - state.itemsFetchedAt < ITEMS_STALE_MS;
    if (fresh && !options.force) {
      renderItems();
      return;
    }

    state.itemsLoading = true;
    state.itemsError = '';
    dom.btnRefreshItems.disabled = true;
    renderItems();
    try {
      const response = await sendCommand(MESSAGE.LIST_ITEMS, {}, { timeoutMs: 30000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível carregar os itens.');
      state.items = Array.isArray(response.items) ? response.items : [];
      state.itemsFetchedAt = response.fetchedAt || Date.now();
    } catch (error) {
      state.itemsError = readableError(error);
    } finally {
      state.itemsLoading = false;
      dom.btnRefreshItems.disabled = false;
      renderItems();
    }
  }

  function filteredItems() {
    const filter = dom.itemsStatusFilter.value;
    const query = normalizeSearchText(dom.itemsSearch.value.trim());
    return state.items.filter((item) => {
      if (filter === 'open' && CLOSED_STATUSES.includes(item.status)) return false;
      if (filter !== 'open' && filter !== 'all' && item.status !== filter) return false;
      if (!query) return true;
      return normalizeSearchText([item.description, item.location, item.created_by_name, item.page_url].join(' ')).includes(query);
    });
  }

  function renderItems() {
    const openCount = state.items.filter((item) => !CLOSED_STATUSES.includes(item.status)).length;
    dom.itemsCountBadge.textContent = String(openCount);
    dom.itemsCountBadge.classList.toggle('hidden', !state.itemsFetchedAt || openCount === 0);

    const showState = (message, isError = false) => {
      dom.itemsState.textContent = message;
      dom.itemsState.classList.toggle('is-error', isError);
      dom.itemsState.classList.remove('hidden');
    };
    dom.itemsState.classList.add('hidden');

    if (state.itemsLoading && !state.items.length) {
      dom.itemsList.replaceChildren();
      dom.itemsSummary.textContent = '';
      showState('Carregando itens…');
      return;
    }
    if (state.itemsError) {
      showState(state.itemsError, true);
      if (!state.items.length) {
        dom.itemsList.replaceChildren();
        return;
      }
    }

    const items = filteredItems();
    dom.itemsSummary.textContent = state.items.length
      ? `${items.length} de ${state.items.length} ${state.items.length === 1 ? 'item' : 'itens'}`
      : '';
    dom.itemsList.replaceChildren(...items.map(renderItemCard));
    if (!items.length && !state.itemsError) {
      showState(state.items.length ? 'Nenhum item corresponde aos filtros.' : 'Nenhum item de QA neste projeto ainda.');
    }
  }

  function renderItemCard(item) {
    const expanded = state.expandedItems.has(item.id);
    const card = element('article', 'qa-card');
    card.classList.toggle('is-expanded', expanded);

    const toggle = element('button', 'qa-card-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.addEventListener('click', () => {
      if (state.expandedItems.has(item.id)) state.expandedItems.delete(item.id);
      else state.expandedItems.add(item.id);
      renderItems();
    });

    const top = element('div', 'qa-card-top');
    const status = element('span', 'qa-status', item.status || 'Pendente');
    status.dataset.status = item.status || '';
    const priority = element('span', 'qa-priority', item.priority || '');
    priority.dataset.priority = item.priority || '';
    top.append(status, priority, element('span', 'qa-meta-line', formatRelativeDate(item.created_at)));

    const footerParts = [
      [item.device, item.location].filter(Boolean).join(' · '),
      item.created_by_name ? `por ${item.created_by_name}` : '',
      item.image_urls.length ? `${item.image_urls.length} ${item.image_urls.length === 1 ? 'imagem' : 'imagens'}` : '',
      item.comments.length ? `${item.comments.length} ${item.comments.length === 1 ? 'comentário' : 'comentários'}` : ''
    ].filter(Boolean);
    const footer = element('div', 'qa-card-footer');
    footerParts.forEach((part) => footer.appendChild(element('span', '', part)));

    toggle.append(top, element('p', 'qa-description', item.description || 'Sem descrição.'), footer);
    card.appendChild(toggle);
    if (expanded) card.appendChild(renderItemDetails(item));
    return card;
  }

  function renderItemDetails(item) {
    const details = element('div', 'qa-card-details');

    const images = item.image_urls.filter(isHttpUrl);
    if (images.length) {
      const thumbs = element('div', 'qa-thumbs');
      images.forEach((url, index) => {
        const link = element('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        const image = element('img');
        image.src = url;
        image.alt = `Imagem ${index + 1} do item`;
        image.loading = 'lazy';
        link.appendChild(image);
        // Clique abre o visualizador; Ctrl/botão do meio mantém a nova aba.
        link.addEventListener('click', (event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          openViewer({ src: url, kind: 'image', title: `Imagem ${index + 1} de ${images.length}` });
        });
        thumbs.appendChild(link);
      });
      details.appendChild(thumbs);
    }

    if (item.responsible_name) {
      details.appendChild(element('div', 'qa-card-footer', `Responsável: ${item.responsible_name}`));
    }

    if (item.comments.length) {
      const list = element('ul', 'qa-comments');
      item.comments.forEach((comment) => {
        const entry = element('li');
        entry.append(
          element('strong', '', `${comment.author_name || 'Usuário'} · ${formatRelativeDate(comment.created_at)}`),
          document.createTextNode(comment.body || '')
        );
        list.appendChild(entry);
      });
      details.appendChild(list);
    }

    const actions = element('div', 'qa-card-actions');
    if (isHttpUrl(item.page_url)) {
      const open = element('a', 'button button-secondary button-small', 'Abrir página');
      open.href = item.page_url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      actions.appendChild(open);
    }
    const copy = element('button', 'button button-ghost button-small', 'Copiar ID');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(item.id, 'ID copiado.'));
    actions.appendChild(copy);
    details.appendChild(actions);
    return details;
  }

  function element(tag, className = '', text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatRelativeDate(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    return new Date(time).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }

  // --- Simulação de tela ------------------------------------------------------

  async function changeViewport(preset) {
    if (state.viewportBusy) return;
    if (!ensureConnected()) {
      renderViewport();
      return;
    }

    state.viewportBusy = true;
    dom.viewportControl.classList.add('is-busy');
    try {
      const response = await sendCommand(MESSAGE.SET_VIEWPORT, {
        preset,
        tabId: state.tab && state.tab.id
      }, { timeoutMs: 20000 });
      if (!isSuccess(response)) throw responseError(response, 'Não foi possível alterar a visualização.');
      state.viewport = response.preset || preset;
      state.viewportMode = response.mode || (state.viewport === 'full' ? 'full' : 'viewer');
      state.viewportActual = response.actualViewport || null;
      if (VIEWPORT_DEVICE[state.viewport]) {
        dom.device.value = VIEWPORT_DEVICE[state.viewport];
        fieldChanged();
      }
      showToast(state.viewport === 'full'
        ? 'Visualização em tela inteira restaurada.'
        : `Prévia ${viewportLabel(state.viewport)} aberta.`, 'success');
    } catch (error) {
      if (!handlePermissionError(error)) showToast(readableError(error), 'error');
    } finally {
      state.viewportBusy = false;
      dom.viewportControl.classList.remove('is-busy');
      renderViewport();
    }
  }

  function renderViewport() {
    // Tamanho aberto pelo Fiscal do Pixel: não corresponde a nenhuma opção fixa.
    if (state.viewport === 'design') {
      document.querySelectorAll('input[name="viewportPreset"]').forEach((radio) => { radio.checked = false; });
      const size = state.viewportActual;
      dom.viewportHint.textContent = size
        ? `Tamanho do design · ${size.width} × ${size.height}`
        : 'Tamanho do design';
      return;
    }
    const preset = VIEWPORT_HINTS[state.viewport] ? state.viewport : 'full';
    const radio = document.querySelector(`input[name="viewportPreset"][value="${preset}"]`);
    if (radio) radio.checked = true;
    if (state.viewportMode === 'viewer' && preset !== 'full') {
      dom.viewportHint.textContent = `${VIEWPORT_HINTS[preset].replace(' · touch', '')} · prévia interativa`;
    } else {
      dom.viewportHint.textContent = VIEWPORT_HINTS[preset];
    }
  }

  function viewportLabel(preset) {
    return { full: 'tela inteira', desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' }[preset] || preset;
  }

  function ensureConnected() {
    if (state.connected) return true;
    showSetup(false);
    showToast('Conecte um projeto para continuar.', 'error');
    return false;
  }

  function setConnectionState(mode, label) {
    dom.connectionBadge.classList.toggle('is-online', mode === 'online');
    dom.connectionBadge.classList.toggle('is-busy', mode === 'busy');
    dom.connectionBadge.classList.toggle('is-offline', mode === 'offline');
    dom.connectionLabel.textContent = label;
    dom.connectionBadge.title = label;
  }

  function setSetupBusy(busy) {
    state.setupBusy = busy;
    dom.btnConnect.disabled = busy;
    dom.connectSpinner.classList.toggle('hidden', !busy);
    if (busy) dom.connectButtonLabel.textContent = 'Validando…';
    else updateConnectButtonLabel();
  }

  function setSubmitBusy(busy) {
    dom.btnSubmit.disabled = busy;
    dom.submitSpinner.classList.toggle('hidden', !busy);
    dom.submitButtonLabel.textContent = busy ? 'Criando item…' : 'Criar item de QA';
  }

  function setCaptureButtonsDisabled(disabled) {
    [dom.btnSelectElement, dom.btnChangeElement, dom.btnScreenshot, dom.btnVideo]
      .forEach((button) => { button.disabled = Boolean(disabled); });
  }

  function hasReportEvidence() {
    const diagnostics = state.diagnostics || {};
    return Boolean(diagnostics.element);
  }

  function showSetupError(message) {
    dom.setupError.textContent = message;
    dom.setupError.classList.remove('hidden');
  }

  function clearSetupError() {
    dom.setupError.textContent = '';
    dom.setupError.classList.add('hidden');
  }

  function updateDescriptionCount() {
    dom.descriptionCount.textContent = `${dom.description.value.length} / 5000`;
  }

  // O mesmo erro costuma chegar pela resposta do comando e pelo broadcast
  // WI_QA_ERROR; mostra uma vez só.
  let lastToast = { message: '', at: 0 };
  function showToast(message, type = 'default') {
    if (message === lastToast.message && Date.now() - lastToast.at < 2000) return;
    lastToast = { message, at: Date.now() };
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
    toast.textContent = message;
    dom.toastRegion.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  async function copyText(value, successMessage) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage, 'success');
    } catch (error) {
      showToast('Não foi possível copiar.', 'error');
    }
  }

  async function sendCommand(type, payload = {}, options = {}) {
    const requestId = makeId('request');
    const envelope = {
      target: 'background',
      source: 'sidepanel',
      type,
      requestId,
      payload,
      ...payload
    };

    try {
      const response = await runtimeSend(envelope, options.timeoutMs || 20000);
      if (response && response.success === false && response.error && response.error.code === 'SESSION_EXPIRED') {
        handleSessionExpired(response.error.message);
      }
      if (response === undefined && options.legacyType) {
        return runtimeSend({ target: 'background', type: options.legacyType, ...payload }, options.timeoutMs || 20000);
      }
      return response;
    } catch (error) {
      if (!options.legacyType || !isUnsupportedMessageError(error)) throw error;
      return runtimeSend({ target: 'background', type: options.legacyType, ...payload }, options.timeoutMs || 20000);
    }
  }

  function runtimeSend(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('A operação demorou mais do que o esperado. Tente novamente.'));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) reject(new Error(runtimeError.message));
          else resolve(response);
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) resolve({});
        else resolve(result || {});
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });
  }

  function tabsQuery(query) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(query, (tabs) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tabs || []);
      });
    });
  }

  function readMediaRecord(recordingId) {
    return new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(MEDIA_DATABASE.NAME, MEDIA_DATABASE.VERSION);
      } catch (error) {
        resolve(null);
        return;
      }
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(MEDIA_DATABASE.STORE)) {
          database.createObjectStore(MEDIA_DATABASE.STORE, { keyPath: 'recordingId' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(MEDIA_DATABASE.STORE)) {
          database.close();
          resolve(null);
          return;
        }
        const transaction = database.transaction(MEDIA_DATABASE.STORE, 'readonly');
        const getRequest = transaction.objectStore(MEDIA_DATABASE.STORE).get(recordingId);
        getRequest.onsuccess = () => resolve(getRequest.result || null);
        getRequest.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => database.close();
      };
    });
  }

  function revokeUnusedObjectUrls() {
    const activeIds = new Set(state.media.map((media) => media.id));
    state.objectUrls.forEach((url, id) => {
      if (!activeIds.has(id)) {
        URL.revokeObjectURL(url);
        state.objectUrls.delete(id);
      }
    });
  }

  function revokeMediaObjectUrl(id) {
    const url = state.objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    state.objectUrls.delete(id);
  }

  function revokeAllObjectUrls() {
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
  }

  function stripUiMediaFields(media) {
    const clean = { ...media };
    delete clean.previewUrl;
    if (clean.dataUrl && clean.dataUrl.length > 500000) {
      // A chave legada continua sendo a dona do Data URL. Evita duplicar a
      // mesma captura no rascunho e consumir a cota do chrome.storage.
      delete clean.dataUrl;
    }
    return clean;
  }

  function normalizeMediaKind(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('image') || normalized.includes('screenshot')) return 'image';
    if (normalized.includes('video') || normalized.includes('tab_video')) return 'video';
    return '';
  }

  function modeToKind(mode) {
    if (mode === 'tab_video') return 'video';
    if (mode === 'screenshot') return 'image';
    return mode || '';
  }

  function normalizeMediaStatus(status) {
    const normalized = String(status || 'local').toLowerCase();
    const aliases = { complete: 'ready', completed: 'ready', failed: 'error', pending: 'uploading' };
    return aliases[normalized] || normalized;
  }

  function friendlyMediaKind(kind) {
    return kind === 'image' ? 'Imagem' : 'Vídeo';
  }

  function friendlyMediaStatus(media) {
    const status = media.status;
    if (status === 'uploading') return 'Enviando ao Supabase…';
    if (media.remoteMediaId && status !== 'error') {
      return media.mimeType === 'image/webp' ? 'Enviado · WebP' : 'Enviado';
    }
    if (status === 'local' && media.uploadError) return 'Envio pendente — tentará ao criar o item';
    const labels = {
      local: 'Pronto para enviar',
      uploading: 'Enviando…',
      uploaded: 'Enviado',
      processing: 'Processando…',
      ready: 'Pronto',
      error: 'Falha no arquivo'
    };
    return labels[status] || 'Pronto para enviar';
  }

  function defaultMediaName(kind) {
    const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return kind === 'image' ? `captura-${stamp}.webp` : `gravacao-${stamp}.webm`;
  }

  function normalizeTab(tab) {
    if (!tab || typeof tab !== 'object') return { id: null, url: '', title: '' };
    return {
      ...tab,
      id: tab.id ?? tab.tabId ?? tab.sourceTabId ?? null,
      url: tab.url || tab.pageUrl || tab.sourcePageUrl || '',
      title: tab.title || tab.pageTitle || ''
    };
  }

  function mergeConfig(base, update) {
    if (!base && !update) return null;
    const output = { ...(base || {}) };
    Object.entries(update || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') output[key] = value;
    });
    return output;
  }

  function isSuccess(response) {
    return Boolean(response && (response.success === true || response.ok === true));
  }

  async function ensureBackgroundProtocol(response) {
    const context = response?.context || response?.data || response?.payload || {};
    if (Number(context.protocolVersion || 0) >= REQUIRED_BACKGROUND_PROTOCOL) {
      await storageSet({ [STORAGE.PROTOCOL_RELOAD_AT]: 0 }).catch(() => undefined);
      return true;
    }
    await recoverOutdatedBackground();
    return false;
  }

  function isUnsupportedMessagePayload(payload) {
    const error = payload?.error || payload || {};
    return error.code === 'UNKNOWN_MESSAGE' || /opera(?:ç|c)ão desconhecida/i.test(String(error.message || error));
  }

  function isUnsupportedMessageResponse(response) {
    return Boolean(response && response.success === false && isUnsupportedMessagePayload(response.error || response));
  }

  async function recoverOutdatedBackground() {
    if (state.reloadingExtension) return;
    state.reloadingExtension = true;
    const stored = await storageGet(STORAGE.PROTOCOL_RELOAD_AT);
    const lastReload = Number(stored[STORAGE.PROTOCOL_RELOAD_AT] || 0);
    if (Date.now() - lastReload < 30_000) {
      state.reloadingExtension = false;
      showToast('O serviço da extensão está desatualizado. Recarregue o WiControl QA em chrome://extensions.', 'error');
      return;
    }
    await storageSet({ [STORAGE.PROTOCOL_RELOAD_AT]: Date.now() }).catch(() => undefined);
    showToast('Atualizando a extensão… reabra o painel em instantes.', 'success');
    window.setTimeout(() => chrome.runtime.reload(), 700);
  }

  function responseError(response, fallback) {
    const raw = response && (response.error || response.message || response.data?.error);
    if (raw instanceof Error) return raw;
    if (raw && typeof raw === 'object') {
      const error = new Error(raw.message || raw.code || fallback);
      error.code = raw.code || '';
      return error;
    }
    return new Error(raw || fallback);
  }

  function readableError(error) {
    const message = String(error?.message || error?.error?.message || error || 'Ocorreu um erro inesperado.');
    if (/receiving end does not exist|could not establish connection/i.test(message)) {
      return 'O serviço da extensão não respondeu. Recarregue a extensão e tente novamente.';
    }
    if (/401|unauthorized|sess[aã]o.*inv[aá]lida/i.test(message)) return 'Credenciais inválidas ou sessão expirada.';
    if (/404|project.*not found|projeto.*n[aã]o encontrado/i.test(message)) return 'Projeto não encontrado para o token informado.';
    if (/429|rate limit/i.test(message)) return 'Muitas tentativas. Aguarde um momento e tente novamente.';
    if (/network|failed to fetch|internet/i.test(message)) return 'Sem conexão com o Supabase. Verifique a internet e a URL configurada.';
    return message;
  }

  function isUnsupportedMessageError(error) {
    return /receiving end does not exist|could not establish connection|message port closed/i.test(String(error?.message || error));
  }

  function makeId(prefix) {
    const value = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
  }

  function isMasked(value) {
    return /[•*]{3,}|^masked$/i.test(String(value || ''));
  }

  function unmaskedValue(value) {
    return value && !isMasked(value) ? String(value) : '';
  }

  function displayableValue(value) {
    return value && !isMasked(value) ? String(value) : '';
  }

  function setValueIfPresent(element, value) {
    if (value !== undefined && value !== null) element.value = String(value);
  }

  function setSelectValue(element, value, allowed) {
    if (allowed.includes(value)) element.value = value;
  }

  function normalizeTimestamp(value) {
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeSearchText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function formatDuration(durationMs) {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value <= 0) return '';
    return formatClock(value);
  }

  function formatClock(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function toDurationString(durationMs) {
    return `PT${Math.max(0, Math.floor(Number(durationMs || 0) / 1000))}S`;
  }

  function isHttpUrl(value) {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch (error) {
      return false;
    }
  }

  function safePreviewUrl(value) {
    if (!value) return '';
    const raw = String(value);
    return /^(blob:|data:image\/|data:video\/|https?:)/i.test(raw) ? raw : '';
  }

  function escapeAttribute(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }
})();
