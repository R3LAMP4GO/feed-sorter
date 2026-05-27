// Profile-level parser — extracts bio / category / external_url / full_name
// from platform profile-info responses. Pure ESM (no DOM, no chrome APIs)
// so it's hermetic in tests and reusable from the content script.
//
// The IIFE runtime mirror lives at src/lib/profile-parser-runtime.js and
// must stay in lock-step. The pure module here is the spec.
//
// Why this exists: niche labeling currently embeds caption/transcript text
// from each creator's posts. For talking-head / sales / advice creators
// that misclassifies because the verbal content sounds generic ("hey
// guys, today I want to talk about…") even when the business is sharply
// vertical (real estate, fitness coaching, B2B SaaS). The bio almost
// always names the vertical directly ("Realtor® DRE#…", "Helping families
// find their dream home"). Capturing it lets clusterNiches use a much
// stronger signal — see "bio-first cascade" in background.js / cluster.js.

// ---------- shared helpers ----------
const stripStr = (s) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";

const normUser = (u) =>
  String(u || "").trim().toLowerCase().replace(/^@/, "");

// Caller-injectable text length cap. Bios are virtually always under 150
// chars on IG and under 80 on TT, so 500 is generous.
const MAX_BIO_CHARS = 500;
const cap = (s, n = MAX_BIO_CHARS) => (s && s.length > n ? s.slice(0, n) : s || "");

// ---------- Instagram ----------
//
// Endpoint: GET /api/v1/users/web_profile_info/?username=<username>
// Response shape (the bits we care about):
//   { data: { user: { username, full_name, biography, category_name,
//     business_category_name, external_url, external_lynx_url,
//     edge_followed_by: { count }, is_business_account, ... } },
//     status: "ok" }
//
// Some surface variations also nest the user object directly under the
// root (older `/api/v1/users/<id>/info/` form) — handle both.

const igUserFromBody = (body) => {
  if (!body || typeof body !== "object") return null;
  // Most common: { data: { user: {...} } }
  if (body.data?.user && typeof body.data.user === "object") return body.data.user;
  // Older shape: { user: {...} }
  if (body.user && typeof body.user === "object") return body.user;
  // Raw user already at root (some graphql variants).
  if (body.username && (body.biography != null || body.full_name != null)) return body;
  return null;
};

export function parseInstagramProfile(body) {
  const u = igUserFromBody(body);
  if (!u) return null;
  const username = normUser(u.username);
  if (!username) return null;
  const fullName = stripStr(u.full_name);
  const bio = cap(stripStr(u.biography));
  const category = stripStr(
    u.category_name || u.business_category_name || u.category || "",
  );
  const externalUrl = stripStr(
    u.external_url || u.external_lynx_url || u.bio_links?.[0]?.url || "",
  );
  const followerCount = Number.isFinite(u.edge_followed_by?.count)
    ? u.edge_followed_by.count
    : Number.isFinite(u.follower_count) ? u.follower_count : null;
  const isBusiness =
    typeof u.is_business_account === "boolean" ? u.is_business_account : null;
  return {
    platform: "instagram",
    username,
    fullName,
    bio,
    category,
    externalUrl,
    followerCount,
    isBusiness,
  };
}

// Returns true if the URL is one this parser knows how to handle.
export function isInstagramProfileInfoUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return /\/api\/v1\/users\/web_profile_info\//.test(url) ||
    // Older endpoint that returns the same `user` block:
    /\/api\/v1\/users\/[0-9]+\/info\//.test(url);
}

// ---------- TikTok ----------
//
// TikTok web embeds the user's signature (bio) in the initial HTML payload
// under window.__UNIVERSAL_DATA_FOR_REHYDRATION__ — not in any of the
// interceptable XHR/fetch endpoints we cover today. So for TT we expose a
// helper that takes a *DOM-extracted* JSON blob and returns the same shape.
// The content script's profile-page scraper passes it in.
//
// Shape: payload.userInfo.user = {
//   uniqueId, nickname, signature, verified, secUid,
//   bioLink: { link, risk }, ftc, ...
// }

const tikTokUserFromBody = (body) => {
  if (!body || typeof body !== "object") return null;
  // Mobile-API shape: { userInfo: { user: {...}, stats: {...} } }
  if (body.userInfo?.user && typeof body.userInfo.user === "object") {
    return { user: body.userInfo.user, stats: body.userInfo.stats || null };
  }
  // Web-rehydration shape: { __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo: { user, stats } } } }
  const scope = body.__DEFAULT_SCOPE__;
  if (scope && typeof scope === "object") {
    const ud = scope["webapp.user-detail"];
    if (ud?.userInfo?.user) {
      return { user: ud.userInfo.user, stats: ud.userInfo.stats || null };
    }
  }
  return null;
};

export function parseTikTokProfile(body) {
  const found = tikTokUserFromBody(body);
  if (!found) return null;
  const u = found.user;
  const username = normUser(u.uniqueId);
  if (!username) return null;
  const fullName = stripStr(u.nickname);
  const bio = cap(stripStr(u.signature));
  const externalUrl = stripStr(u.bioLink?.link || "");
  const followerCount = Number.isFinite(found.stats?.followerCount)
    ? found.stats.followerCount
    : null;
  return {
    platform: "tiktok",
    username,
    fullName,
    bio,
    category: "", // TT has no first-class category, only the free-form signature.
    externalUrl,
    followerCount,
    isBusiness: null,
  };
}

export function isTikTokProfileInfoUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return /\/api\/user\/detail\//.test(url);
}

// ---------- Multi-platform dispatch ----------
//
// Single entry the interceptor can call when it doesn't know yet which
// platform the response came from. Tries each parser; returns the first
// non-null result. Returns null if none matched (caller logs + drops).

export function parseProfile(body, hintUrl) {
  if (typeof hintUrl === "string") {
    if (isInstagramProfileInfoUrl(hintUrl)) return parseInstagramProfile(body);
    if (isTikTokProfileInfoUrl(hintUrl)) return parseTikTokProfile(body);
  }
  return parseInstagramProfile(body) || parseTikTokProfile(body);
}

// ---------- Niche-signal text builder ----------
//
// Concat fields we want to embed into a single string. Order matters: the
// bio carries the strongest vertical signal, category is the cleanest
// taxonomic anchor (when present), full name often contains a tagline
// ("Sarah | Real Estate Coach"), external URL hostname can hint at the
// vertical (acme-fitness.com, mortgage-pro.io).
//
// Returns "" when nothing is usable — caller falls back to caption text.
export function profileToNicheText(profile) {
  if (!profile || typeof profile !== "object") return "";
  const parts = [];
  if (profile.category) parts.push(profile.category);
  if (profile.fullName) parts.push(profile.fullName);
  if (profile.bio) parts.push(profile.bio);
  if (profile.externalUrl) {
    try {
      const host = new URL(profile.externalUrl).hostname.replace(/^www\./, "");
      if (host) parts.push(host);
    } catch {
      // Not a parseable URL — skip.
    }
  }
  return parts.join(" \u2022 ").trim();
}

// Test seam: count meaningful "words" (≥3 chars, alnum) in a niche-text.
// Used by the cascade to decide whether bio is rich enough to embed.
export function nicheTextWordCount(text) {
  if (!text) return 0;
  const m = String(text).toLowerCase().match(/[a-z0-9]{3,}/g);
  return m ? m.length : 0;
}
