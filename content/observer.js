(() => {
  'use strict';

  if (window.__wiqaObserverLoaded) return;
  window.__wiqaObserverLoaded = true;

  const SOURCE = 'wiqa-page-observer';
  const MAX_STRING = 4096;
  const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credit|card|cvv|cpf|email|phone|telefone/i;
  const originalConsole = {};
  const now = () => Date.now();

  function redactUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      return url.toString().slice(0, 2048);
    } catch {
      return String(value || '').slice(0, 2048);
    }
  }

  function serialize(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, MAX_STRING);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
      return { name: value.name, message: String(value.message).slice(0, MAX_STRING), stack: String(value.stack || '').slice(0, 12000) };
    }
    if (value instanceof Element) return elementHint(value);
    if (depth >= 4) return '[Truncated]';
    if (!value || typeof value !== 'object') return String(value).slice(0, MAX_STRING);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => serialize(entry, depth + 1, seen));
    const output = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : serialize(value[key], depth + 1, seen);
    }
    return output;
  }

  function elementHint(element) {
    if (!(element instanceof Element)) return null;
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    const isPrivate = element.matches('input[type="password"], [data-private], [data-wiqa-mask]') || Boolean(element.closest('[data-private], [data-wiqa-mask]'));
    const label = isPrivate ? '[REDACTED]' : String(
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.textContent ||
      ''
    ).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { role, label };
  }

  function emit(kind, payload) {
    window.postMessage({
      source: SOURCE,
      version: 1,
      event: { kind, at: now(), ...payload },
    }, '*');
  }

  for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    originalConsole[level] = original;
    console[level] = function wiqaConsole(...args) {
      try {
        emit('console', { level, args: args.map((entry) => serialize(entry)) });
      } catch {
        // Observação nunca interfere no console da página.
      }
      return Reflect.apply(original, this, args);
    };
  }

  window.addEventListener('error', (event) => {
    emit('console', {
      level: 'uncaught',
      args: [String(event.message || 'Erro JavaScript').slice(0, MAX_STRING)],
      stack: String(event.error?.stack || '').slice(0, 12000),
      url: redactUrl(event.filename || location.href),
      line: event.lineno || null,
      column: event.colno || null,
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    emit('console', {
      level: 'unhandledrejection',
      args: [serialize(event.reason)],
      stack: event.reason instanceof Error ? String(event.reason.stack || '').slice(0, 12000) : '',
    });
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function wiqaFetch(input, init) {
      const startedAt = now();
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const url = redactUrl(input instanceof Request ? input.url : input);
      try {
        const response = await Reflect.apply(originalFetch, this, [input, init]);
        emit('network', {
          request_id: crypto.randomUUID?.() || `${startedAt}-${Math.random()}`,
          transport: 'fetch', method, url, status: response.status,
          ok: response.ok, duration_ms: now() - startedAt,
          response_type: response.headers.get('content-type')?.split(';')[0] || '',
        });
        return response;
      } catch (error) {
        emit('network', {
          request_id: crypto.randomUUID?.() || `${startedAt}-${Math.random()}`,
          transport: 'fetch', method, url, status: 0,
          ok: false, duration_ms: now() - startedAt,
          error: String(error?.message || error).slice(0, 500),
        });
        throw error;
      }
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function wiqaXhrOpen(method, url, ...rest) {
    this.__wiqaRequest = { method: String(method || 'GET').toUpperCase(), url: redactUrl(url) };
    return Reflect.apply(xhrOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function wiqaXhrSend(body) {
    const startedAt = now();
    const request = this.__wiqaRequest || { method: 'GET', url: '' };
    const onDone = () => {
      emit('network', {
        request_id: crypto.randomUUID?.() || `${startedAt}-${Math.random()}`,
        transport: 'xhr', method: request.method, url: request.url,
        status: Number(this.status || 0), ok: this.status >= 200 && this.status < 400,
        duration_ms: now() - startedAt,
        response_type: String(this.getResponseHeader?.('content-type') || '').split(';')[0],
        error: this.status === 0 ? 'Falha de rede ou requisição cancelada' : '',
      });
      this.removeEventListener('loadend', onDone);
    };
    this.addEventListener('loadend', onDone);
    return Reflect.apply(xhrSend, this, [body]);
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button, a, input, select, textarea, [role], [data-testid]') : null;
    if (target) emit('step', { action: 'click', target: elementHint(target) });
  }, true);
  document.addEventListener('submit', (event) => {
    emit('step', { action: 'submit', target: elementHint(event.target) });
  }, true);
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      emit('step', { action: 'change', target: elementHint(target), value_captured: false });
    }
  }, true);

  const emitNavigation = () => emit('step', { action: 'navigate', url: redactUrl(location.href) });
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function wiqaHistory(...args) {
      const result = Reflect.apply(original, this, args);
      emitNavigation();
      return result;
    };
  }
  window.addEventListener('popstate', emitNavigation);
  window.addEventListener('hashchange', emitNavigation);

  emit('environment', {
    environment: {
      url: redactUrl(location.href),
      title: document.title.slice(0, 300),
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height },
      device_pixel_ratio: devicePixelRatio,
      orientation: screen.orientation?.type || (innerWidth > innerHeight ? 'landscape' : 'portrait'),
      touch_capable: navigator.maxTouchPoints > 0,
      locale: navigator.language,
      languages: Array.from(navigator.languages || []).slice(0, 10),
      online: navigator.onLine,
      user_agent: navigator.userAgent.slice(0, 500),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
})();
