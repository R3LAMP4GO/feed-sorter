// Server-side API helper. Reads the session cookie from the incoming request
// and forwards it to the API on behalf of the user.
//
// On Railway, the API is at NEXT_PUBLIC_API_URL (e.g.
// https://api-production-xxxx.up.railway.app). We share cookies via parent
// domain when both services live under the same Railway parent — for prod we
// recommend custom domains (api.feedsorter.app + app.feedsorter.app) to make
// SameSite=Lax + Secure cookies work cleanly.

import { cookies } from 'next/headers';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://localhost:8787';

async function bearerHeader(): Promise<HeadersInit> {
  const c = await cookies();
  const token = c.get('session')?.value;
  return token ? { authorization: `Bearer ${token}`, cookie: `session=${token}` } : {};
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: await bearerHeader(),
    cache: 'no-store',
  });
  if (!res.ok) throw Object.assign(new Error(`api ${res.status}`), { status: res.status });
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { ...(await bearerHeader()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw Object.assign(new Error(`api ${res.status}`), { status: res.status });
  return res.json();
}

export const API_BASE_URL = API_BASE;
