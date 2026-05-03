// Per-post outlier diagnostic via local multimodal Gemma.
//
// One `chat()` call with the cover image attached + a structured-output
// schema asking the model to explain WHY this post overperformed (or
// underperformed) against the creator's own median for the same format.
//
// Pure ES module — no chrome APIs, no DOM. Caller injects:
//   - `chat`        : same shape as src/lib/llm.js chat()
//   - `fetchImpl`   : optional, defaults to globalThis.fetch
//   - `persist`     : optional async (id, diagnosis) → void
//   - `cohort`      : optional Post[] to compute per-creator median for the
//                     same format inline. If omitted, no median signal.
//   - `model`       : vision model id (defaults to "gemma4")
//   - `signal`      : optional AbortSignal
//
// Returns the persisted diagnosis: {
//   hookStrength, visualHookStrength, topicNovelty,    (1-10)
//   emotionalDriver, structuralPattern, hypothesis,    (string)
//   analyzedAt, model
// }
//
// CORS note: cover image lives on IG's CDN. We fetch with credentials:"omit"
// (per the reference fallback in content.js downloadVideo). On any error we
// surface it to the caller with a clear message — we do NOT silently degrade
// to a text-only call, since the whole point is the visual hypothesis.

export const DEFAULT_VISION_MODEL = "gemma4";

export const DIAGNOSIS_SCHEMA = {
  type: "object",
  properties: {
    hookStrength: { type: "number", minimum: 1, maximum: 10 },
    visualHookStrength: { type: "number", minimum: 1, maximum: 10 },
    topicNovelty: { type: "number", minimum: 1, maximum: 10 },
    emotionalDriver: { type: "string" },
    structuralPattern: { type: "string" },
    hypothesis: { type: "string" },
  },
  required: [
    "hookStrength", "visualHookStrength", "topicNovelty",
    "emotionalDriver", "structuralPattern", "hypothesis",
  ],
};

const DIAGNOSE_SYSTEM = [
  "You are a short-form-video performance analyst.",
  "You are shown the COVER FRAME of a post plus its caption, transcript,",
  "and quantitative score versus the creator's own baseline. Your job is to",
  "explain — concretely — WHY this post overperformed (or underperformed).",
  "",
  "Return strict JSON matching the schema. No commentary. No markdown fences.",
  "",
  "Score rubrics (1 = weak, 10 = exceptional):",
  "  hookStrength       — strength of the OPENING TEXT hook (caption + first",
  "                       transcript line). Reward specificity, stakes,",
  "                       contrarian framing, curiosity gaps.",
  "  visualHookStrength — strength of the COVER FRAME as a stop-the-scroll",
  "                       image. Reward face/eye contact, bold text overlay,",
  "                       contrast, novelty, implied motion, emotion.",
  "  topicNovelty       — how fresh the topic+angle feels in this niche.",
  "                       Reward subverted expectations, niche-pollination.",
  "",
  "Open string fields:",
  "  emotionalDriver    — the dominant emotion the post evokes",
  "                       (e.g. 'envy', 'vindication', 'awe', 'fear-of-missing-out',",
  "                       'schadenfreude', 'comfort'). Single short phrase.",
  "  structuralPattern  — the format pattern in 1–4 words",
  "                       (e.g. 'before/after reveal', 'POV reaction',",
  "                       'numbered listicle', 'tutorial-with-payoff').",
  "  hypothesis         — ≤80 words. ONE concrete sentence explaining WHY",
  "                       this beat the baseline. MUST reference at least one",
  "                       VISIBLE element of the cover (face, expression,",
  "                       text overlay, prop, color, framing). Generic",
  "                       answers are unacceptable.",
  "",
  "Do not all-cluster scores at 5 — calibrate against the score-vs-median",
  "signal you are given.",
].join("\n");

// ------------------------------------------------------------------
// Helpers (pure, exported for testing)
// ------------------------------------------------------------------

export const formatOf = (p) => {
  if (!p) return "single";
  if (p.isReel || p.mediaType === 2) return "reel";
  if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
  return "single";
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Median primary metric (likes by default) for the same author + same format
// across `cohort`. Used to give the model a creator-specific baseline.
export const cohortMedianForFormat = (cohort, post, metric = "likes") => {
  if (!Array.isArray(cohort) || !cohort.length || !post) return 0;
  const fmt = formatOf(post);
  const author = post.author || "";
  const vals = [];
  for (const c of cohort) {
    if (!c || !author || c.author !== author) continue;
    if (formatOf(c) !== fmt) continue;
    const v = Number(c[metric]) || 0;
    if (v > 0) vals.push(v);
  }
  return median(vals);
};

// Convert a Blob to a base64 string (no data: prefix — Ollama wants raw b64).
export const blobToBase64 = async (blob) => {
  if (!blob) throw new Error("blobToBase64: blob required");
  // Node + jsdom path: Buffer if available.
  if (typeof Buffer !== "undefined" && typeof blob.arrayBuffer === "function") {
    const buf = Buffer.from(await blob.arrayBuffer());
    return buf.toString("base64");
  }
  // Browser path: FileReader.
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
// Throws with `coverFetch` name on CORS / network failure so the caller can
// surface a clean message (and skip the row instead of pretending success).
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

// Compose the user message describing the post. Kept as pure text so the
// model has stable, deterministic context alongside the attached image.
export const buildUserContent = (post, { creatorMedian = 0, metric = "likes" } = {}) => {
  const desc = String((post && post.desc) || "").trim();
  const transcript = String((post && post.transcript) || "").trim();
  const score = Number(post && post._score) || 0;
  const basis = String((post && post._scoreBasis) || "");
  const surface = String((post && post.surface) || "");
  const fmt = formatOf(post);
  const author = (post && post.author) || "(unknown)";
  const v = Number(post && post[metric]) || 0;
  const lines = [];
  lines.push(`AUTHOR: @${author}`);
  lines.push(`FORMAT: ${fmt}${surface ? ` · surface=${surface}` : ""}`);
  lines.push(
    `OUTLIER SCORE: ${score ? score.toFixed(2) + "x" : "n/a"}` +
    (basis ? ` (basis=${basis})` : "")
  );
  if (creatorMedian > 0) {
    const ratio = v > 0 ? (v / creatorMedian).toFixed(2) : "n/a";
    lines.push(
      `CREATOR'S MEDIAN ${metric.toUpperCase()} FOR ${fmt.toUpperCase()}: ` +
      `${Math.round(creatorMedian)} · this post: ${Math.round(v)} (${ratio}×)`
    );
  } else if (v > 0) {
    lines.push(`THIS POST'S ${metric.toUpperCase()}: ${Math.round(v)}`);
  }
  lines.push("");
  lines.push(`CAPTION:\n${desc || "(no caption)"}`);
  if (transcript) {
    const trimmed = transcript.length > 1200 ? transcript.slice(0, 1200) + "…" : transcript;
    lines.push("");
    lines.push(`TRANSCRIPT:\n${trimmed}`);
  }
  return lines.join("\n");
};

const clampInt = (v, lo, hi, fb) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};
const trimWords = (s, max) => {
  const words = String(s || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(" ");
};

const normalizeDiagnosis = (json, model) => {
  if (!json || typeof json !== "object") {
    throw new Error("diagnoseOutlier: schema validation failed (no object)");
  }
  const out = {
    hookStrength: clampInt(json.hookStrength, 1, 10, 5),
    visualHookStrength: clampInt(json.visualHookStrength, 1, 10, 5),
    topicNovelty: clampInt(json.topicNovelty, 1, 10, 5),
    emotionalDriver: String(json.emotionalDriver || "").trim().slice(0, 80),
    structuralPattern: String(json.structuralPattern || "").trim().slice(0, 80),
    hypothesis: trimWords(json.hypothesis, 80),
    analyzedAt: Date.now(),
    model,
  };
  // The required-fields contract — surface failures up to the UI.
  for (const k of ["emotionalDriver", "structuralPattern", "hypothesis"]) {
    if (!out[k]) {
      const e = new Error(
        `diagnoseOutlier: model returned no '${k}' — likely a non-vision Gemma. ` +
        `Try pulling 'gemma3:12b' or another multimodal variant.`
      );
      e.name = "DiagnosisSchemaError";
      throw e;
    }
  }
  return out;
};

export async function diagnoseOutlier(post, opts = {}) {
  if (!post || typeof post !== "object") throw new Error("diagnoseOutlier: post required");
  const chat = opts.chat;
  if (typeof chat !== "function") throw new Error("diagnoseOutlier: opts.chat required");
  const model = String(opts.model || DEFAULT_VISION_MODEL);
  const cohort = Array.isArray(opts.cohort) ? opts.cohort : null;
  const metric = String(opts.metric || "likes");
  const persist = typeof opts.persist === "function" ? opts.persist : null;

  // 1) Cover image — required. Fail loud, do NOT degrade to text-only.
  if (!post.cover) {
    const e = new Error("diagnoseOutlier: post.cover required for visual diagnosis");
    e.name = "CoverFetchError";
    throw e;
  }
  const coverBase64 = await fetchCoverBase64(post.cover, {
    fetchImpl: opts.fetchImpl || null,
    signal: opts.signal || null,
  });

  // 2) Per-creator median for the same format (computed inline).
  const creatorMedian = cohort ? cohortMedianForFormat(cohort, post, metric) : 0;

  const userContent = buildUserContent(post, { creatorMedian, metric });
  const messages = [
    { role: "system", content: DIAGNOSE_SYSTEM },
    { role: "user", content: userContent },
  ];

  const resp = await chat({
    model,
    messages,
    schema: DIAGNOSIS_SCHEMA,
    images: [coverBase64],
    kind: "diagnose",
    postId: post.id || null,
    signal: opts.signal || null,
    options: { temperature: 0.2 },
  });

  if (!resp || !resp.json) {
    const e = new Error(
      "diagnoseOutlier: model returned no JSON. " +
      "If you pulled a text-only Gemma, try 'gemma3:12b' or another multimodal variant."
    );
    e.name = "DiagnosisSchemaError";
    throw e;
  }

  const diagnosis = normalizeDiagnosis(resp.json, resp.model || model);

  if (persist && post.id) {
    await persist(post.id, diagnosis);
  }

  return diagnosis;
}
