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

// ---------------------------------------------------------------------------
// detectFormat — pure, no LLM.
//
// Classifies a post by caption shape (and lightly the transcript) into one of
// FORMATS. First matching rule wins; falls back to "other".
// ---------------------------------------------------------------------------

export const FORMATS = [
  "list", "story", "tip", "tutorial", "hottake",
  "reaction", "dayinlife", "beforeafter", "other",
];

const transcriptText = (post) => {
  const segs = Array.isArray(post && post.transcriptSegments) ? post.transcriptSegments : null;
  if (segs && segs.length) {
    return segs.map((s) => String((s && s.text) || "")).join(" ");
  }
  return String((post && post.transcript) || "");
};

const countMatches = (s, re) => {
  const m = s.match(re);
  return m ? m.length : 0;
};

export function detectFormat(post) {
  const desc = String((post && post.desc) || "");
  const lower = desc.toLowerCase();
  const trimmed = desc.trim();
  const lowerTrimmed = trimmed.toLowerCase();
  const transcript = transcriptText(post).toLowerCase();

  // 1. list — digit-led caption, OR 3+ bullet/numbered lines.
  if (/^\d+[.\s]/.test(trimmed)) return "list";
  const lines = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^([-•]|\d+\.)\s*\S/.test(l));
  if (bulletLines.length >= 3) return "list";

  // 2. tutorial
  if (/\bstep\s*1\b/.test(lower)
    || /\bhow to\b/.test(lower)
    || /\btutorial\b/.test(lower)
    || /\bguide\b/.test(lower)
    || /\bstep\s*1\b/.test(transcript)
    || /\bstep\s*one\b/.test(transcript)) {
    return "tutorial";
  }

  // 3. beforeafter
  if ((/\bbefore\b/.test(lower) && /\bafter\b/.test(lower))
    || /\btransformation\b/.test(lower)
    || /\bresults\b/.test(lower)) {
    return "beforeafter";
  }

  // 4. dayinlife
  if (/\bday in (my )?life\b/.test(lower)
    || /\bday in\b/.test(lower)
    || /\bmorning routine\b/.test(lower)
    || /\bdaily routine\b/.test(lower)) {
    return "dayinlife";
  }

  // 5. reaction
  if (/\breact(ing)?\b/.test(lower)
    || /\bmy thoughts on\b/.test(lower)
    || /\bwatching\b/.test(lower)) {
    return "reaction";
  }

  // 6. hottake
  if (/\bunpopular opinion\b/.test(lower)
    || /\bhot take\b/.test(lower)
    || /i['’]ll say it\b/.test(lower)
    || /\bcontroversial\b/.test(lower)) {
    return "hottake";
  }

  // 7. tip
  if (/\btip:\s/.test(lower)
    || /\bpro tip\b/.test(lower)
    || /\bquick tip\b/.test(lower)
    || /^if you\s+\S+/.test(lowerTrimmed)) {
    return "tip";
  }

  // 8. story — first-person narrative.
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const firstPerson = countMatches(lower, /\b(i|me|my|we)\b/g);
  if (firstPerson >= 3 && wordCount >= 30) return "story";

  return "other";
}

// ---------------------------------------------------------------------------
// scoreFormats — multi-label, confidence-scored, no LLM.
//
// Returns an object mapping label → confidence in (0,1]. Multiple labels can
// fire simultaneously. Labels with confidence < 0.15 are omitted.
//
// Signals (cheapest first):
//   1. caption regex/keyword heuristics
//   2. caption length + first-person-pronoun density
//   3. duration buckets
//   4. audio metadata flags (audioIsOriginal, audioIsTrending, captionUrl, isDuet)
//   5. hashtag presence
//   6. transcript first-person past-tense ratio (when present)
// ---------------------------------------------------------------------------

export const FORMAT_LABELS = [
  "talking_head", "story", "skit", "educational", "listicle", "tutorial",
  "reaction", "pov", "hottake", "tip", "dayinlife", "beforeafter", "explainer",
];

const hashtagsOf = (s) => {
  const out = new Set();
  const re = /#([a-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(String(s || ""))) !== null) {
    out.add(m[1].toLowerCase());
  }
  return out;
};

export function FORMAT_SIGNALS(post) {
  const desc = String((post && post.desc) || "");
  const lower = desc.toLowerCase();
  const trimmed = desc.trim();
  const transcript = transcriptText(post).toLowerCase();
  const tags = hashtagsOf(desc);
  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  // Strip hashtags before counting first-person pronouns so #me, #iam don't pollute.
  const captionNoTags = lower.replace(/#[a-z0-9_]+/g, " ");
  const firstPerson = countMatches(captionNoTags, /\b(i|i['’]m|i['’]ve|i['’]ll|me|my|mine|we|our)\b/g);
  const pastTense = countMatches(captionNoTags, /\b(was|were|had|did|went|came|told|said|tried|started|stopped|got|made|thought|felt|realized|learned)\b/g);
  const lines = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^([-•]|\d+[.)]?)\s*\S/.test(l));
  const numerals = countMatches(lower, /\b(\d+)\s+(things|reasons|ways|tips|signs|steps|mistakes|lessons|rules|secrets|hacks|facts|myths)\b/g);
  const hasListStart = /^\d+[.)\s]/.test(trimmed);
  const hasPovPrefix = /^(pov|p\.o\.v\.?)\s*:/i.test(trimmed);
  const hasStoryHashtag = tags.has("storytime") || tags.has("story") || tags.has("mystory");
  const hasPovHashtag = tags.has("pov");
  const hasTutorialHashtag = tags.has("tutorial") || tags.has("howto");
  const hasDuration = Number.isFinite(post && post.durationSec);
  const dur = hasDuration ? Number(post.durationSec) : null;
  // Audio signal: prefer the structured `post.audio.*` shape produced by the
  // IG / TT runtime parsers (platform-runtime.js igAudio / parser-tiktok.js).
  // Fall back to the legacy flat boolean flags for back-compat with hand-built
  // test fixtures.
  const audioObj = post && typeof post.audio === "object" ? post.audio : null;
  const audioIsOriginal = audioObj
    ? audioObj.isOriginal === true
    : !!(post && post.audioIsOriginal);
  // "Trending" ≈ a non-original sound that lots of other creators are using.
  // The IG parser populates `audio.useCount`; threshold is empirical (1k+ uses
  // is the lower edge of "clearly a trend" on IG; TT lower because TT discovery
  // skews younger). Below the threshold we still treat it as non-original
  // music — a weaker skit signal than a viral trend but stronger than original.
  const audioUseCount = audioObj && Number.isFinite(audioObj.useCount) ? audioObj.useCount : 0;
  const audioIsLicensedMusic = audioObj ? audioObj.isOriginal === false : false;
  const audioIsTrending = audioObj
    ? (audioObj.isOriginal === false && audioUseCount >= 1000)
    : !!(post && post.audioIsTrending);
  const isDuet = !!(post && (post.isDuet || post.isStitch || post.parentPostId));
  const transcriptWords = transcript ? transcript.split(/\s+/).filter(Boolean).length : 0;
  const transcriptFirstPerson = transcript ? countMatches(transcript, /\b(i|i['’]m|i['’]ve|me|my|we)\b/g) : 0;
  const transcriptPastRatio = transcriptWords ? pastTense / Math.max(1, transcriptWords) : 0;

  return {
    caption_word_count: wordCount,
    caption_first_person: firstPerson,
    caption_past_tense: pastTense,
    bullet_lines: bulletLines.length,
    listicle_numerals: numerals,
    has_list_start: hasListStart,
    has_pov_prefix: hasPovPrefix,
    has_story_hashtag: hasStoryHashtag,
    has_pov_hashtag: hasPovHashtag,
    has_tutorial_hashtag: hasTutorialHashtag,
    has_duration: hasDuration,
    duration_sec: dur,
    audio_is_trending: audioIsTrending,
    audio_is_original: audioIsOriginal,
    audio_is_licensed_music: audioIsLicensedMusic,
    audio_use_count: audioUseCount,
    is_duet_or_stitch: isDuet,
    transcript_words: transcriptWords,
    transcript_first_person: transcriptFirstPerson,
    transcript_past_ratio: transcriptPastRatio,
    hashtags: Array.from(tags),
    lower,
    transcript,
  };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const addScore = (acc, label, delta) => {
  if (!delta) return;
  acc[label] = clamp01((acc[label] || 0) + delta);
};

export function scoreFormats(post) {
  const sig = FORMAT_SIGNALS(post);
  const lower = sig.lower;
  const trimmed = String((post && post.desc) || "").trim();
  const lowerTrimmed = trimmed.toLowerCase();
  const tx = sig.transcript;
  const out = {};

  // ---------- listicle ----------
  // Strong: digit-led caption ("5 things 👇"), bullet lines, "N things/ways/tips".
  if (sig.has_list_start) addScore(out, "listicle", 0.55);
  if (sig.bullet_lines >= 3) addScore(out, "listicle", 0.35);
  if (sig.bullet_lines >= 5) addScore(out, "listicle", 0.15);
  if (sig.listicle_numerals >= 1) addScore(out, "listicle", 0.45);
  if (/\btop\s*\d+\b/.test(lower)) addScore(out, "listicle", 0.30);

  // ---------- tutorial ----------
  // Strong: how-to / step / tutorial / guide language.
  if (/\bhow to\b/.test(lower)) addScore(out, "tutorial", 0.55);
  if (/\bstep\s*1\b/.test(lower) || /\bstep\s*one\b/.test(lower)) addScore(out, "tutorial", 0.45);
  if (/\btutorial\b/.test(lower) || /\bguide\b/.test(lower)) addScore(out, "tutorial", 0.35);
  if (sig.has_tutorial_hashtag) addScore(out, "tutorial", 0.30);
  if (tx && (/\bstep\s*1\b/.test(tx) || /\bstep\s*one\b/.test(tx))) addScore(out, "tutorial", 0.20);

  // ---------- beforeafter ----------
  if (/\bbefore\b/.test(lower) && /\bafter\b/.test(lower)) addScore(out, "beforeafter", 0.65);
  if (/\btransformation\b/.test(lower)) addScore(out, "beforeafter", 0.40);
  if (/\b(\d+)\s*(day|week|month|year)s?\s+(later|transformation|results)\b/.test(lower)) addScore(out, "beforeafter", 0.45);

  // ---------- dayinlife ----------
  if (/\bday in (my |the )?life\b/.test(lower)) addScore(out, "dayinlife", 0.75);
  if (/\bmorning routine\b/.test(lower) || /\bnight routine\b/.test(lower)) addScore(out, "dayinlife", 0.70);
  if (/\b(\d+)\s*am\s+routine\b/.test(lower)) addScore(out, "dayinlife", 0.50);
  if (/\bdaily routine\b/.test(lower)) addScore(out, "dayinlife", 0.45);

  // ---------- reaction ----------
  if (/\breact(ing|ion)?\b/.test(lower)) addScore(out, "reaction", 0.55);
  if (/\bmy thoughts on\b/.test(lower)) addScore(out, "reaction", 0.45);
  if (/\bnot me\s+\w+ing\b/.test(lower)) addScore(out, "reaction", 0.35);
  if (sig.is_duet_or_stitch) addScore(out, "reaction", 0.45);

  // ---------- hottake ----------
  // Important: "I'll say it" makes hottake dominate even on short first-person caps,
  // so the story-vs-hottake adversarial resolves correctly.
  if (/\bunpopular opinion\b/.test(lower)) addScore(out, "hottake", 0.80);
  if (/\bhot take\b/.test(lower)) addScore(out, "hottake", 0.75);
  if (/i['’]ll say it\b/.test(lower)) addScore(out, "hottake", 0.75);
  if (/\bcontroversial\b/.test(lower)) addScore(out, "hottake", 0.45);
  if (/\bnobody (is )?talk(s|ing) about\b/.test(lower)) addScore(out, "hottake", 0.30);

  // ---------- tip ----------
  if (/\btip:\s/.test(lower)) addScore(out, "tip", 0.55);
  if (/\bpro tip\b/.test(lower) || /\bquick tip\b/.test(lower)) addScore(out, "tip", 0.55);
  if (/^if you\s+\S+/.test(lowerTrimmed)) addScore(out, "tip", 0.30);

  // ---------- pov ----------
  if (sig.has_pov_prefix) addScore(out, "pov", 0.85);
  if (sig.has_pov_hashtag) addScore(out, "pov", 0.40);

  // ---------- story ----------
  // Multi-signal: first-person density + length + past-tense + #storytime.
  // Caps must allow co-firing with talking_head on "I tried this for 30 days..."
  // but stay below 0.7 unless caption is long-form.
  if (sig.caption_first_person >= 5 && sig.caption_word_count >= 40) addScore(out, "story", 0.55);
  else if (sig.caption_first_person >= 3 && sig.caption_word_count >= 25) addScore(out, "story", 0.35);
  else if (sig.caption_first_person >= 2 && sig.caption_word_count >= 12) addScore(out, "story", 0.20);
  if (sig.caption_past_tense >= 3) addScore(out, "story", 0.20);
  if (sig.caption_past_tense >= 5) addScore(out, "story", 0.15);
  if (sig.caption_word_count >= 80 && sig.caption_first_person >= 3) addScore(out, "story", 0.20);
  if (sig.has_story_hashtag) addScore(out, "story", 0.30);
  if (/\bstory\s*time\b/.test(lower)) addScore(out, "story", 0.30);
  if (/\b(when i was|so i|last (week|month|year|night)|a few (years|months|weeks) ago)\b/.test(lower)) addScore(out, "story", 0.30);
  if (sig.transcript_words >= 20 && sig.transcript_past_ratio >= 0.04) addScore(out, "story", 0.15);
  // Suppress story when listicle/hottake/tutorial signals are strong textually —
  // they can co-fire weakly but shouldn't dominate.
  if (out.listicle && out.listicle >= 0.55 && out.story) {
    out.story = clamp01(out.story * 0.5);
  }
  if (out.hottake && out.hottake >= 0.55 && out.story) {
    out.story = clamp01(out.story * 0.5);
  }

  // ---------- educational ----------
  // Lessons / explainers / why-things-work / save-this language.
  if (/\bhere['’]s why\b/.test(lower) || /\bthe (real )?reason\b/.test(lower)) addScore(out, "educational", 0.50);
  if (/\bthe truth about\b/.test(lower)) addScore(out, "educational", 0.45);
  if (/\bsave (this|for later)\b/.test(lower)) addScore(out, "educational", 0.30);
  if (/\bdid you know\b/.test(lower)) addScore(out, "educational", 0.40);
  if (/\bmost people (don'?t|dont) (know|realize)\b/.test(lower)) addScore(out, "educational", 0.45);
  if (/\b(why|how|what)\s+\w+\s+(works?|matters?|fails?)\b/.test(lower)) addScore(out, "educational", 0.35);
  if (out.tutorial && out.tutorial >= 0.5) addScore(out, "educational", 0.25);
  if (/\b(macros?|protein|hypertroph|deficit|hormones?|interest rate|inflation|algorithm|api|database)\b/.test(lower)) addScore(out, "educational", 0.20);

  // ---------- talking_head ----------
  // Hard to detect from text alone — strongest signal is "speaking-to-camera"
  // language + mid-length caption + non-trending audio + duration in talk range.
  // We give a baseline boost when educational fires (most educational shorts
  // are TH delivery), then trim back when skit/reaction/pov dominate.
  if (out.educational) addScore(out, "talking_head", out.educational * 0.7);
  if (out.tip) addScore(out, "talking_head", out.tip * 0.5);
  if (out.hottake) addScore(out, "talking_head", out.hottake * 0.4);
  if (sig.has_duration && sig.duration_sec >= 25 && sig.duration_sec <= 90) addScore(out, "talking_head", 0.25);
  if (sig.audio_is_original) addScore(out, "talking_head", 0.10);
  if (/\b(let me explain|listen|hear me out|i['’]m gonna tell you|the real answer)\b/.test(lower)) addScore(out, "talking_head", 0.30);

  // ---------- skit ----------
  // Trending audio + short duration + character/dialogue cues. Licensed music
  // (non-trending) is a weaker but still-useful signal — it indicates the post
  // is not a talking-head explainer.
  if (sig.audio_is_trending) addScore(out, "skit", 0.40);
  else if (sig.audio_is_licensed_music) addScore(out, "skit", 0.20);
  if (sig.has_duration && sig.duration_sec <= 20 && (sig.audio_is_trending || !sig.audio_is_original)) addScore(out, "skit", 0.25);
  if (/\bwait (for it|till the end)\b/.test(lower)) addScore(out, "skit", 0.30);
  if (/\bme:\s|\bhim:\s|\bher:\s|\bthem:\s/.test(lower)) addScore(out, "skit", 0.40);
  if (/\bwhen (you|your|he|she|they)\b/.test(lower) && sig.caption_word_count <= 20) addScore(out, "skit", 0.25);
  // "Educational skit" hybrid (Jeff Nippard analog): explicit lesson framing
  // alongside character/dialogue cues. Boost skit when both signals coexist.
  if (out.educational && /\bme:\s|\bcoach:\s|\bclient:\s|\bfriend:\s/.test(lower)) addScore(out, "skit", 0.30);
  if (out.educational && /\b(plot twist|but actually|here['’]s the catch)\b/.test(lower)) addScore(out, "skit", 0.25);

  // ---------- explainer ----------
  // Voiceover-style explanation, often with diagrams / b-roll. Hard from text.
  // Give a small boost when educational + tutorial both fire.
  if (out.educational && out.tutorial) addScore(out, "explainer", clamp01(out.educational * out.tutorial));
  if (/\bexplained\b/.test(lower)) addScore(out, "explainer", 0.45);
  if (/\bin (\d+) (seconds|minutes)\b/.test(lower)) addScore(out, "explainer", 0.30);

  // ---------- adversarial guards ----------
  // Empty/near-empty captions: ceiling everything at 0.4 except duration-driven
  // weak signals (skit from short+trending). Prevents emoji-only captions from
  // landing strong labels.
  if (sig.caption_word_count <= 2) {
    for (const k of Object.keys(out)) {
      out[k] = Math.min(out[k], 0.55);
    }
  }
  // Zero textual signal AND no audio metadata → nothing should be > 0.7.
  const noAudioInfo = !sig.audio_is_trending && !sig.audio_is_original && !sig.is_duet_or_stitch;
  if (sig.caption_word_count === 0 && noAudioInfo) {
    for (const k of Object.keys(out)) out[k] = Math.min(out[k], 0.4);
  }

  // Drop labels below the noise floor.
  for (const k of Object.keys(out)) {
    if (out[k] < 0.15) delete out[k];
  }
  return out;
}

// argmax helper used by callers that still want a single label.
export function topFormat(post) {
  const scores = scoreFormats(post);
  let best = "other", bestVal = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestVal) { best = k; bestVal = v; }
  }
  return bestVal > 0 ? best : "other";
}
