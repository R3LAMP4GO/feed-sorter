// Pure scoring helpers — outlier score = value / baseline.

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Per-author baseline thresholds. The two-tier strategy:
//   - When an author has enough chronologically-spaced posts in scope, use a
//     ±WINDOW_RADIUS sliding median over createTime-sorted neighbours. This
//     mirrors 1of10's algorithm: the comparison group is "what this creator
//     was getting around the same time", which is robust to long-term
//     channel growth (old low-view posts don't drag the baseline down).
//   - Otherwise fall back to the all-time per-author median across the
//     visible scope (the original behaviour). For lone posts on Explore,
//     fall back to the global median of the list.
//
// Score basis labels exposed via `_scoreBasis`:
//   "window"  — ±5 chronological neighbours, ≥MIN_WINDOW_SAMPLES positives.
//   "author"  — all-time median of this author's posts in scope.
//   "global"  — global median across the list (Explore / single-sample).
//   "none"    — no positive baseline available; _score is 0.
export const MIN_SAMPLES = 2;
export const WINDOW_RADIUS = 5;
export const MIN_AUTHOR_POSTS_FOR_WINDOW = 12;
export const MIN_WINDOW_SAMPLES = 4;

export const computeOutliers = (list, metric) => {
  // Bucket by author, keeping the original index so we can write results
  // back into the same positions the caller passed in.
  const byAuthor = new Map(); // author -> [{ p, idx }, ...]
  const globalPositives = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const v = Number(p[metric]) || 0;
    if (v > 0) globalPositives.push(v);
    const k = p.author || "_unknown";
    if (!byAuthor.has(k)) byAuthor.set(k, []);
    byAuthor.get(k).push({ p, idx: i, v });
  }
  const globalMed = median(globalPositives);

  // Pre-compute per-author all-time medians (positives only).
  const authorMeds = new Map();
  for (const [a, rows] of byAuthor) {
    const positives = rows.map((r) => r.v).filter((x) => x > 0);
    authorMeds.set(a, positives.length >= MIN_SAMPLES ? median(positives) : 0);
  }

  // Output array, filled author-by-author so the windowing pass can sort
  // by createTime without disturbing the caller's order.
  const out = new Array(list.length);

  for (const [a, rows] of byAuthor) {
    const authorMed = authorMeds.get(a) || 0;
    const useWindow = rows.length >= MIN_AUTHOR_POSTS_FOR_WINDOW;

    // Sort a copy by createTime desc (stable for tie-break by original idx).
    // Use a copy because `rows` is the raw bucket and other code may iterate
    // it later; mutating order would silently change semantics.
    const chrono = useWindow
      ? [...rows].sort((x, y) => {
          const ax = Number(x.p.createTime) || 0;
          const ay = Number(y.p.createTime) || 0;
          if (ax !== ay) return ay - ax;
          return x.idx - y.idx;
        })
      : null;

    for (let j = 0; j < rows.length; j++) {
      const { p, idx, v } = rows[j];
      let baseline = 0;
      let basis = "none";

      if (useWindow) {
        const ci = chrono.findIndex((r) => r.idx === idx);
        const lo = Math.max(0, ci - WINDOW_RADIUS);
        const hi = Math.min(chrono.length, ci + WINDOW_RADIUS + 1);
        const neighbours = [];
        for (let k = lo; k < hi; k++) {
          if (k === ci) continue;
          if (chrono[k].v > 0) neighbours.push(chrono[k].v);
        }
        if (neighbours.length >= MIN_WINDOW_SAMPLES) {
          baseline = median(neighbours);
          basis = "window";
        }
      }

      if (!baseline) {
        if (authorMed > 0) {
          baseline = authorMed;
          basis = "author";
        } else if (globalMed > 0) {
          baseline = globalMed;
          basis = "global";
        }
      }

      const score = baseline > 0 ? v / baseline : 0;
      out[idx] = { ...p, _score: score, _scoreBasis: baseline > 0 ? basis : "none" };
    }
  }

  return out;
};
