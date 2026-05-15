// API client (ESM spec, used by tests and dashboard scripts).
// A parallel IIFE mirror lives in `api-client-runtime.js` for content scripts.

const DEFAULT_BASE = 'https://api.feedsorter.app';

export function createApiClient({ baseUrl = DEFAULT_BASE, fetchImpl = fetch, getToken } = {}) {
  async function authHeader() {
    if (!getToken) return {};
    const tok = await getToken();
    return tok ? { authorization: `Bearer ${tok}` } : {};
  }

  async function request(path, opts = {}) {
    const headers = {
      ...(await authHeader()),
      ...(opts.headers ?? {}),
    };
    if (opts.body && !(opts.body instanceof FormData) && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body:
        opts.body instanceof FormData
          ? opts.body
          : opts.body
            ? JSON.stringify(opts.body)
            : undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // leave json null
    }
    if (!res.ok) {
      const err = new Error(`API ${res.status} ${path}: ${json?.error ?? text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    requestMagicLink(email) {
      return request('/v1/auth/magic-link', { method: 'POST', body: { email } });
    },
    verifyToken(token) {
      return request('/v1/auth/verify', { method: 'POST', body: { token } });
    },
    me() {
      return request('/v1/me');
    },
    syncPosts(posts) {
      return request('/v1/posts/sync', { method: 'POST', body: { posts } });
    },
    transcribeFile(postId, file) {
      const fd = new FormData();
      fd.append('file', file);
      return request(`/v1/posts/${encodeURIComponent(postId)}/transcribe`, {
        method: 'POST',
        body: fd,
      });
    },
    transcribeText(postId, { text, source = 'youtube-captions', language, segments, durationS }) {
      return request(`/v1/posts/${encodeURIComponent(postId)}/transcribe`, {
        method: 'POST',
        body: { text, source, language, segments, durationS },
      });
    },
    library({ filter, sort, limit = 50, offset = 0 } = {}) {
      const params = new URLSearchParams();
      if (filter) params.set('filter', btoa(JSON.stringify(filter)).replace(/=+$/, ''));
      if (sort) params.set('sort', btoa(JSON.stringify(sort)).replace(/=+$/, ''));
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      return request(`/v1/library?${params.toString()}`);
    },
    checkout({ plan = 'pro' } = {}) {
      return request('/v1/billing/checkout', { method: 'POST', body: { plan } });
    },
    portal() {
      return request('/v1/billing/portal', { method: 'POST' });
    },
  };
}

export const FEEDSORTER_API_DEFAULT_BASE = DEFAULT_BASE;
