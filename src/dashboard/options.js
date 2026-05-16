// Full-page settings (chrome `options_page`). Mirrors and extends the popup's
// Settings/Dev tabs at full size — Account, Backend, Transcription, LLM,
// Danger. All values persist in chrome.storage.local under fs.* keys; nothing
// is transmitted to the backend except the standard /v1/me probe.

const $ = (id) => document.getElementById(id);

const KEYS = {
  apiBase: 'fs.api.baseUrl',
  appUrl: 'fs.app.url',
  groq: 'fs.dev.groq_key',
  hf: 'fs.dev.hf_key',
  openai: 'fs.dev.openai_key',
  whisperx: 'fs.dev.whisperx_url',
  ollama: 'fs.dev.ollama_url',
};

const DEFAULTS = {
  apiBase: 'http://localhost:8787',
  appUrl: 'http://localhost:3000',
  whisperx: 'http://localhost:8788',
  ollama: 'http://localhost:11434',
};

function read(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function write(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function send(cmd, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type: 'fs-bg', cmd }, payload || {}), (r) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, err: chrome.runtime.lastError.message });
      resolve(r || { ok: false });
    });
  });
}

function deriveAppUrl(apiBaseUrl) {
  try {
    const u = new URL(apiBaseUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return 'http://' + u.hostname + ':3000';
    return DEFAULTS.appUrl;
  } catch (_) {
    return DEFAULTS.appUrl;
  }
}

function flash(elId, text, ms) {
  const el = $(elId);
  if (!el) return;
  el.textContent = text;
  setTimeout(() => (el.textContent = ''), ms || 2000);
}

function setPill(id, kind, text) {
  const el = $(id);
  if (!el) return;
  el.className = 'pill ' + kind;
  el.textContent = text;
}

// ---- Account --------------------------------------------------------------
let cachedAppUrl = DEFAULTS.appUrl;

async function refreshAccount() {
  $('acctErr').textContent = '';
  const cfg = await send('api.config');
  const stored = await read([KEYS.appUrl]);
  cachedAppUrl = stored[KEYS.appUrl] || deriveAppUrl(cfg.baseUrl || DEFAULTS.apiBase);

  if (!cfg.token) {
    $('acctStatus').textContent = 'Not signed in';
    $('acctEmail').textContent = '';
    $('acctTier').style.display = 'none';
    return;
  }
  const me = await send('api.request', { path: '/v1/me' });
  if (me.ok && me.body && me.body.id) {
    $('acctStatus').textContent = 'Connected';
    $('acctEmail').textContent = me.body.email || '';
    const tier = me.body.tier || 'free';
    $('acctTier').style.display = 'inline-block';
    $('acctTier').textContent = tier;
    $('acctTier').className = 'pill ' + (tier === 'pro' || tier === 'studio' ? tier : '');
    $('bsTier').textContent = tier;
    $('bsEmail').textContent = me.body.email || '';
  } else if (me.status === 401) {
    $('acctStatus').textContent = 'Not signed in';
    $('acctErr').textContent = 'Session expired — please reconnect.';
  } else {
    $('acctStatus').textContent = 'Not signed in';
    $('acctErr').textContent = me.err || ('API ' + (me.status || '?'));
  }
}

$('signin').addEventListener('click', () => chrome.tabs.create({ url: cachedAppUrl + '/connect' }));
$('openWeb').addEventListener('click', () => chrome.tabs.create({ url: cachedAppUrl }));

// ---- Backend --------------------------------------------------------------
async function loadBackend() {
  const stored = await read([KEYS.apiBase, KEYS.appUrl]);
  $('apiBaseUrl').value = stored[KEYS.apiBase] || DEFAULTS.apiBase;
  $('appUrl').value = stored[KEYS.appUrl] || '';
  await probeHealth();
}

async function probeHealth() {
  const cfg = await send('api.config');
  const base = cfg.baseUrl || DEFAULTS.apiBase;
  setPill('apiHealth', '', 'checking…');
  $('bsHealth').textContent = 'checking…';
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/healthz', { credentials: 'omit' });
    if (r.ok) {
      setPill('apiHealth', 'ok', 'reachable');
      $('bsHealth').textContent = 'reachable (200)';
    } else {
      setPill('apiHealth', 'warn', 'http ' + r.status);
      $('bsHealth').textContent = 'http ' + r.status;
    }
  } catch (e) {
    setPill('apiHealth', 'err', 'unreachable');
    $('bsHealth').textContent = 'unreachable';
  }
}

$('saveBackend').addEventListener('click', async () => {
  const apiBase = ($('apiBaseUrl').value.trim() || DEFAULTS.apiBase).replace(/\/+$/, '');
  const appU = $('appUrl').value.trim();
  await write({ [KEYS.apiBase]: apiBase, [KEYS.appUrl]: appU || deriveAppUrl(apiBase) });
  await send('api.set-base', { baseUrl: apiBase });
  flash('saveBackendStatus', '✓ saved');
  await refreshAccount();
  await probeHealth();
});

// ---- Transcription --------------------------------------------------------
async function loadTranscribe() {
  const stored = await read([KEYS.whisperx, KEYS.groq, KEYS.hf]);
  $('whisperxUrl').value = stored[KEYS.whisperx] || '';
  $('groqKey').value = stored[KEYS.groq] || '';
  $('hfKey').value = stored[KEYS.hf] || '';
  await probeWhisperx();
}

async function probeWhisperx() {
  const url = ($('whisperxUrl').value.trim() || '').replace(/\/+$/, '');
  if (!url) {
    setPill('whisperxHealth', '', 'not set');
    return;
  }
  setPill('whisperxHealth', '', 'checking…');
  try {
    const r = await fetch(url + '/healthz', { credentials: 'omit' });
    setPill('whisperxHealth', r.ok ? 'ok' : 'warn', r.ok ? 'reachable' : 'http ' + r.status);
  } catch (_) {
    setPill('whisperxHealth', 'err', 'unreachable');
  }
}

$('saveTranscribe').addEventListener('click', async () => {
  await write({
    [KEYS.whisperx]: $('whisperxUrl').value.trim(),
    [KEYS.groq]: $('groqKey').value.trim(),
    [KEYS.hf]: $('hfKey').value.trim(),
  });
  flash('saveTranscribeStatus', '✓ saved');
  await probeWhisperx();
});

$('testWhisperx').addEventListener('click', probeWhisperx);

// ---- LLM ------------------------------------------------------------------
async function loadLLM() {
  const stored = await read([KEYS.openai, KEYS.ollama]);
  $('openaiKey').value = stored[KEYS.openai] || '';
  $('ollamaUrl').value = stored[KEYS.ollama] || '';
}

$('saveLLM').addEventListener('click', async () => {
  await write({
    [KEYS.openai]: $('openaiKey').value.trim(),
    [KEYS.ollama]: $('ollamaUrl').value.trim(),
  });
  flash('saveLLMStatus', '✓ saved');
});

// ---- Danger ---------------------------------------------------------------
$('clearAll').addEventListener('click', async () => {
  if (!confirm('Clear stored Groq / HF / OpenAI / WhisperX / Ollama values?')) return;
  await write({
    [KEYS.groq]: '',
    [KEYS.hf]: '',
    [KEYS.openai]: '',
    [KEYS.whisperx]: '',
    [KEYS.ollama]: '',
  });
  await loadTranscribe();
  await loadLLM();
});

// ---- Init -----------------------------------------------------------------
(async () => {
  await loadBackend();
  await loadTranscribe();
  await loadLLM();
  await refreshAccount();
})();
