// Page-scope detection for TikTok URL pathnames. Pure.
// TikTok profile URLs are `/@{username}` (the `@` is part of the path).
// Video permalinks carry videoId so content.js can reject prefetched neighbors.

export const RESERVED = new Set([
  "explore","foryou","following","live","upload","music","tag","trending",
  "discover","video","login","signup","about","embed","node","share",
  "feedback","legal","setting","creators","business","passport","api",
  "ajax","aweme","captcha","tiktokstudio",
]);

/** @returns {{ kind: "profile"|"explore"|"other", username: string|null, videoId: string|null }} */
export const deriveScope = (pathname = "/") => {
  const path = pathname || "/";
  if (path === "/" || path === "/explore" || path.startsWith("/explore/")) {
    return { kind: "explore", username: null, videoId: null };
  }
  if (path === "/foryou" || path.startsWith("/foryou/")) {
    return { kind: "explore", username: null, videoId: null };
  }
  // /@{username}  or  /@{username}/
  const m = path.match(/^\/@([\w.][\w._-]*[\w])\/?$/);
  if (m) {
    const u = m[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u, videoId: null };
  }
  // /@{username}/video/{id}  → profile scope, constrained to the visible video.
  const m2 = path.match(/^\/@([\w.][\w._-]*[\w])\/(?:video|live)\/([0-9A-Za-z_-]+)/);
  if (m2) {
    const u = m2[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u, videoId: m2[2] };
  }
  return { kind: "other", username: null, videoId: null };
};
