// BYOK cloud-transcription tier: Groq Whisper-Large-v3-Turbo.
//
// No project-side proxy, no backend. The user pastes their own Groq API key
// into extension settings; we POST the audio straight to api.groq.com from
// the MV3 service worker.
//
// Pure ESM. The MV3 SW imports the IIFE mirror (transcribe-cloud-runtime.js).
// Tests target this file directly.

export const GROQ_BASE = "https://api.groq.com";
export const GROQ_MAX_BYTES = 25 * 1024 * 1024; // 25 MB free-tier upload cap.
export const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";

export const HF_BASE = "https://api-inference.huggingface.co";
export const HF_DEFAULT_MODEL = "openai/whisper-large-v3";
export const HF_MAX_LOADING_WAIT_S = 60; // hard cap on a single 503 retry wait.
export const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

/**
 * Transcribe a post's video via Groq Whisper.
 *
 * Cascade contract:
 *   - returns `null`             → caller should fall through to next tier
 *                                   (e.g. local Whisper sidecar). Triggered by
 *                                   missing key / missing video / 5xx /
 *                                   network error / video fetch failure.
 *   - returns `{ ok: true, ... }` → success, do not fall through.
 *   - returns `{ ok: false, err }` → terminal failure, do not fall through
 *                                   (e.g. rate-limit, payload too large).
 */
export async function transcribeWithGroq(post, opts = {}) {
  const {
    apiKey,
    fetchImpl,
    signal,
    language = "en",
    model = GROQ_DEFAULT_MODEL,
  } = opts;

  if (!apiKey) return null;
  if (!post || typeof post !== "object" || !post.videoUrl) return null;
  if (typeof fetchImpl !== "function") return null;

  // 1) Fetch the video bytes from the SW (no page CSP, no Referer leak).
  let buf;
  try {
    const vr = await fetchImpl(post.videoUrl, { credentials: "omit", signal });
    if (!vr || !vr.ok) return null;
    buf = await vr.arrayBuffer();
  } catch {
    return null;
  }
  const size = (buf && buf.byteLength) || 0;
  if (size > GROQ_MAX_BYTES) {
    return { ok: false, err: "video too large", bytes: size };
  }

  // 2) Build the multipart body. `audio.mp4` is fine — Groq sniffs the
  //    container itself; the filename only sets the multipart `filename=`.
  const blob = new Blob([buf], { type: "video/mp4" });
  const fd = new FormData();
  fd.append("file", blob, "audio.mp4");
  fd.append("model", String(model));
  fd.append("response_format", "json");
  fd.append("language", String(language));

  // 3) Hit the OpenAI-compatible endpoint.
  let res;
  try {
    res = await fetchImpl(`${GROQ_BASE}/openai/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal,
    });
  } catch {
    return null;
  }

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

  if (!res || !res.ok) {
    // 5xx / 4xx other than 429 — fall through to the next tier.
    return null;
  }

  let json;
  try { json = await res.json(); } catch { return null; }
  if (!json || typeof json.text !== "string") return null;
  return { ok: true, text: json.text, source: "groq-whisper" };
}

/**
 * Transcribe a post's video via HuggingFace Inference Providers (Whisper).
 *
 * Secondary cloud rung after Groq. Invoked only when:
 *   - groqRateLimited === true && fallbackOnRateLimit === true, OR
 *   - groqRateLimited is falsy (i.e. Groq key was empty / Groq not tried).
 *
 * Cascade contract:
 *   - returns `null`             → caller should fall through to the sidecar
 *                                   (missing key, gate failed, video fetch
 *                                   failed, HF still loading after one retry,
 *                                   or any non-2xx other than 503-with-eta).
 *   - returns `{ ok: true, ... }` → success, do not fall through.
 */
export async function transcribeWithHuggingFace(post, opts = {}) {
  const {
    apiKey,
    fetchImpl,
    signal,
    model = HF_DEFAULT_MODEL,
    groqRateLimited = false,
    fallbackOnRateLimit = false,
  } = opts;

  if (!apiKey) return null;
  // Gate: only run on rate-limit when the user explicitly opted in.
  if (groqRateLimited && !fallbackOnRateLimit) return null;
  if (!post || typeof post !== "object" || !post.videoUrl) return null;
  if (typeof fetchImpl !== "function") return null;

  // 1) Fetch the video bytes from the SW.
  let buf;
  try {
    const vr = await fetchImpl(post.videoUrl, { credentials: "omit", signal });
    if (!vr || !vr.ok) return null;
    buf = await vr.arrayBuffer();
  } catch {
    return null;
  }
  if (!buf || !buf.byteLength) return null;

  const url = `${HF_BASE}/models/${model}`;
  const doPost = async () => {
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "audio/mpeg",
        },
        body: buf,
        signal,
      });
    } catch {
      return null;
    }
  };

  // 2) First attempt.
  let res = await doPost();
  if (res && res.status === 503) {
    // Cold-start: HF returns { error, estimated_time } while the model loads.
    let eta = null;
    try {
      const j = await res.json();
      const n = Number(j && j.estimated_time);
      if (Number.isFinite(n) && n >= 0) eta = Math.min(n, HF_MAX_LOADING_WAIT_S);
    } catch { /* ignore */ }
    if (eta == null) return null;
    await new Promise((r) => setTimeout(r, Math.ceil(eta * 1000)));
    // 3) One retry after the estimated wait.
    res = await doPost();
  }

  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  if (!json || typeof json.text !== "string") return null;
  return { ok: true, text: json.text, source: "hf-whisper" };
}

/**
 * Lightweight key-validity probe for the HF settings UI.
 * GETs https://huggingface.co/api/whoami-v2 with the token.
 */
export async function testHuggingFaceKey(apiKey, opts = {}) {
  const { fetchImpl, signal } = opts;
  if (!apiKey) return { ok: false, err: "no-key" };
  if (typeof fetchImpl !== "function") return { ok: false, err: "no-fetch" };
  try {
    const res = await fetchImpl(HF_WHOAMI_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res || !res.ok) {
      return { ok: false, status: (res && res.status) || 0, err: `HTTP ${res && res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

/**
 * Lightweight key-validity probe for the settings UI.
 * GETs /openai/v1/models with the key. Returns { ok, status, err? }.
 */
export async function testGroqKey(apiKey, opts = {}) {
  const { fetchImpl, signal } = opts;
  if (!apiKey) return { ok: false, err: "no-key" };
  if (typeof fetchImpl !== "function") return { ok: false, err: "no-fetch" };
  try {
    const res = await fetchImpl(`${GROQ_BASE}/openai/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res || !res.ok) {
      return { ok: false, status: (res && res.status) || 0, err: `HTTP ${res && res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}
