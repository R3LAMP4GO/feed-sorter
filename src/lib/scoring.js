// Pure scoring helpers — outlier score = value / baseline.

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Per-author median when the author has ≥2 samples; otherwise fall back to
// the global median across the current list (meaningful on Explore).
export const MIN_SAMPLES = 2;

export const computeOutliers = (list, metric) => {
  const byAuthor = new Map();
  const globalVals = [];
  for (const p of list) {
    const v = p[metric] || 0;
    if (v > 0) globalVals.push(v);
    const k = p.author || "_unknown";
    if (!byAuthor.has(k)) byAuthor.set(k, []);
    byAuthor.get(k).push(v);
  }
  const globalMed = median(globalVals);
  const meds = new Map();
  for (const [a, vals] of byAuthor) {
    const positive = vals.filter((x) => x > 0);
    meds.set(a, positive.length >= MIN_SAMPLES ? median(positive) : 0);
  }
  return list.map((p) => {
    const authorMed = meds.get(p.author || "_unknown") || 0;
    const baseline = authorMed || globalMed;
    const score = baseline > 0 ? (p[metric] || 0) / baseline : 0;
    return { ...p, _score: score, _scoreBasis: authorMed ? "author" : "global" };
  });
};
