'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_BASE_URL_CLIENT } from '@/lib/api-client';

export default function CallbackPage() {
  return (
    <Suspense fallback={<div className="max-w-sm mx-auto mt-16 text-sm text-zinc-400">Loading…</div>}>
      <CallbackInner />
    </Suspense>
  );
}

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    const next = params.get('next') ?? '/library';
    if (!token) {
      setError('Missing token');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL_CLIENT}/v1/auth/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error(`verify ${res.status}`);
        // The API set the cookie on its origin. For cross-origin dev, also stash
        // the bearer in localStorage so subsequent client-side calls work.
        const json = (await res.json()) as { token?: string };
        if (json.token) {
          // Mirror cookie into web app's session cookie (same origin or via parent domain)
          document.cookie = `session=${json.token}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
          // Hand the token off to the extension if installed. The web-bridge
          // content script (src/lib/web-bridge-runtime.js) listens for this.
          window.postMessage(
            {
              source: 'feedsorter-web',
              kind: 'session',
              token: json.token,
              baseUrl: API_BASE_URL_CLIENT,
            },
            window.location.origin,
          );
        }
        router.replace(next);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [params, router]);

  return (
    <div className="max-w-sm mx-auto mt-16 text-sm">
      {error ? (
        <div className="text-red-400">Sign-in failed: {error}</div>
      ) : (
        <div className="text-zinc-400">Signing you in…</div>
      )}
    </div>
  );
}
