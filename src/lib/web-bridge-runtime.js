// Content script that runs on the Feed Sorter web app origin.
// Catches the token handoff from /login/callback (and /connect) and stores
// it in extension storage via the SW `api.set-token` handler.
//
// The web app posts:
//   window.postMessage(
//     { source: 'feedsorter-web', kind: 'session', token, baseUrl },
//     window.location.origin
//   )
//
// We only accept messages whose `event.source === window` AND `event.origin`
// matches the page we're injected into — same-origin only, no eavesdropping.

(function () {
  if (globalThis.__feedSorterWebBridge) return;
  globalThis.__feedSorterWebBridge = true;

  const PAGE_ORIGIN = window.location.origin;

  function send(cmd, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'fs-bg', cmd, ...payload }, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, err: chrome.runtime.lastError.message });
            return;
          }
          resolve(r || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, err: String(e && e.message || e) });
      }
    });
  }

  function reply(replyTo, payload) {
    if (!replyTo) return;
    window.postMessage({ source: 'feedsorter-ext', kind: 'reply', replyTo, ...payload }, PAGE_ORIGIN);
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    if (ev.origin !== PAGE_ORIGIN) return;
    const d = ev.data;
    if (!d || d.source !== 'feedsorter-web') return;

    if (d.kind === 'session' && typeof d.token === 'string') {
      if (typeof d.baseUrl === 'string' && d.baseUrl) {
        await send('api.set-base', { baseUrl: d.baseUrl });
      }
      const r = await send('api.set-token', { token: d.token });
      reply(d.replyTo, r);
    } else if (d.kind === 'logout') {
      const r = await send('api.set-token', { token: null });
      reply(d.replyTo, r);
    } else if (d.kind === 'ping') {
      reply(d.replyTo, { ok: true, present: true });
    }
  });

  // Announce presence so the website can show a "Connected" badge.
  // The web app listens for { source:'feedsorter-ext', kind:'present' }.
  window.postMessage({ source: 'feedsorter-ext', kind: 'present' }, PAGE_ORIGIN);
})();
