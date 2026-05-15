// Platform dispatcher (ESM). Pure — no DOM, no chrome APIs.
// Maps a hostname to a bundle of parser + scope detector + URL helpers
// + IDB / CSV / download conventions. The runtime mirror lives at
// src/lib/platform-runtime.js (IIFE) and stays in lock-step.

import * as parserIg from "./parser.js";
import * as scopeIg from "./scope.js";
import * as parserTt from "./parser-tiktok.js";
import * as scopeTt from "./scope-tiktok.js";
import * as parserYt from "./parser-youtube.js";
import * as scopeYt from "./scope-youtube.js";

export const PLATFORMS = Object.freeze({
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  YOUTUBE: "youtube",
});

/** @returns {"instagram"|"tiktok"|"youtube"|null} */
export const detectPlatform = (host = "") => {
  const h = String(host || "").toLowerCase();
  if (/(^|\.)tiktok\.com$/.test(h)) return PLATFORMS.TIKTOK;
  if (/(^|\.)instagram\.com$/.test(h)) return PLATFORMS.INSTAGRAM;
  if (/(^|\.)youtube\.com$/.test(h)) return PLATFORMS.YOUTUBE;
  return null;
};

// --- Collect strategies -----------------------------------------------------
//
// Two flavors:
//   - "scroll" (default): page-scroll until scrollHeight stalls. Used by IG
//     profile/explore, TT profile/foryou, YT channel /@handle/shorts grid.
//   - "snap":   advance the YT Shorts vertical-snap player by clicking
//     #navigation-button-down. Used on /shorts/<id> + /feed/shorts.
//
// Each strategy is a pure factory:
//   { advance({ doc }) -> boolean,  // false = no-op (end of feed signal)
//     useScrollHeightStall: boolean,
//     kind: 'scroll' | 'snap' }
//
// `advance` reads only from the injected `doc`, never globalThis.document, so
// tests can pass a stub document.

const SCROLL_STRATEGY = Object.freeze({
  kind: "scroll",
  useScrollHeightStall: true,
  advance({ doc } = {}) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.documentElement) return false;
    const w = d.defaultView || (typeof window !== "undefined" ? window : null);
    if (!w || typeof w.scrollTo !== "function") return false;
    w.scrollTo(0, d.documentElement.scrollHeight || 0);
    return true;
  },
});

// Selector tiers, in order of preference. Mirrors the patterns used by
// Tyson3101/Auto-Youtube-Shorts-Scroller, SoRadGaming, and YouTube-Enhancer:
// the canonical next-button is `#navigation-button-down`, scoped to the
// currently-active reel renderer when possible.
const YT_NEXT_BUTTON_SELECTORS = Object.freeze([
  "ytd-reel-video-renderer[is-active] #navigation-button-down button",
  "#navigation-button-down ytd-button-renderer button",
  "#navigation-button-down button",
]);

const YT_SNAP_STRATEGY = Object.freeze({
  kind: "snap",
  useScrollHeightStall: false,
  advance({ doc } = {}) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || typeof d.querySelector !== "function") return false;
    for (const sel of YT_NEXT_BUTTON_SELECTORS) {
      const btn = d.querySelector(sel);
      if (btn && typeof btn.click === "function" && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    return false;
  },
});

const defaultCollectStrategy = () => SCROLL_STRATEGY;

const igConfig = {
  platform: PLATFORMS.INSTAGRAM,
  parser: parserIg,
  scope: scopeIg,
  postIdPrefix: "ig_",
  csvPrefix: "ig",
  downloadFolder: "feed-sorter-ig",
  surfaces: ["profile", "reels", "explore", "graphql"],
  collectStrategy: defaultCollectStrategy,
  postUrl: (post) => {
    if (!post) return "";
    if (post.url) return post.url;
    const sc = post.shortcode || "";
    if (!sc) return "";
    return `https://www.instagram.com/${post.isReel ? "reel" : "p"}/${sc}/`;
  },
  profileUrl: (username) =>
    username ? `https://www.instagram.com/${username}/` : "https://www.instagram.com/",
  audioUrl: (audioId) =>
    audioId ? `https://www.instagram.com/reels/audio/${encodeURIComponent(audioId)}/` : "",
};

const ttConfig = {
  platform: PLATFORMS.TIKTOK,
  parser: parserTt,
  scope: scopeTt,
  postIdPrefix: "tt_",
  csvPrefix: "tt",
  downloadFolder: "feed-sorter-tt",
  surfaces: ["profile", "foryou", "explore", "related"],
  collectStrategy: defaultCollectStrategy,
  postUrl: (post) => {
    if (!post) return "";
    if (post.url) return post.url;
    const native = String(post.nativeId || post.shortcode || post.id || "").replace(/^tt_/, "");
    const author = post.author || "";
    if (!native || !author) return "";
    return `https://www.tiktok.com/@${author}/video/${native}`;
  },
  profileUrl: (username) =>
    username ? `https://www.tiktok.com/@${username}` : "https://www.tiktok.com/",
  audioUrl: (audioId) =>
    audioId ? `https://www.tiktok.com/music/-${encodeURIComponent(audioId)}` : "",
};

const ytConfig = {
  platform: PLATFORMS.YOUTUBE,
  parser: parserYt,
  scope: scopeYt,
  postIdPrefix: "yt_",
  csvPrefix: "yt",
  downloadFolder: "feed-sorter-yt",
  surfaces: ["profile", "shorts-feed", "search"],
  // Snap player on /shorts/<id> + /feed/shorts; classic page-scroll
  // everywhere else (channel /@handle/shorts grid, search, profile tabs).
  collectStrategy: (pageScope) =>
    pageScope && pageScope.kind === "shorts-feed" ? YT_SNAP_STRATEGY : SCROLL_STRATEGY,
  postUrl: (post) => {
    if (!post) return "";
    if (post.url) return post.url;
    const native = String(post.nativeId || post.shortcode || post.id || "").replace(/^yt_/, "");
    return native ? `https://www.youtube.com/shorts/${native}` : "";
  },
  profileUrl: (username) =>
    username ? `https://www.youtube.com/@${username}` : "https://www.youtube.com/",
  audioUrl: () => "",
};

export const getConfig = (platform) => {
  if (platform === PLATFORMS.TIKTOK) return ttConfig;
  if (platform === PLATFORMS.INSTAGRAM) return igConfig;
  if (platform === PLATFORMS.YOUTUBE) return ytConfig;
  return null;
};

export const configForHost = (host) => {
  const p = detectPlatform(host);
  return p ? getConfig(p) : null;
};
