// Pure filter+sort pipeline.
import { computeOutliers } from "./scoring.js";

export const RANGES = { all: 0, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365 };

/**
 * @param {Array} posts
 * @param {{sort:string, metric:string, range:string, limit:number, surface:string}} state
 * @param {number} [now]
 */
export const applyFilter = (posts, state, now = Date.now()) => {
  let list = [...posts];
  if (state.surface !== "all") {
    list = list.filter((p) => p.surface === state.surface);
  }
  const days = RANGES[state.range];
  if (days) {
    const cutoff = now / 1000 - days * 86400;
    list = list.filter((p) => p.createTime >= cutoff);
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
