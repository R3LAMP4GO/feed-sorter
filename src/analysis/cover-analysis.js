// Per-post cover-image vision classification via local multimodal Gemma.
//
// One `chat()` call with the cover image attached + a structured-output
// schema asking the model to classify low-level cover features (faces,
// text overlay, composition) so we can later cross-tab those features
// against the post's outlier score.
//
// Pure ES module — no chrome APIs, no DOM. Caller injects:
//   - `chat`        : same shape as src/lib/llm.js chat()
//   - `fetchImpl`   : optional, defaults to globalThis.fetch
//   - `persist`     : optional async (id, coverAi) → void
//   - `cache`       : optional Map | { get, set, has } keyed by
//                     `${model}:${promptHash}` where promptHash includes
//                     the cover URL — same rule as task c7de9bca.
//   - `model`       : vision model id (defaults to "gemma4")
//   - `signal`      : optional AbortSignal
//
// Returns the persisted classification: {
//   hasFace, faceCount, expression, hasTextOverlay, textContent,
//   dominantColor, composition, analyzedAt, model, cached
// }

import { promptHash } from "../lib/llm.js";

export const DEFAULT_VISION_MODEL = "gemma4";

export const COVER_EXPRESSIONS = [
  "happy", "serious", "surprised", "neutral", "other", "none",
];
export const COVER_COMPOSITIONS = [
  "closeup", "wide", "split", "text-heavy", "product", "other",
];

export const COVER_SCHEMA = {
  type: "object",
  properties: {
    hasFace: { type: "boolean" },
    faceCount: { type: "integer", minimum: 0 },
    expression: { type: "string", enum: COVER_EXPRESSIONS },
    hasTextOverlay: { type: "boolean" },
    textContent: { type: ["string", "null"] },
    dominantColor: { type: "string" },
    composition: { type: "string", enum: COVER_COMPOSITIONS },
  },
  required: [
    "hasFace", "faceCount", "expression",
    "hasTextOverlay", "textContent", "dominantColor", "composition",
  ],
};

const COVER_SYSTEM = [
  "You are a cover-image classifier for short-form-video thumbnails.",
  "You are shown ONE cover frame. Return strict JSON matching the schema.",
  "No commentary, no markdown fences.",
  "",
  "Field rules:",
  "  hasFace          — true if at least one human face is clearly visible.",
  "  faceCount        — integer count of distinct faces (0 if hasFace=false).",
  "  expression       — dominant facial expression of the most prominent",
  "                     face: 'happy' | 'serious' | 'surprised' |",
  "                     'neutral' | 'other' | 'none' (use 'none' when no face).",
  "  hasTextOverlay   — true if there is significant graphic text burned",
  "                     into the image (NOT the IG caption — the cover itself).",
  "  textContent      — verbatim text overlay (≤80 chars) or null when absent.",
  "  dominantColor    — single short color name (e.g. 'red', 'navy', 'beige').",
  "  composition      — 'closeup' (face/object fills frame) | 'wide' (scene) |",
  "                     'split' (before/after or side-by-side) | 'text-heavy'",
  "                     (text dominates) | 'product' (single object on plain",
  "                     background) | 'other'.",
].join("\n");

// ------------------------------------------------------------------
// Helpers (pure, exported for testing)
// ------------------------------------------------------------------

// Convert a Blob to a base64 string (no data: prefix — Ollama wants raw b64).
export const blobToBase64 = async (blob) => {
  if (!blob) throw new Error("blobToBase64: blob required");
  if (typeof Buffer !== "undefined" && typeof blob.arrayBuffer === "function") {
    const buf = Buffer.from(await blob.arrayBuffer());
    return buf.toString("base64");
  }
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.onload = () => {
      const s = String(r.result || "");
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.readAsDataURL(blob);
  });
};

// Fetch the cover image from the IG CDN as a base64 string.
export const fetchCoverBase64 = async (url, { fetchImpl = null, signal = null } = {}) => {
  if (!url) throw new Error("fetchCoverBase64: cover URL required");
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) throw new Error("fetchCoverBase64: no fetch implementation available");
  let resp;
  try {
    resp = await fetchFn(url, { credentials: "omit", signal });
  } catch (e) {
    const err = new Error(`cover fetch failed (CORS / network): ${String(e && e.message || e)}`);
    err.name = "CoverFetchError";
    err.cause = e;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`cover fetch failed: HTTP ${resp.status}`);
    err.name = "CoverFetchError";
    err.status = resp.status;
    throw err;
  }
  const blob = typeof resp.blob === "function" ? await resp.blob() : null;
  if (!blob) throw new Error("cover fetch: response has no blob()");
  return blobToBase64(blob);
};

const clampInt = (v, lo, hi, fb) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

const oneOf = (v, allowed, fb) => {
  const s = String(v || "").toLowerCase().trim();
  return allowed.includes(s) ? s : fb;
};

const normalizeCoverAi = (json, model) => {
  if (!json || typeof json !== "object") {
    throw new Error("analyzeCover: schema validation failed (no object)");
  }
  const hasFace = !!json.hasFace;
  const faceCount = clampInt(json.faceCount, 0, 50, hasFace ? 1 : 0);
  const expression = oneOf(json.expression, COVER_EXPRESSIONS, hasFace ? "neutral" : "none");
  const hasTextOverlay = !!json.hasTextOverlay;
  let textContent = null;
  if (hasTextOverlay && typeof json.textContent === "string") {
    const t = json.textContent.trim();
    if (t) textContent = t.slice(0, 80);
  }
  const dominantColor = String(json.dominantColor || "").trim().slice(0, 24).toLowerCase() || "unknown";
  const composition = oneOf(json.composition, COVER_COMPOSITIONS, "other");
  return {
    hasFace,
    faceCount: hasFace ? Math.max(1, faceCount) : 0,
    expression: hasFace ? expression : "none",
    hasTextOverlay,
    textContent,
    dominantColor,
    composition,
    analyzedAt: Date.now(),
    model,
  };
};

// Cross-tab one boolean/categorical cover feature against `_score`.
// Returns `{ key, buckets: [{ label, n, median, mean }], n }`.
export const crossTabCoverFeature = (posts, getter, label) => {
  if (!Array.isArray(posts) || !posts.length) return { key: label, buckets: [], n: 0 };
  const groups = new Map();
  for (const p of posts) {
    const ai = p && p.cover_ai;
    if (!ai) continue;
    const v = getter(ai, p);
    if (v === undefined || v === null) continue;
    const k = String(v);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(Number(p._score) || 0);
  }
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const buckets = [];
  let total = 0;
  for (const [k, vals] of groups) {
    const sum = vals.reduce((a, b) => a + b, 0);
    buckets.push({
      label: k,
      n: vals.length,
      median: median(vals),
      mean: vals.length ? sum / vals.length : 0,
    });
    total += vals.length;
  }
  buckets.sort((a, b) => b.n - a.n);
  return { key: label, buckets, n: total };
};

// "Win rate" of a post = how favourably its cover-feature bucket fares vs
// the rest. Used by the new "By cover-feature win-rate" sort.
//
// We score each post by the MEAN `_score` of every cover_ai bucket it
// belongs to, divided by the mean across all analyzed posts. A post in
// "hasFace=true" + "composition=closeup" + "hasTextOverlay=true" inherits
// the geometric mean of those three lifts.
export const coverWinRate = (post, allPosts) => {
  if (!post || !post.cover_ai || !Array.isArray(allPosts) || !allPosts.length) return 0;
  const scored = allPosts.filter((p) => p && p.cover_ai);
  if (!scored.length) return 0;
  const overall = scored.reduce((a, p) => a + (Number(p._score) || 0), 0) / scored.length;
  if (!(overall > 0)) return 0;
  const features = [
    ["hasFace", post.cover_ai.hasFace],
    ["hasTextOverlay", post.cover_ai.hasTextOverlay],
    ["composition", post.cover_ai.composition],
    ["expression", post.cover_ai.expression],
  ];
  const lifts = [];
  for (const [key, val] of features) {
    if (val === undefined || val === null) continue;
    const bucket = scored.filter((p) => p.cover_ai[key] === val);
    if (bucket.length < 2) continue;
    const mean = bucket.reduce((a, p) => a + (Number(p._score) || 0), 0) / bucket.length;
    lifts.push(mean / overall);
  }
  if (!lifts.length) return 0;
  // Geometric mean — keeps the metric multiplicative and bounded.
  const product = lifts.reduce((a, b) => a * b, 1);
  return Math.pow(product, 1 / lifts.length);
};

export async function analyzeCover(post, opts = {}) {
  if (!post || typeof post !== "object") throw new Error("analyzeCover: post required");
  const chat = opts.chat;
  if (typeof chat !== "function") throw new Error("analyzeCover: opts.chat required");
  const model = String(opts.model || DEFAULT_VISION_MODEL);
  const persist = typeof opts.persist === "function" ? opts.persist : null;
  const cache = opts.cache || null;

  if (!post.cover) {
    const e = new Error("analyzeCover: post.cover required for cover analysis");
    e.name = "CoverFetchError";
    throw e;
  }

  const messages = [
    { role: "system", content: COVER_SYSTEM },
    { role: "user", content: "Classify the cover frame attached to this message." },
  ];

  // Cache key — same `(model, promptHash where promptHash includes the
  // cover URL)` rule as task c7de9bca. We hash the cover URL rather than
  // the (heavy) base64 bytes so cache lookups stay cheap.
  const cacheKey = `${model}:${promptHash({
    messages,
    schema: COVER_SCHEMA,
    cover: String(post.cover),
  })}`;

  const cacheGet = cache && typeof cache.get === "function" ? (k) => cache.get(k) : null;
  const cacheHas = cache && typeof cache.has === "function" ? (k) => cache.has(k) : (k) => cacheGet ? cacheGet(k) !== undefined : false;
  const cacheSet = cache && typeof cache.set === "function" ? (k, v) => cache.set(k, v) : null;

  if (cacheGet && cacheHas(cacheKey)) {
    const cached = cacheGet(cacheKey);
    const out = { ...cached, cached: true };
    if (persist && post.id) await persist(post.id, out);
    return out;
  }

  // Cover image — required. Fail loud, do NOT degrade to text-only.
  const coverBase64 = await fetchCoverBase64(post.cover, {
    fetchImpl: opts.fetchImpl || null,
    signal: opts.signal || null,
  });

  const resp = await chat({
    model,
    messages,
    schema: COVER_SCHEMA,
    images: [coverBase64],
    kind: "cover",
    postId: post.id || null,
    signal: opts.signal || null,
    options: { temperature: 0.1 },
  });

  if (!resp || !resp.json) {
    const e = new Error(
      "analyzeCover: model returned no JSON. " +
      "If you pulled a text-only Gemma, try 'gemma3:12b' or another multimodal variant."
    );
    e.name = "CoverSchemaError";
    throw e;
  }

  const coverAi = normalizeCoverAi(resp.json, resp.model || model);
  if (cacheSet) cacheSet(cacheKey, coverAi);
  const out = { ...coverAi, cached: false };

  if (persist && post.id) {
    await persist(post.id, out);
  }
  return out;
}
