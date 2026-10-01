import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];

if (manifest.manifest_version !== 3) errors.push('manifest_version deve ser 3.');
if (Number(manifest.minimum_chrome_version || 0) < 116) errors.push('minimum_chrome_version deve ser 116 ou superior.');
if (!manifest.side_panel?.default_path) errors.push('side_panel.default_path não foi configurado.');
if (manifest.host_permissions?.includes('<all_urls>')) errors.push('host_permissions não pode usar <all_urls>.');
if (manifest.content_scripts?.some((entry) => entry.matches?.includes('<all_urls>'))) {
  errors.push('content_scripts global deve ser removido; use injeção sob demanda.');
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);

for (const relativePath of referencedFiles) {
  try {
    await access(join(root, relativePath));
  } catch {
    errors.push(`Arquivo referenciado ausente: ${relativePath}`);
  }
}

for (const htmlPath of ['sidepanel/sidepanel.html', 'popup/popup.html', 'offscreen/offscreen.html']) {
  try {
    const html = await readFile(join(root, htmlPath), 'utf8');
    if (/<(script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(html)) {
      errors.push(`${htmlPath} carrega script/estilo remoto.`);
    }
  } catch {
    errors.push(`HTML ausente: ${htmlPath}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Manifesto MV3 validado; ${referencedFiles.length} arquivos referenciados encontrados.`);
}

