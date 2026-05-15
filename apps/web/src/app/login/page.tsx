'use client';

import { useState } from 'react';
import { API_BASE_URL_CLIENT } from '@/lib/api-client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL_CLIENT}/v1/auth/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setStatus('sent');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-2xl font-semibold mb-2">Sign in</h1>
      <p className="text-sm text-zinc-400 mb-6">
        We&apos;ll email you a one-tap sign-in link.
      </p>
      {status === 'sent' ? (
        <div className="rounded border border-emerald-700 bg-emerald-950/40 p-4 text-sm">
          Link sent. Check your inbox — it expires in 15 minutes.
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600"
          />
          <button
            type="submit"
            disabled={status === 'sending'}
            className="w-full rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
          >
            {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </form>
      )}
      <p className="text-xs text-zinc-500 mt-6 leading-relaxed">
        By signing in, you agree to our{' '}
        <a href="/terms" className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
          Terms
        </a>{' '}
        and{' '}
        <a href="/privacy" className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}
