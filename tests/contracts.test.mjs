import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QaApiClient,
  QaApiError,
  assertSignedUploadUrl,
  normalizeSupabaseUrl,
  sanitizeConfig,
} from '../shared/api-client.js';
import {
  VALID_PRIORITIES,
  VALID_STATUSES,
  validateDraft,
} from '../shared/contracts.js';

test('normaliza a origem Supabase e remove paths', () => {
  assert.equal(normalizeSupabaseUrl('https://demo.supabase.co/path/'), 'https://demo.supabase.co');
  assert.equal(normalizeSupabaseUrl('http://127.0.0.1:54321/'), 'http://127.0.0.1:54321');
});

test('recusa Supabase remoto sem HTTPS', () => {
  assert.throws(() => normalizeSupabaseUrl('http://demo.supabase.co'), QaApiError);
});

test('valida configuração de cliente', () => {
  const config = sanitizeConfig({
    supabaseUrl: 'https://demo.supabase.co',
    supabaseKey: 'sb_publishable_test',
    projectToken: 'project-token',
    authMode: 'client',
    clientAccessToken: 'client-token',
  });
  assert.equal(config.authMode, 'client');
  assert.equal(config.clientAccessToken, 'client-token');
});

test('exige sessão e usuário no modo Wiflow', () => {
  assert.throws(() => sanitizeConfig({
    supabaseUrl: 'https://demo.supabase.co',
    supabaseKey: 'sb_publishable_test',
    projectToken: 'project-token',
    authMode: 'wiflow',
    sessionToken: 'session-only',
  }), /sessão e o usuário/i);
});

test('aceita somente URL assinada do Supabase configurado', () => {
  assert.equal(
    assertSignedUploadUrl(
      'https://demo.supabase.co/storage/v1/object/upload/sign/qa-media/file?token=abc',
      'https://demo.supabase.co',
    ),
    'https://demo.supabase.co/storage/v1/object/upload/sign/qa-media/file?token=abc',
  );
  assert.throws(() => assertSignedUploadUrl(
    'https://attacker.example/upload?token=abc',
    'https://demo.supabase.co',
  ), /não corresponde/i);
});

test('reescreve a URL assinada com host interno do Docker para a origem configurada', () => {
  assert.equal(
    assertSignedUploadUrl(
      'http://kong:8000/storage/v1/object/upload/sign/qa-media/qa/p/drafts/m.webp?token=abc',
      'http://127.0.0.1:54421',
    ),
    'http://127.0.0.1:54421/storage/v1/object/upload/sign/qa-media/qa/p/drafts/m.webp?token=abc',
  );
});

test('enums do formulário correspondem ao contrato documentado', () => {
  assert.deepEqual(VALID_PRIORITIES, ['Baixa', 'Média', 'Alta']);
  assert.ok(VALID_STATUSES.includes('Em andamento'));
  assert.ok(!VALID_STATUSES.includes('Em Análise'));
  assert.ok(!VALID_STATUSES.includes('Resolvido'));
});

test('validação aceita captura ou contexto de diagnóstico como evidência', () => {
  const valid = {
    device: 'Desktop',
    location: 'Produto',
    pageUrl: 'https://example.com/produto',
    description: 'Botão desalinhado.',
    priority: 'Média',
    status: 'Pendente',
    hasImage: true,
  };
  assert.deepEqual(validateDraft(valid), {});
  assert.deepEqual(validateDraft({ ...valid, hasImage: false, hasDiagnostic: true }), {});
  assert.equal(
    validateDraft({ ...valid, hasImage: false, hasDiagnostic: false }).media,
    'Adicione uma captura ou contexto de diagnóstico.',
  );
});

test('seleção de elemento pode ser exigida sem tornar screenshot obrigatório', () => {
  const draft = {
    device: 'Desktop',
    location: 'Produto',
    pageUrl: 'https://example.com/produto',
    description: 'Botão desalinhado.',
    priority: 'Média',
    status: 'Pendente',
    hasImage: false,
    hasDiagnostic: true,
    hasSelectedElement: true,
  };
  assert.deepEqual(validateDraft(draft, { requireImage: false, requireElement: true }), {});
  assert.equal(
    validateDraft({ ...draft, hasSelectedElement: false }, { requireImage: false, requireElement: true }).element,
    'Selecione o elemento onde o problema acontece.',
  );
});

test('updateItem envia PUT /item só com os campos alterados', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ item: { id: 'item-1', status: 'Concluído' } }), { status: 200 });
  };
  try {
    const client = new QaApiClient({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseKey: 'sb_publishable_test',
      projectToken: 'project-token',
      authMode: 'client',
      clientAccessToken: 'client-token',
    });
    const response = await client.updateItem('item-1', { status: 'Concluído' });
    assert.equal(response.item.status, 'Concluído');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://demo.supabase.co/functions/v1/client-project-qa/item');
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      token: 'project-token',
      id: 'item-1',
      item: { status: 'Concluído' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
