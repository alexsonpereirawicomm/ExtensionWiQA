(() => {
  'use strict';

  if (window.__wiqaContentV2Loaded) return;
  window.__wiqaContentV2Loaded = true;

  const HOST_ID = 'wiqa-extension-root';
  const VIEWPORT_HOST_ID = 'wiqa-responsive-viewer';
  const MAX_Z = 2147483647;
  const PIXEL_OVERLAY_HOST_ID = 'wiqa-pixel-overlay';
  const PIXEL_REFERENCE_TYPES = /^image\/(png|jpe?g|webp|gif|avif)$/i;
  const PIXEL_REFERENCE_MAX_BYTES = 40 * 1024 * 1024;
  const FONT_WEIGHT_NAMES = Object.freeze({
    100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
    600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
  });
  const PIXEL_SHORTCUTS = Object.freeze([
    ['Clique', 'fixar ou soltar o elemento'],
    ['Setas', 'mover o design 1px (Shift: 10px)'],
    ['1–9 · 0', 'opacidade 10–90% · 100%'],
    ['− / +', 'opacidade −10% / +10%'],
    ['H', 'mostrar ou ocultar o design'],
    ['D', 'modo diferença'],
    ['C · R', 'centralizar · zerar a posição'],
    ['I', 'ligar ou desligar a inspeção'],
    ['P', 'capturar evidência'],
    ['Ctrl+V', 'colar o design (ou arrastar o arquivo)'],
    ['Esc', 'soltar o elemento · sair'],
  ]);
  // Ícones do Fiscal do Pixel (traço 24×24). Montados com createElementNS em
  // vez de innerHTML para não esbarrar em CSP/Trusted Types da página.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PIXEL_ICONS = Object.freeze({
    inspect: ['M12 3v4M12 17v4M3 12h4M17 12h4', 'M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0'],
    image: ['M4 5h16v14H4z', 'm4 16 5-5 4 4 2-2 5 5', 'M14 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0'],
    camera: ['M4 7.5h3l1.4-2h7.2l1.4 2h3v11H4z', 'M8.6 13a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0 -6.8 0'],
    help: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4', 'M12 17h.01'],
    swap: ['M8 20V4m0 0L4.5 7.5M8 4l3.5 3.5', 'M16 4v16m0 0-3.5-3.5M16 20l3.5-3.5'],
    close: ['m6 6 12 12M18 6 6 18'],
    eye: ['M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z', 'M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0'],
    eyeOff: ['M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z', 'M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0', 'M4 4l16 16'],
    more: ['M5.5 12h.01M12 12h.01M18.5 12h.01'],
  });
  // Último elemento clicado com o botão direito, para o menu "Reportar este
  // elemento" selecionar direto (o Chrome não informa o elemento no clique).
  const CONTEXT_TARGET_MAX_AGE_MS = 60_000;
  let lastContextTarget = null;
  document.addEventListener('contextmenu', (event) => {
    const target = event.composedPath()[0];
    lastContextTarget = target instanceof Element ? { element: target, at: Date.now() } : null;
  }, true);
  let recordingTimer = null;
  let activeCleanup = null;
  let diagnosticDraftId = '';
  let responsiveViewer = null;
  let pixelInspector = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'wiqa-page-observer') return;
    const diagnosticEvent = sanitizeObserverEvent(event.data.event);
    if (!diagnosticEvent) return;
    void chrome.runtime.sendMessage({
      target: 'background',
      source: 'content',
      type: 'WI_QA_DIAGNOSTIC_EVENT',
      payload: { event: diagnosticEvent, draftId: diagnosticDraftId },
    }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'content') return false;

    switch (message.type) {
      case 'WI_QA_PING':
        sendResponse({ success: true, version: 2 });
        return false;
      case 'WI_QA_SET_DIAGNOSTIC_SESSION':
        diagnosticDraftId = String(message.draftId || '');
        sendResponse({ success: true });
        return false;
      case 'initCrop':
        openCrop(message.image)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'showCountdown':
        showCountdown().then(() => sendResponse({ success: true }));
        return true;
      case 'showRecordingBar':
        showRecordingBar(message);
        sendResponse({ success: true });
        return false;
      case 'hideRecordingBar':
        hideRecordingBar();
        sendResponse({ success: true });
        return false;
      case 'WI_QA_SELECT_ELEMENT':
        selectElement({ preferContextTarget: Boolean(message.preferContextTarget) })
          .then((element) => sendResponse({ success: true, element }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'WI_QA_VIEWPORT_SHOW':
        showResponsiveViewport(message.payload || message)
          .then((viewport) => sendResponse({ success: true, viewport }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'WI_QA_VIEWPORT_HIDE':
        hideResponsiveViewport();
        sendResponse({ success: true });
        return false;
      case 'WI_QA_PIXEL_INSPECTOR_SHOW':
        try {
          openPixelInspector();
          sendResponse({ success: true, active: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return false;
      case 'WI_QA_PIXEL_INSPECTOR_HIDE':
        pixelInspector?.exit();
        sendResponse({ success: true, active: false });
        return false;
      default:
        return false;
    }
  });

  function createSurface(name) {
    removeSurface();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.surface = name;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = String(MAX_Z);
    host.style.pointerEvents = 'none';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.append(style);
    document.documentElement.append(host);
    return { host, shadow };
  }

  function removeSurface() {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    document.getElementById(HOST_ID)?.remove();
  }

  async function showResponsiveViewport(payload) {
    // Limites mínimos baixos para caber o tamanho exato de designs do Fiscal do Pixel.
    const width = Math.max(240, Math.min(2560, Number(payload.width) || 390));
    const height = Math.max(200, Math.min(2560, Number(payload.height) || 844));
    const preset = String(payload.preset || 'mobile');
    const label = String(payload.label || preset);
    hideResponsiveViewport();

    const host = document.createElement('div');
    host.id = VIEWPORT_HOST_ID;
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: String(MAX_Z - 10), pointerEvents: 'auto' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host,*{box-sizing:border-box}
      .viewer{position:fixed;inset:0;background:#151519;color:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      .bar{height:52px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.12);background:#202026;box-shadow:0 4px 18px rgba(0,0,0,.28)}
      .identity{display:flex;align-items:baseline;gap:10px;min-width:0}.identity strong{font-size:14px}.identity span{color:#b7b7c2;font:12px/1 ui-monospace,SFMono-Regular,monospace}
      button{height:34px;padding:0 13px;border:1px solid rgba(255,255,255,.18);border-radius:8px;color:#fff;background:#303039;font:600 12px/1 inherit;cursor:pointer}button:hover{background:#3b3b46}button:focus-visible{outline:3px solid rgba(61,148,255,.55);outline-offset:2px}
      .stage{position:absolute;inset:52px 0 0;display:grid;place-items:center;overflow:hidden;padding:16px;background:radial-gradient(circle at 50% 25%,#303039 0,#17171b 62%)}
      .holder{position:relative;flex:none}.device{position:absolute;left:0;top:0;overflow:hidden;border:1px solid rgba(255,255,255,.25);border-radius:10px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.48);transform-origin:top left}
      iframe{display:block;border:0;background:#fff}.loading{position:absolute;inset:0;display:grid;place-items:center;color:#555;background:#fff;font-size:13px}.loading.hidden{display:none}
    `;
    const viewer = document.createElement('div');
    viewer.className = 'viewer';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const identity = document.createElement('div');
    identity.className = 'identity';
    const title = document.createElement('strong');
    title.textContent = label;
    const dimensions = document.createElement('span');
    dimensions.textContent = `${width} × ${height}`;
    identity.append(title, dimensions);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Sair da visualização';
    close.setAttribute('aria-label', 'Voltar para tela inteira');
    bar.append(identity, close);
    const stage = document.createElement('div');
    stage.className = 'stage';
    const holder = document.createElement('div');
    holder.className = 'holder';
    const device = document.createElement('div');
    device.className = 'device';
    const frame = document.createElement('iframe');
    frame.title = `Prévia ${label}`;
    frame.width = String(width);
    frame.height = String(height);
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.textContent = 'Carregando visualização…';
    device.append(frame, loading);
    holder.append(device);
    stage.append(holder);
    viewer.append(bar, stage);
    shadow.append(style, viewer);
    document.documentElement.append(host);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const fit = () => {
      const availableWidth = Math.max(1, stage.clientWidth - 32);
      const availableHeight = Math.max(1, stage.clientHeight - 32);
      const scale = Math.min(1, availableWidth / width, availableHeight / height);
      holder.style.width = `${Math.round(width * scale)}px`;
      holder.style.height = `${Math.round(height * scale)}px`;
      device.style.width = `${width}px`;
      device.style.height = `${height}px`;
      device.style.transform = `scale(${scale})`;
      if (responsiveViewer) responsiveViewer.scale = scale;
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || activeCleanup) return;
      event.preventDefault();
      closeViewportFromPage();
    };
    const onClose = () => closeViewportFromPage();
    close.addEventListener('click', onClose);
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', onKeyDown, true);
    responsiveViewer = { host, frame, width, height, preset, scale: 1, previousOverflow, fit, onKeyDown };
    fit();
    const loaded = new Promise((resolve) => {
      const timeoutId = window.setTimeout(resolve, 12000);
      frame.addEventListener('load', () => {
        window.clearTimeout(timeoutId);
        loading.classList.add('hidden');
        resolve();
      }, { once: true });
    });
    frame.addEventListener('load', () => {
      void chrome.runtime.sendMessage({
        target: 'background', source: 'content', type: 'WI_QA_VIEWPORT_FRAME_READY'
      }).catch(() => undefined);
    });
    frame.src = location.href;
    await loaded;
    pixelInspector?.rebind();
    return { preset, width, height };
  }

  function closeViewportFromPage() {
    hideResponsiveViewport();
    void chrome.runtime.sendMessage({ target: 'background', source: 'content', type: 'WI_QA_VIEWPORT_CLOSED' }).catch(() => undefined);
  }

  function hideResponsiveViewport() {
    const viewer = responsiveViewer;
    if (!viewer) {
      document.getElementById(VIEWPORT_HOST_ID)?.remove();
      return;
    }
    window.removeEventListener('resize', viewer.fit);
    document.removeEventListener('keydown', viewer.onKeyDown, true);
    viewer.host.remove();
    document.documentElement.style.overflow = viewer.previousOverflow;
    responsiveViewer = null;
    pixelInspector?.rebind();
  }

  async function openCrop(dataUrl) {
    if (!String(dataUrl || '').startsWith('data:image/')) throw new Error('Captura inválida.');
    const previousFocus = document.activeElement;
    const { shadow } = createSurface('crop');
    const overlay = element('div', 'overlay crop-overlay');
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Selecionar área da captura');

    const imageLayer = element('div', 'capture-image');
    imageLayer.style.backgroundImage = `url("${dataUrl}")`;
    const shade = element('div', 'shade');
    const selection = element('div', 'selection hidden');
    selection.style.backgroundImage = `url("${dataUrl}")`;
    const size = element('span', 'selection-size');
    selection.append(size);
    const hint = element('div', 'hint');
    hint.textContent = 'Arraste para selecionar · Esc para cancelar';
    overlay.append(imageLayer, shade, selection, hint);
    shadow.append(overlay);

    let drawing = false;
    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;

    const updateSelection = () => {
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      selection.classList.remove('hidden');
      Object.assign(selection.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        backgroundPosition: `-${x}px -${y}px`,
      });
      size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      drawing = true;
      startX = endX = event.clientX;
      startY = endY = event.clientY;
      hint.hidden = true;
      overlay.setPointerCapture(event.pointerId);
      updateSelection();
    };

    const onPointerMove = (event) => {
      if (!drawing) return;
      endX = event.clientX;
      endY = event.clientY;
      updateSelection();
    };

    const onPointerUp = async (event) => {
      if (!drawing) return;
      drawing = false;
      overlay.releasePointerCapture(event.pointerId);
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      if (width < 12 || height < 12) {
        selection.classList.add('hidden');
        hint.hidden = false;
        return;
      }
      const cropped = await cropImage(dataUrl, x, y, width, height);
      openAnnotation(cropped, previousFocus);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        removeSurface();
        previousFocus?.focus?.();
      }
    };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeyDown, true);
    activeCleanup = () => document.removeEventListener('keydown', onKeyDown, true);
    overlay.focus();
  }

  function cropImage(dataUrl, x, y, width, height) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const scaleX = image.naturalWidth / window.innerWidth;
        const scaleY = image.naturalHeight / window.innerHeight;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scaleX));
        canvas.height = Math.max(1, Math.round(height * scaleY));
        const context = canvas.getContext('2d');
        context.drawImage(
          image,
          x * scaleX,
          y * scaleY,
          width * scaleX,
          height * scaleY,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('Não foi possível processar a captura.'));
      image.src = dataUrl;
    });
  }

  function openAnnotation(dataUrl, previousFocus) {
    const { shadow } = createSurface('annotation');
    const overlay = element('div', 'overlay annotation-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Anotar captura');
    const stage = element('div', 'annotation-stage');
    const canvas = document.createElement('canvas');
    canvas.className = 'annotation-canvas';
    const toolbar = element('div', 'toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Ferramentas de anotação');

    const tools = [
      ['pen', 'Livre'],
      ['rect', 'Retângulo'],
      ['arrow', 'Seta'],
    ];
    const toolGroup = element('div', 'tool-group');
    const toolButtons = tools.map(([value, label], index) => {
      const button = makeButton(label, `tool-button${index === 0 ? ' active' : ''}`);
      button.dataset.tool = value;
      button.setAttribute('aria-pressed', String(index === 0));
      toolGroup.append(button);
      return button;
    });

    const colors = [
      ['#ff004b', 'Rosa Wicomm'],
      ['#0074ff', 'Azul'],
      ['#16a062', 'Verde'],
      ['#ffbf00', 'Amarelo'],
    ];
    const colorGroup = element('div', 'color-group');
    const colorButtons = colors.map(([value, label], index) => {
      const button = makeButton('', `color-button${index === 0 ? ' active' : ''}`);
      button.dataset.color = value;
      button.style.background = value;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(index === 0));
      colorGroup.append(button);
      return button;
    });

    const cancel = makeButton('Cancelar', 'plain-button');
    const save = makeButton('Concluir', 'primary-button');
    toolbar.append(toolGroup, colorGroup, cancel, save);
    stage.append(canvas);
    overlay.append(stage, toolbar);
    shadow.append(overlay);

    let context;
    let currentTool = 'pen';
    let currentColor = '#ff004b';
    let drawing = false;
    let start = null;
    let committed;
    const image = new Image();

    image.onload = () => {
      const maxWidth = window.innerWidth * 0.92;
      const maxHeight = window.innerHeight * 0.72;
      const ratio = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
      canvas.width = Math.round(image.naturalWidth * ratio);
      canvas.height = Math.round(image.naturalHeight * ratio);
      context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      committed = context.getImageData(0, 0, canvas.width, canvas.height);
      toolButtons[0].focus();
    };
    image.src = dataUrl;

    toolButtons.forEach((button) => {
      button.addEventListener('click', () => {
        toolButtons.forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        currentTool = button.dataset.tool;
      });
    });

    colorButtons.forEach((button) => {
      button.addEventListener('click', () => {
        colorButtons.forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        currentColor = button.dataset.color;
      });
    });

    const pointerPosition = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!context || event.button !== 0) return;
      drawing = true;
      start = pointerPosition(event);
      canvas.setPointerCapture(event.pointerId);
      setupStroke(context, currentColor);
      if (currentTool === 'pen') {
        context.beginPath();
        context.moveTo(start.x, start.y);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!drawing || !context) return;
      const position = pointerPosition(event);
      if (currentTool === 'pen') {
        context.lineTo(position.x, position.y);
        context.stroke();
        return;
      }
      context.putImageData(committed, 0, 0);
      setupStroke(context, currentColor);
      if (currentTool === 'rect') {
        context.strokeRect(start.x, start.y, position.x - start.x, position.y - start.y);
      } else {
        drawArrow(context, start, position);
      }
    });

    const finishStroke = (event) => {
      if (!drawing || !context) return;
      drawing = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      committed = context.getImageData(0, 0, canvas.width, canvas.height);
    };
    canvas.addEventListener('pointerup', finishStroke);
    canvas.addEventListener('pointercancel', finishStroke);

    const close = () => {
      removeSurface();
      previousFocus?.focus?.();
    };
    cancel.addEventListener('click', close);
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Salvando…';
      const response = await chrome.runtime.sendMessage({
        target: 'background',
        source: 'content',
        type: 'WI_QA_SAVE_SCREENSHOT',
        dataUrl: canvas.toDataURL('image/png'),
      });
      if (!response?.success) {
        save.disabled = false;
        save.textContent = 'Tentar novamente';
        return;
      }
      close();
    });

    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    activeCleanup = () => document.removeEventListener('keydown', onKeyDown, true);
  }

  function setupStroke(context, color) {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
  }

  function drawArrow(context, from, to) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = 14;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }

  async function showCountdown() {
    const { shadow } = createSurface('countdown');
    const overlay = element('div', 'overlay countdown-overlay');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'assertive');
    const number = element('strong', 'countdown-number');
    const label = element('span', 'countdown-label');
    label.textContent = 'Preparando gravação';
    overlay.append(number, label);
    shadow.append(overlay);

    for (const value of [3, 2, 1]) {
      number.textContent = String(value);
      number.animate(
        [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
      await delay(850);
    }
    removeSurface();
  }

  function showRecordingBar(message) {
    hideRecordingBar();
    removeSurface();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.surface = 'recording';
    host.style.position = 'fixed';
    host.style.inset = 'auto 0 20px 0';
    host.style.zIndex = String(MAX_Z);
    host.style.pointerEvents = 'none';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const bar = element('div', 'recording-bar');
    const dot = element('span', 'recording-dot');
    const timer = element('span', 'recording-time');
    const label = element('span', 'recording-label');
    label.textContent = 'Gravando aba';
    const stop = makeButton('Parar', 'stop-button');
    bar.append(dot, label, timer, stop);
    shadow.append(style, bar);
    document.documentElement.append(host);

    const startedAt = Number(message.startedAt || Date.now());
    const renderTimer = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      const seconds = Math.floor(elapsed / 1000);
      timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    renderTimer();
    recordingTimer = window.setInterval(renderTimer, 250);
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      stop.textContent = 'Processando…';
      await chrome.runtime.sendMessage({
        target: 'background',
        source: 'content',
        type: 'WI_QA_VIDEO_STOP',
        sessionId: message.sessionId,
      });
    });
  }

  function hideRecordingBar() {
    if (recordingTimer) window.clearInterval(recordingTimer);
    recordingTimer = null;
    // Só remove a barra: outra superfície (ex.: Fiscal do Pixel) pode estar aberta.
    const host = document.getElementById(HOST_ID);
    if (host?.dataset.surface === 'recording') host.remove();
  }

  // ---------------------------------------------------------------------------
  // Fiscal do Pixel: box model e tipografia no hover, sobreposição do design
  // (export do Figma ou imagem local) em escala 1:1 e captura da divergência.

  function openPixelInspector() {
    if (pixelInspector) return;
    const previousFocus = document.activeElement;
    const { host, shadow } = createSurface('pixel-inspector');
    const extraStyle = document.createElement('style');
    extraStyle.textContent = PIXEL_STYLES;

    // O design fica num host próprio: mix-blend-mode só mistura com a página
    // quando aplicado a um elemento do contexto de empilhamento raiz, e a barra
    // de ferramentas não pode entrar na mistura.
    const overlayHost = document.createElement('div');
    overlayHost.id = PIXEL_OVERLAY_HOST_ID;
    Object.assign(overlayHost.style, {
      position: 'fixed', left: '0', top: '0', width: '0', height: '0', display: 'none',
      overflow: 'hidden', zIndex: String(MAX_Z - 1), pointerEvents: 'none',
    });
    // Canvas em vez de <img>: não depende da CSP da página (img-src) e só pinta
    // a parte visível, mesmo com designs de página inteira.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    overlayHost.attachShadow({ mode: 'closed' }).append(canvas);
    document.documentElement.append(overlayHost);
    const canvasContext = canvas.getContext('2d');

    const boxes = element('div', 'pi-boxes');
    const marginBox = element('div', 'pi-box pi-margin');
    const borderBox = element('div', 'pi-box pi-border');
    const paddingBox = element('div', 'pi-box pi-padding');
    boxes.append(marginBox, borderBox, paddingBox);
    boxes.hidden = true;
    const tip = element('div', 'pi-tip');
    tip.hidden = true;

    // Barra principal enxuta (inspecionar, design, capturar, sair). Os controles
    // do design só aparecem com um design carregado, e as ações raras ficam no
    // menu "Mais". O status é um aviso que some sozinho.
    const dock = element('div', 'pi-dock');
    const status = element('div', 'pi-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    const toolbar = element('div', 'pi-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Fiscal do Pixel');
    const title = element('span', 'pi-title');
    title.textContent = 'Fiscal do Pixel';
    title.title = 'Só visualização: nada aqui altera a página ou o item de QA. Só a captura anexa uma imagem ao rascunho.';

    const inspectButton = iconButton(PIXEL_ICONS.inspect, 'Inspecionar', 'pi-button pi-toggle', true);
    inspectButton.title = 'Medidas e tipografia no hover; clique fixa o elemento (I)';
    const loadButton = iconButton(PIXEL_ICONS.image, 'Comparar com design', 'pi-button', true);
    loadButton.title = 'PNG, JPG ou WebP exportado do Figma. Também dá para colar (Ctrl+V) ou arrastar o arquivo.';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
    fileInput.hidden = true;
    const captureButton = iconButton(PIXEL_ICONS.camera, 'Capturar', 'pi-button pi-primary', true);
    captureButton.title = 'Captura a tela como está e anexa ao rascunho do QA (P)';
    const helpButton = iconButton(PIXEL_ICONS.help, 'Atalhos de teclado (?)', 'pi-button pi-icon');
    helpButton.setAttribute('aria-expanded', 'false');
    const dockButton = iconButton(PIXEL_ICONS.swap, 'Mover a barra para cima ou para baixo', 'pi-button pi-icon');
    const closeButton = iconButton(PIXEL_ICONS.close, 'Sair do Fiscal do Pixel (Esc)', 'pi-button pi-icon');
    toolbar.append(
      title, element('span', 'pi-divider'),
      inspectButton, loadButton, fileInput, captureButton,
      element('span', 'pi-divider'), helpButton, dockButton, closeButton,
    );

    const referenceGroup = element('div', 'pi-toolbar pi-reference');
    referenceGroup.setAttribute('role', 'toolbar');
    referenceGroup.setAttribute('aria-label', 'Controles do design');
    const visibleButton = iconButton(PIXEL_ICONS.eye, 'Mostrar ou ocultar o design (H)', 'pi-button pi-icon');
    const opacityLabel = element('label', 'pi-range');
    opacityLabel.title = 'Opacidade do design (teclas 1–9 e 0)';
    const opacityInput = document.createElement('input');
    Object.assign(opacityInput, { type: 'range', min: '0', max: '100', step: '5' });
    opacityInput.setAttribute('aria-label', 'Opacidade do design');
    const opacityValue = element('output', 'pi-mono');
    opacityLabel.append(opacityInput, opacityValue);
    const differenceButton = makeButton('Diferença', 'pi-button pi-toggle');
    differenceButton.title = 'Onde página e design coincidem fica preto; o que aparece é divergência (D)';
    const scaleSelect = document.createElement('select');
    scaleSelect.className = 'pi-select';
    scaleSelect.setAttribute('aria-label', 'Escala do export do design');
    [1, 2, 3, 4].forEach((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value}x`;
      scaleSelect.append(option);
    });
    const offsetLabel = element('span', 'pi-offset pi-mono');
    offsetLabel.title = 'Deslocamento do design · setas movem 1px, Shift+setas 10px';
    const moreWrap = element('div', 'pi-more');
    const moreButton = iconButton(PIXEL_ICONS.more, 'Mais opções do design', 'pi-button pi-icon');
    moreButton.setAttribute('aria-haspopup', 'menu');
    moreButton.setAttribute('aria-expanded', 'false');
    const moreMenu = element('div', 'pi-menu');
    moreMenu.setAttribute('role', 'menu');
    moreMenu.hidden = true;
    const menuItem = (label, shortcut = '', extraClass = '') => {
      const item = makeButton(label, `pi-menu-item ${extraClass}`.trim());
      item.setAttribute('role', 'menuitem');
      if (shortcut) {
        const key = element('kbd', '');
        key.textContent = shortcut;
        item.append(key);
      }
      return item;
    };
    const centerButton = menuItem('Centralizar na horizontal', 'C');
    const resetButton = menuItem('Zerar posição', 'R');
    const swapButton = menuItem('Trocar design');
    const removeButton = menuItem('Remover design', '', 'pi-danger');
    moreMenu.append(centerButton, resetButton, swapButton, removeButton);
    moreWrap.append(moreButton, moreMenu);
    referenceGroup.append(visibleButton, opacityLabel, differenceButton, scaleSelect, offsetLabel, moreWrap);

    const help = element('div', 'pi-help');
    help.hidden = true;
    const helpNote = element('p', 'pi-help-note');
    helpNote.textContent = 'Só visualização: nada aqui altera a página ou o item de QA. Só “Capturar” anexa uma imagem ao rascunho.';
    help.append(helpNote);
    const helpList = document.createElement('dl');
    PIXEL_SHORTCUTS.forEach(([keys, text]) => {
      const term = document.createElement('dt');
      term.textContent = keys;
      const description = document.createElement('dd');
      description.textContent = text;
      helpList.append(term, description);
    });
    help.append(helpList);
    dock.append(status, help, referenceGroup, toolbar);
    shadow.append(extraStyle, boxes, tip, dock);

    const s = {
      context: null,
      unbindContext: null,
      inspecting: true,
      hovered: null,
      pinned: null,
      image: null,
      imageName: '',
      exportScale: 1,
      opacity: 0.5,
      opacityBeforeDifference: null,
      visible: true,
      difference: false,
      offsetX: 0,
      offsetY: 0,
      dockTop: false,
      capturing: false,
      renderQueued: false,
      statusTimer: 0,
    };

    const area = () => {
      const frame = s.context?.frame;
      if (!frame) {
        return {
          left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, scale: 1,
          contentWidth: document.documentElement.clientWidth || window.innerWidth,
        };
      }
      const rect = frame.getBoundingClientRect();
      const viewWidth = Number(frame.width) || rect.width;
      let contentWidth = viewWidth;
      try { contentWidth = s.context.document.documentElement.clientWidth || viewWidth; } catch { /* moldura trocou de origem */ }
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, scale: rect.width / Math.max(1, viewWidth), contentWidth };
    };

    const scrollPosition = () => {
      try { return { x: s.context.window.scrollX, y: s.context.window.scrollY }; } catch { return { x: 0, y: 0 }; }
    };

    const requestRender = () => {
      if (s.renderQueued) return;
      s.renderQueued = true;
      window.requestAnimationFrame(() => {
        s.renderQueued = false;
        if (pixelInspector !== api) return;
        renderOverlay();
        renderHighlight();
      });
    };

    const renderOverlay = () => {
      const show = Boolean(s.image && s.visible);
      overlayHost.style.display = show ? 'block' : 'none';
      if (!show) return;
      const box = area();
      Object.assign(overlayHost.style, {
        left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
        opacity: String(s.opacity), mixBlendMode: s.difference ? 'difference' : 'normal',
      });
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(box.width * ratio));
      const height = Math.max(1, Math.round(box.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      canvasContext.clearRect(0, 0, width, height);
      // Coordenadas em px CSS da página inspecionada; o design acompanha a rolagem.
      const zoom = box.scale * ratio;
      canvasContext.setTransform(zoom, 0, 0, zoom, 0, 0);
      canvasContext.imageSmoothingQuality = 'high';
      const scroll = scrollPosition();
      canvasContext.drawImage(
        s.image,
        s.offsetX - scroll.x,
        s.offsetY - scroll.y,
        s.image.width / s.exportScale,
        s.image.height / s.exportScale,
      );
    };

    const placeBox = (node, x, y, width, height, sides) => {
      Object.assign(node.style, {
        left: `${x}px`, top: `${y}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px`,
        borderWidth: sides.map((value) => `${Math.max(0, value)}px`).join(' '),
      });
    };

    const renderHighlight = () => {
      const target = s.pinned || (s.inspecting ? s.hovered : null);
      const show = Boolean(target?.isConnected && (!s.capturing || s.pinned));
      boxes.hidden = !show;
      tip.hidden = !show;
      if (!show) return;
      const metrics = measurePixelElement(target);
      const box = area();
      const k = box.scale;
      const x = box.left + metrics.rect.x * k;
      const y = box.top + metrics.rect.y * k;
      const width = metrics.rect.width * k;
      const height = metrics.rect.height * k;
      // Margens negativas não têm área para pintar; os valores reais vão na ficha.
      const margin = metrics.margin.map((value) => Math.max(0, value) * k);
      const border = metrics.border.map((value) => value * k);
      placeBox(marginBox, x - margin[3], y - margin[0], width + margin[1] + margin[3], height + margin[0] + margin[2], margin);
      placeBox(borderBox, x, y, width, height, border);
      placeBox(paddingBox, x + border[3], y + border[0], width - border[1] - border[3], height - border[0] - border[2], metrics.padding.map((value) => value * k));
      borderBox.classList.toggle('is-pinned', Boolean(s.pinned));
      renderTip(metrics, { x, y, width, height });
    };

    const renderTip = (metrics, anchor) => {
      const header = element('div', 'pi-tip-header');
      const name = element('strong', 'pi-mono');
      name.textContent = metrics.label;
      const size = element('span', 'pi-size pi-mono');
      size.textContent = `${formatPx(metrics.rect.width)} × ${formatPx(metrics.rect.height)}`;
      header.append(name, size);

      // No hover só o essencial; a ficha completa aparece ao fixar o elemento.
      const specs = element('div', 'pi-specs');
      (s.pinned ? pixelSpecRows(metrics) : pixelSummaryRows(metrics)).forEach((row) => {
        if (row.section) {
          const section = element('div', 'pi-section');
          section.textContent = row.section;
          specs.append(section);
          return;
        }
        const key = element('span', 'pi-key');
        key.textContent = row.label;
        const value = element('span', 'pi-value pi-mono');
        if (row.swatch) {
          const swatch = element('i', 'pi-swatch');
          swatch.style.background = row.swatch;
          value.append(swatch);
        }
        value.append(row.value);
        if (row.copy && row.copy !== row.value) value.title = row.copy;
        specs.append(key, value);
      });

      const parts = [header, specs];
      if (!s.capturing) {
        const footer = element('div', 'pi-tip-footer');
        const note = element('span', '');
        note.textContent = s.pinned ? 'Fixado · Esc solta' : 'Clique para ver todas as medidas';
        footer.append(note);
        if (s.pinned) {
          const copy = makeButton('Copiar specs', 'pi-button');
          copy.addEventListener('click', async () => {
            const copied = await copyToClipboard(pixelSpecsText(metrics), shadow);
            flash(copied ? 'Especificações copiadas.' : 'Não foi possível copiar.', copied ? 'success' : 'error');
          });
          footer.append(copy);
        }
        parts.push(footer);
      }
      tip.classList.toggle('is-pinned', Boolean(s.pinned));
      tip.replaceChildren(...parts);

      const gap = 8;
      const tipWidth = tip.offsetWidth;
      const tipHeight = tip.offsetHeight;
      const left = Math.max(gap, Math.min(anchor.x, window.innerWidth - tipWidth - gap));
      let top = anchor.y + anchor.height + gap;
      if (top + tipHeight > window.innerHeight - gap) top = anchor.y - tipHeight - gap;
      if (top < gap) top = Math.max(gap, Math.min(window.innerHeight - tipHeight - gap, anchor.y + gap));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    };

    const flash = (message, tone = '', durationMs = 3500) => {
      status.textContent = message;
      status.dataset.tone = tone;
      status.hidden = false;
      window.clearTimeout(s.statusTimer);
      s.statusTimer = window.setTimeout(() => {
        status.hidden = true;
        status.dataset.tone = '';
      }, durationMs);
    };

    const setMenu = (open) => {
      moreMenu.hidden = !open;
      moreButton.setAttribute('aria-expanded', String(open));
    };

    const syncToolbar = () => {
      inspectButton.classList.toggle('active', s.inspecting);
      inspectButton.setAttribute('aria-pressed', String(s.inspecting));
      loadButton.hidden = Boolean(s.image);
      referenceGroup.hidden = !s.image;
      if (!s.image) setMenu(false);
      visibleButton.replaceChildren(svgIcon(s.visible ? PIXEL_ICONS.eye : PIXEL_ICONS.eyeOff));
      visibleButton.classList.toggle('active', !s.visible);
      visibleButton.setAttribute('aria-pressed', String(!s.visible));
      const percent = Math.round(s.opacity * 100);
      opacityInput.value = String(percent);
      opacityInput.setAttribute('aria-valuetext', `${percent}%`);
      opacityValue.textContent = `${percent}%`;
      scaleSelect.value = String(s.exportScale);
      scaleSelect.title = s.image
        ? `Escala do export (2x = retina) · ${s.imageName} · ${s.image.width}×${s.image.height}px`
        : '';
      differenceButton.classList.toggle('active', s.difference);
      differenceButton.setAttribute('aria-pressed', String(s.difference));
      // Posição só aparece quando o design foi deslocado.
      offsetLabel.hidden = !s.offsetX && !s.offsetY;
      offsetLabel.textContent = `X ${s.offsetX} · Y ${s.offsetY}`;
      dock.classList.toggle('at-top', s.dockTop);
    };

    const update = () => {
      syncToolbar();
      requestRender();
    };

    const loadReference = async (file) => {
      if (!file || !PIXEL_REFERENCE_TYPES.test(file.type)) {
        flash('Use uma imagem PNG, JPG ou WebP.', 'error');
        return;
      }
      if (file.size > PIXEL_REFERENCE_MAX_BYTES) {
        flash('A imagem passa de 40 MB.', 'error');
        return;
      }
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        flash('Não foi possível abrir a imagem.', 'error');
        return;
      }
      if (pixelInspector !== api) {
        bitmap.close?.();
        return;
      }
      s.image?.close?.();
      s.image = bitmap;
      s.imageName = file.name || 'Design colado';
      s.exportScale = guessExportScale(bitmap.width);
      s.offsetX = 0;
      s.offsetY = 0;
      s.visible = true;
      update();
      await matchDesignViewport();
    };

    const requestViewport = async (preset, size = null) => {
      try {
        return await chrome.runtime.sendMessage({
          target: 'background', source: 'content', type: 'WI_QA_SET_VIEWPORT', payload: { preset, size },
        });
      } catch (error) {
        return { success: false, error: { message: error.message } };
      }
    };

    // A tela assume o tamanho do design (em px CSS, já descontada a escala do
    // export) para a página ser renderizada exatamente como foi desenhada.
    const matchDesignViewport = async () => {
      if (!s.image) return;
      const size = designViewportSize(s.image.width / s.exportScale, s.image.height / s.exportScale);
      flash('Ajustando a tela ao tamanho do design…');
      const response = await requestViewport('design', size);
      if (pixelInspector !== api || !s.image) return;
      if (response?.success) {
        flash(`Tela no tamanho do design: ${size.width} × ${size.height}px · escala ${s.exportScale}x`, 'success');
      } else {
        flash(response?.error?.message || 'Não foi possível ajustar a tela ao design.', 'error');
      }
    };

    const restoreViewport = () => {
      if (responsiveViewer?.preset === 'design') void requestViewport('full');
    };

    const exit = () => {
      restoreViewport();
      removeSurface();
    };

    const removeReference = () => {
      s.image?.close?.();
      s.image = null;
      s.difference = false;
      s.opacityBeforeDifference = null;
      update();
      restoreViewport();
      flash('Design removido.');
    };

    const setOpacity = (value) => {
      s.opacity = Math.min(1, Math.max(0, Math.round(value * 100) / 100));
      s.visible = true;
      update();
    };

    const toggleVisible = () => {
      s.visible = !s.visible;
      update();
    };

    const toggleDifference = () => {
      s.difference = !s.difference;
      // A diferença só é legível com o design opaco.
      if (s.difference) {
        s.opacityBeforeDifference = s.opacity;
        s.opacity = 1;
      } else if (s.opacityBeforeDifference !== null) {
        s.opacity = s.opacityBeforeDifference;
        s.opacityBeforeDifference = null;
      }
      s.visible = true;
      update();
    };

    const moveReference = (dx, dy) => {
      s.offsetX += dx;
      s.offsetY += dy;
      update();
    };

    const centerReference = () => {
      s.offsetX = Math.round((area().contentWidth - s.image.width / s.exportScale) / 2);
      update();
    };

    const resetOffset = () => {
      s.offsetX = 0;
      s.offsetY = 0;
      update();
    };

    const toggleInspect = () => {
      s.inspecting = !s.inspecting;
      if (!s.inspecting) {
        s.pinned = null;
        s.hovered = null;
      }
      update();
      flash(s.inspecting ? 'Inspeção ligada.' : 'Inspeção desligada: a página volta a aceitar cliques.');
    };

    const setHelp = (open) => {
      help.hidden = !open;
      helpButton.setAttribute('aria-expanded', String(open));
    };

    const capture = async () => {
      if (s.capturing) return;
      s.capturing = true;
      setHelp(false);
      dock.hidden = true;
      renderOverlay();
      renderHighlight();
      await nextFrame();
      await nextFrame();
      let response;
      try {
        response = await chrome.runtime.sendMessage({ target: 'background', source: 'content', type: 'WI_QA_PIXEL_CAPTURE' });
      } catch (error) {
        response = { success: false, error: { message: error.message } };
      }
      if (pixelInspector !== api) return;
      s.capturing = false;
      dock.hidden = false;
      requestRender();
      if (response?.success) flash('Evidência anexada ao rascunho do QA.', 'success');
      else flash(response?.error?.message || 'Não foi possível capturar a evidência.', 'error');
    };

    const isOwnEvent = (event) => {
      const path = event.composedPath();
      return path.includes(host) || path.includes(overlayHost);
    };

    const pickTarget = (event) => {
      const target = s.context.document.elementFromPoint(event.clientX, event.clientY);
      if (!(target instanceof s.context.window.Element) || target === host || target === overlayHost) return null;
      return target;
    };

    const onPointerMove = (event) => {
      if (!s.inspecting || s.pinned || s.capturing || isOwnEvent(event)) return;
      const target = pickTarget(event);
      if (!target || target === s.hovered) return;
      s.hovered = target;
      requestRender();
    };

    const onClick = (event) => {
      if (!s.inspecting || s.capturing || isOwnEvent(event)) return;
      const target = pickTarget(event);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      s.pinned = s.pinned === target ? null : target;
      s.hovered = target;
      requestRender();
    };

    const onEscape = () => {
      if (!moreMenu.hidden) setMenu(false);
      else if (!help.hidden) setHelp(false);
      else if (s.pinned) {
        s.pinned = null;
        requestRender();
      } else exit();
    };

    const resolveKeyAction = (event) => {
      const { key } = event;
      if (key === 'Escape') return onEscape;
      if (key === '?') return () => setHelp(help.hidden);
      const lower = key.toLowerCase();
      if (lower === 'i') return toggleInspect;
      if (lower === 'p') return () => void capture();
      if (!s.image) return null;
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[key]) {
        const step = event.shiftKey ? 10 : 1;
        return () => moveReference(arrows[key][0] * step, arrows[key][1] * step);
      }
      if (/^[0-9]$/.test(key)) return () => setOpacity(key === '0' ? 1 : Number(key) / 10);
      if (key === '-' || key === '_') return () => setOpacity(s.opacity - 0.1);
      if (key === '+' || key === '=') return () => setOpacity(s.opacity + 0.1);
      return { h: toggleVisible, d: toggleDifference, c: centerReference, r: resetOffset }[lower] || null;
    };

    const onKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      // Controles da própria barra (opacidade, escala) usam as setas nativamente.
      const ownFocus = shadow.activeElement;
      if (ownFocus && /^(INPUT|SELECT|TEXTAREA)$/.test(ownFocus.tagName)) {
        if (event.key === 'Escape') {
          consumeEvent(event);
          ownFocus.blur();
        }
        return;
      }
      if (!ownFocus && isEditableTarget(event.composedPath()[0] || event.target)) return;
      const action = resolveKeyAction(event);
      if (!action) return;
      consumeEvent(event);
      action();
    };

    const imageFileFrom = (data) => [...(data?.files || [])].find((file) => PIXEL_REFERENCE_TYPES.test(file.type)) || null;

    const onPaste = (event) => {
      if (isEditableTarget(event.composedPath()[0] || event.target)) return;
      const file = imageFileFrom(event.clipboardData);
      if (!file) return;
      consumeEvent(event);
      void loadReference(file);
    };

    const onDragOver = (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (event) => {
      const file = imageFileFrom(event.dataTransfer);
      if (!file) return;
      consumeEvent(event);
      void loadReference(file);
    };

    const documentListeners = [['keydown', onKeyDown], ['paste', onPaste], ['dragover', onDragOver], ['drop', onDrop]];

    // Com a visualização responsiva aberta, a inspeção acontece dentro da moldura.
    const bindContext = () => {
      s.unbindContext?.();
      let context;
      try {
        context = getElementSelectionContext();
      } catch {
        context = { document, window, frame: null, preset: 'full' };
      }
      s.context = context;
      s.hovered = null;
      s.pinned = null;
      const targetDocument = context.document;
      const listeners = [['pointermove', onPointerMove], ['click', onClick], ['scroll', requestRender]];
      if (context.frame) listeners.push(...documentListeners);
      listeners.forEach(([type, listener]) => targetDocument.addEventListener(type, listener, true));
      const frame = context.frame;
      const onFrameLoad = () => {
        bindContext();
        requestRender();
      };
      frame?.addEventListener('load', onFrameLoad);
      s.unbindContext = () => {
        try {
          listeners.forEach(([type, listener]) => targetDocument.removeEventListener(type, listener, true));
        } catch {
          // A moldura pode ter navegado para outra origem.
        }
        frame?.removeEventListener('load', onFrameLoad);
        s.unbindContext = null;
      };
    };

    const teardown = () => {
      s.unbindContext?.();
      documentListeners.forEach(([type, listener]) => document.removeEventListener(type, listener, true));
      window.removeEventListener('resize', requestRender);
      window.clearTimeout(s.statusTimer);
      s.image?.close?.();
      overlayHost.remove();
      pixelInspector = null;
      previousFocus?.focus?.();
      void chrome.runtime.sendMessage({ target: 'background', source: 'content', type: 'WI_QA_PIXEL_INSPECTOR_CLOSED' }).catch(() => undefined);
    };

    inspectButton.addEventListener('click', toggleInspect);
    loadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void loadReference(file);
    });
    visibleButton.addEventListener('click', toggleVisible);
    opacityInput.addEventListener('input', () => setOpacity(Number(opacityInput.value) / 100));
    scaleSelect.addEventListener('change', () => {
      s.exportScale = Number(scaleSelect.value) || 1;
      update();
      void matchDesignViewport();
    });
    differenceButton.addEventListener('click', toggleDifference);
    moreButton.addEventListener('click', () => setMenu(moreMenu.hidden));
    // Itens do menu fecham o menu depois de agir.
    [
      [centerButton, centerReference],
      [resetButton, resetOffset],
      [swapButton, () => fileInput.click()],
      [removeButton, removeReference],
    ].forEach(([button, action]) => button.addEventListener('click', () => {
      setMenu(false);
      action();
    }));
    captureButton.addEventListener('click', () => void capture());
    helpButton.addEventListener('click', () => {
      setMenu(false);
      setHelp(help.hidden);
    });
    dockButton.addEventListener('click', () => {
      s.dockTop = !s.dockTop;
      update();
    });
    closeButton.addEventListener('click', exit);

    const api = {
      rebind: () => {
        bindContext();
        requestRender();
      },
      exit,
    };
    pixelInspector = api;
    activeCleanup = teardown;
    documentListeners.forEach(([type, listener]) => document.addEventListener(type, listener, true));
    window.addEventListener('resize', requestRender);
    bindContext();
    syncToolbar();
    inspectButton.focus();
    flash('Passe o mouse para medir · clique para fixar · cole um design com Ctrl+V', '', 6000);
  }

  function measurePixelElement(target) {
    const view = target.ownerDocument.defaultView || window;
    const style = view.getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const sides = (prefix, suffix = '') => ['Top', 'Right', 'Bottom', 'Left']
      .map((side) => parseFloat(style[`${prefix}${side}${suffix}`]) || 0);
    return {
      label: shortElementLabel(target),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      margin: sides('margin'),
      border: sides('border', 'Width'),
      padding: sides('padding'),
      borderColor: style.borderTopColor,
      borderRadius: style.borderRadius,
      font: {
        family: style.fontFamily,
        size: parseFloat(style.fontSize) || 0,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      },
      color: style.color,
      background: style.backgroundColor,
    };
  }

  function pixelSpecRows(metrics) {
    const rows = [
      { section: 'Caixa' },
      { label: 'Dimensões', value: `${formatPx(metrics.rect.width)} × ${formatPx(metrics.rect.height)} px` },
      { label: 'Margem', value: boxShorthand(metrics.margin) },
      { label: 'Preenchimento', value: boxShorthand(metrics.padding) },
    ];
    if (metrics.border.some(Boolean)) {
      rows.push({ label: 'Borda', value: `${boxShorthand(metrics.border)} · ${colorLabel(metrics.borderColor)}`, swatch: metrics.borderColor });
    }
    if (metrics.borderRadius && !/^0px( 0px)*$/.test(metrics.borderRadius)) rows.push({ label: 'Raio', value: metrics.borderRadius });
    const family = String(metrics.font.family || '');
    rows.push(
      { section: 'Tipografia' },
      { label: 'Fonte', value: family.split(',')[0].trim().replace(/^["']|["']$/g, '') || '—', copy: family },
      { label: 'Tamanho', value: `${formatPx(metrics.font.size)}px` },
      { label: 'Peso', value: fontWeightLabel(metrics.font.weight) },
      { label: 'Altura da linha', value: lineHeightLabel(metrics.font) },
    );
    if (metrics.font.letterSpacing && metrics.font.letterSpacing !== 'normal') {
      rows.push({ label: 'Espaçamento', value: metrics.font.letterSpacing });
    }
    rows.push({ label: 'Cor', value: colorLabel(metrics.color), swatch: metrics.color });
    if (!isTransparentColor(metrics.background)) {
      rows.push({ label: 'Fundo', value: colorLabel(metrics.background), swatch: metrics.background });
    }
    return rows;
  }

  function pixelSummaryRows(metrics) {
    const family = String(metrics.font.family || '').split(',')[0].trim().replace(/^["']|["']$/g, '') || '—';
    const rows = [
      { label: 'Fonte', value: `${family} · ${formatPx(metrics.font.size)}px · ${metrics.font.weight}` },
      { label: 'Cor', value: colorLabel(metrics.color), swatch: metrics.color },
    ];
    if (!isTransparentColor(metrics.background)) {
      rows.push({ label: 'Fundo', value: colorLabel(metrics.background), swatch: metrics.background });
    }
    return rows;
  }

  function pixelSpecsText(metrics) {
    return [
      `Elemento: ${metrics.label}`,
      ...pixelSpecRows(metrics).map((row) => (row.section ? `— ${row.section}` : `${row.label}: ${row.copy || row.value}`)),
    ].join('\n');
  }

  function shortElementLabel(target) {
    let label = target.tagName.toLowerCase();
    if (target.id) label += `#${target.id}`;
    const classes = [...target.classList].slice(0, 2);
    if (classes.length) label += `.${classes.join('.')}`;
    return label.slice(0, 80);
  }

  function formatPx(value) {
    return String(Math.round(Number(value || 0) * 100) / 100 || 0);
  }

  function boxShorthand(values) {
    const [top, right, bottom, left] = values.map((value) => (value ? `${formatPx(value)}px` : '0'));
    if (top === right && right === bottom && bottom === left) return top;
    if (top === bottom && right === left) return `${top} ${right}`;
    if (right === left) return `${top} ${right} ${bottom}`;
    return `${top} ${right} ${bottom} ${left}`;
  }

  function fontWeightLabel(weight) {
    const name = FONT_WEIGHT_NAMES[Number(weight)];
    return name ? `${weight} · ${name}` : String(weight);
  }

  function lineHeightLabel(font) {
    const lineHeight = parseFloat(font.lineHeight);
    if (!Number.isFinite(lineHeight)) return String(font.lineHeight || 'normal');
    return font.size ? `${formatPx(lineHeight)}px · ${(lineHeight / font.size).toFixed(2)}` : `${formatPx(lineHeight)}px`;
  }

  function parseRgb(value) {
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(String(value || '').trim());
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
  }

  function colorLabel(value) {
    const rgb = parseRgb(value);
    if (!rgb) return String(value || '—');
    const hex = `#${[rgb.r, rgb.g, rgb.b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return rgb.a < 1 ? `${hex} · ${Math.round(rgb.a * 100)}%` : hex;
  }

  function isTransparentColor(value) {
    const rgb = parseRgb(value);
    return rgb ? rgb.a === 0 : !value || value === 'transparent';
  }

  // A tela passa a ter a largura do design, então a escala não pode ser
  // deduzida da janela: usa as larguras de export mais comuns. Frames desktop
  // em 1x ficam até 1920px; acima disso é export retina.
  const RETINA_EXPORT_WIDTHS = Object.freeze({
    720: 2, 750: 2, 780: 2, 786: 2, 828: 2, 860: 2,
    1080: 3, 1125: 3, 1170: 3, 1179: 3, 1242: 3, 1284: 3, 1290: 3, 1320: 3,
  });

  function guessExportScale(imageWidth) {
    if (RETINA_EXPORT_WIDTHS[imageWidth]) return RETINA_EXPORT_WIDTHS[imageWidth];
    if (imageWidth > 3840) return 3;
    if (imageWidth > 1920) return 2;
    return 1;
  }

  // Largura sempre igual à do design; a altura também, quando cabe na tela. Num
  // design de página inteira a moldura ocupa a altura disponível e a página rola
  // junto com o design (uma moldura com a altura da imagem esticaria seções 100vh).
  function designViewportSize(designWidth, designHeight) {
    const width = Math.max(240, Math.min(2560, Math.round(designWidth)));
    const availableWidth = Math.max(1, window.innerWidth - 32);
    const availableHeight = Math.max(1, window.innerHeight - 52 - 36);
    const scale = Math.min(1, availableWidth / width);
    const height = Math.round(Math.min(designHeight, availableHeight / scale));
    return { width, height: Math.max(200, Math.min(2560, height)) };
  }

  function isEditableTarget(node) {
    if (!node || node.nodeType !== 1) return false;
    return Boolean(node.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
  }

  function consumeEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  async function copyToClipboard(text, root) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      root.append(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      field.remove();
      return copied;
    }
  }

  function nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  function sanitizeObserverEvent(value) {
    if (!value || typeof value !== 'object') return null;
    if (!['console', 'network', 'step', 'environment'].includes(value.kind)) return null;
    return sanitizeValue(value, 0);
  }

  function sanitizeValue(value, depth, key = '') {
    if (/pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credit|card|cvv|cpf|email|phone|telefone/i.test(key)) return '[REDACTED]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 4096);
    if (depth >= 6) return '[Truncated]';
    if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitizeValue(entry, depth + 1, key));
    if (!value || typeof value !== 'object') return String(value).slice(0, 256);
    const output = {};
    Object.entries(value).slice(0, 100).forEach(([entryKey, entryValue]) => {
      output[entryKey] = sanitizeValue(entryValue, depth + 1, entryKey);
    });
    return output;
  }

  function selectElement({ preferContextTarget = false } = {}) {
    const recent = lastContextTarget;
    lastContextTarget = null;
    // Só na página inteira: dentro da visualização responsiva o clique
    // direito acontece na moldura, fora deste documento.
    if (preferContextTarget && !responsiveViewer && recent?.element.isConnected
      && Date.now() - recent.at < CONTEXT_TARGET_MAX_AGE_MS) {
      removeSurface();
      return Promise.resolve(describeElement(recent.element, getElementSelectionContext()));
    }
    return new Promise((resolve, reject) => {
      removeSurface();
      const selectionContext = getElementSelectionContext();
      const targetDocument = selectionContext.document;
      const previousFocus = targetDocument.activeElement;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.dataset.surface = 'element-selector';
      Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: String(MAX_Z), pointerEvents: 'none' });
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
        .box{position:fixed;border:2px solid #ff004b;background:rgba(255,0,75,.09);box-shadow:0 0 0 1px rgba(255,255,255,.8);pointer-events:none;transition:all 45ms linear}
        .label{position:fixed;max-width:min(520px,calc(100vw - 20px));padding:6px 9px;border-radius:7px;color:#fff;background:#18181b;box-shadow:0 8px 24px rgba(0,0,0,.28);font:600 12px/1.3 ui-monospace,SFMono-Regular,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
        .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 12px;border-radius:9px;color:#fff;background:rgba(24,24,27,.94);box-shadow:0 8px 26px rgba(0,0,0,.26);font-size:12px;pointer-events:none}
      `;
      const box = document.createElement('div');
      box.className = 'box';
      const label = document.createElement('div');
      label.className = 'label';
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Clique no elemento · Esc para cancelar';
      shadow.append(style, box, label, hint);
      document.documentElement.append(host);

      let current = null;
      const update = (event) => {
        const target = targetDocument.elementFromPoint(event.clientX, event.clientY);
        if (!(target instanceof selectionContext.window.Element) || target === host) return;
        current = target;
        const rect = visualElementRect(target, selectionContext);
        const nativeRect = target.getBoundingClientRect();
        Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        const selector = stableSelector(target);
        label.textContent = `${selector} · ${Math.round(nativeRect.width)} × ${Math.round(nativeRect.height)}`;
        const labelTop = rect.y > 42 ? rect.y - 34 : Math.min(innerHeight - 32, rect.y + rect.height + 6);
        Object.assign(label.style, { left: `${Math.max(8, Math.min(rect.x, innerWidth - 220))}px`, top: `${labelTop}px` });
      };
      const cleanup = () => {
        targetDocument.removeEventListener('pointermove', update, true);
        targetDocument.removeEventListener('click', choose, true);
        targetDocument.removeEventListener('keydown', cancel, true);
        document.removeEventListener('keydown', cancel, true);
        host.remove();
        activeCleanup = null;
        previousFocus?.focus?.();
      };
      const choose = (event) => {
        if (!current) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const descriptor = describeElement(current, selectionContext);
        cleanup();
        resolve(descriptor);
      };
      const cancel = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        cleanup();
        reject(new Error('Seleção cancelada.'));
      };
      targetDocument.addEventListener('pointermove', update, true);
      targetDocument.addEventListener('click', choose, true);
      targetDocument.addEventListener('keydown', cancel, true);
      document.addEventListener('keydown', cancel, true);
      activeCleanup = cleanup;
    });
  }

  function getElementSelectionContext() {
    if (!responsiveViewer) return { document, window, frame: null, preset: 'full' };
    try {
      const frameDocument = responsiveViewer.frame.contentDocument;
      const frameWindow = responsiveViewer.frame.contentWindow;
      if (!frameDocument || !frameWindow) throw new Error('Visualização ainda carregando.');
      return { document: frameDocument, window: frameWindow, frame: responsiveViewer.frame, preset: responsiveViewer.preset };
    } catch {
      throw new Error('A visualização ainda está carregando ou saiu do domínio da página. Tente novamente após o carregamento.');
    }
  }

  function visualElementRect(element, context) {
    const rect = element.getBoundingClientRect();
    if (!context.frame) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const frameRect = context.frame.getBoundingClientRect();
    const scale = frameRect.width / Math.max(1, Number(context.frame.width) || context.window.innerWidth);
    return {
      x: frameRect.left + rect.x * scale,
      y: frameRect.top + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  function describeElement(element, context = { document, window, frame: null, preset: 'full' }) {
    const nativeRect = element.getBoundingClientRect();
    const rect = visualElementRect(element, context);
    const style = context.window.getComputedStyle(element);
    const isPrivate = element.matches('input[type="password"], [data-private], [data-wiqa-mask]') || Boolean(element.closest('[data-private], [data-wiqa-mask]'));
    const accessibleName = isPrivate ? '[REDACTED]' : String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const attributes = {};
    for (const name of ['id', 'role', 'name', 'type', 'aria-label', 'aria-expanded', 'aria-checked', 'data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute(name);
      if (value && !/value|password/i.test(name)) attributes[name] = isPrivate && /label|name/i.test(name) ? '[REDACTED]' : value.slice(0, 300);
    }
    return {
      selector: stableSelector(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || null,
      accessible_name: accessibleName, attributes,
      rect: { x: Math.round(nativeRect.x), y: Math.round(nativeRect.y), width: Math.round(nativeRect.width), height: Math.round(nativeRect.height), page_x: Math.round(nativeRect.x + context.window.scrollX), page_y: Math.round(nativeRect.y + context.window.scrollY) },
      capture_rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      // Usado para converter o retângulo em pixels da captura (prévia do elemento).
      viewport: { width: innerWidth, height: innerHeight },
      responsive_viewport: context.frame ? { preset: context.preset, width: context.window.innerWidth, height: context.window.innerHeight } : null,
      styles: {
        display: style.display, position: style.position, z_index: style.zIndex, overflow: style.overflow,
        color: style.color, background_color: style.backgroundColor, font_family: style.fontFamily.slice(0, 300),
        font_size: style.fontSize, font_weight: style.fontWeight, line_height: style.lineHeight,
        margin: style.margin, padding: style.padding, border: style.border,
      },
      state: { visible: Boolean(nativeRect.width && nativeRect.height && style.visibility !== 'hidden' && style.display !== 'none'), disabled: 'disabled' in element ? Boolean(element.disabled) : false, focused: context.document.activeElement === element },
      html: isPrivate ? '[REDACTED]' : element.outerHTML.slice(0, 4096),
      page_url: context.window.location.href.split('#')[0].slice(0, 2048), captured_at: new Date().toISOString(),
    };
  }

  function stableSelector(element) {
    const ownerDocument = element.ownerDocument || document;
    const unique = (selector) => { try { return ownerDocument.querySelectorAll(selector).length === 1; } catch { return false; } };
    for (const attribute of ['data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute(attribute);
      if (value) {
        const selector = `[${attribute}="${cssEscape(value)}"]`;
        if (unique(selector)) return selector;
      }
    }
    if (element.id && !/\d{4,}|^[a-f0-9-]{12,}$/i.test(element.id)) {
      const selector = `#${CSS.escape(element.id)}`;
      if (unique(selector)) return selector;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const stableClasses = [...current.classList].filter((name) => !/^(active|focus|hover|selected|css-|sc-)/i.test(name)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => `.${CSS.escape(name)}`).join('');
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (unique(selector)) return selector;
      current = current.parentElement;
    }
    return parts.join(' > ') || element.tagName.toLowerCase();
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function element(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function makeButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  function svgIcon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    });
    return svg;
  }

  // Sem showLabel o rótulo vira aria-label/tooltip (botão só com ícone).
  function iconButton(paths, label, className, showLabel = false) {
    const button = makeButton('', className);
    button.append(svgIcon(paths));
    if (showLabel) {
      const text = document.createElement('span');
      text.textContent = label;
      button.append(text);
    } else {
      button.setAttribute('aria-label', label);
    }
    button.title = label;
    return button;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  const STYLES = `
    :host, * { box-sizing: border-box; }
    :host { --brand:#ff004b; --brand-dark:#e00043; --ink:#18181b; --line:#e6e6ea; font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    button { font:inherit; }
    button:focus-visible { outline:3px solid rgba(0,116,255,.38); outline-offset:2px; }
    .overlay { position:fixed; inset:0; pointer-events:auto; }
    .crop-overlay { cursor:crosshair; user-select:none; touch-action:none; }
    .capture-image { position:absolute; inset:0; background-size:100vw 100vh; background-repeat:no-repeat; }
    .shade { position:absolute; inset:0; background:rgba(10,10,14,.66); backdrop-filter:blur(1px); }
    .selection { position:absolute; border:2px solid var(--brand); background-size:100vw 100vh; background-repeat:no-repeat; box-shadow:0 0 0 9999px rgba(10,10,14,.52),0 0 0 3px rgba(255,0,75,.2); }
    .selection.hidden { display:none; }
    .selection-size { position:absolute; left:0; top:calc(100% + 8px); padding:5px 8px; color:#fff; background:var(--ink); border-radius:6px; font:600 12px/1 ui-monospace,SFMono-Regular,monospace; white-space:nowrap; }
    .hint { position:absolute; top:24px; left:50%; transform:translateX(-50%); padding:10px 14px; border:1px solid rgba(255,255,255,.16); border-radius:9px; color:#fff; background:rgba(24,24,27,.9); box-shadow:0 10px 32px rgba(0,0,0,.24); font-size:13px; }
    .annotation-overlay { display:grid; grid-template-rows:minmax(0,1fr) auto; gap:16px; place-items:center; padding:24px; background:rgba(15,15,18,.84); backdrop-filter:blur(8px); }
    .annotation-stage { display:grid; place-items:center; width:100%; height:100%; min-height:0; }
    .annotation-canvas { max-width:92vw; max-height:72vh; background:#fff; border-radius:8px; box-shadow:0 18px 60px rgba(0,0,0,.42); cursor:crosshair; touch-action:none; }
    .toolbar,.tool-group,.color-group { display:flex; align-items:center; }
    .toolbar { max-width:min(920px,calc(100vw - 32px)); gap:12px; padding:10px; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:rgba(24,24,27,.96); color:#fff; box-shadow:0 14px 40px rgba(0,0,0,.32); overflow:auto; }
    .tool-group,.color-group { gap:6px; }
    .color-group { padding:0 12px; border-inline:1px solid rgba(255,255,255,.16); }
    .tool-button,.plain-button,.primary-button,.stop-button { min-height:36px; border:0; border-radius:8px; padding:0 12px; color:#fff; background:transparent; cursor:pointer; white-space:nowrap; }
    .tool-button:hover,.plain-button:hover { background:rgba(255,255,255,.1); }
    .tool-button.active { background:rgba(255,255,255,.14); }
    .color-button { width:26px; height:26px; border:2px solid transparent; border-radius:50%; cursor:pointer; }
    .color-button.active { border-color:#fff; box-shadow:0 0 0 2px rgba(255,255,255,.35); }
    .primary-button,.stop-button { background:var(--brand-dark); font-weight:700; }
    .primary-button:hover,.stop-button:hover { background:#c9003b; }
    .countdown-overlay { display:grid; place-content:center; justify-items:center; gap:10px; color:#fff; background:rgba(16,16,20,.64); backdrop-filter:blur(6px); }
    .countdown-number { color:#fff; font-size:96px; line-height:1; letter-spacing:-.06em; text-shadow:0 8px 28px rgba(255,0,75,.32); }
    .countdown-label { font-size:14px; color:rgba(255,255,255,.78); }
    .recording-bar { pointer-events:auto; display:flex; align-items:center; gap:10px; width:max-content; max-width:calc(100vw - 32px); margin:auto; padding:8px 10px 8px 12px; border:1px solid rgba(255,255,255,.12); border-radius:12px; color:#fff; background:rgba(24,24,27,.96); box-shadow:0 12px 38px rgba(0,0,0,.32); }
    .recording-dot { width:9px; height:9px; border-radius:50%; background:var(--brand); animation:pulse 1.4s ease-in-out infinite; }
    .recording-label { font-size:13px; color:rgba(255,255,255,.78); }
    .recording-time { min-width:44px; font:650 13px/1 ui-monospace,SFMono-Regular,monospace; font-variant-numeric:tabular-nums; }
    .stop-button { min-height:32px; padding-inline:14px; }
    button:disabled { opacity:.58; cursor:wait; }
    @keyframes pulse { 50% { opacity:.35; transform:scale(.86); } }
    @media (max-width:640px) { .annotation-overlay{padding:12px}.toolbar{gap:6px}.tool-button{font-size:12px;padding-inline:8px}.color-group{padding-inline:8px}.annotation-canvas{max-width:96vw;max-height:68vh} }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important} }
  `;

  // Cores do box model seguem o DevTools: margem laranja, borda amarela,
  // preenchimento verde e conteúdo azul.
  const PIXEL_STYLES = `
    [hidden] { display:none !important; }
    .pi-mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; }
    .pi-boxes { position:fixed; inset:0; pointer-events:none; }
    .pi-box { position:fixed; border-style:solid; border-width:0; pointer-events:none; }
    .pi-margin { border-color:rgba(246,178,107,.55); }
    .pi-border { border-color:rgba(255,229,153,.75); outline:1px dashed rgba(255,0,75,.9); }
    .pi-border.is-pinned { outline:2px solid var(--brand); }
    .pi-padding { border-color:rgba(147,196,125,.55); background:rgba(111,168,220,.4); }
    .pi-tip { position:fixed; left:0; top:0; width:max-content; max-width:min(320px,calc(100vw - 16px)); padding:10px 12px; border:1px solid rgba(255,255,255,.12); border-radius:10px; color:#f4f4f5; background:rgba(24,24,27,.96); box-shadow:0 12px 32px rgba(0,0,0,.35); font-size:12px; line-height:1.35; pointer-events:none; }
    .pi-tip.is-pinned { pointer-events:auto; box-shadow:0 0 0 1px rgba(255,0,75,.55),0 12px 32px rgba(0,0,0,.35); }
    .pi-tip-header { display:flex; align-items:baseline; justify-content:space-between; gap:14px; margin-bottom:6px; }
    .pi-tip-header strong { overflow:hidden; color:#ff7aa2; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    .pi-size { flex:none; color:#d4d4d8; }
    .pi-specs { display:grid; grid-template-columns:auto minmax(0,1fr); gap:3px 14px; }
    .pi-section { grid-column:1/-1; margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,.1); color:#a1a1aa; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
    .pi-section:first-child { margin-top:0; padding-top:0; border-top:0; }
    .pi-key { color:#a1a1aa; white-space:nowrap; }
    .pi-value { display:flex; align-items:center; gap:6px; min-width:0; overflow-wrap:anywhere; }
    .pi-swatch { flex:none; width:12px; height:12px; border-radius:3px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.4); }
    .pi-tip-footer { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.1); color:#a1a1aa; font-size:11px; }
    .pi-tip-footer .pi-button { min-height:26px; padding:0 8px; font-size:11px; }
    .pi-dock { position:fixed; left:50%; bottom:16px; display:flex; flex-direction:column; align-items:center; gap:8px; width:max-content; max-width:calc(100vw - 24px); transform:translateX(-50%); pointer-events:none; animation:pi-dock-rise 260ms cubic-bezier(.2,.8,.2,1); }
    .pi-dock.at-top { top:16px; bottom:auto; flex-direction:column-reverse; }
    .pi-toolbar { display:flex; align-items:center; gap:4px; max-width:100%; padding:5px; border:1px solid rgba(255,255,255,.1); border-radius:14px; color:#fff; background:rgba(24,24,27,.94); box-shadow:0 12px 36px rgba(0,0,0,.3); backdrop-filter:blur(10px); font-size:12px; pointer-events:auto; }
    .pi-title { padding:0 8px 0 10px; color:#a1a1aa; font-size:11px; font-weight:650; letter-spacing:.02em; white-space:nowrap; cursor:help; }
    .pi-divider { flex:none; width:1px; height:20px; margin:0 4px; background:rgba(255,255,255,.12); }
    .pi-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:32px; padding:0 10px; border:0; border-radius:9px; color:#e4e4e7; background:transparent; cursor:pointer; white-space:nowrap; transition:background-color 120ms ease, color 120ms ease; }
    .pi-button:hover { color:#fff; background:rgba(255,255,255,.1); }
    .pi-button svg { flex:none; width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .pi-toggle.active { color:#fff; background:rgba(255,0,75,.24); box-shadow:inset 0 0 0 1px rgba(255,0,75,.5); }
    .pi-icon { width:32px; padding:0; }
    .pi-icon.active { color:#ff7aa2; }
    .pi-primary { color:#fff; background:var(--brand-dark); font-weight:650; }
    .pi-primary:hover { background:#c9003b; }
    .pi-reference { padding:4px 5px; border-radius:12px; animation:pi-rise 220ms cubic-bezier(.2,.8,.2,1); }
    .pi-range { display:flex; align-items:center; gap:6px; padding:0 6px; color:#d4d4d8; }
    .pi-range input { width:88px; accent-color:var(--brand); }
    .pi-range output { min-width:34px; font-size:11px; text-align:right; }
    .pi-select { height:30px; padding:0 4px; border:0; border-radius:8px; color:#e4e4e7; background:rgba(255,255,255,.08); font:inherit; cursor:pointer; }
    .pi-offset { padding:0 6px; color:#a1a1aa; font-size:11px; }
    .pi-more { position:relative; }
    .pi-more .pi-icon svg { stroke-width:3.2; }
    .pi-menu { position:absolute; right:0; bottom:calc(100% + 8px); display:grid; min-width:200px; padding:5px; border:1px solid rgba(255,255,255,.1); border-radius:12px; background:rgba(24,24,27,.98); box-shadow:0 14px 40px rgba(0,0,0,.36); animation:pi-pop 160ms ease-out; }
    .at-top .pi-menu { top:calc(100% + 8px); bottom:auto; }
    .pi-menu-item { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:32px; padding:0 10px; border:0; border-radius:8px; color:#e4e4e7; background:transparent; text-align:left; cursor:pointer; }
    .pi-menu-item:hover { background:rgba(255,255,255,.08); }
    .pi-menu-item kbd { color:#71717a; font:600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .pi-danger { color:#fb7185; }
    .pi-status { max-width:min(460px,calc(100vw - 24px)); padding:7px 12px; border-radius:999px; color:#e4e4e7; background:rgba(24,24,27,.9); box-shadow:0 8px 24px rgba(0,0,0,.24); font-size:12px; text-align:center; pointer-events:none; animation:pi-pop 180ms ease-out; }
    .pi-status[data-tone="success"] { color:#bbf7d0; background:rgba(22,101,52,.95); }
    .pi-status[data-tone="error"] { color:#ffe4e6; background:rgba(159,18,57,.95); }
    .pi-help { width:min(420px,calc(100vw - 24px)); padding:12px 14px; border:1px solid rgba(255,255,255,.1); border-radius:12px; color:#fff; background:rgba(24,24,27,.96); box-shadow:0 14px 40px rgba(0,0,0,.32); font-size:12px; pointer-events:auto; animation:pi-pop 160ms ease-out; }
    .pi-help-note { margin:0 0 10px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,.1); color:#a1a1aa; font-size:11px; line-height:1.4; }
    .pi-help dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0; }
    .pi-help dt { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-weight:650; white-space:nowrap; }
    .pi-help dd { margin:0; color:#d4d4d8; }
    @keyframes pi-rise { from { opacity:0; transform:translateY(8px); } }
    @keyframes pi-dock-rise { from { opacity:0; transform:translate(-50%,8px); } to { opacity:1; transform:translate(-50%,0); } }
    @keyframes pi-pop { from { opacity:0; transform:scale(.96); } }
    @media (max-width:640px) { .pi-toolbar .pi-button > span { display:none; } .pi-toolbar .pi-button:has(> span) { width:32px; padding:0; } .pi-title { display:none; } .pi-range input { width:64px; } }
  `;
})();
