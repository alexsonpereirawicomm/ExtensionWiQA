// Gera os PNGs do ícone (o Chrome não aceita SVG em manifest.icons) a partir
// de assets/icon.svg, usando o Chrome em modo headless.
// Uso: node scripts/build-icons.mjs   (CHROME_PATH sobrescreve o executável)
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // tenta o próximo
    }
  }
  throw new Error('Chrome não encontrado. Defina CHROME_PATH.');
}

const chrome = await findChrome();
const svg = await readFile(join(root, 'assets/icon.svg'), 'utf8');
const workDir = await mkdtemp(join(tmpdir(), 'wiqa-icons-'));

try {
  for (const size of SIZES) {
    const page = join(workDir, `icon-${size}.html`);
    await writeFile(page, `<!doctype html><html><head><style>
      html, body { margin: 0; background: transparent; overflow: hidden; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style></head><body>${svg}</body></html>`);

    const output = join(root, `assets/icon-${size}.png`);
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--user-data-dir=${join(workDir, 'profile')}`,
      `--screenshot=${output}`,
      pathToFileURL(page).href,
    ], { stdio: 'ignore' });
    console.log(`assets/icon-${size}.png`);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
