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

// Groq (cloud, BYOK). OpenAI-compatible chat-completions endpoint.
export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODELS_ENDPOINT = "https://api.groq.com/openai/v1/models";
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_GROQ_FAST_MODEL = "llama-3.1-8b-instant";

// Per-post / batch-tier kinds. These get routed to the cheap+fast model on
// Groq. Anything not in this set goes to the main model. The set is exported
// so callers can extend it if they introduce new lightweight kinds.
export const FAST_KINDS = new Set([
  "hook",
  "topic",
  "hookType",
  "per-post-analysis",
  "niche-label",
]);

export const isFastKind = (kind) => FAST_KINDS.has(String(kind || ""));

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
  return (`00000000${(h >>> 0).toString(16)}`).slice(-8);
};

const canonicalize = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
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

// Pick the provider for an outgoing call. Explicit `provider` wins; otherwise
// auto-select: an `apiKey` implies Groq, an `endpoint` (or nothing) implies
// Ollama. This matches the settings flow — pasting a Groq key flips the
// default; clearing it falls back to local Ollama.
export const pickProvider = ({ provider, apiKey, endpoint } = {}) => {
  if (provider === "groq" || provider === "ollama") return provider;
  if (apiKey && String(apiKey).trim()) return "groq";
  if (endpoint) return "ollama";
  return "ollama";
};

export async function chat(opts = {}) {
  const provider = pickProvider(opts);
  if (provider === "groq") return chatGroq(opts);
  return chatOllama(opts);
}

async function chatOllama({
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

  const url = `${trimEnd(endpoint)}/api/chat`;
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
  log("info", "llm.call.start", { model, kind, postId, hasSchema: !!schema, hasImages: !!(images?.length) });

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
    log("warn", "llm.call.fail", { kind, postId, err: String(e?.message || e) });
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

// Groq (OpenAI-compatible /chat/completions). No NDJSON streaming — we use a
// plain JSON response. JSON-mode is enabled with `response_format` when a
// schema is provided; the schema itself is descriptive (the prompt is
// expected to spell out the shape, same as the Ollama path).
async function chatGroq({
  apiKey = null,
  model = DEFAULT_GROQ_MODEL,
  fastModel = DEFAULT_GROQ_FAST_MODEL,
  messages = [],
  schema = null,
  images = null,           // currently unused on Groq path; kept for API parity
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
  const key = String(apiKey || "").trim();
  if (!key) {
    const err = new Error("llm.chat: groq provider requires apiKey");
    err.kind = "config";
    throw err;
  }

  const useModel = isFastKind(kind)
    ? (fastModel || DEFAULT_GROQ_FAST_MODEL)
    : (model || DEFAULT_GROQ_MODEL);

  const body = {
    model: useModel,
    messages,
    stream: false,
  };
  if (schema) body.response_format = { type: "json_object" };
  if (options && typeof options === "object") {
    if (typeof options.temperature === "number") body.temperature = options.temperature;
    if (typeof options.top_p === "number") body.top_p = options.top_p;
    if (typeof options.max_tokens === "number") body.max_tokens = options.max_tokens;
    if (typeof options.num_predict === "number" && body.max_tokens == null) {
      body.max_tokens = options.num_predict;
    }
  }

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
  log("info", "llm.call.start", { provider: "groq", model: useModel, kind, postId, hasSchema: !!schema });

  let resp;
  try {
    resp = await fetchFn(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    log("warn", "llm.call.fail", { provider: "groq", kind, postId, err: String(e?.message || e) });
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }

  if (!resp.ok) {
    let detail = "";
    try { detail = typeof resp.text === "function" ? await resp.text() : ""; } catch { /* ignore */ }
    if (resp.status === 429) {
      const err = new Error(`groq: rate limited${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      err.status = 429;
      err.kind = "rate-limit";
      err.provider = "groq";
      err.detail = detail;
      // Surface Retry-After when present (string seconds or HTTP-date).
      try {
        const ra = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("retry-after") : null;
        if (ra) err.retryAfter = ra;
      } catch { /* ignore */ }
      log("warn", "llm.call.fail", { provider: "groq", kind, postId, status: 429 });
      throw err;
    }
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error(`groq: auth failed (${resp.status})`);
      err.status = resp.status;
      err.kind = "auth";
      err.provider = "groq";
      throw err;
    }
    const err = new Error(`llm.chat ${resp.status}: ${String(detail).slice(0, 200)}`);
    err.status = resp.status;
    err.provider = "groq";
    log("warn", "llm.call.fail", { provider: "groq", kind, postId, status: resp.status });
    throw err;
  }

  const raw = typeof resp.json === "function" ? await resp.json() : JSON.parse(await resp.text());
  const choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
  const text = (choice?.message && typeof choice.message.content === "string")
    ? choice.message.content : "";
  const tokensIn = (raw?.usage && Number(raw.usage.prompt_tokens)) || 0;
  const tokensOut = (raw?.usage && Number(raw.usage.completion_tokens)) || 0;
  const modelEcho = (raw && typeof raw.model === "string") ? raw.model : useModel;

  let json = null;
  if (schema) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) {
        try { json = JSON.parse(m[1]); } catch { /* fall through */ }
      }
      if (!json) {
        log("warn", "llm.json.parse.fail", { provider: "groq", kind, postId, sample: text.slice(0, 120) });
        const err = new Error("llm.chat: structured-output JSON parse failed");
        err.cause = e;
        err.text = text;
        throw err;
      }
    }
  }

  const durationMs = Date.now() - start;
  log("info", "llm.call.end", { provider: "groq", model: modelEcho, kind, postId, durationMs, tokensIn, tokensOut, cached: false });
  return { text, json, tokensIn, tokensOut, durationMs, model: modelEcho, cached: false };
}

// List Groq models — used to populate the settings-panel dropdowns. Cached
// by the caller (content.js stores `state.ai.groq.modelsCache` for 1h).
export async function listGroqModels({
  apiKey,
  fetchImpl = null,
  signal = null,
  timeoutMs = 8_000,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) throw new Error("listGroqModels: no fetch implementation available");
  const key = String(apiKey || "").trim();
  if (!key) {
    const err = new Error("listGroqModels: apiKey required");
    err.kind = "config";
    throw err;
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new Error("aborted"));
  if (signal) {
    if (signal.aborted) ctrl.abort(new Error("aborted"));
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;
  let resp;
  try {
    resp = await fetchFn(GROQ_MODELS_ENDPOINT, {
      method: "GET",
      headers: { "Authorization": `Bearer ${key}` },
      signal: ctrl.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (!resp.ok) {
    const err = new Error(`listGroqModels: ${resp.status}`);
    err.status = resp.status;
    if (resp.status === 401 || resp.status === 403) err.kind = "auth";
    throw err;
  }
  const raw = typeof resp.json === "function" ? await resp.json() : JSON.parse(await resp.text());
  const ids = Array.isArray(raw?.data)
    ? raw.data.map((m) => (m && typeof m.id === "string" ? m.id : null)).filter(Boolean)
    : [];
  return { ok: true, models: ids, raw };
}

// Provider-aware health check. Routes to the right backend based on
// `provider` (or auto-detected from apiKey/endpoint). Returns a uniform
// shape: { ok, provider, models: string[], raw, durationMs }.
export async function healthCheck(arg1, arg2) {
  // Back-compat: healthCheck(endpoint, opts) targets Ollama.
  let opts;
  if (typeof arg1 === "string" || typeof arg1 === "undefined" || arg1 === null) {
    opts = { ...(arg2 || {}), endpoint: arg1 || DEFAULT_ENDPOINT };
  } else {
    opts = arg1 || {};
  }
  const provider = pickProvider(opts);
  if (provider === "groq") {
    const start = Date.now();
    const r = await listGroqModels(opts);
    return {
      ok: true,
      provider: "groq",
      models: r.models,
      raw: r.raw,
      durationMs: Date.now() - start,
    };
  }
  const r = await ollamaHealthCheck(opts.endpoint || DEFAULT_ENDPOINT, opts);
  return { ...r, provider: "ollama" };
}

async function ollamaHealthCheck(endpoint = DEFAULT_ENDPOINT, {
  fetchImpl = null,
  signal = null,
  timeoutMs = 5_000,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) throw new Error("healthCheck: no fetch implementation available");
  const url = `${trimEnd(endpoint)}/api/tags`;

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
  const models = Array.isArray(raw?.models)
    ? raw.models.map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean)
    : [];
  return { ok: true, models, raw, durationMs };
}
