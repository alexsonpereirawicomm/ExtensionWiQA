export const STORAGE_KEYS = Object.freeze({
  CONFIG: 'wiqaConfig',
  PROJECT: 'wiqaProject',
  DRAFT: 'wiqaDraft',
  MEDIA: 'wiqaMedia',
  RECORDER: 'wiqaRecorderState',
  LAST_ITEM: 'wiqaLastItem',
  DIAGNOSTICS: 'wiqaDiagnostics',
  CAPTURED_MEDIA_LEGACY: 'capturedMedia',
});

export const VALID_DEVICES = Object.freeze(['Mobile', 'Desktop', 'Mob&Desk']);
export const VALID_PRIORITIES = Object.freeze(['Baixa', 'Média', 'Alta']);
export const VALID_STATUSES = Object.freeze([
  'Pendente',
  'Em andamento',
  'Validação',
  'Concluído',
  'Cancelado',
  'Info',
  'Layout',
  'Gestão',
  'Cadastro',
  'Plataforma',
]);

export function makeRecorderState(overrides = {}) {
  return {
    status: 'idle',
    sessionId: null,
    recordingId: null,
    mode: null,
    sourceTabId: null,
    sourcePageUrl: '',
    startedAt: null,
    durationMs: 0,
    sizeBytes: 0,
    paused: false,
    error: null,
    ...overrides,
  };
}


export function validateDraft(draft = {}, { requireImage = true, requireElement = false } = {}) {
  const errors = {};
  if (!VALID_DEVICES.includes(draft.device)) errors.device = 'Selecione um dispositivo válido.';
  if (!String(draft.location || '').trim()) errors.location = 'Informe a localização.';
  if (!String(draft.description || '').trim()) errors.description = 'Revise e informe a descrição.';
  if (!VALID_PRIORITIES.includes(draft.priority)) errors.priority = 'Selecione uma prioridade válida.';
  if (!VALID_STATUSES.includes(draft.status)) errors.status = 'Selecione um status válido.';

  try {
    const url = new URL(draft.pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    errors.pageUrl = 'A URL da página é inválida.';
  }

  if (requireImage && !draft.hasImage && !(draft.imageUrls || []).length && !draft.hasDiagnostic) {
    errors.media = 'Adicione uma captura ou contexto de diagnóstico.';
  }
  if (requireElement && !draft.hasSelectedElement) {
    errors.element = 'Selecione o elemento onde o problema acontece.';
  }
  return errors;
}
