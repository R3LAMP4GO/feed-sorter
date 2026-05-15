// IIFE mirror of src/lib/profile-parser.js for content-script + service-worker
// consumption. MV3 content scripts can't import ES modules — keep this in
// lock-step with the pure module. Tests live against the pure module.
//
// Exposes globalThis.__fsProfileParser = {
//   parseInstagramProfile, parseTikTokProfile, parseProfile,
//   isInstagramProfileInfoUrl, isTikTokProfileInfoUrl,
//   profileToNicheText, nicheTextWordCount,
// }.

(function attach(global) {
  if (global.__fsProfileParser) return;

  const stripStr = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
  const normUser = (u) => String(u || "").trim().toLowerCase().replace(/^@/, "");
  const MAX_BIO_CHARS = 500;
  const cap = (s, n = MAX_BIO_CHARS) => (s && s.length > n ? s.slice(0, n) : s || "");

  const igUserFromBody = (body) => {
    if (!body || typeof body !== "object") return null;
    if (body.data && body.data.user && typeof body.data.user === "object") return body.data.user;
    if (body.user && typeof body.user === "object") return body.user;
    if (body.username && (body.biography != null || body.full_name != null)) return body;
    return null;
  };

  function parseInstagramProfile(body) {
    const u = igUserFromBody(body);
    if (!u) return null;
    const username = normUser(u.username);
    if (!username) return null;
    const fullName = stripStr(u.full_name);
    const bio = cap(stripStr(u.biography));
    const category = stripStr(u.category_name || u.business_category_name || u.category || "");
    const externalUrl = stripStr(
      u.external_url || u.external_lynx_url || (u.bio_links && u.bio_links[0] && u.bio_links[0].url) || "",
    );
    const followerCount = Number.isFinite(u.edge_followed_by && u.edge_followed_by.count)
      ? u.edge_followed_by.count
      : Number.isFinite(u.follower_count) ? u.follower_count : null;
    const isBusiness = typeof u.is_business_account === "boolean" ? u.is_business_account : null;
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

  function isInstagramProfileInfoUrl(url) {
    if (typeof url !== "string" || !url) return false;
    return /\/api\/v1\/users\/web_profile_info\//.test(url) ||
      /\/api\/v1\/users\/[0-9]+\/info\//.test(url);
  }

  const tikTokUserFromBody = (body) => {
    if (!body || typeof body !== "object") return null;
    if (body.userInfo && body.userInfo.user && typeof body.userInfo.user === "object") {
      return { user: body.userInfo.user, stats: body.userInfo.stats || null };
    }
    const scope = body.__DEFAULT_SCOPE__;
    if (scope && typeof scope === "object") {
      const ud = scope["webapp.user-detail"];
      if (ud && ud.userInfo && ud.userInfo.user) {
        return { user: ud.userInfo.user, stats: ud.userInfo.stats || null };
      }
    }
    return null;
  };

  function parseTikTokProfile(body) {
    const found = tikTokUserFromBody(body);
    if (!found) return null;
    const u = found.user;
    const username = normUser(u.uniqueId);
    if (!username) return null;
    const fullName = stripStr(u.nickname);
    const bio = cap(stripStr(u.signature));
    const externalUrl = stripStr((u.bioLink && u.bioLink.link) || "");
    const followerCount = Number.isFinite(found.stats && found.stats.followerCount)
      ? found.stats.followerCount
      : null;
    return {
      platform: "tiktok",
      username,
      fullName,
      bio,
      category: "",
      externalUrl,
      followerCount,
      isBusiness: null,
    };
  }

  function isTikTokProfileInfoUrl(url) {
    if (typeof url !== "string" || !url) return false;
    return /\/api\/user\/detail\//.test(url);
  }

  function parseProfile(body, hintUrl) {
    if (typeof hintUrl === "string") {
      if (isInstagramProfileInfoUrl(hintUrl)) return parseInstagramProfile(body);
      if (isTikTokProfileInfoUrl(hintUrl)) return parseTikTokProfile(body);
    }
    return parseInstagramProfile(body) || parseTikTokProfile(body);
  }

  function profileToNicheText(profile) {
    if (!profile || typeof profile !== "object") return "";
    const parts = [];
    if (profile.category) parts.push(profile.category);
    if (profile.fullName) parts.push(profile.fullName);
    if (profile.bio) parts.push(profile.bio);
    if (profile.externalUrl) {
      try {
        const host = new URL(profile.externalUrl).hostname.replace(/^www\./, "");
        if (host) parts.push(host);
      } catch { /* skip */ }
    }
    return parts.join(" \u2022 ").trim();
  }

  function nicheTextWordCount(text) {
    if (!text) return 0;
    const m = String(text).toLowerCase().match(/[a-z0-9]{3,}/g);
    return m ? m.length : 0;
  }

  global.__fsProfileParser = {
    parseInstagramProfile,
    parseTikTokProfile,
    parseProfile,
    isInstagramProfileInfoUrl,
    isTikTokProfileInfoUrl,
    profileToNicheText,
    nicheTextWordCount,
  };
})(typeof self !== "undefined" ? self : this);
