// Feed Sorter popup. Three tabs: Main (sign-in + sync), Settings (API URLs +
// backend status), Dev (BYOK overrides stored in chrome.storage.local).

const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = {
  apiBase: 'fs.api.baseUrl',
  token: 'fs.api.token',
  appUrl: 'fs.app.url',
  groq: 'fs.dev.groq_key',
  openai: 'fs.dev.openai_key',
  whisperx: 'fs.dev.whisperx_url',
};

const DEFAULTS = {
  apiBase: 'http://localhost:8787',
  appUrl: 'http://localhost:3000',
};

function deriveAppUrl(apiBaseUrl) {
  try {
    const u = new URL(apiBaseUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return 'http://' + u.hostname + ':3000';
    }
    if (u.hostname.startsWith('api.')) {
      return u.protocol + '//' + 'app.' + u.hostname.slice(4);
    }
    return u.origin;
  } catch (_) {
    return DEFAULTS.appUrl;
  }
}

function send(cmd, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type: 'fs-bg', cmd }, payload || {}), (r) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, err: chrome.runtime.lastError.message });
      resolve(r || { ok: false });
    });
  });
}

function readStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function writeStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ---- tab switcher ---------------------------------------------------------
document.querySelectorAll('.tab').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === el));
    const target = el.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === target));
    if (target === 'settings') refreshBackendStatus();
  });
});

// ---- main tab -------------------------------------------------------------
let appUrl = DEFAULTS.appUrl;

async function refreshConnection() {
  const cfg = await send('api.config');
  appUrl = await getAppUrl(cfg.baseUrl);

  if (!cfg.token) {
    setSignedOut();
    return;
  }
  const r = await send('api.request', { path: '/v1/me' });
  if (r.ok && r.body && r.body.id) setSignedIn(r.body);
  else if (r.status === 401) {
    setSignedOut();
    $('err').textContent = 'Session expired — please reconnect.';
  } else {
    setSignedOut();
    $('err').textContent = r.err || ('API ' + (r.status || '?'));
  }
}

async function getAppUrl(apiBaseUrl) {
  const stored = await readStorage([STORAGE_KEYS.appUrl]);
  return stored[STORAGE_KEYS.appUrl] || deriveAppUrl(apiBaseUrl);
}

function setSignedOut() {
  $('status').textContent = 'Not signed in';
  $('email').textContent = '';
  $('dot').className = 'dot';
  $('tier').style.display = 'none';
  $('sync').disabled = true;
  $('signin').textContent = 'Sign in / Connect';
}

function setSignedIn(me) {
  $('status').textContent = 'Connected';
  $('email').textContent = me.email || '';
  $('dot').className = 'dot on';
  $('tier').style.display = 'inline-block';
  $('tier').textContent = me.tier || 'free';
  $('tier').classList.toggle('pro', me.tier === 'pro' || me.tier === 'studio');
  $('sync').disabled = !(me.tier === 'pro' || me.tier === 'studio');
  $('signin').textContent = 'Reconnect';
  if ($('sync').disabled) {
    $('syncResult').textContent = 'Sync requires Pro. Upgrade in the web app.';
  }
}

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/index.html') });
  window.close();
});

const openOptionsBtn = document.getElementById('openOptions');
if (openOptionsBtn) {
  openOptionsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/options.html') });
    window.close();
  });
}

$('openWeb').addEventListener('click', () => {
  chrome.tabs.create({ url: appUrl });
  window.close();
});

$('signin').addEventListener('click', () => {
  chrome.tabs.create({ url: appUrl + '/connect' });
  window.close();
});

// Footer legal links — open the web app's Terms/Privacy pages in a new tab.
$('linkTerms').addEventListener('click', () => {
  chrome.tabs.create({ url: appUrl + '/terms' });
  window.close();
});
$('linkPrivacy').addEventListener('click', () => {
  chrome.tabs.create({ url: appUrl + '/privacy' });
  window.close();
});

$('sync').addEventListener('click', async () => {
  $('err').textContent = '';
  $('syncResult').textContent = 'Syncing…';
  $('sync').disabled = true;
  // Popup has no access to page IDB. Ask the active tab to sync from there.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) {
    $('syncResult').textContent = '';
    $('err').textContent = 'no active tab';
    $('sync').disabled = false;
    return;
  }
  const r = await new Promise((resolve) =>
    chrome.tabs.sendMessage(tabId, { type: 'fs-popup', cmd: 'sync-from-page' }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, err: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false });
    }),
  );
  $('sync').disabled = false;
  if (r.ok) {
    $('syncResult').textContent =
      'Synced ' + (r.inserted || 0) + ' / ' + (r.total || 0) +
      (r.dropped ? ' (' + r.dropped + ' dropped)' : '') +
      ' in ' + (r.batches || 0) + ' batches';
  } else {
    $('syncResult').textContent = '';
    $('err').textContent = r.err || 'sync failed (open an IG/TT/YT tab first)';
  }
});

// ---- settings tab ---------------------------------------------------------
async function loadSettings() {
  const stored = await readStorage([STORAGE_KEYS.apiBase, STORAGE_KEYS.appUrl]);
  $('apiBaseUrl').value = stored[STORAGE_KEYS.apiBase] || DEFAULTS.apiBase;
  $('appUrl').value = stored[STORAGE_KEYS.appUrl] || DEFAULTS.appUrl;
}

$('saveSettings').addEventListener('click', async () => {
  const apiBase = $('apiBaseUrl').value.trim() || DEFAULTS.apiBase;
  const appU = $('appUrl').value.trim() || DEFAULTS.appUrl;
  await writeStorage({ [STORAGE_KEYS.apiBase]: apiBase, [STORAGE_KEYS.appUrl]: appU });
  await send('api.set-base', { baseUrl: apiBase });
  $('saveStatus').textContent = '✓ saved';
  setTimeout(() => ($('saveStatus').textContent = ''), 2000);
  refreshConnection();
});

async function refreshBackendStatus() {
  const r = await send('api.request', { path: '/v1/me' });
  if (r.ok && r.body) {
    $('bsEngine').textContent = 'API ' + ((await send('api.config')).baseUrl || '?');
    $('bsTier').textContent = r.body.tier || '?';
  } else {
    $('bsTier').textContent = '(not signed in)';
  }
  // Health probe
  const cfg = await send('api.config');
  try {
    const res = await fetch((cfg.baseUrl || DEFAULTS.apiBase) + '/healthz', { credentials: 'omit' });
    $('bsTranscribe').textContent = res.ok ? 'reachable' : 'http ' + res.status;
  } catch (e) {
    $('bsTranscribe').textContent = 'unreachable';
  }
}

// ---- dev tab --------------------------------------------------------------
async function loadDev() {
  const stored = await readStorage([STORAGE_KEYS.groq, STORAGE_KEYS.openai, STORAGE_KEYS.whisperx]);
  $('groqKey').value = stored[STORAGE_KEYS.groq] || '';
  $('openaiKey').value = stored[STORAGE_KEYS.openai] || '';
  $('whisperxUrl').value = stored[STORAGE_KEYS.whisperx] || '';
}

$('saveDev').addEventListener('click', async () => {
  await writeStorage({
    [STORAGE_KEYS.groq]: $('groqKey').value.trim(),
    [STORAGE_KEYS.openai]: $('openaiKey').value.trim(),
    [STORAGE_KEYS.whisperx]: $('whisperxUrl').value.trim(),
  });
  $('saveDevStatus').textContent = '✓ saved';
  setTimeout(() => ($('saveDevStatus').textContent = ''), 2000);
});

$('clearDev').addEventListener('click', async () => {
  if (!confirm('Clear stored Groq / OpenAI / WhisperX values?')) return;
  await writeStorage({ [STORAGE_KEYS.groq]: '', [STORAGE_KEYS.openai]: '', [STORAGE_KEYS.whisperx]: '' });
  $('groqKey').value = '';
  $('openaiKey').value = '';
  $('whisperxUrl').value = '';
});

// ---- init -----------------------------------------------------------------
(async () => {
  await loadSettings();
  await loadDev();
  refreshConnection();
})();
