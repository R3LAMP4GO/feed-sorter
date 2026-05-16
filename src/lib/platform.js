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
//     profile/explore, TT profile, and YT channel /@handle/shorts grid.
//   - "snap":   advance a fixed-height vertical player by clicking/pressing
//     the next-video control. Used on TT For You/Explore and YT Shorts.
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
  useIdleEnd: false,
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
    const w = d.defaultView || (typeof window !== "undefined" ? window : null);
    const amount = Math.max(1, w?.innerHeight || d.documentElement?.clientHeight || 900);
    const sentArrowDown = [d.activeElement, d.body, d.documentElement, w]
      .map((target) => dispatchArrowDown(target))
      .some(Boolean);
    const sentWheel = dispatchWheelDown(d, amount);
    if (w && typeof w.scrollBy === "function") {
      w.scrollBy(0, amount);
      return true;
    }
    return sentArrowDown || sentWheel;
  },
});

const TT_NEXT_BUTTON_SELECTORS = Object.freeze([
  'button[data-e2e="arrow-right"]',
  'button[data-e2e="arrow-down"]',
  '[data-e2e="arrow-right"] button',
  '[data-e2e="arrow-down"] button',
  'button[aria-label="Go to next video"]',
  'button[aria-label="Next video"]',
  'button[aria-label="next video"]',
  'button[aria-label="Scroll down"]',
  'button[aria-label="Next"]',
  'button[title="Next"]',
  'svg path[d^="m24 27.76"]',
  'svg path[d^="M24 27.76"]',
]);

const buttonForSelector = (doc, selector) => {
  const el = doc.querySelector(selector);
  if (!el) return null;
  return el.closest?.("button") || el;
};

const isDisabledButton = (btn) =>
  !!(
    !btn ||
    btn.disabled ||
    btn.getAttribute?.("aria-disabled") === "true" ||
    btn.getAttribute?.("disabled") != null
  );

const dispatchArrowDown = (target) => {
  if (!target || typeof target.dispatchEvent !== "function") return false;
  const KeyboardEventCtor =
    target.KeyboardEvent || (typeof KeyboardEvent !== "undefined" ? KeyboardEvent : null);
  if (!KeyboardEventCtor) return false;
  const opts = {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    which: 40,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEventCtor("keydown", opts));
  target.dispatchEvent(new KeyboardEventCtor("keyup", opts));
  return true;
};

const dispatchWheelDown = (doc, amount) => {
  const w = doc.defaultView || (typeof window !== "undefined" ? window : null);
  const WheelEventCtor = w?.WheelEvent || (typeof WheelEvent !== "undefined" ? WheelEvent : null);
  if (!WheelEventCtor) return false;
  const targets = [];
  const add = (el) => {
    if (el && typeof el.dispatchEvent === "function" && !targets.includes(el)) targets.push(el);
  };
  add(doc.activeElement);
  if (typeof doc.elementFromPoint === "function" && w) {
    add(doc.elementFromPoint(Math.floor((w.innerWidth || 1200) / 2), Math.floor((w.innerHeight || 900) / 2)));
  }
  add(doc.body);
  add(doc.documentElement);
  add(w);
  const opts = {
    deltaY: amount,
    deltaX: 0,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
    clientX: Math.floor((w?.innerWidth || 1200) / 2),
    clientY: Math.floor((w?.innerHeight || 900) / 2),
  };
  let sent = false;
  for (const target of targets) {
    target.dispatchEvent(new WheelEventCtor("wheel", opts));
    sent = true;
  }
  return sent;
};

const scrollTikTokContainers = (doc, amount) => {
  if (typeof doc.querySelectorAll !== "function") return false;
  const selectors = [
    '[data-e2e="recommend-list-container"]',
    '[data-e2e="recommend-list-item-container"]',
    '[data-e2e="feed-container"]',
    'main',
    '#app',
  ];
  const candidates = [];
  for (const sel of selectors) {
    for (const el of doc.querySelectorAll(sel)) candidates.push(el);
  }
  for (const el of doc.querySelectorAll("body, html, div")) {
    if (candidates.length >= 80) break;
    if (el?.classList?.contains("fs-root")) continue;
    const scrollable = (el.scrollHeight || 0) > (el.clientHeight || 0) + 20;
    if (scrollable) candidates.push(el);
  }
  const seen = new Set();
  for (const el of candidates) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (typeof el.scrollBy === "function") {
      el.scrollBy(0, amount);
      return true;
    }
    if (typeof el.scrollTop === "number") {
      el.scrollTop += amount;
      return true;
    }
  }
  return false;
};

const TT_SNAP_STRATEGY = Object.freeze({
  kind: "snap",
  useScrollHeightStall: false,
  useIdleEnd: false,
  advance({ doc } = {}) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || typeof d.querySelector !== "function") return false;
    let sawNextButton = false;
    for (const sel of TT_NEXT_BUTTON_SELECTORS) {
      const btn = buttonForSelector(d, sel);
      if (!btn) continue;
      sawNextButton = true;
      if (typeof btn.click === "function" && !isDisabledButton(btn)) {
        btn.click();
        return true;
      }
    }
    if (sawNextButton) return false;
    const w = d.defaultView || (typeof window !== "undefined" ? window : null);
    const amount = Math.max(1, w?.innerHeight || d.documentElement?.clientHeight || 900);
    const sentArrowDown = [d.activeElement, d.body, d.documentElement, w]
      .map((target) => dispatchArrowDown(target))
      .some(Boolean);
    const sentWheel = dispatchWheelDown(d, amount);
    const scrolledContainer = scrollTikTokContainers(d, amount);
    if (w && typeof w.scrollBy === "function") {
      w.scrollBy(0, amount);
      return true;
    }
    return sentArrowDown || sentWheel || scrolledContainer;
  },
});

const defaultCollectStrategy = () => SCROLL_STRATEGY;
const ttCollectStrategy = (pageScope) =>
  pageScope && pageScope.kind === "explore" ? TT_SNAP_STRATEGY : SCROLL_STRATEGY;

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
  collectStrategy: ttCollectStrategy,
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
