// Thin wrapper around `chat()` for use from content scripts.
//
// Routes the call through the MV3 service worker via chrome.runtime so the
// background page can centralize:
//   - rate-limiting / concurrency caps
//   - request logging
//   - cache lookup / write
//
// This module intentionally has no dependency on src/lib/llm.js so it can
// be loaded in classic-script content-script contexts. It just shapes the
// message and awaits the response.

(function attach(global) {
  const TAG = "[fs-llm-bridge]";
  const log = (level, event, data) => {
    if (typeof console === "undefined" || !console[level]) return;
    try { console[level](TAG, event, JSON.stringify(data || {})); }
    catch { console[level](TAG, event); }
  };

  const send = (kind, payload) => new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error("llm-bridge: chrome.runtime unavailable"));
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: kind, payload }, (resp) => {
        const lerr = chrome.runtime.lastError;
        if (lerr) {
          reject(new Error(String(lerr.message || lerr)));
          return;
        }
        if (!resp || resp.ok === false) {
          const e = new Error(String((resp && resp.err) || "no-response"));
          if (resp && resp.status) e.status = resp.status;
          reject(e);
          return;
        }
        resolve(resp.body);
      });
    } catch (e) { reject(e); }
  });

  // Fire an LLM chat call via the SW. Same shape as `chat()` in llm.js,
  // minus `signal` (chrome.runtime can't pass an AbortSignal cross-context).
  // To cancel, send `{cmd: "llm.cancel", payload: {requestId}}`.
  async function chat(payload) {
    const t0 = Date.now();
    try {
      const r = await send("llm.chat", payload || {});
      log("info", "bridge.chat.ok", {
        model: payload && payload.model,
        kind: payload && payload.kind,
        durationMs: r && r.durationMs,
        cached: !!(r && r.cached),
        ms: Date.now() - t0,
      });
      return r;
    } catch (e) {
      log("warn", "bridge.chat.fail", {
        kind: payload && payload.kind,
        err: String(e && e.message || e),
        ms: Date.now() - t0,
      });
      throw e;
    }
  }

  async function healthCheck(endpoint) {
    return send("llm.health", { endpoint });
  }

  async function clearCache() {
    return send("llm.clearCache", {});
  }

  global.__fsLlm = { chat, healthCheck, clearCache };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { chat, healthCheck, clearCache };
  }
})(typeof window !== "undefined" ? window : globalThis);
