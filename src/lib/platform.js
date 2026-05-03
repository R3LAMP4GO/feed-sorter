// Platform dispatcher (ESM). Pure — no DOM, no chrome APIs.
// Maps a hostname to a bundle of parser + scope detector + URL helpers
// + IDB / CSV / download conventions. The runtime mirror lives at
// src/lib/platform-runtime.js (IIFE) and stays in lock-step.

import * as parserIg from "./parser.js";
import * as scopeIg from "./scope.js";
import * as parserTt from "./parser-tiktok.js";
import * as scopeTt from "./scope-tiktok.js";

export const PLATFORMS = Object.freeze({
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
});

/** @returns {"instagram"|"tiktok"|null} */
export const detectPlatform = (host = "") => {
  const h = String(host || "").toLowerCase();
  if (/(^|\.)tiktok\.com$/.test(h)) return PLATFORMS.TIKTOK;
  if (/(^|\.)instagram\.com$/.test(h)) return PLATFORMS.INSTAGRAM;
  return null;
};

const igConfig = {
  platform: PLATFORMS.INSTAGRAM,
  parser: parserIg,
  scope: scopeIg,
  postIdPrefix: "ig_",
  csvPrefix: "ig",
  downloadFolder: "feed-sorter-ig",
  surfaces: ["profile", "reels", "explore", "graphql"],
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

export const getConfig = (platform) => {
  if (platform === PLATFORMS.TIKTOK) return ttConfig;
  if (platform === PLATFORMS.INSTAGRAM) return igConfig;
  return null;
};

export const configForHost = (host) => {
  const p = detectPlatform(host);
  return p ? getConfig(p) : null;
};
