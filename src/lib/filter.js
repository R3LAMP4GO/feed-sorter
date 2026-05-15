// Pure filter+sort pipeline.
import { computeOutliers } from "./scoring.js";

export const RANGES = { all: 0, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365 };

/**
 * Surface-filter predicate. IG's profile-reels tab now serves reels through
 * `/graphql/query`, which the parser tags `surface:"graphql"`, so a strict
 * equality check would hide every reel when the user picks "reels". Match
 * by `isReel` for the reels bucket and treat `graphql` (mixed feed/reels
 * over GraphQL) as the profile bucket for non-reels.
 * @param {{surface?:string, isReel?:boolean}} post
 * @param {string} target  e.g. "all" | "reels" | "profile" | "explore" | ...
 */
export const matchesSurface = (post, target) => {
  if (!target || target === "all") return true;
  const s = post.surface;
  if (target === "reels") return post.isReel === true || s === "reels";
  if (target === "profile") return !post.isReel && (s === "profile" || s === "graphql");
  return s === target;
};

/**
 * @param {Array} posts
 * @param {{sort:string, metric:string, range:string, limit:number, surface:string}} state
 * @param {number} [now]
 */
export const applyFilter = (posts, state, now = Date.now()) => {
  let list = [...posts];
  if (state.surface !== "all") {
    list = list.filter((p) => matchesSurface(p, state.surface));
  }
  const days = RANGES[state.range];
  if (days) {
    const cutoff = now / 1000 - days * 86400;
    list = list.filter((p) => p.createTime >= cutoff);
  }
  if (state.nicheFilter) {
    list = list.filter((p) => p && p.niche === state.nicheFilter);
  }
  if (state.formatFilter) {
    list = list.filter((p) => p && p.format === state.formatFilter);
  }
  list = computeOutliers(list, state.metric);
  const key = state.sort;
  list.sort((a, b) => {
    if (key === "outlier") return b._score - a._score;
    if (key === "recent") return b.createTime - a.createTime;
    return (b[key] || 0) - (a[key] || 0);
  });
  if (state.limit > 0) list = list.slice(0, state.limit);
  return list;
};
