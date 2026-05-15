// IIFE mirror of src/lib/transcribe-cloud.js for the MV3 service worker
// (importScripts) and content scripts. Keep in lock-step with the ESM spec.
//
// Exposes globalThis.__fsTranscribeCloud = {
//   GROQ_BASE, GROQ_MAX_BYTES, GROQ_DEFAULT_MODEL,
//   transcribeWithGroq, testGroqKey,
// }.

(function (root) {
  const GROQ_BASE = "https://api.groq.com";
  const GROQ_MAX_BYTES = 25 * 1024 * 1024;
  const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";
  const HF_BASE = "https://api-inference.huggingface.co";
  const HF_DEFAULT_MODEL = "openai/whisper-large-v3";
  const HF_MAX_LOADING_WAIT_S = 60;
  const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

  async function transcribeWithGroq(post, opts) {
    const o = opts || {};
    const apiKey = o.apiKey;
    const fetchImpl = o.fetchImpl;
    const signal = o.signal;
    const language = o.language || "en";
    const model = o.model || GROQ_DEFAULT_MODEL;

    if (!apiKey) return null;
    if (!post || typeof post !== "object" || !post.videoUrl) return null;
    if (typeof fetchImpl !== "function") return null;

    let buf;
    try {
      const vr = await fetchImpl(post.videoUrl, { credentials: "omit", signal });
      if (!vr || !vr.ok) return null;
      buf = await vr.arrayBuffer();
    } catch { return null; }
    const size = (buf && buf.byteLength) || 0;
    if (size > GROQ_MAX_BYTES) return { ok: false, err: "video too large", bytes: size };

    const blob = new Blob([buf], { type: "video/mp4" });
    const fd = new FormData();
    fd.append("file", blob, "audio.mp4");
    fd.append("model", String(model));
    fd.append("response_format", "json");
    fd.append("language", String(language));

    let res;
    try {
      res = await fetchImpl(GROQ_BASE + "/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey },
        body: fd,
        signal,
      });
    } catch { return null; }

    if (res && res.status === 429) {
      let retryAfter = null;
      try {
        const h = res.headers && (res.headers.get
          ? res.headers.get("retry-after")
          : res.headers["retry-after"]);
        if (h != null) {
          const n = Number(h);
          retryAfter = Number.isFinite(n) ? n : null;
        }
      } catch { /* ignore */ }
      return { ok: false, err: "groq-rate-limit", retryAfter };
    }

    if (!res || !res.ok) return null;

    let json;
    try { json = await res.json(); } catch { return null; }
    if (!json || typeof json.text !== "string") return null;
    return { ok: true, text: json.text, source: "groq-whisper" };
  }

  async function testGroqKey(apiKey, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl;
    const signal = o.signal;
    if (!apiKey) return { ok: false, err: "no-key" };
    if (typeof fetchImpl !== "function") return { ok: false, err: "no-fetch" };
    try {
      const res = await fetchImpl(GROQ_BASE + "/openai/v1/models", {
        method: "GET",
        headers: { Authorization: "Bearer " + apiKey },
        signal,
      });
      if (!res || !res.ok) {
        return { ok: false, status: (res && res.status) || 0, err: "HTTP " + (res && res.status) };
      }
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  }

  async function transcribeWithHuggingFace(post, opts) {
    const o = opts || {};
    const apiKey = o.apiKey;
    const fetchImpl = o.fetchImpl;
    const signal = o.signal;
    const model = o.model || HF_DEFAULT_MODEL;
    const groqRateLimited = !!o.groqRateLimited;
    const fallbackOnRateLimit = !!o.fallbackOnRateLimit;

    if (!apiKey) return null;
    if (groqRateLimited && !fallbackOnRateLimit) return null;
    if (!post || typeof post !== "object" || !post.videoUrl) return null;
    if (typeof fetchImpl !== "function") return null;

    let buf;
    try {
      const vr = await fetchImpl(post.videoUrl, { credentials: "omit", signal });
      if (!vr || !vr.ok) return null;
      buf = await vr.arrayBuffer();
    } catch { return null; }
    if (!buf || !buf.byteLength) return null;

    const url = HF_BASE + "/models/" + model;
    const doPost = async () => {
      try {
        return await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "audio/mpeg",
          },
          body: buf,
          signal,
        });
      } catch { return null; }
    };

    let res = await doPost();
    if (res && res.status === 503) {
      let eta = null;
      try {
        const j = await res.json();
        const n = Number(j && j.estimated_time);
        if (Number.isFinite(n) && n >= 0) eta = Math.min(n, HF_MAX_LOADING_WAIT_S);
      } catch { /* ignore */ }
      if (eta == null) return null;
      await new Promise((r) => setTimeout(r, Math.ceil(eta * 1000)));
      res = await doPost();
    }

    if (!res || !res.ok) return null;
    let json;
    try { json = await res.json(); } catch { return null; }
    if (!json || typeof json.text !== "string") return null;
    return { ok: true, text: json.text, source: "hf-whisper" };
  }

  async function testHuggingFaceKey(apiKey, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl;
    const signal = o.signal;
    if (!apiKey) return { ok: false, err: "no-key" };
    if (typeof fetchImpl !== "function") return { ok: false, err: "no-fetch" };
    try {
      const res = await fetchImpl(HF_WHOAMI_URL, {
        method: "GET",
        headers: { Authorization: "Bearer " + apiKey },
        signal,
      });
      if (!res || !res.ok) {
        return { ok: false, status: (res && res.status) || 0, err: "HTTP " + (res && res.status) };
      }
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  }

  root.__fsTranscribeCloud = {
    GROQ_BASE,
    GROQ_MAX_BYTES,
    GROQ_DEFAULT_MODEL,
    HF_BASE,
    HF_DEFAULT_MODEL,
    HF_WHOAMI_URL,
    transcribeWithGroq,
    testGroqKey,
    transcribeWithHuggingFace,
    testHuggingFaceKey,
  };
})(typeof self !== "undefined" ? self : this);
