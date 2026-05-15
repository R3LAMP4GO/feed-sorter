// Reproduces the exact flow the user took: hit /login/callback?token=… then
// inspect chrome.storage.local from the extension SW to confirm the token
// landed.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const APP_URL = 'http://localhost:3000';
const API_URL = 'http://localhost:8787';
const USER = process.env.USER || 'postgres';

// 1. Issue a fresh magic link
const issue = await (await fetch(`${API_URL}/v1/auth/magic-link`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'playwright-test@example.com' }),
})).json();
console.log('[issue]', issue);

const token = execSync(
  `psql -U ${USER} -d feedsorter -tAc "select token from magic_link_tokens where email='playwright-test@example.com' and used_at is null order by expires_at desc limit 1;"`,
).toString().trim();
console.log('[token]', token);

const userDataDir = mkdtempSync(join(tmpdir(), 'fs-callback-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${REPO_ROOT}`,
    `--load-extension=${REPO_ROOT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
  ],
  viewport: { width: 1100, height: 800 },
});

ctx.on('serviceworker', (sw) => {
  console.log('[sw.spawn]', sw.url());
  sw.on('console', (m) => console.log('[sw.console]', m.type(), m.text()));
});

const page = await ctx.newPage();
await page.exposeFunction('__fsLog', (...a) => console.log('[bridge]', ...a));
await page.addInitScript(() => {
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.source === 'feedsorter-ext' || d.source === 'feedsorter-web') {
      // @ts-ignore
      window.__fsLog(d.source, d.kind, d.replyTo || '', d.token ? '<token>' : '');
    }
  });
});
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[page.error]', e.message));

console.log('---- visiting /login/callback?token=...');
await page.goto(`${APP_URL}/login/callback?token=${encodeURIComponent(token)}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(3000);

console.log('[final url]', page.url());
const cookies = await ctx.cookies(APP_URL);
console.log('[web cookies]', cookies.map((c) => `${c.name}=${c.value.slice(0,20)}…`));

const sw = ctx.serviceWorkers()[0];
if (sw) {
  const stored = await sw.evaluate(
    () => new Promise((res) => chrome.storage.local.get(['fs.api.token', 'fs.api.baseUrl'], res)),
  );
  console.log('[sw.storage]', JSON.stringify(stored));
}

await ctx.close();
console.log('done');
