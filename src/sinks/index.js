// Sink registry + shared HTTP helper. Loads as a content script before the
// individual sink files. Exposes `window.__fsSinks` with:
//
//   sinks: { sheets, airtable, notion }       (filled by sink files)
//   register(sink)                             (called by sink files)
//   mapPost(p) -> slim row                     (mirrors content.js slimPost)
//   RateLimiter(rps)                           (exponential backoff on 429/5xx)
//   chunk(arr, n)                              (utility)
//   post({url, method, headers, body})         (routed via background SW to
//                                               escape IG's CSP + omit creds)
//
// Each registered sink implements the contract:
//   { name: string,
//     test:  async (cfg)                      -> { ok, msg, status? }
//     push:  async (rows, cfg, onProgress)    -> { ok, sent, failed, errors } }

(() => {
  if (window.__fsSinks) return;

  const mapPost = (p) => ({
    id: String(p.id || ""),
    shortcode: String(p.shortcode || ""),
    author: String(p.author || ""),
    desc: String(p.desc || "").slice(0, 1000),
    createTime: Number(p.createTime || 0),
    createdISO: p.createTime ? new Date(p.createTime * 1000).toISOString() : "",
    surface: String(p.surface || ""),
    likes: Number(p.likes || 0),
    views: Number(p.views || 0),
    comments: Number(p.comments || 0),
    score: Number(p._score || p.score || 0),
    url: String(p.url || ""),
    cover: String(p.cover || ""),
    videoUrl: String(p.videoUrl || ""),
  });

  class RateLimiter {
    constructor(rps = 5) {
      this.minIntervalMs = Math.max(1, Math.floor(1000 / rps));
      this._next = 0;
    }
    async wait() {
      const now = Date.now();
      const slot = Math.max(now, this._next);
      this._next = slot + this.minIntervalMs;
      const delay = slot - now;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    async runWithBackoff(fn, { attempts = 4, baseMs = 500 } = {}) {
      let last = null;
      for (let i = 0; i < attempts; i++) {
        await this.wait();
        const r = await fn();
        if (r?.ok) return r;
        const s = (r?.status) || 0;
        const transient = s === 429 || (s >= 500 && s < 600) || s === 0;
        last = r;
        if (!transient) return r;
        const ra = r?.retryAfter ? Number(r.retryAfter) * 1000 : 0;
        const backoff = Math.max(ra, baseMs * 2 ** i);
        await new Promise((res) => setTimeout(res, backoff));
      }
      return last || { ok: false, status: 0, err: "exhausted" };
    }
  }

  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  /** Route HTTP through the background SW. Returns {ok,status,text,json,err,retryAfter}. */
  const post = ({ url, method = "POST", headers = {}, body = null }) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fs-bg", cmd: "sink-post", url, method, headers, body },
          (resp) => {
            const lerr = chrome.runtime.lastError;
            if (lerr || !resp) {
              return resolve({ ok: false, status: 0, err: String(lerr?.message || "no-response") });
            }
            resolve(resp);
          },
        );
      } catch (e) {
        resolve({ ok: false, status: 0, err: String(e) });
      }
    });

  const sinks = Object.create(null);
  const register = (sink) => {
    if (!sink || !sink.name) throw new Error("sink missing name");
    sinks[sink.name] = sink;
  };

  window.__fsSinks = {
    sinks,
    register,
    mapPost,
    RateLimiter,
    chunk,
    post,
  };
})();
