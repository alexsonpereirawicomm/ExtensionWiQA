/* ==================================================
   WiControl QA — Background Service Worker
   Orquestra: screenshots, gravação via tabCapture, offscreen
   ================================================== */

// =============================================
// LISTENER CENTRAL
// =============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return false;

  switch (message.type) {
    case 'takeScreenshot':
      handleScreenshot(sendResponse);
      return true;

    case 'saveCropResult':
      handleSaveCrop(message.dataUrl);
      return false;

    case 'startRecording':
      handleStartRecording(sendResponse);
      return true;

    case 'stopRecording':
      handleStopRecording(sendResponse);
      return true;

    case 'saveRecording':
      handleSaveRecording(message.dataUrl);
      return false;
  }

  return false;
});

// =============================================
// SCREENSHOT
// =============================================
async function handleScreenshot(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Captura a tela inteira da aba visível
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // Envia a imagem para o content script iniciar o crop
    chrome.tabs.sendMessage(tab.id, {
      target: 'content',
      type: 'initCrop',
      image: dataUrl
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Content script não encontrado, injetando...');
        // Injeta dinamicamente se o content script não estiver presente
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        }, () => {
          chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content/content.css']
          }, () => {
            // Tenta novamente após injeção
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, {
                target: 'content',
                type: 'initCrop',
                image: dataUrl
              });
            }, 200);
          });
        });
      }
    });

    sendResponse({ success: true });
  } catch (error) {
    console.error('Erro no screenshot:', error);
    sendResponse({ success: false, error: error.message });
  }
}

function handleSaveCrop(dataUrl) {
  chrome.storage.local.set({
    capturedMedia: { type: 'image', dataUrl, name: 'screenshot.png' }
  });
}

// =============================================
// GRAVAÇÃO DE ABA
// =============================================

async function hasOffscreenDocument() {
  const matchedClients = await clients.matchAll();
  return matchedClients.some(c => c.url.endsWith('offscreen/offscreen.html'));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Gravar a aba do navegador para QA'
  });
}

function handleStartRecording(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) {
      sendResponse({ success: false, error: 'Nenhuma aba ativa' });
      return;
    }

    // Solicita o streamId da aba (sem popup nativo de compartilhamento)
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, async (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        const errMsg = chrome.runtime.lastError?.message || 'Falha ao obter stream da aba';
        console.error('tabCapture error:', errMsg);
        sendResponse({ success: false, error: errMsg });
        return;
      }

      try {
        await ensureOffscreenDocument();

        // Mostra countdown na aba
        chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'showCountdown' }, () => {
          // Após countdown, inicia gravação
          setTimeout(() => {
            chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'startRecording',
              streamId
            });

            // Mostra barra flutuante na aba
            chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'showRecordingBar' });
          }, 3200); // 3 segundos de countdown + buffer
        });

        sendResponse({ success: true });
      } catch (error) {
        console.error('Erro ao preparar gravação:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
  });
}

function handleStopRecording(sendResponse) {
  // Esconde a barra flutuante
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { target: 'content', type: 'hideRecordingBar' });
    }
  });

  // Para a gravação no offscreen
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopRecording' });
  sendResponse?.({ success: true });
}

function handleSaveRecording(dataUrl) {
  chrome.storage.local.set({
    capturedMedia: { type: 'video', dataUrl, name: 'recording.webm' }
  }, () => {
    chrome.storage.local.set({ isRecording: false, recordingStart: null });
  });
}
