// Page-scope detection for TikTok URL pathnames. Pure.
// TikTok profile URLs are `/@{username}` (the `@` is part of the path).

export const RESERVED = new Set([
  "explore","foryou","following","live","upload","music","tag","trending",
  "discover","video","login","signup","about","embed","node","share",
  "feedback","legal","setting","creators","business","passport","api",
  "ajax","aweme","captcha","tiktokstudio",
]);

/** @returns {{ kind: "profile"|"explore"|"other", username: string|null }} */
export const deriveScope = (pathname = "/") => {
  const path = pathname || "/";
  if (path === "/explore" || path.startsWith("/explore/")) {
    return { kind: "explore", username: null };
  }
  if (path === "/foryou" || path.startsWith("/foryou/")) {
    return { kind: "explore", username: null };
  }
  // /@{username}  or  /@{username}/
  const m = path.match(/^\/@([\w.][\w._-]*[\w])\/?$/);
  if (m) {
    const u = m[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u };
  }
  // /@{username}/video/{id}  → still scoped to that profile
  const m2 = path.match(/^\/@([\w.][\w._-]*[\w])\/(?:video|live)\//);
  if (m2) {
    const u = m2[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u };
  }
  return { kind: "other", username: null };
};
