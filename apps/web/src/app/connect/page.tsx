'use client';

// /connect — bridges the current session into the extension.
//
// Behavior:
//   1. Page-load: ping the extension via window.postMessage. If the bridge
//      content script is loaded (extension installed), it postMessages back
//      `{ source: 'feedsorter-ext', kind: 'present' }`.
//   2. On click "Connect extension", read the JWT from the cookie (or fall
//      back to fetching /v1/me which we know works because middleware lets
//      us land here) and postMessage `{ source: 'feedsorter-web', kind:
//      'session', token, baseUrl }`.
//   3. The extension content script forwards to the SW which persists in
//      chrome.storage.local. Reply event flips the UI to "Connected".

import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL_CLIENT } from '@/lib/api-client';

type ExtState = 'unknown' | 'present' | 'connected' | 'absent';

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export default function ConnectPage() {
  const [extState, setExtState] = useState<ExtState>('unknown');
  const [error, setError] = useState<string | null>(null);

  // Track which replyTo ids belong to a session-handoff vs a ping, so a
  // ping reply doesn't flip the UI to "Connected" prematurely.
  const sessionReplyIds = useRef(new Set<string>());

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as { source?: string; kind?: string; replyTo?: string; ok?: boolean };
      if (!d || d.source !== 'feedsorter-ext') return;
      if (d.kind === 'present') {
        setExtState((s) => (s === 'connected' ? s : 'present'));
        return;
      }
      if (d.kind === 'reply') {
        if (d.replyTo && sessionReplyIds.current.has(d.replyTo)) {
          sessionReplyIds.current.delete(d.replyTo);
          if (d.ok) setExtState('connected');
          else setError('Extension rejected the token.');
        } else {
          // Ping reply — only confirms the bridge is alive.
          setExtState((s) => (s === 'connected' ? s : 'present'));
        }
      }
    };
    window.addEventListener('message', onMsg);

    // Ping with replyTo so we know if the bridge is active even after
    // its initial 'present' broadcast.
    const replyTo = 'ping-' + Math.random().toString(36).slice(2);
    window.postMessage({ source: 'feedsorter-web', kind: 'ping', replyTo }, window.location.origin);

    const t = setTimeout(() => {
      setExtState((s) => (s === 'unknown' ? 'absent' : s));
    }, 1500);

    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(t);
    };
  }, []);

  function connect() {
    setError(null);
    const token = readCookie('session') ?? window.localStorage.getItem('fs.session.token');
    if (!token) {
      setError('No session found. Sign in first, then reopen this page in the same browser profile as the extension.');
      return;
    }
    const replyTo = 'connect-' + Math.random().toString(36).slice(2);
    sessionReplyIds.current.add(replyTo);
    window.postMessage(
      {
        source: 'feedsorter-web',
        kind: 'session',
        token,
        baseUrl: API_BASE_URL_CLIENT,
        replyTo,
      },
      window.location.origin,
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-12">
      <h1 className="text-2xl font-semibold mb-2">Connect your browser extension</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Hand off your sign-in to the Feed Sorter extension so captured posts can sync here.
      </p>

      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center gap-3">
          <Dot state={extState} />
          <div className="text-sm">
            {extState === 'unknown' && 'Looking for extension…'}
            {extState === 'absent' && (
              <>
                Extension not detected on this page.
                <div className="text-xs text-zinc-500 mt-1">
                  Install the unpacked extension and reload.
                </div>
              </>
            )}
            {extState === 'present' && 'Extension detected — not yet connected.'}
            {extState === 'connected' && 'Connected. You can close this tab.'}
          </div>
        </div>

        <button
          onClick={connect}
          disabled={extState !== 'present' && extState !== 'connected'}
          className="mt-4 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium"
        >
          {extState === 'connected' ? 'Reconnect' : 'Connect extension'}
        </button>

        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
      </div>
    </div>
  );
}

function Dot({ state }: { state: ExtState }) {
  const cls =
    state === 'connected'
      ? 'bg-emerald-500'
      : state === 'present'
        ? 'bg-amber-400'
        : state === 'absent'
          ? 'bg-zinc-600'
          : 'bg-zinc-400 animate-pulse';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />;
}
