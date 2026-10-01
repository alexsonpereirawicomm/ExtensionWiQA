/* ==================================================
   WiControl QA — Content Script
   Injetado em todas as páginas.
   Responsável por: Overlay de crop, Countdown, Barra de gravação
   ================================================== */

(function () {
  'use strict';

  // Evitar injeção dupla
  if (window.__wqcContentLoaded) return;
  window.__wqcContentLoaded = true;

  // =============================================
  // LISTENER DE MENSAGENS
  // =============================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;

    switch (msg.type) {
      case 'initCrop':
        initCropOverlay(msg.image);
        sendResponse({ success: true });
        break;

      case 'showCountdown':
        showCountdown(() => {
          sendResponse({ success: true });
        });
        return true; // async

      case 'showRecordingBar':
        showRecordingBar();
        sendResponse({ success: true });
        break;

      case 'hideRecordingBar':
        hideRecordingBar();
        sendResponse({ success: true });
        break;
    }
  });

  // =============================================
  // CROP OVERLAY
  // =============================================
  function initCropOverlay(dataUrl) {
    cleanup('wqc-crop-overlay');

    const overlay = document.createElement('div');
    overlay.id = 'wqc-crop-overlay';

    overlay.innerHTML = `
      <div id="wqc-crop-bg" style="background-image:url(${dataUrl})"></div>
      <div id="wqc-crop-selection" style="background-image:url(${dataUrl})"></div>
      <div id="wqc-crop-instructions">Clique e arraste para selecionar a área · ESC para cancelar</div>
    `;

    document.documentElement.appendChild(overlay);

    const selection = document.getElementById('wqc-crop-selection');
    const instructions = document.getElementById('wqc-crop-instructions');
    let drawing = false;
    let sx = 0, sy = 0, ex = 0, ey = 0;

    overlay.addEventListener('mousedown', (e) => {
      drawing = true;
      sx = e.clientX;
      sy = e.clientY;
      selection.style.display = 'block';
      selection.style.left = sx + 'px';
      selection.style.top = sy + 'px';
      selection.style.width = '0px';
      selection.style.height = '0px';
      instructions.style.display = 'none';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!drawing) return;
      ex = e.clientX;
      ey = e.clientY;

      const x = Math.min(sx, ex);
      const y = Math.min(sy, ey);
      const w = Math.abs(ex - sx);
      const h = Math.abs(ey - sy);

      selection.style.left = x + 'px';
      selection.style.top = y + 'px';
      selection.style.width = w + 'px';
      selection.style.height = h + 'px';
      selection.style.backgroundPosition = `-${x}px -${y}px`;
    });

    overlay.addEventListener('mouseup', () => {
      if (!drawing) return;
      drawing = false;

      const x = Math.min(sx, ex);
      const y = Math.min(sy, ey);
      const w = Math.abs(ex - sx);
      const h = Math.abs(ey - sy);

      if (w < 10 || h < 10) {
        overlay.remove();
        return;
      }

      cropAndSave(dataUrl, x, y, w, h).then((croppedUrl) => {
        overlay.remove();
        initAnnotationOverlay(croppedUrl);
      });
    });

    // ESC para cancelar
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onEsc);
      }
    };
    document.addEventListener('keydown', onEsc);
  }

  function cropAndSave(dataUrl, x, y, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = w * ratio;
        canvas.height = h * ratio;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, x * ratio, y * ratio, w * ratio, h * ratio, 0, 0, w * ratio, h * ratio);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  // =============================================
  // ANNOTATION OVERLAY
  // =============================================
  function initAnnotationOverlay(dataUrl) {
    cleanup('wqc-annotation-overlay');

    const overlay = document.createElement('div');
    overlay.id = 'wqc-annotation-overlay';

    overlay.innerHTML = `
      <canvas id="wqc-annotation-canvas"></canvas>
      <div id="wqc-annotation-toolbar">
        <button class="wqc-tool-btn active" data-tool="pen">✏️ Livre</button>
        <button class="wqc-tool-btn" data-tool="rect">⬜ Retângulo</button>
        <button class="wqc-tool-btn" data-tool="arrow">↗️ Seta</button>
        <div class="wqc-color-picker">
          <button class="wqc-color-btn active" style="background:#ff004b" data-color="#ff004b"></button>
          <button class="wqc-color-btn" style="background:#00e676" data-color="#00e676"></button>
          <button class="wqc-color-btn" style="background:#2979ff" data-color="#2979ff"></button>
          <button class="wqc-color-btn" style="background:#ffea00" data-color="#ffea00"></button>
        </div>
        <button class="wqc-action-btn" id="wqc-annot-cancel">Cancelar</button>
        <button class="wqc-action-btn primary" id="wqc-annot-save">✅ Concluir</button>
      </div>
    `;

    document.documentElement.appendChild(overlay);

    const canvas = document.getElementById('wqc-annotation-canvas');
    const ctx = canvas.getContext('2d');
    let currentTool = 'pen';
    let currentColor = '#ff004b';
    let isDrawing = false;
    let startX = 0, startY = 0;
    
    let baseImage = new Image();

    const img = new Image();
    img.onload = () => {
      const maxWidth = window.innerWidth * 0.9;
      const maxHeight = window.innerHeight * 0.8;
      
      let w = img.width;
      let h = img.height;
      
      if (w > maxWidth || h > maxHeight) {
        const ratio = Math.min(maxWidth / w, maxHeight / h);
        w *= ratio;
        h *= ratio;
      }

      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      
      baseImage.src = canvas.toDataURL();
    };
    img.src = dataUrl;

    const toolBtns = overlay.querySelectorAll('.wqc-tool-btn');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        toolBtns.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentTool = e.currentTarget.dataset.tool;
      });
    });

    const colorBtns = overlay.querySelectorAll('.wqc-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        colorBtns.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentColor = e.currentTarget.dataset.color;
      });
    });

    document.getElementById('wqc-annot-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('wqc-annot-save').addEventListener('click', () => {
      const finalDataUrl = canvas.toDataURL('image/png');
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'saveCropResult',
        dataUrl: finalDataUrl
      });
      overlay.remove();
    });

    function getMousePos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    function drawArrow(ctx, fromx, fromy, tox, toy) {
      const headlen = 15;
      const dx = tox - fromx;
      const dy = toy - fromy;
      const angle = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(fromx, fromy);
      ctx.lineTo(tox, toy);
      ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(tox, toy);
      ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }

    canvas.addEventListener('mousedown', (e) => {
      isDrawing = true;
      const pos = getMousePos(e);
      startX = pos.x;
      startY = pos.y;
      
      ctx.strokeStyle = currentColor;
      ctx.fillStyle = currentColor;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (currentTool === 'pen') {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!isDrawing) return;
      const pos = getMousePos(e);

      if (currentTool === 'pen') {
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(baseImage, 0, 0);
        
        ctx.strokeStyle = currentColor;
        ctx.fillStyle = currentColor;
        ctx.lineWidth = 4;
        
        if (currentTool === 'rect') {
          ctx.beginPath();
          ctx.rect(startX, startY, pos.x - startX, pos.y - startY);
          ctx.stroke();
        } else if (currentTool === 'arrow') {
          drawArrow(ctx, startX, startY, pos.x, pos.y);
        }
      }
    });

    canvas.addEventListener('mouseup', () => {
      if (!isDrawing) return;
      isDrawing = false;
      baseImage.src = canvas.toDataURL();
    });

    canvas.addEventListener('mouseleave', () => {
      if (isDrawing) {
        isDrawing = false;
        baseImage.src = canvas.toDataURL();
      }
    });
  }

  // =============================================
  // COUNTDOWN (3, 2, 1...)
  // =============================================
  function showCountdown(callback) {
    cleanup('wqc-countdown-overlay');

    const overlay = document.createElement('div');
    overlay.id = 'wqc-countdown-overlay';
    overlay.innerHTML = `
      <div id="wqc-countdown-number">3</div>
      <div id="wqc-countdown-label">Preparando para gravar...</div>
    `;
    document.documentElement.appendChild(overlay);

    const numEl = document.getElementById('wqc-countdown-number');
    let count = 3;

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        numEl.textContent = count;
        numEl.style.animation = 'none';
        void numEl.offsetWidth; // reflow
        numEl.style.animation = 'wqc-count-pop 0.8s ease-out';
      } else {
        clearInterval(interval);
        overlay.remove();
        callback();
      }
    }, 1000);
  }

  // =============================================
  // BARRA DE GRAVAÇÃO FLUTUANTE
  // =============================================
  let recBarInterval = null;
  let recBarSeconds = 0;

  function showRecordingBar() {
    cleanup('wqc-recording-bar');
    recBarSeconds = 0;

    const bar = document.createElement('div');
    bar.id = 'wqc-recording-bar';
    bar.innerHTML = `
      <span class="wqc-rec-dot"></span>
      <span class="wqc-rec-timer">00:00</span>
      <button class="wqc-rec-stop">⏹ Parar</button>
    `;
    document.documentElement.appendChild(bar);

    const timerEl = bar.querySelector('.wqc-rec-timer');
    const stopBtn = bar.querySelector('.wqc-rec-stop');

    recBarInterval = setInterval(() => {
      recBarSeconds++;
      const m = String(Math.floor(recBarSeconds / 60)).padStart(2, '0');
      const s = String(recBarSeconds % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
    }, 1000);

    stopBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ target: 'background', type: 'stopRecording' });
      hideRecordingBar();
    });
  }

  function hideRecordingBar() {
    clearInterval(recBarInterval);
    cleanup('wqc-recording-bar');
  }

  // =============================================
  // UTILS
  // =============================================
  function cleanup(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

})();
