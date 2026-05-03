// Per-post LLM analysis: hook + topic, in parallel.
//
// Pure ES module — no chrome APIs, no DOM. Safe for unit tests; the runtime
// (content.js) calls it through the llm-bridge by passing a `chat` adapter.
//
// Contract:
//   analyzePost(post, {
//     chat,                    // async ({ model, messages, schema, kind, postId, options }) → { json, ... }
//     model = "gemma4",        // resolved by caller from chrome.storage.local["fs:ai"].model
//     cache = inMemory,        // Map | { get, set, has } keyed by `${model}:${promptHash}`
//     signal,                  // optional AbortSignal forwarded to chat()
//   }) → Promise<{
//     hook, hookType, topic, angle, analyzedAt, model, descHash, cached,
//   }>
//
// Skip-rule: caller checks `post.ai && post.ai.descHash === descHashOf(post.desc)`
// and decides whether to invoke. We re-export `descHashOf()` so callers can
// reuse the same hash function.

import { promptHash } from "../lib/llm.js";

export const HOOK_TYPES = [
  "question", "contrarian", "listicle", "curiosity-gap",
  "stat-drop", "story-open", "other",
];

export const HOOK_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "The opening line of the post (≤12 words)" },
    hookType: { type: "string", enum: HOOK_TYPES },
  },
  required: ["hook", "hookType"],
};

export const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "The subject (1–3 words, e.g. 'macros')" },
    angle: { type: "string", description: "The treatment (1–4 words, e.g. 'myth-busting')" },
  },
  required: ["topic", "angle"],
};

const HOOK_SYSTEM = [
  "You analyze short-form social-media posts and extract the HOOK.",
  "The hook is the opening sentence (or implied opening if only caption is present).",
  "Return strict JSON matching the schema. No commentary, no markdown.",
  "Rules:",
  "- 'hook' MUST be ≤12 words, verbatim or lightly normalized.",
  "- 'hookType' MUST be one of:",
  "    question       — opens with an interrogative",
  "    contrarian     — challenges common belief",
  "    listicle       — promises N items / steps / reasons",
  "    curiosity-gap  — withholds info to bait the watch",
  "    stat-drop      — leads with a number / statistic",
  "    story-open     — sets a scene / personal anecdote",
  "    other          — none of the above",
].join("\n");

const TOPIC_SYSTEM = [
  "You analyze short-form social-media posts and extract TOPIC + ANGLE.",
  "Return strict JSON matching the schema. No commentary, no markdown.",
  "- 'topic' is the subject in 1–3 lowercase words (e.g. 'macros', 'cold plunges').",
  "- 'angle' is the treatment in 1–4 lowercase words (e.g. 'myth-busting',",
  "  'how-to', 'before/after', 'rant', 'reaction', 'tutorial', 'storytime').",
].join("\n");

// Build the user-message payload from caption + optional first-3 transcript
// segments (task 096ead1c).
export const buildUserContent = (post) => {
  const desc = String((post && post.desc) || "").trim();
  const segs = Array.isArray(post && post.transcriptSegments) ? post.transcriptSegments : null;
  const head = segs
    ? segs.slice(0, 3).map((s) => String(s && s.text || "").trim()).filter(Boolean)
    : [];
  const parts = [];
  parts.push(`CAPTION:\n${desc || "(no caption)"}`);
  if (head.length) {
    parts.push(`TRANSCRIPT (first ${head.length} segments):\n${head.join(" ")}`);
  }
  return parts.join("\n\n");
};

// Stable hash of the *input* the LLM saw — used to detect a stale `post.ai`
// after the caption changes. Includes transcript-head so a newly-arrived
// transcript also invalidates.
export const descHashOf = (post) => promptHash({
  desc: String((post && post.desc) || "").trim(),
  segs: Array.isArray(post && post.transcriptSegments)
    ? post.transcriptSegments.slice(0, 3).map((s) => String(s && s.text || "").trim())
    : [],
});

const sanitizeHookType = (t) => HOOK_TYPES.includes(String(t)) ? String(t) : "other";
const trimWords = (s, max) => {
  const words = String(s || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(" ");
};

const memCache = new Map();

export async function analyzePost(post, opts = {}) {
  if (!post || typeof post !== "object") {
    throw new Error("analyzePost: post required");
  }
  const chat = opts.chat;
  if (typeof chat !== "function") {
    throw new Error("analyzePost: opts.chat function required");
  }
  const model = String(opts.model || "gemma4");
  const cache = opts.cache || memCache;
  const signal = opts.signal || null;
  const postId = post.id || null;

  const userContent = buildUserContent(post);
  const hookMessages = [
    { role: "system", content: HOOK_SYSTEM },
    { role: "user", content: userContent },
  ];
  const topicMessages = [
    { role: "system", content: TOPIC_SYSTEM },
    { role: "user", content: userContent },
  ];

  const hookKey = `${model}:${promptHash({ messages: hookMessages, schema: HOOK_SCHEMA })}`;
  const topicKey = `${model}:${promptHash({ messages: topicMessages, schema: TOPIC_SCHEMA })}`;

  const cacheGet = (k) => (typeof cache.get === "function" ? cache.get(k) : undefined);
  const cacheHas = (k) => (typeof cache.has === "function" ? cache.has(k) : cacheGet(k) !== undefined);
  const cacheSet = (k, v) => { if (typeof cache.set === "function") cache.set(k, v); };

  const runOne = async (key, messages, schema, kind) => {
    if (cacheHas(key)) return { json: cacheGet(key), cached: true };
    const r = await chat({
      model, messages, schema, signal,
      kind, postId,
      // Bias towards low-temperature deterministic output so cache hits stick.
      options: { temperature: 0.1 },
    });
    if (!r || !r.json) {
      throw new Error(`analyzePost: ${kind} returned no JSON`);
    }
    cacheSet(key, r.json);
    return { json: r.json, cached: false };
  };

  const [hookRes, topicRes] = await Promise.all([
    runOne(hookKey, hookMessages, HOOK_SCHEMA, "hook"),
    runOne(topicKey, topicMessages, TOPIC_SCHEMA, "topic"),
  ]);

  const ai = {
    hook: trimWords(hookRes.json.hook, 12),
    hookType: sanitizeHookType(hookRes.json.hookType),
    topic: String(topicRes.json.topic || "").toLowerCase().trim(),
    angle: String(topicRes.json.angle || "").toLowerCase().trim(),
    analyzedAt: Date.now(),
    model,
    descHash: descHashOf(post),
    cached: !!(hookRes.cached && topicRes.cached),
  };

  return ai;
}

// Test-friendly: clear the module-level cache between runs.
export const _resetCache = () => memCache.clear();
