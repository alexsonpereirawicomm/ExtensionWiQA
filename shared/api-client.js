const DEFAULT_TIMEOUT_MS = 30_000;

export class QaApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'QaApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'UNKNOWN_ERROR';
    this.retryable = options.retryable ?? (this.status === 0 || this.status === 429 || this.status >= 500);
    this.requestId = options.requestId ?? null;
    this.details = options.details ?? null;
  }
}

export function normalizeSupabaseUrl(value) {
  const input = String(value || '').trim().replace(/\/+$/, '');
  if (!input) throw new QaApiError('Informe a URL do Supabase.', { code: 'CONFIG_URL_REQUIRED' });

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new QaApiError('A URL do Supabase é inválida.', { code: 'CONFIG_URL_INVALID' });
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new QaApiError('Use HTTPS para conectar ao Supabase.', { code: 'CONFIG_URL_PROTOCOL' });
  }

  return url.origin;
}

export function sanitizeConfig(raw = {}) {
  const authMode = raw.authMode === 'wiflow' ? 'wiflow' : 'client';
  const config = {
    supabaseUrl: normalizeSupabaseUrl(raw.supabaseUrl),
    supabaseKey: String(raw.supabaseKey || raw.anonKey || raw.publishableKey || '').trim(),
    projectToken: String(raw.projectToken || raw.token || '').trim(),
    authMode,
    clientAccessToken: String(raw.clientAccessToken || '').trim(),
    sessionToken: String(raw.sessionToken || raw.wiflowSessionToken || '').trim(),
    userId: String(raw.userId || raw.wiflowUserId || '').trim(),
    wiflowEmail: String(raw.wiflowEmail || '').trim().toLowerCase(),
    wiflowIssuedAt: String(raw.wiflowIssuedAt || '').trim(),
    clientAccessExpiresAt: String(raw.clientAccessExpiresAt || '').trim(),
    authorName: String(raw.authorName || '').trim(),
    authorEmail: String(raw.authorEmail || '').trim(),
  };

  if (!config.supabaseKey) {
    throw new QaApiError('Informe a chave pública do Supabase.', { code: 'CONFIG_KEY_REQUIRED' });
  }
  if (!config.projectToken) {
    throw new QaApiError('Informe o token do projeto.', { code: 'CONFIG_PROJECT_TOKEN_REQUIRED' });
  }
  if (authMode === 'client' && !config.clientAccessToken && !raw.clientPassword) {
    throw new QaApiError('Informe o token de acesso do cliente ou a senha.', { code: 'CONFIG_CLIENT_TOKEN_REQUIRED' });
  }
  if (authMode === 'wiflow' && (!config.sessionToken || !config.userId)) {
    throw new QaApiError('Informe a sessão e o usuário Wiflow.', { code: 'CONFIG_WIFLOW_REQUIRED' });
  }

  return config;
}

export async function verifyClientAccessPassword(supabaseUrl, anonKey, password) {
  const url = new URL(`${supabaseUrl}/functions/v1/client-access/verify`);
  
  const headers = {
    apikey: anonKey,
    'Content-Type': 'application/json',
  };

  if (/^eyJ[A-Za-z0-9_-]+\./.test(anonKey)) {
    headers.Authorization = `Bearer ${anonKey}`;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ password }),
  });

  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }

  if (!response.ok || !body.token) {
    throw new QaApiError(body.error || 'Senha de convidado inválida.', {
      status: response.status,
      code: 'INVALID_PASSWORD',
      retryable: false,
    });
  }

  return { token: body.token, expiresAt: body.expiresAt || '' };
}

// Login por e-mail: mesmo fluxo de código do WiControl web
// (frontend/src/lib/wiflow-auth.ts), passando pela edge function wiflow-proxy.
async function wiflowAuthRequest(supabaseUrl, anonKey, path, payload, fallbackError) {
  const headers = {
    apikey: anonKey,
    'Content-Type': 'application/json',
    'x-wiflow-path': path,
  };
  if (/^eyJ[A-Za-z0-9_-]+\./.test(anonKey)) {
    headers.Authorization = `Bearer ${anonKey}`;
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/wiflow-proxy`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new QaApiError('Não foi possível falar com o WiFlow. Verifique sua conexão.', {
      code: 'WIFLOW_NETWORK_ERROR',
    });
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new QaApiError(body.error || fallbackError, {
      status: response.status,
      code: 'WIFLOW_AUTH_FAILED',
      retryable: response.status >= 500,
    });
  }
  return body;
}

export async function requestWiflowLoginCode(supabaseUrl, anonKey, email) {
  const body = await wiflowAuthRequest(
    supabaseUrl,
    anonKey,
    '/auth/request-token',
    { email: String(email || '').trim().toLowerCase() },
    'Falha ao solicitar código de acesso.',
  );
  return body.message || 'Código enviado. Verifique seu e-mail.';
}

export async function validateWiflowLoginCode(supabaseUrl, anonKey, email, code) {
  const body = await wiflowAuthRequest(
    supabaseUrl,
    anonKey,
    '/auth/validate-token',
    { email: String(email || '').trim().toLowerCase(), code: String(code || '').trim() },
    'Código inválido ou expirado.',
  );
  if (!body.sessionToken || !body.user?.id) {
    throw new QaApiError(body.error || 'Código inválido ou expirado.', {
      status: 401,
      code: 'INVALID_LOGIN_CODE',
      retryable: false,
    });
  }
  return { sessionToken: body.sessionToken, user: body.user };
}

// Retorna null quando o WiFlow recusa a renovação; quem chama mantém a sessão
// atual até ela vencer de fato.
export async function renewWiflowSession(supabaseUrl, anonKey, sessionToken, userId) {
  try {
    const body = await wiflowAuthRequest(
      supabaseUrl,
      anonKey,
      '/auth/renew-session',
      { sessionToken, userId },
      'Falha ao renovar a sessão.',
    );
    return body.newSessionToken ? { sessionToken: body.newSessionToken, user: body.user || null } : null;
  } catch {
    return null;
  }
}

export function publicConfig(config = {}) {
  return {
    supabaseUrl: config.supabaseUrl || '',
    supabaseKey: config.supabaseKey || '',
    anonKey: config.supabaseKey || config.anonKey || '',
    publishableKey: config.supabaseKey || config.publishableKey || '',
    projectToken: config.projectToken || '',
    authMode: config.authMode || 'client',
    clientAccessToken: config.clientAccessToken || '',
    sessionToken: config.sessionToken || '',
    wiflowSessionToken: config.sessionToken || config.wiflowSessionToken || '',
    userId: config.userId || '',
    wiflowUserId: config.userId || config.wiflowUserId || '',
    wiflowEmail: config.wiflowEmail || '',
    clientAccessExpiresAt: config.clientAccessExpiresAt || '',
    authorName: config.authorName || '',
    authorEmail: config.authorEmail || '',
  };
}

export class QaApiClient {
  constructor(rawConfig) {
    this.config = sanitizeConfig(rawConfig);
    this.baseUrl = `${this.config.supabaseUrl}/functions/v1/client-project-qa`;
  }

  buildHeaders({ idempotencyKey, json = true } = {}) {
    const headers = {
      apikey: this.config.supabaseKey,
      Accept: 'application/json',
    };

    // A referência atual usa o JWT anon legado também como Bearer. As novas
    // chaves sb_publishable_* não são JWTs e devem permanecer apenas em apikey.
    if (/^eyJ[A-Za-z0-9_-]+\./.test(this.config.supabaseKey)) {
      headers.Authorization = `Bearer ${this.config.supabaseKey}`;
    }

    if (json) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    if (this.config.authMode === 'wiflow') {
      headers['x-wiflow-session-token'] = this.config.sessionToken;
      headers['x-wiflow-user-id'] = this.config.userId;
    } else {
      headers['x-client-access-token'] = this.config.clientAccessToken;
    }

    return headers;
  }

  async request(path, options = {}) {
    const method = options.method || 'GET';
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders({ idempotencyKey: options.idempotencyKey }),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const requestId = response.headers.get('x-request-id');
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }

      if (!response.ok) {
        throw new QaApiError(data?.error || data?.message || `Falha HTTP ${response.status}.`, {
          status: response.status,
          code: data?.code || `HTTP_${response.status}`,
          retryable: data?.retryable,
          requestId: data?.request_id || requestId,
          details: data,
        });
      }

      return data || {};
    } catch (error) {
      if (error instanceof QaApiError) throw error;
      if (error?.name === 'AbortError') {
        throw new QaApiError('A operação demorou mais que o esperado.', {
          code: 'REQUEST_TIMEOUT',
          retryable: true,
        });
      }
      throw new QaApiError('Não foi possível conectar ao Supabase.', {
        code: 'NETWORK_ERROR',
        retryable: true,
        details: error?.message,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getSnapshot(options = {}) {
    return this.request('/snapshot', {
      query: {
        token: this.config.projectToken,
        includeMembers: options.includeMembers === false ? 'false' : 'true',
      },
    });
  }

  // Atualização parcial (PUT /item): só os campos enviados mudam.
  updateItem(itemId, fields) {
    return this.request('/item', {
      method: 'PUT',
      body: {
        token: this.config.projectToken,
        id: itemId,
        item: fields,
      },
    });
  }

  initMedia(metadata, idempotencyKey) {
    return this.request('/media/init', {
      method: 'POST',
      idempotencyKey,
      body: {
        token: this.config.projectToken,
        kind: metadata.kind,
        mime_type: metadata.mimeType,
        size_bytes: metadata.sizeBytes,
        duration_ms: metadata.durationMs || 0,
        client_request_id: idempotencyKey,
      },
    });
  }

  completeMedia(mediaId, options = {}) {
    return this.request('/media/complete', {
      method: 'POST',
      body: {
        token: this.config.projectToken,
        media_id: mediaId,
      },
      timeoutMs: options.timeoutMs || 60_000,
    });
  }

  createDiagnostic(bundle, idempotencyKey) {
    return this.request('/diagnostic', {
      method: 'POST',
      idempotencyKey,
      body: {
        token: this.config.projectToken,
        client_request_id: idempotencyKey,
        schema_version: 1,
        bundle,
      },
    });
  }

  createItem(draft, idempotencyKey) {
    const body = {
      token: this.config.projectToken,
      item: {
        device: draft.device,
        location: draft.location,
        page_url: draft.pageUrl,
        description: draft.description,
        image_urls: draft.imageUrls || [],
        status: draft.status,
        priority: draft.priority,
        responsible_id: draft.responsibleId || null,
        responsible_name: draft.responsibleName || null,
      },
      author: {
        name: draft.authorName || this.config.authorName || undefined,
        email: draft.authorEmail || this.config.authorEmail || undefined,
      },
      attachment_ids: draft.attachmentIds || [],
      diagnostic_session_ids: draft.diagnosticSessionIds || [],
      client_request_id: idempotencyKey,
    };

    if (!body.author.name && !body.author.email) delete body.author;

    return this.request('/item', {
      method: 'POST',
      idempotencyKey,
      body,
    });
  }
}

export function assertSignedUploadUrl(uploadUrl, supabaseUrl) {
  let target;
  let expected;
  try {
    target = new URL(uploadUrl);
    expected = new URL(supabaseUrl);
  } catch {
    throw new QaApiError('O backend retornou uma URL de upload inválida.', {
      code: 'UPLOAD_URL_INVALID',
    });
  }

  if (target.protocol === expected.protocol && target.host === expected.host) {
    return target.toString();
  }

  // No Supabase local a Edge Function enxerga SUPABASE_URL=http://kong:8000
  // (rede interna do Docker) e assina URLs com esse host, inacessível do
  // navegador. O caminho assinado é o mesmo; reaproveitamos só ele sobre a
  // origem configurada, então o arquivo nunca vai para outro host.
  if (target.pathname.startsWith('/storage/v1/object/upload/sign/')) {
    return new URL(`${target.pathname}${target.search}`, expected.origin).toString();
  }

  throw new QaApiError('O host da URL de upload não corresponde ao Supabase configurado.', {
    code: 'UPLOAD_URL_HOST_MISMATCH',
  });
}

// Mesmo caso do upload: URLs de leitura assinadas localmente saem com o host
// interno do Docker. Outras URLs (imagens externas antigas) ficam como estão.
export function rebaseStorageUrl(value, supabaseUrl) {
  try {
    const target = new URL(value);
    const expected = new URL(supabaseUrl);
    if (target.host === expected.host || !target.pathname.startsWith('/storage/v1/')) return target.toString();
    return new URL(`${target.pathname}${target.search}`, expected.origin).toString();
  } catch {
    return value;
  }
}

export async function uploadToSignedUrl(initResponse, blob, supabaseUrl) {
  const uploadUrl = assertSignedUploadUrl(initResponse.upload_url, supabaseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  const declaredHeaders = initResponse.upload?.headers || {};

  try {
    const response = await fetch(uploadUrl, {
      method: initResponse.upload?.method || 'PUT',
      headers: {
        'content-type': blob.type || declaredHeaders['content-type'] || 'application/octet-stream',
        'cache-control': declaredHeaders['cache-control'] || 'max-age=3600',
        'x-upsert': 'false',
      },
      body: blob,
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new QaApiError(message || `Falha no upload (${response.status}).`, {
        status: response.status,
        code: response.status === 413 ? 'MEDIA_TOO_LARGE' : 'SIGNED_UPLOAD_FAILED',
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
  } catch (error) {
    if (error instanceof QaApiError) throw error;
    throw new QaApiError(
      error?.name === 'AbortError' ? 'O upload excedeu o tempo limite.' : 'O upload da mídia falhou.',
      { code: 'SIGNED_UPLOAD_NETWORK_ERROR', retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
