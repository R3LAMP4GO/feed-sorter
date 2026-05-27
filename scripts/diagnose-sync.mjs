// End-to-end sync diagnostic.
//
// 1. Issue a fresh magic-link, exchange via /login/callback so the bridge
//    hands the JWT to the SW.
// 2. Seed IDB with a representative IG post so the sync has data.
// 3. Invoke chrome.runtime.sendMessage({ cmd: 'api.sync-posts' }) from the
//    SW's own context and report the response.
// 4. Verify the row appears in Postgres.

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
const EMAIL = 'diag@example.com';

console.log('---- promote diag user to pro');
execSync(
  `psql -U ${USER} -d feedsorter -c "insert into users (email, tier) values ('${EMAIL}','pro') on conflict (email) do update set tier='pro';" -q`,
);

console.log('---- issue magic link');
await fetch(`${API_URL}/v1/auth/magic-link`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL }),
});
const token = execSync(
  `psql -U ${USER} -d feedsorter -tAc "select token from magic_link_tokens where email='${EMAIL}' and used_at is null order by expires_at desc limit 1;"`,
).toString().trim();
console.log('[token]', `${token.slice(0, 12)}…`);

const userDataDir = mkdtempSync(join(tmpdir(), 'fs-diag-'));
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
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[page.err]', e.message));

console.log('\n=== STEP 1: hand off token via /login/callback ===');
await page.goto(`${APP_URL}/login/callback?token=${encodeURIComponent(token)}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(2500);
console.log('[final url]', page.url());

const sw = ctx.serviceWorkers()[0];
if (!sw) {
  console.error('NO SERVICE WORKER FOUND'); process.exit(1);
}

const stored = await sw.evaluate(
  () => new Promise((res) => chrome.storage.local.get(['fs.api.token', 'fs.api.baseUrl'], res)),
);
console.log('[sw.storage]', {
  baseUrl: stored['fs.api.baseUrl'],
  hasToken: !!stored['fs.api.token'],
  tokenStart: `${(stored['fs.api.token'] || '').slice(0, 20)}…`,
});

console.log('\n=== STEP 2: seed IDB with a representative IG post ===');
const seedResult = await sw.evaluate(async () => {
  const post = {
    id: 'ig_diag_3001',
    nativeId: '3001',
    shortcode: 'diag1',
    platform: 'instagram',
    author: 'diaguser',
    desc: 'diagnostic post — hello world',
    createTime: Math.floor(Date.now() / 1000) - 3600,
    likes: 1234,
    comments: 56,
    views: 78900,
    shares: 12,
    durationSec: 23,
    cover: 'https://example.com/cover.jpg',
    videoUrl: 'https://example.com/video.mp4',
    surface: 'profile',
    isReel: true,
    mediaType: 2,
    productType: 'video',
  };
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('feed-sorter');
    req.onsuccess = () => {
      const db = req.result;
      const stores = Array.from(db.objectStoreNames);
      if (!stores.includes('posts')) {
        resolve({ ok: false, err: 'no posts store', stores, version: db.version });
        return;
      }
      const tx = db.transaction('posts', 'readwrite');
      tx.objectStore('posts').put(post);
      tx.oncomplete = () => {
        const rtx = db.transaction('posts', 'readonly');
        const all = rtx.objectStore('posts').getAll();
        all.onsuccess = () => resolve({ ok: true, stores, version: db.version, count: all.result.length, sample: all.result[0] });
        all.onerror = () => reject(all.error);
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
});
console.log('[idb.seed]', JSON.stringify(seedResult, null, 2).slice(0, 800));

console.log('\n=== STEP 3: invoke api.sync-posts from SW ===');
const syncResp = await sw.evaluate(
  () => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'fs-bg', cmd: 'api.sync-posts' }, (r) => {
      res({ lastError: chrome.runtime.lastError?.message ?? null, response: r });
    });
  }),
);
console.log('[sync resp]', JSON.stringify(syncResp, null, 2));

await page.waitForTimeout(800);

console.log('\n=== STEP 4: verify in Postgres ===');
const dbCount = execSync(
  `psql -U ${USER} -d feedsorter -tAc "select count(*) from posts where id='ig_diag_3001';"`,
).toString().trim();
console.log('[db.posts.count for ig_diag_3001]', dbCount);

const dbCaptures = execSync(
  `psql -U ${USER} -d feedsorter -tAc "select c.user_id, c.scope from captures c join users u on u.id=c.user_id where c.post_id='ig_diag_3001' and u.email='${EMAIL}';"`,
).toString().trim();
console.log('[db.captures]', dbCaptures || '(none)');

console.log('\n=== STEP 5: tail API log ===');
try {
  const apiLog = execSync(
    `tail -25 /Users/imorgado/.gg/bg/6381a28a.log | grep -E "posts/sync|sync.|level\\":50|err" || true`,
  ).toString();
  console.log(apiLog);
} catch (_) {}

await ctx.close();
console.log('\n---- done');
