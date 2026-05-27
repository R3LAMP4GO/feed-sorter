// Picks the embedding text source for one creator. The output is what
// `clusterNiches` (background.js / src/lib/cluster.js) feeds into MiniLM to
// place a creator in a niche cluster.
//
// Why a separate module: today the embed source is hardcoded to "top-N
// outlier captions + hooks" (see Cluster.buildCreatorVectors). That misclassifies
// talking-head creators whose business vertical is sharp (Realtor, B2B
// salesperson, fitness coach) but whose verbal hooks sound generic. The bio
// /category/external_url named the vertical directly and is virtually never
// captured in caption text. This module owns the source-selection cascade so
// the call site only needs to inject a profile lookup + the posts list.
//
// Cascade (first sufficient signal wins):
//   1. bio     — creator.bio / category / fullName / externalUrl host (≥ minBioWords)
//   2. captions — caption+hook text from top-N outlier posts (≥ minCaptionWords)
//   3. tags    — flattened "#tag #tag" string from N posts (≥ minHashtags)
//   4. none    — caller skips embedding this creator (gets "unlabeled" bucket)
//
// Returns:
//   { source: "bio" | "captions" | "tags" | "none",
//     text: string,
//     wordCount: number,
//     debug: { bioWords, captionWords, tagCount, ... }   // log payload
//   }
//
// Pure ESM. The IIFE mirror at src/lib/niche-signal-runtime.js stays in
// lock-step. Tests verify both copies against the same canonical fixtures.

const HASHTAG_RE = /#([\w_]+)/g;

const stripStr = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

// Re-exports the same word count rule profile-parser uses, so the cascade
// thresholds compare apples-to-apples no matter which source they're
// applied to.
export function wordCountAlnum(text) {
  if (!text) return 0;
  const m = String(text).toLowerCase().match(/[a-z0-9]{3,}/g);
  return m ? m.length : 0;
}

// Build niche-text from a profile-like blob (bio, category, etc.). Caller
// can pass `creator` directly (denormalized profile fields) OR an explicit
// profile object — same shape either way.
export function profileToNicheText(p) {
  if (!p || typeof p !== "object") return "";
  const parts = [];
  if (p.category) parts.push(stripStr(p.category));
  if (p.fullName) parts.push(stripStr(p.fullName));
  if (p.bio) parts.push(stripStr(p.bio));
  if (p.externalUrl) {
    try {
      const host = new URL(p.externalUrl).hostname.replace(/^www\./, "");
      if (host) parts.push(host);
    } catch { /* skip */ }
  }
  return parts.filter(Boolean).join(" \u2022 ").trim();
}

const extractHook = (desc) =>
  String(desc || "").split("\n")[0].slice(0, 200).trim();

// Caption+hook text for a single post (hook weighted ~2× by appearing first
// and again in the body). Mirrors src/lib/cluster.js captionPlusHook().
const captionPlusHookOne = (post) => {
  const desc = String(post?.desc || post?.caption || "").trim();
  if (!desc) return "";
  const hook = extractHook(desc);
  return `${hook}\n${desc}`;
};

// Pick top-N posts by per-author outlier score (likes ÷ author median).
const topOutlierTexts = (posts, n) => {
  const byA = new Map();
  for (const p of posts) {
    if (!p?.author) continue;
    if (!byA.has(p.author)) byA.set(p.author, []);
    byA.get(p.author).push(Number(p.likes || 0));
  }
  const med = new Map();
  for (const [a, vs] of byA) {
    const s = [...vs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    med.set(a, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  }
  return posts
    .filter((p) => p && (p.desc || p.caption || "").toString().trim().length > 0)
    .map((p) => {
      const base = med.get(p.author) || 0;
      const score = base > 0 ? (Number(p.likes || 0) / base) : Number(p.likes || 0);
      return { p, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => captionPlusHookOne(x.p))
    .filter(Boolean);
};

const flattenTags = (posts, n) => {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    if (!p) continue;
    let tags = [];
    if (Array.isArray(p.hashtags)) {
      tags = p.hashtags.map((t) => String(t).replace(/^#/, "").toLowerCase()).filter(Boolean);
    } else {
      const s = String(p.desc || p.caption || "");
      HASHTAG_RE.lastIndex = 0;
      let m;
      while ((m = HASHTAG_RE.exec(s))) tags.push(String(m[1] || "").toLowerCase());
    }
    for (const t of tags) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(`#${t}`);
      if (out.length >= n) return out;
    }
  }
  return out;
};

const DEFAULTS = Object.freeze({
  minBioWords: 4,       // "Realtor® in SF" is 3 — bump just above that so single-noun bios fall through.
  minCaptionWords: 6,   // captionPlusHook with a 12-word hook is ~6 alnum tokens after stopword-thinning.
  minHashtags: 2,       // 2+ tags is enough to disambiguate, 1 isn't.
  topN: 20,             // top-N outlier captions to concat for the captions source.
});

// Entry point. `creator` carries denormalized bio/category fields (from the
// store.creators row); `posts` is that creator's posts (caller usually
// passes byAuthor.get(username) from clusterNiches).
//
// Caller can override thresholds via opts; tests pin tiny thresholds to
// exercise each branch.
export function pickNicheSignal(creator, posts, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const safePosts = Array.isArray(posts) ? posts : [];

  // ----- Branch 1: bio -----
  const bioText = profileToNicheText(creator);
  const bioWords = wordCountAlnum(bioText);

  // ----- Branch 2: captions+hook -----
  const captionTexts = topOutlierTexts(safePosts, o.topN);
  const captionBlob = captionTexts.join("\n\n");
  const captionWords = wordCountAlnum(captionBlob);

  // ----- Branch 3: tags -----
  const tagList = flattenTags(safePosts, 30);
  const tagCount = tagList.length;
  const tagBlob = tagList.join(" ");

  const debug = {
    username: creator?.username || null,
    bioPresent: !!bioText,
    bioWords,
    captionPosts: captionTexts.length,
    captionWords,
    tagCount,
    pinned: !!(creator?.nichePinned),
    pinnedLabel: creator?.nichePinned && creator.niche ? creator.niche : null,
  };

  if (bioWords >= o.minBioWords) {
    return { source: "bio", text: bioText, wordCount: bioWords, debug };
  }
  if (captionWords >= o.minCaptionWords) {
    return { source: "captions", text: captionBlob, wordCount: captionWords, debug };
  }
  if (tagCount >= o.minHashtags) {
    return { source: "tags", text: tagBlob, wordCount: tagCount, debug };
  }
  return { source: "none", text: "", wordCount: 0, debug };
}

// Test seam: surface defaults so the runtime mirror can assert parity.
export const __defaults = DEFAULTS;
