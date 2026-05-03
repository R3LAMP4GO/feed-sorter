// Page-scope detection from URL pathname. Pure.

export const RESERVED = new Set([
  "explore","reels","direct","accounts","p","reel","stories","tv","about",
  "settings","challenge","web","api","graphql","ajax","oauth","legal",
  "press","developer",
]);

/** @returns {{ kind: "profile"|"explore"|"other", username: string|null }} */
export const deriveScope = (pathname = "/") => {
  const path = pathname || "/";
  if (path === "/explore" || path.startsWith("/explore/")) {
    return { kind: "explore", username: null };
  }
  // /{username}/  or  /{username}/reels/
  const m = path.match(/^\/([\w.][\w.]*[\w])\/(?:reels\/?)?$/);
  if (m) {
    const u = m[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u };
  }
  // single-segment edge case (`/foo`)
  const m2 = path.match(/^\/([\w.][\w.]*[\w])\/?$/);
  if (m2) {
    const u = m2[1].toLowerCase();
    if (!RESERVED.has(u)) return { kind: "profile", username: u };
  }
  return { kind: "other", username: null };
};
