document.addEventListener('DOMContentLoaded', () => {
  const btnOpenPanel = document.getElementById('btnOpenPanel');
  const btnQuickScreenshot = document.getElementById('btnQuickScreenshot');
  const projectStatus = document.getElementById('projectStatus');
  const launcherMessage = document.getElementById('launcherMessage');

  // Update project status
  chrome.storage.local.get(['wiqaProject'], (result) => {
    const project = result.wiqaProject;
    if (project && (project.name || project.id)) {
      projectStatus.innerHTML = `<i></i>${project.name || 'Conectado'}`;
      projectStatus.classList.add('is-online');
    } else {
      projectStatus.innerHTML = `<i></i>Não conectado`;
      projectStatus.classList.remove('is-online');
    }
  });

  // Open side panel
  btnOpenPanel.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.windowId) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        window.close();
      }
    } catch (e) {
      console.error(e);
    }
  });

  // Quick screenshot
  btnQuickScreenshot.addEventListener('click', () => {
    launcherMessage.textContent = 'Iniciando captura...';
    launcherMessage.style.color = 'var(--wi-ink-soft)';
    
    // Try sending new protocol command
    chrome.runtime.sendMessage({ target: 'background', type: 'WI_QA_CAPTURE_SCREENSHOT' }, (response) => {
      if (chrome.runtime.lastError || (response && !response.success && response.error && typeof response.error.message === 'string' && response.error.message.includes('Operação desconhecida'))) {
        // Fallback to legacy
        chrome.runtime.sendMessage({ target: 'background', type: 'takeScreenshot' }, () => {
          window.close();
        });
      } else {
        window.close();
      }
    });
  });
});
