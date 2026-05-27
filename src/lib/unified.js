// Cross-platform unified post schema.
//
// This module is the single source of truth for the row shape that every
// feed-sorter extension (Instagram, TikTok, YouTube Shorts) writes to the
// shared sink (Airtable / Sheets / Notion / webhook). Keeping the shape
// identical lets a single dashboard read all platforms together.
//
// Loaded twice:
//   1. As a content/extension script via plain <script> — exposes
//      `window.__fsUnified`.
//   2. As an ES module from the dashboard page — `import { ... } from
//      './lib/unified.js'`.
//
// SCHEMA VERSION — bump on every breaking change. Sinks should write this
// alongside the row so the dashboard can detect drift.
//
//   { schemaVersion: 1,
//     platform:      "instagram" | "tiktok" | "youtube_shorts",
//     id:            string,        // platform-native id, globally-unique within platform
//     author:        string,        // @handle, no leading @
//     url:           string,        // canonical post URL
//     createTime:    number,        // unix seconds (UTC)
//     views:         number,        // 0 if unknown
//     likes:         number,
//     comments:      number,
//     shares:        number,        // 0 on platforms that don't expose it (IG)
//     saves:         number,        // 0 on platforms that don't expose it
//     durationSec:   number,        // 0 for image posts
//     transcript:    string,        // "" if not transcribed yet
//     hookType:      string,        // free-form tag from hook classifier
//     score:         number,        // outlier multiple (post / per-author median)
//     scoreBasis:    "author" | "global" | "",
//     sourceExtensionVersion: string, // "ig@0.1.0" / "tt@0.3.2" / etc.
//     capturedAt:    number,        // unix ms when the row was captured
//   }
//
// Adapters live next to each platform's parser and MUST emit this exact
// shape. Field types are checked at runtime by `validateUnified` to catch
// silent regressions.

// NOTE: this file is loaded as a classic <script> in both the content
// script context and the dashboard page. It must NOT use ES module
// syntax — it registers itself on globalThis.__fsUnified instead.
((root) => {
  const mod = (() => {
  const SCHEMA_VERSION = 1;

  const PLATFORMS = Object.freeze({
    INSTAGRAM: "instagram",
    TIKTOK: "tiktok",
    YOUTUBE_SHORTS: "youtube_shorts",
  });

  const FIELDS = Object.freeze([
    "schemaVersion",
    "platform",
    "id",
    "author",
    "url",
    "createTime",
    "views",
    "likes",
    "comments",
    "shares",
    "saves",
    "durationSec",
    "transcript",
    "hookType",
    "score",
    "scoreBasis",
    "sourceExtensionVersion",
    "capturedAt",
  ]);

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const str = (v) => (v == null ? "" : String(v));

  /**
   * Build a UnifiedPost from raw fields. Pass everything you have; missing
   * fields get safe defaults. Throws if id / platform are missing.
   */
  function makeUnified(input) {
    if (!input || typeof input !== "object") {
      throw new Error("makeUnified: input required");
    }
    const platform = str(input.platform);
    if (!Object.values(PLATFORMS).includes(platform)) {
      throw new Error(`makeUnified: unknown platform "${platform}"`);
    }
    const id = str(input.id);
    if (!id) throw new Error("makeUnified: id required");

    const out = {
      schemaVersion: SCHEMA_VERSION,
      platform,
      id,
      author: str(input.author).replace(/^@+/, ""),
      url: str(input.url),
      createTime: num(input.createTime),
      views: num(input.views),
      likes: num(input.likes),
      comments: num(input.comments),
      shares: num(input.shares),
      saves: num(input.saves),
      durationSec: num(input.durationSec),
      transcript: str(input.transcript),
      hookType: str(input.hookType),
      score: Number.isFinite(input.score) ? Number(input.score) : 0,
      scoreBasis: ["author", "global", ""].includes(input.scoreBasis)
        ? input.scoreBasis
        : "",
      sourceExtensionVersion: str(input.sourceExtensionVersion),
      capturedAt: num(input.capturedAt) || Date.now(),
    };
    return out;
  }

  /**
   * Lightweight runtime validation. Returns a list of error strings; empty
   * means valid. Doesn't throw — caller decides whether to drop or warn.
   */
  function validateUnified(u) {
    const errs = [];
    if (!u || typeof u !== "object") return ["not an object"];
    if (u.schemaVersion !== SCHEMA_VERSION) {
      errs.push(`schemaVersion ${u.schemaVersion} != ${SCHEMA_VERSION}`);
    }
    if (!Object.values(PLATFORMS).includes(u.platform)) {
      errs.push(`bad platform: ${u.platform}`);
    }
    if (!u.id) errs.push("missing id");
    for (const k of ["createTime", "views", "likes", "comments", "shares", "saves", "durationSec", "score", "capturedAt"]) {
      if (!Number.isFinite(u[k])) errs.push(`${k} not finite`);
    }
    return errs;
  }

  // ------------------------------------------------------------------
  // Instagram adapter — Post (from content.js toPost) → UnifiedPost.
  // The shape of `p` is the row stored in IndexedDB by the IG extension.
  // ------------------------------------------------------------------
  function fromInstagramPost(p, ctx) {
    if (!p) return null;
    const c = ctx || {};
    return makeUnified({
      platform: PLATFORMS.INSTAGRAM,
      id: `ig_${p.id}`,
      author: p.author || "",
      url: p.url || (p.shortcode
        ? `https://www.instagram.com/${p.isReel ? "reel" : "p"}/${p.shortcode}/`
        : ""),
      createTime: p.createTime,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      // IG never exposes share/save counts in the surfaces we scrape.
      shares: 0,
      saves: 0,
      durationSec: p.videoDuration || 0,
      transcript: p.transcript || "",
      hookType: p.hookType || p.hook || "",
      score: p._score || p.score || 0,
      scoreBasis: p._scoreBasis || "",
      sourceExtensionVersion: c.extensionVersion
        ? `ig@${c.extensionVersion}`
        : "ig@unknown",
      capturedAt: p.capturedAt || Date.now(),
    });
  }

  // ------------------------------------------------------------------
  // Airtable mapping. The unified table should be a SEPARATE table from
  // the per-platform legacy tables — name suggested: `UnifiedPosts`.
  //
  // Required fields (case-sensitive) — see docs/UNIFIED_SCHEMA.md:
  //   id (Single line text, primary, merge key)
  //   platform (Single select: instagram, tiktok, youtube_shorts)
  //   author, url, hookType, scoreBasis, sourceExtensionVersion, transcript (text)
  //   createTime, views, likes, comments, shares, saves, durationSec, score, schemaVersion (number)
  //   capturedAt, createdAt (date w/ time, ISO accepted)
  // ------------------------------------------------------------------
  function unifiedToAirtableFields(u) {
    return {
      id: u.id,
      platform: u.platform,
      author: u.author,
      url: u.url,
      createTime: u.createTime,
      createdAt: u.createTime ? new Date(u.createTime * 1000).toISOString() : undefined,
      views: u.views,
      likes: u.likes,
      comments: u.comments,
      shares: u.shares,
      saves: u.saves,
      durationSec: u.durationSec,
      transcript: u.transcript || undefined,
      hookType: u.hookType || undefined,
      score: u.score,
      scoreBasis: u.scoreBasis || undefined,
      sourceExtensionVersion: u.sourceExtensionVersion,
      capturedAt: u.capturedAt
        ? new Date(u.capturedAt).toISOString()
        : undefined,
      schemaVersion: u.schemaVersion,
    };
  }

  // ------------------------------------------------------------------
  // Cross-platform outlier scoring. The dashboard re-computes `score`
  // across the full unified set (not just the in-memory IG view) using a
  // PER-PLATFORM median — IG view counts and TikTok view counts aren't
  // comparable in absolute terms, but their multiples-vs-platform-median
  // are. Same metric formula as src/lib/scoring.js.
  // ------------------------------------------------------------------
  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function computeCrossPlatformOutliers(rows, metric) {
    const m = metric || "views";
    const byPlatform = new Map(); // platform -> [vals]
    for (const r of rows) {
      const v = Number(r[m]) || 0;
      if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
      if (v > 0) byPlatform.get(r.platform).push(v);
    }
    const meds = new Map();
    for (const [p, vals] of byPlatform) meds.set(p, median(vals));

    return rows.map((r) => {
      const baseline = meds.get(r.platform) || 0;
      const v = Number(r[m]) || 0;
      const score = baseline > 0 ? v / baseline : 0;
      return { ...r, _score: score, _baseline: baseline, _metric: m };
    });
  }

  return {
    SCHEMA_VERSION,
    PLATFORMS,
    FIELDS,
    makeUnified,
    validateUnified,
    fromInstagramPost,
    unifiedToAirtableFields,
    computeCrossPlatformOutliers,
    median,
  };
})();
  root.__fsUnified = mod;
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
})(typeof globalThis !== "undefined" ? globalThis : this);
