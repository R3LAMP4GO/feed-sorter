// IIFE mirror of src/lib/niche-signal.js — must stay in lock-step.
// Exposes globalThis.__fsNicheSignal = { pickNicheSignal, profileToNicheText,
//   wordCountAlnum, DEFAULTS }.

(function attach(global) {
  if (global.__fsNicheSignal) return;

  const HASHTAG_RE = /#([\w_]+)/g;
  const stripStr = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

  function wordCountAlnum(text) {
    if (!text) return 0;
    const m = String(text).toLowerCase().match(/[a-z0-9]{3,}/g);
    return m ? m.length : 0;
  }

  function profileToNicheText(p) {
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

  const extractHook = (desc) => String(desc || "").split("\n")[0].slice(0, 200).trim();
  const captionPlusHookOne = (post) => {
    const desc = String((post && (post.desc || post.caption)) || "").trim();
    if (!desc) return "";
    const hook = extractHook(desc);
    return `${hook}\n${desc}`;
  };

  const topOutlierTexts = (posts, n) => {
    const byA = new Map();
    for (const p of posts) {
      if (!p || !p.author) continue;
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
    minBioWords: 4,
    minCaptionWords: 6,
    minHashtags: 2,
    topN: 20,
  });

  function pickNicheSignal(creator, posts, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const safePosts = Array.isArray(posts) ? posts : [];
    const bioText = profileToNicheText(creator);
    const bioWords = wordCountAlnum(bioText);
    const captionTexts = topOutlierTexts(safePosts, o.topN);
    const captionBlob = captionTexts.join("\n\n");
    const captionWords = wordCountAlnum(captionBlob);
    const tagList = flattenTags(safePosts, 30);
    const tagCount = tagList.length;
    const tagBlob = tagList.join(" ");
    const debug = {
      username: (creator?.username) || null,
      bioPresent: !!bioText,
      bioWords,
      captionPosts: captionTexts.length,
      captionWords,
      tagCount,
      pinned: !!(creator?.nichePinned),
      pinnedLabel: creator?.nichePinned && creator.niche ? creator.niche : null,
    };
    if (bioWords >= o.minBioWords) return { source: "bio", text: bioText, wordCount: bioWords, debug };
    if (captionWords >= o.minCaptionWords) return { source: "captions", text: captionBlob, wordCount: captionWords, debug };
    if (tagCount >= o.minHashtags) return { source: "tags", text: tagBlob, wordCount: tagCount, debug };
    return { source: "none", text: "", wordCount: 0, debug };
  }

  global.__fsNicheSignal = { pickNicheSignal, profileToNicheText, wordCountAlnum, DEFAULTS };
})(typeof self !== "undefined" ? self : this);
