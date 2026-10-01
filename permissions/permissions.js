/*
 * Página "Liberar acessos". Abre numa aba para ter espaço de explicar o passo a
 * passo de cada acesso e o que fazer quando algo foi recusado.
 *
 * Abrir com ?focus=site|pages destaca o card correspondente.
 */
(() => {
  'use strict';

  const STATUS_LABELS = {
    checking: 'Verificando…',
    granted: 'Liberado',
    prompt: 'Pendente',
    missing: 'Conecte o projeto'
  };

  const params = new URLSearchParams(location.search);
  const focus = params.get('focus') || '';
  // A conexão é liberada antes de existir configuração salva; o painel passa a
  // origem digitada no formulário.
  const requestedOrigin = params.get('origin') || '';
  const cards = {
    site: document.getElementById('card-site'),
    pages: document.getElementById('card-pages')
  };
  let siteOrigin = '';

  document.addEventListener('DOMContentLoaded', initialize);

  async function initialize() {
    document.querySelector('[data-action="grant-site"]').addEventListener('click', grantSite);
    document.querySelector('[data-action="grant-pages"]').addEventListener('click', grantPages);
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);

    await refresh();

    if (cards[focus]) {
      cards[focus].classList.add('is-focused');
      cards[focus].scrollIntoView({ block: 'center' });
    }
  }

  async function refresh() {
    const config = (await chrome.storage.local.get('wiqaConfig')).wiqaConfig;
    siteOrigin = originOf(requestedOrigin) || originOf(config && config.supabaseUrl);
    document.getElementById('siteOrigin').textContent = siteOrigin ? new URL(siteOrigin).host : 'Supabase';
    document.querySelector('.prompt-site').textContent = siteOrigin ? new URL(siteOrigin).host : 'seu-projeto.supabase.co';

    setCardState('site', siteOrigin
      ? (await chrome.permissions.contains({ origins: [`${siteOrigin}/*`] })) ? 'granted' : 'prompt'
      : 'missing');
    setCardState('pages', (await chrome.permissions.contains({ origins: ['<all_urls>'] })) ? 'granted' : 'prompt');
  }

  function setCardState(key, value) {
    const card = cards[key];
    card.dataset.state = value;
    const badge = card.querySelector('.access-status');
    badge.dataset.status = value;
    badge.textContent = STATUS_LABELS[value] || value;

    card.querySelectorAll('[data-when]').forEach((element) => {
      element.classList.toggle('hidden', element.dataset.when !== value);
    });
    const grantButton = card.querySelector('[data-action^="grant-"]');
    if (grantButton) grantButton.disabled = value === 'missing';
  }

  async function grantSite() {
    if (!siteOrigin) return;
    const granted = await chrome.permissions.request({ origins: [`${siteOrigin}/*`] }).catch(() => false);
    showToast(granted ? 'Conexão liberada.' : 'A conexão não foi liberada. Clique em Permitir no aviso do Chrome.', granted ? 'success' : 'error');
    refresh();
  }

  async function grantPages() {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    showToast(granted
      ? 'Acesso às páginas liberado. Volte ao painel e tente o Screenshot de novo.'
      : 'O acesso não foi liberado. Clique em Permitir no aviso do Chrome.', granted ? 'success' : 'error');
    refresh();
  }

  function originOf(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.origin : '';
    } catch (error) {
      return '';
    }
  }

  function showToast(message, type = 'default') {
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
    toast.textContent = message;
    document.getElementById('toastRegion').appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
})();
