// IIFE mirror of src/lib/api-client.js for use in content scripts.
// Exposes window.FeedSorterApiClient = createApiClient(opts).
//
// Keep this file in lock-step with `api-client.js`.

(function () {
  const DEFAULT_BASE = 'https://api.feedsorter.app';

  function createApiClient(opts) {
    const baseUrl = (opts && opts.baseUrl) || DEFAULT_BASE;
    const fetchImpl = (opts && opts.fetchImpl) || fetch;
    const getToken = opts && opts.getToken;

    async function authHeader() {
      if (!getToken) return {};
      const tok = await getToken();
      return tok ? { authorization: 'Bearer ' + tok } : {};
    }

    async function request(path, options) {
      options = options || {};
      const headers = Object.assign({}, await authHeader(), options.headers || {});
      if (options.body && !(options.body instanceof FormData) && !headers['content-type']) {
        headers['content-type'] = 'application/json';
      }
      const res = await fetchImpl(baseUrl + path, {
        method: options.method || 'GET',
        headers,
        body:
          options.body instanceof FormData
            ? options.body
            : options.body
              ? JSON.stringify(options.body)
              : undefined,
        credentials: 'include',
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {}
      if (!res.ok) {
        const err = new Error('API ' + res.status + ' ' + path + ': ' + ((json && json.error) || text));
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
        return request('/v1/posts/' + encodeURIComponent(postId) + '/transcribe', {
          method: 'POST',
          body: fd,
        });
      },
      transcribeText(postId, payload) {
        return request('/v1/posts/' + encodeURIComponent(postId) + '/transcribe', {
          method: 'POST',
          body: Object.assign({ source: 'youtube-captions' }, payload),
        });
      },
    };
  }

  globalThis.FeedSorterApiClient = { createApiClient, DEFAULT_BASE };
})();
