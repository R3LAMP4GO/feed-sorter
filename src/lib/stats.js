// Pure aggregation helpers for the stats sidebar. Mirrors the logic
// embedded in content.js so the math is unit-testable in isolation.
//
// All inputs are post objects already enriched with `_score`, `cpr`,
// and `mediaType`/`isReel`/`carouselCount` flags.

import { median } from "./scoring.js";

export const HASHTAG_RE = /#([\w_]+)/g;

export const formatOf = (p) => {
  if (p.isReel || p.mediaType === 2) return "reel";
  if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
  return "single";
};

export const computeFormatStats = (list) => {
  const buckets = { reel: [], carousel: [], single: [] };
  for (const p of list) buckets[formatOf(p)].push(p);
  return ["reel", "carousel", "single"].map((f) => {
    const items = buckets[f];
    const views = items.map((p) => p.views || 0).filter((x) => x > 0);
    const med = median(views);
    const outliers = items.filter((p) => (p._score || 0) >= 2).length;
    const pct = items.length ? (outliers / items.length) * 100 : 0;
    return { format: f, n: items.length, medianViews: med, outlierPct: pct };
  });
};

export const computeHashtagLift = (list, { minN = 3, top = 15 } = {}) => {
  const counts = new Map();
  const sums = new Map();
  let allSum = 0, allN = 0;
  for (const p of list) {
    const s = p._score || 0;
    allSum += s; allN++;
    const desc = p.desc || "";
    const seen = new Set();
    HASHTAG_RE.lastIndex = 0;
    let m;
    while ((m = HASHTAG_RE.exec(desc)) !== null) {
      const t = m[1].toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
      sums.set(t, (sums.get(t) || 0) + s);
    }
  }
  const rows = [];
  for (const [t, n] of counts) {
    if (n < minN) continue;
    const meanWith = sums.get(t) / n;
    const remN = allN - n;
    const meanWithout = remN > 0 ? (allSum - sums.get(t)) / remN : 0;
    const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Infinity : 0);
    rows.push({ tag: t, n, lift, meanWith });
  }
  rows.sort((a, b) => b.lift - a.lift);
  return rows.slice(0, top);
};

export const computeCaptionHist = (list, nb = 20) => {
  const lens = list.map((p) => (p.desc || "").length).filter((x) => x > 0);
  const maxLen = lens.length ? Math.max(...lens) : 1;
  const minExp = 0;
  const maxExp = Math.max(1, Math.log10(maxLen + 1));
  const out = new Array(nb).fill(0);
  const non = new Array(nb).fill(0);
  for (const p of list) {
    const len = (p.desc || "").length;
    if (len <= 0) continue;
    const exp = Math.log10(len);
    let b = Math.floor(((exp - minExp) / (maxExp - minExp || 1)) * nb);
    if (b < 0) b = 0;
    if (b >= nb) b = nb - 1;
    if ((p._score || 0) >= 2) out[b]++;
    else non[b]++;
  }
  return { out, non, nb, maxLen };
};

export const computeCprStats = (list) => {
  const cprs = list.map((p) => p.cpr || 0).filter((x) => x > 0);
  return {
    median: median(cprs),
    mean: cprs.length ? cprs.reduce((a, b) => a + b, 0) / cprs.length : 0,
    n: cprs.length,
  };
};

export const cprOf = (p) => (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;

export const computeCadence = (list) => {
  const cell = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ n: 0, sum: 0 }))
  );
  for (const p of list) {
    if (!p.createTime) continue;
    const d = new Date(p.createTime * 1000);
    cell[d.getDay()][d.getHours()].n++;
    cell[d.getDay()][d.getHours()].sum += p._score || 0;
  }
  return cell;
};

export const computeStats = (list) => ({
  total: list.length,
  authors: new Set(list.map((p) => p.author).filter(Boolean)).size,
  formats: computeFormatStats(list),
  hashtags: computeHashtagLift(list),
  hist: computeCaptionHist(list),
  cpr: computeCprStats(list),
  cadence: computeCadence(list),
});
