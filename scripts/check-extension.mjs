// Headful Chromium with the unpacked extension loaded against the local
// web app. Visits /login, then /connect, and prints all console + page
// errors plus any [FS] logs from content scripts. Exits 0 on success.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const userDataDir = mkdtempSync(join(tmpdir(), 'fs-check-'));
const args = [
  `--disable-extensions-except=${REPO_ROOT}`,
  `--load-extension=${REPO_ROOT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
];

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args,
  viewport: { width: 1100, height: 800 },
});

const log = (tag, ...rest) => console.log(`[${tag}]`, ...rest);

ctx.on('weberror', (e) => log('weberror', e.error()));
ctx.on('serviceworker', (sw) => {
  log('sw.spawn', sw.url());
  sw.on('console', (m) => log('sw.console', m.type(), m.text()));
});

const page = await ctx.newPage();
page.on('console', (m) => log('page.console', m.type(), m.text()));
page.on('pageerror', (e) => log('page.error', e.message));
page.on('requestfailed', (r) => log('page.reqfail', r.url(), r.failure()?.errorText));

// Capture every postMessage from the page so we see whether the bridge
// content script reported `present` and replied to our pings.
await page.exposeFunction('__fsLog', (...a) => log('bridge', ...a));
await page.addInitScript(() => {
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.source === 'feedsorter-ext' || d.source === 'feedsorter-web') {
      // @ts-ignore
      window.__fsLog(d.source, d.kind, d.replyTo || '', d.ok ?? '');
    }
  });
});

console.log('---- visiting', `${APP_URL}/connect`);
await page.goto(`${APP_URL}/connect`, { waitUntil: 'domcontentloaded' });
// Give middleware redirects, content-script injection, and React hydration
// a moment to settle.
await page.waitForTimeout(3000);
log('url', page.url());

const h1 = await page.locator('h1').first().textContent().catch(() => null);
log('h1', h1);
const statusText = await page
  .locator('.rounded.border .text-sm')
  .first()
  .textContent()
  .catch(() => null);
log('status-line', JSON.stringify(statusText));
const btnEnabled = await page.locator('button').filter({ hasText: 'Connect' }).isEnabled().catch(() => null);
log('connect-btn-enabled', btnEnabled);

// Stage 2: simulate a signed-in user by setting a fake session cookie and
// clicking Connect. The button should round-trip through the bridge and
// flip the status to "Connected."
log('---- stage 2: setting fake session cookie + clicking Connect');
await ctx.addCookies([
  {
    name: 'session',
    value: 'fake-jwt-for-bridge-test',
    url: APP_URL,
    sameSite: 'Lax',
  },
]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'Connect extension' }).click();
await page.waitForTimeout(1200);
const statusAfter = await page
  .locator('.rounded.border .text-sm')
  .first()
  .textContent()
  .catch(() => null);
log('status-after-connect', JSON.stringify(statusAfter));

// Confirm SW received api.set-token by reading chrome.storage.local from
// the SW context.
const sw = ctx.serviceWorkers()[0];
if (sw) {
  const stored = await sw.evaluate(
    () => new Promise((res) => chrome.storage.local.get(['fs.api.token', 'fs.api.baseUrl'], res)),
  );
  log('sw.storage', JSON.stringify(stored));
}

console.log('---- service workers seen so far:');
ctx.serviceWorkers().forEach((sw) => console.log('  •', sw.url()));

await page.waitForTimeout(500);
await ctx.close();
console.log('done');
