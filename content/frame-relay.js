(() => {
  'use strict';

  if (window.top === window || window.__wiqaFrameRelayLoaded) return;
  window.__wiqaFrameRelayLoaded = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'wiqa-page-observer') return;
    const diagnosticEvent = sanitize(event.data.event, 0);
    if (!diagnosticEvent || !['console', 'network', 'step', 'environment'].includes(diagnosticEvent.kind)) return;
    void chrome.runtime.sendMessage({
      target: 'background',
      source: 'content-frame',
      type: 'WI_QA_DIAGNOSTIC_EVENT',
      payload: { event: diagnosticEvent, draftId: '' },
    }).catch(() => undefined);
  });

  function sanitize(value, depth, key = '') {
    if (/pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credit|card|cvv|cpf|email|phone|telefone/i.test(key)) return '[REDACTED]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 4096);
    if (depth >= 6) return '[Truncated]';
    if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitize(entry, depth + 1, key));
    if (!value || typeof value !== 'object') return String(value).slice(0, 256);
    const output = {};
    Object.entries(value).slice(0, 100).forEach(([entryKey, entryValue]) => {
      output[entryKey] = sanitize(entryValue, depth + 1, entryKey);
    });
    return output;
  }
})();
