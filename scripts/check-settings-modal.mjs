// Verifies the settings modal: gear button shows up next to ?, click opens
// the modal, save persists to chrome.storage.local.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STUB_PORT = 4501;

// Tiny stub that pretends to be www.instagram.com so content.js mounts.
import http from 'node:http';
const stub = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><title>FS Stub</title></head><body><div id=root>stub</div></body></html>');
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
console.log('[stub]', STUB_URL);

// Build a temp manifest that matches our stub origin.
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
const tmpExt = mkdtempSync(join(tmpdir(), 'fs-ext-settings-'));
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'));
// Inject stub URL into matches so content.js loads on the stub
const stubMatch = `${STUB_URL}/*`;
manifest.host_permissions = [...new Set([...manifest.host_permissions, stubMatch])];
manifest.content_scripts[0].matches = [...new Set([...manifest.content_scripts[0].matches, stubMatch])];
manifest.web_accessible_resources[0].matches = [...new Set([...manifest.web_accessible_resources[0].matches, stubMatch])];

// Copy every file referenced by the manifest content_scripts + helpers
const files = [
  'background.js', 'content.js', 'injected.js', 'overlay.css', 'rules.json',
  'offscreen.html', 'offscreen.js',
  ...manifest.content_scripts[0].js,
  ...manifest.web_accessible_resources.flatMap((r) => r.resources),
];
for (const f of files) {
  const src = join(REPO_ROOT, f);
  if (!existsSync(src)) { console.warn('[skip-missing]', f); continue; }
  const dest = join(tmpExt, f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
writeFileSync(join(tmpExt, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = mkdtempSync(join(tmpdir(), 'fs-user-settings-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${tmpExt}`,
    `--load-extension=${tmpExt}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
  ],
  viewport: { width: 1100, height: 800 },
});

ctx.on('serviceworker', (sw) => {
  console.log('[sw.spawn]', sw.url());
  sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));
});

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page.err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || /FS\b/.test(m.text())) console.log('[page]', m.type(), m.text().slice(0, 220));
});

console.log('---- visiting stub');
await page.goto(STUB_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.querySelector('.fs-root'), { timeout: 8000 }).catch(() => {});

const gearBtn = page.locator('.fs-root [data-act="settings"]');
const gearVisible = await gearBtn.isVisible().catch(() => false);
const gearText = await gearBtn.textContent().catch(() => null);
const helpVisible = await page.locator('.fs-root [data-act="help"]').isVisible().catch(() => false);
console.log('[gear]', { visible: gearVisible, text: gearText, helpVisible });

if (!gearVisible) {
  console.error('FAIL: gear button not in DOM');
} else {
  await gearBtn.click();
  await page.waitForTimeout(400);
  const modalVisible = await page.locator('.fs-modal .fs-settings').isVisible().catch(() => false);
  const title = await page.locator('.fs-modal-head b').textContent().catch(() => null);
  console.log('[modal]', { visible: modalVisible, title });

  // Read input defaults
  const apiVal = await page.locator('[data-fs-input="apiBase"]').inputValue().catch(() => null);
  const appVal = await page.locator('[data-fs-input="appUrl"]').inputValue().catch(() => null);
  console.log('[inputs.before]', { apiBase: apiVal, appUrl: appVal });

  // Edit values + save
  await page.locator('[data-fs-input="apiBase"]').fill('http://localhost:9999');
  await page.locator('[data-fs-input="groq"]').fill('gsk_test_xyz');
  await page.locator('[data-act="fs-settings-save"]').click();
  await page.waitForTimeout(600);
  const saveStatus = await page.locator('[data-fs-settings-status]').textContent().catch(() => null);
  console.log('[save.status]', JSON.stringify(saveStatus));

  // Verify chrome.storage.local was written
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    const stored = await sw.evaluate(
      () => new Promise((res) => chrome.storage.local.get(
        ['fs.api.baseUrl', 'fs.app.url', 'fs.dev.groq_key', 'fs.dev.openai_key', 'fs.dev.whisperx_url'],
        res,
      )),
    );
    console.log('[storage.after-save]', stored);
  }
}

await ctx.close();
await new Promise((r) => stub.close(r));
console.log('---- done');
