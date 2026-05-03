// Per-creator voice/style fingerprint built from their top posts via local LLM.
//
// Pure ES module — no chrome APIs, no DOM. Safe for unit tests; the runtime
// (content.js) calls `regenerateVoice()` through the llm-bridge by passing
// a `chat` adapter and the IDB-backed `store` adapter (the same shape as
// `window.__fsStore`).
//
// Contract (pinned for the rewrite-generator task):
//
//   regenerateVoice({
//     username,               // creator username, lowercased
//     chat,                   // async ({ model, messages, schema, kind, options }) → { json, ... }
//     store,                  // { getByAuthor, putVoice }
//     model = "gemma4",       // text-only Gemma; no vision needed
//     topN = 20,              // hard cap on posts pulled into the prompt
//     minScore = 1.5,         // _score floor — below this we ignore the post
//     truncateChars = 500,    // per-post caption + transcript truncation
//     signal = null,
//   }) → Promise<{
//     username, tone, avgSentenceLen, signatureWords[], emojiRate,
//     openerPatterns[], closerPatterns[], CTAStyle,
//     generatedAt, sourcePostCount, model,
//   }>
//
//   buildSystemPrompt(voice) → string  // reusable system message for rewrites.
//
// Schema mirrors the IDB `voice` store row exactly (minus the username key
// and the persistence-only fields), so the LLM JSON is dropped in directly.

export const VOICE_SCHEMA = {
  type: "object",
  properties: {
    tone: {
      type: "string",
      description: "Voice & tone in 1–4 lowercase words (e.g. 'wry, didactic', 'high-energy hype').",
    },
    avgSentenceLen: {
      type: "number",
      description: "Approximate average sentence length in words (integer, 4–40).",
    },
    signatureWords: {
      type: "array",
      items: { type: "string" },
      description: "5–15 distinctive words/phrases this creator reuses (lowercase, no hashtags).",
    },
    emojiRate: {
      type: "number",
      description: "Emojis per 100 words (0 if they don't use emoji).",
    },
    openerPatterns: {
      type: "array",
      items: { type: "string" },
      description: "3–6 templates for how they open posts (use [BRACKETS] for slots, e.g. '[NUMBER] reasons …', 'Stop [VERB]ing your [NOUN]').",
    },
    closerPatterns: {
      type: "array",
      items: { type: "string" },
      description: "2–5 templates for how they close posts (sign-offs, last-line punchlines).",
    },
    CTAStyle: {
      type: "string",
      description: "How they invite engagement in 1 sentence (e.g. 'soft — asks an open question', 'hard — explicit save/share/follow').",
    },
  },
  required: [
    "tone", "avgSentenceLen", "signatureWords",
    "emojiRate", "openerPatterns", "closerPatterns", "CTAStyle",
  ],
};

const VOICE_SYSTEM = [
  "You are a voice-and-style profiler for short-form social-media creators.",
  "You will be given the creator's TOP posts (caption + transcript). Your job",
  "is to extract a reusable VOICE FINGERPRINT — patterns that another writer",
  "could follow to produce posts that sound like this creator.",
  "Return strict JSON matching the schema. No commentary, no markdown fences.",
  "Rules:",
  "- Be concrete. 'casual' is useless; 'wry, deadpan, hyper-confident' is useful.",
  "- 'signatureWords' must come from the actual posts — verbatim words/phrases",
  "  the creator reuses, not generic vocabulary.",
  "- 'openerPatterns' and 'closerPatterns' are TEMPLATES — keep variable bits",
  "  in [BRACKETS] (e.g. 'Stop [VERB]ing your [NOUN]', '[NUMBER] reasons …').",
  "- Numeric fields are NUMBERS, not strings.",
].join("\n");

const truncate = (s, n) => {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

// Build the user-message context: top-N posts, each with its key engagement
// stats so the model can weight signal vs. noise.
export const buildVoicePrompt = (posts, { truncateChars = 500 } = {}) => {
  const blocks = posts.map((p, i) => {
    const cap = truncate(p.desc, truncateChars);
    const tx = truncate(p.transcript, truncateChars);
    const stats = [
      typeof p._score === "number" ? `score=${p._score.toFixed(2)}` : null,
      typeof p.likes === "number" ? `likes=${p.likes}` : null,
      typeof p.views === "number" && p.views ? `views=${p.views}` : null,
    ].filter(Boolean).join(" ");
    const lines = [`--- POST ${i + 1}${stats ? " (" + stats + ")" : ""} ---`];
    lines.push(`CAPTION: ${cap || "(none)"}`);
    if (tx) lines.push(`TRANSCRIPT: ${tx}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
};

// Tiny normalizers — clamp ranges and dedupe so a sloppy LLM can't poison
// the persisted row.
const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};
const dedupeStrings = (arr, max) => {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = String(v || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

const normalizeVoiceJson = (j) => ({
  tone: String((j && j.tone) || "").toLowerCase().trim().slice(0, 80),
  avgSentenceLen: Math.round(clampNum(j && j.avgSentenceLen, 1, 80, 12)),
  signatureWords: dedupeStrings(j && j.signatureWords, 20),
  emojiRate: Math.round(clampNum(j && j.emojiRate, 0, 100, 0) * 100) / 100,
  openerPatterns: dedupeStrings(j && j.openerPatterns, 8),
  closerPatterns: dedupeStrings(j && j.closerPatterns, 6),
  CTAStyle: String((j && j.CTAStyle) || "").trim().slice(0, 200),
});

// Pick the top-N posts for `username` from store, filtering by minScore.
// Returns posts sorted by `_score` desc, oldest fields broken on `lastSeenAt`.
export const selectTopPosts = (allByAuthor, { topN, minScore }) => {
  const arr = (allByAuthor || []).filter(
    (p) => p && typeof p._score === "number" && p._score >= minScore
  );
  arr.sort((a, b) => {
    const ds = (b._score || 0) - (a._score || 0);
    if (ds !== 0) return ds;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });
  return arr.slice(0, topN);
};

export async function regenerateVoice(opts = {}) {
  const username = String(opts.username || "").toLowerCase().trim();
  if (!username) throw new Error("regenerateVoice: username required");
  const chat = opts.chat;
  if (typeof chat !== "function") {
    throw new Error("regenerateVoice: opts.chat function required");
  }
  const store = opts.store;
  if (!store || typeof store.getByAuthor !== "function" || typeof store.putVoice !== "function") {
    throw new Error("regenerateVoice: opts.store with getByAuthor + putVoice required");
  }
  const model = String(opts.model || "gemma4");
  const topN = Math.max(1, Math.min(50, Number(opts.topN) || 20));
  const minScore = Number.isFinite(opts.minScore) ? Number(opts.minScore) : 1.5;
  const truncateChars = Math.max(100, Math.min(4000, Number(opts.truncateChars) || 500));
  const signal = opts.signal || null;

  const all = await store.getByAuthor(username);
  const top = selectTopPosts(all, { topN, minScore });
  if (!top.length) {
    const err = new Error("regenerateVoice: no posts ≥ minScore for this creator");
    err.code = "no-source-posts";
    err.username = username;
    err.minScore = minScore;
    throw err;
  }

  const userContent = buildVoicePrompt(top, { truncateChars });
  const messages = [
    { role: "system", content: VOICE_SYSTEM },
    { role: "user", content: userContent },
  ];

  const t0 = Date.now();
  const r = await chat({
    model,
    messages,
    schema: VOICE_SCHEMA,
    kind: "voice-fingerprint",
    options: { temperature: 0.2 },
    signal,
  });
  const durationMs = Date.now() - t0;
  if (!r || !r.json) {
    throw new Error("regenerateVoice: chat returned no JSON");
  }

  const v = normalizeVoiceJson(r.json);
  const row = {
    username,
    tone: v.tone,
    avgSentenceLen: v.avgSentenceLen,
    signatureWords: v.signatureWords,
    emojiRate: v.emojiRate,
    openerPatterns: v.openerPatterns,
    closerPatterns: v.closerPatterns,
    CTAStyle: v.CTAStyle,
    generatedAt: Date.now(),
    sourcePostCount: top.length,
    model,
  };
  await store.putVoice(row);

  // Caller-visible event: log here is best-effort; the runtime wrapper in
  // content.js also emits its own structured log line.
  if (typeof opts.log === "function") {
    try { opts.log("voice.regenerated", { username, sourcePosts: top.length, durationMs }); }
    catch { /* ignore */ }
  }

  return row;
}

// Build a system message that primes the rewrite generator to mimic this
// creator's voice. Stable formatting — snapshot-tested.
export function buildSystemPrompt(voice) {
  if (!voice || typeof voice !== "object") {
    throw new Error("buildSystemPrompt: voice required");
  }
  const list = (arr) => (Array.isArray(arr) && arr.length)
    ? arr.map((s) => `  - ${s}`).join("\n")
    : "  (none)";
  const lines = [
    `You are writing in the voice of @${voice.username || "(unknown)"}.`,
    "Match their voice EXACTLY. Do not invent your own style.",
    "",
    `TONE: ${voice.tone || "(unspecified)"}`,
    `AVERAGE SENTENCE LENGTH: ~${voice.avgSentenceLen || 12} words.`,
    `EMOJI RATE: ${voice.emojiRate || 0} per 100 words.`,
    `CTA STYLE: ${voice.CTAStyle || "(unspecified)"}`,
    "",
    "SIGNATURE WORDS / PHRASES (reuse these naturally; do not force every one):",
    list(voice.signatureWords),
    "",
    "OPENER PATTERNS (pick one and instantiate the [BRACKETS]):",
    list(voice.openerPatterns),
    "",
    "CLOSER PATTERNS (pick one):",
    list(voice.closerPatterns),
    "",
    "Rules:",
    "- Stay within ~2× the average sentence length.",
    "- Do not break character to explain that you're an AI.",
    "- Do not output markdown fences or commentary — only the rewritten post.",
  ];
  return lines.join("\n");
}
