// Pure filter+sort pipeline. Mirrors content.js sort math for unit coverage.
import { computeOutliers } from "./scoring.js";

export const RANGES = { all: 0, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365 };

const ACCEL_RATIO = 1.5;

// Observed velocity = (current views - first captured views) / elapsed hours
// between first capture and last seen. A single persisted baseline snapshot is
// enough once the row has been re-seen later; a brand-new one-snapshot row is
// marked velocityReady=false so UI can show “—” instead of misleading 0/hr.
export const computeDerived = (post, now = Date.now()) => {
  const p = post || {};
  const snaps = Array.isArray(p.snapshots) ? p.snapshots.filter(Boolean) : [];
  const currentViews = Number(p.views) || 0;
  if (!snaps.length) {
    return { firstSeenViews: currentViews, velocityViewsPerHr: 0, velocityReady: false, accelerating: false, snapshotCount: 0 };
  }
  const first = snaps[0] || {};
  const lastSnapshot = snaps[snaps.length - 1] || {};
  const lastSnapshotViews = Number(lastSnapshot.views) || 0;
  const hasImplicitCurrent = currentViews > lastSnapshotViews;
  const last = hasImplicitCurrent
    ? { ...lastSnapshot, views: currentViews, capturedAt: Number(p.lastSeenAt) || now }
    : lastSnapshot;
  const firstAt = Number(first.capturedAt) || Number(p.firstSeenAt) || 0;
  const lastAtRaw = Math.max(Number(last.capturedAt) || 0, Number(p.lastSeenAt) || 0, firstAt);
  const lastAt = Math.max(lastAtRaw, firstAt);
  const hrs = (lastAt - firstAt) / 3600000;
  const dViews = Math.max(0, Number(last.views || 0) - Number(first.views || 0));
  const velocityReady = hrs > 0;
  const velocity = velocityReady ? dViews / hrs : 0;
  let accelerating = false;
  if (snaps.length >= 3 && velocity > 0) {
    const prev = snaps[snaps.length - 2] || {};
    const prevAt = Number(prev.capturedAt) || firstAt;
    const recentHrs = Math.max((lastAt - prevAt) / 3600000, 0);
    const recentV = recentHrs > 0
      ? Math.max(0, Number(last.views || 0) - Number(prev.views || 0)) / recentHrs
      : 0;
    accelerating = recentV > velocity * ACCEL_RATIO;
  }
  return {
    firstSeenViews: Number(first.views) || 0,
    velocityViewsPerHr: velocity,
    velocityReady,
    accelerating,
    snapshotCount: snaps.length,
  };
};

export const vphSincePosted = (post, now = Date.now()) => {
  const views = Number(post?.views) || 0;
  const created = Number(post?.createTime) || 0;
  if (!views || !created) return 0;
  const ageHrs = Math.max(1, (now / 1000 - created) / 3600);
  return views / ageHrs;
};

export const cprOf = (post) => (Number(post?.comments) || 0) / Math.max(Number(post?.likes) || 0, 1) * 1000;

export const enrichForSort = (post, now = Date.now()) => {
  const derived = computeDerived(post, now);
  return {
    ...post,
    ...derived,
    velocity: derived.velocityViewsPerHr,
    cpr: cprOf(post),
    vph: vphSincePosted(post, now),
  };
};

const numericDesc = (a, b, key) => (Number(b?.[key]) || 0) - (Number(a?.[key]) || 0);

export const comparePosts = (a, b, sortKey) => {
  if (sortKey === "outlier") return numericDesc(a, b, "_score");
  if (sortKey === "recent") return numericDesc(a, b, "createTime");
  if (sortKey === "velocity") return numericDesc(a, b, "velocityViewsPerHr");
  if (sortKey === "vph") return numericDesc(a, b, "vph");
  if (sortKey === "cpr") return numericDesc(a, b, "cpr");
  return numericDesc(a, b, sortKey);
};

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
  list = list.map((p) => enrichForSort(p, now));
  list = computeOutliers(list, state.metric);
  const key = state.sort;
  list.sort((a, b) => comparePosts(a, b, key));
  if (state.limit > 0) list = list.slice(0, state.limit);
  return list;
};
