// Local-only LLM client targeting Ollama (http://localhost:11434).
//
// Pure ES module — no chrome APIs, no DOM, no network state held globally.
// Safe to import from content scripts, the service worker, and unit tests.
//
// Contract (pinned for downstream tasks: rewrites, fingerprint, diagnostic,
// cover analysis):
//
//   chat({ endpoint, model, messages, schema, images, signal, options,
//          timeoutMs, fetchImpl, kind, postId }) -> Promise<{
//     text, json, tokensIn, tokensOut, durationMs, model, cached
//   }>
//
//   healthCheck(endpoint, { fetchImpl, signal, timeoutMs }) -> Promise<{
//     ok, models: string[], raw, durationMs
//   }>
//
// The helper streams Ollama's NDJSON `/api/chat` response, joining each
// `message.content` chunk into the final text. If a `schema` is provided,
// Ollama is asked to emit JSON matching that schema (`format` field, JSON
// Schema since Ollama 0.5+) and we parse the joined text into `.json`.
//
// `images` is an optional `string[]` of base64-encoded image data; per
// Ollama's native API, it gets attached to the LAST user message.

export const DEFAULT_ENDPOINT = "http://localhost:11434";
export const DEFAULT_MODEL = "gemma4";
export const DEFAULT_TIMEOUT_MS = 60_000;

const TAG = "[fs-llm]";
const log = (level, event, data) => {
  if (typeof console === "undefined" || !console[level]) return;
  try { console[level](TAG, event, JSON.stringify(data || {})); }
  catch { console[level](TAG, event); }
};

const trimEnd = (s) => String(s || "").replace(/\/+$/, "");

// Stable hash for cache keys. Not cryptographic — just a fast, deterministic
// digest over (model, schema, messages, images-fingerprints).
export const promptHash = (payload) => {
  const s = canonicalize(payload);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
};

const canonicalize = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
};

// Read an Ollama NDJSON stream from a fetch Response. Yields each parsed
// JSON object. Falls back to non-streaming if `body` is not a ReadableStream
// (some `fetchImpl` mocks return plain text).
async function* iterNdjson(resp) {
  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          try { yield JSON.parse(line); }
          catch { /* skip malformed line */ }
        }
      }
    }
    const tail = buf.trim();
    if (tail) {
      try { yield JSON.parse(tail); } catch { /* ignore */ }
    }
    return;
  }
  // Non-stream fallback: read text and split.
  const text = typeof resp.text === "function" ? await resp.text() : "";
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { yield JSON.parse(t); } catch { /* skip */ }
  }
}

// Apply `images` to the last user message in the OpenAI-style messages
// array, returning the Ollama-shaped messages array.
const attachImages = (messages, images) => {
  const out = (messages || []).map((m) => ({ ...m }));
  if (!images || !images.length) return out;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      out[i].images = images.slice();
      return out;
    }
  }
  // No user message found — append one with the images.
  out.push({ role: "user", content: "", images: images.slice() });
  return out;
};

export async function chat({
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  messages = [],
  schema = null,
  images = null,
  signal = null,
  options = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = null,
  kind = "generic",
  postId = null,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) throw new Error("llm.chat: no fetch implementation available");
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("llm.chat: messages[] required");
  }

  const url = trimEnd(endpoint) + "/api/chat";
  const body = {
    model,
    messages: attachImages(messages, images),
    stream: true,
  };
  if (schema) body.format = schema;
  if (options && typeof options === "object") body.options = options;

  // Wire up our own AbortController so we can both honor the caller's signal
  // AND impose a timeout. Linking is one-way (parent -> child).
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(new Error("aborted"));
  if (signal) {
    if (signal.aborted) ctrl.abort(new Error("aborted"));
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;

  const start = Date.now();
  log("info", "llm.call.start", { model, kind, postId, hasSchema: !!schema, hasImages: !!(images && images.length) });

  let resp;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    log("warn", "llm.call.fail", { kind, postId, err: String(e && e.message || e) });
    throw e;
  }

  if (!resp.ok) {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    let detail = "";
    try { detail = typeof resp.text === "function" ? await resp.text() : ""; } catch { /* ignore */ }
    const err = new Error(`llm.chat ${resp.status}: ${detail.slice(0, 200)}`);
    err.status = resp.status;
    log("warn", "llm.call.fail", { kind, postId, status: resp.status });
    throw err;
  }

  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let modelEcho = model;
  try {
    for await (const evt of iterNdjson(resp)) {
      if (evt.message && typeof evt.message.content === "string") {
        text += evt.message.content;
      }
      if (typeof evt.model === "string") modelEcho = evt.model;
      if (evt.done) {
        if (typeof evt.prompt_eval_count === "number") tokensIn = evt.prompt_eval_count;
        if (typeof evt.eval_count === "number") tokensOut = evt.eval_count;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }

  let json = null;
  if (schema) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      // Some models wrap JSON in ```json fences — try to recover.
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) {
        try { json = JSON.parse(m[1]); } catch { /* fall through */ }
      }
      if (!json) {
        log("warn", "llm.json.parse.fail", { kind, postId, sample: text.slice(0, 120) });
        const err = new Error("llm.chat: structured-output JSON parse failed");
        err.cause = e;
        err.text = text;
        throw err;
      }
    }
  }

  const durationMs = Date.now() - start;
  log("info", "llm.call.end", { model: modelEcho, kind, postId, durationMs, tokensIn, tokensOut, cached: false });

  return { text, json, tokensIn, tokensOut, durationMs, model: modelEcho, cached: false };
}

export async function healthCheck(endpoint = DEFAULT_ENDPOINT, {
  fetchImpl = null,
  signal = null,
  timeoutMs = 5_000,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) throw new Error("healthCheck: no fetch implementation available");
  const url = trimEnd(endpoint) + "/api/tags";

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new Error("aborted"));
  if (signal) {
    if (signal.aborted) ctrl.abort(new Error("aborted"));
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;

  const start = Date.now();
  let resp;
  try {
    resp = await fetchFn(url, { method: "GET", signal: ctrl.signal });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const durationMs = Date.now() - start;

  if (!resp.ok) {
    const err = new Error(`healthCheck: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const raw = typeof resp.json === "function" ? await resp.json() : JSON.parse(await resp.text());
  const models = Array.isArray(raw && raw.models)
    ? raw.models.map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean)
    : [];
  return { ok: true, models, raw, durationMs };
}
